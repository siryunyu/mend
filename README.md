# mend

mend is a Node.js 22 CLI that applies AI-generated patches to a tree of text files.

## Usage

Run mend from the root of the tree you want to edit.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Omit `PATCH` or pass `-` to read from standard input. mend detects the patch format by default. Use `--format` to select `unified`, `search-replace`, `v4a`, or `json` explicitly.

For line-based patches, mend tries exact matching first, then ignores trailing spaces and tabs, then ignores spaces and tabs at both ends. `--strict` uses exact matching only.

Writes are all or nothing. Use `--check` to preview the result without writing files.

## Practice tests

From the repository root, pass the path to `program/generator/practice.json` from the official kit.

```sh
node check.ts <practice.json>
```
