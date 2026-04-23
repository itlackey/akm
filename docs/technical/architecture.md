# Architecture

akm is a Bun-based CLI for discovering and using agent assets from local stashes,
cache-backed sources, and registries.

---

## Asset Types

Built-in asset types are:

- `skill`
- `command`
- `agent`
- `knowledge`
- `workflow`
- `script`
- `memory`
- `vault`
- `wiki`

Each type maps to a canonical stash directory through `src/asset-spec.ts`
(`skills/`, `commands/`, `agents/`, `knowledge/`, `workflows/`, `scripts/`,
`memories/`, `vaults/`, `wikis/`).

---

## Stash Sources and Provider Reality

Current source handling has two layers:

1. **Indexed local sources** resolved by `resolveStashSources()`:
   - primary working stash
   - extra filesystem stashes
   - installed kit stash roots
   - cache-backed git sources
   - cache-backed website snapshots
2. **Remote show/search providers**:
   - OpenViking remains the main remote pre-scored provider

Important implementation details:

- Git-backed stash entries use canonical type `git`
- Legacy stash types `context-hub` and `github` are still accepted as aliases
  for git-backed mirrors
- Website sources are mirrored into cache and then indexed locally like any
  other stash source
- Filesystem, git mirrors, website mirrors, and installed kits all compete
  through the same local indexing pipeline once resolved to directories

---

## Ref Format

Refs are parsed and emitted in wire format:

```text
[origin//]type:name
```

- `type:name` is the canonical asset identity
- optional `origin//` narrows lookup to a specific installed or named source
- refs are normalized through `src/stash-ref.ts`
- markdown-backed asset types strip `.md` from canonical names

Examples:

- `skill:code-review`
- `workflow:release/train`
- `npm:@scope/pkg//command:deploy`

---

## Search Pipeline

Local indexed content shares one scoring pipeline:

1. multi-column FTS5 search
2. BM25 normalization
3. optional semantic/vector scoring
4. metadata and utility boosts

Indexed field weighting is:

- `name` ×10
- `description` ×5
- `tags` ×3
- `hints` ×2
- `content` ×1

Implementation notes:

- `hints` includes `searchHints`, `examples`, `usage`, intent fields, wiki
  cross-references, and page-kind hints
- `content` is primarily TOC headings plus parameter names/descriptions
- remote registry results are returned separately in `registryHits`
- `--source both` does not flatten registry results into stash `hits`
- OpenViking scores are preserved and merged fairly with stash hits

---

## Show Resolution

`akm show` does **not** resolve local assets through the FTS index.

Local show flow:

1. parse `[origin//]type:name`
2. resolve candidate stash sources by origin
3. resolve the asset path from the filesystem layout
4. classify the file and render a response

If local lookup fails with `NotFoundError`, akm falls back to remote providers
that support `show()`.

Special case:

- `wiki:<name>` with no page path returns the wiki root summary payload rather
  than a single markdown page response

---

## Workflow Runtime State

Workflow definitions live in `workflows/`, but workflow run state is separate
runtime state stored in `workflow.db`.

- workflow discovery and search use the shared asset index
- workflow run records survive index rebuilds
- workflow run state is not derived from the FTS index

---

## Utility Scoring

Utility is feedback-driven and rebuilt from `usage_events`.

- usage history is preserved across schema resets and full rebuilds
- detached events are re-linked to fresh entry ids by ref
- decay is time-proportional, not tied to index frequency

---

## Module Boundaries

| Module | Responsibility |
| --- | --- |
| `src/cli.ts` | command parsing, output shaping, user-facing help |
| `src/asset-spec.ts` | asset type registry and canonical stash directories |
| `src/matchers.ts` | file classification rules |
| `src/renderers.ts` | search/show shaping per asset type |
| `src/search-source.ts` | stash source resolution, cache-backed source discovery, editability |
| `src/indexer.ts` | walking, metadata generation, index rebuilds, embeddings, utility recompute |
| `src/search-fields.ts` | FTS field extraction |
| `src/local-search.ts` | local FTS/vector search and reranking |
| `src/stash-search.ts` | local/provider/registry orchestration |
| `src/stash-ref.ts` | ref parsing and normalization |
| `src/stash-resolve.ts` | filesystem path resolution for refs |
| `src/stash-show.ts` | local-first show with remote fallback |
| `src/workflow-runs.ts` | workflow run persistence |
| `src/stash-providers/` | stash source/provider implementations (`filesystem`, `git`, `openviking`, `website`) |
| `src/providers/` | registry providers such as static index and skills.sh |

---

## Tech Stack

- Runtime: Bun
- Language: TypeScript (ESM, strict)
- Database: `bun:sqlite` with FTS5 and optional `sqlite-vec`
- Testing: `bun:test`
- Formatting/linting: Biome
