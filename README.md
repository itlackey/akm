# Agent-i-Kit

A CLI tool and library for managing a stash of assets for AI coding assistants. It lets you **search** and **show** tools, skills, commands, and agents from a stash directory.

The CLI is called **akm** (Agent Kit Manager).

## Installation

### npm / bun

```sh
npm install -g agentikit
# or
bun add -g agentikit
```

### Standalone binary

Use the install scripts for a copy/paste install:

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash
# pin a release tag)
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash -s -- v1.2.3

# PowerShell (Windows)
irm https://raw.githubusercontent.com/itlackey/agentikit/main/install.ps1 -OutFile install.ps1; ./install.ps1
```

The shell installer verifies the downloaded binary against release `checksums.txt` before installing it.

## Stash model

Set a stash path via `AGENTIKIT_STASH_DIR`, or run `akm init` to create one automatically.

```sh
export AGENTIKIT_STASH_DIR=/abs/path/to/your-stash
```

Expected stash layout:

```
$AGENTIKIT_STASH_DIR/
├── tools/      # recursive files (.sh, .ts, .js, .ps1, .cmd, .bat)
├── skills/     # skill directories containing SKILL.md
├── commands/   # markdown files
├── agents/     # markdown files
└── knowledge/  # markdown files
```

## CLI usage

```sh
akm init                 # Initialize stash directory and set AGENTIKIT_STASH_DIR
akm index [--full]       # Build search index (incremental by default)
akm add <ref>            # Install a registry kit by npm/GitHub ref
akm list                 # List installed registry kits from config.registry.installed
akm remove <target>      # Remove installed kit by id/ref (or parsed ref id)
akm update [target] [--all]     # Fresh install from current ref(s), report changed revision/version
akm reinstall [target] [--all]  # Reinstall from stored refs
akm search [query]       # Search local stash and/or registry
akm show <type:name>     # Read a stash asset by ref
```

### add

Install a registry reference and make it searchable immediately.

```sh
akm add @scope/kit
akm add npm:@scope/kit@latest
akm add owner/repo
akm add github:owner/repo#v1.2.3
```

- Uses registry resolution + install helpers (`npm` and `github` refs)
- Updates `config.json` registry install records and syncs `additionalStashDirs`
- If an existing install with the same id is replaced, old cache directories are cleaned up (best effort)
- Triggers an incremental index build
- Returns JSON with install details and index stats

### list

Show installed entries from `config.registry.installed`.

- Source of truth is config, not cache directory discovery
- Each entry includes status flags:
  - `status.cacheDirExists`
  - `status.stashRootExists`

### remove

Remove a single installed entry and reindex incrementally.

```sh
akm remove npm:@scope/kit
akm remove github:owner/repo
akm remove owner/repo
```

- Target resolution order: exact `id`, exact stored `ref`, then parsed ref `id`
- Removes entry via config helper (also syncs `additionalStashDirs`)
- Deletes prior `cacheDir` best effort
- Runs one incremental reindex

### reinstall

Reinstall one entry or all entries from stored refs.

```sh
akm reinstall npm:@scope/kit
akm reinstall --all
```

- Uses the same registry install flow as `akm add`
- Upserts config entries + `additionalStashDirs`
- Cleans up replaced cache directories best effort
- Runs one incremental reindex after all installs

### update

Update one entry or all entries by doing a fresh resolve/install from each current ref.

```sh
akm update npm:@scope/kit
akm update --all
```

- Same target selection rules as `reinstall`
- Floating refs (for example `@latest` or default branch) resolve to newest available artifact
- Reports per-entry change flags for version/revision (`changed.version`, `changed.revision`, `changed.any`)
- Runs one incremental reindex after all installs

### search

Search local stash assets, registry entries, or both.

```sh
akm search "deploy" --type tool --limit 10 --usage both
akm search "lint" --source registry
akm search "docker" --source both
```

- `query`: case-insensitive substring over stable names (relative paths)
- `--type`: `tool | skill | command | agent | knowledge | any` (default: `any`)
- `--limit`: defaults to `20`
- `--usage`: `none | both | item | guide` (default: `both`)
- `--source`: `local | registry | both` (default: `local`)

By default (`--source local`), results are the existing stash hits with `openRef`, score/explainability details (`score`, `whyMatched`), and, for tools, execution-ready `runCmd`.

When registry results are included (`--source registry|both`), each registry hit includes explicit install guidance:

- `installRef` (normalized ref for install)
- `installCmd` (ready-to-run command, e.g. `akm add npm:@scope/kit`)

- `usageGuide` is included by default (`--usage both`) and explains how to use each hit type.
- Per-hit `usage` is optional metadata from `.stash.json` and is included when present.

### show

Show a hit using `openRef` from search results.

```sh
akm show skill:code-review
akm show knowledge:guide.md --view toc
akm show knowledge:guide.md --view section --heading "Getting Started"
akm show knowledge:guide.md --view lines --start 10 --end 30
```

Returns full payload by type:

- `skill` — full `SKILL.md` content
- `command` — full markdown body as `template` (+ best-effort `description`)
- `agent` — full markdown body as `prompt` (+ best-effort `description`, `toolPolicy`, `modelHint`)
- `tool` — `runCmd`/`kind` (the agent uses the host's shell to execute `runCmd`)
- `knowledge` — content with optional view modes (`full`, `toc`, `frontmatter`, `section`, `lines`)

## Library API

Agentikit also exports its core functions for use as a library:

```ts
import {
  agentikitAdd,
  agentikitList,
  agentikitRemove,
  agentikitReinstall,
  agentikitUpdate,
  agentikitSearch,
  agentikitShow,
  agentikitInit,
  agentikitIndex,
} from "agentikit"
```

- `agentikitAdd({ ref })` — install a registry reference and index it
- `agentikitList()` — list installed registry entries and filesystem status flags
- `agentikitRemove({ target })` — remove one installed entry and reindex incrementally
- `agentikitReinstall({ target? , all? })` — reinstall one/all installed entries
- `agentikitUpdate({ target? , all? })` — fresh resolve/install one/all installed entries with change reporting
- `agentikitSearch({ query, type?, limit?, usage?, source? })` — search local stash and/or registry
- `agentikitShow({ ref, view? })` — show a stash asset
- `agentikitInit()` — initialize stash directory
- `agentikitIndex()` — build/rebuild search index

## Configuration

Agentikit stores configuration in `config.json` inside the stash directory.

```sh
akm config                    # Show current config
akm config --set key=value    # Update a config key
```

### Embedding connection

By default, agentikit uses the local `@xenova/transformers` library for embeddings. You can configure an OpenAI-compatible embedding endpoint instead:

```sh
akm config --set 'embedding={"endpoint":"http://localhost:11434/v1/embeddings","model":"nomic-embed-text"}'
```

To clear the custom embedding config and revert to local embeddings:

```sh
akm config --set 'embedding=null'
```

### LLM connection

When configured, agentikit uses an OpenAI-compatible LLM to generate richer metadata (descriptions, intents, tags) during indexing:

```sh
akm config --set 'llm={"endpoint":"http://localhost:11434/v1/chat/completions","model":"llama3.2"}'
```

To clear:

```sh
akm config --set 'llm=null'
```

### Using a local Ollama instance

[Ollama](https://ollama.com) provides local models with an OpenAI-compatible API. After installing Ollama and pulling your models:

```sh
# Pull models
ollama pull nomic-embed-text
ollama pull llama3.2

# Configure agentikit to use Ollama for both embeddings and metadata generation
akm config --set 'embedding={"endpoint":"http://localhost:11434/v1/embeddings","model":"nomic-embed-text"}'
akm config --set 'llm={"endpoint":"http://localhost:11434/v1/chat/completions","model":"llama3.2"}'

# Rebuild the index — embeddings use Ollama, metadata is LLM-enhanced
akm index --full
```

Both `embedding` and `llm` accept an optional `apiKey` field for authenticated endpoints:

```json
{
  "endpoint": "https://api.openai.com/v1/embeddings",
  "model": "text-embedding-3-small",
  "apiKey": "sk-..."
}
```

### Config reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `semanticSearch` | `boolean` | `true` | Enable semantic search ranking |
| `additionalStashDirs` | `string[]` | `[]` | Extra stash directories to search |
| `embedding` | `object` | not set | OpenAI-compatible embedding endpoint (`endpoint`, `model`, `apiKey?`) |
| `llm` | `object` | not set | OpenAI-compatible LLM endpoint (`endpoint`, `model`, `apiKey?`) |

## Notes

- `akm add` installs registry kits into the local cache and adds discovered stash roots to `additionalStashDirs`.
- Registry lifecycle commands (`list`, `remove`, `reinstall`, `update`) use `config.registry.installed` as the source of truth.
- When commands fail, CLI errors are returned as structured JSON with `error` and `hint` fields.
- Missing or unreadable stash paths return friendly errors.
