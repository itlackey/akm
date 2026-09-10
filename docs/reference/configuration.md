# Configuration

AKM reads one user configuration file: `$XDG_CONFIG_HOME/akm/config.json`
(normally `~/.config/akm/config.json` on Linux and macOS, or
`%APPDATA%\akm\config.json` on Windows). Set `AKM_CONFIG_DIR` to override the
directory. Project `.akm/config.json` files are not merged. A config file may
optionally extend one other config via `extends` (see "Sharing configuration
across installs" below) — this is a single, explicit, user-opted-in key, not
automatic project-config discovery.

## Version 0.9

A present configuration file must set `configVersion` to a version this
binary knows: the current `"0.9.0"`, or a known older version it can
auto-upgrade in memory (see "Version read shim" below). Missing, newer,
numeric, and any other unrecognized version are rejected by ordinary
commands without rewriting the file — an older binary never guesses at a
newer, unknown shape. Pre-0.9 config and database layouts are not runtime
inputs and are not migrated by `akm upgrade`. Configure the current schema
directly. The standalone migrator exists only for explicit task migration:
task v2 to task v3, then task v3 to task source v4, in one pass.

### Version read shim

Like the task-source v2/v3 auto-shim (`akm migrate apply`'s in-memory
counterpart, documented under Migration below), a known older `configVersion`
is converted to the current shape in memory on load — with a one-line stderr
deprecation warning — rather than hard-failing every command. Nothing is
written back to disk by the shim itself; the very next config-mutating
command (`akm config set`, etc.) persists the upgrade for free, since every
config write already forces `configVersion` to the current value, which
silences the warning. A `configVersion` this binary does not recognize at
all — including anything newer than current — still fails closed with
`UNSUPPORTED_CONFIG_VERSION`.

As of this writing `"0.9.0"` is the only `configVersion` akm has ever
shipped, so there is no real older shape for the shim to convert yet; the
mechanism (`src/core/config/config-version-shim.ts`) is established ahead of
the first bump that will need it, per #863.

```jsonc
{
  "configVersion": "0.9.0",
  "$schema": "https://itlackey.github.io/akm/schemas/akm-config.json",
  "engines": {
    "fast": {
      "kind": "llm",
      "endpoint": "http://localhost:11434/v1/chat/completions",
      "model": "qwen3",
      "apiKey": "${LOCAL_LLM_API_KEY}"
    },
    "reviewer": {
      "kind": "agent",
      "platform": "opencode",
      "model": "anthropic/claude-sonnet-4-6"
    }
  },
  "defaults": {
    "engine": "reviewer",
    "llmEngine": "fast",
    "improveStrategy": "default"
  },
  "workflow": {
    "maxConcurrency": 8,
    "judgeEngine": "reviewer"
  },
  "improve": {
    "strategies": {
      "nightly": {
        "engine": "fast",
        "processes": {
          "reflect": {},
          "memoryInference": { "model": "qwen3-small", "llm": { "temperature": 0.1 } }
        }
      }
    }
  }
}
```

## Engines

`engines` is the only public execution map. An engine name is lowercase
kebab-case, at most 63 characters, and cannot start with `akm-`.

| Kind | Required fields | Use |
| --- | --- | --- |
| `llm` | `endpoint`, `model` | OpenAI-compatible chat completions |
| `agent` | `platform` | A registered dispatch-capable harness |

LLM endpoints must be complete `http://` or `https://` chat-completions URLs
ending in `/chat/completions`, without userinfo, query, or fragment. API keys
are symbolic only: `$VAR` or `${VAR}`. AKM resolves them only at dispatch.

An LLM engine may set `enableThinking: false` to turn thinking off and
`reasoningEffort` to a value such as `"none"`, `"low"`, or `"high"`. AKM sends
**both** wire forms — `chat_template_kwargs.enable_thinking` and top-level
`enable_thinking` — whenever `enableThinking` resolves, from engine config
or a calling process (improve's `consolidate`/`reflect` and the distill
quality gate always request `enableThinking: false` for a machine-readable
payload); `reasoningEffort` is always sent as top-level `reasoning_effort`
when set. Backend support: llama.cpp direct honors both forms
(`reasoning_effort` from build ≥ b10644); vLLM honors
`chat_template_kwargs`; Bifrost drops `chat_template_kwargs` and passes
`reasoning_effort` through, so also set `reasoningEffort: "none"` behind it; a
strict hosted API may 400 on unrecognized keys. Both fields are AKM-owned, not
settable via `extraParams`. A response with reasoning tokens despite
`enableThinking: false` triggers a runtime warning and the `akm health`
`thinking-control` advisory.

An agent engine may set `bin`, `args`, `workspace`, `model`, and `timeoutMs`.
Only `platform: "opencode-sdk"` may set `llmEngine`; it names
the LLM engine used as that SDK engine's fallback connection.

`platform: "opencode-sdk"` needs the **`opencode` binary** on PATH (or a `bin`
pointing at it). akm bundles `@opencode-ai/sdk`, but that package is an HTTP
client with no dependencies — it spawns `opencode serve` and talks to it — so
the npm dependency alone does not make the platform usable. Install the binary
with `npm i -g opencode-ai` or opencode's own installer.

### Model-map files

AKM ships an immutable `models.json` package asset with three intent aliases:
`fast`, `balanced`, and `reasoning`. The installed starter has separate
columns for Claude Code, OpenCode, and OpenCode SDK only. A provider-specific
identifier is not pretended to work on unrelated engines. Add mappings for
Gemini, Codex, named direct LLM engines, or other harnesses in your user file.
Config-root and per-engine `modelAliases` are rejected; this file is the only
alias definition surface.

An optional operator-owned file lives beside `config.json` at
`$XDG_CONFIG_HOME/akm/models.json` (or `<AKM_CONFIG_DIR>/models.json`). It uses
the same version-1 schema as the installed file:

```json
{
  "version": 1,
  "aliases": {
    "fast": {
      "gemini": "gemini-2.5-flash"
    },
    "reasoning": {
      "claude": {
        "inference": {
          "effort": "medium"
        }
      },
      "local-reasoner": {
        "model": "qwen3:30b",
        "inference": {
          "effort": "high"
        }
      }
    }
  }
}
```

Each engine mapping is either a non-empty exact model string or a structured
profile with the documented fields `model`, `inference`, and `engine`. A user
profile may omit `model` when the installed layer already supplies it, as the
partial Claude override above does. After overlay, every alias/engine entry
must have a usable model. Unknown profile fields are rejected; JSON-safe
fields inside `inference` are preserved for engine adapters to lower
optimistically.

A profile's `engine` field (0.9.15, #946) borrows a column's `model` (and, for
an `llm`-kind engine, its inference defaults) from a configured
`engines.<name>` connection instead of hand-typing a literal model a second
time:

```json
{
  "version": 1,
  "aliases": {
    "fast": {
      "opencode": { "engine": "local-fast" }
    }
  }
}
```

With `engines.local-fast` configured (agent-kind or llm-kind), this column
resolves to that engine's own `model` string. `model` and `engine` are
mutually exclusive on the same profile — `engine` is an indirection for the
model value, never an engine-selection override; which engine `akm agent`
dispatches to is still decided entirely by `--engine`/`defaults.engine` (see
[Engine selection](#engines)). The referenced engine's `model` must itself be
literal, not another alias, and akm copies it verbatim: it does not translate
between an engine's connection and an agent platform's own provider registry,
so the value must already be meaningful for the column's platform (e.g. a
`kind: "agent", platform: "opencode"` engine's `model` should already be a
string opencode itself understands, such as `krang/qwen3.5-9b`). Run
`akm models list` to see, for every alias/column, the resolved model and
whether it came from the installed defaults, the user overlay, and a literal
value or an `engine` reference.

The user file overlays the installed file by alias, engine, and nested object
field. Objects merge recursively. Arrays, scalars, and explicit `null` replace
the lower value; omitted fields preserve it. A layer setting a literal `model`
clears any `engine` inherited from a farther layer, and vice versa — the
nearer layer's choice of literal-vs-engine always wins outright rather than
merging. Alias and engine keys are case-normalized, and case-colliding
definitions are rejected. Unknown model inputs still pass through
byte-for-byte as exact identifiers. Once a name is a known merged alias,
selecting an engine with no mapping is an actionable configuration error
rather than silently sending the alias as a model ID.

The common execution cascade reads these files for current direct command and
non-interactive agent calls, task source v4 runs, and improve/proposal/index
model work routed through that resolver. A structured alias expands as
defaults at the layer that selected it; explicit sibling fields and nearer
layers still win. The resulting request carries the exact model ID and merged
inference object. Engine lowerers consume that exact selection and never run
alias resolution again. New workflow starts persist the exact request and
symbolic runner selection in the durable plan v4 family's executable
`irVersion: 5`; resume consumes that frozen material without resolving aliases
again.

Copy the complete installed starter into the user configuration directory when
you want to customize all fields:

```sh
akm models copy-defaults
akm models copy-defaults --overwrite  # explicit replacement confirmation
```

The command validates the installed asset, creates the config directory, and
writes a fully synced sibling before publication. Without `--overwrite`, a
hard-link/no-replace operation makes publication atomic: a racing creator wins
without losing its bytes. A filesystem that cannot provide that operation
fails safely instead of falling back to a clobbering rename.

With `--overwrite`, the portable guarantee is an atomic pathname replacement
that never follows the target when it is a symlink. AKM verifies the observed
regular-file identity again immediately before rename, but the portable
filesystem APIs do not provide a conditional compare-and-swap rename. Another
process can still change the directory entry after that check; AKM replaces
the entry at the pathname without dereferencing it. Consequently,
`overwritten: true` means overwrite was requested for an entry AKM observed,
not that an inode identity was transactionally locked. Symlinks and other
non-regular targets observed at either check are refused.

AKM does not auto-create or sync this file, and authoritative defaults never
live in the cache. npm/Node and normal Bun installs read the packaged
`dist/assets/models.json` lazily, so `akm health` can report a missing or
malformed package asset as a `model-map-files` failure. A standalone binary has
the same authoritative bytes embedded at compile time and therefore has no
external model-map asset that can later disappear; its health check validates
the embedded copy, and release tests pin copied bytes to `src/assets/models.json`.
The health check passes when the optional user file is absent and warns with
its path and JSON location when the user file is unreadable or invalid.

`defaults.engine` names an LLM or agent engine. `defaults.llmEngine` must name
an LLM engine. There is no first-engine fallback: an unset `defaults.engine`
never resolves to some arbitrary entry in `engines`. It resolves instead to a
synthesized, config-free `opencode-sdk` engine when the `opencode` binary is on
PATH — announced once per run, and preempted by any `opencode-sdk` engine you
configure yourself. Naming an engine that is not configured is always an error
and is never rescued by that fallback.

Index passes select engines through `index.defaults.engine` or
`index.<pass>.engine`. Per-pass `model`, `timeoutMs`, and `llm` fields are
invocation overrides; `enabled: false` disables that pass. Connection fields
such as `endpoint`, `provider`, `apiKey`, and `apiKeyFile` belong only on
named engines.

`workflow.maxConcurrency` is the native workflow engine ceiling. An explicit
value is clamped to `1..64`. When absent, AKM derives the cap once from the CPU
count (`min(16, max(1, cores - 2))`) and freezes it into the run plan, so resume
does not change policy on a different host or after config edits.

`workflow.defaultMapConcurrency` is the width a `map` step freezes when it
declares no `concurrency:` of its own. Unset means **4** — map steps are
parallel by default as of 0.9.1. An explicit value is clamped to `1..64`; set
it to `1` to restore the pre-0.9.1 serial-by-default fan-out for every workflow
on this machine. It is only a default: an authored `map.concurrency` always
wins, and it never raises a step past `workflow.maxConcurrency`, the selected
engine's `concurrency`, or the host CPU cap. An LLM engine that declares no
`engines.<name>.concurrency` gets **1** on a loopback endpoint (a local model
server holds one loaded model) and **4** on a remote one.

`workflow.judgeEngine` names the LLM or agent engine used to verify every
non-empty workflow `### gate` rubric. It is required when a workflow declares
completion criteria and is frozen into each new run, so later config edits do
not change an in-flight run's verifier. Missing, failed, or malformed verifier
results reject the gate; criteria are never silently bypassed.

## Strategies

Improve presets live under `improve.strategies`; invoke one with
`akm improve --strategy <name>`. The selection order is `--strategy`,
`defaults.improveStrategy`, then built-in `default`. A strategy and each process
can select `engine`, `model`, `timeoutMs`, and LLM request overrides:

```jsonc
{
  "improve": {
    "strategies": {
      "nightly": {
        "engine": "fast",
        "processes": {
          "reflect": { "llm": { "temperature": 0.2 } },
          "graphExtraction": { "model": "qwen3-small" }
        }
      }
    }
  }
}
```

LLM-only improve processes require an LLM engine; an explicit invalid or
incompatible engine never falls back to another engine. Built-in strategies
are complete presets. User-defined strategies inherit omitted fields from the
built-in `default` strategy before applying their own overrides.

`processes.triage.judgment` explicitly controls the optional judgment tier.
Use `true` to enable it, `false` to disable it, or an object with `enabled`,
`engine`, `model`, `timeoutMs`, and/or `llm` overrides. Existing object values
such as `{}` and `{ "engine": "reviewer" }` remain enabled by default. Unknown
object keys are rejected so misspellings cannot silently change execution;
the retired `mode` and `profile` keys continue to report their engine migration
guidance. When enabled, engine selection is judgment → triage → strategy →
`defaults.llmEngine`, and resolution fails closed if none is available.

```jsonc
{
  "improve": {
    "strategies": {
      "nightly": {
        "processes": {
          "triage": {
            "enabled": true,
            "judgment": { "enabled": true, "engine": "reviewer" }
          }
        }
      }
    }
  }
}
```

The shipped `default` and `frequent` strategies keep improve-stage session
extraction off. `proactiveMaintenance` is off in `default` and
`reflect-distill`; run `akm improve --strategy proactive-maintenance` to use the
dedicated opt-in preset. Because strategies inherit from `default`, a preset
that omits either process also inherits the off value. User strategy overrides
are applied last, so an explicit `enabled: true` still opts the selected
strategy in.

These improve-stage defaults do not gate explicit standalone extraction through
`akm proposal extract --type <harness>` or `akm proposal extract --auto`. The interactive
scheduled-task step also continues to offer the bundled `core/extract` template
as an unselected opt-in; it is not installed merely because the template is
bundled.

## Indexing

AKM-native Markdown contributes a normalized body projection to the
lowest-weight `content` search field. The projection is capped at 16,384
characters, removes frontmatter, comments, fenced code, and link destinations,
and is never produced for secret, env, session, or session-checkpoint assets.
Embedding input is separately capped at 8,192 characters with structured
metadata placed before body content.

## Semantic search

`semanticSearchMode` (top-level, `"off" | "auto"`, default `"off"`) gates
embedding-based search. `"auto"` lets AKM set up embeddings (which downloads
a local model unless you point `embedding` at a remote provider) and falls
back to keyword-only FTS if the embedding runtime is unavailable; `"off"`
disables semantic search outright and search is always keyword-only FTS.
If a backend marked ready cannot serve a query, search still returns the FTS
results but reports `searchMode: "fts-fallback"` and one sanitized warning.
This is distinct from `searchMode: "keyword"`, which is the normal result when
semantic search is disabled or has not been built. A read-only sandbox that
cannot record best-effort usage telemetry does not by itself mark search as
degraded.
The npm/Bun package declares `@huggingface/transformers` as a normal dependency.
AKM imports that external package directly; it does not carry a copied runtime
under `src/` or `dist/`. If the dependency is unavailable, reinstall `akm-cli`
or configure a remote `embedding.endpoint`. Setup does not mutate a global
installation to add runtime packages.
The default is `"off"` so a bare or headless install (`akm bundle create`, `--yes`,
`--config`) never silently downloads the local embedding model on first
index.
The interactive `akm setup` wizard pre-selects semantic search **on**
regardless of this default, and warns that choosing it downloads the model
unless a remote `embedding` config is provided.

```jsonc
{ "semanticSearchMode": "off" }
```

`embedding` configures the connection used for semantic search and
`akm improve`'s memory-inference/consolidate passes when they call an
embedding model: `provider`, `endpoint`, `model`, `apiKey` (symbolic
reference, same rules as engine `apiKey`), `dimension`, `localModel`,
`maxInputTokens`, `maxTokens`, `batchSize`, `contextLength`, `timeoutMs`,
`concurrency`, and `ollamaOptions.num_ctx`.

The knobs that bound request/document size and rate, all optional (defaults
apply when unset), for a remote endpoint (`src/llm/embedders/remote.ts`):

| Key | Default | Bounds |
| --- | --- | --- |
| `embedding.maxInputTokens` | `512` | Per-DOCUMENT cap, applied before batching (#956). A document's embedded text is truncated to its head (unicode-safe) at this many estimated tokens instead of ever being skipped for size alone — a document is skipped only when its truncated head is empty. |
| `embedding.maxTokens` | `6000` (`DEFAULT_TOKEN_BUDGET`) | Per-REQUEST token budget: how many (already-capped) documents' estimated tokens fit in one HTTP request. With the 512-token default document cap, a request carries about 11 documents by default. Lowered from 8000 to 6000 (#954): the 4-chars-per-token estimator undercounts dense technical text by 7-55%, so 8000 regularly overshot an 8192-token endpoint's real context window. |
| `embedding.batchSize` | `100` | Per-REQUEST document-COUNT safety cap, independent of the token budget — guards against many tiny documents packing an oversized request. |
| `embedding.contextLength` | unset | Ollama's `num_ctx` ONLY, forwarded verbatim as `options.num_ctx` on the native `/api/embed` request. Does **not** feed the request token budget above (#956) — the two used to share this one field, so setting it for the server's context window silently changed request batching too. |
| `embedding.timeoutMs` | `120000` (120s) | Per-request wall timeout — see below. |
| `embedding.concurrency` | `1` loopback / `2` remote | In-flight request window — see below. |

**Which knob fixed the field's 8k-context overflow, worked examples.** A
0.9.15-beta field report described documents estimated under the request
budget that still tokenized to 8.5k-12.4k real tokens against an
8192-token endpoint, because the 4-chars-per-token estimator undercounts
dense technical text. Three knobs changed shape between beta and this
release; only one of them makes that overflow structurally unreachable:

- `embedding.maxInputTokens: 512` — per-DOCUMENT cap, applied before
  batching. Example: a 6,000-character API reference page is truncated to
  its first ~2,000 characters (512 estimated tokens) before it is ever
  counted toward a request. This is the fix for the original overflow: no
  single document can contribute more than 512 estimated tokens to a
  request, no matter how `maxTokens` or `contextLength` are set.
- `embedding.maxTokens: 6000` — per-REQUEST budget: how many already-capped
  documents' estimated tokens fit in one HTTP request. Example: with the
  default 512-token document cap, a request packs about 11 documents before
  this budget is reached and the request is sent; if the run's first
  request is still rejected for exceeding the endpoint's real context
  window, akm shrinks this budget to three quarters of its value (floored
  at twice `maxInputTokens`) for every later request in the same run. A
  request-level budget alone cannot stop one oversized document from
  overflowing a request — only the per-document cap above does that.
- `embedding.contextLength: 8192` — Ollama's `num_ctx` only, forwarded
  verbatim on a native `/api/embed` request. It has no effect on request or
  document sizing, and no effect at all against a non-Ollama endpoint — see
  below for why that used not to be true.

A field config of `contextLength: 8192` + `maxTokens: 8000` (the exact
0.9.15-beta values from the original report) produces no 400s on 0.9.15:
`maxInputTokens` (512, new this release) caps every document before it is
counted, so the original 8.5k-12.4k-token documents that overflowed the
8192-token endpoint can never reach the request budget in the first place —
independent of whatever `maxTokens` or `contextLength` are set to.

`embedding.timeoutMs` (positive integer, default `120000` — 120s) is the
budget for a request at the FULL token budget (`embedding.maxTokens`); a
local model server on a large, token-budget-bounded batch legitimately takes
longer than the prior fixed 30s cut off. A smaller request gets a
proportionally smaller timeout —
`clamp(timeoutMs × requestTokens / tokenBudget, 30000, timeoutMs)` — so a
dead endpoint is still detected in seconds on the common case of small
documents. Set `embedding.timeoutMs` lower to fail fast against a
known-fast endpoint, or higher for a slow local server on large batches.

`embedding.maxTokens` (or its default) is also a run-scoped adaptive
starting point, not a hard ceiling (#954): on the FIRST rejection of an
`akm index` run for exceeding the endpoint's context window, akm shrinks
the request budget to three quarters of its current value — floored at
twice `embedding.maxInputTokens` — for every request not yet sent, and
prints one line naming the new value. This never changes the rejected
request's own split-and-retry (below), never shrinks a second time in the
same run, and never grows the budget back up. Users who set
`embedding.maxTokens` explicitly are unaffected by the LOWERED DEFAULT
above but still benefit from this same-run recovery if their own value
turns out to be too high for the endpoint.

A request TIMEOUT (not a rejection for exceeding the context window) never
drops its batch immediately: field confirmation showed that once akm
abandons a timed-out request, the endpoint (e.g. llama-server) keeps
computing it anyway, so dropping it right away just grows the provider's
queue while every following batch dies the same way. Instead akm backs off
(5s, doubling, capped at 60s) and retries the same request once; a second
timeout splits it in half and retries each half the same way, down to
individual documents, and a single document that still times out is finally
skipped (logged at the default `warn` level). After 3 consecutive failures
at single-document size (timeout or network error), or 3 consecutive
network errors at any size, the embedding phase stops dispatching further
requests and reports failure — batches already committed are kept; rerun
`akm index` once the endpoint is healthy.

`akm index` keeps a small number of `/v1/embeddings` requests in flight at
once (a remote endpoint only; the local transformer path is unaffected):
`1` for a loopback endpoint (`localhost`, `127.0.0.0/8`, etc. — a local
model server serves one inference at a time, and parallel requests thrash
it) and `2` for a remote one, unless `embedding.concurrency` (positive
integer, 1-16) overrides it. This default holds for the overwhelming
majority of setups; set the override only for an endpoint that genuinely
serves parallel requests — a local server started with a multi-slot flag
(llama.cpp's `--parallel N`, vLLM) — not to "speed up" an ordinary
single-slot model server, which the default already protects from
reload-thrash. Request SIZE remains the first throughput lever regardless:
`embedding.batchSize` (a document-count cap, default 100) together with
`embedding.maxTokens` (an estimated token budget per request, default 6000
— NOT `embedding.contextLength`, see the table above) control how many
documents land in one request — with the default 512-token
`embedding.maxInputTokens` document cap, that is about 11 documents,
taking about the same wall time as a single one against a healthy endpoint.

## Search tuning

`search` tunes ranking, not behavior an ordinary user needs to touch:

| Key | Purpose |
| --- | --- |
| `search.minScore` | Drop results below this score |
| `search.defaultExcludeTypes` | Asset types excluded from results by default |

### Graph boost search tuning

| Key | Purpose |
| --- | --- |
| `search.graphBoost.*` | Entity-graph relevance boost: `directBoostPerEntity`/`directBoostCap` (directly related entities), `hopBoostPerEntity`/`hopBoostCap` (multi-hop, capped at `maxHops` ≤ 3), `confidenceMode` (`blend`, the only supported value), `confidenceWeight` (0–1, default `0.2`) |

## Feedback

`feedback` shapes the `akm feedback` taxonomy:

| Key | Purpose |
| --- | --- |
| `feedback.requireReason` | Whether `akm feedback --negative` without `--reason`/`--failure-mode` is a hard error. **Defaults to `true`** when unset — set `false` to downgrade the check to a warning instead |
| `feedback.allowedFailureModes` | Restrict `--failure-mode` values accepted by `akm feedback`. Curated set (also the default when unset): `incorrect`, `outdated`, `dangerous`, `incomplete`, `redundant` |

## Bundles and write target

`bundles` (replacing the retired `stashDir`/`sources[]`/`installed[]` trio)
and `defaultBundle` are the 0.9 source configuration shape — see
[Concepts](https://github.com/itlackey/akm/blob/main/docs/guides/concepts.md) and the [CLI reference](cli.md) for the
full bundle model (`path`, `git`, `website`, `npm`, `writable`, `registryId`,
`components`). `defaultBundle` must name a key in `bundles` when set. A
bundle's `components.<id>.adapter` key pins it to a specific format adapter
instead of relying on auto-detection — see [Bundle Types](bundle-types.md)
for the full adapter list and what each one reads/writes.

### defaultWriteTarget

`defaultWriteTarget` names the bundle that write commands (`akm remember`,
`akm env`/`secret create`, `akm improve`, etc.) fall back to when no
explicit destination flag is given and the command isn't already scoped to a
specific source. It must name a configured bundle; setting it with no
`bundles` configured, or naming an unconfigured bundle, is rejected at
`config set` (or config load) time. The full write-target resolution order
is the command's destination flag (`--bundle` on `remember`/`clone`/
`improve`, `--target` on `env`/`secret create`) -> `defaultWriteTarget` ->
working bundle (`defaultBundle`) -> `ConfigError`.

### Memory scope

`akm remember`'s scope flags (`--user`, `--agent`, `--run`, `--channel`)
write four canonical top-level frontmatter keys on the memory file:
`scope_user`, `scope_agent`, `scope_run`, `scope_channel` (one key per
non-empty scope value; string values). This is not a config-file setting —
it is documented here because it is the multi-tenant/multi-agent contract
that `akm search --filter` and `akm show --filter` read back:
`--filter user=<id>` / `--filter agent=<id>` / `--filter run=<id>` /
`--filter channel=<name>` (repeatable) narrow results/resolution to assets
whose frontmatter scope matches, without changing ranking. A memory with
only scope flags and no tags is valid — the tag-required check is
independent of scope. `--scope` was removed in 0.9.0 with no alias; use
`--filter`.

`archiveRetentionDays` (default `90` when unset) controls how long a pending
proposal is kept before `akm improve`'s maintenance pass archives it (status
`rejected`, reason `"expired: no action within retention window"`) — `akm
proposal` itself has no archive/expire verb. Setting it to `0` or less
disables expiry entirely.

## Registries

`registries` (top-level array, distinct from `bundles`) lists remote package
registries `akm registry`/`akm bundle add` can search and install from.
Each entry is `{ url, name?, enabled?, provider?, options? }`; `provider`
defaults to `"static-index"`. See [Registries](https://github.com/itlackey/akm/blob/main/docs/reference/registry.md) for the full
field reference and provider list.

Registry `url` values must not contain username/password userinfo. The built-in
providers do not currently support authenticated registry requests; `options`
does not add an authentication mechanism. Use a credential-free HTTPS endpoint.

## Output defaults

`output.format` (one of `json`\|`yaml`\|`text`\|`jsonl`\|`md`\|`html`,
default `json`) and `output.detail` (`brief`\|`normal`\|`full`, default
`brief`) set the CLI's default `--format`/`--detail` when the flags are
omitted. Per-command flags always override these.

## Setup-derived recommendations

`setup` is reserved for configuration derived by `akm setup`. It currently
holds no keys — the `setup.taskSchedules` sub-key was removed in 0.9.0 after
nothing in the setup flow or the tasks subsystem was found to read or write
it. Scheduling lives in the tasks subsystem (`akm task`).

## Experimental opt-ins

`experimental` holds explicit opt-ins for behavior outside the 0.9
stability contract (see [STABILITY.md](../../STABILITY.md) for full
classification). Every key defaults to **off**; an absent `experimental`
section, an absent key, and an explicit `false` all read identically as off.

```jsonc
{
  "experimental": {
    "improveAutonomy": false
  }
}
```

- **`experimental.improveAutonomy`** — gates only the autonomous
  `memoryInference`, `triagePromote`, and `memoryCleanup` lanes. `akm improve`
  itself always runs; this only gates mutations without a human in the loop.
  Consolidation is not gated: it remains advisory and emits reviewable
  proposals. `sync.push` is deliberately **not** gated by this key.

## Managing Config

```sh
akm config list
akm config get engines.fast
akm config set engines.fast '{"kind":"llm","endpoint":"http://localhost:11434/v1/chat/completions","model":"qwen3"}'
akm config set engines.fast.apiKey '$LOCAL_LLM_API_KEY'
akm config unset engines.old
```

Object values passed to `config set` deep-merge with their current value.
Arrays replace, `null` is only valid for nullable fields, and `config unset` is
the only deletion operation. `configVersion` cannot be set or unset with the
generic walker.

`config get <key> --show-source` wraps the (redacted) value as
`{ value, source }`, where `source` is `"local"` when the local file's own
JSON sets the key, `"extends:<ref>"` for the nearest `extends` chain member
that sets it, or `"default"` when neither does. It is opt-in — plain
`config get` keeps its Stable, script-safe bare-value shape.

### Sharing configuration across installs

Five hosts running the same fleet often carry an identical `engines` map and
`improve.strategies` block, differing only in credential delivery (`apiKey`
vs `apiKeyFile`), bundle paths, and cron offsets. Hand-syncing that block
across hosts drifts silently. `extends` fixes this: put the shared block in
one file, and have each host's local config extend it.

```jsonc
// bundles/fleet/config/shared.json — versioned with the bundle, shared by every host
{
  "configVersion": "0.9.0",
  "engines": {
    "fast": { "kind": "llm", "endpoint": "https://api.example.test/v1/chat/completions", "model": "qwen3" }
  },
  "improve": { "strategies": { "nightly": { "engine": "fast" } } }
}
```

```jsonc
// ~/.config/akm/config.json — this host's local file, under 20 lines
{
  "configVersion": "0.9.0",
  "extends": "fleet//config/shared.json",
  "bundles": {
    "fleet": { "git": "https://github.com/example/fleet-bundle.git" },
    "stash": { "path": "~/akm-stash", "writable": true }
  },
  "defaultBundle": "stash",
  "engines": { "fast": { "apiKeyFile": "/run/secrets/fast-api-key" } }
}
```

`extends` accepts either form:

- A filesystem path — relative paths resolve against the directory of the
  config file that declares them; a leading `~` expands.
- A `bundle//<path>` ref — a plain file path *relative to that bundle's
  content root* (e.g. `config/shared.json`), resolved through the bundle's
  configured `path`, not the search index — so it never needs `akm index` to
  have run. This is not an asset ref: the path after `//` needs no asset type
  (`scripts/`, `knowledge/`, …) and the shared file is never indexed; it can
  live anywhere under the bundle. An empty, absolute, or content-root-escaping
  path is rejected. Only a filesystem bundle (`bundles.<id>.path`) can host an
  `extends` source; sync a `git`/`website` bundle with `akm bundle
  add`/`akm sync` first so the file is materialized locally, then point
  `extends` at it.

There is no `extends: <url>` form: config load is synchronous and runs on
every invocation, and akm deliberately does not fetch network resources at
load time (the same reason `registries` is never fetched until a
registry-touching command runs). A URL-backed shared config should be synced
as a `git`/`website` bundle and referenced as `extends: bundle//<path>`
once materialized, reusing the sync machinery akm already has instead of a
second one inside config load.

The base config runs through the exact same load pipeline as the local
file — its own version shim, its own legacy-shape shim — so it can carry an
older `configVersion` independently, and it may itself set `extends`
(chained). Cycle detection (`ConfigError`, "extends cycle detected") stops A
extends B extends A instead of recursing forever. Merge order is
`DEFAULT_CONFIG` (outermost) → the resolved `extends` chain → the local
file's own keys (local always wins) — the same `deepMergeConfig` "override
wins" semantics `config set` already uses. A referenced file/bundle that does
not already exist locally is a load-time `ConfigError` naming the ref — akm
never fetches or syncs one on your behalf.

`akm config diff <path|bundle//path>` compares this host's EFFECTIVE
config (its own `extends` already applied) against another config file or
bundle-relative file (loaded through the same loader, so ITS `extends` is
honoured too), printing sorted `{ path, local, other }` rows for every leaf
that differs. Both sides are redacted the same way `config get`/`list` are
before comparison, so a differing secret never round-trips into the diff
output. Cross-host comparison (`ssh host2 akm config diff ...` in a loop) is
left to the operator; akm has no concept of a networked fleet to compare
against directly.

```sh
akm config diff ~/other-host/config.json
akm config diff fleet//config/shared.json
```

## Environment

| Variable | Purpose |
| --- | --- |
| `AKM_CONFIG_DIR` | Override the user config directory (or set `XDG_CONFIG_HOME`) |
| `AKM_ENGINE_<NAME>_API_KEY` | Fallback credential for LLM engine `<name>` |
| `AKM_LLM_API_KEY` | Fallback only for the selected `defaults.llmEngine` |
| `AKM_EMBED_API_KEY` | Embedding credential |
| `AKM_BUNDLE_DIR` | Override the bundle directory |
| `AKM_DATA_DIR` | Override the data directory — `index.db`, durable `state.db`, and `akm.lock` (or set `XDG_DATA_HOME`) |
| `AKM_CACHE_DIR` | Override the cache directory — regenerable caches (or set `XDG_CACHE_HOME`) |
| `AKM_STATE_DIR` | Override the state directory — task-scheduler invocation state, and (per stash) `akm improve`'s machine-local writers and whole-run lock (or set `XDG_STATE_HOME`) |
| `AKM_SQLITE_JOURNAL_MODE` | SQLite journal mode: `WAL` (default), `DELETE`, or `TRUNCATE` |
| `AKM_VERBOSE` | Truthy value enables the same diagnostics as `--verbose` |
| `AKM_DEBUG` | `1` prints a stack trace on unexpected internal errors |

For an engine named `fast`, its fallback variable is
`AKM_ENGINE_FAST_API_KEY`. An explicit `apiKey` symbolic reference is
authoritative and does not fall through to another variable.

`engines.<name>.apiKeyFile` is a file-backed alternative to `apiKey`, for a
host that refuses to put secrets in the process environment (a container
runtime's mounted secret, for example). It is a plain filesystem path — `~`
expands to the home directory — read at dispatch time and trimmed of one
trailing newline; the raw path is safe to keep in `config.json` since it is
not itself a secret. Setting both `apiKey` and `apiKeyFile` on the same
engine is rejected. A missing, unreadable, or empty file fails the call
closed, naming the engine and path but never the file's content.

`engines.<name>.apiKey` also accepts `secret://<name>`, a reference into
AKM's own secret store (`akm secret set <name> --from-file <file>`), for a
launch context where the credential's environment variable is deliberately
not sourced into the process — a scheduled task's crontab preamble, or a
container entrypoint that keeps the user's env out on purpose — and a
file-backed credential is not an option. Like `apiKeyFile`, only the
reference is kept in `config.json`; the store lookup happens at dispatch
time, and an unresolved reference fails the call closed, naming the
reference but never the value. `akm improve`, workflow LLM steps, and `akm
health`'s engine probes all resolve `secret://` the same way direct LLM and
embedding calls have since 0.9.13 (#917); resolution order for a single
`apiKey` field is: an env reference (`$VAR`/`${VAR}`) first, then
`apiKeyFile`, then `secret://<name>` — though in practice a config sets only
one of the three per engine.

`embedding.apiKey` accepts the same three forms and resolves `secret://` the
same way, on every path that sends an embedding request: `akm index`
(including its `bundle update` post-commit embedding pass and the targeted
re-embed a write command like `akm remember` triggers), `akm improve`'s
consolidate pass (memory dedup and similarity clustering), and the
fingerprint-rename canary `akm index` runs when the embedding config
changes. All of them build the
provider request through the same `RemoteEmbedder`/`resolveSecret` boundary,
so a `secret://` reference resolves identically regardless of which command
triggered the request (#953).

Use `AKM_SQLITE_JOURNAL_MODE=DELETE` or `TRUNCATE` when WAL is unavailable,
such as on some NFS/SMB mounts. With the default `WAL` setting, AKM detects a
network filesystem for the data directory and falls back to `DELETE`.

## Retired Configuration

`profiles`, `llm`, `agent`, `features`, `stashes`, `defaults.llm`,
`defaults.agent`, and `defaults.improve` are rejected in 0.9. Recreate the
configuration using `engines`, `defaults.engine`, `defaults.llmEngine`, and
`improve.strategies`; AKM deliberately does not infer or rename ambiguous
profile identities.

`embedding.chunkSize` was never read by anything under `src/` (#954), so a
config that still sets it is simply ignored — it still loads, unvalidated
and without warning.
