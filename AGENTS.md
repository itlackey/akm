# AKM Repo Notes

## Workflow
- Runtime and tooling are Bun-first. Use `bun install`.
- CI runs `bun run check`, which is `bun run lint && bunx tsc --noEmit && bun run test:unit && bun run test:integration`.
- Before committing, run `bunx biome check --write src/ tests/`. Repo guidance prefers the write-capable Biome pass, not just `bun run lint`.
- Build with `bun run build`. It compiles `src/**` only into `dist/`; `dist/tests` should never appear.
- Prefer focused verification with `bun test tests/<file>.test.ts`. `bun run check:changed` runs a small set of output/contract suites (output-baseline, registry-search, show-argv-entrypoint, output-shapes-unit) plus `bun run lint` and `bunx tsc --noEmit`.

## Architecture
- This is a CLI-only package. There is no public API, no barrel exports, and no `exports` map. `src/cli.ts` is the thin dispatcher; add CLI verbs under `src/commands/*.ts`.
- If you touch providers, refs, search/show behavior, config, or output shaping, read `docs/technical/architecture.md` first. `tests/contracts/` pins active contracts and is meant to catch contract drift.
- Supported source providers are locked to `filesystem`, `git`, `website`, and `npm`. Do not add `context-hub`; do not reintroduce `openviking`.
- `SourceProvider` is exactly `{ name, kind, path, sync? }`. All providers materialize files to local disk.
- Asset refs are `[bundle//]conceptId[#fragment]`, where `conceptId` is subdir-qualified within its bundle (e.g. `skills/code-review`, `memories/vpn-note`, `knowledge/api-guide`, `env/prod`). Durable state stores the fully-qualified `bundle//conceptId`; the short bundle-omitted form is input sugar resolved against `defaultBundle`, then the remaining bundles in installation-priority order. Source locators like `github:owner/repo` are for `akm add`, not for asset addressing. The pre-0.9.0 `[origin//]type:name` grammar is gone (the frozen migrator in `src/migrate/legacy/` is the only place it survives).
- `show` is local-index only: resolve through the FTS index, then read from disk. No per-provider `show` exists.
- Registry results are opt-in, stay separate from normal stash hits, and live in `registryHits`, never `hits`.
- All write-target branching by `source.kind` belongs in `src/core/write-source.ts`.
- Write-target resolution order is `--target` -> `defaultWriteTarget` -> `stashDir`; there is no fallback to the first writable source.
- `writable` defaults to `true` on `filesystem` and `false` on `git` / `website` / `npm`; `writable: true` on `website` or `npm` is rejected at config load.

## Tests
- **Two test targets**: `bun run test:unit` (fast, < 60s, excludes `tests/integration/`) and `bun run test:integration` (slow, covers `tests/integration/`, `tests/commands/`, `tests/workflows/`). `bun run check` runs both in sequence after lint and typecheck.
- For a tight inner feedback loop, use `bun run test:unit` or `bun test tests/<specific-file>.test.ts`.
- Semantic search e2e is gated: `AKM_SEMANTIC_TESTS=1 bun test tests/semantic-search-e2e.test.ts`. First run downloads Hugging Face models.
- Docker install coverage is gated: `AKM_DOCKER_TESTS=1 bun test tests/integration/docker-install.test.ts` or `./tests/docker/run-docker-tests.sh`.
- Release validation is `./tests/release-check.sh [--skip-docker]`. Its order is intentional: Biome write pass, typecheck, build, npm bin-target check, setup/install regression suite, full test suite, then optional Docker matrix.

### Test-isolation harness
- `bunfig.toml` preloads `tests/_preload.ts` for every `bun test` invocation. The preload owns process state that crosses test boundaries:
  - `HOME` and all four `XDG_*_HOME` env vars are pointed at a per-process sandbox dir at preload time. Test files never read the developer's real `~/.config/akm/`, `~/.cache/akm/`, etc. unless they go through `process.env.HOME` after explicitly restoring it.
  - Every test gets a `beforeEach`/`afterEach` that snapshots the harnessed env (HOME, XDG_*, AKM_STASH_DIR, AKM_CONFIG_DIR, AKM_CACHE_DIR, AKM_DATA_DIR, AKM_STATE_DIR, AKM_VERBOSE, AKM_LLM_API_KEY, AKM_EMBED_API_KEY, AKM_REGISTRY_URL, AKM_NPM_REGISTRY), `process.cwd()`, and `globalThis.fetch`, then restores them after.
  - All module-level singletons in production code are reset between tests: `cachedConfig`, `cachedParsedGraph`, `embedCache`, `localEmbedder`, quiet/verbose flags, and the warn-module log file path.
  - `mock.restore()` is called unconditionally on `afterEach`.
  - A tripwire **throws** if any test leaks an `AKM_*` / `XDG_*` / `HOME` env var that wasn't there at preload time, leaves `process.cwd()` changed, or leaves `globalThis.fetch` replaced.
- Helpers live in `tests/_helpers/sandbox.ts`: `sandboxStashDir()`, `sandboxHome()`, `sandboxXdgConfigHome()`, `sandboxXdgDataHome()`, `writeSandboxConfig(partial)`, and `withMockedFetch(fn, mock)`. Use them rather than mutating env / fetch by hand.
- New test files should not mutate `process.env.HOME =`, `process.chdir(...)`, or `globalThis.fetch =` directly. The lint rule `bun scripts/lint-tests-isolation.ts` (wired into `bun run lint`) flags new occurrences; existing offenders are allow-listed. Use `withMockedFetch` for fetch swaps and restore cwd in a `finally` block when chdir is unavoidable.
- Background: the harness was added on `feat/test-isolation-harness` because the per-file save/restore pattern kept regressing — `tests/wiki.test.ts` was reading the developer's real `~/.config/akm/config.json` despite the file's own env-isolation boilerplate. The design lives at `knowledge/projects/akm/test-harness-redesign`.

## CLI Contract
- Failures render to `stderr` as `{ok:false, error, code}`. Exit codes are `2` for usage, `78` for config, and `1` for general errors.

## LLM Defaults

LLM defaults follow a "works correctly for the lowest common denominator" philosophy — a slow local model on a single-threaded server. Do not add per-call tuning knobs without a strong reason.

- `max_tokens` is **not sent** by default in `chatCompletion`. The model/API already knows its own limits; a hardcoded default creates silent truncation failures. Users who need a cap can set `llm.maxTokens` in config.json. The only exception is `probeLlmCapabilities`, which sends `maxTokens: 64` because it expects a tiny fixed-shape response.
- `DEFAULT_TIMEOUT_MS` in `tryLlmFeature` is **600 000 ms** (10 minutes). There is a single timeout knob: `llm.timeoutMs` in config.json (forwarded as `opts.timeoutMs`). The removed `featureGateTimeoutMs` field was a band-aid; do not re-add it.
- `concurrency` defaults to **1** in `concurrentMap`. Cloud users can set `llm.concurrency: 4` in config.json. Local model servers (LM Studio, Ollama) run one inference at a time — the old default of 4 crashed them with "Model reloaded" / HTTP 500 errors.

## Code Style
- Prefer external `.md` (or `.xml`) files over long inline strings in TypeScript. Multi-line template literals containing markdown, XML, or prose belong in a standalone file in the same directory as the module that uses them. Import them with `import x from "./x.md" with { type: "text" }` and use `.replace`/`.replaceAll` with `{{PLACEHOLDER}}` tokens at call time. This keeps templates editable without touching TS source and avoids escaping noise inside template literals. See `src/tasks/backends/schtasks.ts` (which imports `src/assets/backends/schtasks-template.xml`), `src/output/cli-hints.ts`, and `scripts/copy-assets.ts` for the established pattern.

## Gotchas
- `prepublishOnly` copies `.github/README.npm.md` over `README.md` before building, and `postpublish` restores `README.md` with `git checkout -- README.md`. Do not treat that README churn as a normal source edit.
- `.github/workflows/ci.yml` ignores docs-only changes (`docs/**`, `README.md`, `CHANGELOG.md`, `schemas/**`, `CLAUDE.md`, `LICENSE`), so docs-only edits will not get normal CI coverage.
