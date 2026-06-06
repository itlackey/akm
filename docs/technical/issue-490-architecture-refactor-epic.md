# Issue #490 — Architecture Refactor Epic: Triage & Decomposition

Status: epic / tracker (`tractable=false`, size=epic)
Parent: [#490](https://github.com/itlackey/akm/issues/490)
Target: multi-PR program across 0.9.x (blocks #489 XDG storage move)

## Triage decision

Issue #490 is a **master tracker**, not a discrete change. Its own body
estimates ~32–49 hours touching 500+ LOC across ~40 files, with the cost
dominated by ~518 test-suite env-var pokes and 154/230 test files using raw
`mkdtempSync`. A single coding-agent pass is **not** appropriate.

Therefore:

- **No implementation PR is opened against #490 directly.**
- The epic is decomposed into discrete, independently-shippable child issues
  (one per phase), each carrying file:line citations, its own acceptance
  criteria, and an out-of-scope list so it can be implemented cold.
- Project gates (`bunx tsc --noEmit`, `bun run lint`, `bun test`) are enforced
  **per child PR** — never gated on the epic as a whole.
- The five quick-wins referenced in the body (#491–#495) are already
  closed/merged.

## Child issues

| Child | Phase | Scope |
|---|---|---|
| [#524](https://github.com/itlackey/akm/issues/524) | 1 (additive) | `StorageLocations` resolver so callers never compose db paths |
| [#525](https://github.com/itlackey/akm/issues/525) | 1–2 | Repository layer to hide `Database`; pull raw SQL out of non-DB modules |
| [#526](https://github.com/itlackey/akm/issues/526) | 1 (additive) | `withIsolatedAkmStorage(fn)` test helper replacing ad-hoc env pokes |
| [#527](https://github.com/itlackey/akm/issues/527) | 2 | Split `cli.ts` into one-file-per-command + services |
| [#528](https://github.com/itlackey/akm/issues/528) | 1–3 | `MigrationStep` registry to break up `scripts/migrate-storage.ts` |
| [#529](https://github.com/itlackey/akm/issues/529) | 3 | Collapse duplicate `getLockfilePath` |

## Key citations verified on `release/0.9.0`

- `src/core/paths.ts:206` `getDataDir`, `:248` `getDbPath`, `:267`
  `getLockfilePath`, `:139` `getCacheDir`, `:76` `getConfigDir`
- `src/integrations/lockfile.ts:44` private `getLockfilePath` (duplicate of the
  exported one in `paths.ts:267`)
- `src/workflows/runs.ts:31` `withWorkflowDb`, with raw `db.prepare` SQL at
  `:139, :145, :253, :293, :308, :341, :499` (9+ sites)
- `src/cli.ts` — 4,724 LOC, 119 `defineCommand` blocks (post-QW1 #491)
- `scripts/migrate-storage.ts` — 1,259 LOC
- ~73 `openDatabase`/`openExistingDatabase` call sites in `src/`
- ~1,119 `process.env.XDG_*` / `process.env.AKM_*` references under `tests/`

## Sequencing

Children #524, #526 are additive (Phase 1) and can land first with zero
behavioural change. #525 and #527 are the Phase-2 cutover that unblocks the
#489 XDG storage move. #529 is the smallest slice (good first issue) and can
land at any point. #528 spans phases and can proceed independently.

The epic (#490) remains open as the tracker and continues to block #489 until
the Phase-2 cutover lands.
