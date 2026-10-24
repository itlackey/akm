# Testing Workflow

This project is a CLI with three risk-heavy areas:

- command behavior across real files, config, and cache directories
- managed-source install/update flows
- binary deployment and self-upgrade behavior

The safest way to test it is in layers: fast local checks first, then end-to-end
CLI coverage, then Docker-based deployment and upgrade validation. This document
covers the automated test workflow and test-authoring guidance.

## What To Validate

- core CLI flows: `setup`, `index`, `search`, `show`, `info`, `bundle list`, `config`
- asset lifecycle: add assets, re-index, search, show, and incremental refresh
- managed-source lifecycle: `akm bundle add`, `akm bundle list`, `akm bundle update`, `akm bundle remove`
- binary lifecycle: install, run, `akm upgrade --check`, `akm upgrade`
- cross-environment behavior on Ubuntu, Debian, Alpine, and Fedora containers

## Test Layers In This Repo

### 1. Fast local correctness

Run these before any release candidate or merge:

```sh
bun run test:unit
bunx biome check --write src/ tests/
bunx tsc --noEmit
```

Use this when you want the shortest full-project signal:

```sh
bun run check
```

Relevant coverage:

- `tests/integration/self-update.test.ts` - self-upgrade detection and checksum handling
- `tests/integration/registry/*.test.ts`, `tests/provider-registry.test.ts` - registry search, index formats, and install resolution
- `tests/setup-wizard.test.ts`, `tests/setup-scheduled-tasks.test.ts` - setup wizard orchestration and failure handling
- `tests/integration/install/install-script.test.ts` - repeatable `install.sh` edge cases and permission paths

### Writing deterministic, isolated tests

`bunfig.toml` preloads `tests/_preload.ts` for every `bun test` run. The preload
points `HOME` and the `XDG_*` variables at a per-process sandbox, snapshots and
restores the harnessed `AKM_*` variables, `process.cwd()`, and `globalThis.fetch`
around every test, resets module-level singletons, and throws when a test leaks
one of them.

Both `scripts/test-unit.sh` (`bun run test:unit`) and `scripts/test-integration.sh`
(`bun run test:integration`) shard their target across up to `min(nproc, 8)`
concurrent `bun test` processes, splitting the file list round-robin — neither
runner is a single shared process. Within one shard, every file assigned to that
process still runs in **one shared process**: one `process.env`, one
module-singleton namespace, and (under fake timers) one global clock for every
file in that shard. A test that mutates shared state without restoring it, or
that asserts on a wall-clock measurement, can pass on one scheduling and fail on
another.

Rules (conventions, not statically enforced; `src/core/paths.ts` throws
`TEST_ISOLATION_MISSING` at runtime when isolation is missing, and the preload
tripwire catches leaks):

1. **Do not mutate `AKM_*` / `XDG_*` / `HOME` on `process.env` directly.** Use the
   helpers in `tests/_helpers/sandbox.ts`:
   - `sandboxStashDir`, `sandboxXdgConfigHome`, `sandboxXdgDataHome`,
     `sandboxXdgCacheHome`, `sandboxXdgStateHome`, `sandboxHome` — set the env var
     to an isolated temp dir and return a `cleanup` that restores the prior value.
     Chain them and call `cleanup()` in `afterEach`.
   - `withEnv({ AKM_BUNDLE_DIR }, async () => …)` — scoped override that always
     restores in a `finally`, even on throw. Use this for per-call overrides
     around an in-process CLI invocation.
   - `makeStashDir` / `makeSandboxDir` — temp dirs that are not wired into env
     (pass them to `withEnv` or a subprocess env object yourself).
   - `withMockedFetch` for `fetch` swaps; restore `process.cwd()` in a `finally`
     block when a `chdir` is unavoidable.

   The DB path resolves from `XDG_DATA_HOME`; if you `akmIndex` then `akmSearch`,
   both must see the **same** sandboxed `XDG_DATA_HOME` or the search reads a
   different (empty or stale) DB. Sandbox it in `beforeEach`.

2. **Do not assert on a measured wall-clock delta.** `expect(Date.now() - start)
   .toBeLessThan(N)` races the scheduler. Assert the *observable result* instead
   (e.g. `result.reason === "timeout"`), or drive time deterministically with
   fake timers and a fetch/spawn stub. Asserting on a `durationMs` field
   computed from injected fixture timestamps is fine (it is deterministic).

3. **Assert on the value the user sees.** Search orders fused candidates by
   score and then by `itemRef` (`src/indexer/search/ranking.ts`), and a hit's
   `score` is rounded for display; when a test asserts ordering, compare the
   same value the output carries.

### Where a test lives

A file belongs under `tests/integration/` when it opens a real database
(`openIndexDatabase` / `openExistingDatabase`), touches the network, or spawns a
real process. Everything else — pure in-memory logic, mocked I/O — belongs under
`tests/`, regardless of nesting. A file whose placement rests on a different
rationale says which clause it satisfies in a one-line header comment.

### 2. End-to-end CLI validation

Run the full integration suite when changing CLI behavior, indexing, search,
config, source management, or output shaping:

```sh
bun run test:integration
```

Collectively, these suites (`tests/integration/`) exercise real flows,
including:

- `index -> search -> show`
- CLI subprocess execution through `src/cli.ts`
- config read/write behavior
- registry sources and static-index compatibility
- progressive indexing and re-indexing
- update and upgrade command error paths
- markdown `#fragment` selection and mixed asset discovery

## Semantic Search States

Semantic search does not behave as a simple on/off feature at runtime. Testing
should distinguish between saved-config state and actual readiness.

### Config intent

Semantic search intent is saved independently as `semanticSearchMode`:

- `off` when the user opts out explicitly
- `auto` when the user wants semantic search enabled

Setup should not flip intent from `auto` back to `off` because preparation or
verification fails transiently.

### Runtime readiness

Actual semantic readiness is tracked separately from config intent. Runtime state
can be:

- `pending` when semantic search is enabled but not yet verified
- `ready-js` when every entry has a vector (the name is historical; there is no other vector path)
- `blocked` when semantic search cannot run with the current provider/setup

These cases are covered by the setup and semantic-status suites
(`tests/setup-wizard.test.ts`, `tests/integration/vector-search.test.ts`,
`tests/integration/update-no-op-semantic-status.test.ts`).

The real-model gate (`AKM_SEMANTIC_TESTS=1 bun test tests/integration/semantic-search-e2e.test.ts`)
honors an explicit `HF_HOME` and otherwise uses the ignored, repo-local
`.ci-cache/huggingface` directory. That path is outside the preload's disposable
test `HOME`, so a second local run reuses the model without touching the
developer's normal AKM cache. Gated CI sets the same path and restores it from
an Actions cache; only the scheduled default-branch run saves a cache entry. The
first run downloads Hugging Face models.

### What to test explicitly

- config stays `off` only when the user disables semantic search intentionally
- config stays `auto` when preparation is skipped intentionally
- config stays `auto` when preparation fails but runtime status becomes `blocked`
- runtime status becomes `pending`, `ready-js`, or `blocked` as appropriate
- index and info output report readiness state instead of only config intent

### 3. Docker deployment validation

Run the Docker matrix when changing install, packaging, startup, runtime
dependencies, or platform behavior:

```sh
AKM_DOCKER_TESTS=1 bun test tests/integration/docker-install.test.ts
```

Or run the shell orchestrator directly:

```sh
./tests/docker/run-docker-tests.sh
```

This validates two deployment methods across four Linux families:

- bun-based install: Ubuntu, Debian, Alpine, Fedora
- compiled binary install: Ubuntu, Debian, Fedora

Binary validation currently excludes Alpine: there is no
`Dockerfile.alpine-binary`, because the compiled Linux binary targets glibc and
Alpine is musl-based.

The Docker smoke test in `tests/docker/smoke-test.sh` verifies:

- `akm --help`
- `akm models copy-defaults`
- `akm bundle create`
- `akm index`
- `akm search` (including `--format json` and `--type skill`)
- `akm show`
- `akm info`
- `akm bundle list`
- incremental re-index after adding a new asset

The Dockerfiles are `tests/docker/Dockerfile.{ubuntu,debian,alpine,fedora}-bun`
and `tests/docker/Dockerfile.{ubuntu,debian,fedora}-binary`. Run one variant for
a focused repro:

```sh
./tests/docker/run-docker-tests.sh ubuntu-binary
./tests/docker/run-docker-tests.sh --bun-only
./tests/docker/run-docker-tests.sh --binary-only
```

The matrix shows that the CLI starts in minimal Linux images, that runtime
dependencies are enough for `bundle create`, `index`, `search`, and `show`, that
bun-linked installs work after building from source, and that compiled Linux
binaries run when copied into the image. It also exercises the real entrypoint
scripts, which can catch shell-level failures that unit and subprocess tests
miss. It does not show that the published release artifact matches the local
compiled binary, that `install.sh` works against a real GitHub release, or that
self-upgrade can replace the running binary in place; check those by hand in a
disposable container after publishing.

### 4. Benchmark (agent utility)

The LLM-provider-driven, multi-seed agent-utility benchmark (`akm-bench`) lives
in the standalone repo **[itlackey/akm-bench](https://github.com/itlackey/akm-bench)**.
Run it from there after any change to `src/output/`, `src/commands/read/show.ts`,
APPLY directives, or other content that affects what agents see.

For curate/search ranking quality, run the retrieval eval of
**[itlackey/akm-eval](https://github.com/itlackey/akm-eval)**
(`evals/retrieval/run --corpus public`, with `AKM_BIN` naming the build under
test). It scores `akm search` and `akm curate` against graded judgments and
calls no model service. See `docs/maintainers/eval.md`.

## Recommended Workflow

### Normal change

Use this for most code changes:

```sh
bun run test:unit
bun run test:integration
bunx biome check --write src/ tests/
bunx tsc --noEmit
```

### Install, packaging, or release-related change

Use this when touching `src/cli.ts`, `src/commands/sources/self-update.ts`, install flows,
source management, or Docker assets:

```sh
bun run test:unit
bun test tests/integration/self-update.test.ts tests/integration/install/install-script.test.ts
./tests/docker/run-docker-tests.sh
bunx biome check --write src/ tests/
bunx tsc --noEmit
```

### Release gate

Use this before publishing a release:

```sh
bun run release:check
```

If Docker is available, prefer `./tests/docker/run-docker-tests.sh` over a
single-variant container run so both bun and binary installs are covered.

For a local release gate without Docker, use:

```sh
./tests/release-check.sh --skip-docker
```

That script checks the packaged artifact: bin targets, the migrator, package
acceptance, and the upgrade rehearsal against the packed tarball. Lint, the
typecheck and the test suites are `bun run check`.

The Release workflow runs Gated CI (real embeddings, Docker, and the
Linux/macOS/Windows schedulers) on the commit it publishes and requires CI to
have passed on that commit; see the
[maintainer release checklist](../../maintainers/release-checklist.md). The
weekly scheduled run of Gated CI detects default-branch drift.

## Upgrade Regression Coverage

Managed-source updates and CLI self-upgrade are separate implementations.
Provider and registry suites cover source add/update/remove/cache behavior;
`tests/integration/self-update.test.ts` covers install-method detection,
orchestration, checksum, and failure paths.

### Upgrade rehearsal gate

`tests/integration/upgrade-rehearsal/` runs once per origin in
`KNOWN_UPGRADE_ORIGINS` (`previous-release.ts`): `previous`, the highest stable
release below the candidate's `package.json` version, and `0.9.15`, a fixed
older release. For each origin it installs that release as a real global npm
package (a real `npm pack` / `npm install --global` into a throwaway prefix, see
`scripts/package-install.ts`), uses it to build a realistic home — filesystem,
git (with an in-bundle symlink at its root), website, and npm bundles, scheduled
tasks, and a synced native (fake) crontab — then installs the CANDIDATE build
OVER it in the SAME prefix: an in-place swap, the same thing a real
`npm i -g akm-cli@…` or `bun add -g` upgrade does. It then runs the candidate
against that home (`migrate status` / `apply`, `bundle list`, `search` / `show`,
`task sync` dry-run and real — plain, no `--rebind`, as an upgrading user runs
it — executing the generated cron command and confirming it ran the candidate,
`task run`, `health`, `improve --plan`), and finally runs a separate untouched
copy of the origin release back against the candidate-written home to check that
read-back still works. Plain `task sync` is clean because the candidate lands
inside the same prefix the previous release's scheduler rows already point at;
a side-by-side install (a separate prefix) would need `--rebind`.
`tests/integration/previous-release-corpus.test.ts` covers persisted-data shapes
read in isolation; this gate covers the whole CLI surface across two real
installed releases.

Run it locally with:

```sh
bun run build
AKM_UPGRADE_REHEARSAL=1 TMPDIR=/tmp bun test --timeout=900000 tests/integration/upgrade-rehearsal/
```

Unset (the default), the suite logs one line and skips. When it is requested,
every missing capability (no `npm` on `PATH`, no network reachable to resolve or
fetch the previous release, no candidate build) throws naming the fix. Env
overrides:

- `AKM_UPGRADE_FROM=<version>` — pin the `previous` origin instead of resolving
  the highest published stable version below the candidate's `package.json`
  version.
- `AKM_UPGRADE_REHEARSAL_ORIGIN=<origin>` — run only one origin (CI runs each
  origin as its own job).
- `AKM_CANDIDATE_TARBALL=<path>` — use an already-packed candidate tarball
  (`tests/release-check.sh` passes `$PACKAGE_CANDIDATE`) instead of running
  `npm pack` on the working tree (which requires `dist/cli.js` — run
  `bun run build` first).

Fetched previous-release tarballs are cached under
`${TMPDIR:-/tmp}/akm-upgrade-rehearsal/previous-release/<version>/` so repeat
runs do not re-hit the network. It is wired into CI as the `upgrade-rehearsal`
job (`.github/workflows/ci.yml`) and into `tests/release-check.sh` right
after packing the release candidate.

## Coverage Notes

Coverage is broad across the CLI, indexing, registry, workflow, and
semantic-search paths. Use these directories as the starting point when
extending it:

- `tests/integration/db/`, `tests/integration/fts/`, `tests/integration/indexer/`,
  `tests/integration/storage/` — database, full-text search, and index behavior
- `tests/search-rrf.test.ts`, `tests/integration/search-fusion.test.ts` — search ranking
- `tests/integration/registry/` — registry install, search, and update flows
- `tests/integration/workflows/`, `tests/integration/tasks/` — workflow and task behavior
- `tests/integration/vector-search.test.ts`, `tests/integration/semantic-search-e2e.test.ts` — vectors and embeddings
- `tests/integration/info-command.test.ts`, `tests/integration/output-baseline.test.ts` — CLI output shaping
- `tests/integration/docker-install.test.ts` — Docker install validation

### When Adding Tests

- prefer focused `bun:test` files under `tests/`
- use isolated temp config/cache/stash dirs
- cover the user-visible CLI behavior when the risk is output shaping or command routing
- cover internal units directly when the risk is scoring, metadata extraction, or persistence
