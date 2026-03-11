# Development Workflow

## Required local verification

Before pushing any branch that changes CLI output, search behavior, docs, or tests:

- run `bun run check`

For faster iteration while changing output contracts, run:

- `bun run check:changed`

`check:changed` is a quick gate for the most failure-prone areas:

- output contract baselines
- CLI end-to-end output expectations
- search-path regressions
- lint
- typecheck

Use it during development, then run `bun run check` before every push.

## Why this exists

This repository has repeatedly seen CI failures caused by output-shape changes
that updated implementation without updating end-to-end expectations. The fix is
to treat `bun run check` as the pre-push gate and to use `bun run check:changed`
while iterating on output-related changes.
