# Legacy-stash → 0.9.0 migration review — defect report

**Scope.** The one-time migration that upgrades a 0.8.x install to the 0.9.0
"bundle" layout: `akm migrate apply` (`src/cli/config-migrate.ts`), the backup /
restore machinery (`src/core/migration-backup.ts`), the three-DB cutover and
re-key engine (`src/migrate/legacy/three-db-cutover.ts`), the content / config /
task / proposal folds (`src/migrate/legacy/*`), and the frozen resolver
(`src/migrate/legacy/legacy-layout.ts`, `src/migrate/legacy-ref-grammar.ts`).

**Method.** Every defect below is backed by a **passing unit test** under
`tests/_review_proofs/` that exercises the real migrator functions (or the real
`migrate apply` / `backup restore` flow) and demonstrates the bad outcome. 65
proof tests across 34 files pass (0 fail). Findings were produced by fanned-out
per-module reviewers, each candidate then independently proven or refuted by a
separate agent that wrote and ran a test; 30 candidates → 27 confirmed, 3
refuted. Four were additionally reproduced by hand.

Two categories, as requested:
**(A) migration-failure** — a legitimate 0.8.x install cannot complete `migrate
apply`, or wedges in an unresumable state.
**(B) data-loss / rollback-restore** — data is silently lost, or the user cannot
return to their pre-migration state.

Severity legend: **Critical** = data destroyed or install permanently unusable
with no in-tool remedy · **High** · **Medium** · **Low**.

---

## Category A — migration fails or wedges

### A1 · HIGH · A durable `vault:` / `tool:` ref permanently blocks the entire migration
*`three-db-cutover.ts` `classifyCutoverRef` L417-427 → throws at rekeyEventTable L622 / rekeyScalarTable L531. Proof: `cutover-rekey-engine-0`, `cutover-refmap-0`, `frozen-resolver-0`.*

`vault` and `tool` were first-class 0.8.x asset types (removed in 0.9.0 —
`DEPRECATED_REJECTED_TYPES = {tool, vault}`). Any durable state.db row keyed to
such a ref (an `events` audit row, `asset_salience`/`asset_outcome`, a
`proposal`, `task_history`, …) survives forever in the append-only streams.

During the cutover re-key, a `vault:prod` ref is not in the ref map (the frozen
resolver's `TYPE_DIRS` and the index join can never mint a `vault` mapping), so
`classifyCutoverRef` falls through to `parseStoredRef("vault:prod")`, which
**hard-throws** on the removed type. The bare `catch` turns that throw into
`{kind:"integrity"}`, and the engine raises `CutoverIntegrityError`. The apply
flow fail-closes: the transaction rolls back and the verified backup is
restored — cleanly, but the offending row is restored **intact** every time. So
every subsequent `migrate apply` re-hits the same row, re-throws, and restores
again. **The install can never advance to 0.9.0**, and hand-editing state.db is
not a supported action.

Contrast (same test): a still-valid-type orphan like `skill:gone` is quarantined
into `legacy_state` and the migration completes. Only the *removed* types abort.

> **Fix direction:** in `classifyCutoverRef`, treat a parse failure caused by a
> removed/deprecated type as an expected orphan (quarantine to `legacy_state`),
> not an integrity failure. Reserve the integrity abort for genuinely malformed
> refs.

### A2 · HIGH · A crash inside the `state-converting` transaction wedges apply and restore
*`config-migrate.ts` `runStateMigrationStep` / `readApplyJournal` state-converting arm (throw L1374); fingerprint in `migration-backup.ts` L914-930. Proof: `apply-crash-recovery-0`.*

The first migration phase records `journal.generation` **before** opening
state.db, so on a default WAL install the recorded fingerprint has
`state.wal = null`. The conversion runs inside `db.transaction(...)` in WAL mode;
a power-loss/SIGKILL rolls the transaction back (marker never committed) but
leaves a hot `state.db-wal`/`-shm` on disk. On resume, `fingerprintMigrationGeneration`
now sees non-null `state.wal`, so the exact-generation guard fails and — because
no committed marker exists — the state-converting arm throws
*"does not match its exact marker-bound generation."* Nothing on the resume path
opens state.db read-write to checkpoint the stray WAL first, so the failure is
**deterministic on every retry**. `backup restore` is simultaneously refused
(*"Migration apply recovery is pending … run `akm migrate apply` before
restore"*). The two supported recovery commands point at each other. Escape
requires manually deleting the stray `-wal` (undocumented).

### A3 · HIGH · A crash during the three-DB merge wedges apply via a stray `workflow.db-shm`
*`config-migrate.ts` `workflowArtifactIsDeletionSubset` L1218 / `isAuthenticatedCutoverAdjacent` L1203; ATTACH in `three-db-cutover.ts` L745. Proof: `apply-crash-recovery-1`.*

`runFrozenWorkflowRoll` closes workflow.db cleanly, so the `workflow-applied`
journal records `workflow.shm = null`. The cutover then **ATTACHes the WAL
workflow.db**, which re-creates `workflow.db-shm`. There is no crash hook inside
the ATTACH..DETACH span, so a real power-loss there leaves a stray
`workflow.db-shm`. On resume, `fingerprintMigrationGeneration` reports
`workflow.shm != null`; `workflowArtifactIsDeletionSubset` and
`sameMigrationGeneration` both fail; every recovery arm throws *"does not match
the exact live artifact generation"*, and `backup restore` refuses while the
journal exists. Control (same test): deleting only the stray `.db-shm` lets the
identical interrupted migration resume to completion — proving the sidecar is the
sole cause and the merge itself was fully re-runnable. This is the **longest,
most crash-exposed step**, so the trigger is realistic.

### A4 · HIGH · A resolvable task target with `@` or `#` in its origin blocks the whole migration
*`task-target-ref-migration.ts` `renderScalarLike` L160-167 (throw L166). Proof: `task-target-migration-1`.*

A persisted 0.8 scheduled task whose `workflow:` target references a scoped-npm
(`npm:@scope/pkg//workflow:ship`) or version-pinned github
(`github:owner/repo#v1//workflow:ship`) source is **fully resolvable** — origin
resolves, the workflow file exists. But `renderScalarLike`'s allow-list regex
forbids `@` and `#`, so it throws *"the legacy workflow target uses an
unsupported YAML scalar style."* akm's own serializer (`yaml.stringify`) emits
these values **plain/unquoted**, so this is exactly the on-disk byte sequence a
normal install has. The throw is a preflight blocker (`migrate status` blocker +
first statement of the apply try-block), so **the entire upgrade is blocked** by
a healthy task, with a misleading error.

### A5 · MEDIUM · A single stale/dangling task `workflow:` target blocks the whole migration
*`task-target-ref-migration.ts` `assertWorkflowExists` L139-153 → blocker in `config-migrate.ts` L2003/2062. Proof: `task-target-migration-0`, `ind-task-target-lockout`.*

If any persisted task references a `workflow:` that no longer resolves (the
workflow was deleted/renamed — a normal occurrence over a stash's lifetime),
`planTaskTargetRefMigration` throws and the whole plan reports *"Migration is
blocked: … Repair or remove this task."* One stale auxiliary record blocks the
entire 0.9 upgrade. Planning is read-only and the message is actionable
(recoverable by fixing the task), so this is a robustness/UX defect rather than
data loss — but it is all-or-nothing (the first bad task aborts the scan of all
remaining good tasks).

### A6 · MEDIUM · Two bundles resolving to the same directory block the migration
*`task-target-ref-migration.ts` `bundlesFromConfig` L86-95 (throw L89). Proof: `task-target-migration-2`.*

If the migrated config has two bundles whose paths `realpath` to the same
directory (common when a user `akm add`-ed a local path that is also the
`stashDir`), task migration throws and the whole apply fails — even though the
config is a valid *runtime* 0.9 config that would otherwise load fine.

### A7 · MEDIUM · A non-slug `defaultWriteTarget` is never re-keyed, so the migrated config is rejected
*`config-source-migration.ts` `migrateConfigSourcesToBundles` L226-254. Proof: `config-source-migration-0`.*

Bundle **keys** are slug-sanitized by `deriveBundleId` (`my.docs` → key `docs`),
but the top-level `defaultWriteTarget` is carried through verbatim. The 0.9 schema
requires `defaultWriteTarget ∈ keys(bundles)`; `my.docs` is no longer a key, so
validation throws and `migrate apply` is blocked. A legitimate multi-source user
who named a writable source with a dot (`acme.docs`, `kb.v2`) and set it as their
default write target cannot auto-upgrade.

### A8 · MEDIUM · A stray `workflow.db` from a silently-failed unlink permanently wedges apply
*`three-db-cutover.ts` `deleteWorkflowDb` L957-973 (swallows non-ENOENT errors); return ignored by `config-migrate.ts` L1828. Proof: `cross-cutting-rollback-2`.*

`deleteWorkflowDb` swallows any `rmSync` failure other than ENOENT
(EACCES/EPERM/EBUSY — e.g. a Windows file lock or a read-only mount), logs, and
returns `{deleted:false}`, which the caller ignores. The first apply still
commits. But a leftover fully-migrated workflow.db is inspected as `"current"`,
so `migrate status` is permanently stuck `"ready"`, and every fresh `migrate
apply` re-enters the cutover with a new operationId, fails (*"no such table:
workflow_runs"*), and rolls back to the same stray state — forever.

---

## Category B — data loss / cannot restore

### B1 · HIGH · A real 0.8.x `index.db` has no `item_ref`, so live installed-bundle refs are quarantined and DELETED as false orphans
*`three-db-cutover.ts` `buildCutoverRefMap` item_ref guard L141, orphan DELETE L545-549/624-632. Proof: `frozen-resolver-1`.*

The cutover reads the **live** 0.8.x index.db with no reindex step. A real 0.8.x
index.db predates the `item_ref` column, so ref-map **source (a) is skipped
entirely** (`entryColumns?.has("item_ref")` is false). Source (b) only walks
filesystem bundles with a `.path`, and an installed git/npm bundle migrates to a
`{git|npm: ref}` locator with **no `.path`**, so it is never walked either.
Result: every durable state row keyed to an installed community-bundle asset —
`asset_outcome` (retrieval counts, outcome scores), `asset_salience`, `events`,
`proposals` — is absent from the map, classified as an "orphan," archived as
**ref+count only** into `legacy_state`, and **DELETED** inside the committed
cutover transaction. Immediately afterward `workflow.db` is unlinked, so rollback
cannot recover it. The asset file (`SKILL.md`) still exists on disk, so this is
**silent, unrecoverable loss of all accumulated learning signal for still-present
installed assets** — on the *default* migration path, not an edge case.

### B2 · HIGH · A corrupt `index.db` is silently dropped from the backup, then DELETED by rollback/restore
*`migration-backup.ts` `createMigrationBackupUnlocked` L594-595; `replaceArtifactsFromBundle` L1387-1393; `cleanupCommittedRestore` L1288. Proof: `backup-create-verify-0`.*

If index.db fails SQLite `quick_check` at backup time (single-page corruption, a
partial write, a transient locked open), it is recorded `present:false` and **not
copied** — no warning (`assertBackupEligible` deliberately ignores index.db). But
the *file is still on disk*. On the fail-closed rollback (or `backup restore`),
`replaceArtifactsFromBundle` sees the manifest says "absent" yet the live file
exists, renames it to `.restore-quarantine.*`, and `cleanupCommittedRestore`
then **`rm`s it permanently**. The restore that is supposed to return the user to
their exact pre-migration state instead **destroys their index.db and its
non-regenerable `usage_events` history** (the very data the cutover exists to
rescue). Self-concealing: the next `migrate apply` sees index.db missing, skips
the rescue, and succeeds — "failed once, then worked" — with the history gone.
The test seeds 20 readable `usage_events`, corrupts only a b-tree page so
`quick_check` fails while the rows stay readable, and proves both the file
deletion and the recoverable-data loss.

### B3 · HIGH · No-id `backup restore` restores the WRONG (newer rescue) snapshot
*`migration-backup.ts` `resolveBackupRun` L1318-1331; rescue minted L1454. Proof: `backup-restore-journal-0`.*

`resolveBackupRun` with no `--run` returns the **newest directory by mtime**, with
no provenance filter — despite the CLI help calling it "the newest applicable
run." But every restore first mints a **rescue** snapshot of the current (broken)
state into the same root. So a second no-id `backup restore` (a normal "make sure
it took" retry) selects that rescue and reverts the just-good restore — flipping
the user back into the migrated/broken state. A single post-migration `backup
create` triggers the same wrong selection on the first restore. Pre-migration
state is only reachable by passing an id the user has no reason to know; the
default recovery path actively defeats recovery.

### B4 · HIGH · `backup restore` is refused exactly when the live install is corrupt/newer/inconsistent
*`migration-backup.ts` `restoreMigrationBackup` L1438-1459 → `createMigrationBackupUnlocked`/`assertBackupEligible`; also `activeWorkflowClaims` L840 opens state.db with no try/catch. Proof: `backup-restore-journal-1`.*

Before restoring a good backup, `restoreMigrationBackup` force-creates an
**eligibility-gated rescue** of the *current* state. If the current state.db is
corrupt, `assertNoArtifactReplacementBlockers → activeWorkflowClaims` opens it
read-only and queries it with **no try/catch**, so an uncaught *"file is not a
database"* escapes and zero bytes are restored. If config.json is `"newer"` (an
accidental binary downgrade), the rescue aborts with *"artifact state is unsafe:
config.json=newer."* Either way the tool **refuses to restore a verified good
backup in the one scenario restore exists for**, with no `--force`/`--skip-rescue`
bypass. (The backup bundle itself remains intact on disk, so an expert could hand
-copy — but the tool won't.)

### B5 · HIGH · Restore cannot revert the filesystem — deleted `.stash.json` sidecars are gone for good
*`migration-backup.ts` restore set covers only config/state/workflow/index (L1346); filesystem folds in `content-migration.ts`, `task-target-ref-migration.ts`, `three-db-cutover.ts`. Proof: `cross-cutting-rollback-1`, `content-migration-2`, `ind-rollback-completeness`.*

The migration backup snapshots **only** config.json / state.db / workflow.db /
index.db. It never snapshots the stash filesystem. But after the cutover commits,
the content migration **deletes `.stash.json` sidecars**, **renames** reserved
files (`index.md` → `index-content.md`), **rewrites** task `.yml` targets, and
rewrites the pilot file — none captured by any backup. So `backup restore`
reverts the DBs+config to 0.8 but leaves the filesystem in 0.9 shape: **0.8
databases on a half-0.9 filesystem**, with the deleted curated sidecars
permanently unrecoverable. Proven end-to-end: after a real apply + real `backup
restore --confirm`, `configVersion` is back to `0.8.0` but the sidecar is still
gone and the renamed file stays renamed.

### B6 · HIGH · Curated `.stash.json` metadata is silently erased for non-markdown / missing / corrupt sidecars
*`content-migration.ts` `foldEntry` L256-273 + `foldSidecarInDir` L241-253 (unconditional `rmSync`). Proof: `content-migration-0`, `content-migration-1`, `ind-content-nonmd-loss`.*

The sidecar fold only writes curated fields into **`.md` frontmatter**, then
deletes the sidecar **unconditionally**. Three loss paths:
- **Non-markdown targets** (script/env/secret): the entry is skipped, its
  curated `description`/`quality`/`tags`/`run`/`setup`/`cwd` — which lived *only*
  in `.stash.json` — vanish with the sidecar. (0.8 merged sidecar overrides for
  every asset type; 0.9 no longer reads the sidecar.)
- **Missing target file**: same skip-then-delete.
- **Corrupt / wrong-shape `.stash.json`**: `readLegacyStashOverrides` returns
  `null`, so **zero entries are folded** and the entire sidecar is deleted — the
  whole curated file lost silently.

### B7 · MEDIUM · Interrupted pre-cutover migration + any out-of-band change wedges every migrate/backup command
*`config-migrate.ts` `authenticatePreConversionJournalForApply` L1444-1474 vs `restoreMigrationBackup` refusal. Proof: `apply-state-machine-0`.*

After a crash at `state-applied`, the 0.9 runtime rejects the still-old-shape
config, so no normal akm command works and the user may touch config.json. Any
change to config.json (or a stray state `-wal`) that alters its fingerprint then
makes `migrate apply` throw *"…does not match the exact live artifact
generation"* **before** the recovery try/catch, `migrate status` throw the same,
and `backup restore` refuse (*"apply recovery is pending"*). All migrate/backup
commands fail with **circular, contradictory guidance**. No data is lost (the
backup is intact) but recovery needs undocumented manual steps (delete the
journal file / hand-restore config.json).

### B8 · MEDIUM · A failed best-effort lock write silently orphans an installed git/npm bundle's content
*`config-migrate.ts` swallowed catch L2179-2181; producer `migratedLockEntries`; consumer `resolveEntryContentDir`. Proof: `config-source-migration-1`.*

An installed git/npm bundle migrates to a locator descriptor with no `.path`; its
resolved cache root is written **only** to the lockfile by `mergeLockEntriesSync`,
inside a swallowed try/catch in the forward-only region. If that write fails
(lockfile permission/contention), apply **still commits**, but the runtime can no
longer resolve the bundle's content dir (`lockContentRootFor` returns nothing).
The already-materialized content is silently orphaned; `migratedLockEntries` over
the now-migrated config returns `[]`, so no later `migrate apply` re-derives it.

### B9 · MEDIUM · Frontmatter fold corrupts an asset when its existing YAML doesn't strictly parse
*`content-migration.ts` `rewriteSourceBackrefsInDir`/`foldCuratedFields` → `mutateFrontmatter` lenient path. Proof: `content-migration-3`.*

When a file's frontmatter is not strictly valid YAML, `parseFrontmatter` falls
back to a **lenient scalar-only** regex parser that drops block sequences
(`tags:` + `  - item`), nested objects, and block scalars. If the file also has a
`source: memory:<name>` backref, the fold re-serializes the **lenient (lossy)**
object back over the file — permanently overwriting the sequence/nested bytes —
and counts it a success. A user's `tags`/`aliases`/nested metadata is silently
destroyed on an otherwise-recoverable file.

### B10 · LOW · First-wins bare-key mapping mis-attributes durable refs to the wrong bundle
*`three-db-cutover.ts` `addIndexEntryMappings` L167-188, `setMapping` first-wins L164. Proof: `cutover-refmap-1`.*

Source (a) iterates `entries` in rowid order with no tie-break. When a bundle's
config path does not `path.resolve`-match its stored `stash_dir`, that bundle is
treated as primary and claims the bare `type:name` key; first-wins means the
lower-rowid row wins. A bare durable ref that 0.8 resolved to the *primary*
bundle can be re-homed onto a non-primary bundle — curated durable metadata
silently attributed to the wrong bundle.

### B11 · LOW · D-R6 reserved-file rename misses concepts lacking `description`/`when_to_use` → de-indexed
*`content-migration.ts` `renameReservedConceptsInDir`/`carriesAssetFrontmatter` L287-323. Proof: `content-migration-4`.*

The reserved-filename rescue only renames an asset-bearing `index.md`/`log.md`
when it carries a literal `description`/`when_to_use` frontmatter key. A real 0.8
concept named `index.md` whose description was body/filename-derived (or that has
only `tags:`/`aliases:`/no frontmatter) is *not* renamed and is then dropped by
the 0.9 reserved-file exclusion — silently un-indexed. Non-destructive (file
stays on disk), gated on the uncommon reserved name.

### B12 · LOW · A source with an unbuildable descriptor is silently dropped from the migrated config
*`config-source-migration.ts` `oldConfigMigratableSources`/`sourceEntryDescriptor`; primary branch L123-143 has no fallback. Proof: `config-source-migration-2`, `ind-config-source-drop`.*

A `sources[]` entry whose descriptor can't be built (a `filesystem` source
missing `path`, a `git` source missing `url`) returns `undefined` and is
**silently omitted** from `bundles` — the whole source and every asset/ref under
it disappears with no error. Worse: if the omitted source is the `primary:true`
one, the `stashDir` fallback is suppressed too, dropping the working stash and
leaving `defaultBundle` undefined.

---

## Refuted (checked, not defects)

- **Orphan re-key deletes rows keeping only a count** — *by design.* The
  spec mandates the `legacy_state` count archive for genuine orphans (deleted
  assets). (This is distinct from **B1**, where *live* assets are wrongly
  classified as orphans because a ref-map source is skipped.)
- **`defaultBundle` undefined after migrating a sources-only config** — *no
  behavior change.* `resolveStashDir`'s fallback chain lands on the same
  `~/akm` the 0.8 install used; recoverable `STASH_DIR_NOT_FOUND` otherwise.
- **The stale-task block (A5) as "silent/unrecoverable"** — the block is real
  (reported as A5) but planning is read-only and the message is actionable, so it
  is a robustness/UX issue, not silent data loss.

---

## Highest-priority fixes

1. **B1** and **A1** are the two that bite a *default, realistic* 0.8→0.9
   migration hardest: B1 silently deletes live learning-signal data; A1 makes the
   upgrade impossible for any install that ever used a `vault`/`tool` asset. Both
   should be fixed before release.
2. **B2 / B3 / B4** together mean the recovery machinery can *destroy* data,
   restore the *wrong* state, or *refuse* to run — precisely when the user needs
   it. The backup/restore contract needs: back up (or refuse to delete) index.db
   even when unreadable; select the restore target by provenance, not mtime; and
   allow restore to proceed when the live state is unsafe (that is the point).
3. **A2 / A3 / B7** are crash-recovery wedges: the resume path should checkpoint
   or tolerate stray `-wal`/`-shm` sidecars rather than treat them as a generation
   mismatch, and the "apply pending" vs "restore refused" deadlock needs one
   documented escape.
4. **B5 / B6** — the restore contract silently excludes the filesystem, and the
   sidecar fold deletes curated metadata it cannot carry. Either snapshot the
   stash mutations or preserve non-markdown curated metadata before deleting the
   sidecar.

*All claims above are reproduced by the passing tests named in each heading,
under `tests/_review_proofs/`.*
