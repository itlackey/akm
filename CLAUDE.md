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

### `src/` layout (post-v1 reorg)

```
src/
  cli.ts             # thin argv dispatcher
  version.ts
  globals.d.ts
  commands/          # one file per CLI verb (search, show, add, remove, ...)
  core/              # config, types, errors, refs, write-source, frontmatter
  indexer/           # FTS5 index + lookup
  integrations/      # external tooling integrations
  llm/               # LLM client glue
  output/            # output shapes + text rendering
  registry/          # registry providers + factory + resolve
  setup/             # setup steps, one per file
  sources/           # source providers + factory + resolve
  templates/
  wiki/              # wiki-crud, wiki-index, wiki-lint, wiki-ingest
  workflows/
```

The reorg is internal. There is no public API, no barrel exports, no
`exports` map in `package.json`. Tests and the CLI binary import directly
from these modules.

## Architectural Rules

See `docs/technical/v1-architecture-spec.md` for the locked v1 contract and
`docs/technical/architecture.md` for the implementation overview. These
constraints are inviolable:

### Source provider types
- The supported source kinds are: **filesystem**, **git**, **website**, **npm**.
- MUST NOT create a `context-hub` type. It is just a git repo.
- MUST NOT recreate `openviking`. It was removed in v1 (see `docs/migration/v1.md`).
- All providers materialise files to local disk. The FTS5 indexer walks the disk path returned by `provider.path()`.
- The `SourceProvider` interface is exactly `{ name, kind, init, path, sync? }` (spec §2.1). Three required methods, one optional. No extras.
- The internal type is `SourceProvider`; the config entry type is `SourceConfigEntry`. The persisted config key is `sources[]` (legacy `stashes[]` is read with a deprecation warning for one release cycle).

### Writes
- One write helper: `writeAssetToSource` in `src/core/write-source.ts`. It is the only place that branches on `source.kind` to add behaviour.
- `writable` defaults: `true` on `filesystem`, `false` on `git` / `website` / `npm`.
- `writable: true` on `website` or `npm` is rejected at config load with `ConfigError("writable: true is only supported on filesystem and git sources")`.
- Write-target resolution order: `--target` flag → `defaultWriteTarget` config key → `stashDir` (working stash) → `ConfigError("no writable source configured; run \`akm init\`")`. No "first writable in `sources[]` order" fallback.

### Refs
- Asset refs are `[origin//]type:name` (e.g., `skill:deploy`, `team//skill:deploy`). Nothing else.
- Source locators (`github:owner/repo`, `npm:pkg`) are for `akm add`, not for addressing assets.
- MUST NOT use URI schemes in user-facing refs.

### Search
- One scoring pipeline (FTS5 + boosts) for all indexed content.
- `SearchHit.score` is in `[0, 1]`, higher = better.
- Registry results are off by default; behind `--include-registry` (or `--source registry|both`). Default `akm search` output is source-only.
- Registry results live in `registryHits`, never in `hits`.

### Show
- Local FTS5 index only. No remote provider fallback.
- `show` uses `indexer.lookup(ref)` then reads the file from disk. No per-provider `show` method exists.

### Errors and exit codes
- Error classes own `.code` and `.hint()`. No regex-on-message hint chain.
- Hints print to stderr inline. `--verbose` is not required to see them.
- Exit codes: `USAGE = 2`, `CONFIG = 78`, `GENERAL = 1`.

### Utility scoring
- EMA decay is time-proportional, not tied to index frequency.

## Locked v1 contracts (spec §9)

Any change to the following requires a major version bump after v1.0:

- `SourceProvider` and `RegistryProvider` interfaces.
- Core types: `AssetRef`, `AssetContent`, `SearchHit`, `KitResult`, `AssetPreview`, `KitManifest`, `SourceConfigEntry`.
- Asset ref grammar (`[origin//]type:name`) and install ref grammar (distinct).
- Score range for `SearchHit.score`: `[0, 1]`, higher = better.
- Configuration JSON Schema, including literal-or-env value form and the `writable` flag.
- Error classes, `.code` values, exit codes, hints attached to error classes.
- CLI command surface: `add | remove | list | update | search | show | clone | index | setup | remember | import | feedback | registry *` (plus `info`, `curate`, `workflow`, `vault`, `wiki`, `enable`, `disable`, `completions`, `upgrade`, `save`, `help`, `hints`). Renaming or removing is major.
- Output shape registry is exhaustive. Each command registers `{ shape, textRenderer }` at module load. No silent `JSON.stringify` fallback.
- v2 JSON index schema, owned by `static-index`.
- Index DB is ephemeral; schema-version bumps may wipe and rebuild.

## What NOT To Do

- Do not create new URI schemes for refs
- Do not add parallel scoring systems for different provider types
- Do not make `context-hub` a provider type
- Do not re-introduce `openviking` or any remote-only source provider
- Do not merge registry results into source search hits
- Do not add `search` or `show` methods back to `SourceProvider`
- Do not branch on `source.kind` outside `src/core/write-source.ts`
- Do not allow `writable: true` on `website` / `npm` sources
- Do not skip `bunx biome check --write` before committing
