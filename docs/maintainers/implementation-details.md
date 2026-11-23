# Implementation details referenced by the stability policy

The [stability policy](../../STABILITY.md) classifies public interfaces. These
repository scripts and runtime signals are implementation details, not additional
CLI commands or compatibility promises.

## Repository tooling

- Check the public command inventory against `main.subCommands` in `src/cli.ts` and each group's `subCommands`.
- `scripts/build-registry-index.ts` builds registry indexes; it is maintainer tooling outside the public CLI.
- `scripts/rekey-asset-ref.ts` re-keys earned signal from an old ref to a new one by hand. A plain rename needs it no longer: `akm index` pairs a vanished entry with the new file of the same content and re-keys its history (`src/indexer/ref-moves.ts`); the script is for a move that also changed the content.
- In 0.10, `akm-migrate` ships inside the `akm-cli` package alongside `akm`, with no separate package. `task-to-v4.ts` and `task-source-v3-frozen.ts` live under `scripts/akm-migrate/migrate/`, outside `src/`. The standalone executable is deprecated for 0.11; callers should use `akm migrate status` / `apply`.
- `BundleAdapter.placeNew()` was removed in 0.10 because nothing called it. Writes use AKM's fixed type-to-directory table. Supporting writes into a non-AKM adapter layout would need placement support again ([#1163](https://github.com/itlackey/akm/issues/1163)).

## Runtime and test environment

`AKM_EVENT_SOURCE` is a documented input (see [STABILITY.md](../../STABILITY.md#environment-overrides)).
The earlier policy listed `AKM_NODE_ENTRY`, `AKM_EVENT_SOURCE`, `AKM_SESSION_ID`,
`AKM_AGENT_HARNESS`, `AKM_EMBED_DETERMINISTIC`, `AKM_CLAUDE_PROJECTS_DIR`, and
`AKM_FORCE_INIT_TMP_STASH` as implementation variables without compatibility
guarantees. Do not turn them into user-facing configuration promises by relying
on their names alone; inspect their current readers before changing launchers,
attribution, or test fixtures. Their presence here does not assert that every
variable is still read by every release.

`AKM_STATE_DIR` is not one of them: with `AKM_CONFIG_DIR`, `AKM_DATA_DIR` and
`AKM_CACHE_DIR` it is a Stable location override (see
[STABILITY.md](../../STABILITY.md#environment-overrides)).
