# CLAUDE.md

akm (Agent Kit Manager) -- CLI tool for managing AI agent assets (skills, commands, agents, knowledge, scripts, memories).

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

See `ARCHITECTURE.md` for full details. These constraints are inviolable:

### Provider types
- Only three stash provider types exist: **filesystem**, **git**, **openviking**
- MUST NOT create a `context-hub` type. It is just a git repo.
- Local providers (filesystem, git) are indexed by us. Remote providers (openviking) return pre-scored results.

### Refs
- Asset refs are `type:name` (e.g., `skill:deploy`). Nothing else.
- Source locators (`github:owner/repo`, `npm:pkg`) are for `akm add`, not for addressing assets.
- MUST NOT use URI schemes (`viking://`, `context-hub://`) in user-facing refs.

### Search
- One scoring pipeline (FTS5 + boosts) for all indexed content.
- Remote provider scores compete fairly with local scores -- never suppressed.
- Registry results go in `registryHits`, never in `hits`.

### Show
- Local FTS5 first, remote fallback. Routing by source metadata, not URI prefix.

### Utility scoring
- EMA decay is time-proportional, not tied to index frequency.

## What NOT To Do

- Do not create new URI schemes for refs
- Do not add parallel scoring systems for different provider types
- Do not make `context-hub` a provider type
- Do not merge registry results into stash hits
- Do not suppress remote provider scores below local scores
- Do not skip `bunx biome check --write` before committing
