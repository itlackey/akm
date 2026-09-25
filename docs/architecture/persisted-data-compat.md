# Persisted-Data Compatibility Contract

akm persists state in twelve-odd formats across releases: config, three SQLite
databases, task and workflow documents, native scheduler rows, transaction
journals, and a few smaller JSON/text payloads. Each has grown its own
versioning and its own failure behavior. This document is the one place that
states what a reader owes data an earlier release wrote, and inventories how
close each format is to that contract today.

## The contract

A reader must tolerate anything an earlier release wrote: convert the old
shape in memory, warn once, and name `akm migrate apply` as the on-disk
cleanup path — the migrator is where an explicit, backed-up rewrite happens,
never a precondition for reading. The only refusal a reader is allowed is data
written by a release *newer* than itself, and that refusal must name the
remedy (upgrade akm). Bundle content is never rewritten just to make it
readable again by an older or current binary. Every format-version bump must
ship with its old shape covered by the upgrade rehearsal gate
(`tests/integration/upgrade-rehearsal/`) and, for `config.json`
specifically, by the schema-compatibility lint
(`scripts/lint-config-schema-compat.ts`).

## Formats

| Format | Where written | Version marker | Older data | Newer data | Gate |
| --- | --- | --- | --- | --- | --- |
| `config.json` | `src/core/config/config.ts` | `configVersion` field, plus the retired-keys registry (`src/core/config/retired-keys.ts`) for individual keys | A known old `configVersion` is auto-upgraded in memory by `src/core/config/config-version-shim.ts` (`upgradeConfigVersion`) with a one-line warning; retired keys are dropped with a warning before schema validation; the legacy `stashDir`/`sources[]`/`installed` shape is the one registered-retired shape that is *converted* rather than dropped — `migrateLegacySourceShape` (`src/core/config/legacy-source-shape-shim.ts`) folds it into `bundles`/`defaultBundle` in memory on every load, and `akm migrate apply` persists that same conversion to the file once (`scripts/akm-migrate/migrate/config-legacy-source-shape.ts`) | Fails closed with `UNSUPPORTED_CONFIG_VERSION` (`config-version-shim.ts:109-118`), but the error message does not distinguish "newer than this binary" from "unknown/malformed" and its remedy text is written for the one known migration rather than a generic "upgrade akm" pointer. **Gap: message does not name the upgrade-akm remedy for the newer case.** | Upgrade rehearsal gate (`tests/integration/upgrade-rehearsal/`); schema-compat lint (`scripts/lint-config-schema-compat.ts`) |
| `state.db` | `src/core/state/migrations.ts` (append-only `MIGRATIONS` registry, applied by `src/storage/engines/sqlite-migrations.ts`) | `schema_migrations` ledger table | Migrations not yet applied are run forward on open | An older binary opening a `state.db` migrated by a newer akm continues with the schema it knows and warns once (`warnNewerStateLedger`, `src/core/state-db.ts:444`); it does not refuse | Upgrade rehearsal gate (`tests/integration/upgrade-rehearsal/`) |
| `index.db` | `src/storage/repositories/index-connection.ts` (`index-entry-schema.ts` for the generation constant) | `CANONICAL_INDEX_DB_VERSION`, read via `classifyIndexGeneration` | The read-only opener (`openIndexDatabase` / `assertCanonicalIndexGeneration`, `index-connection.ts:157-176`) refuses an older generation and names `akm index` to rebuild it; the writable opener rebuilds in place instead of refusing | Refused with "Upgrade akm to use this index." (`index-connection.ts:162-166`) | Upgrade rehearsal gate (`tests/integration/upgrade-rehearsal/`) |
| Task source (`tasks/*.yml`) | `src/tasks/source/parse-task-source.ts` | `version: 4` (`TASK_SOURCE_V4_VERSION`) | `version: 2` or `version: 3` is converted to v4 in memory by the same pure planners `akm migrate apply` uses, with a one-line stderr deprecation warning (once per file per process) and no disk write; a declared `version: 4` document whose `schedule[]` still carries a retired `enabled` key (0.9.15's v4 grammar accepted it) is tolerated the same way — routed through `planTaskToV4File`'s own `version === 4` branch, which strips the key without ever reading its value; only a shape the deterministic conversion itself cannot resolve still throws `TASK_SCHEMA_VERSION_UNSUPPORTED` naming the specific blocked reason | Any other `version` throws `TASK_SCHEMA_VERSION_UNSUPPORTED` naming `akm migrate apply` | Upgrade rehearsal gate (`tests/integration/upgrade-rehearsal/`); `tests/integration/previous-release-corpus.test.ts` |
| Workflow IR (frozen plans) | `src/workflows/ir/freeze-v4.ts`, read back in `src/workflows/runtime/plan-classifier.ts` | `irVersion` (`WORKFLOW_IR_V5_VERSION`) | Pre-`irVersion`-5 plans classify as `support: "unsupported-version"` with a message pointing at the exact complete-or-abandon policy (`plan-classifier.ts:45-58`); a frozen plan is never re-interpreted in place, it is completed or abandoned | A plan frozen by a newer akm (`irVersion` above what this binary knows) classifies the same way, with a message naming that it was "probably written by a newer akm" (`plan-classifier.ts:57-58`) | `tests/workflows/plan-classifier.test.ts` — unit only; the rehearsal builds no workflow run, so it exercises none of this |
| Native scheduler rows (crontab, Task Scheduler) | `src/tasks/backends/cron.ts` (`--scheduler-context` argument) | Presence/absence of `--scheduler-context` in the row's invocation | Rows written before 0.9.2 (no `--scheduler-context` at all) are recognized by `extractLegacyCronInvocation` (`cron.ts:516-530`) instead of being treated as foreign and colliding with sync | Plain `akm task sync` does not rewrite a row it can still match: when an installed binding is found, `installOptionsFor` (`src/tasks/scheduler-sync.ts:853-865`) keeps that binding's own recorded invocation and context path, so an older binary's row is left pointing at the older launcher. `akm task sync --rebind` is what repoints it to the current binary (the flag: `src/commands/tasks/tasks-cli.ts:419-425`; `installOptionsFor`'s `input.rebind` above). A row whose argv shape this binary cannot parse at all (for example one written by a newer akm using a grammar this binary predates) yields no resolved invocation, and `assertSchedulerNativeArtifactOwner` (`src/tasks/scheduler-binding.ts:369-381`) then refuses to touch it rather than overwriting it blind | Upgrade rehearsal gate (`tests/integration/upgrade-rehearsal/`) |
| Transaction journals | `src/core/fs-txn.ts` | `journal.version` (currently `1`, checked at `fs-txn.ts:347`) | Recovery rolls a journal forward from whatever phase it names; a version other than `1` fails the `version !== 1` check alongside the other shape checks, which surfaces as a generic corrupt-journal error rather than a dedicated "newer akm" message. **Gap: no distinct newer-akm path yet; only one version has ever shipped so this is unexercised.** | Same generic check as above | none — gap |
| Proposal `metadata_json` | `src/storage/repositories/proposals-repository.ts` | No explicit version field; presence/absence of the `changes` key | Rows from before the `changes` key existed (~89% of archived rows on real installs) are treated as a known legacy gap — decoded with an empty change list rather than thrown (`proposals-repository.ts:47-56`) | Not handled explicitly; an unrecognized shape falls through to the generic "Proposal row has invalid metadata_json" throw (`proposals-repository.ts:257`) rather than naming an upgrade. **Gap.** | `tests/proposal-repository-pure.test.ts` — unit only; the rehearsal builds no proposal |
| `task_history` metadata | `src/storage/repositories/task-history-repository.ts` | `metadataVersion` (currently `2`) | An absent `metadataVersion` is treated as a legacy row (58% of rows written by prior releases) and decoded best-effort; unknown fields are dropped harmlessly rather than round-tripped (`task-history-repository.ts:61-69`) | A `metadataVersion` newer than this binary's `2` is decoded best-effort as version 2 with a warning, rather than rejected (`task-history-repository.ts:85-89`) | Upgrade rehearsal gate (`tests/integration/upgrade-rehearsal/`) |
| Lock payloads | `src/core/file-lock.ts` | No version field; payload is a bare numeric pid string, or a JSON object carrying `pid` and optionally `launcherPid` (`extractLockIdentity`, `file-lock.ts:350-377`) | Any payload shape parses permissively — a payload the holder-pid extraction cannot parse is simply treated as having no launcher pid (`file-lock.ts:359-377`) rather than rejected | Same permissive parse; a payload from a newer akm that adds fields is read the same way | `tests/integration/file-lock.test.ts` (describe "probeLock: launcherPid (#956)") — not the rehearsal, which does not contend locks |
| Guarded directory manifests | `src/execution/guarded-source.ts` | Per-entry `version` (an mtime/ctime-derived stat fingerprint, `statVersion`) | Not applicable in the cross-release sense: a manifest is captured fresh within a single process (e.g. one `akm task sync` call) and compared only against another capture in that same run (`src/tasks/scheduler-sync.ts:966-968`); it is never read back from disk as a previous release's artifact | N/A, same reason | `tests/workflows/guarded-execution-source-red.test.ts` (describe "guarded touched-directory manifests and final source CAS") — not the rehearsal, which triggers no guarded execution |
| `.akm` residue | Documented in `docs/architecture/internals/storage-locations.md` | No version marker | Stale `.akm` directories or files from a previous layout are inert; nothing in current code reads or interprets them | N/A | none — gap (the closest coverage, `tests/migrate/dead-residue.test.ts`, tests the opt-in `akm health --clean-dead-residue` advisory, not that ordinary commands tolerate leftover `.akm` residue) |

## Adding a format or bumping one

1. Give the format an explicit version marker (a field, a table, a filename
   convention) if it does not already have one — "no marker" is not a
   compatibility strategy.
2. Write the reader so it converts an older marker in memory and warns once,
   per the contract above. Reserve throwing for data from a version this
   binary has never heard of, and name `akm migrate apply` (or the specific
   rebuild command, e.g. `akm index`) in the error.
3. Add the old shape as a fixture to
   `tests/integration/upgrade-rehearsal/` so a real previous-release
   binary's output is exercised, not just a hand-written fixture.
4. If the format is `config.json`, also register any removed or newly
   strict key in `src/core/config/retired-keys.ts` so
   `scripts/lint-config-schema-compat.ts` does not fail CI.
5. Add or extend the row in the table above, including a `Gap:` note if the
   code does not yet meet the contract — do not leave a mismatch undocumented.
