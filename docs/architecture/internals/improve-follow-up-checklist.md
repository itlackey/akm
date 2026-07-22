# Improve And Migration Follow-Up Checklist

Status captured on 2026-07-22 after the 0.9.0 improve and migration close-out.
Issues #720 and #721 are complete and closed. The current release-candidate
worktree passes `bun run check` with 2,824 unit tests and 4,767 integration
tests. `./tests/release-check.sh --skip-docker` also passes, including 7,591
tests in the final unsharded suite and the published 0.8.14 upgrade gate. The
close-out was committed and pushed as `e7a6f4a3`; it has not been retained as a
durable package candidate or deployed.

## Release Candidate

- [x] Review and commit the current worktree as one coherent changeset (`e7a6f4a3`).
- [x] Run the required pre-commit formatter: `bunx biome check --write src/ tests/`.
- [x] Build the package with `bun run build` and verify that `dist/tests` is absent.
- [ ] Pack the exact candidate that will be deployed.
- [x] Run the published 0.8.14 upgrade gate against the temporary release-check tarball:
  `AKM_PUBLISHED_UPGRADE_TESTS=1 AKM_PUBLISHED_UPGRADE_TARBALL=<tarball> AKM_CANDIDATE_VERSION=<version> bun test tests/integration/published-task-upgrade.test.ts`.
- [x] Run `./tests/release-check.sh --skip-docker`.
- [ ] Run the Docker matrix if the release requires it.
- [ ] Record the candidate commit, tarball checksum, and release-check result before deployment.

## Live Migration

- [ ] Confirm the live binary is the intended candidate rather than the older
  `0.9.0-rc.5` implementation that shares the same version string.
- [ ] Re-verify the pre-migration snapshot at
  `/home/founder3/.local/share/akm/backups/operations/20260722T082312Z-step1-live-snapshot`.
- [ ] Re-verify the exported pending proposals at
  `/home/founder3/.local/share/akm/backups/exports/recombine/20260722T082312Z/pending-recombine-proposals.db`.
- [ ] Run staged migration preflight/status before replacing the live executable.
- [ ] Run `akm migrate apply` under the maintenance barrier and retain its
  operation ID, backup path, and final status output.
- [ ] Run `akm index --full` so the live index has canonical `item_ref` and
  `bundle_id` columns.
- [ ] Verify `akm health`, `akm info`, representative `search`/`show`/`curate`
  calls, task history, and the seven exported pending proposals.
- [ ] Run `scripts/akm-eval/bin/akm-eval-recombine-analyze --format json` only
  after the canonical index rebuild succeeds.
- [ ] Run `scripts/akm-eval/bin/akm-eval-attribution-rollup --format json` and
  archive the first post-migration baseline.

## Host Operations

- [ ] Keep `default` and `reflect-distill` proactive maintenance disabled until
  the deployed candidate and its attribution reports are verified.
- [ ] Keep `akm-improve-proactive-weekly`, `akm-extract`, and
  `akm-extract-prenightly` disabled until an explicit re-enable decision.
- [ ] Reassess the still-enabled recombine schedule after reviewing the
  read-only analyzer output; do not restore full production recombine by default.
- [ ] Verify scheduler definitions and host state after deployment without
  re-enabling unrelated tasks.

## Open Product Work

- [ ] #711: support scheduling tasks from configured bundles with an explicit
  execution-trust gate and bundle-qualified task identity.
- [ ] #692: remove or default-disable the R2 salience ranking contribution unless
  outcome-gated benchmark evidence supports it.
- [ ] #672: extract salience/outcome repositories, make preparation accumulators
  explicit, and widen the repository SQL boundary guard.

These issues intentionally remain open and unchanged by the close-out.

## Residual Hardening

- [ ] Add a committed Bun/better-sqlite3 parity test for canonical migration
  generation hashes; the current parity check was an ad hoc closure reproduction.
- [ ] Decide whether SQLite rollback-journal files need the same private snapshot
  treatment as main/WAL generations under concurrent DELETE-mode cache spill.
- [ ] Decide whether config text should be captured with SQLite snapshots to
  prevent a mixed status view during direct concurrent config replacement.
- [ ] Document the fail-closed limitation for extension tables that shadow all
  three implicit rowid aliases (`rowid`, `_rowid_`, and `oid`).
- [ ] Monitor temporary disk and I/O cost when status authenticates very large
  state/index main+WAL generations.
- [ ] Consider stronger index-quarantine durability for power loss and the narrow
  recreation race between presence checks and rename operations.
