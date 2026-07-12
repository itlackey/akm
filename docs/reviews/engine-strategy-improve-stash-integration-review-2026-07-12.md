# Engine, Strategy, Improve, and Stash Integration Review

Date: 2026-07-12

Status: complete

## Scope

This review covers the engine and strategy refactor, improve orchestration, the
stash organization and backlink conventions, and the boundaries where those
features interact with sources, proposals, indexing, setup, health, and
migration behavior.

The goal is not merely for each feature to work in isolation. Engine selection,
strategy execution, source selection, convention context, writes, indexing, and
recovery must form one coherent end-to-end system.

## Integration Findings

### INT-1: `improve --target` does not consistently select the read or write target

Severity: Critical

The CLI passes a source name into both `AkmImproveOptions.target` and
consolidation, but the main improve option is unused. Consolidation treats the
value as a filesystem path while loading memories, then independently resolves
the write target without the explicit value. Auto-accept also promotes with an
empty target option.

Evidence:

- `src/commands/improve/improve-cli.ts:280-301`
- `src/commands/improve/improve.ts:85-99`
- `src/commands/improve/consolidate.ts:1089`
- `src/commands/improve/consolidate.ts:1797`
- `src/commands/improve/consolidate.ts:2822-2833`
- `src/commands/improve/improve-auto-accept.ts:244-245`

Impact:

`akm improve --target team` can load no memories because `team` is resolved as
a path relative to the current directory, while accepted proposals and
consolidation writes land in the default target instead of `team`.

Proposed solution:

Resolve one `ResolvedWriteTarget` at improve command entry. Pass its source
name, canonical root path, and write-boundary object through every improve
process, proposal promotion, consolidation operation, convention resolver, and
index update. Do not reuse one string for both a source name and a path.

### INT-2: Consolidation mixes read-only and duplicate cross-source memories

Severity: Critical

Without an explicit source path, consolidation loads every indexed memory from
all sources. It then keys entries by bare ref, discarding origin identity, while
merge writes and deletes operate on an independently selected writable target.

Evidence:

- `src/commands/improve/consolidate.ts:1819-1823`
- `src/commands/improve/consolidate.ts:2319-2339`
- `src/commands/improve/consolidate.ts:2827-2847`

Impact:

A read-only source can influence a plan applied to the primary stash. Duplicate
refs can overwrite one another in the lookup map, allowing content from one
source to drive a write or deletion against another source's asset.

Proposed solution:

Select one writable source before loading the consolidation pool. Filter the
pool to that source's canonical root and retain source identity throughout
planning. Never deduplicate cross-source entries by bare ref for a mutating
operation.

### INT-3: Improve-generated refs violate placement conventions

Severity: High

The stash conventions place scope-born memories and lessons under a project or
client slug and reusable knowledge under a stable domain. Improve generators
cannot reliably produce those layouts:

- Extract forbids `/` in candidate names.
- Distill flattens an input path into a root-level lesson.
- Knowledge promotion copies a memory's project path directly into the
  knowledge namespace, treating project scope as a domain.
- Recombine hardcodes `lesson:recombined/...` for a scope-born type.

Evidence:

- `src/assets/stash-skeleton/facts/conventions/organization.md:30-59`
- `src/commands/improve/extract-prompt.ts:59-63`
- `src/commands/improve/distill.ts:315-329`
- `src/commands/improve/distill-promotion-policy.ts:157-160`
- `src/commands/improve/recombine.ts:521-530`

Proposed solution:

Make placement deterministic application logic rather than unconstrained model
output. Preserve the project segment for scope-born outputs. Resolve a
controlled domain for reusable outputs. Validate the final canonical ref before
creating a proposal.

### INT-4: Improve provenance bypasses the live xref lifecycle

Severity: High

The new convention requires canonical `xrefs` for derived assets because that
channel is indexed and linted. Improve uses several incompatible channels:

- Distill adds fallback `sources` only to `payload.frontmatter`, while proposal
  promotion writes only `payload.content`; the fallback is lost on acceptance.
- Extract writes `sources` and uses `session:<harness>:<id>` instead of the
  canonical `session:<harness>/<id>` ref.
- Recombine writes `source_refs`.
- Procedural records no source refs in the generated asset.
- Search folds `xrefs`, but not these substitute channels, into hints.

Evidence:

- `src/commands/improve/distill.ts:1204-1226`
- `src/commands/proposal/repository.ts:1060-1115`
- `src/commands/improve/extract.ts:452-478`
- `src/commands/improve/session-asset.ts:264-275`
- `src/commands/improve/recombine.ts:843-853`
- `src/commands/improve/procedural.ts:449-456`
- `src/indexer/search/search-fields.ts:50-62`

Proposed solution:

Serialize canonical provenance `xrefs` into the actual proposal content before
the proposal is created. Keep specialized historical provenance fields only as
additional metadata after their indexing and lint semantics are explicitly
defined.

### INT-5: Built-in strategy composition is asymmetric

Severity: High

Selected built-ins merge only the selected JSON asset with user overrides, but
new user-defined strategies inherit the built-in default baseline. Plan
construction treats omitted process entries as disabled. `thorough` describes
itself as "Like default" while omitting and therefore disabling extract,
validation, and proactive maintenance.

Evidence:

- `src/commands/improve/improve-strategies.ts:92-107`
- `src/commands/improve/improve-strategies.ts:156-164`
- `src/assets/improve-strategies/default.json:3-18`
- `src/assets/improve-strategies/thorough.json:2-13`
- `tests/commands/improve-strategy-selection.test.ts:61-79`
- `tests/commands/improve-strategy-selection.test.ts:180-204`

Proposed solution:

Choose one composition rule. Prefer merging every strategy over the complete
default baseline and requiring explicit disables in specialized presets.
Alternatively, fully materialize every built-in and stop inheriting default for
new custom strategies. Snapshot effective behavior, not sparse source JSON.

### INT-6: Setup removes or fails to establish a general LLM engine default

Severity: High

Agent setup ignores an LLM-valued `defaults.engine`. When no agent is selected,
`writeAgentEngines` deletes `defaults.engine`. Detected LLM setup writes only
`defaults.llmEngine`, leaving generic LLM-capable commands without a selected
engine.

Evidence:

- `src/setup/engine-config.ts:28-37`
- `src/setup/engine-config.ts:84-87`
- `src/setup/setup.ts:393-395`
- `src/setup/setup.ts:665-708`
- `src/setup/detected-engines.ts:139-146`
- `src/commands/proposal/propose.ts:122-127`
- `src/tasks/runner.ts:404-407`

Proposed solution:

Agent selection must modify `defaults.engine` only when the selected general
default is an agent or the user explicitly requests replacement. On an LLM-only
installation, setup should set both `defaults.engine` and
`defaults.llmEngine` to the detected LLM unless the user already chose a
different general default.

### INT-7: OpenCode SDK fallback requirements differ by execution path

Severity: High

The config schema permits an OpenCode SDK agent without `llmEngine`. The SDK
runner can use native OpenCode configuration without a fallback, and workflow
freezing permits a null fallback. Canonical `resolveEngine` nevertheless rejects
the same engine with `LLM_NOT_CONFIGURED`.

Evidence:

- `src/core/config/config-schema.ts:260-276`
- `src/integrations/agent/engine-resolution.ts:277-287`
- `src/integrations/harnesses/opencode-sdk/sdk-runner.ts:295-322`
- `src/workflows/ir/freeze.ts:250-265`

Proposed solution:

Make fallback resolution optional in the canonical resolver and carry no
fallback when absent. If product policy instead requires a fallback, enforce it
consistently in schema validation, setup, workflow freezing, documentation, and
tests.

### INT-8: `akm mv` is not serialized or recoverable as one mutation

Severity: High

`akm mv` rewrites citer files sequentially, renames the asset and optional twin,
then rekeys databases and reindexes. It does not hold the index-writer lease used
by a full index, and it has no rollback if a later write or rename fails.

Evidence:

- `src/commands/mv-cli.ts:857-901`
- `src/indexer/indexer.ts:505-527`
- `src/indexer/index-writer-lock.ts:78-143`

Proposed solution:

Use a shared stash-mutation/index lease. Stage all rewritten files before
replacement, record a small recovery journal, rename the asset only after every
precondition succeeds, and roll back or resume deterministically after a partial
failure.

### INT-9: Health can pass while the improve LLM is unusable

Severity: Medium

Health checks only `defaults.engine ?? defaults.llmEngine`, so a healthy agent
default hides a broken improve LLM. For an LLM it resolves symbolic connection
configuration but does not materialize a required credential.

Evidence:

- `src/commands/health/checks.ts:85-98`
- `src/commands/health/checks.ts:166-182`
- `src/integrations/agent/engine-resolution.ts:218-230`

Proposed solution:

Report the general and LLM defaults independently. Verify the presence of a
required symbolic credential without exposing its name or value. Health should
reflect the engines used by improve, workflows, tasks, and generic dispatch
rather than selecting only one default.

### INT-10: Proposal acceptance and reversion bypass write-path indexing

Severity: Medium

Proposal promotion and reversion write assets and commit write targets but do
not call `indexWrittenAssets`. Accepted improve output can remain absent from
search and curate until a later full index, while show may find it through its
filesystem fallback.

Evidence:

- `src/commands/proposal/repository.ts:1112-1127`
- `src/commands/proposal/repository.ts:1189-1210`
- `src/indexer/index-written-assets.ts:48-59`

Proposed solution:

Index the written path after promotion and reversion. Keep indexing fail-open,
but make the write command responsible for immediate index freshness.

### INT-11: Unknown strategy processes validate and then disappear

Severity: Medium

The improve process map permits unknown keys, cross-reference validation only
handles known matrix entries, and plan construction rebuilds the process map
from the static matrix. A misspelled enabled process and its invalid engine
reference can therefore pass config validation and silently vanish.

Evidence:

- `src/core/config/config-schema.ts:594-608`
- `src/core/config/config-schema.ts:1293-1321`
- `src/commands/improve/improve-strategies.ts:156-201`

Proposed solution:

Reject unknown executable process names for the current config version. If
forward compatibility requires preserving unknown data, retain it in storage
but emit a prominent validation error or warning whenever it is marked enabled.

## Recommended Integration Boundary

Resolve one immutable improve invocation context at command entry containing:

- the selected strategy and frozen process engines;
- one resolved writable source and canonical root;
- source-qualified input identities;
- target-specific general and per-type convention context; and
- one promotion, write, commit, and index boundary.

This boundary addresses the target split, cross-source consolidation,
convention drift, provenance loss, and stale indexing as one integration problem
instead of adding more leaf-level fallback logic.

## Verification Completed

- `bun run check` passed. Its integration stage reported 798 passing and 42
  skipped tests.
- An additional 452 focused engine, strategy, improve, convention, lint,
  metadata, and move tests passed.
- Focused reproductions confirmed the SDK fallback mismatch, setup deletion of
  an LLM-valued general default, health false-positive behavior, sparse built-in
  strategy behavior, and silent dropping of an unknown improve process.
- Several tests currently pin the problematic behavior, so passing tests do not
  invalidate these findings.

## Upgrade and Migration Review

### Incident State (Generalized)

A read-only audit of the installation described in the incident found the
following state. Machine-specific paths, timestamps, and row counts are omitted
from this public review.

- The active config is a structurally valid 0.9.0 engine/strategy config.
- A post-attempt config copy is byte-for-byte identical to the active config,
  while legacy 0.8 config copies also remain.
- The moved bundle's manifest binds both databases to a deleted temporary root
  and records them as absent. It is not a recovery backup for the durable
  databases.
- The multi-gigabyte `state.db` passes `PRAGMA quick_check`, contains populated
  events, proposals, and improve-run tables, and has migrations 001 through 016.
  Migration `017-improve-run-strategy` has not run.
- `workflow.db` passes `PRAGMA quick_check`, contains workflow-run data, and has
  migrations 001 through 009. Migration `010-ir-v3-engine` has not run.
- The cutover columns added by migrations 017 and 010 are absent.
- Both databases therefore remain at the pre-cutover schema while the config is
  at the post-cutover schema.
- No valid migration recovery bundle currently covers the live databases.

There is no evidence that the attempt deleted assets, proposals, events,
improve-run rows, or workflow-run rows. The integrity checks passed and the
cutover migrations never ran. Logical equality with the pre-attempt databases
cannot be proven because no valid before snapshot exists. The changed
`state.db` mtime and empty WAL are consistent with the backup code's explicit
checkpoint, not evidence of row deletion.

This state should remain read-only until the migration implementation is fixed
or an independent, verified backup of the current config and databases is
created. The audit itself used read-only SQLite handles and made no changes to
the live artifacts.

### MIG-1: A current config without the singleton bundle causes permanent lockout

Severity: Critical

Every config mutation requires the pre-cutover bundle. Canonical state and
workflow opens also create or verify it before opening SQLite. Bundle creation
then refuses whenever the config is already 0.9.0.

Evidence:

- `src/core/config/config.ts:282-292`
- `src/core/config/config.ts:316-336`
- `src/core/config/config.ts:345-367`
- `src/core/state-db.ts:108-120`
- `src/workflows/db.ts:50-69`
- `src/core/migration-backup.ts:194-209`
- `tests/migration-backup.test.ts:95-98`

Impact:

A missing, corrupt, moved, or foreign bundle blocks future config writes and
durable database opens even when the installation is already current. The
safety mechanism creates the dead-end it is intended to prevent.

Proposed solution:

Remove migration-backup enforcement from ordinary config writes and database
opens. A backup should gate only an identified pending migration operation.
Current installations must not depend forever on a historical backup artifact.

### MIG-2: Cutover detection considers only config version

Severity: Critical

`assertNotAlreadyCutOver` treats `configVersion: 0.9.0` as proof that all
artifacts crossed the boundary, while backup creation does not inspect either
database migration ledger.

Evidence:

- `src/core/migration-backup.ts:194-209`
- `src/core/migration-backup.ts:223-299`
- `src/core/state/migrations.ts:778-802`
- `src/workflows/db.ts:403-408`

Impact:

- A current config with old databases is refused even though the databases can
  still be safely backed up before migration. This is the reported live state.
- An old config with already-migrated databases can be mislabeled as a complete
  pre-cutover backup.
- Restoring only an old config, as the error suggests, is not sufficient to
  establish database rollback safety.

Proposed solution:

Classify each artifact independently using raw config version and ordered
database migration IDs. Report `old`, `current`, `newer`, `inconsistent`,
`missing`, or `corrupt` for each artifact. Backup eligibility and migration
planning must use that complete state, not one config field.

### MIG-3: `config migrate` does not migrate and setup cannot perform recovery

Severity: Critical

`akm config migrate` is a version diagnostic that always rejects legacy config;
it never prepares or writes a replacement. Setup performs the same legacy
preflight before it can collect choices or apply an operator-provided 0.9
config.

Evidence:

- `src/cli/config-migrate.ts:10-58`
- `src/core/config/config.ts:191-199`
- `src/setup/setup.ts:137-150`
- `tests/integration/config-recovery-concurrency.test.ts:48-66`

Impact:

Users are told to recreate config manually outside AKM. The guidance does not
make backup creation an enforced first step. Following the documented manual
path can produce a current config before a valid database backup, exactly as in
the incident.

Proposed solution:

Provide one supported cross-artifact migration command. It may require an
operator-authored target config because profile-to-engine naming is ambiguous,
but it must validate that config in memory, create and verify backups, migrate
the databases, and atomically install the config in the correct order.

If `config migrate` remains diagnostic-only, rename it to avoid promising a
mutation it deliberately does not perform.

### MIG-4: Self-upgrade replaces the binary before running a nonexistent migration

Severity: Critical

Package-manager and binary upgrades install the new version, then invoke
`akm index`. The implementation still claims that loading config during index
will auto-migrate legacy configuration, but 0.9 strictly rejects legacy config
and removed the transforming migration.

Evidence:

- `src/commands/sources/sources-cli.ts:113-139`
- `src/commands/sources/self-update.ts:125-157`
- `src/commands/sources/self-update.ts:249-346`
- `src/commands/sources/self-update.ts:350-400`

Impact:

The new binary is installed before compatibility is established. Post-upgrade
indexing fails on the legacy config, no cross-artifact backup is guaranteed,
and the user is left with a binary that cannot use the existing installation.
The `--skip-post-upgrade` help and result text also incorrectly say a later
index will migrate config.

Proposed solution:

Stage and checksum the new binary. Run its read-only migration preflight before
replacement. Create and verify the migration backup while the old installation
is intact. Only then replace the binary and invoke the new binary's idempotent
migration apply command. Index rebuild is a separate post-migration step, not a
schema/config migration mechanism.

### MIG-5: Restore can destroy current data and publish a database beside the wrong WAL

Severity: Critical

Restore overwrites the current config and databases without first creating a
verified rescue snapshot of the current state. It restores artifacts
sequentially, and replaces a database before removing its old WAL/SHM sidecars.

Evidence:

- `src/core/migration-backup.ts:449-482`
- `src/core/common.ts:111-139`

Impact:

- Restore deliberately discards all post-upgrade state without a rollback of
  the restore itself.
- A crash or I/O error can leave config, state, and workflow artifacts from
  different epochs.
- A restored main database can temporarily coexist with a post-upgrade WAL.
  SQLite documents mismatched database and hot journal/WAL files as a corruption
  risk.

Proposed solution:

Before destructive restore, quiesce writers and create a verified rescue backup
of the current state. Stage every replacement, validate it, write a small durable
restore journal, quarantine each main database together with its sidecars, then
publish the clean staged files. Resume or roll back from the journal after a
crash. Never offer destructive restore without a verified rescue backup unless
a separately designed emergency mode requires an explicit stronger confirmation.

### MIG-6: The mandatory bundle is a global singleton in disposable cache

Severity: High

There is one fixed `$CACHE/migration-backups/0.9.0` bundle per cache root. Its
manifest binds exact config/data paths. Any existing bundle is reverified rather
than selecting or creating one applicable to the current installation.

Evidence:

- `src/core/migration-backup.ts:50-63`
- `src/core/migration-backup.ts:111-127`
- `src/core/migration-backup.ts:260-265`
- `src/core/paths.ts:168-172`
- `tests/_preload.ts:285-289`

Impact:

A temporary test or review environment sharing the cache can poison the live
installation, as occurred here. Clearing a directory explicitly treated as
regenerable cache deletes the rollback authority and then blocks normal durable
operations. The test harness has to delete shared bundles between tests to hide
this production property.

Proposed solution:

Store migration backups in durable data/state storage or an operator-selected
backup directory. Namespace them by installation identity and unique run ID.
Foreign and stale backups should be visible in status output but must never gate
normal operation or prevent creating an applicable backup.

### MIG-7: Backup verification and restore load entire databases into memory

Severity: High

SQLite snapshot creation correctly uses `VACUUM INTO`, but checksum verification
uses `fs.readFileSync`, and restore reads each complete database into a Buffer
before writing it.

Evidence:

- `src/core/migration-backup.ts:66-68`
- `src/core/migration-backup.ts:131-166`
- `src/core/migration-backup.ts:290-305`
- `src/core/migration-backup.ts:449-452`

Impact:

The incident `state.db` is multi-gigabyte. Whole-file hashing can exceed the
process memory limit after SQLite has already spent substantial I/O creating the snapshot.
Verification of an existing bundle and restore have the same unbounded memory
failure mode.

Proposed solution:

Hash files with a fixed-size read loop or stream. Restore by streaming or copying
to a same-directory staging file, fsyncing it, verifying its hash, and renaming
it. Never represent a database-sized artifact as one JavaScript Buffer.

### MIG-8: Read telemetry synchronously enters migration and backup machinery

Severity: High

Search, show, curate, and feedback append events. Event persistence opens the
canonical state database, which can trigger backup creation and schema
migration. The caller describes this as fire-and-forget and silently ignored,
but the call is synchronous and failures are written to stderr.

Evidence:

- `src/core/events.ts:238-288`
- `src/commands/read/search.ts:291-324`
- `src/core/state-db.ts:108-120`

Impact:

Read-oriented commands can synchronously checkpoint and copy multi-gigabyte
databases. In the current mixed state they repeatedly print the pre-cutover
backup refusal, lose telemetry, and still return success. This exact behavior
reproduced during this review with `akm curate` and `akm show`.

Proposed solution:

Migration must be an explicit startup/upgrade concern, never a side effect of
telemetry. If the state store is unavailable or pending migration, optional
telemetry should skip quietly and health/status should report the actionable
problem separately.

### MIG-9: The migration ledger cannot reject newer or divergent schemas

Severity: High

The shared runner stores only migration ID and timestamp. It treats any known
missing ID as pending but does not reject unknown IDs from a newer binary,
out-of-order/holey ledgers, or changed SQL under a reused ID.

Evidence:

- `src/storage/engines/sqlite-migrations.ts:63-100`
- `tests/storage/sqlite-migrations.characterization.test.ts`

Impact:

An older binary can write to a newer schema despite documentation saying it
must not. Editing a released migration body under the same ID produces different
schemas on old and fresh installations without detection.

Proposed solution:

Keep the existing ledger as the single schema authority; do not add a second
competing migration framework. Enforce that applied IDs are an exact ordered
prefix of the immutable registry. Reject unknown IDs on writable open. Store and
validate a checksum for each released migration body.

### MIG-10: Backup verification checks bytes, not SQLite recoverability

Severity: High

Verification checks source paths, modes, sizes, and SHA-256, but never opens the
snapshot as SQLite, checks its migration state, or runs an integrity check.

Evidence:

- `src/core/migration-backup.ts:131-175`
- `src/core/migration-backup.ts:223-258`

Impact:

A checksum can faithfully authenticate an already corrupt or semantically wrong
database. A bundle bound to the wrong schema epoch can pass byte verification.

Proposed solution:

Open each completed snapshot read-only, require `PRAGMA quick_check` to return
`ok`, verify the expected ordered migration prefix, then stream its hash and
publish the manifest last.

### MIG-11: The shipped backup task invokes a nonexistent command

Severity: High

The enabled weekly core task runs `akm db backups`, but no `db` command is
registered. The only current backup surface is the one-time
`akm backup create|restore --for 0.9.0` group.

Evidence:

- `src/assets/tasks/core/backup.yml:1-5`
- `tests/tasks-embedded.test.ts:16-23`
- `src/cli.ts:550-591`
- `src/commands/backup-cli.ts:18-59`

Impact:

Users can believe weekly config/database backups are running when the scheduled
command cannot execute. The test pins the invalid command instead of executing
it. The live stash also contains several duplicate, outdated knowledge assets
claiming `AKM_DB_BACKUP`, `AKM_DB_BACKUP_RETAIN`, and `akm db backups` are active
features, even though none exists in current code. Agent recall can therefore
reinforce a false safety model.

Proposed solution:

Disable the task until a real general backup command exists, or implement and
end-to-end test the command before enabling it. Add a contract test that executes
every embedded command template through CLI parsing. Supersede or remove the
outdated knowledge assets so improve/curate does not teach obsolete recovery
behavior.

### MIG-12: Restore exclusion is bypassed by a canonical state writer

Severity: High

`akm mv` opens the canonical `state.db` directly instead of through the managed
opener and therefore does not register a maintenance activity for the handle's
lifetime.

Evidence:

- `src/commands/mv-cli.ts:536-568`
- `src/core/state-db.ts:108-140`
- `src/core/migration-backup.ts:462-478`

Impact:

Restore can replace or remove `state.db` while the move operation writes
salience/outcome history through an unregistered handle. POSIX can strand writes
in an unlinked inode; Windows can fail restore midway.

Proposed solution:

Route every canonical durable database handle through one managed opener. Add a
module-boundary test that rejects raw `openDatabase(getStateDbPath())` and raw
workflow equivalents outside the canonical modules.

### MIG-13: Tests encode and mask the broken lifecycle

Severity: Medium

The direct current-config test expects backup refusal. The common test config
writer silently creates an absent-state bundle before writing any 0.9 fixture,
and the preload deletes shared bundles to avoid path poisoning. Setup tests
require legacy setup to fail before creating a backup.

Evidence:

- `tests/migration-backup.test.ts:95-98`
- `tests/_helpers/sandbox.ts:343-375`
- `tests/_preload.ts:285-289`
- `tests/integration/config-recovery-concurrency.test.ts:48-66`

Impact:

The suite passes because fixtures manufacture the invariant that production
users can easily violate. It has no successful end-to-end path from a real 0.8
config and pre-cutover databases through verified backup, operator-resolved
config, database migration, current operation, and rollback.

Proposed solution:

Replace helper-level bundle fabrication with explicit migration fixtures. Add a
matrix for old/current/newer/missing/corrupt config and database states, cache
loss, foreign bundles, large sparse databases, interrupted apply/restore, and
older-binary refusal.

## Minimal Safe Upgrade Process

The replacement should retain the good existing primitives:

- config locking and atomic config replacement;
- `VACUUM INTO` or the SQLite Online Backup API for live snapshots;
- one SQLite transaction per schema migration, with the ledger insert in the
  same transaction;
- immutable append-only migration registries; and
- the maintenance barrier during actual replacement.

It should remove the global pre-cutover-bundle invariant and use one small,
explicit coordinator.

### Command surface

Keep the surface small:

```text
akm migrate status
akm migrate apply --config <prepared-0.9-config>
akm backup restore --for 0.9.0 --run <backup-run-id> --confirm
```

`status` is always read-only and bypasses normal config loading. `apply` is
idempotent and doubles as resume after interruption. Setup may produce the
prepared target config interactively, but it calls the same coordinator. There
is no need for a generic workflow engine, migration service container, or
detailed mutable step machine.

### Apply order

1. Inspect raw config and both database ledgers read-only.
2. Reject newer, corrupt, or impossible ledger states with an artifact-by-
   artifact report.
3. Parse and validate the complete target config in memory without writing it.
4. Acquire one migration lock scoped to the canonical installation/data root.
5. Quiesce registered durable writers through the maintenance barrier.
6. Check free disk space and create a unique durable backup run containing every
   artifact that this migration will change.
7. Snapshot SQLite with `VACUUM INTO` or the Online Backup API, run
   `PRAGMA quick_check`, verify the source migration prefix, stream SHA-256, and
   publish the manifest only after every artifact passes.
8. Apply pending state and workflow migrations transactionally and re-check the
   ledgers/schema.
9. Atomically write the target config last. The current config version is the
   installation-level completion marker.
10. Remove the small active-operation marker and report the retained backup run.

Writing config last makes interruption straightforward. Database ledgers make
each migration retryable; the new binary sees an old config plus partially
advanced databases and resumes `apply`. Older binaries refuse writable opens
when they encounter unknown migration IDs.

### Backup layout

Use a durable, installation-scoped layout such as:

```text
$XDG_DATA_HOME/akm/backups/migrations/<installation-id>/<run-id>/
```

The manifest records canonical roots, source config version, source migration
IDs and checksums, artifact presence, sizes, streaming hashes, creation time,
target version, and completion status. A stale or foreign backup is diagnostic
only. It never blocks normal operation.

### Restore order

1. Inspect and verify the selected backup without changing live state.
2. Create and verify a rescue backup of the current live state.
3. Quiesce all durable handles.
4. Stage and validate all replacement files.
5. Write a small fsynced restore journal.
6. Quarantine current database files with their WAL/SHM sidecars.
7. Publish staged config/databases, fsync parent directories, and run final
   read-only integrity/schema checks.
8. Mark complete. On restart, resume or roll back using the journal and rescue
   backup.

### Self-upgrade order

1. Download, stage, and checksum the new binary.
2. Run the staged binary's read-only `migrate status` against the live roots.
3. Create and verify the applicable migration backup before replacing the old
   binary.
4. Atomically install the new binary while retaining the old binary until
   migration completes.
5. Run the new binary's `migrate apply`.
6. Rebuild the index only after config and durable schemas are current.
7. Remove the old binary only after successful verification.

Package-manager upgrades cannot always control binary retention, but they can
still run the same preflight/backup hook and print an exact migration command
instead of claiming `akm index` migrates config.

## Migration Safety Invariants

The implementation and tests should enforce these concise invariants:

1. No config or durable schema migration runs without a verified backup that
   matches the exact source artifact states.
2. No destructive restore runs without a verified rescue backup of current
   state.
3. Routine reads, telemetry, config writes, and already-current database opens
   never depend on a historical migration backup.
4. Unknown future database migration IDs refuse writable opens.
5. Applied migration IDs form an exact ordered prefix and released SQL checksums
   never change.
6. Backup and restore memory use is bounded independently of database size.
7. SQLite snapshots pass integrity and schema checks before they are advertised
   as recoverable.
8. A stale backup from another root cannot block or be restored into the current
   installation.
9. Interrupted apply and restore operations are detectable and idempotently
   resumable.
10. Every shipped scheduled task invokes a command that exists and is exercised
    by an end-to-end test.

## Mitigation Status

Implementation completed on 2026-07-12 using test-first correction tracks and
independent review gates. Each track was blocked and returned for correction
until reviewers found no remaining critical or high-severity issue.

| Finding | Status | Regression coverage |
| --- | --- | --- |
| INT-1 | Mitigated | Named-target resolution, triage promotion, reflect/distill lookup, and dry-run target tests |
| INT-2 | Mitigated | Duplicate-source consolidation, retrieval, relink, replay, and durable-state isolation tests |
| INT-3 | Mitigated | Scoped distill/recombine placement and flat-fallback tests |
| INT-4 | Mitigated | Session, procedural, and consolidation canonical `xrefs` tests |
| INT-5 | Mitigated | Built-in strategy baseline composition and snapshot tests |
| INT-6 | Mitigated | Setup default preservation, LLM selection, and explicit-none tests |
| INT-7 | Mitigated | Native OpenCode SDK and fallback credential resolution tests |
| INT-8 | Mitigated | Shared mutation lease plus `mv` rollback, no-clobber, and SIGKILL recovery tests |
| INT-9 | Mitigated | Independent defaults and active improve-plan engine/credential health tests |
| INT-10 | Mitigated | Journaled proposal accept/revert/reject, exact Git commit, and immediate indexing tests |
| INT-11 | Mitigated | Enabled unknown-process rejection and disabled-process preservation tests |
| MIG-1 | Mitigated | Current-config/current-database opens no longer require a historical bundle |
| MIG-2 | Mitigated | Independent config, state, and workflow classification tests |
| MIG-3 | Mitigated | Real top-level `migrate status/apply` CLI and prepared-config tests |
| MIG-4 | Mitigated | Current/staged binary preflight, retained binary, and future-config upgrade tests |
| MIG-5 | Mitigated | Rescue backup, WAL/SHM quarantine, authenticated restore, and crash recovery tests |
| MIG-6 | Mitigated | Durable installation-scoped unique migration-run tests |
| MIG-7 | Mitigated | Streaming copy/hash and bounded metadata/download tests |
| MIG-8 | Mitigated | Telemetry and routine read tests that do not enter migration machinery |
| MIG-9 | Mitigated | Exact-prefix, future-ledger, checksum sealing, and substitution tests |
| MIG-10 | Mitigated | SQLite `quick_check`, schema, and authenticated snapshot tests |
| MIG-11 | Mitigated | Invalid recurring backup task disabled; embedded-command contract tests added |
| MIG-12 | Mitigated | Managed state handles, activity blockers, and post-registration race tests |
| MIG-13 | Mitigated | Production-shaped lifecycle, concurrency, SIGKILL, and malicious-journal tests |

Final repository verification passed:

- `bun run lint`
- `bunx tsc --noEmit`
- `bun run test:unit`: 6,779 passed, 0 failed
- `bun run test:integration`: 852 passed, 42 gated skips, 0 failed
- `bun run check`

The incident was remediated only after an independent verified backup. All
durable SQLite artifacts passed integrity checks and reached their current
ledgers. Local backup paths and executable rollback locations are intentionally
not recorded in this public document.

## External References

- SQLite Online Backup API: <https://www.sqlite.org/backup.html>
- SQLite `VACUUM INTO`: <https://www.sqlite.org/lang_vacuum.html#vacuuminto>
- SQLite corruption guidance for backup/restore and WAL pairing:
  <https://www.sqlite.org/howtocorrupt.html>
- SQLite `quick_check`, `application_id`, and `user_version` pragmas:
  <https://www.sqlite.org/pragma.html>
