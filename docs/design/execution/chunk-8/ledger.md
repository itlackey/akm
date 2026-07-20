# Chunk 8 — execution ledger

Status: CLOSING (2026-07-20). Companion to `brief.md` + `cutover-design.md`.
Records the landed work, every gate result, and every deviation with its
disposition, per the execution-workflow's per-chunk ledger rule.

## Landed work items

| WI | Landed | Headline |
|---|---|---|
| 8.1 | ✅ | Frozen WORKFLOW_MIGRATIONS ids+checksums (`SealedMigration` engine seam); backup manifest v3 (pre-rescue index.db 4th artifact, strict v2 backward-read) |
| 8.2 | ✅ | `020-three-db-cutover` DDL + the journaled cutover module (`three-db-cutover.ts`): ref-map → ATTACH merge txn → §3.2 re-key with three-spelling merge → `legacy_state` quarantine → index.db quarantine-rename → workflow.db deletion; `cutover-applied` apply phase with crash-resume coverage |
| 8.3 | ✅ | Runtime on three DBs: `workflows/db.ts` deleted (frozen BODIES copy for the pre-merge roll), `withWorkflowRunsRepo` → state.db, `usage_events`+`legacy_state` re-homed to state.db with cross-DB joins split, dual-source `activeWorkflowClaims` |
| 8.4 | ✅ | Config `bundles`/`defaultBundle` (D-R5 ids via shared `deriveBundleId` — no identity shift, proof test), shape-based "old" classification, §10.2 bundle lock shape, §11.5 startup guard at `ensureIndex` |
| 8.5a-d | ✅ | Writer flip to item_ref; display/content arm flips with §15-rule-5 golden re-designations; `parseStoredRef` + `legacy-ref-grammar` retired outside `src/migrate/` (grep gates 0); dual readers deleted; content migration (`.stash.json` fold + D-R6 reserved-file handling, journaled, idempotent, reported); mv re-key item_ref-only |
| 8.6 | ✅ | report.ts five-phase decomposition + finalize-lock split; ALL FOUR residual import-cycle knots killed — baseline EMPTY, ratchet absolute |
| 8.7 | ✅ | ≥1000-case re-key property gate vs the REAL `rekeyStateDb` (green, ~300s, slow-listed); orphan/rc-train/cross-binary/crash suites |
| CI-green | ✅ | 207 integration failures → 0; node-smoke re-keyed; five missed src bugs fixed (memory-inference child mint, extract candidate mint, cleanup parent read, website-crawler D-R6 reserved-name cache, enumerate-path nondeterministic listing order) |

## Gate results (chunk close)

- 4 → 3 DBs; grep `getWorkflowDbPath|openWorkflowDatabase|workflows/db` confined to the migrate/backup homes.
- Backup-verified restore green INCLUDING a v2 pre-cutover backup restored by the v3 binary.
- Orphan fixture completes-with-quarantine; rc-train FROM-state round-trip green; migration suites EXTENDED (§15.3), never rewritten.
- Re-key merge property test: 1000 generated cases × 3 model widths, all 5 invariants, green.
- Import-cycle participant baseline: EMPTY; ratchet absolute (DoD 11). Dynamic-import baseline untouched.
- fn-size ratchets green (report/akmPropose/handlePromoteOp/mv extractions recorded; baselines only shrank).
- Grep gates: `parseAssetRef|makeAssetRef|refToString` outside migrate 0; `legacy-ref-grammar|parseStoredRef` outside migrate 0.
- Test-literal ratchet: 111 → **50** (ceiling lowered stepwise, shrink-only; survivor analysis below).
- Batteries at close: unit 0 fail; integration 4610/4611 (the one: `add website` — later root-caused
  as a real D-R6 crawler bug, see Landed row "CI-green"). NOTE (2026-07-20 correction): unit pass
  totals recorded during this chunk (10256/10736) were 4x-inflated — bun `--shard` was silently
  ignored by the pre-file-list runner, so all four "shards" ran the full suite and the aggregate
  summed them; the true suite is ~2564 fast / ~2684 slow-inclusive tests. Fail counts were unaffected
  (a failure would have surfaced in every duplicated run).

## §11.4 MUST-rekey coverage (audited line-by-line)

usage/feedback events ✅ (rescued + re-keyed; writers item_ref) · utility records ✅ (index-resident, regenerable) ·
proposal targets ✅ (`proposals.ref` re-keyed; writers item_ref) · **workflow and task target refs ✅** (drift
CAUGHT in the close audit: `workflow_runs.workflow_ref` was initially left legacy on a delegate's
"internal run-key" rationale — corrected: writers mint `workflows/<name>` via the single
`canonicalWorkflowRunRef` helper and the cutover re-keys pre-existing rows by deterministic spelling
transform; `task_history.target_ref` re-keyed in 8.2) · accepted-change history ✅ (proposals table) ·
memory retirement/outcome ✅ (`asset_salience`/`asset_outcome`) · bindings n/a (Tier B, never minted) ·
graph rows ✅ (file-path-keyed by #624-P1, no ref key).

## Ratchet survivors (50) — dispositions

- Index `entry_key` seeds (`${stashDir}:${type}:${name}`): index.db-internal, regenerable, NOT durable
  state — sanctioned; dies if/when entry_key itself is retired (post-0.9.0).
- `derived_from` channel (`memory:<name>` in index column + `source:` frontmatter backref): deliberate
  WI-8.5c decision — producer+consumer-consistent legacy channel with a tolerant reader
  (`parseMemoryRef`); flipping it is a coupled content-migration follow-up, not a ref-grammar item.
- Error-message / prose / `$env:` PowerShell / `session:<harness>:<id>` provenance: not refs.
- Consolidate LLM-prompt refs: FLIPPED at close (chunking.ts → `memories/`), removed from survivors.
- Workflow run-key family: FLIPPED at close (see §11.4 above), removed from survivors.

## Open deferrals (tracked)

1. **#37** — full old-config-shape retirement (setup emits bundles; `stashDir`/`sources`/`installed`
   out of schema; installed→bundle re-sync; desired-vs-resolved lock split). Transitional state is
   coherent: old-shape-alone loads, mixed shape hard-rejects, migrator emits bundles.
2. **#39** — `.stash.json` live-reader removal blocked on a script-asset curated-metadata mechanism
   (no frontmatter equivalent for non-`.md`); sidecars are already folded+deleted at cutover.
3. `derived_from`/`source:` legacy channel (above) — candidate for a 0.9.x content migration.

## Process notes (for future chunk runs)

- The chunk gate is `bun run check` — lint + tsc + unit + INTEGRATION. Mid-chunk verification that
  substitutes unit-only batteries WILL miss integration fallout (this chunk: 207 failures found by
  CI, including 3 real src bugs).
- Never read a gate's verdict through a pipe (`| tail`) — capture the exit code; two premature
  pushes this chunk trace to pipe-masked exits.
- Run heavy batteries sequentially; parallel unit+integration runs starve each other.
- Distrust "environmental" failure labels: `add website` was carried for weeks as "needs live
  network" when the test serves from a local `Bun.serve` — the real failure was the crawler caching
  the home page as D-R6-reserved `index.md` (fixed: `index`/`log` basenames remap to `*-content`).
- A golden must never pin an un-`ORDER BY`'d SELECT's row order: it tracks the query plan and
  index-insertion (readdir) order, both machine-dependent — it passes on the capture machine and
  fails everywhere else. `enumerateEntries` now sorts type→name→filePath explicitly and the
  scored-vs-enumerate golden was re-captured under that order (registry notes updated).
- Never trust a flag a runner passes without verifying its effect: bun `--shard` was silently
  ignored (locally) or partially applied (CI, different bun patch release) for the entire chunk —
  aggregate pass counts were 4x-inflated and looked plausible. Both batteries now shard by explicit
  file lists and hard-fail unless files-ran == files-found.
