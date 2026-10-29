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

## Test Targets

`bun run check` runs lint and the typecheck, then both targets in sequence.

- `bun run test:unit` (`scripts/test-unit.sh`) runs every `*.test.ts` under
  `tests/` except `tests/integration/`. That includes the top-level
  `tests/commands/` and `tests/workflows/` directories; do not confuse them with
  the separate `tests/integration/commands/` and `tests/integration/workflows/`
  directories.
- `bun run test:integration` (`scripts/test-integration.sh`) runs
  `tests/integration/**` only.

**Where a test goes.** A file belongs under `tests/integration/` if it opens a
real database (`openIndexDatabase`, `openExistingDatabase`), touches the network
(a loopback server included), or spawns a real process (`spawn`, `spawnSync`,
`Bun.spawn`); `tests/integration/commands/sources/index-db-contention.test.ts`
writes the reasoning out against a concrete file. Everything else, such as pure
in-memory logic and mocked I/O, belongs under `tests/`, however deeply nested.
The real OpenCode binary (its own SQLite database and a shell tool) and the
loopback fake model are integration resources, and
`tests/contracts/test-targets.test.ts` fails on a unit-target test that uses
either. A file that seems to qualify for `tests/integration/` on any other
ground says which clause it satisfies in a one-line header comment instead of
being placed by feel. No `.test.ts` belongs under a `fixtures` or `_fixtures`
path: those are data, not executable specs.

**Green by default** ([principle 6](../akm-core-principles.md#6-the-suite-is-green-by-default-and-sandboxed-through-the-environment)).
A test that must be disabled is `.skip`ped in the same change that links its
issue; never leave a failure standing and never add an "expected failures"
allowlist.

## Test Layers In This Repo

### 1. Fast local correctness

Run these before any release candidate or merge:

```sh
bun run test:unit
bun run lint:fix
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
   - `writeSandboxConfig(partial)` — merges `partial` into the sandboxed
     `config.json` (call `sandboxXdgConfigHome` first).
   - `withMockedFetch(run, mock)` — swaps `globalThis.fetch` for the duration of
     `run` and restores it in a `finally`.

   Do not assign `process.env.HOME =`, call `process.chdir(...)`, or assign
   `globalThis.fetch =` directly. Use `withMockedFetch` for fetch swaps, and
   restore the cwd in a `finally` block when a `chdir` is unavoidable.

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

4. **Pass `--timeout` when a test spawns `bun test <fixture>`.** Bun ignores
   `bunfig.toml`'s `timeout` (see the comment there), so the fixture dies at 5 s
   under load.

5. **Keep an index from downloading a model.** An index with
   `semanticSearchMode: "auto"` and no fake embedder downloads a Hugging Face
   model mid-test; use the deterministic embedder (`AKM_EMBED_DETERMINISTIC`) or
   `"off"`.

### The preload

`bunfig.toml` preloads `tests/_preload.ts` for every `bun test` invocation. It
owns the process state that crosses test boundaries:

- At preload time `HOME` and all four `XDG_*_HOME` variables point at a
  per-process sandbox directory, the `AKM_*_DIR` overrides are cleared, and so
  are `AKM_VERBOSE`, `AKM_LLM_API_KEY` and `AKM_EMBED_API_KEY`. A test file never
  reads the developer's real `~/.config/akm/` or `~/.cache/akm/`.
- Bun's `os.homedir()` ignores a runtime `HOME` change, so the preload cannot
  redirect a default built from it. Both runner scripts start every shard with its
  own throwaway `HOME`, which `os.homedir()` does see; under a bare
  `bun test <file>` it returns the real home. Code that resolves a home directory
  therefore uses the XDG variables or an override of its own, and a test can never
  rely on `HOME` alone. The preload points `CODEX_HOME` and `CLAUDE_CONFIG_DIR` at
  the sandbox for the Codex and Claude Code session readers, and
  `OPENCODE_TEST_HOME` for OpenCode.
- Before each test it snapshots the harnessed environment (`HARNESSED` in the
  preload: `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `OPENCODE_TEST_HOME`, the
  four `XDG_*_HOME` variables, `AKM_BUNDLE_DIR`, `AKM_CONFIG_DIR`,
  `AKM_CACHE_DIR`, `AKM_DATA_DIR`, `AKM_STATE_DIR`, `AKM_VERBOSE`,
  `AKM_LLM_API_KEY`, `AKM_EMBED_API_KEY`, `AKM_REGISTRY_URL`,
  `AKM_NPM_REGISTRY`), `process.cwd()` and `globalThis.fetch`, and restores them
  afterwards.
- It resets the module-level singletons of production code between tests:
  `cachedConfig`, `embedCache`, `localEmbedder`, the quiet and verbose flags and
  the warn module's log file path. `mock.restore()` runs after every test.
- A tripwire throws when a test leaks an `AKM_*`, `XDG_*` or `HOME` variable that
  was not there at preload time, leaves `process.cwd()` changed, or leaves
  `globalThis.fetch` replaced.
- A global `afterAll` ends the run by removing the suite sandbox directory.
  `bun test` does not emit `process.on("exit")` when a run ends normally, so the
  preload's `exit` listener does not fire there and every run would leave its
  `akm-test-suite-*` directory behind. The `exit` and signal handlers still cover
  an explicit `process.exit()` and signal-kills. Do not rely on
  `process.on("exit")` for test-process cleanup.
- The preload refuses akm's real OpenCode runtime (`agentRuntime.run`): a test
  that dispatches agent work on a connection installs
  `installFakeOpencodeRuntime` (`tests/_helpers/fake-opencode-runtime.ts`), which
  records what the run was asked and answers it, or calls
  `useRealOpencodeRuntime()` to run the real binary.

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

The real-model gate runs with
`AKM_SEMANTIC_TESTS=1 bun test tests/integration/semantic-search-e2e.test.ts`; its
first run downloads Hugging Face models. It honors an explicit `HF_HOME` and
otherwise uses the ignored, repo-local `.ci-cache/huggingface` directory. That
path is outside the preload's disposable test `HOME`, so a second local run
reuses the model without exposing the developer's normal AKM cache. Gated CI
sets the same path and restores it from a model/source-identified Actions
cache. Candidate tags and manual runs are restore-only; only the scheduled
default-branch run may save a cache entry.

The same gate runs real semantic index/search round-trips on `onnxruntime-node`'s
binding, asserts the `embeddingRuntime` the index reports, and compares the
embedder's vectors with the Transformers.js reference in
`tests/fixtures/embedder-reference-vectors.json`. The binding and its library are
shared across runs the same way as the model: `tests/_helpers/onnx-runtime-cache.ts`
copies the repo-local `.ci-cache/akm/onnxruntime/` into each sandbox's akm cache
and keeps a folder a run fetched there, and gated CI caches that directory under
a key from `src/llm/embedders/onnx-runtime.ts`, which pins the ONNX Runtime
version. Package acceptance separately verifies
the ordinary npm package surface.

`tests/integration/standalone-semantic.test.ts` (the same `AKM_SEMANTIC_TESTS=1`
gate) builds the host's standalone binary and asserts it embeds no `.node` file.
Where akm offers local embeddings it runs `akm setup --yes --embedding local`,
expects the binding and the library in the cache folder, and indexes a small
stash, asserting a ready status, a vector per entry and the native runtime.
Everywhere else it asserts the default: setup warns and saves keyword search, an
index with semantic search on reports it unavailable for the platform, `akm
health` warns, and search is keyword. Gated CI runs it in the Semantic Search job
(Linux) and in the Native Scheduler job on macOS (local embeddings) and Windows
(the default), the only places the binary runs on those platforms.

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

This validates three deployment methods across four Linux families:

- bun-based install: Ubuntu, Debian, Alpine, Fedora
- compiled binary install: Ubuntu, Debian, Fedora
- npm install: Debian on `node:24-slim`, which has no compiler, python or make
  (`npm install -g --ignore-scripts` of the packed package, as npm 12 installs by
  default; the install's exit code and the smoke test are the check)

Binary validation currently excludes Alpine: there is no
`Dockerfile.alpine-binary`, because the compiled Linux binary targets glibc and
Alpine is musl-based.

The Docker smoke test in `tests/docker/smoke-test.sh` verifies:

- `akm --help`
- `akm bundle create`
- `akm index`
- `akm search` (including `--format json` and `--type skill`)
- `akm show`
- `akm info`
- `akm bundle list`
- incremental re-index after adding a new asset

The Dockerfiles are `tests/docker/Dockerfile.{ubuntu,debian,alpine,fedora}-bun`,
`tests/docker/Dockerfile.{ubuntu,debian,fedora}-binary` and
`tests/docker/Dockerfile.debian-npm`. Run one variant for a focused repro:

```sh
./tests/docker/run-docker-tests.sh ubuntu-binary
./tests/docker/run-docker-tests.sh --bun-only
./tests/docker/run-docker-tests.sh --binary-only
```

The matrix shows that the CLI starts in minimal Linux images, that runtime
dependencies are enough for `bundle create`, `index`, `search`, and `show`, that
bun-linked installs work after building from source, that compiled Linux
binaries run when copied into the image, and that an npm install of the packed
package works on an image with no compiler. It also exercises the real
entrypoint scripts, which can catch shell-level failures that unit and
subprocess tests miss. It does not show that the published release artifact
matches the local compiled binary, that `install.sh` works against a real GitHub
release, or that self-upgrade can replace the running binary in place; check
those by hand in a disposable container after publishing.

### 4. OpenCode 2 CLI compatibility

The unit tests build the `opencode run` command line and the stub-program tests
check that it reaches a program; only a real OpenCode 2 says what its flags, its
permission map, its environment and a signal do to it. The compatibility suite
runs the real CLI when a binary is named, and is one skipped test otherwise (the
CI workflow does not set the gate):

```sh
AKM_TEST_OPENCODE2_BIN=/path/to/opencode bun test --timeout=120000 tests/integration/opencode-cli-compat.test.ts
```

Every run of the binary is sandboxed: its `HOME`, XDG and OpenCode directories
are temporary directories, every other `OPENCODE_*` variable the developer has
exported is blanked, its only provider is a loopback fake model reached through
the `@ai-sdk/openai-compatible` package bundled in the binary (nothing is
downloaded), and no real OpenCode file, login or key is opened. The suite covers
what akm relies on at that boundary. Model work, which runs standalone, offers
only its reading tools, and an abort or a timeout, during a model request or a
tool call, releases OpenCode's claim on the session and leaves no process
behind. Agent work is the plain invocation, which OpenCode 2 runs through a
background service on one port for every `HOME`: those cases end the service
they start, skip when something else holds the port, and record that a stop ends
the `opencode` command and the service's turn (2.1.4 and 2.2.0) and leaves the service up.
A provider defined only in the
user's `OPENCODE_CONFIG_CONTENT` works for agent work and model work alike. Run
it when changing the OpenCode builder or the subprocess kill ladder, and against
a new OpenCode 2 release.

The suites that run akm's own runtime on the real binary
(`opencode-runtime-sessions`, `opencode-runtime-signal-teardown`,
`opencode-session-store` and `standalone-first-run`, all under
`tests/integration/`) need no gate: they fetch the pinned OpenCode once, through
akm's own fetch path, into a cache every run shares (`$AKM_TEST_OPENCODE_CACHE`,
else `node_modules/.cache/akm-test-opencode`), and link it into each test's
sandboxed akm cache (`tests/_helpers/opencode-binary.ts`). When the registry
cannot be reached they skip, with a message that says why. Run them against a new
`OPENCODE_RUNTIME_VERSION` before moving it.

### 5. Benchmark (agent utility)

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
bun run lint:fix
bunx tsc --noEmit
```

### Install, packaging, or release-related change

Use this when touching `src/cli.ts`, `src/commands/sources/self-update.ts`, install flows,
source management, or Docker assets:

```sh
bun run test:unit
bun test tests/integration/self-update.test.ts tests/integration/install/install-script.test.ts
./tests/docker/run-docker-tests.sh
bun run lint:fix
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

That script checks the packaged artifact: bin targets, the migrator and package
acceptance. Lint, the typecheck and the test suites are `bun run check`; the
upgrade rehearsal runs in CI.

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
release below the candidate's `package.json` version; `0.9.32`, which keeps the
full engines migration covered after `previous` advances to 0.10; and `0.9.15`,
which covers scheduler rows installed before host-local activation was recorded.
Each origin installs that release as a real global npm
package (a real `npm pack` / `npm install --global` into a throwaway prefix, see
`scripts/package-install.ts`). The `previous` and `0.9.32` origins build a full
home — filesystem,
git (with an in-bundle symlink at its root), website, and npm bundles, scheduled
tasks, a synced native (fake) crontab, and model configuration the release
itself writes: native connections/harnesses on 0.10+, or the full 0.9 `engines`
form (an llm engine with an `apiKeyFile`, agent engines, a `models.json`, and a
command and task that name an engine). The `0.9.15` origin uses a smaller home
with one directly installed scheduled task. Each then installs
the CANDIDATE build OVER it in the SAME prefix: an in-place swap, the same thing
a real `npm i -g akm-cli@…` or `bun add -g` upgrade does. It then runs the
candidate against that home (`migrate status` / `apply`, which converts the
`engines` form, files its key and rewrites the `engine:` keys, or preserves
native connections/harnesses, `bundle list`,
`search` / `show`, `task sync` dry-run and real — plain, no `--rebind`, as an
upgrading user runs it — executing the generated cron command and confirming it
ran the candidate, `task run`, `health`, `improve --dry-run`), and finally runs a
separate untouched copy of the origin release back against the candidate-written
home to check that read-back still works. Plain `task sync` is clean because the
candidate lands inside the same prefix the previous release's scheduler rows
already point at; a side-by-side install (a separate prefix) would need
`--rebind`. `tests/integration/previous-release-corpus.test.ts` covers
persisted-data shapes read in isolation; this gate covers the whole CLI surface
across two real installed releases.

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
  instead of running `npm pack` on the working tree (which requires
  `dist/cli.js` — run `bun run build` first).

Fetched previous-release tarballs are cached under
`${TMPDIR:-/tmp}/akm-upgrade-rehearsal/previous-release/<version>/` so repeat
runs do not re-hit the network. It is wired into CI as the `upgrade-rehearsal`
job (`.github/workflows/ci.yml`), which runs on pushes to `main` and release
branches, on manual runs and on every commit of a pull request that is ready
for review (a draft pull request skips it until it is marked ready). The Release
workflow requires that CI run to pass on the commit it publishes.

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
