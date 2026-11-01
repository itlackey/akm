# Task brief template

One brief per child issue. Source: [plan.md](plan.md) Appendix A. The plan wins where this file differs.

```markdown
# <ID> <imperative title>
Labels: ui-overhaul, phase:<n>, lane:<T|C|F|V|S>, gate:<…>, <topic>   ·   Lane: <X>   ·   Depends on: <IDs>   ·   Owner questions: <Q-ids → default>

## Goal
One sentence: what is true for the user or the codebase when this merges.

## Context
Plan: docs/design/ui-overhaul/plan.md §…; decisions D-…; bugs B-…; visuals V-…; metrics M-….
Verified code facts the implementer relies on (file:line).

## Files
- Owned (may edit): …
- May touch minimally: … (CSS ≤ 20 lines outside lane C; say why)
- Must NOT touch: CSS during the freeze (P2-1a…P2-4) unless lane C; other pages; ci.yml; baselines of unrelated routes.
- Generated: run `bun scripts/gen-embedded-ui.ts` when a UI file is added, removed or renamed.

## Steps (each with its check)
1. Write the failing test that reproduces the bug or requirement → verify it fails for the right reason.
2. … → verify: …

## Standards (plan §8.8)
Owner requirement: modern CSS and clean code (plan §8 intro). Items: S-… (with names). S-23 always applies.

## Tests
Unit/integration: … · Visual: routes/states expected to change; everything else 0 diff · a11y ratchet entries expected to close · budget delta.

## Local gates before "ready for review"
`bun run lint:fix` · `bunx tsc --noEmit` · `bun test <focused files>` · `bun run check:changed` · `bun run test:ui-visual:docker` (UI PRs)

## Design review gate
R1 → R2a → R2 (→ R3). Capture → review (plan §11.5.3) → fix → re-capture, at most 3 rounds, then split or escalate. Who signs.

## Acceptance criteria
- [ ] observable, testable statements (test names)
- [ ] `bun run check` and `ui-visual` green; diffs only where listed
- [ ] docs updated (ui-api.md for API changes; compat doc for persisted fields)

## Out of scope
…
```
