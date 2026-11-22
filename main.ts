// mend applies patches as specified in SPEC.md (MIT). Run with Node 22 as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function requireSafe(path: string): void {
  if (!safe(path)) throw new Fail('unsafe', path);
}

function parseError(line: number): never {
  throw new Exit2(`error: parse ${line}`);
}

interface TextFile {
  lines: string[];
  separator: '\n' | '\r\n';
  finalBreak: boolean;
}

function splitFile(text: string): TextFile {
  const firstBreak = text.indexOf('\n');
  const separator = firstBreak > 0 && text[firstBreak - 1] === '\r' ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(separator);
  const finalBreak = text.endsWith(separator);
  if (finalBreak) lines.pop();
  return { lines, separator, finalBreak };
}

function joinFile({ lines, separator, finalBreak }: TextFile): string {
  return lines.length === 0 ? '' : lines.join(separator) + (finalBreak ? separator : '');
}

function newFile(lines: string[], finalBreak = true): string {
  return joinFile({ lines, separator: '\n', finalBreak });
}

interface Move {
  from: string;
  to: string;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Move[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        const localPath = `./${p}`;
        if (statSync(localPath).isFile()) v = readFileSync(localPath, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree, strict: boolean) => void;
type Transform = (text: string, path: string, strict: boolean) => string;
type FileMode = 'create' | 'delete' | 'change' | 'move';

function fileEdit(
  oldPath: string | null,
  newPath: string | null,
  transform?: Transform,
  mode: FileMode = oldPath === null ? 'create' : newPath === null ? 'delete' : 'change',
): Edit {
  return (tree, strict) => {
    if (oldPath !== null) requireSafe(oldPath);
    if (newPath !== null && newPath !== oldPath) requireSafe(newPath);
    if (mode === 'create') {
      const path = newPath ?? '';
      if (newPath === null) requireSafe(path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, transform?.('', path, strict) ?? '');
      return;
    }

    const path = oldPath ?? '';
    if (oldPath === null) requireSafe(path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (mode === 'delete') {
      tree.now.set(path, null);
      return;
    }

    const destination = newPath ?? path;
    const moving = mode === 'move' || destination !== path;
    if (moving && tree.get(destination) !== null) throw new Fail('exists', destination);
    const after = transform?.(before, path, strict) ?? before;
    tree.now.set(destination, after);
    if (moving) {
      tree.now.set(path, null);
      tree.moves.push({ from: path, to: destination });
    }
  };
}

type Tier = 0 | 1 | 2;
const strictTiers: readonly Tier[] = [0];
const allTiers: readonly Tier[] = [0, 1, 2];

function lineAtTier(line: string, tier: Tier): string {
  if (tier === 0) return line;
  const trailing = line.replace(/[ \t]+$/, '');
  return tier === 1 ? trailing : trailing.replace(/^[ \t]+/, '');
}

function matchLines(
  lines: string[], old: string[], path: string, strict: boolean, start = 0, endOfFile = false,
): { positions: number[]; tier: Tier } {
  const last = lines.length - old.length;
  const first = endOfFile ? Math.max(start, last) : start;
  for (const tier of strict ? strictTiers : allTiers) {
    const expected = old.map((line) => lineAtTier(line, tier));
    const positions: number[] = [];
    for (let at = first; at <= last; at++) {
      if (expected.every((line, i) => line === lineAtTier(lines[at + i]!, tier))) positions.push(at);
    }
    if (positions.length > 0) return { positions, tier };
  }
  throw new Fail('no-match', path);
}

interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  noNewline?: boolean;
}

function bodyLine(line: string): BodyLine | undefined {
  if (line === '') return { kind: ' ', text: '' };
  const kind = line[0];
  if (kind === ' ' || kind === '-' || kind === '+') return { kind, text: line.slice(1) };
  return undefined;
}

function oldLines(body: BodyLine[]): string[] {
  return body.filter((line) => line.kind !== '+').map((line) => line.text);
}

function leadingIndent(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}

function applyLines(file: TextFile, at: number, old: string[], body: BodyLine[], tier: Tier): number {
  const patchIndent = tier === 2 ? leadingIndent(old[0]!) : '';
  const fileIndent = tier === 2 ? leadingIndent(file.lines[at]!) : '';
  const replacement: string[] = [];
  let source = at;
  for (const line of body) {
    if (line.kind === ' ') replacement.push(file.lines[source++]!);
    else if (line.kind === '-') source++;
    else if (tier === 2 && !blank(line.text) && line.text.startsWith(patchIndent)) {
      replacement.push(fileIndent + line.text.slice(patchIndent.length));
    } else replacement.push(line.text);
  }
  file.lines = file.lines.slice(0, at).concat(replacement, file.lines.slice(at + old.length));
  return replacement.length;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let outsideStart = 0;
  let previousPath: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let path = previousPath;
    for (let j = i - 1; j >= outsideStart; j--) {
      const candidate = lines[j]!.trim();
      if (candidate === '' || candidate.startsWith('```')) continue;
      path = candidate;
      break;
    }
    if (path === undefined) parseError(i + 1);
    let middle = i + 1;
    while (middle < lines.length && lines[middle]!.trimEnd() !== '=======') middle++;
    let end = middle + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end++;
    if (end >= lines.length) parseError(i + 1);

    const old = lines.slice(i + 1, middle);
    const replacement = lines.slice(middle + 1, end);
    if (old.length === 0) {
      edits.push(fileEdit(null, path, () => newFile(replacement)));
    } else {
      const body: BodyLine[] = replacement.map((text) => ({ kind: '+', text }));
      edits.push(fileEdit(path, path, (text, path, strict) => {
        const file = splitFile(text);
        const { positions, tier } = matchLines(file.lines, old, path, strict);
        if (positions.length !== 1) throw new Fail('ambiguous', path);
        applyLines(file, positions[0]!, old, body, tier);
        return joinFile(file);
      }));
    }
    previousPath = path;
    outsideStart = end + 1;
    i = end;
  }
  return edits;
}

const V4A_ADD = '*** Add File: ';
const V4A_DELETE = '*** Delete File: ';
const V4A_UPDATE = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';
const v4aHeaders = [V4A_ADD, V4A_DELETE, V4A_UPDATE];

function v4aHeader(line: string): string | undefined {
  return v4aHeaders.find((header) => line.startsWith(header));
}

interface V4AChunk {
  anchor: string;
  body: BodyLine[];
  endOfFile: boolean;
}

function v4aUpdate(lines: string[], header: number, end: number, path: string): Edit {
  let at = header + 1;
  let destination: string | undefined;
  if (at < end && lines[at]!.startsWith(V4A_MOVE)) destination = lines[at++]!.slice(V4A_MOVE.length).trim();

  const chunks: V4AChunk[] = [];
  while (at < end) {
    const first = lines[at]!;
    let anchor = '';
    if (first.startsWith('@@')) {
      anchor = first.slice(2).trim();
      at++;
    } else if (chunks.length > 0 || bodyLine(first) === undefined) {
      parseError(at + 1);
    }

    const body: BodyLine[] = [];
    while (at < end) {
      const entry = bodyLine(lines[at]!);
      if (entry === undefined) break;
      body.push(entry);
      at++;
    }
    const endOfFile = at < end && lines[at] === '*** End of File';
    if (endOfFile) at++;
    chunks.push({ anchor, body, endOfFile });
  }
  if (chunks.length === 0 && destination === undefined) parseError(header + 1);

  return fileEdit(path, destination ?? path, (text, path, strict) => {
    const file = splitFile(text);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== '') {
        const { positions } = matchLines(file.lines, [chunk.anchor], path, strict, cursor);
        cursor = positions[0]! + 1;
      }
      const old = oldLines(chunk.body);
      let at = chunk.endOfFile ? file.lines.length : cursor;
      let tier: Tier = 0;
      if (old.length > 0) {
        const match = matchLines(file.lines, old, path, strict, cursor, chunk.endOfFile);
        at = match.positions[0]!;
        tier = match.tier;
      }
      cursor = at + applyLines(file, at, old, chunk.body, tier);
    }
    return joinFile(file);
  }, destination === undefined ? 'change' : 'move');
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  if (first === -1) parseError(1);
  if (lines[first]!.trim() !== '*** Begin Patch') parseError(first + 1);
  let last = lines.length - 1;
  while (blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') parseError(lines.length + 1);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const header = v4aHeader(lines[i]!);
    if (header === undefined) parseError(i + 1);
    const path = lines[i]!.slice(header.length).trim();
    let next = i + 1;
    while (next < last && v4aHeader(lines[next]!) === undefined) next++;
    let end = next;
    while (end > i + 1 && blank(lines[end - 1]!)) end--;

    if (header === V4A_ADD) {
      const added: string[] = [];
      for (let j = i + 1; j < end; j++) {
        const line = lines[j]!;
        if (line !== '' && !line.startsWith('+')) parseError(j + 1);
        added.push(line.slice(1));
      }
      edits.push(fileEdit(null, path, () => newFile(added)));
    } else if (header === V4A_DELETE) {
      if (end > i + 1) parseError(i + 2);
      edits.push(fileEdit(path, null));
    } else {
      edits.push(v4aUpdate(lines, i, end, path));
    }
    i = next;
  }
  return edits;
}

interface UnifiedHunk {
  start: number;
  body: BodyLine[];
}

type DiffPaths = [string | null, string | null];

interface UnifiedSection {
  paths: DiffPaths;
  headerPaths?: DiffPaths;
  renameFrom?: string;
  renameTo?: string;
  create?: boolean;
  delete?: boolean;
  hunks: UnifiedHunk[];
}

function diffGitHeader(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

function diffPathPair(lines: string[], at: number): boolean {
  return lines[at]!.startsWith('--- ') && (lines[at + 1] ?? '').startsWith('+++ ');
}

function diffHeaderPath(line: string): string | null {
  const path = line.slice(4).split('\t', 1)[0]!.trim();
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
}

function unifiedBody(lines: string[], start: number): { body: BodyLine[]; end: number } {
  let end = start;
  while (end < lines.length) {
    const line = lines[end]!;
    if (diffGitHeader(line) || diffPathPair(lines, end)) break;
    if (line !== '' && !' -+\\'.includes(line[0]!)) break;
    end++;
  }
  let last = end;
  while (last > start && lines[last - 1] === '') last--;
  const body: BodyLine[] = [];
  let previous: BodyLine | undefined;
  for (let i = start; i < last; i++) {
    const entry = bodyLine(lines[i]!);
    if (entry) body.push(entry);
    else if (previous) previous.noNewline = true;
    previous = entry;
  }
  return { body, end };
}

function applyUnifiedHunks(text: string, path: string, strict: boolean, hunks: UnifiedHunk[]): string {
  const file = splitFile(text);
  let delta = 0;
  for (const { start, body } of hunks) {
    const old = oldLines(body);
    let at = Math.max(0, Math.min(start + delta, file.lines.length));
    let tier: Tier = 0;
    if (old.length !== 0) {
      const match = matchLines(file.lines, old, path, strict);
      const hint = Math.max(0, Math.min(start - 1 + delta, file.lines.length));
      at = match.positions[0]!;
      for (const position of match.positions) {
        if (Math.abs(position - hint) < Math.abs(at - hint)) at = position;
      }
      tier = match.tier;
    }
    if (at + old.length === file.lines.length) {
      const lastWritten = body.findLast((line) => line.kind !== '-');
      file.finalBreak = lastWritten?.noNewline !== true;
    }
    delta += applyLines(file, at, old, body, tier) - old.length;
  }
  return joinFile(file);
}

function unifiedEdit(section: UnifiedSection): Edit {
  const { headerPaths, paths, renameFrom, renameTo, hunks } = section;
  const [oldPath, newPath] = headerPaths ?? [renameFrom ?? paths[0], renameTo ?? paths[1]];
  if (oldPath === null || section.create) {
    const added = hunks.flatMap(({ body }) => body.filter((line) => line.kind === '+'));
    return fileEdit(oldPath, newPath, () => newFile(added.map((line) => line.text), added.at(-1)?.noNewline !== true), 'create');
  }
  if (newPath === null || section.delete) return fileEdit(oldPath, newPath, undefined, 'delete');
  return fileEdit(oldPath, newPath, (text, path, strict) => applyUnifiedHunks(text, path, strict, hunks));
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (diffGitHeader(line)) {
      const paths = /^diff --git a\/(.*?) b\/(.*)$/s.exec(line);
      if (paths === null) parseError(i + 1);
      section = { paths: [paths[1]!, paths[2]!], hunks: [] };
      sections.push(section);
    } else if (diffPathPair(lines, i)) {
      const paths: DiffPaths = [diffHeaderPath(line), diffHeaderPath(lines[++i]!)];
      if (section === undefined || section.headerPaths !== undefined || section.hunks.length > 0) {
        section = { paths, headerPaths: paths, hunks: [] };
        sections.push(section);
      } else section.headerPaths = paths;
    } else if (line.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (header === null || section === undefined) parseError(i + 1);
      const { body, end } = unifiedBody(lines, i + 1);
      section.hunks.push({ start: Number(header[1]), body });
      i = end - 1;
    } else if (section !== undefined && section.hunks.length === 0) {
      if (line.startsWith('--- ')) parseError(i + 2);
      if (line.startsWith('rename from ')) section.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) section.renameTo = line.slice('rename to '.length);
      else if (line === 'new file mode' || line.startsWith('new file mode ')) section.create = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) section.delete = true;
    }
  }
  return sections.map(unifiedEdit);
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    requireSafe(p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return fileEdit(null, p, () => text);
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const file = splitFile(exists(tree));
      if (line < 0 || line > file.lines.length) throw new Fail('no-match', p);
      file.lines = file.lines.slice(0, line).concat(add, file.lines.slice(line));
      tree.now.set(p, joinFile(file));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function patchEdits(kind: string, text: string, lines: string[]): Edit[] {
  switch (kind) {
    case 'unified': return unifiedEdits(lines);
    case 'search-replace': return searchReplaceEdits(lines);
    case 'v4a': return v4aEdits(lines);
    case 'json': return jsonEdits(text, lines);
    default: return [];
  }
}

function reportMoves(tree: Tree, rows: Map<string, string>): void {
  for (const { from, to } of tree.moves) {
    // Consume each deletion and addition at most once, in the order the moves ran.
    if (rows.get(from) !== `D ${from}` || rows.get(to) !== `A ${to}`) continue;
    rows.delete(from);
    rows.set(to, `R ${from} -> ${to}`);
  }
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = patchEdits(kind, text, lines);
    if (edits.length === 0) parseError(1);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = new Map<string, string>();
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    const localPath = `./${p}`;
    if (now === null) rmSync(localPath, { force: true });
    else {
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, now);
    }
  }
  reportMoves(tree, rows);
  return { code: 0, out: [...rows.values(), `ok: ${rows.size} ${rows.size === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
