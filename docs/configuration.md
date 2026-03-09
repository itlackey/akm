# Configuration

Agentikit stores configuration in a platform-standard config directory:

| Platform | Path |
| --- | --- |
| Linux / macOS | `$XDG_CONFIG_HOME/agentikit/config.json` (default `~/.config/agentikit/config.json`) |
| Windows | `%APPDATA%\agentikit\config.json` |

## Managing Config

```sh
akm config                          # Show current config
akm config list                     # List with effective provider defaults
akm config get embedding.provider   # Read a single key
akm config set llm.maxTokens 512    # Set a single key
akm config unset llm.apiKey         # Remove an optional key
```

## Config Reference

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `semanticSearch` | boolean | `true` | Enable semantic vector search |
| `mountedStashDirs` | string[] | `[]` | Additional read-only stash directories |
| `embedding` | object | local provider | Embedding provider settings |
| `llm` | object | disabled | LLM provider for metadata enhancement |
| `registry.installed` | array | `[]` | Installed kit metadata (managed by akm) |

## Embedding Providers

Two backends are supported for generating search embeddings.

### Local (default)

Uses `@xenova/transformers` with the `Xenova/all-MiniLM-L6-v2` model. Runs
on CPU with no external dependencies. Produces 384-dimensional vectors.

### Remote

Any OpenAI-compatible embedding endpoint. Configure with:

```sh
akm config providers embedding       # List available providers
akm config use embedding ollama       # Switch to a provider preset
```

Or set fields directly:

```sh
akm config set embedding.provider ollama
akm config set embedding.model nomic-embed-text
akm config set embedding.dimension 384
```

Or pass a JSON object:

```sh
akm config set embedding '{"endpoint":"http://localhost:11434/v1/embeddings","model":"nomic-embed-text","dimension":384}'
```

To revert to the built-in local provider:

```sh
akm config unset embedding
```

When using a remote provider, `embedding.dimension` must match the index
vector size (384). Built-in presets set this automatically.

## LLM Provider

When configured, the indexer uses an LLM to generate richer descriptions,
intent phrases, and tags during `akm index`.

```sh
akm config providers llm             # List available providers
akm config use llm ollama            # Switch to a provider preset
```

Or set fields directly:

```sh
akm config set llm.provider ollama
akm config set llm.model llama3.2
akm config set llm.temperature 0.3
akm config set llm.maxTokens 512
```

To disable:

```sh
akm config unset llm
```

Both `embedding` and `llm` accept an optional `apiKey` for authenticated
endpoints.

## Using Ollama

[Ollama](https://ollama.com) provides local models with an OpenAI-compatible
API. After installing Ollama:

```sh
# Pull models
ollama pull nomic-embed-text
ollama pull llama3.2

# Configure agentikit
akm config use embedding ollama
akm config set embedding.model nomic-embed-text
akm config set embedding.dimension 384
akm config use llm ollama
akm config set llm.model llama3.2

# Rebuild the index with enhanced metadata
akm index --full
```
