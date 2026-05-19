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
akm config set output.detail full   # Set one scalar key
akm config set security.installAudit.enabled false
akm config unset embedding          # Remove an optional key
akm config migrate --dry-run        # Preview config v2 migration
akm config migrate                  # Apply config v2 migration
```

`akm config set` / `unset` write the user config in your platform config
directory. Project config files are meant to be edited directly in the project.

## v2 Config Shape

0.8.0 introduces a unified config shape (`configVersion: "0.8.0"`) with three
top-level sections that replace the scattered v1 keys:

- **`profiles`** — declare every LLM and agent connection once, referenced by
  name from `features` entries.
- **`defaults`** — fallback profile names and section-level defaults.
- **`features`** — every named LLM/agent operation in the app, grouped by
  lifecycle: `features.improve.*`, `features.index.*`, `features.search.*`.

Configs without `configVersion` (or with a version predating `"0.8.0"`) are
auto-migrated at first run. A timestamped backup is written before any
in-place rewrite. Set `AKM_NO_AUTO_MIGRATE=1` to suppress the rewrite.

### Minimal working example

```jsonc
{
  "configVersion": "0.8.0",
  "$schema": "https://itlackey.github.io/akm/schemas/akm-config.0.8.0.json",
  "profiles": {
    "llm": {
      "openai-mini": {
        "endpoint": "https://api.openai.com/v1/chat/completions",
        "model": "gpt-4o-mini",
        "apiKey": "${OPENAI_API_KEY}",
        "temperature": 0.3,
        "supportsJsonSchema": true
      }
    },
    "agent": {
      "opencode-default": { "platform": "opencode", "bin": "opencode", "args": ["run"] }
    }
  },
  "defaults": {
    "llm": "openai-mini",
    "agent": "opencode-default",
    "improve": { "limit": 25, "preset": "custom" }
  },
  "features": {
    "improve": {
      "reflect": { "mode": "llm", "profile": "openai-mini", "timeoutMs": 90000,
                   "options": { "cooldown": { "memory": 2, "lesson": 7, "knowledge": 30 } } },
      "distill": { "mode": "llm", "profile": "openai-mini" },
      "memory_consolidation": { "mode": "llm", "profile": "openai-mini" },
      "propose": { "mode": "agent", "profile": "opencode-default" },
      "feedback_distillation": true
    },
    "index": {
      "memory_inference": true,
      "graph_extraction": { "profile": "openai-mini" },
      "metadata_enhance": false
    },
    "search": {
      "curate_rerank": true
    }
  },
  "embedding": {
    "endpoint": "http://localhost:11434/v1/embeddings",
    "model": "nomic-embed-text",
    "dimension": 384
  },
  "stashDir": "~/akm"
}
```

## Config Reference

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `configVersion` | string | — | Version gate for load-time migration. Set to `"0.8.0"` for the current shape. Omitting it (or setting an older value) triggers auto-migration. |
| `profiles.llm.<name>` | object | — | Named OpenAI-compatible chat-completion connection. See [Profile types](#profile-types). |
| `profiles.agent.<name>` | object | — | Named agent profile (`platform: "opencode"\|"claude"\|"opencode-sdk"`). See [Profile types](#profile-types). |
| `defaults.llm` | string | — | Default LLM profile name. Used when a features entry omits `profile`. Also the target for `AKM_LLM_API_KEY` injection. |
| `defaults.agent` | string | — | Default agent profile name. Fallback for `mode: "agent"` or `mode: "sdk"` entries that omit `profile`. |
| `defaults.improve.limit` | number | 25 | Default refs per improve run; overridden by `--limit`. |
| `defaults.improve.preset` | string | `"custom"` | Improve preset (`"fast"`, `"thorough"`, `"mixed"`, `"custom"`). |
| `features.improve.<name>` | process entry | — | Operation during `akm improve`. Unified shape: `true\|false\|{mode, profile, timeoutMs, options}`. |
| `features.index.<name>` | process entry | — | Operation during `akm index`. |
| `features.search.<name>` | process entry | — | Operation during `akm search` / `akm curate`. |
| `semanticSearchMode` | `"off"` \| `"auto"` | `"auto"` | Semantic vector search mode. |
| `embedding` | object | null (local) | Embedding connection settings. Unchanged from v1. |
| `output.format` | string | `json` | Default output format (`json`, `text`, `yaml`, `jsonl`). |
| `output.detail` | string | `brief` | Default output detail (`brief`, `normal`, `full`, `summary`, `agent`). |
| `sources` | array | `[]` | Source entries — directories, git repos, websites, npm packages. |
| `defaultWriteTarget` | string | — | Source name for `akm remember` / `akm import` writes when `--target` is omitted. |
| `writable` | boolean | `false` | Whether the primary stash pushes on `akm save`. |
| `stashInheritance` | `"merge"` \| `"replace"` | `"merge"` | How per-project sources compose with global ones. |
| `registries` | array | official + skills.sh | Configured registries. |
| `stashDir` | string | platform default | Path to the working stash. |
| `security.installAudit.enabled` | boolean | `true` | Enable or disable install-time auditing. |
| `security.installAudit.blockOnCritical` | boolean | `true` | Block installs when critical findings are detected. |
| `security.installAudit.registryAllowlist` | array | `[]` | Allowed registry names or hosts. |
| `security.installAudit.blockUnlistedRegistries` | boolean | `false` | Reject installs from registries not in the allowlist. |
| `search.minScore` | number | `0.2` | Minimum score floor for semantic-only hits. |
| `search.graphBoost.directBoostPerEntity` | number | `0.25` | Additive direct-match graph boost per matched entity. |
| `search.graphBoost.directBoostCap` | number | `0.75` | Maximum direct-match additive graph boost per hit. |
| `search.graphBoost.hopBoostPerEntity` | number | `0.1` | Additive connected-entity graph boost per matched entity. |
| `search.graphBoost.hopBoostCap` | number | `0.3` | Maximum connected-entity additive graph boost per hit. |
| `search.graphBoost.maxHops` | integer | `1` | Max graph traversal depth (hard cap `3`). |
| `search.graphBoost.confidenceMode` | `"off"` \| `"blend"` \| `"multiply"` | `"blend"` | How extraction confidence values affect graph boosts. |
| `search.graphBoost.confidenceWeight` | number | `0.2` | Blend strength in `[0,1]` when `confidenceMode` is `"blend"`. |

> **v1 keys deprecated:** `config.llm` (top-level), `config.agent.profiles`, `config.agent.processes`, and `llm.features.*` flags are deprecated in 0.8.0. They are auto-migrated to the v2 shape at first run.

## Profile types

### LLM profiles (`profiles.llm.<name>`)

Used by processes whose `mode` is `"llm"`. Each profile is an OpenAI-compatible
chat-completion endpoint declared once and referenced by name.

| Field | Required | Description |
| --- | --- | --- |
| `endpoint` | yes | Chat completions URL (e.g. `https://api.openai.com/v1/chat/completions`) |
| `model` | yes | Model identifier |
| `apiKey` | no | API key. Use `${ENV_VAR}` syntax. Prefer `AKM_LLM_API_KEY` or `AKM_PROFILE_<NAME>_API_KEY` env vars. |
| `temperature` | no | Sampling temperature (default provider default) |
| `maxTokens` | no | Maximum tokens in the completion |
| `contextLength` | no | Context window size — used for batch-size clamping in graph extraction |
| `concurrency` | no | Max parallel requests for this profile |
| `supportsJsonSchema` | no | When `true`, akm sends `response_format: {type: "json_schema"}` for structured outputs, eliminating JSON parse failures for capable providers |

```jsonc
"profiles": {
  "llm": {
    "openai-mini": {
      "endpoint": "https://api.openai.com/v1/chat/completions",
      "model": "gpt-4o-mini",
      "apiKey": "${OPENAI_API_KEY}",
      "temperature": 0.3,
      "supportsJsonSchema": true
    },
    "openai-judge": {
      "endpoint": "https://api.openai.com/v1/chat/completions",
      "model": "gpt-4o",
      "apiKey": "${OPENAI_API_KEY}",
      "maxTokens": 4096,
      "supportsJsonSchema": true
    },
    "ollama-local": {
      "endpoint": "http://localhost:11434/v1/chat/completions",
      "model": "qwen2.5-coder",
      "temperature": 0.4,
      "contextLength": 32768
    }
  }
}
```

### Agent profiles (`profiles.agent.<name>`)

Used by processes whose `mode` is `"agent"` (CLI subprocess) or `"sdk"`
(in-process opencode). The required `platform` field selects the runtime:

| `platform` | Runtime | Use case |
| --- | --- | --- |
| `"opencode"` | opencode CLI subprocess | Full opencode tool + plugin access; ~30s/call startup |
| `"claude"` | Claude Code CLI (`--print` mode) | Claude tooling; ~30s/call startup |
| `"opencode-sdk"` | In-process opencode programmatic API | Same tool surface as CLI, no subprocess startup (~10–15s/call) |

The Anthropic / Claude Agent SDK is **not supported**. The `sdk` mode
exclusively drives the opencode programmatic API.

```jsonc
"profiles": {
  "agent": {
    "opencode-default": {
      "platform": "opencode",
      "bin": "opencode",
      "args": ["run"]
    },
    "claude-cli": {
      "platform": "claude",
      "bin": "claude",
      "args": ["--print"]
    },
    "opencode-sdk": {
      "platform": "opencode-sdk",
      "workspace": "${PWD}",
      "model": "anthropic/claude-sonnet-4-5"
    }
  }
}
```

Agent profiles also accept the v1 fields (`bin`, `args`, `stdio`,
`parseOutput`, `envPassthrough`, `timeoutMs`, `commandBuilder`,
`modelAliases`) for CLI subprocess profiles. See
[docs/configuration-agent-profiles.md](configuration-agent-profiles.md) for
the full field reference and model alias documentation.

## Process entry shape

Every `features.<section>.<name>` entry uses the same unified shape. Three
shorthand forms are accepted:

```jsonc
"X": true                    // enabled, all defaults resolved at load time
"X": false                   // disabled — caller short-circuits (no runner resolved)
"X": {
  "enabled": true,           // optional; default true
  "mode": "llm",             // "llm" | "agent" | "sdk" — optional, inferred if omitted
  "profile": "<name>",       // optional; falls back to defaults.llm or defaults.agent
  "timeoutMs": 60000,        // optional; null = unlimited
  "options": { /* ... */ }   // optional; process-specific tuning
}
```

**Mode resolution** (when `mode` is omitted):

1. If `profile` is set, the mode is inferred from the profile's pool:
   LLM profile → `"llm"`, `"opencode-sdk"` platform → `"sdk"`,
   `"opencode"` / `"claude"` platform → `"agent"`.
2. If neither is set: `defaults.llm` is set → `"llm"`; else `defaults.agent` → `"agent"`.

**`options`** holds process-specific tuning that doesn't fit the generic fields:

- `features.improve.reflect.options.cooldown` — per-asset-type reflect cooldown
  in days (replaces the old `improve.reflectCooldownByType`).
- `features.improve.reflect.options.maxRefineIters` — self-refine cap (default 3).
- `features.improve.distill.options.judgeRubric` — rubric override for distill.

Unknown keys under `options` warn-and-ignore.

## Known process names

### `features.improve.*`

| Process | Default mode | Description |
| --- | --- | --- |
| `reflect` | `llm` | Per-asset reflection pass; multi-turn self-refine in LLM mode |
| `distill` | `llm` | Quality judgement (use a larger `openai-judge` profile for better scoring) |
| `memory_consolidation` | `llm` | Memory deduplication |
| `graph_extraction` | `false` (improve cycle skips; handled at index) | Entity/relation extraction |
| `propose` | `agent` | New-asset authoring; needs tool access |
| `memory_improve` | `llm` | Memory enrichment |
| `feedback_distillation` | `true` (defaults) | Turn collected feedback into lessons |
| `validation` | unset → falls back to `defaults.llm` | Lower-tier classifier model used by staleness detection, confidence scoring, and lesson classification. Configure with a smaller/cheaper LLM profile to keep validation cycles cheap. |

#### Tuning the forgetting curve

The recency-decay component of search ranking exposes two knobs under
`improve.utilityDecay`:

```jsonc
{
  "improve": {
    "utilityDecay": {
      "halfLifeDays": 30,            // default 30 — how fast unused assets fade
      "feedbackStabilityBoost": 1.5  // default 1.5 — per positive-feedback event
    }
  }
}
```

The effective half-life for an asset is
`halfLifeDays × (feedbackStabilityBoost ^ positiveFeedbackCount)`, capped at
`halfLifeDays × 4`. Assets with repeated positive feedback resist decay; assets
with none decay at the base rate.

Leave the section absent to use the previous fixed 30-day formula
unchanged — the feedback-count query is skipped entirely when `utilityDecay`
is not configured, so there's zero overhead on the search hot path.

### `features.index.*`

| Process | Default | Description |
| --- | --- | --- |
| `memory_inference` | `true` | Derive structured memories from pending memory files |
| `graph_extraction` | `true` | Extract entities and relations for graph-boosted search |
| `metadata_enhance` | `false` | LLM-driven description/tag enrichment during `akm index` |

### `features.search.*`

| Process | Default | Description |
| --- | --- | --- |
| `curate_rerank` | `true` | LLM re-ranking during `akm curate` |

## Migration from v1

If your config uses the old `config.llm`, `config.agent.profiles`,
`config.agent.processes`, or `llm.features.*` keys, run:

```sh
# Preview changes without writing
akm config migrate --dry-run

# Apply migration (writes a timestamped backup first)
akm config migrate
```

Auto-migration also runs on the first command after upgrade (one-time notice
printed). Set `AKM_NO_AUTO_MIGRATE=1` to suppress automatic rewrites — useful
on read-only CI mounts where you want to run `akm config migrate` explicitly
during deploy.

See [docs/migration/v0.7-to-v0.8.md](migration/v0.7-to-v0.8.md) for the
complete old-key-to-new-key mapping table and step-by-step instructions.

---

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
points at `akm setup`.

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
  no scope key to satisfy the filter.
- Each scope key is an opaque string (no validation beyond non-empty + trimmed).
- The keys are stored flat (top-level) so the existing one-level frontmatter
  parser reads them without nested-object handling.
- The four canonical keys are the locked v1 wire contract for scope.

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

When using a remote provider, `dimension` must match the index vector size (384).

## Graph boost search tuning

`search.graphBoost` controls only the search-time graph boost component in the
single FTS5+boosts pipeline. Default values preserve current ranking behavior.

```jsonc
{
  "search": {
    "graphBoost": {
      "directBoostPerEntity": 0.25,
      "directBoostCap": 0.75,
      "hopBoostPerEntity": 0.1,
      "hopBoostCap": 0.3,
      "maxHops": 1,
      "confidenceMode": "blend",
      "confidenceWeight": 0.2
    }
  }
}
```

- `maxHops` is bounded to a conservative hard cap of `3`.
- `confidenceMode` supports `off`, `blend`, and `multiply`.
- `confidenceWeight` is clamped to `[0,1]` and only applies when
  `confidenceMode` is `"blend"`.

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

## Using Ollama

[Ollama](https://ollama.com) provides local models with an OpenAI-compatible
API. After installing Ollama:

```sh
# Pull models
ollama pull nomic-embed-text
ollama pull qwen2.5-coder

# Configure embedding (unchanged)
akm config set embedding '{"endpoint":"http://localhost:11434/v1/embeddings","model":"nomic-embed-text","dimension":384}'
```

For the LLM (v2 config — add to config.json directly):

```jsonc
{
  "configVersion": "0.8.0",
  "profiles": {
    "llm": {
      "ollama-local": {
        "endpoint": "http://localhost:11434/v1/chat/completions",
        "model": "qwen2.5-coder",
        "temperature": 0.4,
        "contextLength": 32768
      }
    }
  },
  "defaults": { "llm": "ollama-local" }
}
```

## sqlite-vec Extension

akm uses [sqlite-vec](https://github.com/asg017/sqlite-vec) for fast
vector similarity search. When sqlite-vec is not available (common in compiled
binaries on macOS), semantic search falls back to a pure JS implementation
that computes cosine similarity over BLOB-stored embeddings.

The JS fallback works correctly at any scale but becomes noticeably slower
above ~10,000 indexed entries.

Install the extension to use the optimized path:

```sh
npm install sqlite-vec
# or
bun add sqlite-vec
```

To check whether sqlite-vec is active, run:

```sh
akm info
```

If `searchModes` includes `"semantic"` with `"ready-vec"`, the native extension
is working. If it shows `"ready-js"`, the JS fallback is in use.

## Environment variables

akm reads a small set of environment variables in addition to `config.json`.

| Variable | Purpose | Default | Notes |
| --- | --- | --- | --- |
| `AKM_CONFIG_DIR` | Override the platform config directory. | `~/.config/akm` (XDG) | |
| `AKM_DATA_DIR` | Override the platform data directory. | `~/.local/share/akm` (XDG) | Set explicitly in CI if you previously relied on `AKM_CONFIG_DIR` as a data-dir fallback (removed in 0.8.0). |
| `AKM_STATE_DIR` | Override the platform state directory. | `~/.local/state/akm` (XDG) | |
| `AKM_CACHE_DIR` | Override the platform cache directory. | `~/.cache/akm` (XDG) | |
| `AKM_STASH_DIR` | Override the working stash directory. | `config.stashDir` or `~/.akm` | Per-invocation; never persisted. |
| `AKM_EMBED_API_KEY` | API key applied to `embedding` config when `apiKey` is unset. | — | Preferred over storing the key in `config.json`. |
| `AKM_LLM_API_KEY` | API key injected into `profiles.llm[defaults.llm].apiKey` when `apiKey` is unset. | — | Legacy form still works in v2. |
| `AKM_PROFILE_<NAME>_API_KEY` | Per-profile API key override. NAME is upper-cased profile key with hyphens replaced by underscores (e.g. `AKM_PROFILE_OPENAI_JUDGE_API_KEY`). | — | New in 0.8.0. |
| `AKM_NO_AUTO_MIGRATE` | When set to `1`, suppresses the automatic config v2 rewrite at startup. | — | Use in CI on read-only mounts; run `akm config migrate` in deploy pipelines instead. |
| `AKM_NPM_REGISTRY` | npm registry for `npm:` install refs. | `https://registry.npmjs.org` | |
| `AKM_REGISTRY_URL` | Comma-separated registry index URLs to use instead of configured `registries[]`. | unset | CI / one-shot override; does not persist. |
| `HF_HOME` | Hugging Face cache root for the local embedder. | `<AKM_CACHE_DIR>/hf` | akm sets this at process start when unset. |
| `GITHUB_TOKEN` / `GH_TOKEN` | Token for authenticated GitHub API calls. | — | `GITHUB_TOKEN` wins if both are set. |
| `AKM_VERBOSE` | When truthy, print verbose diagnostics. | unset | Env wins over `--verbose` / `--quiet` flags. |
