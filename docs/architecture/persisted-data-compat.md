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
(`tests/integration/upgrade-rehearsal/`, item A1) and, for `config.json`
specifically, by the schema-compatibility lint
(`scripts/lint-config-schema-compat.ts`, item A2).

## Formats

| Format | Where written | Version marker | Older data | Newer data | Gate |
| --- | --- | --- | --- | --- | --- |
| `config.json` | `src/core/config/config.ts` | `configVersion` field, plus the retired-keys registry (`src/core/config/retired-keys.ts`, item A2) for individual keys | A known old `configVersion` is auto-upgraded in memory by `src/core/config/config-version-shim.ts` (`upgradeConfigVersion`) with a one-line warning; retired keys are dropped with a warning before schema validation | Fails closed with `UNSUPPORTED_CONFIG_VERSION` (`config-version-shim.ts:109-118`), but the error message does not distinguish "newer than this binary" from "unknown/malformed" and its remedy text is written for the one known migration rather than a generic "upgrade akm" pointer. **Gap: message does not name the upgrade-akm remedy for the newer case.** | Upgrade rehearsal gate (A1); schema-compat lint (A2) |
| `state.db` | `src/core/state/migrations.ts` (append-only `MIGRATIONS` registry, applied by `src/storage/engines/sqlite-migrations.ts`) | `schema_migrations` ledger table | Migrations not yet applied are run forward on open | An older binary opening a `state.db` migrated by a newer akm continues with the schema it knows and warns once (`warnNewerStateLedger`, `src/core/state-db.ts:444`); it does not refuse | Upgrade rehearsal gate (A1) |
| `index.db` | `src/storage/repositories/index-connection.ts` (`index-entry-schema.ts` for the generation constant) | `CANONICAL_INDEX_DB_VERSION`, read via `classifyIndexGeneration` | The read-only opener (`openIndexDatabase` / `assertCanonicalIndexGeneration`, `index-connection.ts:157-176`) refuses an older generation and names `akm index` to rebuild it; the writable opener rebuilds in place instead of refusing | Refused with "Upgrade akm to use this index." (`index-connection.ts:162-166`) | Upgrade rehearsal gate (A1) |
| Task source (`tasks/*.yml`) | `src/tasks/source/parse-task-source.ts` | `version: 4` (`TASK_SOURCE_V4_VERSION`) | At this base, any `version` other than 4 throws `TASK_SCHEMA_VERSION_UNSUPPORTED` and points at `akm migrate apply --dry-run` — there is no in-memory read shim for v2/v3. **Gap: violates the contract above; item A3 restores the in-memory v2/v3 → v4 shim this document describes.** | Any `version` other than 4 throws `TASK_SCHEMA_VERSION_UNSUPPORTED` naming `akm migrate apply` | Upgrade rehearsal gate (A1); `tests/integration/previous-release-corpus.test.ts` |
| Workflow IR (frozen plans) | `src/workflows/ir/freeze-v4.ts`, read back in `src/workflows/runtime/plan-classifier.ts` | `irVersion` (`WORKFLOW_IR_V5_VERSION`) | Pre-`irVersion`-5 plans classify as `support: "unsupported-version"` with a message pointing at the exact complete-or-abandon policy (`plan-classifier.ts:45-58`); a frozen plan is never re-interpreted in place, it is completed or abandoned | A plan frozen by a newer akm (`irVersion` above what this binary knows) classifies the same way, with a message naming that it was "probably written by a newer akm" (`plan-classifier.ts:57-58`) | Upgrade rehearsal gate (A1) |
| Native scheduler rows (crontab, Task Scheduler) | `src/tasks/backends/cron.ts` (`--scheduler-context` argument) | Presence/absence of `--scheduler-context` in the row's invocation | Rows written before 0.9.2 (no `--scheduler-context` at all) are recognized by `extractLegacyCronInvocation` (`cron.ts:516-530`) instead of being treated as foreign and colliding with sync | N/A — sync always rewrites rows to the current binary's launcher path and argument shape | Upgrade rehearsal gate (A1) |
| Transaction journals | `src/core/fs-txn.ts` | `journal.version` (currently `1`, checked at `fs-txn.ts:347`) | Recovery rolls a journal forward from whatever phase it names; a version other than `1` fails the `version !== 1` check alongside the other shape checks, which surfaces as a generic corrupt-journal error rather than a dedicated "newer akm" message. **Gap: no distinct newer-akm path yet; only one version has ever shipped so this is unexercised.** | Same generic check as above | Upgrade rehearsal gate (A1) |
| Proposal `metadata_json` | `src/storage/repositories/proposals-repository.ts` | No explicit version field; presence/absence of the `changes` key | Rows from before the `changes` key existed (~89% of archived rows on real installs) are treated as a known legacy gap — decoded with an empty change list rather than thrown (`proposals-repository.ts:47-56`) | Not handled explicitly; an unrecognized shape falls through to the generic "Proposal row has invalid metadata_json" throw (`proposals-repository.ts:257`) rather than naming an upgrade. **Gap.** | Upgrade rehearsal gate (A1) |
| `task_history` metadata | `src/storage/repositories/task-history-repository.ts` | `metadataVersion` (currently `2`) | An absent `metadataVersion` is treated as a legacy row (58% of rows written by prior releases) and decoded best-effort; unknown fields are dropped harmlessly rather than round-tripped (`task-history-repository.ts:61-69`) | A `metadataVersion` newer than this binary's `2` is decoded best-effort as version 2 with a warning, rather than rejected (`task-history-repository.ts:85-89`) | Upgrade rehearsal gate (A1) |
| Lock payloads | `src/core/file-lock.ts` | No version field; payload is `String(pid)` or a PID-plus-token string | Any payload shape parses permissively — a payload the holder-pid extraction cannot parse is simply treated as having no launcher pid (`file-lock.ts:351-357`) rather than rejected | Same permissive parse; a payload from a newer akm that adds fields is read the same way | Upgrade rehearsal gate (A1) |
| Guarded directory manifests | `src/execution/guarded-source.ts` | Per-entry `version` (an mtime/ctime-derived stat fingerprint, `statVersion`) | Not applicable in the cross-release sense: a manifest is captured fresh within a single process (e.g. one `akm task sync` call) and compared only against another capture in that same run (`src/tasks/scheduler-sync.ts:966-968`); it is never read back from disk as a previous release's artifact | N/A, same reason | Upgrade rehearsal gate (A1) |
| `.akm` residue | Documented in `docs/architecture/internals/storage-locations.md` | No version marker | Stale `.akm` directories or files from a previous layout are inert; nothing in current code reads or interprets them | N/A | Upgrade rehearsal gate (A1) |

## Adding a format or bumping one

1. Give the format an explicit version marker (a field, a table, a filename
   convention) if it does not already have one — "no marker" is not a
   compatibility strategy.
2. Write the reader so it converts an older marker in memory and warns once,
   per the contract above. Reserve throwing for data from a version this
   binary has never heard of, and name `akm migrate apply` (or the specific
   rebuild command, e.g. `akm index`) in the error.
3. Add the old shape as a fixture to
   `tests/integration/upgrade-rehearsal/` (item A1) so a real previous-release
   binary's output is exercised, not just a hand-written fixture.
4. If the format is `config.json`, also register any removed or newly
   strict key in `src/core/config/retired-keys.ts` so
   `scripts/lint-config-schema-compat.ts` (item A2) does not fail CI.
5. Add or extend the row in the table above, including a `Gap:` note if the
   code does not yet meet the contract — do not leave a mismatch undocumented.
