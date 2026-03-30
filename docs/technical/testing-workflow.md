# Testing Workflow

This project is a CLI with three risk-heavy areas:

- command behavior across real files, config, and cache directories
- managed-source install/update flows
- binary deployment and self-upgrade behavior

The safest way to test it is in layers: fast local checks first, then end-to-end
CLI coverage, then Docker-based deployment and upgrade validation.

## What To Validate

- core CLI flows: `init`, `index`, `search`, `show`, `info`, `list`, `config`
- asset lifecycle: add assets, re-index, search, show, and incremental refresh
- managed-source lifecycle: `akm add`, `akm list`, `akm update`, `akm remove`
- binary lifecycle: install, run, `akm upgrade --check`, `akm upgrade`
- cross-environment behavior on Ubuntu, Debian, Alpine, and Fedora containers
- provider integration that depends on Docker Compose, especially OpenViking

## Test Layers In This Repo

### 1. Fast local correctness

Run these before any release candidate or merge:

```sh
bun test
bunx biome check --write src/ tests/
bunx tsc --noEmit
```

Use this when you want the shortest full-project signal:

```sh
bun run check
```

Relevant coverage:

- `tests/self-update.test.ts` - self-upgrade detection and checksum enforcement
- `tests/stash-registry.test.ts` - `list`, `remove`, `update`, cache cleanup
- `tests/registry-install.test.ts` - install resolution, tar safety, local/git/npm paths
- `tests/e2e.test.ts` - real CLI workflows and subprocess behavior
- `tests/setup-run.integration.ts` - full setup wizard orchestration and failure handling
- `tests/install-script.test.ts` - repeatable `install.sh` edge cases and permission paths

### 2. End-to-end CLI validation

Run the full E2E suite when changing CLI behavior, indexing, search, config,
source management, or output shaping:

```sh
bun test tests/e2e.test.ts
```

This suite exercises real flows, including:

- fallback search without an index
- `index -> search -> show`
- CLI subprocess execution through `src/cli.ts`
- config read/write behavior
- registry-source compatibility
- progressive indexing and re-indexing
- update and upgrade command error paths
- knowledge view modes and mixed asset discovery

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

These cases are covered by `tests/setup-run.integration.ts` and the focused
semantic/config suites.

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
bun test tests/docker-install.test.ts
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
- `akm init`
- stash directory creation
- `akm index`
- `akm search`
- `akm show`
- `akm info`
- `akm list`
- incremental re-index after adding a new asset

## Recommended Workflow

### Normal change

Use this for most code changes:

```sh
bun test
bun test tests/e2e.test.ts
bunx biome check --write src/ tests/
bunx tsc --noEmit
```

### Install, packaging, or release-related change

Use this when touching `src/cli.ts`, `src/self-update.ts`, install flows,
source management, or Docker assets:

```sh
bun test
bun test tests/e2e.test.ts tests/self-update.test.ts tests/stash-registry.test.ts tests/registry-install.test.ts ./tests/setup-run.integration.ts tests/install-script.test.ts
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

## End-To-End Manual Validation

Use an isolated environment so host config and cache do not affect results:

```sh
export XDG_CONFIG_HOME="$(mktemp -d)"
export XDG_CACHE_HOME="$(mktemp -d)"
export AKM_STASH_DIR="$(mktemp -d)/akm"

bun run build
bun run src/cli.ts init
```

Then run a complete user flow:

```sh
mkdir -p "$AKM_STASH_DIR/scripts/deploy"
cat > "$AKM_STASH_DIR/scripts/deploy/deploy-app.sh" <<'EOF'
#!/usr/bin/env bash
# Deploy application
echo deploying
EOF
chmod +x "$AKM_STASH_DIR/scripts/deploy/deploy-app.sh"

bun run src/cli.ts index
bun run src/cli.ts search deploy --detail full
bun run src/cli.ts show script:deploy-app.sh --detail full
bun run src/cli.ts info --format json
```

Expected outcomes:

- `init` creates the stash and saves config
- `index` reports at least one entry
- `search` returns the script with an action and score
- `show` returns `type: script` and a `run` command
- `info` reports the configured stash and cache paths

## Docker Deployment Validation

### Automated matrix

The repo already contains Dockerfiles for:

- `tests/docker/Dockerfile.ubuntu-bun`
- `tests/docker/Dockerfile.debian-bun`
- `tests/docker/Dockerfile.alpine-bun`
- `tests/docker/Dockerfile.fedora-bun`
- `tests/docker/Dockerfile.ubuntu-binary`
- `tests/docker/Dockerfile.debian-binary`
- `tests/docker/Dockerfile.alpine-binary`
- `tests/docker/Dockerfile.fedora-binary`

Run one variant if you need a focused repro:

```sh
./tests/docker/run-docker-tests.sh ubuntu-binary
./tests/docker/run-docker-tests.sh --bun-only
./tests/docker/run-docker-tests.sh --binary-only
```

### What the Docker matrix proves

- the CLI starts in minimal Linux images
- runtime dependencies are sufficient for `init`, `index`, `search`, and `show`
- bun-linked installs work after building from source
- compiled Linux binaries run correctly when copied into the image
- the CLI can create a fresh stash, build an index, and discover new assets

Treat this matrix as a release gate for shell-level regressions too. The Docker
smoke path exercises real entrypoint scripts and container command execution,
which can catch failures that unit and subprocess tests miss.

### What it does not prove by itself

- that the published release artifact matches the local compiled binary
- that `install.sh` works against a real GitHub release
- that self-upgrade can replace the running binary in-place

Those should be validated in disposable containers as described next.

## Validating Published Binary Deployment

Use this when validating a real release artifact, not just a local build.

Inside an ephemeral container:

```sh
docker run --rm -it ubuntu:22.04 bash
apt-get update && apt-get install -y curl ca-certificates git
curl -fsSL https://raw.githubusercontent.com/itlackey/akm/main/install.sh | bash
akm --help
akm init
akm index
```

Validate:

- `install.sh` downloads the correct binary for the OS and architecture
- checksum verification passes
- the binary lands on `PATH`
- the installed binary can execute normal CLI flows

Run the same release-artifact check in at least one glibc-based image and one
musl-based image if you publish binaries intended for both environments.

## Validating Upgrade Logic

There are two different upgrade paths and both matter.

### 1. Managed-source upgrades: `akm update`

`akm update` refreshes managed kits, not the `akm` binary itself.

Automated coverage already exists in:

- `tests/stash-registry.test.ts`
- `tests/registry-install.test.ts`
- upgrade-related scenarios inside `tests/e2e.test.ts`

Before release, validate this manually against a disposable managed source.
Use a staging npm package, GitHub repo, or git ref that you can change between
two versions.

Recommended manual flow:

```sh
akm add <managed-source-ref>
akm list
akm search "<known asset>"

# publish or expose an updated source version here

akm update <managed-source-ref>
akm update <managed-source-ref> --force
akm list --format json
akm search "<updated asset>" --detail full
```

Validate:

- the source appears as `managed` in `akm list`
- `akm update` reports `changed.version`, `changed.revision`, and `changed.any` correctly
- `--force` clears stale cache and re-downloads cleanly
- reindexing happens automatically and new asset contents are searchable
- `akm remove <managed-source-ref>` removes the managed source and cleans cache

### 2. CLI self-upgrade: `akm upgrade`

`akm upgrade` only performs an in-place upgrade for standalone binary installs.
For npm installs it intentionally prints guidance.

Automated coverage:

- install-method detection
- `--check` behavior
- checksum fetch failures
- missing checksum entries
- checksum mismatches
- npm and unknown-install guidance

See `tests/self-update.test.ts`.

### Why Docker is required for final self-upgrade validation

The real binary-upgrade path replaces the running executable. That is risky to
test on a host machine and is intentionally not fully exercised by unit tests.
Use a disposable container or VM for the happy-path upgrade test.

### Disposable-container self-upgrade test

Start from an older released binary in a container, then run the upgrade:

```sh
docker run --rm -it ubuntu:22.04 bash
apt-get update && apt-get install -y curl ca-certificates git
curl -fsSL https://raw.githubusercontent.com/itlackey/akm/main/install.sh | bash -s -- <older-tag>
akm --version
akm upgrade --check
akm upgrade
akm --version
```

Validate:

- `akm upgrade --check` reports the newer version
- `akm upgrade` downloads the correct binary and verifies checksums
- the executable still runs after replacement
- `akm --version` changes to the expected version
- a basic command still works after upgrade, for example `akm info`

Also run one negative-path check in automation or staging:

- checksum file missing
- target binary missing from `checksums.txt`
- checksum mismatch
- permission failure when install directory is not writable

Most of those negative cases are already covered by `tests/self-update.test.ts`.

## Docker Compose Provider Validation

The repo includes `tests/fixtures/openviking/docker-compose.yml` for manual
OpenViking provider validation.

Bring it up:

```sh
docker compose -f tests/fixtures/openviking/docker-compose.yml up -d
```

Then validate provider wiring:

```sh
akm add http://localhost:1933 --provider openviking --name openviking
akm list
akm search "project context" --source both --detail full
```

Validate:

- the remote provider is listed as a source
- `--source both` returns local hits plus remote provider results
- remote-provider failures surface as warnings instead of crashing the CLI

Tear it down when done:

```sh
docker compose -f tests/fixtures/openviking/docker-compose.yml down
```

## Evidence To Capture For A Release

For any release candidate, keep these artifacts:

- `bun test` output
- `bun test tests/e2e.test.ts` output
- Docker matrix summary from `./tests/docker/run-docker-tests.sh`
- one successful `install.sh` transcript in a fresh container
- one successful `akm upgrade` transcript from an older binary to the candidate
- one successful `akm update` transcript against a disposable managed source

## Practical Notes

- always isolate `AKM_STASH_DIR`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME` during manual testing
- use Docker for any test that mutates the installed binary or depends on OS packaging
- treat `akm update` and `akm upgrade` as separate release gates; they test different code paths
- if a change touches packaging, runtime detection, or checksums, do not rely on unit tests alone
