# Configuration

akm stores configuration in a platform-standard config directory:

| Platform | Path |
| --- | --- |
| Linux / macOS | `$XDG_CONFIG_HOME/akm/config.json` (default `~/.config/akm/config.json`) |
| Windows | `%APPDATA%\akm\config.json` |

Override with `AKM_CONFIG_DIR`.

> All configuration keys documented below are accepted by the current
> pre-release build. The `agent.*` and `llm.features.*` blocks shipped in
> 0.7.0 (see [release notes](migration/release-notes/0.7.0.md)). Unknown
> top-level keys are warn-and-ignore.

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

> **Legacy `stashes` key removed:** `sources` was previously named `stashes`.
> The one-cycle compat shim is gone — configs that still use `stashes[]` will
> not load. Rename the key to `sources[]` in your `config.json` before
> upgrading.

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

## Memory scope

Multi-tenant / multi-agent deployments scope memories with four canonical
top-level frontmatter keys. The `akm remember --user --agent --run --channel`
flags write these keys; `akm search --filter` and `akm show --scope` read
them back.

| Frontmatter key | CLI flag | Meaning |
| --- | --- | --- |
| `scope_user` | `--user <id>` | User id this memory belongs to |
| `scope_agent` | `--agent <id>` | Agent id that produced or consumes this memory |
| `scope_run` | `--run <id>` | Run id (single agent invocation / chat session) |
| `scope_channel` | `--channel <name>` | Channel / conversation name |

All four are independent and optional. A memory may carry any subset; absent
keys are simply not emitted. Example:

```yaml
---
tags: [ops]
scope_user: alice
scope_agent: claude
---
Use staging cluster for blue-green deploys.
```

**Round-trip rules** (carried by spec contract):

- Memories without any `scope_*` key (legacy content written before 0.7.0)
  load and re-serialize unchanged. They match unfiltered `akm search`
  queries — but a query with any `--filter` excludes them, since they have
  no scope key to satisfy the filter. See the
  [0.7.0 release notes](migration/release-notes/0.7.0.md) for the rollout
  detail on `scope_*` keys.
- Each scope key is an opaque string (no validation beyond non-empty +
  trimmed). Use whatever id shape your host system already uses (UUID,
  email, `@handle`, etc.).
- The keys are stored flat (top-level) so the existing one-level frontmatter
  parser reads them without nested-object handling.
- The four canonical keys are the locked v1 wire contract for scope. Adding
  new scope keys after v1.0 is a major version bump.

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

### Per-pass LLM opt-out (`index.<pass>.llm`)

Every LLM-using pass inside `akm index` shares the same top-level `llm`
block — there is exactly one provider/model configuration. To skip the LLM
for a single pass while keeping it on for others, set
`index.<passName>.llm = false`:

```jsonc
{
  "llm": {
    "endpoint": "http://localhost:11434/v1/chat/completions",
    "model": "llama3.2"
  },
  "index": {
    "enrichment": { "llm": false },  // skip LLM metadata enrichment
    "memory": { "llm": false },      // skip memory inference (see below)
    "graph": { "llm": false }        // skip graph extraction (see below)
  }
}
```

Per-pass entries only support the boolean `llm` flag. Supplying a parallel
provider configuration under `index.<pass>` (e.g. `endpoint`, `model`,
`apiKey`, `temperature`) is rejected at config-load time with
`ConfigError("INVALID_CONFIG_FILE")` so that there is exactly one place to
configure the LLM. To use a different model entirely, change the top-level
`llm` block.

### Memory inference pass (`index.memory`)

When `akm.llm` is configured, `akm index` runs an opt-in memory inference
pass that splits each pending memory in `<stashDir>/memories/` into atomic
facts. Each atomic fact is written as a new sibling memory with frontmatter
`inferred: true` and `source: memory:<parent-name>`, and the parent is
marked `inferenceProcessed: true` so subsequent index runs are idempotent.

The pass is disabled when:

- No `akm.llm` block is configured (the default), or
- `index.memory.llm = false` is set explicitly.

Disabling the pass after a previous run never deletes existing inferred
children — they remain on disk and continue to be searchable.

### Graph extraction pass (`index.graph`)

When `akm.llm` is configured, `akm index` runs an opt-in graph-extraction
pass that walks the primary stash for `memory:` and `knowledge:` markdown
files, asks the configured LLM to surface entities and relations from each
body, and persists the result to `<stashRoot>/.akm/graph.json`. The
search-time scorer reads this artifact and contributes a single additive
boost component inside the existing FTS5+boosts loop.

Three preconditions must ALL hold for the pass to run:

- `akm.llm` must be configured (no provider configured → no extraction);
- `llm.features.graph_extraction` must not be `false` (locked v1 spec §14
  feature flag — defaults to `true`);
- `index.graph.llm` must not be `false` (per-pass opt-out — defaults to
  `true`).

To skip just the graph pass while leaving other LLM-using passes enabled,
set `index.graph.llm = false`. To block graph extraction entirely at the
feature-flag layer (e.g. air-gapped environments), set
`llm.features.graph_extraction = false`.

Disabling either layer after a previous run never deletes the existing
`<stashRoot>/.akm/graph.json` artifact — it stays on disk and continues to
contribute to ranking, it just stops refreshing on subsequent index runs.

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

---

## `agent.*` block

**Status: Available since 0.7.0.**
Configures external agent CLI integration (see
[CLI: agent / reflect / propose](cli.md#agent-reflection-and-proposal-queue-070)
and v1 spec §12).

```jsonc
{
  "agent": {
    "default": "opencode",
    "timeoutMs": 60000,
    "profiles": {
      "opencode": {
        "bin": "opencode",
        "args": ["--non-interactive"],
        "stdio": "captured",
        "parseOutput": "text"
      },
      "claude": {
        "bin": "claude",
        "args": [],
        "stdio": "interactive"
      }
    }
  }
}
```

Per-key contract:

| Key | Required | Description |
| --- | --- | --- |
| `agent.default` | optional | Default profile name. If unset, agent commands require an explicit `--profile` flag |
| `agent.timeoutMs` | optional | Hard timeout for spawned agent CLIs (default 60_000) |
| `agent.profiles[<name>]` | optional | Per-profile overrides on top of built-in defaults for `opencode`, `claude`, `codex`, `gemini`, `aider` |
| `agent.profiles[<name>].bin` | required if profile defined | Command to spawn |
| `agent.profiles[<name>].args` | optional | Base args prepended to caller args |
| `agent.profiles[<name>].stdio` | optional | `"captured"` (default for CI / scripted) or `"interactive"` (default for `akm agent`) |
| `agent.profiles[<name>].env` | optional | Extra env vars passed into the spawn |
| `agent.profiles[<name>].envPassthrough` | optional | Array of env-var names to pass through from the calling process to the spawned agent. Use this for profile-level secrets you do not want stored in config (e.g. `["ANTHROPIC_API_KEY"]`). |
| `agent.profiles[<name>].timeoutMs` | optional | Per-profile override of `agent.timeoutMs` |
| `agent.profiles[<name>].parseOutput` | optional | `"text"` or `"json"` |

Unknown keys under `agent` are warn-and-ignore. A missing `agent` block
disables all agent commands with a `ConfigError` whose hint points at this
section.

## `llm.features.*` map

**Status: Available since 0.7.0.**
Gates the small set of bounded in-tree LLM call sites. All defaults are
`false` — the v1 contract is "the in-tree LLM does nothing unless you opt
in, per feature." See v1 spec §14 for the boundary rules.

```jsonc
{
  "llm": {
    "endpoint": "http://localhost:11434/v1/chat/completions",
    "model": "llama3.2",
    "temperature": 0.3,
    "maxTokens": 512,
    "features": {
      "curate_rerank":         false,
      "feedback_distillation": false,
      "memory_inference":      true,
      "graph_extraction":      false
    }
  }
}
```

| Feature flag | Use site | Behaviour when disabled |
| --- | --- | --- |
| `curate_rerank` | `akm curate` re-orders top-N results via LLM scoring | Curate falls back to the deterministic pipeline |
| `feedback_distillation` | `akm distill <ref>` | `akm distill` exits 0 with `outcome: "skipped"` |
| `memory_inference` | `akm index` memory-inference pass (split a pending memory into atomic facts) | The pass is a no-op; existing inferred children remain |
| `graph_extraction` | `akm index` graph-extraction pass (entities + relations from memory/knowledge → `graph.json` boost) | The pass is a no-op; an existing `graph.json` is preserved and still feeds the boost component |

Unknown keys under `llm.features` are warn-and-ignore. The keys above
are locked and cannot be renamed after v1.0.

**Statelessness invariant.** Every in-tree LLM call site is a single,
bounded request/response cycle with a hard timeout. There are no caches
keyed on prior responses, no streaming sessions, and no persistent
connections. Long-lived state belongs in the agent path, not here.

**Graceful-fallback contract.** Each gated feature uses the
`tryLlmFeature(feature, config, fn, fallback)` wrapper from
`src/llm/feature-gate.ts`. The wrapper returns `fallback` on disablement
(`llm.features.<key>` not `true`), on timeout (default 30s; the wrapper
raises `LlmFeatureTimeoutError`), or on any thrown error from `fn`. Call
sites may pass an `onFallback` sink to surface a structured `warnings`
entry per spec §14.2 — the gate itself never throws and never blocks the
caller's command.

## Environment variables

akm reads a small set of environment variables in addition to `config.json`.
Variables with a literal-or-env config form (e.g. `apiKey: "${MY_KEY}"`) are
documented inline next to the relevant config key; the table below covers
the variables that are read directly by the CLI.

| Variable | Purpose | Default | Notes |
| --- | --- | --- | --- |
| `AKM_CONFIG_DIR` | Override the platform config directory. | `~/.config/akm` (XDG) / `%APPDATA%\akm` | Overrides the table at the top of this page. |
| `AKM_CACHE_DIR` | Override the platform cache directory used for indexes, registry mirrors, and bench tmp roots. | `~/.cache/akm` (XDG) | Read at startup; takes precedence over `XDG_CACHE_HOME`. |
| `AKM_STASH_DIR` | Override the working stash directory. | `config.stashDir` or `~/.akm` | Per-invocation override; never persisted. |
| `AKM_EMBED_API_KEY` | API key applied to `embedding` config when `apiKey` is unset. | — | Preferred over storing the key in `config.json`. |
| `AKM_LLM_API_KEY` | API key applied to `llm` config when `apiKey` is unset. | — | Preferred over storing the key in `config.json`. |
| `AKM_NPM_REGISTRY` | npm registry used when resolving `npm:` install refs and tarballs. | `https://registry.npmjs.org` | Honour your private registry without rewriting refs. |
| `AKM_REGISTRY_URL` | Comma-separated list of registry index URLs to use *instead of* the configured `registries[]`. | unset (use `config.registries`) | Intended as a CI / one-shot override; does not persist to `config.json`. |
| `HF_HOME` | Hugging Face cache root for the local embedder (`@huggingface/transformers`). | `<AKM_CACHE_DIR>/hf` | akm sets this at process start when unset, so model downloads land in the akm cache rather than `~/.cache/huggingface`. Pre-set it in your environment to opt out. |
| `GITHUB_TOKEN` | Token used for authenticated GitHub API calls (private repos, higher rate limits). | — | Read alongside `GH_TOKEN`. |
| `GH_TOKEN` | Same as `GITHUB_TOKEN`; honoured for compatibility with the `gh` CLI. | — | Either name works; if both are set, `GITHUB_TOKEN` wins. |
| `AKM_VERBOSE` | When truthy (`1`, `true`, `yes`, `on`), print verbose diagnostics. When falsy (`0`, `false`, `no`, `off`), force quiet even if `--verbose` is passed. | unset | Env wins over the `--verbose` / `--quiet` flags. |
