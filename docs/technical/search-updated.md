# Search Implementation Notes

This is the short, implementation-focused companion to `search.md`.

## Source Routing

`akm search` supports `--source`:

- `stash` (alias `local`) — search the local FTS5 index only (default)
- `registry` — search registries only
- `both` — run both paths; results stay in separate response fields

The orchestration lives in `src/commands/search.ts`. `akmSearch` calls
`searchLocal` (`src/indexer/db-search.ts`) for source results and
`searchRegistry` (`src/commands/registry-search.ts`) for registry results.

## Result Sets

The JSON response shape is:

```json
{
  "hits": [],
  "registryHits": []
}
```

`registryHits` are **not** rank-merged into `hits`.

## What Counts as a Source

The indexed path covers every configured source, materialised to disk:

- `filesystem` sources (including the working stash created by `akm init`)
- `git` sources (cloned/pulled into cache)
- `website` sources (recrawled into cache)
- `npm` sources (installed into cache)

All four kinds are walked by the indexer through their `path()` method. There
is no separate "remote" provider tier — providers do not implement `search()`.

## Scoring

For indexed source hits:

- FTS5 BM25 is primary
- vector similarity is optional (and combined with weighted addition)
- multiplicative boosts apply afterward

There is one scoring pipeline for all source kinds. See `search.md` for the
full boost table and worked examples.

## Output Shaping

Search output is shaped in `src/cli.ts`:

- `brief` source hits: `type`, `name`, `action`, `estimatedTokens`
- `normal` source hits: adds `description` and `score`
- `full` source hits: full hit object
- `agent` (preferred since 0.6.0; `--for-agent` is the deprecated alias):
  keeps `name`, `ref`, `type`, `description`, `action`, `score`,
  `estimatedTokens`

Registry hits use a smaller shape and stay under `registryHits`.

## Index Trust

The indexed path is trusted only when the stored `stashDirs` metadata still
matches the active resolved source directories, not just the primary stash
path.
