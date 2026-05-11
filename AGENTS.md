# AKM Repo Notes

## Workflow
- Runtime and tooling are Bun-first. Use `bun install`.
- CI runs `bun run check`, which is `bun run lint && bunx tsc --noEmit && bun test ./tests`.
- Before committing, run `bunx biome check --write src/ tests/`. Repo guidance prefers the write-capable Biome pass, not just `bun run lint`.
- Build with `bun run build`. It compiles `src/**` only into `dist/`; `dist/tests` should never appear.
- Prefer focused verification with `bun test tests/<file>.test.ts`. Do not rely on `bun run check:changed` without checking it first; the script references `tests/stash-search.test.ts`, which is not present.

## Architecture
- This is a CLI-only package. There is no public API, no barrel exports, and no `exports` map. `src/cli.ts` is the thin dispatcher; add CLI verbs under `src/commands/*.ts`.
- If you touch providers, refs, search/show behavior, config, or output shaping, read `CLAUDE.md` and `docs/technical/v1-architecture-spec.md` first. `tests/contracts/` pins the spec and is meant to catch contract drift.
- Supported source providers are locked to `filesystem`, `git`, `website`, and `npm`. Do not add `context-hub`; do not reintroduce `openviking`.
- `SourceProvider` is exactly `{ name, kind, init, path, sync? }`. All providers materialize files to local disk.
- Asset refs are `[origin//]type:name`. Source locators like `github:owner/repo` are for `akm add`, not for asset addressing.
- `show` is local-index only: resolve through the FTS index, then read from disk. No per-provider `show` exists.
- Registry results are opt-in, stay separate from normal stash hits, and live in `registryHits`, never `hits`.
- All write-target branching by `source.kind` belongs in `src/core/write-source.ts`.
- Write-target resolution order is `--target` -> `defaultWriteTarget` -> `stashDir`; there is no fallback to the first writable source.
- `writable` defaults to `true` on `filesystem` and `false` on `git` / `website` / `npm`; `writable: true` on `website` or `npm` is rejected at config load.

## Tests
- Semantic search e2e is gated: `AKM_SEMANTIC_TESTS=1 bun test tests/semantic-search-e2e.test.ts`. First run downloads Hugging Face models.
- Docker install coverage is gated: `AKM_DOCKER_TESTS=1 bun test tests/docker-install.test.ts` or `./tests/docker/run-docker-tests.sh`.
- Release validation is `./tests/release-check.sh [--skip-docker]`. Its order is intentional: Biome write pass, typecheck, build, npm bin-target check, setup/install regression suite, full test suite, then optional Docker matrix.

## CLI Contract
- Failures render to `stderr` as `{ok:false, error, code}`. Exit codes are `2` for usage, `78` for config, and `1` for general errors.

## LLM Defaults

LLM defaults are intentionally generous — do not reduce max_tokens, timeouts, or concurrency defaults without a documented user-facing reason. Local model users need headroom.

- `max_tokens` defaults to **4096** in `chatCompletion` (raised from 512). The old 512 default caused ~50% of `akm consolidate` chunks to silently fail with truncated JSON. Only lower this for probe calls (capability detection) where you explicitly know a small output is expected.
- `DEFAULT_TIMEOUT_MS` in `tryLlmFeature` is **120 000 ms** (2 minutes, raised from 30 s). Local models on consumer hardware routinely take 30–90 s per request. If a call seems to hang, investigate the model server first before reducing the timeout.
- `concurrency` defaults to **4** for cloud APIs. Set `llm.concurrency: 1` in config.json for local model servers (LM Studio, Ollama) that run one inference at a time — running 4 concurrent requests crashes them with "Model reloaded" / HTTP 500 errors.
- `featureGateTimeoutMs` is user-overridable in config.json. Document any change to these defaults in both the JSDoc comment and this section.

## Code Style
- Prefer external `.md` (or `.xml`) files over long inline strings in TypeScript. Multi-line template literals containing markdown, XML, or prose belong in a standalone file in the same directory as the module that uses them. Import them with `import x from "./x.md" with { type: "text" }` and use `.replace`/`.replaceAll` with `{{PLACEHOLDER}}` tokens at call time. This keeps templates editable without touching TS source and avoids escaping noise inside template literals. See `src/wiki/wiki-templates.ts`, `src/tasks/backends/schtasks-template.xml`, and `scripts/copy-assets.ts` for the established pattern.

## Gotchas
- `prepublishOnly` copies `.github/README.npm.md` over `README.md` before building, and `postpublish` restores `README.md` with `git checkout -- README.md`. Do not treat that README churn as a normal source edit.
- `.github/workflows/ci.yml` ignores docs-only changes (`docs/**`, `README.md`, `CHANGELOG.md`, `schemas/**`, `CLAUDE.md`, `LICENSE`), so docs-only edits will not get normal CI coverage.
