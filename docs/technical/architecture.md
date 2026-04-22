# Architecture

akm (Agent Kit Manager) is a CLI tool for managing AI agent assets: skills, commands, agents, knowledge, workflows, scripts, and memories. This document defines the system's core design decisions. These are final and inviolable.

---

## Stash Provider Types

There are exactly three stash provider types:

| Type | Category | Behavior |
|------|----------|----------|
| **filesystem** | local | Directory on disk. Walker classifies files, indexer writes to FTS5. |
| **git** | local | Any git repository. Cloned to cache, then indexed identically to filesystem. |
| **openviking** | remote | REST API returning pre-scored results. We merge, not index. |

**Local** providers (filesystem, git) are indexed by us into a unified FTS5 index. **Remote** providers (openviking) return their own pre-scored results which compete with local results during merge.

The deciding question for any new provider: "Do we index it, or does it come pre-indexed?"

### Constraints

- **MUST NOT** create a provider types for git repos. Any git-based stash source follows one path: clone, cache, register as filesystem stash, index through FTS5.
- **MUST NOT** create parallel scoring pipelines for local content. All locally-cached content goes through one index.
- **MUST NOT** suppress remote provider scores below local scores. Remote results compete fairly.

---

## Ref Format

Assets are identified by `type:name` refs (e.g., `skill:deploy`, `script:deploy.sh`). This encodes the file path convention (`skills/deploy`, `scripts/deploy.sh`).

Source locators for `akm add` are URLs or shorthands:

| Locator | Example |
|---------|---------|
| GitHub | `github:owner/repo`, `github:owner/repo#v1.2.3` |
| npm | `npm:@scope/pkg`, `@scope/pkg` |
| Git URL | `git+https://gitlab.com/org/kit` |
| Local path | `./path/to/kit` |

Source locators are NOT refs. They identify where to fetch a kit, not how to address an asset.

### Constraints

- **MUST NOT** use URI schemes in user-facing refs. No `viking://`, no `context-hub://`. Provider routing is internal, based on which stash the asset came from, not on a prefix in the ref.
- **MUST NOT** invent new ref formats. `type:name` is the only asset addressing scheme.

---

## Workflow Runtime State

Workflow assets are markdown documents stored under `workflows/`, but workflow
run state is **runtime state**, not derived index data.

- Workflow runs live in a **separate local workflow database**
- Workflow run state **must survive** index rebuilds and index schema resets
- Workflow search/show still uses the same local asset indexing pipeline as all
  other indexed asset types

---

## Search Pipeline

One scoring pipeline for all indexed content:

1. FTS5 multi-column search (name 10x, desc 5x, tags 3x, hints 2x, content 1x)
2. Normalized BM25 scoring (0.3--1.0 base range)
3. Boost signals: exact name match, type relevance, alias match, description relevance, searchHints, quality, utility
4. Optional vector similarity (sqlite-vec) combined with FTS score

Remote providers (openviking) return their own scores. These scores are normalized and merged fairly with local results -- not suppressed, not placed below.

Registry results (installable kits from npm, GitHub, skills.sh) are separated into `registryHits` in the search response. They are never mixed into `hits`.

### Constraints

- **MUST NOT** create separate scoring functions for different provider types. One pipeline scores all indexed content.
- **MUST NOT** merge registry results into the `hits` array. Registry hits are installable kits; stash hits are usable assets. They serve different purposes.
- **MUST NOT** treat any stash provider's results as second-class. If content is indexed locally, it goes through the same pipeline. If it comes pre-scored from a remote provider, its scores compete on equal footing.

---

## Show Routing

`akm show` resolves content through this order:

1. Query the local FTS5 index first
2. Fall back to remote providers if not found locally

Routing is by source metadata (which stash the asset belongs to), not by URI prefix matching. A provider's `canShow()` means "I am available and configured," not "this ref has my prefix."

### Constraints

- **MUST NOT** route show requests by parsing URI prefixes from refs. Refs are `type:name`, period.
- **MUST NOT** require users to know which provider holds an asset. The system resolves this internally.

---

## Utility Scoring

Utility scores are primarily feedback-driven. Usage frequency (search/show events) is a minor additive modifier, not the primary signal. EMA decay is time-proportional -- it decays based on elapsed time, not on how many times the indexer runs.

### Constraints

- **MUST NOT** tie decay rate to indexing frequency. Indexing twice as often must not cause twice as fast decay.
- **MUST NOT** make usage frequency the dominant scoring signal. Feedback is primary.

---

## Module Boundaries

| Module | Responsibility |
|--------|---------------|
| `src/cli.ts` | citty-based CLI, argument parsing, output formatting |
| `src/stash-search.ts` | Search orchestration: local FTS5 + remote provider merge |
| `src/local-search.ts` | FTS5 queries, scoring pipeline, boost computation |
| `src/stash-show.ts` | Asset content retrieval (local first, remote fallback) |
| `src/indexer.ts` | Walks stash dirs, classifies files, builds FTS5 index |
| `src/walker.ts` | Filesystem traversal (`walkStashFlat`) |
| `src/db.ts` | SQLite schema, FTS5 table management |
| `src/asset-spec.ts` | Asset type registry, type directories, `registerAssetType()` |
| `src/config.ts` | User configuration (stash sources, providers, embedding settings) |
| `src/stash-providers/` | Provider implementations (filesystem, git, openviking) |
| `src/providers/` | Registry provider implementations (static-index, skills-sh) |

---

## Tech Stack

- **Runtime:** Bun
- **Language:** TypeScript (strict, ESM)
- **Testing:** bun:test
- **Linting:** Biome
- **CLI framework:** citty
- **Database:** bun:sqlite with FTS5; optional sqlite-vec for vector search
- **Build:** tsc (JS emit only, no declarations)
