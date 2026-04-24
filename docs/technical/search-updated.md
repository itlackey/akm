# Search Implementation Notes

This is the short, implementation-focused companion to `search.md`.

## Source Routing

`akm search` supports:

- `stash`
- `registry`
- `both`

Behavior:

- `stash` searches indexed/local stash sources plus remote stash providers
- `registry` searches registries only
- `both` runs both paths, but stash hits and registry hits remain separate in
  the response

## Result Sets

The JSON response shape is:

```json
{
  "hits": [],
  "registryHits": []
}
```

`registryHits` are **not** rank-merged into `hits`.

## What Counts as a Local Stash Source

The local indexed path includes more than the primary working stash:

- primary stash
- configured filesystem stashes
- installed stash stash roots
- cache-backed git mirrors
- cache-backed website mirrors

Git-backed stash sources are indexed locally after mirroring; they are not
merged as a separate remote provider result stream.

## Scoring

For indexed stash hits:

- FTS is primary
- vector similarity is optional
- boosts apply afterward

OpenViking provider hits keep their source scores and compete fairly with local
stash hits.

## Output Shaping

Search output is shaped in `src/cli.ts`:

- `brief` stash hits: `type`, `name`, `action`, `estimatedTokens`
- `normal` stash hits: adds `description` and `score`
- `full` stash hits: full hit object
- `for-agent`: keeps `name`, `ref`, `type`, `description`, `action`, `score`, `estimatedTokens`

Registry hits use a smaller shape and still stay under `registryHits`.

## Index Trust

The indexed path is trusted only when the stored `stashDirs` metadata still
matches the active resolved stash directories, not just the primary stash path.
