# CLAUDE.md

akm (Agent Kit Manager) -- CLI tool for managing AI agent assets (skills, commands, agents, knowledge, scripts, memories, workflows, vaults, wikis).

## Build & Test

```sh
bun test                              # Run all tests
bunx biome check --write src/ tests/  # Lint and format (run before every commit)
bunx tsc --noEmit                     # Type-check without emitting
bun run tests/benchmark-suite.ts      # Scoring benchmarks
```

## Project Structure

- `src/` -- all source code (TypeScript, ESM)
- `tests/` -- bun:test test files
- `dist/` -- build output (JS only, no declarations)
- CLI-only package; no public API, no barrel exports

## Architectural Rules

See `docs/technical/architecture.md` for full details. These constraints are inviolable:

### Source provider types
- Only two source provider types exist: **filesystem**, **git** (website and npm for cache-backed sources)
- MUST NOT create a `context-hub` type. It is just a git repo.
- MUST NOT recreate `openviking`. It was removed in v1 (see `docs/migration/v1.md`).
- All providers materialise files to local disk. The FTS5 indexer walks the disk path.
- The internal type is `SourceProvider`; the config entry type is `SourceConfigEntry`.

### Refs
- Asset refs are `type:name` (e.g., `skill:deploy`). Nothing else.
- Source locators (`github:owner/repo`, `npm:pkg`) are for `akm add`, not for addressing assets.
- MUST NOT use URI schemes in user-facing refs.

### Search
- One scoring pipeline (FTS5 + boosts) for all indexed content.
- Registry results go in `registryHits`, never in `hits`.

### Show
- Local FTS5 index only. No remote provider fallback.

### Utility scoring
- EMA decay is time-proportional, not tied to index frequency.

## What NOT To Do

- Do not create new URI schemes for refs
- Do not add parallel scoring systems for different provider types
- Do not make `context-hub` a provider type
- Do not re-introduce `openviking` or any remote-only source provider
- Do not merge registry results into source search hits
- Do not skip `bunx biome check --write` before committing
