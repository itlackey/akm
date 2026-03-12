# Configuration

akm stores configuration in a platform-standard config directory:

| Platform | Path |
| --- | --- |
| Linux / macOS | `$XDG_CONFIG_HOME/akm/config.json` (default `~/.config/akm/config.json`) |
| Windows | `%APPDATA%\akm\config.json` |

Override with `AKM_CONFIG_DIR`.

## Managing Config

```sh
akm config                          # Show current config
akm config list                     # List current config
akm config get embedding            # Read a single key
akm config get output.format        # Read one nested key
akm config set llm '{"endpoint":"...","model":"llama3.2"}'  # Set a key
akm config set output.detail full   # Set one scalar key
akm config unset llm                # Remove an optional key
```

## Config Reference

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `semanticSearch` | boolean | `true` | Enable semantic vector search |
| `searchPaths` | string[] | `[]` | Additional stash directories to search |
| `embedding` | object | null (local) | Embedding connection settings |
| `llm` | object | null (disabled) | LLM connection for metadata enhancement |
| `output.format` | string | `json` | Default output format (`json`, `text`, `yaml`) |
| `output.detail` | string | `brief` | Default output detail (`brief`, `normal`, `full`) |
| `stashDir` | string | platform default | Path to the stash directory |
| `registries` | array | official registry | Configured registries (managed via `akm registry add/remove`) |
| `installed` | array | `[]` | Installed kit metadata (managed by akm) |

## Embedding Configuration

Two backends are supported for generating search embeddings.

### Local (default)

When `embedding` is not configured (null), akm uses `@xenova/transformers`
with the `Xenova/all-MiniLM-L6-v2` model. Runs on CPU with no external
dependencies. Produces 384-dimensional vectors.

### Remote

Any OpenAI-compatible embedding endpoint. Configure with a JSON object:

```sh
akm config set embedding '{"endpoint":"http://localhost:11434/v1/embeddings","model":"nomic-embed-text","dimension":384}'
```

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

On macOS, Apple's built-in SQLite disables extension loading. If you installed
akm as a compiled binary, you may need to install a full SQLite build
(e.g. via Homebrew) and point Bun to it:

```sh
brew install sqlite
```

After installing, rebuild your index to verify:

```sh
akm index --full
```
