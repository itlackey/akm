# Chunk 8 — cutover design (WI-8.2/8.3 mechanics)

Companion to `brief.md`. Pins the implementation decisions for the journaled cutover so the
Stage-B work lands against settled mechanics. Authorities: plan §3.2/§3.3/§8; normative §11.4;
brief.md recon facts (which override plan prose where they conflict).

## 1. Vehicle: DDL in the ledger, data movement in the journaled step

- **`020-three-db-cutover`** joins `STATE_MIGRATIONS`: pure, sealable, idempotent DDL only —
  `CREATE TABLE IF NOT EXISTS` for `workflow_runs`/`workflow_run_steps`/`workflow_run_units` at
  FINAL shape (the 10 `WORKFLOW_MIGRATIONS` folded — column lists per the recon inventory),
  `usage_events` (state.db home, same columns as the index.db original + indexes), and
  `legacy_state` (the quarantine archive, re-homed from index.db —
  `surface, old_ref, row_count, reason, quarantined_at, PK(surface,old_ref)`).
  The engine's no-DROP contract note in `state-db.ts` gets the cutover carve-out comment.
- **The data movement is CODE** — a new `ApplyJournal` phase `cutover-applied` inserted after
  `state-applied` in `runMigrationApply` (`cli/config-migrate.ts`), reusing
  `advanceApplyJournal` + `fingerprintMigrationGeneration`. The old `workflow-applied` phase is
  retired for post-cutover applies (backward-read: journals recorded by older binaries still
  parse; a resumed pre-cutover journal completes on the old path or fails closed to restore —
  pick the simpler, test-pinned behavior).
- **Fresh installs**: 020's DDL creates the tables empty; the data step detects nothing to move
  (no workflow.db, no pre-cutover index.db, no legacy-spelled state rows) and records itself
  complete. ATTACH is never issued when workflow.db is absent (ATTACH would CREATE the file).

## 2. The data step, in order (all inside the fail-closed gate until noted)

1. Backup (4 artifacts incl. pre-rescue index.db — WI-8.1's manifest v3), verify-restorable.
2. **Old-ref → item_ref map**: computed BEFORE any re-layout and persisted next to the
   ApplyJournal. Sources, in precedence order:
   (a) last-good index.db join — `entries.entry_key`/`item_ref` (the F4c
   `findEntryIdByLegacyRef`/`classifyLegacyRefForRekey` algebra, generalized to full-table);
   (b) frozen `legacy-layout.ts` walk of the configured stash roots (per source) for refs the
   index no longer holds. Never through new-layout code (§3.3 item 2).
3. **State cutover transaction** (bun:sqlite / SQLite 3.51 verified sequence):
   assert workflow.db exists (else skip merge), `PRAGMA database_list` check, ATTACH workflow.db
   + old index.db read-only OUTSIDE any txn, `BEGIN IMMEDIATE`, then:
   - `INSERT INTO … SELECT` the three workflow tables verbatim;
   - `usage_events` rescue: `INSERT … SELECT` with residual legacy `entry_ref` re-keyed via the
     map (rows already `bundle//conceptId` — the F4c majority — carried as-is); fresh
     AUTOINCREMENT ids are fine (`entry_id` is an index.db-generation-scoped provenance column;
     the relink pass re-derives it);
   - carry existing index.db `legacy_state` rows into the state.db table;
   - **full re-key** over the state tables with per-table merge policy (§3 below);
   - `COMMIT`; DETACH both (in-txn DETACH fails).
4. **Orphan taxonomy**: expected orphans (mapped to no live item) → rows moved to `legacy_state`
   with surface + old_ref + row_count + reason, counts reported, migration completes. Integrity
   failures (unparseable ref; row-count mismatch after the pass; collision without a defined
   merge) → fail closed to restore.
5. **index.db boundary** (AFTER the state txn commits; outside the fail-closed gate):
   journaled rename index.db (+`-wal`/`-shm`) → `index.db.pre-cutover-<runId>` quarantine; the
   next index run rebuilds from scratch (rebuild failure does NOT roll back the committed state
   cutover).
6. Journaled, idempotent deletion of workflow.db + sidecars, keyed on the committed ledger row.
7. `config-applied` (WI-8.4's bundles emission) then `committed` as today.

## 3. Re-key targets and per-table merge policy (recon-corrected)

Merge model = the Chunk 0b harness invariants: no key lost; event rows carried as-is with counts
preserved; scalar most-recently-updated wins; deterministic; idempotent. The legacy spellings of
one logical item (bare `type:name`, `origin//type:name`, `.derived` twins of both) collapse onto
one `bundle//conceptId[.derived]` key.

| table.column | policy |
|---|---|
| `asset_salience.asset_ref` (PK) | scalar — MRU wins on collision (compare `updated_at`) |
| `asset_outcome.asset_ref` (PK) | scalar — MRU wins |
| `events.ref` (nullable) | event — UPDATE in place, rows carried as-is |
| `proposals.ref` | event-shaped — UPDATE in place |
| `task_history.target_ref` | event-shaped — UPDATE in place |
| `proposal_fingerprints.ref` | ref column UPDATE only; fingerprint hashes untouched (opaque; post-flip inputs mint new fingerprints; dedup window resets at cutover — documented) |
| `canary_queries.anchor_ref` | UPDATE in place |
| `usage_events.entry_ref` (post-rescue) | residual legacy rows re-keyed; unmapped → quarantine |

Dropped/ref-less tables are NOT targets: `consolidation_judged`/`recombine_hypotheses` (dropped by
018), `improve_runs`, `extract_sessions_seen` (no ref columns).

**RekeyFn conformance**: the real re-key engine is exposed as
`(dbPath: string, model: RekeyModel) => void`-compatible (an adapter builds the old→new map from
the model) so `checkRekeyInvariants` runs it directly; the WI-8.7 property gate executes ≥1000
generated cases against THIS function, not a reference impl.

## 4. Blast-radius repoints (WI-8.3, lands with the cutover)

- `withWorkflowRunsRepo` → opens state.db (`resolveStorageLocations().stateDb` /
  `openStateDatabase` loan path); repository SQL unchanged.
- `cli/config-migrate.ts` `runWorkflowMigrations` path retired (backward-read of old journals);
  `activeWorkflowClaims` reads state.db post-merge, RETAINS a workflow.db read-only probe for
  pre-cutover generations.
- **`usage_events` readers/writers repoint index.db → state.db** (implied by the rescue; big):
  `src/indexer/usage/usage-events.ts` (schema fn moves out of index-schema `ensureSchema`),
  insert/query paths, ranking enrichment, improve eligibility/feedback scans, events command,
  `rekeyUsageEventsToItemRef` + `relinkUsageEvents` (their finalize-pass homes now open
  state.db). index.db drops the `usage_events` + `legacy_state` DDL (version bump).
- Delete `workflows/db.ts` (incl. `bootstrapPreVersioningDb`), `getWorkflowDbPath`,
  `StorageLocations.workflowDb`. Frozen ids+checksums copy (WI-8.1) is the only survivor.
- Test blast radius: ~25 files open workflow.db directly (recon list) — mechanical repoint;
  migration suites EXTENDED to cover the cutover, never rewritten (§15.3).

## 5. Open items consumed by later WIs

- WI-8.4: `bundles`/`defaultBundle` emission (D-R5 ids), §10.2 lock shape superseding
  `integrations/lockfile.ts`, §11.5 startup guard, `bindings:` never emitted.
- WI-8.5: writer flip (propose.ts `expectedRef`, salience/outcome write keys, consolidate
  provenance, workflow renderer/validator xrefs, knowledge frontmatter, feedback/manifest display
  arms) to fully-qualified item_ref; then the ~32 `legacy-ref-grammar` importers collapse,
  `parseStoredRef` retires, `.stash.json` dies with the content migration (D-R6 conformance:
  reserved `index.md`/`log.md` never items, producer emits §6/§7 shapes only).
