# Chunk 8 — Three-DB merge + migration cutover + config/lockfile (execution brief)

Status: OPEN (2026-07-20). Authorities: chunk manifest id 8; plan §3.2/§3.3/§3.4/§8/§10.7/§12.2-12.3/§15;
normative spec §10.1/§10.2/§11.1/§11.4/§11.5; ref-grammar decision (D-R4/D-R5/D-R6, "Chunk 8 then
consumes D-R5 as settled"). This brief pins the RECON-CORRECTED facts; where it contradicts the plan
prose, the brief (verified at HEAD) wins and the deviation is noted.

## Recon-corrected facts (verified at HEAD, 2026-07-20)

1. **State ledger** `STATE_MIGRATIONS` runs 001–019 (`src/core/state/migrations.ts`); next free id **020**
   (the plan's "018-<name>" example predates 018/019 landing). Shared engine
   `src/storage/engines/sqlite-migrations.ts` (sha-256 body sealing; `generationMarker` hook).
2. **The journaled-step seam exists**: `src/cli/config-migrate.ts` `runMigrationApply` drives
   `prepared → state-applied → workflow-applied → config-applied → committed` via the on-disk
   `ApplyJournal` (formatVersion 2) + `fingerprintMigrationGeneration`. The cutover extends this
   phase machine; it does NOT invent journal plumbing.
3. **`consolidation_judged` and `recombine_hypotheses` are DROPPED** (migration 018) — NOT re-key
   targets, deviation from plan §3.2. `improve_runs` and `extract_sessions_seen` carry **no
   asset-ref column** — not re-key targets either (plan §3.2 stale).
4. **Actual state.db re-key surface**: `asset_salience.asset_ref` (PK), `asset_outcome.asset_ref`
   (PK), `proposals.ref` (bare `type:name`, written by `propose.ts` `expectedRef`), `events.ref`
   (nullable, caller-supplied), `task_history.target_ref`, `proposal_fingerprints.ref`
   (ref column only — the fingerprint hashes are opaque content addresses; post-flip inputs mint
   new fingerprints and old rows age out via retention; document the dedup-window reset),
   `canary_queries.anchor_ref`.
5. **`usage_events` lives in index.db** (`src/indexer/usage/usage-events.ts`), already largely
   re-keyed to `bundle//conceptId` by the F4c `rekeyUsageEventsToItemRef` finalize pass; historical
   orphans remain legacy-spelled. The cutover rescues the table into state.db (ATTACH,
   `INSERT…SELECT`, residual re-key in the same pass) BEFORE index.db is touched.
6. **`legacy_state` quarantine currently lives in index.db** (`ensureLegacyStateTable`,
   `index-schema.ts` v19) — a regenerable DB, so quarantine rows die on rebuild. The cutover
   RE-HOMES the quarantine archive into state.db (durable, auditable, purgeable) and carries the
   existing index.db rows across.
7. **Backup set today is 3 artifacts** (`ARTIFACT_NAMES` in `core/migration-backup.ts`: config.json,
   state.db, workflow.db). The cutover backup adds the **pre-rescue index.db** as a 4th artifact
   (manifest formatVersion 2 → 3 with backward-read of the 3-artifact shape).
8. **workflow.db surface**: 10 `WORKFLOW_MIGRATIONS` (final-shape DDL for
   `workflow_runs`/`workflow_run_steps`/`workflow_run_units` enumerated in the recon);
   runtime gateway `withWorkflowRunsRepo` (`workflow-runs-repository.ts:650`) — constructor takes an
   injected `Database`, so the repoint is zero SQL rewrite. Direct openers outside it:
   `cli/config-migrate.ts:643` (`runWorkflowMigrations`) and `core/migration-backup.ts`
   `activeWorkflowClaims` (:634, reads live leases/claims; post-merge reads state.db, RETAINS the
   workflow.db probe for pre-cutover generations).
9. **Config**: `bundles`/`defaultBundle` do NOT exist yet (`config-schema.ts`); `wikiName` is
   already gone. `resolve-ref.ts:186-206` and `indexer/installations.ts` (D-R5:
   `registryId ?? slugForPath`, `ensureUniqueId`) already anticipate the `bundles` key. A lockfile
   exists: `src/integrations/lockfile.ts` (`akm.lock` in $DATA, per-source entries) — superseded by
   the §10.2 bundle lock shape.
10. **Chunk 0b substrate is live** (`tests/_fixtures/migration/`): `generateRekeyState(seed, opts)`
    real-DB generator (4 spelling shapes, forced collisions), `checkRekeyInvariants(generated,
    rekeyFn)` verifying the 5 invariants (no key lost; event rows carried as-is with counts;
    scalar most-recently-updated wins; deterministic; idempotent), `RekeyFn = (dbPath, model) =>
    void` — **Chunk 8's real re-key function must be callable in this shape**. Also
    `buildRcTrainFromState` (ceiling `019-proposal-fingerprints`) and `buildOrphanBearingStateDb`
    (4 orphan spellings + live contrasts; deliberately does not pre-create `legacy_state`).
11. **Cycle baseline (10 participants, 4 SCCs)**: workflows trio `exec/step-work.ts →
    runtime/runs.ts → runtime/unit-checkin.ts` (Chunk-8-owned), plus residual `common.ts ↔
    paths.ts`, `config.ts → config-schema.ts → registry/types.ts → config.ts`,
    `indexer/passes/metadata.ts ↔ metadata-contributors.ts`. The chunk-8 gate is baseline
    **EMPTY** + ratchet absolute (DoD 11) — all four knots die here. `report.ts` (1,798 LOC,
    438-line `reportWorkflowUnitWithBarrier`) is NOT a cycle participant; its five-phase
    decomposition is the same-PR §10.7 refactor, not the cycle kill itself.
12. **`src/migrate/` inventory**: `legacy/legacy-layout.ts` is frozen + zero live importers (the
    migrator seed). `legacy-ref-grammar.ts` has ~32 live importers (the WI-8.5 sweep);
    `legacy-stash-json.ts` has 3 (`indexer.ts`, `manifest.ts`, `registry/build-index.ts`).
    Frozen `WORKFLOW_MIGRATIONS` ids+checksums copy: NOT yet present in `src/migrate/legacy/`.

## Landing order

- **Stage A (parallel, independent):**
  - WI-8.1 frozen legacy surface + backup 4th artifact + manifest v3 (backward-read v2).
  - WI-8.6 report.ts decomposition + ALL four cycle-knot kills → baseline empty, ratchet absolute.
- **Stage B (atomic landing, staged commits):** WI-8.2 cutover (map → state txn → quarantine →
  index rename → workflow.db delete; ledger row `020-three-db-cutover`) + WI-8.3 blast-radius
  repoint (withWorkflowRunsRepo → state.db; delete workflows/db.ts, getWorkflowDbPath,
  StorageLocations.workflowDb, bootstrapPreVersioningDb; retire the `workflow-applied` journal
  phase with backward-read). Dual readers stay alive through Stage B.
- **Stage C:** WI-8.4 config migration (`bundles`/`defaultBundle` emitted from the already-derived
  D-R5 ids; §10.2 lock shape supersedes integrations/lockfile.ts; `bindings:` NOT emitted; §11.5
  startup guard).
- **Stage D:** WI-8.5 writer flip to item_ref + survival sweep (~50 `// Chunk-8` arms, ~32
  legacy-ref-grammar importers collapse, `.stash.json` retirement + content migration incl. D-R6
  `index.md`/`log.md` conformance) + retire `parseStoredRef`.
- **Gates throughout (WI-8.7):** property re-key ≥1000 generated cases against the REAL RekeyFn;
  orphan fixture completes-with-quarantine; rc-train FROM-state round-trip; pre-cutover backup
  restored by post-cutover binary; migration suites EXTENDED not rewritten; full
  `AKM_RUN_SLOW_TESTS=1 bun run check:fast` green at every stage boundary.

## Standing rules

Same discipline as the Chunk-5 flip: intermediate commits tsc-green; batteries green at every
stage boundary; single push per landed stage after reading the full gate result (never compound
the gate read with the push). `bun test` always with `--timeout=30000`. No new trust machinery.
No bindings/lifecycle DDL. Migrator code all `@removeIn` next-minor under `src/migrate/legacy/`.
