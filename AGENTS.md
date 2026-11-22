# mend — one patch tool for every AI edit format

Node 22, standard library only, one CLI at `main.ts`: `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
It applies a unified diff, SEARCH/REPLACE blocks, a V4A patch or JSON edits to a tree of text files, all or nothing.

## Status

Updated 2026-11-22. `main.ts` implements all of SPEC.md; 100/100 on the official practice set (score 1000) under
Node 22.23.4. Entered in make.fun bounty `hidden-spec-cli-01-run-20261122` at commit `6f24a4f` (entry
`01a203f2-615e-736c-ae80-4c335ce6f5d6`, scored, waiting on the final phase that opens 2026-11-24T14:10Z).

## Run

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]   # PATCH or "-" = stdin
    node check.ts <kit>/program/generator/practice.json         # the 100 practice checks
    node check.ts <practice.json> <check-id>                    # one check

The grader runs Node 22; the machine's PATH node is v25, so call the 22 binary explicitly when it matters.

## Map

- `main.ts` — the whole CLI: options, output, paths, format detection, three-tier matching, the four formats, atomic write.
- `runner.ts` — the trial hand-over; keep it exactly as the kit ships it.
- `check.ts` — runs `main.ts` over the practice set and diffs exit code, stdout and files.
- `SPEC.md` — the contract; every sentence is a requirement.

## Decisions

- History starts at the `makefun init` beacon root, so this enters as a source bundle (`submit --source`), not a GitHub
  repo entry. The GitHub repo is a public mirror of the same commits.
- The kit's starter lines are excluded from the authorship count; everything written after it must come from an agent
  session that quotes the anchor line.
