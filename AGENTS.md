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

## Gotchas
- `prepublishOnly` copies `.github/README.npm.md` over `README.md` before building, and `postpublish` restores `README.md` with `git checkout -- README.md`. Do not treat that README churn as a normal source edit.
- `.github/workflows/ci.yml` ignores docs-only changes (`docs/**`, `README.md`, `CHANGELOG.md`, `schemas/**`, `CLAUDE.md`, `LICENSE`), so docs-only edits will not get normal CI coverage.
