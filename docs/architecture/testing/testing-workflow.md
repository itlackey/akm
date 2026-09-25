# Testing Workflow

This project is a CLI with three risk-heavy areas:

- command behavior across real files, config, and cache directories
- managed-source install/update flows
- binary deployment and self-upgrade behavior

The safest way to test it is in layers: fast local checks first, then end-to-end
CLI coverage, then Docker-based deployment and upgrade validation. This document
owns automated test workflow and test-authoring guidance only. The authoritative
manual setup, command matrix, expected behavior, release gates, evidence, and
cleanup live in [AKM Manual Testing Runbook](./manual-testing-checklist.md).

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

- `tests/integration/self-update.test.ts` - self-upgrade detection and checksum enforcement
- `tests/integration/registry-*.test.ts`, `tests/provider-registry.test.ts` - `list`, `remove`, `update`, cache cleanup, install resolution, tar safety, local/git/npm paths
- `tests/integration/setup-run.test.ts` - full setup wizard orchestration and failure handling
- `tests/integration/install-script.test.ts` - repeatable `install.sh` edge cases and permission paths

### Writing deterministic, isolated tests

Both `scripts/test-unit.sh` (`bun run test:unit`) and `scripts/test-integration.sh`
(`bun run test:integration`) shard their target across up to `min(nproc, 8)`
concurrent `bun test` processes, splitting the file list round-robin — neither
runner is a single shared process, and neither is "the unit suite" alone.
Within one shard, every file assigned to that process still runs in **one
shared process**: one `process.env`, one module-singleton namespace, and
(under fake timers) one global clock for every file in that shard. A test that
mutates shared state without restoring it, or that asserts on a wall-clock
measurement, can pass on one scheduling and
fail on another — the two release/0.8.0 flakes (scoring-pipeline Issue #14
reading the wrong index DB after a sibling mutated `XDG_DATA_HOME`; the
llm-client timeout test racing real timers) were both this class.

Rules (conventions, not statically enforced — the lint script that policed
them was deleted in 0.9.8; the runtime guard in `src/core/paths.ts` throws
`TEST_ISOLATION_MISSING` and the preload tripwire catches leaks):

1. **Never mutate `AKM_*` / `XDG_*` / `HOME` on `process.env` directly.** Use the
   sanctioned helpers in `tests/_helpers/sandbox.ts`:
   - `sandboxStashDir`, `sandboxXdgConfigHome`, `sandboxXdgDataHome`,
     `sandboxXdgCacheHome`, `sandboxXdgStateHome`, `sandboxHome` — set the env var
     to an isolated temp dir and return a `cleanup` that restores the prior value.
     Chain them and call `cleanup()` in `afterEach`.
   - `withEnv({ AKM_BUNDLE_DIR }, async () => …)` — scoped override that always
     restores in a `finally`, even on throw. Use this for per-call overrides
     around an in-process CLI invocation.
   - `makeStashDir` / `makeSandboxDir` — temp dirs that are NOT wired into env
     (pass them to `withEnv` or a subprocess env object yourself).

   The DB path resolves from `XDG_DATA_HOME`; if you `akmIndex` then `akmSearch`,
   both must see the **same** sandboxed `XDG_DATA_HOME` or the search reads a
   different (empty/stale) DB. Sandbox it in `beforeEach`.

2. **Do not assert on a measured wall-clock delta.** `expect(Date.now() - start)
   .toBeLessThan(N)` races the scheduler. Assert the *observable result* instead
   (e.g. `result.reason === "timeout"`), or drive time deterministically with
   `jest.useFakeTimers()` + `jest.advanceTimersByTime(...)` and a fetch/spawn stub.
   Asserting on a `durationMs` field computed from injected fixture timestamps is
   fine (it is deterministic).

3. **Sort/compare on the value the user sees.** When a test asserts ordering,
   make the production sort key the same quantized value that is displayed
   (`db-search.ts` sorts on the clamped+rounded score, then breaks ties by name),
   so an invisible sub-display-precision epsilon can never reorder visible ties.

4. **Avoid stateful feedback within one test.** Re-running `akmSearch` without
   `skipLogging: true` writes utility/recency rows that perturb the next search's
   ranking. Pass `skipLogging: true` when you need repeatable ranking across
   calls in a single test.

If a file legitimately needs a literal env value (e.g. pure path-resolution unit
tests) and restores via its own save/restore wrapper, add it to the linter's
`ENV_ASSIGN_ALLOWED` set with a one-line justification — the list may only shrink.

### 2. End-to-end CLI validation

Run the full integration suite when changing CLI behavior, indexing, search,
config, source management, or output shaping:

```sh
bun run test:integration
```

Collectively, these suites (`tests/integration/`) exercise real flows,
including:

- fallback search without an index
- `index -> search -> show`
- CLI subprocess execution through `src/cli.ts`
- config read/write behavior
- registry-source compatibility
- progressive indexing and re-indexing
- update and upgrade command error paths
- knowledge `#fragment` selection and mixed asset discovery

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
- `ready-js` when embeddings work and JS vector fallback is available
- `ready-vec` when embeddings work and `sqlite-vec` is available
- `blocked` when semantic search cannot run with the current provider/setup

These cases are covered by `tests/integration/setup-run.test.ts` and the focused
semantic/config suites.

The real-model gate (`AKM_SEMANTIC_TESTS=1`) honors an explicit `HF_HOME` and
otherwise uses the ignored, repo-local `.ci-cache/huggingface` directory. That
path is outside the preload's disposable test `HOME`, so a second local run
reuses the model without exposing the developer's normal AKM cache. Gated CI
sets the same path and restores it from a model/source-identified Actions
cache. Candidate tags and manual runs are restore-only; only the scheduled
default-branch run may save a cache entry.

The same gate runs real semantic index/search round-trips against the declared
external dependency. Package acceptance separately verifies the ordinary npm
package surface; there is no installed-consumer compatibility architecture or
copied semantic runtime to audit.

### What to test explicitly

- config stays `off` only when the user disables semantic search intentionally
- config stays `auto` when preparation is skipped intentionally
- config stays `auto` when preparation fails but runtime status becomes `blocked`
- runtime status becomes `pending`, `ready-js`, `ready-vec`, or `blocked` as appropriate
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

Binary validation currently excludes Alpine. The compiled Linux binary used in
this repo's Docker tests is not packaged for Alpine/musl compatibility, so the
binary deployment gate focuses on the glibc-based targets we currently support.

The Docker smoke test in `tests/docker/smoke-test.sh` verifies:

- `akm --help`
- `akm bundle create`
- bundle directory creation
- `akm index`
- `akm search`
- `akm show`
- `akm info`
- `akm bundle list`
- incremental re-index after adding a new asset

### 4. Benchmark (agent utility)

The LLM-provider-driven, multi-seed agent-utility benchmark (`akm-bench`) now
lives in the standalone repo **[itlackey/akm-bench](https://github.com/itlackey/akm-bench)**.
Run it from there after any change to `src/output/`, `src/commands/read/show.ts`,
APPLY directives, or other content that affects what agents see.

For curate/search ranking quality — which stays in this repo — use the
deterministic, rank-aware curate benchmark instead (no LLM provider needed):

```sh
# Single scorecard for the current source
scripts/akm-eval/bin/akm-eval-curate-bench --akm "bun src/cli.ts"

# Compare two checkouts and fail on a per-case regression
scripts/akm-eval/bin/akm-eval-curate-bench \
  --akm "bun /path/to/baseline/src/cli.ts" --compare "bun src/cli.ts" --fail-on-regression
```

See `docs/maintainers/eval.md`.

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
bun test tests/integration/self-update.test.ts tests/integration/setup-run.test.ts tests/integration/install-script.test.ts
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

That script now runs a dedicated install/setup regression suite before the full
test run so first-run, installer, and wizard failures surface early.

The local script is only one half of release validation. Follow the
[maintainer release checklist](../../maintainers/release-checklist.md) to
run **Gated CI** from a `gated-ci/candidate-*` tag targeting the exact candidate
commit, or manually dispatch it with the full candidate
SHA after the workflow reaches the default branch. Its real-embedding, Docker,
and Linux/macOS/Windows scheduler jobs must all succeed, and the release PR
must link the resulting Actions run. The weekly scheduled run detects
default-branch drift; it cannot attest a different release-candidate commit.

## Manual QA Authority

Use [AKM Manual Testing Runbook](./manual-testing-checklist.md) for every manual
flow. Its full sandbox is mandatory; the smaller historical XDG-only setup is
unsafe because `AKM_CONFIG_DIR` can bypass it. The runbook also owns expected
exits/channels, fixtures, release evidence, platform gates, and cleanup.

## Docker Deployment Validation

### Automated matrix

The repo already contains Dockerfiles for:

- `tests/docker/Dockerfile.ubuntu-bun`
- `tests/docker/Dockerfile.debian-bun`
- `tests/docker/Dockerfile.alpine-bun`
- `tests/docker/Dockerfile.fedora-bun`
- `tests/docker/Dockerfile.ubuntu-binary`
- `tests/docker/Dockerfile.debian-binary`
- `tests/docker/Dockerfile.fedora-binary`

`Dockerfile.alpine-binary` does not exist and is deliberately not part of this
matrix: binary validation excludes Alpine (see above) because the compiled
binary targets glibc and Alpine is musl-based.

Run one variant if you need a focused repro:

```sh
./tests/docker/run-docker-tests.sh ubuntu-binary
./tests/docker/run-docker-tests.sh --bun-only
./tests/docker/run-docker-tests.sh --binary-only
```

### What the Docker matrix proves

- the CLI starts in minimal Linux images
- runtime dependencies are sufficient for `bundle create`, `index`, `search`, and `show`
- bun-linked installs work after building from source
- compiled Linux binaries run correctly when copied into the image
- the CLI can create a fresh bundle, build an index, and discover new assets

Treat this matrix as a release gate for shell-level regressions too. The Docker
smoke path exercises real entrypoint scripts and container command execution,
which can catch failures that unit and subprocess tests miss.

### What it does not prove by itself

- that the published release artifact matches the local compiled binary
- that `install.sh` works against a real GitHub release
- that self-upgrade can replace the running binary in-place

Those should be validated in disposable containers as described next.

## Published Artifact Acceptance

Published binary, installer, checksum, native-platform, and self-upgrade
procedures are release-facing manual gates. Run sections 21-22 of the
[manual runbook](./manual-testing-checklist.md); do not validate release bytes
with an installer fetched from raw `main`.

## Upgrade Regression Coverage

Managed-source updates and CLI self-upgrade are separate implementations.
Provider/registry suites cover source add/update/remove/cache behavior;
`tests/integration/self-update.test.ts` covers install-method detection,
orchestration, checksum, and failure paths. Real managed-source and self-upgrade
acceptance is manual and lives in section 21 of the
[manual runbook](./manual-testing-checklist.md).

### Upgrade rehearsal gate

`tests/integration/upgrade-rehearsal/` installs the PREVIOUS published stable
`akm-cli` release and the CANDIDATE build as real global npm packages (real
`npm pack` / `npm install --global` into throwaway prefixes — see
`scripts/package-install.ts`), drives the previous release to build a
realistic home — a filesystem bundle, a git bundle (with an in-bundle symlink
at its root), a website bundle, an npm bundle, three scheduled tasks (two
granted, one left ungranted) plus a manual task, and a synced native (fake)
crontab — then runs the CANDIDATE against that home (`migrate status`/
`apply`, `bundle list`, `search`/`show`, `task sync` dry-run and real,
executing a rebound generated cron command, `task run`, `health`,
`improve --plan`), and finally runs the PREVIOUS release back against the
candidate-written home to prove read-back still works. It exists because no
other suite drives a real prior release against a real candidate build: the
symlink-abort regression fixed in 0.9.17-alpha.3 (`45b5693dc`) went
undetected by the full unit/integration suite, `tests/release-check.sh`, and
the Docker matrix, because no fixture combined a git bundle with an
in-bundle symlink, a website bundle, an npm bundle, an ungranted task, and a
real crontab row in one home. `tests/integration/previous-release-corpus.test.ts`
covers persisted-data shapes read in isolation; this gate covers the whole
CLI surface driven end to end across two real installed releases.

Run it locally with:

```sh
bun run build
AKM_UPGRADE_REHEARSAL=1 TMPDIR=/tmp bun test --timeout=900000 tests/integration/upgrade-rehearsal/
```

Unset (the default), the suite logs one line and skips — it never fails
"inconclusively" (#795): every missing capability (no `npm` on `PATH`, no
network reachable to resolve/fetch the previous release, no candidate build)
throws naming the fix instead. Env overrides:

- `AKM_UPGRADE_FROM=<version>` — pin the previous release instead of
  resolving the highest published stable version below the candidate's
  `package.json` version.
- `AKM_CANDIDATE_TARBALL=<path>` — use an already-packed candidate tarball
  (`tests/release-check.sh` passes `$PACKAGE_CANDIDATE`) instead of running
  `npm pack` on the working tree (which requires `dist/cli.js` — run
  `bun run build` first).

Fetched previous-release tarballs are cached under
`${TMPDIR:-/tmp}/akm-upgrade-rehearsal/previous-release/<version>/` so repeat
runs do not re-hit the network. It is wired into CI as the `upgrade-rehearsal`
job (`.github/workflows/ci.yml`) and into `tests/release-check.sh` right
after packing the release candidate.

## Coverage Gap Guide

This repo now has broad coverage across the major CLI, indexing, registry, and
semantic-search paths. Use this file as a current gap guide, not a greenfield
test plan.

### Areas With Strong Existing Coverage

- database and scoring (`tests/integration/db.test.ts`, `tests/integration/db-scoring.test.ts`, `tests/integration/fts-field-weighting.test.ts`)
- search/show CLI surfaces (`tests/integration/commands/search-cli-envelope.test.ts`, `tests/integration/commands/show.test.ts`, and the other `search-*`/`show-*` suites under `tests/integration/`)
- registry install/search/update/list flows
- workflow, vault, and wiki behavior
- semantic status, vector search, and embedding config behavior
- CLI error handling and output shaping
- Docker install validation

### Highest-Value Remaining Gaps

1. corrupt or version-mismatched DB fallback behavior during search
2. local model download and ONNX startup failures
3. partial embedding-generation failures during indexing
4. concurrent search/embedder behavior under load
5. semantic readiness reporting parity between `setup`, `search`, and `info`
6. broader platform CI for Alpine/musl, ARM, and Windows edge cases

### When Adding Tests

- prefer focused `bun:test` files under `tests/`
- use isolated temp config/cache/stash dirs
- cover the user-visible CLI behavior when the risk is output shaping or command routing
- cover internal units directly when the risk is scoring, metadata extraction, or persistence

### Useful Existing Suites To Extend

- `tests/integration/commands/search-cli-envelope.test.ts`
- `tests/integration/commands/show.test.ts`
- `tests/integration/vector-search.test.ts`
- `tests/integration/semantic-status.test.ts`
- `tests/setup-wizard.test.ts`, `tests/setup-scheduled-tasks.test.ts`
- `tests/integration/info-command.test.ts`
- `tests/integration/docker-install.test.ts`
