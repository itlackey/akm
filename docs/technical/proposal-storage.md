# Proposal storage — SQLite single source of truth (#578)

Status: shipped in 0.9.0.

This document maps the proposal lifecycle as it existed before 0.9.0, the
consolidated design that replaced it, and the migration path for existing
stashes.

## The problem

Proposal storage was split across two stores, only one of which was real:

- `state.db` had a `proposals` table (created by migration `001-initial-schema`
  with `id, stash_dir, ref, status, source, created_at, updated_at, content,
  frontmatter_json, metadata_json`) plus `upsertProposal` /
  `listStateProposals` / `getStateProposal` helpers in `src/core/state-db.ts`.
  **Nothing ever called the helpers** — the table was empty in every
  production install. `scripts/migrate-storage.ts` (the v0.7→v0.8 storage
  migration) imported events and task history into state.db but never touched
  proposals.
- The actual store was per-uuid JSON directories on the filesystem, owned by
  `src/commands/proposal/validators/proposals.ts`:

  ```
  <stashDir>/.akm/proposals/<id>/proposal.json          # live (pending) queue
  <stashDir>/.akm/proposals/<id>/backup.<ext>           # pre-promotion backup
  <stashDir>/.akm/proposals/archive/<id>/…              # accepted/rejected/reverted
  ```

  Archival was a physical directory move; "live vs. archived" was encoded in
  the on-disk location, and the revert backup was a sibling file referenced by
  a relative path stored in the proposal's `backup` field.

## Lifecycle map (pre-0.9.0)

Every reader and writer funnelled through the module-level API of
`src/commands/proposal/validators/proposals.ts` — there were **no** direct
filesystem readers of `.akm/proposals/` elsewhere in `src/`:

| Operation | API | Callers |
|---|---|---|
| create | `createProposal` | `akm propose` (propose.ts), reflect, distill, extract, consolidate, improve (memory inference), schema-repair, `akmProposalCreate` |
| list | `listProposals` | `akm proposal list` (proposal.ts), drain engine, improve backlog/dedup scans, consolidate, reflect (rejected-history prompt context), sources/history accept-rate metrics |
| read one | `getProposal` / `resolveProposalId` | `akm proposal show/diff/accept/reject/revert` |
| accept | `promoteProposal` (validate → `writeAssetToSource` → archive, capturing a backup) | `akm proposal accept`, drain promote, improve auto-accept gate (`runAutoAcceptGate`) |
| reject | `archiveProposal` | `akm proposal reject`, drain reject, orphan purge, expiration |
| revert | `revertProposal` (restore backup via `writeAssetToSource`) | `akm proposal revert` |
| expire / purge | `expireStaleProposals`, `purgeOrphanProposals` | improve maintenance passes |

The table was bypassed simply because the file store shipped first (#225) and
the state.db consolidation (#204) wired up events/task-history but never
migrated the proposal write path.

## Chosen design

The `proposals` table in `state.db` is canonical. The public API of
`validators/proposals.ts` is unchanged (same functions, same error types and
codes, same envelope shapes), so every caller above — the `akm proposal *`
commands, the drain engine, the improve auto-accept gate, history metrics —
moved to SQLite without touching their code.

Storage rules:

- One row per proposal, `id` (UUID) primary key, partitioned by `stash_dir`.
- Archival is a **status flip** (`pending` → `accepted`/`rejected`/`reverted`),
  not a move. The live queue is `WHERE status = 'pending'`.
- `sourceRun`, `review`, `confidence`, and `backupContent` live in
  `metadata_json` (the designed extension point); indexed query columns are
  unchanged from migration 001.
- The pre-promotion backup is inlined as `backupContent` on the row (it is the
  prior content of a single small asset file). The standalone `backup.<ext>`
  file and the path-valued `backup` field are gone; `akm proposal revert`
  reads `backupContent` instead. The field is internal — `akm proposal show`
  output shapes never surfaced it.
- All access goes through one helper (`withProposalsDb`): open `state.db`
  (WAL, `busy_timeout=5000` — same PRAGMAs as events), run the legacy import
  once per stash, do the work, close. The `ProposalsContext.dbPath` test seam
  mirrors `EventsContext.dbPath`.
- Concurrency: WAL mode allows concurrent readers during a write and the busy
  timeout serialises concurrent writers — strictly stronger than the old
  multi-process file-store behaviour (which had no locking at all).

### Why SQLite (and not files)

- Consistent with the project's SQLite-first direction (events, improve_runs,
  task_history, workflow runs all live in state.db / workflow.db).
- The dedup/cooldown guard and the drain backlog scans are queries, not
  directory walks; status/ref lookups are indexed.
- Proposals are non-regenerable queue state — exactly the class of data
  state.db's additive-migration contract was built for.
- Corrupt-file handling disappears: rows are written by parameterised SQL, so
  the "invalid proposal.json stub" branch of `listProposals` is gone.

## Fate of the file path: one-shot import, files left in place

The files were the real store, so existing pending/archived proposals must
keep working. On the first proposal operation against a stash (any read or
write through `withProposalsDb`):

1. If `proposal_fs_imports` (migration `005-proposal-fs-imports`) already has
   a row for this `stash_dir`, skip — no directory walk.
2. Otherwise, if `<stashDir>/.akm/proposals/` exists, walk the live and
   archive trees, parse each `proposal.json`, inline any referenced
   `backup.<ext>` file as `backupContent`, and `INSERT OR IGNORE` (keyed on
   the UUID) so re-runs and partially-imported states never duplicate or
   clobber rows that were since mutated through the canonical store.
3. Record the stash in `proposal_fs_imports`.

The legacy files are **never modified or deleted** — deleting user data
automatically is out of bounds; after import they are inert and the operator
can remove them at leisure. Corrupt legacy entries are skipped with a warning
and never block the rest of the import (matching the old tolerance for
invalid proposal files).

The dead code path removed: the fs read/write primitives, `getProposalsRoot`,
`isProposalArchived` (exported but unused), and the directory-move archival.

## Knock-on notes

- `docs/technical/v1-architecture-spec.md` §11.1 and `docs/migration/v1.md`
  now describe the table as the store and the legacy layout as import-only;
  the contract tests pinning those sections were updated in lockstep.
- `scripts/akm-eval` retains a read-only filesystem fallback
  (`src/sources/stash-fs.ts`) for environments without the CLI; it still reads
  legacy files but will not see post-0.9.0 proposals. Its primary CLI-shell-out
  path is unaffected. Tracked as an eval-harness follow-up.
- `shapeProposalEntry` (output layer) projects only
  `id/ref/status/source/sourceRun/createdAt/updatedAt/payload/review` — the
  storage change is invisible in `akm proposal *` output, as required.
