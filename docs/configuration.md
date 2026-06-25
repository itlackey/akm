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
akm config unset embedding          # Remove an optional key
akm config migrate --dry-run        # Preview config v2 migration
akm config migrate                  # Apply config v2 migration
```

`akm config set` / `unset` write the user config in your platform config
directory. Project config files are meant to be edited directly in the project.

## 0.8.0 Config Shape

0.8.0 finalises the unified config shape (`configVersion: "0.8.0"`). The
legacy top-level `llm`, `agent`, and `features` blocks have been **removed**.
LLM and agent connections live exclusively under `profiles.*`, and per-process
gating lives under `profiles.improve.<name>.processes.*`. Non-improve feature
sections (`index.metadataEnhance`, `index.stalenessDetection`,
`search.curateRerank`) are first-class top-level entries.

Configs without `configVersion` (or with a pre-0.8.0 version) are
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
    },
    "improve": {
      "default": {
        "processes": {
          "reflect": {
            "enabled": true,
            "mode": "llm",
            "profile": "openai-mini",
            "timeoutMs": 90000,
            "cooldownByType": { "memory": 2, "lesson": 7, "knowledge": 30 }
          },
          "distill": { "enabled": true, "mode": "llm", "profile": "openai-mini" },
          "consolidate": { "enabled": true, "mode": "llm", "profile": "openai-mini" },
          "memoryInference": { "enabled": true },
          "graphExtraction": { "enabled": true, "profile": "openai-mini" },
          "feedbackDistillation": { "enabled": true }
        }
      }
    }
  },
  "defaults": {
    "llm": "openai-mini",
    "agent": "opencode-default",
    "improve": "default"
  },
  "index": {
    "metadataEnhance": { "enabled": true },
    "stalenessDetection": { "enabled": false }
  },
  "search": {
    "curateRerank": { "enabled": false }
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
| `defaults.improve` | string | `"default"` | Default improve profile name. Selects one of the built-ins (`default`, `quick`, `thorough`, `memory-focus`) or a user-defined entry under `profiles.improve`. Overridden by `--profile <name>`. |
| `profiles.improve.<name>` | object | — | Improve profile defining per-process gating, type filters, cooldowns, and run-level `autoAccept` / `limit` defaults. See [Improve profiles](#improve-profiles). |
| `profiles.improve.<name>.processes.<process>` | object | — | Per-process binding (`reflect`, `distill`, `consolidate`, `memoryInference`, `graphExtraction`, `feedbackDistillation`, `validation`). Shape: `{ enabled, mode, profile, timeoutMs, qualityGate?, contradictionDetection?, cooldownByType?, allowedTypes? }`. |
| `index.metadataEnhance.enabled` | boolean | `false` | Toggles the `akm index` metadata-enhancement pass. Replaces the legacy `features.index.metadata_enhance` entry. |
| `index.stalenessDetection.enabled` | boolean | `false` | Toggles the `akm index` staleness-detection pass. |
| `index.stalenessDetection.thresholdDays` | integer | `90` | Days before a memory is re-evaluated for staleness. |
| `search.curateRerank.enabled` | boolean | `false` | Toggles the `akm curate` LLM-rerank pass. Replaces the legacy `features.search.curate_rerank` entry. |
| `semanticSearchMode` | `"off"` \| `"auto"` | `"auto"` | Semantic vector search mode. |
| `embedding` | object | null (local) | Embedding connection settings. Unchanged from v1. |
| `output.format` | string | `json` | Default output format (`json`, `text`, `yaml`, `jsonl`). |
| `output.detail` | string | `brief` | Default output detail (`brief`, `normal`, `full`, `summary`, `agent`). |
| `sources` | array | `[]` | Source entries — directories, git repos, websites, npm packages. |
| `defaultWriteTarget` | string | — | Source name for `akm remember` / `akm import` writes when `--target` is omitted. |
| `writable` | boolean | `false` | Whether the primary stash pushes on `akm sync`. |
| `stashInheritance` | `"merge"` \| `"replace"` | `"merge"` | How per-project sources compose with global ones. |
| `registries` | array | official + skills.sh | Configured registries. |
| `stashDir` | string | platform default | Path to the working stash. |
| `search.minScore` | number | `0.2` | Minimum score floor for semantic-only hits. |
| `search.graphBoost.directBoostPerEntity` | number | `0.25` | Additive direct-match graph boost per matched entity. |
| `search.graphBoost.directBoostCap` | number | `0.75` | Maximum direct-match additive graph boost per hit. |
| `search.graphBoost.hopBoostPerEntity` | number | `0.1` | Additive connected-entity graph boost per matched entity. |
| `search.graphBoost.hopBoostCap` | number | `0.3` | Maximum connected-entity additive graph boost per hit. |
| `search.graphBoost.maxHops` | integer | `1` | Max graph traversal depth (hard cap `3`). |
| `search.graphBoost.confidenceMode` | `"off"` \| `"blend"` \| `"multiply"` | `"blend"` | How extraction confidence values affect graph boosts. |
| `search.graphBoost.confidenceWeight` | number | `0.2` | Blend strength in `[0,1]` when `confidenceMode` is `"blend"`. |

> **Removed in 0.8.0:** `config.llm` (top-level), `config.agent.*`, `config.features.*`, and `llm.features.*` flags. Auto-migration rewrites any of these on first load into the new locations described above. See [Migrating from 0.7.x to 0.8.0](migration/v0.7-to-v0.8.md) for the complete old → new mapping.

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

**`options`** holds process-specific tuning that doesn't fit the generic fields.
Unknown keys under `options` warn-and-ignore.

Reflect/distill cooldowns, per-process type filters, and per-process gating
all live under [`profiles.improve.<name>.processes.*`](#improve-profiles)
in 0.8.0.

## Known process names

### `profiles.improve.<name>.processes.*`

Each entry under `processes` is either absent (use the built-in default
for the named profile) or an object of the form
`{ enabled?, mode?, profile?, timeoutMs?, allowedTypes?, qualityGate?, contradictionDetection?, defaultSince?, maxTotalChars? }`.
(Not all fields apply to all processes: `allowedTypes` is for reflect/distill; `qualityGate` and `contradictionDetection` for specific processes; `defaultSince` and `maxTotalChars` only for extract.)

| Process | Default (built-in `default` profile) | Description |
| --- | --- | --- |
| `reflect` | enabled, all markdown types | Reflection pass — generates per-asset proposals. Optional `qualityGate.enabled` runs an LLM-as-judge check before queuing. |
| `distill` | enabled, `memory` only | Turns feedback into lesson proposals. Optional `qualityGate.enabled`. |
| `consolidate` | enabled, `memory` only | Memory deduplication / promotion. Optional `contradictionDetection.enabled` runs pairwise checks. |
| `memoryInference` | enabled | Derives structured memories from pending memory files. |
| `graphExtraction` | enabled | Extracts entities and relations for graph-boosted search. |
| `extract` | enabled | Reads native session files (Claude Code JSONL, opencode logs) and extracts insight proposals via LLM. Configure `defaultSince` (discovery window, e.g. `"24h"`) and `maxTotalChars` (event-budget, default `80000`) to tune extraction scope. |
| `validation` | unset → falls back to `defaults.llm` | Lower-tier classifier model used by staleness detection, confidence scoring, and lesson classification. Configure with a smaller/cheaper LLM profile to keep validation cycles cheap. |

#### Configuring the extract process

The `extract` process runs as part of `akm improve` to automatically derive memory, lesson, and knowledge proposals from native session logs (Claude Code JSONL, opencode storage). You can tune its behavior with two optional fields:

```jsonc
"processes": {
  "extract": {
    "enabled": true,                    // default: enabled
    "defaultSince": "24h",              // session discovery window (default "24h")
    "maxTotalChars": 80000              // event pre-filter budget (default 80000)
  }
}
```

- **`defaultSince`**: Sets the discovery window for session extraction when no explicit time range is given. Accepts ISO 8601 timestamps (`2026-05-20T00:00:00Z`) or duration strings (`24h`, `7d`, `30m`). Default: `"24h"` (most recent sessions only).
  - Use `"7d"` to include a broader historical window.
  - Use `"0"` to disable time-based filtering (extract all available sessions).

- **`maxTotalChars`**: Pre-filter budget for kept events before sending to the extraction LLM. Once kept events exceed this many characters, older events are dropped (recency-bias) to keep the prompt within token limits. Default: `80000` (tuned for 32K-token models).
  - Increase to `200000` for larger-context models (e.g., Opus with 200K tokens).
  - Decrease to `30000` for smaller models (e.g., Haiku).

Set `enabled: false` to skip extraction entirely during improve runs.

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

### `index.*`

| Section | Default | Description |
| --- | --- | --- |
| `index.metadataEnhance.enabled` | `false` | LLM-driven description/tag enrichment during `akm index`. |
| `index.stalenessDetection.enabled` | `false` | Run the staleness-detection validator pass during `akm index`. |
| `index.stalenessDetection.thresholdDays` | `90` | Days before a memory is re-evaluated for staleness. |

### `search.*`

| Section | Default | Description |
| --- | --- | --- |
| `search.curateRerank.enabled` | `false` | LLM re-ranking during `akm curate`. |

## Improve profiles

`profiles.improve.<name>` defines a named bundle of settings for an
`akm improve` run: which sub-processes are enabled, which asset types each
processes, per-process runner / cooldown overrides, and run-level
`autoAccept` / `limit` defaults. Pick a profile per invocation with
`--profile <name>` or set the default with `defaults.improve: "<name>"`.

### Built-in profiles

| Name | Description | Sync behavior |
| --- | --- | --- |
| `default` | Standard improve pass — all sub-processes, markdown asset types. | Auto-commit + push |
| `quick` | Reflect-only — distill, consolidate, memoryInference, graphExtraction all disabled. | Sync disabled |
| `thorough` | All sub-processes enabled (currently identical to `default`; reserved for future divergence). | Auto-commit + push |
| `memory-focus` | Reflect + memoryInference only; restricted to `memory` and `lesson` types. | Sync disabled |

### Schema

```jsonc
"profiles": {
  "improve": {
    "<profile-name>": {
      "description": "Human-readable summary (optional).",
      "autoAccept": 90,             // optional — default proposal auto-accept threshold (0-100)
      "limit": 25,                  // optional — default refs per run; overridden by --limit
      "processes": {
        "reflect": {
          "enabled": true,
          "mode": "llm",            // optional — "llm" | "agent" | "sdk"
          "profile": "openai-mini", // optional — runner profile name (profiles.llm.* / profiles.agent.*)
          "timeoutMs": 60000,       // optional
          "allowedTypes": ["memory", "lesson"],      // optional — whitelist of asset types
          "cooldownByType": { "memory": 1 },         // optional — per-type cooldown (days)
          "cooldownDays": 7                          // optional — uniform cooldown
        },
        "distill": { "enabled": true, "allowedTypes": ["memory"] },
        "consolidate": { "enabled": true },
        "memoryInference": { "enabled": true },
        "graphExtraction": { "enabled": true }
      },
      "sync": {
        "enabled": true,       // optional — false disables end-of-run auto-commit
        "push": true,          // optional — false commits only, no push
        "message": "akm improve auto-sync {date}"  // optional — supports {token} placeholders
      }
    }
  }
}
```

`allowedTypes` is only honoured by `reflect` and `distill` (per-ref
operations). Setting it on `consolidate`, `memoryInference`, or
`graphExtraction` (full-pass operations) triggers a parse-time warning.

### Configuring end-of-run sync

The `sync` block controls whether `akm improve` commits (and optionally pushes)
the git-backed primary stash at the end of a run. Detection is based on the
presence of a `.git` directory in the stash — no remote is required.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | true (default/thorough), false (quick/memory-focus) | Whether to auto-commit at run end |
| `push` | boolean | true | Whether to push after commit (only applies when `enabled: true` and stash is writable) |
| `message` | string | `"akm improve auto-sync"` | Commit message template; supports `{token}` placeholders |

**Commit message tokens:**

| Token | Value |
| --- | --- |
| `{timestamp}` | `YYYY-MM-DD HH:MM:SS` (UTC) |
| `{date}` | `YYYY-MM-DD` |
| `{time}` | `HH:MM:SS` |
| `{scope}` | Scope ref or type, or `all` for whole-stash runs |
| `{refs}` | Number of planned refs this run processed |
| `{accepted}` | Number of proposals auto-accepted by the confidence gate |

Unknown tokens pass through verbatim so adding new tokens later never breaks
an existing template. Example: `"akm improve {scope} on {date} ({refs} refs)"`.

CLI flags `--sync` / `--no-sync` and `--push` / `--no-push` override the
profile-level `sync` block for a single run. A sync failure is always
non-fatal — it never fails a successful improve run.

### Selection precedence

1. `--profile <name>` CLI flag (this run only)
2. `defaults.improve: "<name>"` in config
3. Built-in `default`

Profile name lookups search both built-ins and `profiles.improve.<name>`.
An unknown name falls back to `default` with a warning.

## Migration from pre-0.8.0

If your config uses the old top-level `llm`, `agent`, or `features` blocks,
run:

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

### Public environment variables

These variables are part of the supported surface — safe to set in scripts and
CI. Variables not listed here (e.g. `AKM_FORCE_INIT_TMP_STASH`, `AKM_DEBUG*`,
`AKM_DISABLE_*`) are internal test/debug hooks, are undocumented on purpose,
and may change or be renamed without notice.

| Variable | Purpose | Default | Notes |
| --- | --- | --- | --- |
| `AKM_CONFIG_DIR` | Override the platform config directory. | `~/.config/akm` (XDG) | |
| `AKM_DATA_DIR` | Override the platform data directory. | `~/.local/share/akm` (XDG) | Set explicitly in CI if you previously relied on `AKM_CONFIG_DIR` as a data-dir fallback (removed in 0.8.0). |
| `AKM_SQLITE_JOURNAL_MODE` | SQLite journal mode applied at every db open: `WAL`, `DELETE`, or `TRUNCATE`. | `WAL` | WAL is impossible on network filesystems (NFS/SMB) — its `-shm` wal-index can't be mmap'd over a network mount. Use `DELETE` or `TRUNCATE` there. At the `WAL` default, akm probes the data dir's filesystem and auto-falls-back to `DELETE` on a detected network mount (one-line warning). Invalid values warn once and fall back to `WAL`. |
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
| `AKM_BIN` | Absolute path to the `akm` binary used when scheduled tasks re-invoke akm. | resolved from `execPath`/PATH | Takes precedence over auto-detection. Set when akm is not on PATH for the scheduler. |
| `AKM_NON_INTERACTIVE` | Set to `1` to force non-interactive behavior (treat as no TTY) for prompts and consolidation review. | unset | Useful in CI and headless agents. Also inferred when stdin is not a TTY. |
| `AKM_EVENT_SOURCE` | Tags emitted events with their source (`user` or `improve`). | unset | Set automatically by `akm improve` for agent subprocesses so improve-driven events can be filtered out of user-facing history. |

### Recovering the index database

`index.db` is a **derived cache** — every row is regenerable from the markdown
in your stash. Its schema evolves through idempotent, additive migrations
(`CREATE … IF NOT EXISTS` + guarded `ALTER`s), so opening an older database
converges it forward without ever dropping data. There is no automatic
pre-upgrade backup and no destructive version-bump rebuild.

If the index is ever corrupted or you want a clean rebuild, delete it and
re-run `akm index` — that regenerates `entries`, embeddings, FTS, and the graph
from scratch. (The non-regenerable state — events, proposals, task history —
lives in the separate, additively-migrated `state.db`, which is never wiped.)

## Hosting AKM databases on a network share (NFS / SMB)

AKM keeps its durable state in SQLite databases under `AKM_DATA_DIR`
(`state.db`, `index.db`, `workflow.db`, `logs.db`). By default these open in
**WAL** journal mode, which is the right choice on a local disk but **cannot
run on a network filesystem** (NFS, SMB/CIFS, most networked Docker/Kubernetes
volumes, Azure Files). WAL maintains a `-shm` shared-memory wal-index that every
connection on the host must `mmap` together, and that mmap cannot be backed by a
network mount — so a WAL database on a share fails at open with `disk I/O error`
/ `SQLITE_IOERR_SHMMAP`, or worse, corrupts. This is the SQLite project's
[documented position](https://sqlite.org/wal.html) ("WAL does not work over a
network filesystem").

AKM solves this with the `AKM_SQLITE_JOURNAL_MODE` knob plus automatic
network-FS detection. **You usually do not need to set anything** — leave the
default and AKM does the right thing.

### How it works

- **Auto-detect (default).** At the `WAL` default, AKM probes the filesystem
  backing `AKM_DATA_DIR` (`statfs`). If it detects a network type (NFS, CIFS,
  SMB2, or a FUSE network mount), it transparently falls back to **`DELETE`**
  (rollback-journal) mode and prints a one-line warning. DELETE mode uses only
  `fcntl` byte-range locks plus a `-journal` sidecar — no shared-memory segment —
  so it is safe on a share.
- **Explicit override.** Set `AKM_SQLITE_JOURNAL_MODE` to force a mode and skip
  detection:

  | Value | Use when |
  |---|---|
  | `WAL` (default) | Local disk. Auto-falls-back to `DELETE` on a detected network mount. |
  | `DELETE` | A network share where you want to be explicit (or detection can't see the mount type). Rollback journal + `synchronous = FULL`. |
  | `TRUNCATE` | Like `DELETE` but truncates the journal instead of deleting it each commit — marginally faster on some filesystems. |

  Invalid values warn once and fall back to `WAL`. In `DELETE`/`TRUNCATE` mode
  AKM also sets `PRAGMA synchronous = FULL` for extra durability on the share;
  `busy_timeout = 30000` is kept in every mode.

### Recommended setup

Point `AKM_DATA_DIR` at a directory on the share. The default auto-detection
handles the rest; set the env var explicitly only if you prefer to be certain:

```sh
# e.g. AKM data on an Azure Files / NFS mount at /mnt/op-home/data/akm
export AKM_DATA_DIR=/mnt/op-home/data/akm
export AKM_SQLITE_JOURNAL_MODE=DELETE   # optional — auto-detected otherwise
akm index
```

This lets the AKM database subtree live on the same shared volume as the rest of
your application state (the original driver for this feature was running AKM
under OpenPalm on Azure Container Apps, whose only persistent volume option is
Azure Files).

### Important caveats

- **Single host only.** SQLite over a network filesystem is safe only when a
  single host accesses the database files. AKM is a CLI, so an interactive
  invocation and the scheduler cron run as separate processes — that is fine on
  one host (they coordinate through `fcntl` locks + `busy_timeout`), but do **not**
  point two machines / replicas at the same `AKM_DATA_DIR` on a share. Pin AKM to
  one replica. See SQLite's [Use Over a Network](https://sqlite.org/useovernet.html).
- **NFS locking.** Some older NFS servers have broken `fcntl` file locking. NFS
  v4.x (including Azure Files NFS v4.1) supports advisory byte-range locks and is
  the recommended target; `DELETE` mode relies on those locks.
- **Performance.** Rollback-journal mode + `synchronous = FULL` over a network
  mount is slower than local WAL. Keep the data dir on the lowest-latency share
  tier available; `index.db` rebuilds and `akm improve` runs will feel it most.
