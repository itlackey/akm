# Agentikit Concepts

Agentikit is a capability discovery system for AI agents. Instead of searching
files, agents discover capabilities -- tools, skills, commands, agents,
knowledge, and scripts -- through indexed metadata and hybrid search.

## Asset Types

Agentikit organizes capabilities into six asset types, each with its own
storage directory inside the stash:

| Type | Directory | File Pattern | Purpose |
| --- | --- | --- | --- |
| tool | `tools/` | `.sh`, `.ts`, `.js`, `.ps1`, `.cmd`, `.bat` | Executable scripts with generated run commands |
| skill | `skills/` | Directory containing `SKILL.md` | Structured skill packages (name derived from path) |
| command | `commands/` | `.md` files | Slash commands with frontmatter |
| agent | `agents/` | `.md` files | Agent definitions with model hints |
| knowledge | `knowledge/` | `.md` files | Reference documents with section navigation |
| script | `scripts/` | `.sh`, `.ts`, `.js`, `.py`, `.rb`, `.go`, `.pl`, `.php`, `.lua`, `.r`, `.swift`, `.kt`, etc. | Broad script collection across languages |

Each type has a dedicated handler that controls file detection, canonical
naming, metadata extraction, search enrichment, and show formatting.

## Stash Sources

Assets are resolved from three sources in priority order:

1. **Working stash** (read-write) -- The user's main stash directory
   (`AKM_STASH_DIR` or `~/agentikit`). This is where `akm init` creates the
   directory structure and where `akm clone` copies assets into.

2. **Mounted stash dirs** (read-only) -- Additional stash directories listed in
   `config.mountedStashDirs`. Useful for sharing assets across teams or
   projects.

3. **Installed packages** (read-only) -- Registry packages installed via
   `akm add`. Stored in the cache directory and tracked in
   `config.registry.installed`.

Search and show operations check sources in this order. The first match wins.

## Metadata System

### `.stash.json` Sidecar Files

Each asset type directory can contain a `.stash.json` file describing its
capabilities. This is the core metadata format:

```json
{
  "entries": [
    {
      "name": "git-diff-summarizer",
      "type": "tool",
      "description": "Summarize git commit changes",
      "tags": ["git", "diff", "commit"],
      "intents": [
        "summarize git commits",
        "explain what changed in a repository"
      ],
      "usage": ["Pass a commit range as the first argument"],
      "entry": "run.ts",
      "quality": "curated",
      "source": "manual",
      "confidence": 1.0
    }
  ]
}
```

See [filesystem.md](filesystem.md) for the full field reference.

### Automatic Metadata Generation

When no `.stash.json` exists, the indexer generates one from available signals,
in priority order:

1. **`package.json`** -- `description` and `keywords` fields (confidence 0.8)
2. **Frontmatter** -- YAML `description` in `.md` files (confidence 0.9)
3. **Code comments** -- JSDoc blocks (`/** ... */`) and hash comments (`# ...`)
   extracted by type-specific handlers (confidence 0.7)
4. **Filename heuristics** -- Converts `docker-build.ts` to `"docker build"`
   (confidence 0.55)

Generated metadata is written to `.stash.json` automatically. Edit the file
and set `quality` to `"curated"` to prevent regeneration.

### LLM Enhancement

When an LLM provider is configured (`config.llm`), the indexer can enhance
auto-generated metadata by:

- Improving descriptions with file content context
- Generating 3-6 natural language intent phrases
- Suggesting relevant tags

This runs against an OpenAI-compatible chat endpoint with low temperature
(0.3) for consistency. Enhancement is optional and degrades gracefully.

## Search Architecture

Search uses a hybrid approach combining lexical and semantic ranking.

### Indexed Search (primary)

When an index exists (`~/.cache/agentikit/index.db`), search runs two
strategies in parallel:

1. **FTS5 (lexical)** -- SQLite full-text search with Porter stemming. Matches
   against a combined search text built from name, description, tags, intents,
   examples, and aliases.

2. **Semantic (vector)** -- Cosine similarity between query embedding and stored
   entry embeddings via sqlite-vec (384 dimensions). Requires an embedding
   provider.

Scores are blended: **70% semantic + 30% FTS5** when both are available.

Quality boosts are then applied:

| Boost | Value |
| --- | --- |
| Tag exact match | +0.15 |
| Intent token match | +0.12 |
| Name token match | +0.10 |
| Curated metadata | +0.05 |
| Confidence score | up to +0.05 |

### Substring Fallback

When no index is available, search falls back to scanning the stash directory
and filtering by substring match. This ensures search always works, even
before `akm index` has been run.

### Registry Search

Search can also query the external registry API (`--source registry` or
`--source both`). Registry results are merged with local results in
alternating order.

### Explainability

Each search hit includes a `whyMatched` field explaining which signals
contributed to its ranking (e.g., "fts bm25 relevance", "matched name
tokens", "semantic similarity").

## Indexing

The indexer (`akm index`) builds the search database:

- **Incremental by default** -- Tracks file modification times and
  `.stash.json` changes. Only re-processes directories that have changed.
- **Full rebuild** -- Use `--full` to wipe and rebuild the entire index.
- **Database schema** -- SQLite with three tables: `entries` (main data),
  `entries_fts` (FTS5 virtual table), `entries_vec` (vector table).

The indexing pipeline:

```text
Walk stash directories
        |
        v
Load or generate .stash.json
        |
        v
Build search text for FTS5
        |
        v
Generate embeddings (if provider configured)
        |
        v
Upsert into SQLite index
```

## Tool Execution

For tool and script assets, agentikit generates execution metadata:

| Extension | Runtime | Example `runCmd` |
| --- | --- | --- |
| `.sh` | bash | `cd "/path/to/tools" && bash "/path/to/deploy.sh"` |
| `.ts`, `.js` | bun | `cd "/path/to/tools" && bun "/path/to/run.ts"` |
| `.ps1` | powershell | `powershell -ExecutionPolicy Bypass -File ...` |
| `.cmd`, `.bat` | cmd | `cmd /c ...` |

When a `package.json` is found in the tool's directory tree (up to the type
root), the working directory is set to that package root. If
`AGENTIKIT_BUN_INSTALL` is set, `bun install` runs before execution.

## Show Command

`akm show <type:name>` displays asset details through type-specific handlers:

- **Tools/Scripts** -- Returns `runCmd` and `kind` for execution
- **Commands** -- Returns parsed template and frontmatter description
- **Agents** -- Returns prompt content and model hint
- **Knowledge** -- Supports view modes:
  - `full` -- Entire document (default)
  - `toc` -- Table of contents with line counts
  - `section <heading>` -- Extract a specific section
  - `lines <start> <end>` -- Extract a line range
  - `frontmatter` -- YAML frontmatter only

## Registry & Package Management

Agentikit supports installing asset packages from external sources:

| Source | Example ref |
| --- | --- |
| npm | `npm:@scope/package` |
| GitHub | `github:owner/repo#tag` |
| Local git | Path to a local git directory |

Packages are resolved, downloaded to the cache directory, and registered in
config. The `agentikit.include` field in a package's `package.json` controls
which files are included.

CLI commands for package management:

- `akm add <ref>` -- Install a package
- `akm list` -- Show installed packages with status
- `akm update` -- Update packages to latest versions
- `akm remove <id>` -- Remove an installed package
- `akm reinstall` -- Reinstall from existing refs

## Cloning

`akm clone <type:name>` copies an asset from any source (mounted or installed)
into the working stash for local editing. Supports `--name` for renaming and
`--force` for overwriting existing assets. Skills (directories) are copied
recursively; other types copy a single file.

## Embedding Providers

Two embedding backends are supported:

1. **Local (default)** -- `@xenova/transformers` with the
   `Xenova/all-MiniLM-L6-v2` model. Runs on CPU, no GPU or external API
   required. Produces 384-dimensional vectors.

2. **Remote** -- Any OpenAI-compatible embedding endpoint. Configured via
   `config.embedding` with `baseUrl`, `model`, `apiKey`, and optional
   `dimensions`.

When no provider is available, semantic search is skipped and search falls
back to FTS5-only ranking.

## Configuration

Configuration lives outside the stash directory at
`~/.config/agentikit/config.json` (see [filesystem.md](filesystem.md) for
platform-specific paths).

Key settings:

| Key | Default | Purpose |
| --- | --- | --- |
| `semanticSearch` | `true` | Enable vector-based semantic search |
| `mountedStashDirs` | `[]` | Additional read-only stash directories |
| `embedding` | -- | OpenAI-compatible embedding provider config |
| `llm` | -- | OpenAI-compatible LLM provider config |
| `registry.installed` | `[]` | Installed package metadata |

Manage via `akm config get <key>`, `akm config set <key> <value>`, or
`akm config list`.
