# AKM Repo Notes

## Workflow
- Runtime and tooling are Bun-first. Use `bun install`.
- CI runs `bun run check`, which is `bun run lint && bunx tsc --noEmit && bun run test:unit && bun run test:integration`.
- Before committing, run `bunx biome check --write src/ tests/`. Repo guidance prefers the write-capable Biome pass, not just `bun run lint`.
- Build with `bun run build`. It compiles `src/**` only into `dist/`; `dist/tests` should never appear.
- Prefer focused verification with `bun test tests/<file>.test.ts`. `bun run check:changed` runs a small set of output/contract suites (output-baseline, registry-search, show-argv-entrypoint, output-shapes-unit) plus `bun run lint` and `bunx tsc --noEmit`.

## Architecture
- This is a CLI-only package. There is no public API, no barrel exports, and no `exports` map. `src/cli.ts` is the thin dispatcher; command implementations live under `src/commands/`, mostly in per-family directories (`src/commands/read/`, `src/commands/improve/`, `src/commands/sources/`, `src/commands/env/`, `src/commands/tasks/`, `src/commands/agent/`, `src/commands/proposal/`, `src/commands/health/`, `src/commands/lint/`), with a handful of standalone `*-cli.ts` files (e.g. `config-cli.ts`, `workflow-cli.ts`, `migrate-cli.ts`, `registry-cli.ts`) still at the top level.
- If you touch providers, refs, search/show behavior, config, or output shaping, read `docs/architecture/architecture.md` first. `tests/contracts/` pins active contracts and is meant to catch contract drift.
- Supported source providers are locked to `filesystem`, `git`, `website`, and `npm`. Do not add `context-hub`; do not reintroduce `openviking`.
- `SourceProvider` is exactly `{ name, kind, path, sync? }`. All providers materialize files to local disk.
- Asset refs are `[bundle//]conceptId[#fragment]`, where `conceptId` is subdir-qualified within its bundle (e.g. `skills/code-review`, `memories/vpn-note`, `knowledge/api-guide`, `env/prod`). Durable state stores the fully-qualified `bundle//conceptId`; the short bundle-omitted form is input sugar resolved against `defaultBundle`, then the remaining bundles in installation-priority order. Source locators like `github:owner/repo` are for `akm bundle add`, not for asset addressing. The old `[origin//]type:name` grammar is gone (the frozen migrator in `scripts/akm-migrate/migrate/` is the only place it survives).
- `show` is local-index only: resolve through the FTS index, then read from disk. No per-provider `show` exists.
- Registry results are opt-in, stay separate from normal stash hits, and live in `registryHits`, never `hits`.
- All write-target branching by `source.kind` belongs in `src/core/write-source.ts`.
- Write-target resolution order is `--target` -> `defaultWriteTarget` -> working stash (`defaultBundle`); there is no fallback to the first writable source.
- `writable` defaults to `true` on `filesystem` and `false` on `git` / `website` / `npm`; `writable: true` on `website` or `npm` is rejected at config load.

## Tests
- **Two test targets**: `bun run test:unit` (`scripts/test-unit.sh`) runs every `*.test.ts` under `tests/` except `tests/integration/` — that includes the top-level `tests/commands/` and `tests/workflows/` directories (59 files combined, verified 2026-07-27). Do not confuse those with the separate `tests/integration/commands/` and `tests/integration/workflows/` directories, which belong to `bun run test:integration` (`scripts/test-integration.sh`, `tests/integration/**` only). Both scripts shard their target across up to `min(nproc, 8)` concurrent `bun test` processes. `bun run check` runs both targets in sequence after lint and typecheck.
- For a tight inner feedback loop, use `bun run test:unit` or `bun test tests/<specific-file>.test.ts`.
- Semantic search e2e is gated: `AKM_SEMANTIC_TESTS=1 bun test tests/integration/semantic-search-e2e.test.ts`. First run downloads Hugging Face models.
- Docker install coverage is gated: `AKM_DOCKER_TESTS=1 bun test tests/integration/docker-install.test.ts` or `./tests/docker/run-docker-tests.sh`.
- Release validation is `./tests/release-check.sh [--skip-docker]`. Its order is intentional: workflow checks, lint (verify-only — the same `bun run lint` CI runs, no `--write`), typecheck, build, npm bin-target check, package/install regression suites, then the full test suite (`bun run test:unit` + `bun run test:integration`) and an optional Docker matrix. Every `bun test` invocation in the script uses `--timeout=120000`, matching `scripts/test-unit.sh` and `scripts/test-integration.sh`.

### Test-isolation harness
- `bunfig.toml` preloads `tests/_preload.ts` for every `bun test` invocation. The preload owns process state that crosses test boundaries:
  - `HOME` and all four `XDG_*_HOME` env vars are pointed at a per-process sandbox dir at preload time. Test files never read the developer's real `~/.config/akm/`, `~/.cache/akm/`, etc. unless they go through `process.env.HOME` after explicitly restoring it.
  - Every test gets a `beforeEach`/`afterEach` that snapshots the harnessed env (HOME, XDG_*, AKM_BUNDLE_DIR, AKM_CONFIG_DIR, AKM_CACHE_DIR, AKM_DATA_DIR, AKM_STATE_DIR, AKM_VERBOSE, AKM_LLM_API_KEY, AKM_EMBED_API_KEY, AKM_REGISTRY_URL, AKM_NPM_REGISTRY), `process.cwd()`, and `globalThis.fetch`, then restores them after.
  - All module-level singletons in production code are reset between tests: `cachedConfig`, `cachedParsedGraph`, `embedCache`, `localEmbedder`, quiet/verbose flags, and the warn-module log file path.
  - `mock.restore()` is called unconditionally on `afterEach`.
  - A tripwire **throws** if any test leaks an `AKM_*` / `XDG_*` / `HOME` env var that wasn't there at preload time, leaves `process.cwd()` changed, or leaves `globalThis.fetch` replaced.
- Helpers live in `tests/_helpers/sandbox.ts`: `sandboxStashDir()`, `sandboxHome()`, `sandboxXdgConfigHome()`, `sandboxXdgDataHome()`, `writeSandboxConfig(partial)`, and `withMockedFetch(fn, mock)`. Use them rather than mutating env / fetch by hand.
- New test files should not mutate `process.env.HOME =`, `process.chdir(...)`, or `globalThis.fetch =` directly. The lint rule `bun scripts/lint-tests-isolation.ts` (wired into `bun run lint`) flags new occurrences; existing offenders are allow-listed. Use `withMockedFetch` for fetch swaps and restore cwd in a `finally` block when chdir is unavoidable.

## CLI Contract
- Failures render to `stderr` as `{ok:false, error, code}`. The canonical exit-code table (`EXIT_CODES` in `src/cli/shared.ts`) is: `0` success, `1` general error / not found, `2` usage error, `4` health warn (`akm health` only), `70` internal / unclassified (any thrown value that is not an `AkmError` — sysexits `EX_SOFTWARE`), `78` config error.

## LLM Defaults

LLM defaults follow a "works correctly for the lowest common denominator" philosophy — a slow local model on a single-threaded server. Do not add per-call tuning knobs without a strong reason.

- `max_tokens` is **not sent** by default in `chatCompletion`. The model/API already knows its own limits; a hardcoded default creates silent truncation failures. Users who need a cap can set `engines.<name>.maxTokens` in config.json. The only exception is `probeLlmCapabilities`, which sends `maxTokens: 64` because it expects a tiny fixed-shape response.
- `DEFAULT_TIMEOUT_MS` in `tryLlmFeature` is **600 000 ms** (10 minutes). There is a single timeout knob: `engines.<name>.timeoutMs` in config.json (forwarded as `opts.timeoutMs`). The removed `featureGateTimeoutMs` field was a band-aid; do not re-add it.
- `concurrency` defaults to **1** in `concurrentMap`. For indexing's LLM enrichment pool the effective default is auto-derived by `getDefaultLlmConcurrency` (`src/indexer/indexer.ts`): **1** for a local/localhost endpoint, **2** for a remote one — local model servers (LM Studio, Ollama) run one inference at a time, and the old flat default of 4 crashed them with "Model reloaded" / HTTP 500 errors. `engines.<name>.concurrency` is a valid schema field, but on this path it is **not honored**: `resolveLlmEngineUse` (`src/integrations/agent/engine-resolution.ts`) never copies it into the resolved connection, so setting it in config.json has no effect on indexing concurrency. The same key IS honored for workflow step engine concurrency caps — `src/workflows/ir/freeze.ts` reads `engine.concurrency` off the raw config into the frozen `FrozenLlmEngine` (clamped to `1..64`; when unset it derives **1** for a loopback endpoint and **4** for a remote one, per `src/workflows/concurrency-policy.ts`), and the workflow scheduler (`src/workflows/exec/scheduler.ts`) uses it to cap `map`/`over` step fan-out.
- **Workflow fan-out is parallel by default (0.9.1+).** A `map` step with no `concurrency:` freezes `DEFAULT_MAP_CONCURRENCY` (**4**), overridable per install by `workflow.defaultMapConcurrency` (set it to `1` for the pre-0.9.1 serial default) and per step by an authored `concurrency:` (an explicit `1` is honored and stays distinguishable from unset). All fan-out policy lives in `src/workflows/concurrency-policy.ts` and is resolved ONCE at freeze, so `plan_json` carries the widths and an in-flight/resumed run never changes behavior underneath itself. The scheduler's own `concurrency ?? 1` is a fail-safe for callers that name no width, not the map default. Effective width is `min(map concurrency, execution.maxConcurrency, engine concurrency, host CPU cap)`.
- There is no top-level `llm` config key in 0.9 — it is retired and rejected at
  config load (`akm config set/unset llm...` fails with `Unknown config key`).
  Per-call tuning lives on each named engine under `engines.<name>.*`.

## Code Style
- Prefer external `.md` (or `.xml`) files over long inline strings in TypeScript. Multi-line template literals containing markdown, XML, or prose belong in a standalone file in the same directory as the module that uses them. Import them with `import x from "./x.md" with { type: "text" }` and use `.replace`/`.replaceAll` with `{{PLACEHOLDER}}` tokens at call time. This keeps templates editable without touching TS source and avoids escaping noise inside template literals. See `src/tasks/backends/schtasks.ts` (which imports `src/assets/backends/schtasks-template.xml`), `src/output/cli-hints.ts`, and `scripts/copy-assets.ts` for the established pattern.

## Gotchas
- `prepublishOnly` copies `.github/README.npm.md` over `README.md` before building, and `postpublish` restores `README.md` with `git checkout -- README.md`. Do not treat that README churn as a normal source edit.
- `.github/workflows/ci.yml` ignores docs-only changes (`docs/**`, `README.md`, `CHANGELOG.md`, `schemas/**`, `CLAUDE.md`, `LICENSE`), so docs-only edits will not get normal CI coverage.
