# Configuration

akm stores configuration in a platform-standard config directory:

| Platform | Path |
| --- | --- |
| Linux / macOS | `$XDG_CONFIG_HOME/akm/config.json` (default `~/.config/akm/config.json`) |
| Windows | `%APPDATA%\akm\config.json` |

Override with `AKM_CONFIG_DIR`.

When akm runs inside a project, it also looks for project config files named
`.akm/config.json` in the current directory and each parent directory, then
merges them on top of the user config. Closer project directories win for
scalar/object settings, while project `sources` are appended after user-level
sources. This makes it easy to add project-specific sources without
changing your global config.

For a guided first-run experience, use `akm setup` to choose a stash directory,
configure embeddings/LLM settings, review registries, and add sources.
The wizard saves this file for you, initializes the stash, and builds the
search index.

## Managing Config

```sh
akm config                          # Show current config
akm config list                     # List current config
akm config get embedding            # Read a single key
akm config get output.format        # Read one nested key
akm config set llm '{"endpoint":"...","model":"llama3.2"}'  # Set a key
akm config set output.detail full   # Set one scalar key
akm config set security.installAudit.enabled false
akm config unset llm                # Remove an optional key
```

`akm config set` / `unset` still write the user config in your platform config
directory. Project config files are meant to be edited directly in the project.

## Config Reference

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `semanticSearchMode` | `"off"` \| `"auto"` | `"auto"` | Semantic vector search mode. Legacy boolean values accepted. |
| `embedding` | object | null (local) | Embedding connection settings |
| `llm` | object | null (disabled) | LLM connection for metadata enhancement |
| `output.format` | string | `json` | Default output format (`json`, `text`, `yaml`, `jsonl`) |
| `output.detail` | string | `brief` | Default output detail (`brief`, `normal`, `full`, `summary`, `agent`) |
| `sources` | array | `[]` | Source entries — directories, git repos, websites, npm packages (managed via `akm add/remove`). One entry may set `primary: true` to mark it as the working stash |
| `defaultWriteTarget` | string | — | Name of the source that should receive `akm remember` / `akm import` writes when no `--target` flag is given. Falls back to the working stash (`stashDir`) if unset |
| `writable` | boolean | `false` | Root-level flag controlling whether the primary stash pushes on `akm save` (when a git remote is configured). Per-source `writable` lives inside each `sources[]` entry |
| `stashInheritance` | `"merge"` \| `"replace"` | `"merge"` | How per-project sources compose with global ones. `merge` keeps both; `replace` hides globals when a project-level config is present |
| `registries` | array | official + skills.sh | Configured registries (managed via `akm registry add/remove`) |
| `stashDir` | string | platform default | Path to the working stash created by `akm init` |
| `security.installAudit.enabled` | boolean | `true` | Enable or disable install-time auditing |
| `security.installAudit.blockOnCritical` | boolean | `true` | Block installs when critical findings are detected |
| `security.installAudit.registryAllowlist` | array | `[]` | Allowed registry names or hosts when allowlisting is enabled |
| `security.installAudit.blockUnlistedRegistries` | boolean | `false` | Reject installs from registries not in the allowlist |

> **Legacy `stashes` key:** `sources` was previously named `stashes`. Configs
> that still use `stashes[]` continue to load — the loader migrates the value
> in-memory and emits a one-time deprecation warning. The renamed key is
> persisted on the next `akm config set/unset` write. New configs should use
> `sources[]`.

### Source entry schema

Each entry in `sources[]` is shaped like this:

```jsonc
{
  "name": "team",                  // human-friendly id (auto-derived if omitted)
  "type": "git",                   // one of: filesystem, git, website, npm
  "url": "https://github.com/team/kit",   // required for git/website
  "path": "~/.claude",             // required for filesystem
  "writable": true,                // see "writable" below
  "primary": false,                // optional; one entry may set true
  "options": { "ref": "main" },    // type-specific options
  "wikiName": "research"           // optional: index this source as a wiki
}
```

### `writable`

`writable` is a hint that controls where akm is allowed to write. Defaults
per `type`:

| Type | Default `writable` |
| --- | --- |
| `filesystem` | `true` |
| `git` | `false` (opt in per source if you intend to push back) |
| `website` | `false` (rejected at config load if set to `true`) |
| `npm` | `false` (rejected at config load if set to `true`) |

`website` and `npm` cannot be writable: their `sync()` step would clobber
local edits on the next refresh. To author into a checked-out npm package,
add the same path as a separate `filesystem` source.

### `defaultWriteTarget`

Names the source that receives writes from `akm remember`, `akm import`,
and other write commands when `--target` is omitted. Resolution order:

1. `--target <name>` flag
2. `defaultWriteTarget` config field
3. Working stash (`stashDir`)

If none of those are configured, write commands raise a `ConfigError` that
points at `akm init`.

## Embedding Configuration

Two backends are supported for generating search embeddings.

### Local (default)

When `embedding` is not configured (null), akm uses `@huggingface/transformers`
with the `Xenova/bge-small-en-v1.5` model. Runs on CPU with no external
dependencies. Produces 384-dimensional vectors.

To use a different local model, set `embedding.localModel`:

```sh
akm config set embedding '{"localModel":"Xenova/all-MiniLM-L6-v2"}'
```

The model must be compatible with `@huggingface/transformers` and produce
embeddings at the configured dimension (default 384). Changing the model
requires a full reindex: `akm index --full`.

### Remote

Any OpenAI-compatible embedding endpoint. Configure with a JSON object:

```sh
akm config set embedding '{"endpoint":"http://localhost:11434/v1/embeddings","model":"nomic-embed-text","dimension":384}'
```

If you provide a base URL such as `http://localhost:11434/v1`, akm will
normalize it to `.../v1/embeddings` automatically.

For an OpenAI endpoint:

```sh
akm config set embedding '{"endpoint":"https://api.openai.com/v1/embeddings","model":"text-embedding-3-small","dimension":384}'
```

To revert to the built-in local provider:

```sh
akm config unset embedding
```

When using a remote provider, `dimension` must match the index vector size
(384).

## LLM Configuration

When configured, the indexer uses an LLM to generate richer descriptions,
intent phrases, and tags during `akm index`.

```sh
akm config set llm '{"endpoint":"http://localhost:11434/v1/chat/completions","model":"llama3.2","temperature":0.3,"maxTokens":512}'
```

To disable:

```sh
akm config unset llm
```

Both `embedding` and `llm` accept an optional `apiKey` field, but API keys
should preferably be provided via environment variables `AKM_EMBED_API_KEY`
and `AKM_LLM_API_KEY` rather than stored in the config file.

## Install Security Audit

akm audits managed installs before they are registered. The audit scans code,
metadata, prompts, and install scripts for suspicious patterns such as prompt
injection attempts, remote shell pipes, and risky lifecycle hooks.

```sh
akm config set security.installAudit.enabled true
akm config set security.installAudit.blockOnCritical true
akm config set security.installAudit.registryAllowlist '["npm","github.com"]'
akm config set security.installAudit.blockUnlistedRegistries true
```

Use `security.installAudit.enabled false` to disable the feature completely, or
`security.installAudit.blockOnCritical false` to keep reporting findings without
blocking the install.

To allow a known false positive in user config without disabling the audit,
add an exact finding waiver:

```json
{
  "security": {
    "installAudit": {
      "allowedFindings": [
        {
          "id": "prompt-reveal-hidden-secrets",
          "ref": "github:owner/repo",
          "path": "skills/review/SKILL.md",
          "reason": "Reviewed manually; benign system prompt reference"
        }
      ]
    }
  }
}
```

`allowedFindings` uses exact matching on `id`, and optionally `ref` and `path`,
so waivers stay narrowly scoped.

For one-off installs you trust after manual review, use the CLI flag instead of
persisting a waiver:

```sh
akm add github:owner/private-stash --trust
```

## Using Ollama

[Ollama](https://ollama.com) provides local models with an OpenAI-compatible
API. After installing Ollama:

```sh
# Pull models
ollama pull nomic-embed-text
ollama pull llama3.2

# Configure akm
akm config set embedding '{"endpoint":"http://localhost:11434/v1/embeddings","model":"nomic-embed-text","dimension":384}'
akm config set llm '{"endpoint":"http://localhost:11434/v1/chat/completions","model":"llama3.2","temperature":0.3,"maxTokens":512}'

# Rebuild the index with enhanced metadata
akm index --full
```

## sqlite-vec Extension

akm uses [sqlite-vec](https://github.com/asg017/sqlite-vec) for fast
vector similarity search. When sqlite-vec is not available (common in compiled
binaries on macOS), semantic search falls back to a pure JS implementation
that computes cosine similarity over BLOB-stored embeddings.

The JS fallback works correctly at any scale but becomes noticeably slower
above ~10,000 indexed entries. If you see this warning:

> Semantic search is using JS fallback for N entries. Install sqlite-vec for
> faster performance.

Install the extension to use the optimized path:

```sh
npm install sqlite-vec
# or
bun add sqlite-vec
```

On macOS, the sqlite-vec native extension may not load if the platform binary
is unavailable. Bun uses its own embedded SQLite (not the system one), so
`brew install sqlite` will **not** help. When sqlite-vec cannot load, akm
automatically falls back to a pure-JS cosine similarity search. This fallback
is functionally correct but slower for large indexes (10,000+ entries).

To check whether sqlite-vec is active, run:

```sh
akm info
```

If `searchModes` includes `"semantic"` with `"ready-vec"`, the native extension
is working. If it shows `"ready-js"`, the JS fallback is in use.

