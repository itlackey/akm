# Architecture

akm is a Bun-based CLI for discovering and using agent assets from local
filesystem sources, cache-backed sources (git, website, npm), and registry
catalogs.

This document is the operating summary of the v1 architecture. The full design
contract lives in `docs/technical/v1-architecture-spec.md`.

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

Each type maps to a canonical source directory through `src/core/asset-spec.ts`
(`skills/`, `commands/`, `agents/`, `knowledge/`, `workflows/`, `scripts/`,
`memories/`, `vaults/`, `wikis/`).

---

## Sources and Source Providers

A **source** is a directory plus a way to refresh it from upstream. There are
exactly two source provider types in v1:

- `filesystem` — a local path the user owns
- `git` — a git working tree mirrored under akm's cache

Two additional cache-backed kinds materialise files into the cache before
indexing:

- `website` — recrawled and converted to markdown
- `npm` — installed into the cache

All four kinds expose the same minimal `SourceProvider` interface
(`src/sources/source-provider.ts`):

```ts
interface SourceProvider {
  readonly name: string;
  readonly kind: string;            // "filesystem" | "git" | "website" | "npm"
  init(ctx: ProviderContext): Promise<void>;
  path(): string;                   // directory the indexer walks
  sync?(): Promise<void>;           // refresh from upstream (no-op for filesystem)
}
```

Providers do **not** implement `search`, `show`, `canShow`, or any read method.
The indexer walks `path()`, classifies files, and answers all queries from the
local FTS5 index.

The legacy `LiveStashProvider` / `SyncableStashProvider` split is gone, as is
any "remote-only" provider tier. API-backed sources (mem0, Notion, etc.) are
deferred to a separate `QuerySource` tier post-v1.

### Cache-backed sources are still indexed locally

`git`, `website`, and `npm` all materialise files into a cache directory under
`$XDG_CACHE_HOME/akm/`. Once mirrored, they participate in the same local
indexing pipeline as filesystem sources. There is no parallel scoring system
for "remote" content.

---

## Refs

User-facing asset refs are flat:

```text
[origin//]type:name
```

- `type:name` is the canonical asset identity
- optional `origin//` narrows lookup to a configured source
- refs are parsed by `parseAssetRef` in `src/core/asset-ref.ts`
- markdown-backed asset types strip `.md` from canonical names

Examples:

- `skill:code-review`
- `workflow:release/train`
- `team//command:deploy`

URI schemes (`viking://...`, `github://...`) are **not** asset refs. Install
locators like `github:owner/repo`, `git+https://...`, `npm:@scope/pkg`,
`skills.sh:slug`, and `./local/path` are a separate grammar parsed by
`parseRegistryRef` in `src/registry/registry-resolve.ts` and consumed by
`akm add` / `akm clone`.

---

## Search Pipeline

There is **one** scoring pipeline for all indexed content:

1. multi-column FTS5 search
2. BM25 normalization
3. optional semantic / vector scoring
4. metadata, type, and utility boosts

Indexed field weighting:

- `name` ×10
- `description` ×5
- `tags` ×3
- `hints` ×2
- `content` ×1

Notes:

- `hints` includes `searchHints`, `examples`, `usage`, intent fields, wiki
  cross-references, and page-kind hints
- `content` is primarily TOC headings plus parameter names/descriptions
- registry results live in `registryHits`, never in `hits`
- `--source both` keeps registry results in `registryHits` — they are not
  rank-merged with source hits

`akm search` is implemented in `src/commands/search.ts` and queries the
indexer's local search (`src/indexer/db-search.ts`). Provider fan-out is gone.

---

## Show Resolution

`akm show` queries the local FTS5 index, then reads the file from disk.

Local show flow (`src/commands/show.ts`):

1. parse `[origin//]type:name`
2. `lookup(ref)` against the FTS5 index (`src/indexer/indexer.ts`)
3. fall back to on-disk type-dir traversal only when the index has no row
   (covers the "indexed yet?" gap before `akm index` runs)
4. classify the file and render a response

There is **no remote provider fallback**. Show is local FTS5 only.

Special case: `wiki:<name>` with no page path returns the wiki root summary
payload rather than a single markdown page response.

---

## Writing to Sources

Writes go through one helper: `src/core/write-source.ts`. This is the only
place in the codebase that branches on `source.kind`.

```ts
writeAssetToSource(source, config, ref, content)
deleteAssetFromSource(source, config, ref)
```

The flow:

1. Refuse if the source is not `writable`.
2. Plain filesystem write to `path.join(source.path, …)`.
3. For `kind === "git"`, run `git add` + `git commit` (and `git push` when
   `options.pushOnCommit` is set).

`writable` is a config flag, not an interface concern. Defaults: `true` for
`filesystem`, `false` for everything else. `writable: true` on `website` or
`npm` is rejected at config load — `sync()` would clobber edits on the next
refresh.

Write-target resolution (`resolveWriteTarget`) follows: explicit `--target` →
`config.defaultWriteTarget` → working stash (`config.stashDir`) → `ConfigError`.

---

## Registry Providers

Registry providers are read-only catalogs of installable kits. The interface
lives in `src/registry/registry-providers/types.ts`:

```ts
interface RegistryProvider {
  readonly type: string;            // "static-index" | "skills-sh"
  search(options): Promise<RegistryProviderResult>;
  searchKits(q): Promise<KitResult[]>;
  searchAssets?(q): Promise<AssetPreview[]>;
  getKit(id): Promise<KitManifest | null>;
  canHandle(ref: ParsedRegistryRef): boolean;
}
```

Built-in registries:

| Kind | Role |
| --- | --- |
| `static-index` | Reads the v2 JSON index schema (official akm registry, team mirrors). |
| `skills-sh` | Wraps the skills.sh REST API. |

Context Hub is **not** a registry provider type. It is just a recommended git
kit installable through the official static-index registry like any other
source.

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

## Errors

`ConfigError`, `UsageError`, and `NotFoundError` (in `src/core/errors.ts`) each
carry a stable `code` and a `hint(): string | undefined` method. The CLI
surfaces hints by calling `error.hint()` directly — there is no regex chain
parsing error messages.

| Class | Default exit code |
| --- | --- |
| `ConfigError` | 78 |
| `UsageError` | 2 |
| `NotFoundError` | 1 |

---

## Module Boundaries

| Module | Responsibility |
| --- | --- |
| `src/cli.ts` | command parsing, output shaping, user-facing help |
| `src/core/asset-spec.ts` | asset type registry and canonical source directories |
| `src/core/asset-ref.ts` | asset ref parsing and normalization |
| `src/core/config.ts` | config loading, validation, env resolution |
| `src/core/errors.ts` | error classes with stable codes and hints |
| `src/core/write-source.ts` | the single write helper (branches on `source.kind`) |
| `src/sources/source-provider.ts` | minimal `SourceProvider` interface |
| `src/sources/source-providers/` | filesystem / git / website / npm implementations |
| `src/sources/source-resolve.ts` | filesystem path resolution for refs |
| `src/indexer/indexer.ts` | walking, metadata generation, index rebuilds, embeddings, utility recompute |
| `src/indexer/walker.ts` | flat directory walker |
| `src/indexer/matchers.ts` | file classification rules |
| `src/indexer/file-context.ts` | matcher/renderer pipeline plumbing |
| `src/indexer/search-fields.ts` | FTS field extraction |
| `src/indexer/db-search.ts` | local FTS/vector search and reranking |
| `src/indexer/search-source.ts` | source resolution, cache materialisation, editability |
| `src/commands/search.ts` | `akm search` orchestration |
| `src/commands/show.ts` | `akm show` orchestration |
| `src/registry/registry-providers/` | registry provider implementations (static-index, skills-sh) |
| `src/output/renderers.ts` | search/show shaping per asset type |
| `src/workflows/workflow-runs.ts` | workflow run persistence |

---

## Tech Stack

- Runtime: Bun
- Language: TypeScript (ESM, strict)
- Database: `bun:sqlite` with FTS5 and optional `sqlite-vec`
- Testing: `bun:test`
- Formatting/linting: Biome
