# Chunk 8 — execution ledger

Status: CLOSED (2026-07-20). CI fully green at 69a48aa4 — check (lint+tsc+unit+integration,
sharded) + node-smoke (22, 24) + smoke + actionlint. Companion to `brief.md` + `cutover-design.md`.
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

> **Update 2026-07-21 (Group-C item 2, task #47) — `derived_from` channel FLIPPED, survivors 50 → 48.**
> The `derived_from` channel (the WI-8.5c survivor above) was flipped to the 0.9.0 `memories/<name>`
> grammar end-to-end, so it is no longer a survivor:
> - PRODUCER: `renderDerivedMemory` (memory-inference.ts) now writes `source: memories/<name>`, and
>   the index `derived_from` COLUMN producer (`metadata.ts`) normalises to the same conceptId.
> - READER: `parseMemoryRef`/`resolveParentRef` (derived-ref.ts) stay tolerant of BOTH spellings on
>   input (un-migrated disk) but their NORMALISED output is now `memories/<name>`.
> - CONSUMERS (flipped in lockstep so the parentRef comparison never mismatches): `memoryCleanupParentRef`
>   (eligibility.ts) + `collectDerivedMemories`' parentRef filter/`canonicalName` (memory-improve.ts) +
>   the `getDerivedForParent` lookup key (search-hit-enrichers.ts) + the contradiction-detect grouping.
> - CONTENT MIGRATION: `content-migration.ts` gained a third journaled fold that rewrites on-disk
>   `source: memory:<name>` → `source: memories/<name>` (idempotent, reported as `sourceBackrefsRewritten`).
>   The index column needs NO migration — it is regenerable, so the producer flip + a reindex re-key it.
> - RATCHET: ceiling lowered 50 → 48 (the two `source: memory:deploy` fixtures in
>   improve-dry-run-side-effects.test.ts were the only derived_from tokens in the counted scope; the
>   memory-specific suites are skip-listed). Deferral #3 below is thereby CLOSED.

## Open deferrals (tracked)

1. **#37 — CLOSED (2026-07-21)**: full old-config-shape retirement landed. Schema hard-rejects
   `stashDir`/`sources`/`installed` whenever present (migrate-apply hint); every writer emits
   `bundles`/`defaultBundle`; installed bundles carry the DESIRED descriptor (git/npm + registryId)
   with resolved roots only in the §10.2 lock (the lock shape itself landed in WI-8.4 — the split
   was config-side); readers moved to bundles+lock (isEditable via writable+localRoot;
   source-identity via defaultBundle path); `inspectConfig` still classifies old-shape configs as
   migration-eligible via the normalizing probe. Notable semantics ratified at close: locator-form
   origins (`github:owner/repo//…`) do not resolve — the canonical bundle segment is the configured
   key per D-R5; concurrent setup+add on `bundles` is a genuine same-field precommit conflict
   (fail-closed); non-interactive setup preserves existing plain secondary bundles.
2. **#39 — CLOSED (2026-07-20, user decision)**: `.stash.json` sidecar metadata is dropped outright
   ("officially retired two versions ago"). The three live readers
   (`indexer/manifest.ts`, `indexer/indexer.ts`, `registry/build-index.ts`) no longer call
   `readLegacyStashOverrides`; sidecar-only dirs (including never-migrated remote registry stashes)
   contribute only frontmatter-recognized entries with generated metadata. The module survives in
   `src/migrate/legacy/` for the cutover's fold step only.
3. `derived_from`/`source:` legacy channel (above) — candidate for a 0.9.x content migration.
   **CLOSED (2026-07-21, Group-C item 2 / task #47)**: flipped to `memories/<name>` producer +
   consumer + reader-wide; the coupled content-migration fold rewrites disk content forward. See the
   dated update in "Ratchet survivors" above. Survivors 50 → 48.

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
