# agentikit

Agentikit is a CLI tool and library for managing a stash of extension assets for AI coding assistants. It lets you **search** and **show** tools, skills, commands, and agents from a stash directory.

The CLI is called **akm** (Agentikit Manager).

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
akm search [query]       # Search the stash
akm show <type:name>     # Read a stash asset by ref
```

### search

Search the stash for extension assets.

```sh
akm search "deploy" --type tool --limit 10 --usage both
```

- `query`: case-insensitive substring over stable names (relative paths)
- `--type`: `tool | skill | command | agent | knowledge | any` (default: `any`)
- `--limit`: defaults to `20`
- `--usage`: `none | both | item | guide` (default: `both`)

Returns typed hits with `openRef`, score/explainability details (`score`, `whyMatched`), and, for tools, execution-ready `runCmd`.

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
import { agentikitSearch, agentikitShow, agentikitInit, agentikitIndex } from "agentikit"
```

- `agentikitSearch({ query, type?, limit?, usage? })` — search the stash
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

- Agentikit does not install or copy kit files.
- Missing or unreadable stash paths return friendly errors.
