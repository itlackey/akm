# Engine and Strategy Refactor

> **ARCHIVED (2026-07-18) — shipped in 0.9.0.** The engine/strategy/workflow
> cutover this plan specified is live: named `engines` (`src/core/config/`),
> `improve.strategies` (`src/assets/improve-strategies/`), and workflow IR
> compile/freeze (`src/workflows/ir/`). `profiles.llm`/`profiles.agent` are gone.
> Current truth: `docs/technical/architecture.md` + `docs/technical/configuration.md`.

**Status:** Implementation-ready proposal
**Target:** AKM 0.9.0
**Verified against:** `980e8d0a` (`0.9.0-rc.1`)
**Current architecture authority:** `docs/technical/architecture.md`

This document is the binding implementation plan for the 0.9 engine,
strategy, and workflow execution cutover. It does not describe the currently
shipping pre-cutover architecture at the verified RC baseline. The entire
cutover lands in one PR before the final 0.9.0 release. Update current
architecture, configuration, workflow, CLI, and storage documentation in that
same PR.

## Decision Summary

AKM 0.9 makes one clean public-model change:

- replace `profiles.llm` and `profiles.agent` with one named `engines` map;
- replace improve profiles with `improve.strategies`;
- replace public execution selectors named `runner`, `mode`, or `profile` with
  `engine`;
- make workflow YAML v2 select engines and compile to strictly decoded IR v3;
- freeze allowlisted, non-secret execution settings in each workflow run;
- retain the existing internal `RunnerSpec`, `executeRunner()`,
  `UnitDispatcher`, and harness registry seams;
- preserve historical database rows without relabeling or translating them.

This is a schema and vocabulary cutover, not an engine framework. Do not add an
`Engine` class, execution service, dependency-injection container, plugin API,
adapter registry, generic strategy interface, or fourth `RunnerSpec` kind.

## Fixed Product Decisions

The following decisions are not reopened during implementation:

1. The public execution term is **engine**.
2. The public improve-preset term is **strategy**.
3. Public engine kinds are exactly `llm` and `agent`.
4. SDK execution is selected by an agent engine's platform and remains the
   internal `RunnerSpec.kind: "sdk"` path.
5. Config 0.9 does not automatically translate profile-based configuration.
6. Removed config keys, CLI flags, workflow fields, and IR versions have no
   compatibility aliases in production parsing.
7. Workflow execution supports IR v3 only. IR v2 plans are not converted or
   executed by 0.9.
8. A workflow snapshot freezes resolved non-secret execution settings, not
   merely engine names.
9. Secret values remain late-bound and never enter workflow plans or hashes.
10. Storage changes are append-only and preserve historical meaning.

Public selectors and identities use `engine`. Internal code may continue to use
`RunnerSpec` and the runtime-kind values `llm | agent | sdk`. Public diagnostics
name that resolved implementation field `runtimeKind`, not `runner`.

## Expert Review Resolution

The review team disagreed on several points. These are the final resolutions.

| Dispute | Decision | Reason |
| --- | --- | --- |
| Automatic config translation | Rejected | The cutover explicitly requires manual recreation. Unified-map name collisions and external task/workflow references make automatic renaming unsafe. |
| Keep old CLI/YAML aliases for one release | Rejected | Aliases retain the vocabulary ambiguity this refactor removes. |
| Freeze only engine names | Rejected | It would preserve current config and model-alias drift during resume. |
| Serialize `RunnerSpec` | Rejected | It is a runtime object that can contain resolved credentials and implementation details. |
| Inline a full snapshot on every node | Rejected | A plan-local immutable engine catalog avoids duplication while remaining fully covered by `plan_hash`. Per-invocation overrides stay on nodes. |
| Remove `UnitDispatcher` | Rejected | It is the existing workflow application seam and keeps workflow tests independent from child processes and SDK servers. |
| Rename existing storage columns | Rejected | Existing `runner` and `profile` values have historical meanings that are not engine or strategy identities. |
| Add a generic capability framework | Rejected | A small static improve-process matrix and existing harness capability fields are sufficient. |
| Add workflow gate engine syntax now | Rejected | Existing YAML has no judge selector. IR v3 freezes the current `defaults.llmEngine` judge without expanding source syntax. |

## Target Configuration

```jsonc
{
  "configVersion": "0.9.0",
  "engines": {
    "fast": {
      "kind": "llm",
      "endpoint": "http://localhost:11434/v1/chat/completions",
      "model": "qwen3",
      "apiKey": "${LOCAL_LLM_API_KEY}"
    },
    "reviewer": {
      "kind": "agent",
      "platform": "pi",
      "model": "claude-sonnet-4-6"
    },
    "sdk-reviewer": {
      "kind": "agent",
      "platform": "opencode-sdk",
      "model": "anthropic/claude-sonnet-4-6"
    }
  },
  "defaults": {
    "engine": "reviewer",
    "llmEngine": "fast",
    "improveStrategy": "default"
  },
  "improve": {
    "strategies": {
      "default": {
        "engine": "fast",
        "processes": {
          "reflect": {},
          "memoryInference": {
            "model": "qwen3-small",
            "llm": { "temperature": 0.1 }
          },
          "graphExtraction": {
            "graphExtractionBatchSize": 4,
            "llm": { "extraParams": { "seed": 7 } }
          }
        }
      }
    }
  },
  "index": {
    "defaults": { "engine": "fast" },
    "graph": {
      "model": "qwen3-small"
    }
  }
}
```

The example uses one OpenAI-compatible `fast` engine for improve reflection,
memory inference, graph extraction, and standalone indexing. Deeper sections
override only the invocation settings they need.

### Identifier Grammar

Engine and strategy names use the same grammar:

```text
^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$
```

Names are case-sensitive, are at most 63 characters, and are not normalized.
This grammar keeps YAML references simple and makes derived environment names
collision-free. Names beginning with `akm-` are reserved for future built-ins.

### Engine Schema

Build the discriminated Zod union from the current connection fields rather
than introducing a generic `options` object.

```ts
type LlmEngineConfig = {
  kind: "llm";
  provider?: string;
  endpoint: string;
  model: string;
  apiKey?: string; // only $VAR or ${VAR}
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number | null;
  concurrency?: number;
  supportsJsonSchema?: boolean;
  extraParams?: JsonObject;
  contextLength?: number;
  enableThinking?: boolean;
};

type AgentEngineConfig = {
  kind: "agent";
  platform: HarnessId;
  bin?: string;
  args?: string[];
  workspace?: string;
  model?: string;
  timeoutMs?: number | null;
  modelAliases?: Record<string, string>;
  llmEngine?: string; // opencode-sdk connection fallback only
};
```

Requirements:

- `endpoint` and `model` on LLM engines are non-empty.
- LLM endpoints are complete OpenAI-compatible chat-completions URLs. They must
  use `http://` or `https://`, have no query or fragment, and their parsed
  pathname must end in `/chat/completions`. URL username and password fields
  must be empty.
- Literal API keys and `${VAR:-literal}` forms are invalid in 0.9 config.
- Agent `platform` must be a canonical `VALID_HARNESS_IDS` value whose harness
  has `capabilities.agentDispatch === true`.
- `kind: "sdk"` is invalid public configuration.
- Agent engines do not duplicate LLM endpoint or API-key fields. The
  `opencode-sdk` runtime receives its OpenAI-compatible connection from
  `agent.llmEngine`, then `defaults.llmEngine`. The selected agent engine's
  `model` may override the referenced LLM engine model without copying its
  endpoint or credentials.
- `llmEngine` is valid only on `platform: "opencode-sdk"`, must name an LLM
  engine, and is forbidden on CLI agent platforms. `args` is forbidden for
  `opencode-sdk`; `bin` is its server executable and defaults to `opencode`.
- Preserve `.passthrough()` on config objects for same-version extension data.
  Keep `extraParams` intentionally open.
- Known opposite-kind fields are rejected on each discriminated union arm even
  though unknown extension keys pass through. Changing an existing engine's
  `kind` through a partial update is invalid; unset the engine and write a
  complete replacement. Setup/config imports with a conflicting existing kind
  fail rather than producing a hybrid object.

Known opposite-kind fields are exhaustive:

- LLM engines reject `platform`, `bin`, `args`, `workspace`, `modelAliases`,
  and `llmEngine`;
- agent engines reject `provider`, `endpoint`, `apiKey`, `temperature`, `maxTokens`,
  `concurrency`, `supportsJsonSchema`, `extraParams`, `contextLength`, and
  `enableThinking`.

The identifier grammar and 63-character limit apply to both `engines` and
configured `improve.strategies` map keys and appear in generated JSON Schema
`propertyNames`. Engine credential fallback names are derived exactly as:

```ts
`AKM_ENGINE_${name.toUpperCase().replaceAll("-", "_")}_API_KEY`
```

### Defaults

`defaults` contains exactly these execution fields:

```ts
type EngineDefaults = {
  engine?: string;
  llmEngine?: string;
  improveStrategy?: string;
};

type ModelAliasConfig = Record<
  string, // lowercase alias
  Record<string, string> // platform/engine target -> exact model
>;
```

Root `modelAliases?: ModelAliasConfig` remains part of the config schema. Root
and engine-local alias keys are normalized to lowercase at validation; reject a
map containing distinct source keys such as `Fast` and `fast` that normalize to
the same key. Values are exact, one-level, non-recursive model identifiers.

Cross-field validation runs at load, validation, and save:

- `defaults.engine`, when present, names an existing engine of either kind.
- `defaults.llmEngine`, when present, names an existing `kind: "llm"` engine.
- `defaults.improveStrategy`, when present, names a built-in or configured
  strategy.
- every strategy process engine and nested judgment engine exists;
- every process engine satisfies the improve capability matrix;
- every agent platform supports dispatch;
- all existing source/write-target invariants remain unchanged.

There is no implicit engine named `default`, first-map-entry fallback, platform
inference from an engine name, or fallback after an explicit invalid engine.

### General Resolution Precedence

| Consumer | Resolution |
| --- | --- |
| Generic interactive AI operation | explicit `--engine` -> `defaults.engine` -> error |
| Agent/tool-required operation | explicit `--engine` -> `defaults.engine`; resolved engine must be agent |
| Direct LLM-only operation | explicit/process engine -> enclosing section engine -> `defaults.llmEngine` -> error or documented skip |
| Workflow unit | unit engine -> workflow `defaults.engine` -> config `defaults.engine` -> start error |
| Improve strategy | `--strategy` -> `defaults.improveStrategy` -> built-in `default` |

An operation may deliberately treat an absent LLM as optional, but it may not
substitute another configured engine after an explicit selection fails.

## Uniform Deep Merge and Engine Reuse

### Two Separate Operations

Configuration composition and engine selection are different operations and
must not be conflated.

**Deep merge** combines increasingly specific configuration objects.

**Engine selection** chooses one named engine by pointer. Selecting a more
specific engine replaces the less-specific engine name; it never merges two
engine definitions together.

After selecting the engine, application, strategy, process, workflow, task, or
call-level invocation settings are deep-merged over that one normalized engine
definition.

### Shared Merge Contract

Use `deepMergeConfig()` as the single merge implementation throughout config
loading, config updates, setup, strategy composition, section defaults, and
invocation overlays.

| More-specific value | Result |
| --- | --- |
| missing or `undefined` | inherit the less-specific value |
| plain object | recursively merge; deeper keys win |
| array, including `[]` | replace the complete less-specific array |
| scalar, including `false`, `0`, and `""` | replace |
| `null` on a nullable field | explicit replacement, such as unbounded timeout |
| `null` on a non-nullable field | validation error |
| deletion | only `akm config unset`; never infer deletion from `null` |

Validate the fully merged object after composition. Preserve unknown
same-version passthrough keys during merge. Do not add special per-section
merge functions with different null, array, or object behavior.

Reject `__proto__`, `prototype`, and `constructor` keys at any depth before
merge. Merge only own enumerable properties into fresh plain objects; never
mutate prototypes or source objects.

Apply the same contract to:

- `DEFAULT_CONFIG <- on-disk config`;
- current config <- setup/config partial update;
- nested object values passed to `akm config set`;
- built-in default strategy <- selected built-in <- user strategy;
- named engine <- section defaults <- process/unit/task <- call override;
- model-alias maps and nested LLM `extraParams`.

`saveConfig()` receives a complete config and does not merge with disk. Dotted
`config unset` remains the only deletion operation.

### Reusable Engine-Use Shape

Every model-backed application section uses the same invocation fields:

```ts
type LlmInvocationOverrides = {
  temperature?: number;
  maxTokens?: number;
  supportsJsonSchema?: boolean;
  extraParams?: JsonObject;
  contextLength?: number;
  enableThinking?: boolean;
};

type EngineUseConfig = {
  engine?: string;
  model?: string;
  timeoutMs?: number | null;
  llm?: LlmInvocationOverrides;
};
```

`endpoint`, `provider`, `apiKey`, and `concurrency` remain named-engine identity
and connection fields. They cannot be copied or overridden in application
sections. A section that needs another endpoint or credential selects another
named engine. This keeps OpenAI-compatible connection configuration reusable
and keeps credentials centralized.

`model`, timeout, and request tuning are invocation concerns and may be
overridden more deeply. `llm` is invalid when the selected engine is an agent,
except that an SDK agent obtains its base connection through `llmEngine` and
still uses only the generic `model`/`timeoutMs` agent overrides.

The nested invocation shape is projected explicitly rather than directly
merged into the top-level connection:

```ts
type ResolvedLlmUse = {
  engine: string;
  connection: Omit<LlmConnectionConfig, "apiKey" | "timeoutMs"> & {
    supportsJsonSchema?: boolean;
  };
  credential?: {
    names: [string, ...string[]];
    required: boolean;
  };
  timeoutMs: number | null;
};

function projectLlmUse(layer: EngineUseConfig) {
  return {
    ...layer.llm,
    ...(layer.model !== undefined ? { model: layer.model } : {}),
  };
}
```

For each layer, flatten `llm.*` onto the connection and then apply top-level
`model`. Resolve timeout separately so explicit `null` remains an unbounded
call value instead of being lost to a non-null connection field. Keep the
symbolic credential descriptor in `credential`; this type never contains a
secret value. Validate every name against the environment-variable grammar.
Validate the projected connection, timeout, and symbolic refs together before
dispatch or freezing.

### Uniform Precedence

For any operation, first choose the engine name from most explicit to least
explicit. Then deep-merge settings from least explicit to most explicit.

```text
engine name:
  call or unit/process/task engine
  -> enclosing workflow/strategy/index default engine
  -> config defaults.engine or defaults.llmEngine as required
  -> error or explicitly documented optional skip

effective settings:
  selected named engine
  <- application-section defaults
  <- selected strategy/workflow/task settings
  <- process/pass/unit settings
  <- direct call or CLI overrides
```

Specific hierarchies:

| Surface | Engine selection | Settings overlay |
| --- | --- | --- |
| Improve LLM process | process `engine` -> strategy `engine` -> `defaults.llmEngine` | engine <- strategy use config <- process use config <- call |
| Standalone index pass | pass `engine` -> `index.defaults.engine` -> `defaults.llmEngine` | engine <- index defaults <- pass <- call |
| Workflow unit | unit `engine` -> workflow default -> `defaults.engine` | engine <- workflow defaults <- unit, all frozen at start |
| Workflow gate | frozen `defaults.llmEngine` | engine <- gate invocation timeout/model policy |
| SDK agent | agent `llmEngine` -> `defaults.llmEngine` | referenced LLM engine <- agent model/timeout <- call |
| Generic command | CLI `--engine` -> `defaults.engine` | engine <- command config <- CLI flags |
| Prompt task | task `engine` -> `defaults.engine` | engine <- task use config |

An explicit invalid engine or incompatible kind is always an error. It never
falls through to another engine.

### OpenAI-Compatible LLM Resolution

Every LLM-backed feature, including `memoryInference`, `graphExtraction`,
`extract`, `distill`, `consolidate`, validation repair, recombine, procedural,
index enrichment, workflow LLM units, gates, remember, and SDK fallback, must
resolve through one named `kind: "llm"` engine and produce the existing
`LlmConnectionConfig` consumed by `chatCompletion()`.

Use one small resolver, not an adapter layer:

```ts
resolveLlmEngineUse(
  config,
  layers: readonly EngineUseConfig[],
  options?: { optional?: boolean },
): ResolvedLlmUse | undefined;
```

The resolver:

1. selects the most-specific engine name;
2. requires a named LLM engine;
3. converts the engine to a non-secret normalized base connection;
4. deep-merges ordered invocation layers;
5. carries the symbolic credential descriptor without resolving it;
6. resolves the exact timeout, including explicit `null` and the leaf default;
7. validates the final connection;
8. returns engine identity and effective settings for telemetry and
   workflow freezing.

At dispatch only, `materializeLlmConnection(resolved)` reads the credential
descriptor and creates the secret-bearing `LlmConnectionConfig`. An explicitly
configured `$VAR` freezes as one required name and never falls through. Implicit
fallback freezes the ordered engine-specific and global names with
`required: false`; include the global name only when the selected engine is
`defaults.llmEngine`. Materialization uses the first non-empty value and permits
unauthenticated dispatch when none is set. Workflow freezing consumes
`ResolvedLlmUse` and never calls the materializer.

`extraParams` is merged as data but may not override protected request fields
or carry credentials. Reject `extraParams` containing any top-level protected
key: `model`, `messages`, `temperature`, `max_tokens`, `response_format`,
`stream`, `stream_options`, or `enable_thinking`. Recursively reject keys that
normalize to `authorization`, `headers`, `apikey`, `token`, `password`,
`secret`, `cookie`, or `setcookie`. Normalize every recursively visited key by
lowercasing it and removing all non-ASCII alphanumeric characters before this
comparison, so `API_KEY`, `api-key`, and `ApiKey` are identical. Rejection is
the only behavior; do not rely on spread order. This validation runs before
config save and before workflow snapshot construction.

### Current Inconsistencies to Remove

The verified 0.9 RC baseline is not uniform. The PR must remove these paths:

| Current behavior | Required correction |
| --- | --- |
| `mergeLoadedConfig()` shallow/hybrid merge | replace with `deepMergeConfig()` |
| `updateConfig()` shallow/hybrid merge | deep-merge or delete if still unused |
| `SetupContext.apply()` root shallow spread | deep-merge setup patches |
| legacy setup adapters replace named profiles | delete adapters; write engines directly |
| setup may persist an LLM base URL while HTTP uses the URL verbatim | persist one full chat-completions URL and derive SDK base URL |
| setup may classify a native non-OpenAI API as a direct LLM | import only verified OpenAI-compatible endpoints; otherwise create an agent or skip |
| config walker rejects every `apiKey` set | allow symbolic engine references and reject literals |
| save sanitizes before final validation | validate unsanitized config, then redact defensively |
| discriminator changes can retain old union-arm fields | reject partial kind changes and opposite-kind fields |
| improve private merge ignores `null` | use shared merge and preserve nullable null |
| non-default built-ins do not inherit complete default | always merge default <- selected <- user |
| `getImproveProcessConfig()` falls back by whole process entry | remove fallback; use the already merged selected strategy |
| agent timeout uses `??` and loses explicit null | use presence checks/shared merge |
| index memory/graph reread default improve profile | pass selected engine connection explicitly |
| improve leaves call `getDefaultLlmConfig()` directly | accept resolved process connection |
| workflow compile and projection duplicate field precedence | use one engine-use merge helper |
| `extraParams` currently overrides explicit LLM request fields | protect explicit/deeper typed fields |

Deep merging does not restore project-level config layering. The 0.9 decision
to ignore `.akm/config.json` remains unchanged unless separately approved.

## Configuration Lifecycle

### Version Contract

A present config file must contain exactly:

```json
{ "configVersion": "0.9.0" }
```

Missing, numeric, malformed, older, or newer versions are rejected with a
`ConfigError`, code `UNSUPPORTED_CONFIG_VERSION`, and exit code 78. Loading
never rewrites the file.

An absent config file remains a valid cold start. `loadUserConfig()` returns an
in-memory `DEFAULT_CONFIG` stamped with `configVersion: "0.9.0"` and does not
create a file. Commands that do not need an engine continue to work.

Only `ENOENT` means no config. Permission, I/O, and malformed-file failures are
reported rather than treated as absence.

Config schema version is independent from npm package patch/prerelease version.
Files created by `0.9.0-rc.1` are normally unversioned or stamped `0.8.0` and
use profiles; they are expected manual-upgrade inputs, not corrupt anomalies.
Final 0.9 writes config schema `0.9.0`, and later package patches keep that
schema version until the persisted shape changes again.

The exact load pipeline for a present file is:

1. read and parse raw JSON/JSONC;
2. require the raw file's own exact `configVersion` before applying defaults;
3. reject retired keys;
4. deep-merge `DEFAULT_CONFIG <- parsed config`;
5. run full structural and cross-reference validation;
6. cache only the symbolic validated config.

Defaults never satisfy a missing version on a present file.

With no file, `config list/get` use in-memory `DEFAULT_CONFIG`; `config set`
creates a valid versioned file; `config unset` is a no-op and creates nothing;
`config validate` and `config migrate` report absence without writing.

### Recovery Command Startup

CLI startup bypasses normal config loading for top-level `--help`, `--version`,
command help, `config path`, `config validate`, `config migrate`, migration
backup create/restore, and every `setup` entry point including detect-only.
These surfaces initialize output from CLI flags and built-in defaults only.

Non-detect setup raw-checks the existing file before `akmInit()`, prompts,
source mutations, backups, or writes. A legacy/invalid file therefore cannot
block diagnosis and cannot be mutated as a side effect of seeking recovery.

### Legacy-Key Rejection

`.passthrough()` and clean rejection coexist through an explicit retired-key
denylist. Reject at least:

- root `profiles`, `llm`, `agent`, `features`, and `stashes`;
- `defaults.llm`, `defaults.agent`, and `defaults.improve`;
- improve process `mode` and `profile`;
- nested judgment `mode` and `profile`.
- old index-pass `llm` booleans and duplicate metadata-enhance selectors;
- current config CLI aliases `llm.*`, `stashes.*`, and boolean
  `semanticSearchMode` coercion.

Errors name the retired path and its 0.9 replacement. Unknown non-retired keys
still round-trip within a valid 0.9 config.

### `akm config migrate`

`akm config migrate` does not translate profile-based configuration in 0.9.
It remains as a recovery and diagnosis command that reads raw config without
normal runtime loading:

- absent file: exit 0 with `status: "absent"`;
- valid 0.9 file: exit 0 with `status: "current"`;
- missing/old/profile-based or newer file: `UNSUPPORTED_CONFIG_VERSION`, exit
  78, with bundled manual guidance;
- malformed/unreadable file: `INVALID_CONFIG_FILE`, exit 78.

Remove transform-only `--dry-run` and `--print-diff` flags. Remove automatic
load-time migration, migration banners, and `AKM_NO_AUTO_MIGRATE` behavior from
the 0.9 load path. Historical migration code may remain only if another
standalone historical tool still imports it; production loading must not.
Diagnosis examines only the user config path and never writes, backs up, locks,
scans project configs, or emits diffs.

The migration guide must provide a deterministic manual mapping table and a
collision checklist. It must not claim AKM can resolve LLM/agent name
collisions automatically.

Delete `migrateConfigShape()` and the transform body once production loading and
diagnosis no longer import them. Retain only a small version constant/comparator
in the config schema module if still needed. Add `UNSUPPORTED_CONFIG_VERSION`
to the typed config error-code union. Migration guidance must be bundled in CLI
help and may also link to a stable URL; a repository-relative path alone is not
valid for packaged binaries.

### Config CLI and Mutation

| Surface | Unknown same-version passthrough keys |
| --- | --- |
| Runtime parser/generated schema | preserve (`additionalProperties: true`) |
| `config list` | emit the full effective symbolic config, including unknowns |
| `config get` | read known paths and existing unknown paths |
| `config set` | set known schema paths only; object values deep-merge |
| `config unset` | remove known or existing unknown paths and prune empty parents |

`configVersion` cannot be set or unset through the generic walker. Symbolic API
key references are shown by config management output; values are never resolved.
Index pass objects follow the same unknown-key preservation rule. Known retired
and misplaced provider keys remain explicit errors, not unknown extensions.

Object mutation algorithm:

1. parse an object patch without validating it as a complete engine/section;
2. deep-merge it with the existing leaf;
3. reject a discriminator change;
4. validate the complete config;
5. sanitize defensively and write atomically.

Creating a new engine requires a complete valid object. Replacing its kind
requires redirecting/unsetting all references, unsetting the engine, creating a
complete replacement, then restoring references. Setup's explicit "none"
choices perform equivalent targeted unsets; `null` never means deletion.

Every mutation uses one lock covering read -> merge -> validation -> backup ->
atomic write. Long-running setup accumulates a patch, then rereads and applies
it under that final lock. Complete writers call `saveConfig()` with a full
object and do no disk merge; source/registry/installed arrays intentionally
replace. All complete writers preserve the required version and passthrough
fields. Regression coverage includes init, source add/manage, registry toggles,
wiki operations, setup, and config CLI.

### Setup

Setup writes the 0.9 shape directly:

- only detected endpoints verified to accept OpenAI-compatible chat-completions
  requests become LLM engines;
- Anthropic-native and other incompatible provider APIs are not written as LLM
  engines; setup creates a matching agent engine when a supported harness is
  available or skips them with actionable guidance;
- detected agent harnesses become agent engines keyed by canonical platform;
- setup sets `defaults.engine` and `defaults.llmEngine` when available;
- setup writes API-key environment references, never literal values;
- existing valid 0.9 engines, strategies, and unrelated config survive;
- a legacy config is rejected before prompts or writes with manual migration
  guidance.

Delete the old-shape adapters in `src/setup/legacy-config.ts`. Setup, config
path/validate/migrate, and other recovery commands must be invokable without
first successfully loading the invalid legacy config.

Setup detection/import contract:

1. enumerate every registered dispatch-capable harness instead of choosing one
   aggregate "best" harness;
2. imported records carry canonical platform plus URL kind: native provider,
   provider base, OpenAI base, or complete chat-completions URL;
3. normalize eligible URLs through one function to a complete
   `/chat/completions` endpoint;
4. verify with a 10-second, non-streaming POST to that endpoint using the
   detected model, `messages: [{ role: "user", content: "Reply OK" }]`,
   `max_tokens: 1`, and `stream: false`; resolve an imported credential only
   ephemerally for this probe and accept only 2xx JSON containing
   `choices[0].message.content` as a string;
5. native/incompatible providers become agent engines when a matching harness
   exists or produce actionable skips;
6. persist imported `apiKeyEnvVar` as `${ENV_VAR}`;
7. name LLM engines deterministically from provider/platform, adding `-2`,
   `-3`, and so on only for genuine collisions;
8. preserve existing matching engines on rerun and make default selection
   idempotent;
9. complete all conflict and legacy preflight before stash initialization or
   config writes.

An unavailable required credential, no detected model, authentication failure,
timeout, non-2xx response, or invalid response shape is not verified and is
skipped with exact remediation. Detection-only reports status and performs no
config/stash mutation.

Setup identity fingerprints are `llm:<canonical endpoint>` and
`agent:<canonical platform>`. If any existing same-kind engine has that
fingerprint, reuse it without modifying user-edited model/tuning/bin fields. If
the deterministic candidate name is occupied by another fingerprint, choose the
first free numeric suffix; reruns find and reuse the prior suffix by fingerprint.
Defaults are set only when absent or already point to the reused fingerprint;
setup never replaces an explicit different default on rerun.

### Secrets and Config Mutation

Do not inject environment values into cached `AkmConfig`. Keep the parsed
configuration symbolic and resolve credentials only when constructing a
runtime connection.

For an LLM engine named `fast`, credential lookup is:

1. the variable named by configured `apiKey: "$VAR"` or `${VAR}`;
2. `AKM_ENGINE_FAST_API_KEY` when no explicit reference exists;
3. `AKM_LLM_API_KEY` only when `fast` is `defaults.llmEngine`;
4. absent.

An explicit reference is authoritative. If it is unset, dispatch fails rather
than falling through. Retire `AKM_PROFILE_*_API_KEY` in 0.9.

`sanitizeConfigForWrite()` remains a defense-in-depth recursive redactor even
though schema validation rejects literal keys. Config list/get/setup output
must never display credential values.

Embedding credentials follow the same symbolic-only rule as engine
credentials. Config management output may display the symbolic `$VAR` or
`${VAR}` reference because it is configuration, not a secret value; it never
resolves or prints the referenced value.

`akm config set engines.<name>.apiKey '$VAR'` and the `${VAR}` form are allowed;
literal values and `${VAR:-literal}` are rejected. Validate the complete
unsanitized config first. Run defensive sanitization only after successful
validation, so invalid literals produce an error rather than being silently
dropped into an apparently valid file.

Every engine-dispatch scope builds an ephemeral exact-value redaction set. It
includes every non-empty engine credential, direct secret binding,
`${secret:...}` substitution, and value originating from an env asset. Ambient
agent `envPassthrough` values are also included unless their variable name is in
this exhaustive non-secret allowlist: `HOME`, `PATH`, `USER`, `LANG`, `LC_ALL`,
`TERM`, `TMPDIR`, `AKM_EVENT_SOURCE`, `OPENCODE_CONFIG`, `CLAUDE_CONFIG`, and
`CODEX_CONFIG`. Every included value is redacted regardless of length. Adding a
new non-secret passthrough exception requires adding it to this list and a test;
there is no name-pattern heuristic.

Use one small `redactSensitiveText(text, values)` helper at durable and rendered
result boundaries for workflows, tasks, improve, proposals, and agent commands.
Before stdout, stderr, provider errors, or result text can enter a database row,
event, result file, brief/report diagnostic, or rendered error, replace exact
occurrences with `[REDACTED]`. Tests cover children and providers that echo
sentinel values. This cannot detect transformed, encoded, or externally
exfiltrated values.

The enforceable guarantee is: **secret values that AKM resolves from declared
engine credentials, env assets, or secret bindings do not enter AKM-authored
durable state or rendered output**. It does not claim to discover credential
literals hidden in arbitrary agent args, innocuously named provider parameters,
model output, or external-driver output. Endpoint userinfo and credential-shaped
`extraParams` keys are still rejected as defense in depth.

Before persisting manual `workflow report` results, resolve for redaction-only
use the active frozen unit's declared env/secret refs, frozen engine credential,
and every non-allowlisted frozen `envPassthrough` variable. Missing required
declared assets or credentials reject the report without mutation. Brief may
expose env asset refs, but never resolved keys, values, or credential variable
names.

Use the existing `deepMergeConfig()` semantics for setup/config partial
updates: plain objects recursively merge, while arrays and scalars replace.
`null` is not deletion; use `akm config unset`.

## Engine Resolution

### One Platform-Based Resolver

Engine name is identity only. Agent behavior comes from `platform`.

Resolve an agent engine as follows:

1. Look up the named engine and require `kind: "agent"` where applicable.
2. Resolve the canonical platform through `HARNESS_BY_ID`, not alias lookup.
3. Require `harness.capabilities.agentDispatch`.
4. For CLI platforms, read existing built-in runtime defaults for the platform
   and require the harness builder. For `opencode-sdk`, use an explicit SDK
   baseline: server binary `opencode`, captured/text invocation policy, no base
   args, and the SDK result path.
5. Overlay configured `bin`, `args`, `workspace`, `model`, timeout, and aliases.
6. Set the runtime profile name to the engine name.
7. Set runtime command-builder identity to the platform.
8. Produce `RunnerSpec.kind: "sdk"` only for `platform: "opencode-sdk"`;
   otherwise produce `RunnerSpec.kind: "agent"`.

This makes an engine named `reviewer` with `platform: "pi"` inherit Pi's binary,
arguments, builder, environment passthrough, and result-extractor identity.
Do not infer any of those from `reviewer`.

No new registry is needed. The current harness registry remains platform and
capability authority. Resolve builders and result extractors by canonical
platform, never engine name.

### Resolution Functions

Keep the API functional and small:

```ts
resolveEngineDefinition(name, config): ResolvedEngineDefinition;
resolveEngine(name, config, options?): RunnerSpec;
resolveDefaultEngine(config, options?): RunnerSpec;
```

`resolveEngineDefinition()` returns an allowlisted, non-secret normalized
definition plus symbolic credential variable names. It is shared by runtime
lowering and workflow snapshot construction. It is not a public service or
serialized `RunnerSpec`.

`resolveEngine()` resolves credential values at consumption time and lowers the
definition to `RunnerSpec`. LLM-default callers use `resolveLlmEngineUse()`;
there is no overlapping `resolveDefaultLlmEngine()` convenience API.

Direct HTTP LLM dispatch uses the canonical endpoint verbatim. OpenCode SDK
lowering derives its provider base URL by removing the terminal
`/chat/completions` suffix from the referenced LLM endpoint; it does not require
a second endpoint field.

### Internal `RunnerSpec`

Retain three internal kinds and add only data required to preserve behavior:

```ts
type RunnerSpec =
  | {
      kind: "llm";
      engine: string;
      connection: Omit<LlmConnectionConfig, "timeoutMs">;
      timeoutMs?: number | null;
    }
  | {
      kind: "agent";
      engine: string;
      profile: AgentProfile;
      timeoutMs?: number | null;
    }
  | {
      kind: "sdk";
      engine: string;
      profile: AgentProfile;
      fallbackConnection?: Omit<LlmConnectionConfig, "timeoutMs">;
      timeoutMs?: number | null;
    };
```

For SDK engines, `fallbackConnection` comes from the effective
`agentEngine.llmEngine ?? defaults.llmEngine`. SDK model precedence is
`call model -> agent engine model -> referenced LLM engine model`. Freeze the
effective fallback engine identity and model at workflow start; callers never
reselect the global default during dispatch.

Resolved `AgentProfile` is runtime spawn metadata only. Add canonical
`platform` and normalized absolute `workspace`; remove `timeoutMs`, `sdkMode`,
`endpoint`, and `apiKey`. `RunnerSpec` owns kind and timeout, while the SDK
fallback owns provider connection data. Frozen exact models are carried with an
internal `modelIsExact: true` marker so builders and SDK lowering never resolve
them as aliases again.

### `executeRunner()`

Keep `executeRunner()` as the only exhaustive `RunnerSpec.kind` switch.

Required narrow changes:

- pass normalized `RunAgentOptions` to the caller-supplied LLM handler;
- apply timeout precedence `call option -> spec timeout -> leaf default`;
- preserve `null` as explicitly unbounded where the leaf supports it;
- pass SDK `fallbackConnection` to `runOpencodeSdk()`;
- preserve cwd, environment, abort signal, dispatch request, usage, session ID,
  and `AgentRunResult.reason` behavior;
- keep the `assertNever` arm;
- never load config, select an engine, resolve aliases, or resolve secrets.

The exact seam changes are:

```ts
llm?: (
  spec: Extract<RunnerSpec, { kind: "llm" }>,
  prompt: string,
  opts: RunAgentOptions,
) => Promise<AgentRunResult>;

runSdk?: (
  profile: AgentProfile,
  prompt: string,
  opts: RunAgentOptions,
  fallbackConnection?: Omit<LlmConnectionConfig, "timeoutMs">,
) => Promise<AgentRunResult>;
```

Normalize timeout and cwd once using property-presence checks, then pass the
same effective options to every arm. `AgentDispatchRequest.cwd` is removed;
`RunAgentOptions.cwd` is the sole cwd input.

The HTTP stack accepts `timeoutMs: number | null`. `null` installs no internal
timer but still honors an external abort signal. Remove the signed-32-bit timer
workaround and branch retry-budget arithmetic for null.

The LLM handler remains caller-specific. Reflect, structured workflow calls,
and plain judgment calls have different request and result contracts.

`UnitDispatcher` remains above `executeRunner()` for workflow-specific env,
worktree, structured-output, result-normalization, and failure mapping. It is
not reused as a universal command service.

Working-directory precedence is:

```text
worktree cwd for an isolated attempt -> explicit non-isolated call cwd
-> frozen engine workspace -> process.cwd()
```

`workspace` is carried by the resolved runtime profile or `RunnerSpec` and is
lowered into `RunAgentOptions.cwd`; it must not remain a parsed-but-unused
config field.

### Resource Ownership

- `runAgent()` owns its child process, streams, abort listeners, and timers.
- `runOpencodeSdk()` owns each SDK session.
- the outermost CLI dispatch scope closes cached SDK servers in `finally`.
- workflow-level cleanup remains as defense in depth.
- `executeRunner()` does not close shared SDK servers after each unit.

The SDK server registry key is a digest of canonical effective provider config,
materialized API-key value, server binary, environment bindings, and provider
base URL. Different engine configurations never share a server merely because
their child environments match. Each concurrently live key receives a distinct
port. When fallback connection data exists, every effective model is routed
through the generated `akm-custom` provider, including model IDs containing
`/`.

Retain create/prompt promises across timeout races. A late-created session gets
bounded deletion when its ID arrives. Once an ID exists, deletion runs in
`finally`; a prompt that never settles is handled by bounded server shutdown.
The composition root in `src/cli.ts` awaits `runMain(main)` in `try/finally` and
calls `disposeDispatchResources()`; workflow cleanup remains defense in depth.

Redaction materializers contribute exact values to one dispatch-local set.
Deduplicate and sort descending by value length before replacement, then redact
individual strings before JSON serialization. Existing pattern redaction stays
as defense in depth.

### Command Capability Matrix

| Command/consumer | Accepted engine |
| --- | --- |
| `akm agent` | agent only |
| `akm wiki ingest` | agent only |
| `akm propose` | LLM or agent |
| prompt task | LLM or agent |
| proposal-drain judgment | LLM or agent |
| remember enrichment | LLM only, optional when not configured |
| standalone extract | LLM only |
| index enrichment/lazy graph | LLM only |

The selected engine is final. A dispatch failure never retries through another
kind. Route every accepted kind through `executeRunner()` with its
caller-specific LLM handler. Delete unused `src/llm/call-ai.ts` rather than
adapting its implicit agent-to-LLM fallback.

## Improve Strategies

### Schema and Built-ins

Move built-ins from `src/assets/profiles/` to
`src/assets/improve-strategies/` and rename the resolver module to
`improve-strategies.ts`.

Preserve all existing strategy-level and process-specific fields. Strategies
may provide shared engine/invocation defaults, while each process may override
them:

```ts
type ImproveStrategyConfig = EngineUseConfig & {
  // existing description, processes, autoAccept, limit, maxCycles,
  // symmetricValence, and sync fields remain
};

type ImproveProcessConfig = EngineUseConfig & {
  enabled?: boolean;
  // every existing process-specific field remains
};
```

Nested triage judgment becomes:

```ts
judgment?: EngineUseConfig;
```

Judgment engine precedence is:

```text
judgment.engine -> triage process.engine -> strategy.engine
-> defaults.llmEngine
```

Judgment settings merge as selected engine <- strategy <- triage process <-
judgment <- call. An explicit agent judgment may use only generic model/timeout
fields; `judgment.llm` requires an LLM engine.

The judgment tier remains opt-in through the existing judgment execution flag.
When requested, an absent `judgment` block does not disable fallback: resolve
`triage process.engine -> strategy.engine -> defaults.llmEngine`. Only when no
tier resolves is judgment unavailable and the proposal remains deferred. An
explicit invalid judgment engine is always an error.

Do not create a runtime `Strategy` interface. The command boundary carries a
plain value:

```ts
type SelectedStrategy = {
  name: string;
  config: ImproveStrategyConfig;
};
```

### Strategy Merge

Resolve once at command entry:

1. select name from `--strategy`, `defaults.improveStrategy`, or built-in
   `default`;
2. start with the complete built-in `default` baseline;
3. recursively merge the selected built-in when it is not `default`;
4. recursively merge `improve.strategies.<selected>`;
5. arrays replace; explicit `false`, `0`, and empty arrays survive;
6. schema-invalid `null` values are rejected rather than ignored.

The resulting strategy contains all known process entries. Unknown names are a
hard `UNKNOWN_IMPROVE_STRATEGY` error.

Before activation, materialize every built-in strategy as a complete tree whose
resolved behavior is byte-for-byte equivalent to the RC baseline. Sparse
built-ins must explicitly disable or override fields that would otherwise leak
from the default baseline. Golden snapshots compare the entire resolved tree,
not only enabled states, for all 12 built-ins: `default`, `quick`, `thorough`,
`memory-focus`, `graph-refresh`, `frequent`, `consolidate`, `catchup`,
`synthesize`, `reflect-distill`, `proactive-maintenance`, and `recombine-only`.
Delete `IMPROVE_PROCESS_DEFAULTS` after this normalization.

For a model-backed process, resolve engine and settings as:

```text
engine name: process.engine -> strategy.engine -> defaults.llmEngine
connection: selected engine <- strategy EngineUseConfig
            <- process EngineUseConfig <- direct call overrides
```

This allows `memoryInference`, `graphExtraction`, and every other LLM process to
reuse one OpenAI-compatible engine while selecting a different model, timeout,
or request tuning only where needed.

Pass `SelectedStrategy` through preparation, loop stages, post-loop stages,
triage, index passes invoked by improve, nested quality checks, result writing,
and events. No leaf process may reread `improve.strategies.default` or select a
different strategy.

Construct one plain preflighted process catalog at the outer command boundary:

```ts
type ResolvedImproveProcess = {
  name: ImproveProcessName;
  config: ImproveProcessConfig;
  engine?: string;
  llm?: ResolvedLlmUse;
  runner?: RunnerSpec; // judgment/interactive-capable processes only
};

type ResolvedImprovePlan = {
  strategy: SelectedStrategy;
  processes: Record<ImproveProcessName, ResolvedImproveProcess>;
};
```

Every nested call receives its resolved process entry or connection. Nested
functions do not accept `AkmConfig` for engine selection. Ownership is exact:

- reflect generation and quality judgment use reflect;
- distill generation, existing-knowledge merge, promotion quality, CLS, and
  fidelity use distill;
- consolidate chunk/retry, synthesis, contradiction, and quality use
  consolidate;
- extract generation and session summary use extract;
- schema repair uses validation;
- memory inference and graph extraction use their respective processes;
- recombine and procedural use their respective processes;
- proposal judgment uses triage judgment.

Quality judgments use the owning process's effective model unless their nested
`EngineUseConfig` explicitly overrides it. Remove `judgeModel`; nested use
configuration is the one model-selection mechanism. Preserve each call's
existing fail-open/fail-closed policy and timeout as explicit fields/tests.

### Process Capability Matrix

Use one static validation table, not a capability framework.

| Process | Allowed engine | Fallback when engine omitted |
| --- | --- | --- |
| `reflect` inside `akm improve` | LLM only | `strategy.engine` -> `defaults.llmEngine` |
| reflect invoked by an interactive proposal command | LLM or agent | command engine, then `defaults.engine` |
| `distill` | LLM only | `strategy.engine` -> `defaults.llmEngine` |
| `consolidate` | LLM only | `strategy.engine` -> `defaults.llmEngine` |
| `memoryInference` | LLM only | `strategy.engine` -> `defaults.llmEngine` |
| `graphExtraction` | LLM only | `strategy.engine` -> `defaults.llmEngine` |
| `extract` | LLM only | `strategy.engine` -> `defaults.llmEngine` |
| `validation` schema repair | LLM only | `strategy.engine` -> `defaults.llmEngine` |
| `triage.judgment` | LLM or agent | `triage.engine` -> `strategy.engine` -> `defaults.llmEngine`; no resolved tier means no judgment |
| `recombine` | LLM only | `strategy.engine` -> `defaults.llmEngine` |
| `procedural` | LLM only | `strategy.engine` -> `defaults.llmEngine` |
| `proactiveMaintenance` | no engine | none |

Preflight every enabled model-backed process before locks, writes, or model
calls. Explicit missing or wrong-kind engines are configuration errors and
never silently fall back. Disabled process references are still structurally
and cross-reference validated.

Preflight occurs immediately after strategy resolution, before index
enrichment, locks, event writes, contradiction work, or any model call. Dry-run
may perform read-only index discovery/enrichment only when explicitly requested,
but never invokes mutation-capable improve leaves. Contradiction detection in
dry-run cannot write frontmatter.

Unattended improve reflect remains tool-less and fail-closed. Interactive
proposal/reflect APIs may use an agent engine.

Structural validation always runs and uses no engine. The `validation` process
controls only LLM-backed schema repair. Repair runs when validation failures
exist, `repairValidationFailures !== false`, and the selected strategy enables
`validation`. The complete built-in default baseline sets
`validation.enabled: true` to preserve the currently effective default repair
behavior. A disabled validation process leaves failures unrepaired but does not
skip structural validation.

### Index and Feature-Gate Boundary

Improve owns engines for improve-triggered memory inference and graph
extraction. Resolve their effective OpenAI-compatible connection through
`resolveLlmEngineUse()` and pass it explicitly into those operations.

Actual non-improve consumers are:

| Consumer | Canonical section | Behavior |
| --- | --- | --- |
| `akm index` metadata enrichment | `index.enrichment` | optional model calls during index walk |
| lazy `show` graph extraction | `index.graph` | one single-file graph call |
| curate graph queueing | `index.graph` | reads enablement only; no model call |
| improve memory inference | selected strategy process | ignores index execution settings |
| improve graph extraction | selected strategy process | ignores index execution settings |

Non-improve index and lazy-show behavior use:

```text
pass.engine -> index.defaults.engine -> defaults.llmEngine
selected engine <- index.defaults <- pass settings
```

Replace the old `index.<pass>.llm: false` selector with `enabled: false` on that
pass. Add `index.defaults: EngineUseConfig`; each model-backed pass combines
`EngineUseConfig` with its existing pass-specific fields. Standalone index does
not consult the selected improve strategy.

Do not make `akm index` start memory inference or full graph extraction as part
of this refactor. Collapse duplicate metadata-enhancement controls into
`index.enrichment`. Canonical graph keys live under `index.graph`.

Pass all dispatch-significant improve graph settings explicitly, including
include types and batch size; do not let the graph leaf reread `index.graph`.
Put those fields on `processes.graphExtraction` and document their manual config
mapping. Remove parsed-but-unused `memoryInferenceBatchSize`.

Remove hard-coded reads of the old default improve profile from:

- feature-gate resolution;
- index-pass LLM resolution;
- memory inference;
- graph extraction;
- distill generation, promotion, and quality checks;
- consolidate contradiction and merge calls;
- recombine and procedural helpers.

The orchestrator decides whether an improve process and nested toggle runs.
Split `tryLlmFeature()` so the leaf wrapper retains timeout/error fallback but
does not read strategy config. Delete improve entries from `FEATURE_LOCATION`,
the improve branches of `isProcessEnabled()`, and config-gated behavior in
`callStructured()` when a resolved process is supplied. Standalone index
enablement stays section-local.

### Improve Persistence

Add a nullable `strategy` column to `improve_runs`. Do not rename, drop,
backfill, or reinterpret the existing `profile` column.

| Row | `profile` | `strategy` |
| --- | --- | --- |
| Historical | preserved | `NULL` |
| New 0.9 row | `NULL` | effective selected strategy |

Do not use `COALESCE(strategy, profile)`. Health and diagnostics may expose a
separately named `legacyProfile` for historical rows.

New improve results increment their result schema version and include the
effective strategy name. Rename strategy-derived result and event fields, such
as `profileFilteredRefs`, without reinterpreting historical result JSON.

Add state migration `017-improve-run-strategy`:

```sql
ALTER TABLE improve_runs ADD COLUMN strategy TEXT;
CREATE INDEX IF NOT EXISTS idx_improve_runs_strategy_started
  ON improve_runs(strategy, started_at);
```

Every new writer sets `profile = NULL` and `strategy = <effective name>`.
Versioned result mapping is exact:

| Result v1 | Result v2 |
| --- | --- |
| no effective selector field | `strategy` |
| `profileFilteredRefs` | `strategyFilteredRefs` |
| `profile_filtered_all_passes` | `strategy_filtered_all_passes` |

Resolve `SelectedStrategy` in the CLI before installing signal handlers, then
pass it into `akmImprove()`. Programmatic entry may resolve only when no
preselected value is supplied and must not resolve twice. Success, dry-run,
exception, and signal-termination rows/results therefore carry the same
effective strategy. No new termination event is introduced; termination is an
`improve_runs` row/result unless separately designed.

Add one strict `decodeImproveResult()` shared by repository metrics, health,
reports, eval tooling, and filesystem import. Readers branch on result schema
version and never coalesce persisted v1/v2 names. Update the eval loader to
accept both versions and imported v1 artifacts to write both selectors null.
Health output changes from schema v2 to v3 when
`profileFilteredRefs` becomes `strategyFilteredRefs`; update JSON/text/Markdown/
HTML fixtures. Degradation reporting and retention continue to support mixed
v1/v2 rows; retention remains selector-independent and deletes by timestamp.

`queryImproveRuns()` and health summaries project `strategy` and
`legacyProfile` separately. Add internal engine attribution to usage telemetry
through an explicit call option/context set from each resolved process; nested
calls record owning process and engine without rereading config.

Standalone `proposal drain` uses the normal strategy precedence
`--strategy -> defaults.improveStrategy -> built-in default`. The existing
`--judgment` flag remains the opt-in switch for executing the strategy's
judgment tier; selecting a strategy does not implicitly enable judgment.

Standalone `akm extract` accepts `--engine`, resolves non-engine settings from
the selected strategy, and intentionally ignores `processes.extract.enabled` so
an explicit command remains runnable. Auto/watch resolves and validates the
strategy/engine once at command start and reuses that immutable resolved entry
for each trigger.

Standalone proposal drain always resolves the strategy for triage limits and
policy but intentionally ignores `triage.enabled`; explicit invocation is the
enablement. `--judgment` remains the only judgment execution switch. Results and
audit events include effective strategy. Pin LLM, agent, no-judge, dry-run,
malformed-verdict, and explicit bad-engine behavior.

Health uses the same engine resolver:

- agent default: resolve and probe the canonical platform runtime;
- LLM default in `defaults.engine`: report no default agent selected; never pick
  the first agent engine;
- SDK: validate package, server binary, model, and fallback relation without
  printing endpoints or credential variable names;
- egress: enumerate `kind: "llm"` endpoints plus embedding/source/registry
  egress;
- missing defaults: advisory/unknown, never map-order fallback.

Task doctor output changes from profile vocabulary to engine/strategy and
reports stale generated commands without rewriting them.

## Workflow Source v2

Workflow YAML uses engine syntax only:

```yaml
version: 2
name: review-change

defaults:
  engine: reviewer
  model: balanced
  timeout: 10m
  on_error: fail

steps:
  - id: review
    unit:
      engine: fast
      model: qwen3
      llm:
        temperature: 0.1
        extraParams:
          seed: 7
      instructions: Review the supplied change.
```

Replace `defaults.runner`, `unit.runner`, and `unit.profile` with
`defaults.engine` and `unit.engine`. Reject source version 1, `runner`,
`profile`, and `inherit` outright.

Preserve params, instructions, model override, timeout, output schema, retry,
environment refs, isolation, routes, maps, gates, on-error behavior, and
OpenAI-compatible `llm` invocation overrides. Workflow defaults and units both
implement `EngineUseConfig`; unit values deep-merge over workflow defaults.

Workflow source has a presentation-specific use shape:

```ts
type WorkflowEngineUseSource = Omit<EngineUseConfig, "timeoutMs"> & {
  timeout?: number | `${number}ms` | `${number}s` | `${number}m` | "none";
};
```

Positive numeric values are milliseconds and `none` normalizes to null. Parser
output uses `EngineUseConfig.timeoutMs`; source key `timeoutMs` is rejected.

Effective unit engine precedence is:

```text
unit.engine -> workflow defaults.engine -> config defaults.engine -> error
```

Classic Markdown workflows have no engine syntax and therefore use
`config.defaults.engine`. They still compile directly to IR v3.

Every creation path, including explicit start and auto-start, calls the same
compile-resolve-freeze function before inserting a run. `workflow start`
dispatches nothing, but it still requires a fully valid executable snapshot.
All workflow invocation overlays are resolved and serialized at this boundary.
Dispatch-time options may carry cancellation, resolved env values, and the
attempt cwd, but may not change engine, model, timeout, or `llm` request tuning.

The boundary is explicit:

```ts
compileResolveFreezeWorkflow(asset, config): {
  plan: WorkflowPlanGraphV3;
  stepRows: FrozenStepProjection[];
  warnings: WorkflowError[];
};
```

Source parsing and expression validation remain pure. Engine/default selection,
deep overlays, aliases, timeout, scheduling policy, gate judge, and catalog
construction occur only in freeze. Classic Markdown preserves verbatim
templating, literal `${{ ... }}` text, linear steps, and start-time
`defaults.engine` resolution.

Workflow detection recognizes workflow-shaped YAML independently of supported
version so stale v1 files remain classifiable and receive an actionable
"version 1 retired; version 2 required" parser error rather than disappearing
from indexing.

## Workflow IR v3

### Plan Shape

Rename `IrAgentNode` to `IrUnitNode`, use `kind: "unit"`, and make IR v3 the
only current persisted shape.

The plan contains an immutable, plan-local catalog of only the engines
referenced by units, SDK fallbacks, or gate judges:

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type JsonSchema = JsonObject;

type SourceRef = {
  path: string;
  start: number;
  end: number;
};

type IrRetryV3 = {
  max: number;
  on: AgentFailureReason[];
};

type IrOnError = "fail" | "continue";
type IrIsolation = "none" | "worktree";

type IrBudgetV3 = {
  maxTokens?: number;
  maxUnits?: number;
};

interface WorkflowPlanGraphV3 {
  irVersion: 3;
  title: string;
  params?: string[];
  paramSchemas?: Record<string, JsonSchema>;
  budget?: IrBudgetV3;
  execution: {
    maxConcurrency: number;
    engines: Record<string, FrozenEngineSnapshot>;
  };
  steps: IrStepPlanV3[];
}

type FrozenEngineSnapshot =
  | {
      name: string;
      kind: "llm";
      provider?: string;
      endpoint: string;
      credential?: {
        names: [string, ...string[]];
        required: boolean;
      };
      temperature?: number;
      maxTokens?: number;
      concurrency: number;
      supportsJsonSchema?: boolean;
      extraParams?: JsonObject;
      contextLength?: number;
      enableThinking?: boolean;
    }
  | {
      name: string;
      kind: "agent";
      runnerKind: "agent" | "sdk";
      platform: HarnessId;
      bin: string;
      args: string[];
      workspace: string | null;
      envPassthrough: string[];
      fallbackLlmEngine: string | null;
    };

interface IrInvocationV3 {
  engine: string;
  model: string | null; // exact, never an alias
  timeoutMs: number | null;
  llm?: LlmInvocationOverrides;
}

interface IrUnitNode {
  kind: "unit";
  id: string;
  instructions: string;
  templating: "expressions" | "verbatim";
  invocation: IrInvocationV3;
  schema?: JsonSchema;
  retry?: IrRetryV3;
  onError: IrOnError;
  env?: string[];
  isolation: IrIsolation;
  source?: SourceRef;
}

interface IrMapNodeV3 {
  kind: "map";
  id: string;
  over: string;
  template: IrUnitNode;
  concurrency: number;
  reducer: "collect" | "vote";
  source?: SourceRef;
}

type IrExecNodeV3 = IrUnitNode | IrMapNodeV3;

interface IrRouteSpecV3 {
  input: string;
  when: Record<string, string>;
  defaultStepId?: string;
}

interface IrGateNodeV3 {
  kind: "gate";
  id: string;
  stepId: string;
  criteria: string[];
  maxLoops: number;
  required: boolean;
  judge: IrInvocationV3 | null;
}

interface IrStepPlanV3 {
  stepId: string;
  title: string;
  sequenceIndex: number;
  dependsOn?: string[];
  root?: IrExecNodeV3;
  route?: IrRouteSpecV3;
  outputSchema?: JsonSchema;
  gate: IrGateNodeV3;
}
```

The catalog is part of `plan_json` and `plan_hash`; it is not a database table,
foreign key, or mutable runtime cache. Invocation-level exact model and timeout
support several effective variants of one engine without duplicating the base
snapshot.

The strict decoder additionally requires:

- every catalog key equals its snapshot `name`;
- every unit, gate judge, and SDK fallback reference resolves in the catalog;
- gate judges and SDK fallbacks reference LLM snapshots;
- `runnerKind: "sdk"` appears only with `platform: "opencode-sdk"`, and that
  platform always uses `sdk`;
- every other agent platform uses `runnerKind: "agent"`;
- every agent snapshot has a non-empty resolved executable `bin`;
- `runnerKind: "agent"` requires `fallbackLlmEngine: null`;
- `runnerKind: "sdk"` permits either `null` or the frozen
  `agentEngine.llmEngine ?? defaults.llmEngine` reference selected at start;
- every catalog entry is referenced by at least one unit, gate, or fallback;
- LLM snapshots cannot be paired with env injection or worktree isolation.

The decoder is recursively strict and also enforces unique step/node IDs,
contiguous unique sequence indices, exactly one of root/route, map templates
containing a unit, gate ID/step consistency, valid earlier dependencies and
route targets, valid expression references, non-empty retry reasons, positive
bounds/concurrency, and JSON-domain values. Required/defaulted fields shown
above are materialized during freeze; the decoder does not invent defaults.

Resource limits are enforced before canonicalization/insertion: source file 1
MiB, frozen plan 2 MiB, 256 steps, 64 referenced engines, 128 params, 256 route
branches per route, 256 KiB per instruction or schema, 64 KiB per `extraParams`,
and maximum JSON/object depth 64. Runtime map expansion is capped at 10,000
items and remains subject to run `maxUnits`. Exceeding a limit is a usage error,
not truncation.

### Snapshot Allowlist

Never spread a parsed config engine or `RunnerSpec` into IR. Construct each
snapshot field explicitly.

The snapshot includes only dispatch-significant, non-secret settings. It does
not contain:

- API-key values;
- resolved env or secret asset values;
- authorization headers;
- whole process environments;
- config passthrough keys not explicitly allowlisted;
- model alias tables after alias resolution;
- functions, harness instances, builders, or extractors.

Workflow instructions and params remain explicitly non-secret user input. The
guarantee is that AKM does not add resolved config/env secret values to durable
workflow surfaces.

### Plan Authority and Scheduling

For v3, decoded and hash-verified `plan_json` is the sole authority for titles,
instructions, criteria, schemas, routes, dependencies, engine invocations, and
gate policy. Derive `workflow_run_steps` projections from the frozen plan during
the start transaction. Before executable mutation, verify step-row IDs and
sequence match the plan. Runtime, complete, brief, and report read static values
from the plan, never unhashed `instructions` or `completion_json` columns.
Historical inspection may continue to render old step rows. The only policy
overlay is invocation-level `--require-gates`, which may strengthen optional
frozen gates to required but may never weaken or replace frozen criteria/judges.

Freeze `workflow.maxConcurrency` into `execution.maxConcurrency`. If configured,
clamp it to 1..64; if absent, compute the current CPU-derived default at start
and freeze it. Current host capacity remains a late-bound safety cap that may
lower but never raise concurrency.

Effective map concurrency is the minimum of map concurrency, frozen workflow
policy, selected LLM engine concurrency (default 1) when applicable, and current
host safety capacity. Agent engines have no additional engine-level cap. Remove
post-start config loading from scheduler, unit resolution, and gate construction.

### Freeze Timing

At `startWorkflowRun()`:

1. parse and validate workflow source;
2. resolve every unit's effective engine;
3. resolve agent platform defaults;
4. resolve unit and workflow model aliases to exact model strings;
5. resolve effective timeout and static capability constraints;
6. resolve the current gate judge from `defaults.llmEngine`;
7. freeze symbolic API-key variable names, never their values;
8. build strict IR v3;
9. canonicalize and hash it;
10. insert the run, steps, plan JSON, plan hash, and IR version atomically.

Store timeout only on `IrInvocationV3`; engine snapshots do not contain a
second timeout authority. Resolve the first present value, preserving explicit
`null`:

```text
workflow unit: unit -> workflow defaults -> agent/LLM engine -> 600000 ms
workflow gate: gate policy -> LLM engine -> 600000 ms
direct LLM: call/process/pass -> LLM engine -> 600000 ms
direct CLI agent: call -> agent engine -> 60000 ms
SDK: call/unit -> agent engine -> referenced LLM engine -> 600000 ms
```

`null` means no timeout and must be tested by property presence, never `??`.
For workflows, the exact resulting number or null is frozen in each unit and
gate invocation.

For gates:

- a criteria-bearing required gate requires a valid LLM judge at start;
- a non-required gate with no LLM freezes `judge: null` and preserves current
  fail-open behavior;
- gate execution uses the frozen judge, never live config;
- gate attempts receive persisted input hashes and journal identity.

Gate judging uses the selected LLM engine's normal effective model; there is no
separate `judgeModel` authority. `workflow run --require-gates` changes only gate policy:
criteria-bearing optional gates are treated as required. A frozen `judge: null`
then blocks, while a frozen judge is attempted and any unavailable or malformed
verdict blocks. The flag never consults live config or selects a new judge.

Journal identity remains compatible with current accounting:

- looped unit: `<unitId>~l<n>`;
- retry: `<baseId>~r<n>`;
- gate attempt: `<stepId>.gate:l<n>`.

Gate hash preimage is canonical `{ hashVersion: 3, systemPrompt, userPrompt,
dispatch: transitiveJudgeSnapshot, invocation }`. New gate rows persist engine,
`runner = "llm"`, exact model, and input hash. Retry/on-error policy remains
outside completed-call identity; retry attempts preserve input hash, while new
gate-loop feedback changes the rendered prompt/hash. Gate rows remain excluded
from unit/token dispatch budgets. Running/errored gate recovery uses persisted
attempt rows and never reselects a judge. Preserve current crash windows with
tests before gate insert, after running insert, after verdict, and before step
completion.

No workflow execution, brief, report, resume, or gate path loads config to
reselect an engine or model.

### Model Alias Resolution

Resolve aliases once at workflow start:

```text
unit model -> workflow default model -> engine model
```

Agent alias precedence remains:

```text
engine.modelAliases[lowerAlias]
-> config.modelAliases[lowerAlias][aliasTarget]
-> config.modelAliases[lowerAlias]["*"]
-> builtInAliases[lowerAlias][aliasTarget]
-> verbatim
```

LLM precedence is:

```text
config.modelAliases[lowerAlias][engineName]
-> config.modelAliases[lowerAlias]["llm"]
-> config.modelAliases[lowerAlias]["*"]
-> verbatim
```

`aliasTarget` is the canonical harness ID, including `opencode-sdk`. Aliases are
one-level and non-recursive. LLM invocations require a non-null exact model;
agent invocation model may be null only when that harness permits omission.

The dispatcher sets `modelIsExact: true` for frozen models so a value that
happens to equal an alias key is never resolved a second time.

### Canonicalization and Hashing

Add one strict IR v3 decoder shared by run, brief, and report. Validate version,
shape, JSON-domain values, snapshot discriminants, refs, and required fields
before use. Remove `JSON.parse(...) as WorkflowPlanGraph` casts.

Use one canonical JSON implementation:

- recursively sort object keys by code-unit order;
- preserve array order and string bytes;
- reject non-finite numbers and non-JSON values;
- hash UTF-8 canonical JSON with SHA-256.

On load, require the stored `plan_json` bytes to equal canonical JSON of the
decoded plan before validating `plan_hash`. A semantically equivalent but
noncanonical stored plan is rejected rather than silently normalized.

`plan_hash` covers the complete plan, including `execution.engines`.

Resolve a transitive dispatch snapshot before hashing. For an ordinary LLM or
CLI agent this is the selected frozen engine snapshot. For an SDK agent it is
the selected agent snapshot plus the complete referenced frozen LLM snapshot.
The v3 unit input-hash preimage is canonical JSON containing:

```ts
{
  hashVersion: 3,
  prompt,
  dispatch: transitiveFrozenDispatchSnapshot,
  invocation,
  schema: schema ?? null,
  env: envRefs ?? null,
  isolation,
}
```

Include symbolic credential variable names through the transitive snapshot,
never resolved values. A changed SDK fallback endpoint, model, or credential
variable changes the input hash. Keep retry and on-error policy outside
completed-call identity.

### Dispatch

`UnitDispatchRequest` carries the frozen engine snapshot and exact invocation,
not public runner/profile selectors. The default dispatcher:

1. resolves credential and env asset values only for work that will dispatch;
2. reconstructs a runtime `RunnerSpec` from the frozen allowlist;
3. enforces env/worktree compatibility;
4. invokes `executeRunner()` with a workflow-specific LLM handler;
5. redacts exact resolved secret values from results and errors;
6. applies existing failure mapping, schema validation, result extraction,
   usage accounting, cancellation, and journaling.

Dynamic checks remain late-bound: credential presence, env/secret asset
contents, executable availability, network reachability, current cwd/git
worktree suitability, cancellation, leases, and host capacity.

Completed reusable work must not resolve secrets, require deleted env assets,
or rerun worktree preflight.

### IR v2 Operational Policy

AKM 0.9 does not execute, translate, recompile, or mutate the plans, steps, or
units of IR v2 or null-plan runs. Abandoning the run lifecycle is the sole
permitted mutation.

One `classifyWorkflowRunPlan(row)` function is the authority for every command:

- valid current v3;
- unsupported v2;
- missing/null plan;
- stored `plan_ir_version` versus decoded-version mismatch;
- corrupt/noncanonical/hash-invalid v3;
- unknown future version.

It is a classifier and strict v3 decoder, not a v2 decoder or converter. Add
`WORKFLOW_IR_VERSION_UNSUPPORTED` to the typed workflow error union.

Allowed for old runs:

- list;
- status and unit diagnostics;
- watch;
- abandon.

Rejected for old runs:

- run;
- next;
- resume;
- complete;
- brief;
- report or settle.

Return `WORKFLOW_IR_VERSION_UNSUPPORTED` with instructions to abandon the old
run and start a new run. An active v2 run continues to occupy its scope until
abandoned or a new run is explicitly forced. Do not mark it failed during a
database migration because that would falsify history.

The matrix applies even to completed old runs; `workflow run` does not return a
terminal no-op before classification. Start without force remains blocked by an
active old row; force creates a separate v3 run. Abandon works even for malformed
old plan JSON.

For current v3 mutation commands, validate canonical plan bytes, hash, row
version, params, catalog, and step-spine consistency before lease acquisition or
any database write. Then acquire the lease and atomically recheck active status
before dispatch. Apply the same validate-before-mutate order to resume,
complete, report finalization, and settle. A rejected plan leaves lease and
lifecycle columns unchanged.

## Workflow Storage

Add append-only workflow migration `010-ir-v3-engine` after migration 009:

```sql
ALTER TABLE workflow_runs ADD COLUMN plan_ir_version INTEGER;
ALTER TABLE workflow_run_units ADD COLUMN engine TEXT;
```

Storage meaning:

- new runs write `plan_ir_version = 3` in the plan-insert transaction;
- historical rows remain null unless the reader derives a display-only version
  from `plan_json`;
- new unit and gate rows write public engine name to `engine`;
- historical `runner` values are preserved authored selectors and may include
  `inherit`; new v3 rows store resolved `llm | agent | sdk` runtime kind;
- existing `model` stores the exact effective model;
- historical unit rows retain `engine = NULL`;
- never backfill `engine` from `runner`.

Run summary projection is:

```ts
{
  planIrVersion: number | null;
  executionSupport:
    | "supported"
    | "unsupported-version"
    | "missing-plan"
    | "corrupt-plan";
}
```

For v3 rows, expose engine identity and planned `runtimeKind`, platform, and
exact model in unit diagnostics. External reports record the planned lowering;
they do not claim an independently observed runtime. For
historical rows, expose `engine: null`, `runtimeKind: null`, and optionally
`legacyRunnerSelector: row.runner`; never infer a runtime kind from `inherit`.
Run summaries also expose plan IR version and whether execution is supported.
Brief and `status --units` expose non-secret engine name, planned runtime kind,
platform, and exact model. List exposes only run-level version/support because a
run may use several engines. Do not print endpoint, argv, credential variable
names, or whole snapshots in normal output.

## Public Vocabulary Cutover

Rename engine-selection surfaces without aliases:

| Old | New |
| --- | --- |
| `akm improve --profile` | `akm improve --strategy` |
| `akm proposal drain --profile` | `akm proposal drain --strategy` |
| `akm agent <profile> [<agent-ref>]` | `akm agent [<agent-ref>] --engine <name>` |
| propose/wiki/task `--profile` | `--engine` |
| task target `profile` | `engine` |
| workflow `runner` + `profile` | `engine` |
| process `mode` + `profile` | `engine` |
| `ImproveProfileConfig` | `ImproveStrategyConfig` |
| `resolveImproveProfile` | `resolveImproveStrategy` |
| `UNKNOWN_IMPROVE_PROFILE` | `UNKNOWN_IMPROVE_STRATEGY` |

Internal `AgentProfile` and `RunnerSpec` names may remain because they describe
runtime spawn data and an internal tagged union, not public configuration.

The exact agent CLI grammar becomes:

```text
akm agent [<agent-ref>] [--engine <name>] [--prompt ...]
```

The engine flag is optional and falls back to `defaults.engine`, which must
resolve to an agent engine. This removes the current ambiguous first positional
profile selector. `akm propose`, `akm wiki ingest`, and prompt-task creation use
the same optional `--engine` flag and capability check.

Task assets make a separate versioned cutover. Persist root `version: 2` and,
for prompt tasks, root `engine`, optional `model`, `timeoutMs`, and `llm`
invocation overrides alongside the existing root target fields. Prompt-task
execution deep-merges those fields over the selected named engine. Set internal
`TASK_SCHEMA_VERSION = 2`. A missing root version is v1; reject missing version,
`version: 1`, and root `profile`. Update the task parser, validator, output
projection, bundled assets, and `tasks add --engine` together. Task doctor
diagnoses stale v1 files and user-authored commands but does not rewrite them.

A prompt task may select an LLM or agent engine. LLM prompt tasks use the plain
chat handler and have no file-write contract; agent prompt tasks retain child
process/SDK behavior. `llm` overrides are valid only for an LLM prompt task.
Command task timeout remains supported; workflow task timeout is rejected.
`engine`, `model`, and `llm` are prompt-only. Command and workflow target
semantics are otherwise unchanged.

Task YAML v2 is strict. Allowed root keys are `version`, `name`, `description`,
`when_to_use`, `tags`, `schedule`, `enabled`, exactly one of `workflow` /
`prompt` / `command`, `params`, `engine`, `model`, `timeoutMs`, and `llm`.
Unknown keys and wrong-target fields are errors. `version` is integer 2;
`enabled` is boolean; strings are not coerced from numbers/booleans;
`timeoutMs` is a positive integer or null. The normalized document records both
source version 2 and output `schemaVersion: 2`.

`tasks add` supports `--engine`, `--model`, and `--timeout-ms`; advanced `llm`
overrides are YAML-only. Serialization order is version, metadata, schedule,
enabled, target, params, engine/model/timeout/llm. Add and package
`schemas/akm-task.json` with drift coverage.

Stale v1 policy:

- list surfaces stale file IDs and a grouped warning instead of omitting them;
- show/run/enable/disable return `TASK_SCHEMA_VERSION_UNSUPPORTED` without
  mutation;
- sync reports stale files and preserves existing scheduler entries;
- doctor parses every YAML file, reports stale IDs, and gives exact corrections;
- known generated task IDs and exact legacy `--profile` commands receive exact
  `--strategy` replacement guidance; arbitrary commands are never rewritten.

Doctor's recognized generated replacements are:

| Task ID | Legacy command | Replacement |
| --- | --- | --- |
| `akm-improve-frequent` | `akm improve --profile frequent --auto-accept safe` | `akm improve --strategy frequent --auto-accept safe` |
| `akm-improve-consolidate` | `akm improve --profile consolidate --auto-accept safe` | `akm improve --strategy consolidate --auto-accept safe` |
| `akm-improve-nightly` | `akm improve --profile thorough --auto-accept safe` | `akm improve --strategy thorough --auto-accept safe` |
| `akm-improve-catchup` | `akm improve --profile catchup --auto-accept safe` | `akm improve --strategy catchup --auto-accept safe` |
| `akm-graph-refresh-weekly` | `akm improve --profile graph-refresh --auto-accept safe` | `akm improve --strategy graph-refresh --auto-accept safe` |

Rename internal `DefaultTaskSpec.profile` to `strategy`. Existing installed
tasks are never silently rewritten.

Default task definitions and bundled task assets must emit `--strategy` and
`engine`. Do not regex-rewrite arbitrary user-authored shell commands. Task
doctor should identify known stale generated commands and provide the exact
replacement.

### Versioned Output Ledger

| Surface | Baseline | 0.9 target | Required field change |
| --- | ---: | ---: | --- |
| config | 0.8/absent | 0.9.0 | profiles -> engines/strategies |
| workflow YAML | 1 | 2 | runner/profile -> engine |
| workflow IR | 2 | 3 | frozen execution catalog |
| task YAML/document | 1 | 2 | profile -> engine, strict source version |
| improve result | 1 | 2 | strategy and strategy-filter fields |
| health output | 2 | 3 | strategy metrics and engine health |
| agent result | 1 | 2 | `profileName` -> `engine` |
| propose result | 1 | 2 | `agentProfile` -> `engine` |
| task history metadata | unversioned | 2 | `engine`; historical profile separate |
| wiki ingest result | unversioned | 2 | `engine` |

Every persisted/public reader branches on its explicit version. Historical
profile fields are projected as `legacyProfile` where useful and never
reinterpreted as engines or strategies. Do not bulk-bump unrelated nested
result schemas.

The changed envelopes are exact; fields not listed do not survive by
passthrough:

```ts
type AkmAgentDispatchResultV2 = {
  schemaVersion: 2;
  ok: boolean;
  shape: "agent-result";
  engine: string; // present on success and failure
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
  reason?: AgentFailureReason;
};

type AkmProposeResultV2 =
  | {
      schemaVersion: 2;
      ok: true;
      engine: string;
      proposal: Proposal;
      ref: string;
      durationMs: number;
    }
  | {
      schemaVersion: 2;
      ok: false;
      engine: string;
      reason: AgentFailureReason;
      error: string;
      type: string;
      name: string;
      exitCode: number | null;
      stdout?: string;
      stderr?: string;
    };

type WikiIngestResultV2 = {
  schemaVersion: 2;
  wiki: string;
  path: string;
  schemaPath: string;
  dispatched: true;
  engine: string;
  agentResult: AkmAgentDispatchResultV2;
};

type TaskHistoryMetadataV2 = {
  metadataVersion: 2;
  durationMs: number;
  detail: JsonValue | null;
  engine?: string; // prompt targets only
};
```

Missing `metadataVersion` is the legacy task-history format; decode its
`profile` only as `legacyProfile`. New `TaskRunResult` prompt targets expose
`engine`; historical prompt targets expose `engine: null` and
`legacyProfile`. Engine identity is retained on all failed dispatch envelopes
because selection precedes execution.

Health v3 retains all unrelated v2 fields exactly and makes these exhaustive
renames: `ImproveHealthMetrics.profileFilteredRefs` becomes
`strategyFilteredRefs`; check name `agent-profile` becomes
`default-agent-engine`; its evidence is `{ engine, platform, runtimeKind,
model }` with nullable values and no profile/bin/endpoint/credential fields;
profile-derived messages use strategy terminology; egress records label direct
connections as `llm engine <name>`. Historical improve v1 decoding remains
internal evidence and never repopulates v3 strategy fields.

## Improve and Database Changes in the 0.9 PR

All changes in this document ship in one PR targeting the final 0.9.0 release.
The PR may use dependency-ordered commits for reviewability, but no subset is
merged, released, or activated separately.

### Improve Pipeline

The PR changes improve as one vertical slice:

1. Move `profiles.improve` to `improve.strategies` in the active schema and
   rename built-in assets and resolver types.
2. Replace `--profile` with `--strategy` and persist the effective strategy,
   including when selected through defaults.
3. Replace process `mode/profile` and nested judgment selectors with `engine`.
4. Resolve one `SelectedStrategy` at command entry and pass it through
   preparation, triage, loop stages, post-loop work, nested quality checks, and
   result/event writers.
5. Enforce the static process capability matrix before locks, writes, indexing,
   or model calls.
6. Pass selected LLM connections explicitly into improve-triggered memory
   inference and graph extraction. Standalone index behavior remains separate.
7. Remove all leaf rereads of the configured default strategy and all silent
   fallback after an explicit engine fails.
8. Preserve structural validation while making LLM schema repair explicitly
   owned by `processes.validation`.
9. Emit result schema v2 and strategy-named metrics/events without rewriting
   historical result JSON.
10. Update default scheduled tasks and task doctor for `--strategy`.

### `state.db`

Add migration `017-improve-run-strategy` to the existing append-only state
migration ledger:

```sql
ALTER TABLE improve_runs ADD COLUMN strategy TEXT;
CREATE INDEX IF NOT EXISTS idx_improve_runs_strategy_started
  ON improve_runs(strategy, started_at);
```

New improve rows write `strategy` and leave `profile` null. Existing rows retain
their original `profile` and a null strategy. Health, reports, and repository
types read the fields separately. Retention remains unchanged and deletes by
`started_at` regardless of result version or selector. Historical filesystem
imports write both selectors null. The migration does not backfill, rename,
rebuild, or drop anything. Update the exact state migration ledger/schema
characterization fixtures.

### `workflow.db`

Add migration `010-ir-v3-engine` to the workflow migration ledger:

```sql
ALTER TABLE workflow_runs ADD COLUMN plan_ir_version INTEGER;
ALTER TABLE workflow_run_units ADD COLUMN engine TEXT;
```

New runs write `plan_ir_version = 3`; new units and gate attempts write the
public engine name while the existing `runner` column stores the resolved v3
runtime kind. Historical columns and rows remain unchanged. IR v2 and null-plan
runs are readable but not executable under the policy above.

### `index.db`

No `index.db` schema or `DB_VERSION` change is required. Improve-triggered
memory inference and graph extraction receive an explicit selected engine at
runtime, but their indexed data shape is unchanged. Do not force an index
rebuild or paid re-embedding for this refactor.

Both database migrations are normal additive application migrations and may run
automatically when their databases open. This does not conflict with the ban on
automatic **configuration** translation: database migrations preserve row
meaning, while profile-to-engine config translation would require ambiguous
semantic choices.

## Upgrade, Downgrade, and Release Policy

This one PR is the 0.9 cutover, but merge does not bypass the governing release
metrics runbook. The first release artifact containing the cutover is
`v0.9.0-rc.2`; its deployment timestamp is the new observation anchor. Reset
all three stable-release gates: clean-week baseline, minting-shutdown interval,
and 30 clean days of `improve_cycle_metrics`. No pre-cutover row counts toward a
gate. Update every fixed beta.58 anchor/query/example in
`docs/technical/0.9.0-release-metrics-runbook.md` in this PR. Stable 0.9.0 is
promoted only after that post-cutover window passes. Package-version promotion
remains owned by the release workflow, not hand-edited in the implementation
PR.

Provide recovery-safe `akm backup create --for 0.9.0` and
`akm backup restore --for 0.9.0 --confirm` commands. The bundle path is
`$CACHE/migration-backups/0.9.0/` with exact files `manifest.json`,
`config.json`, `state.db`, and `workflow.db`; the manifest records source path,
presence/absence, byte size, SHA-256, and creation time for each artifact.
Creation writes a mode-0700 temporary directory, mode-0600 files, uses SQLite
backup/checkpoint APIs for present databases, fsyncs, then atomically renames.
It never overwrites a complete bundle and fails with cleanup guidance on an
incomplete bundle.

The migration guide requires bundle creation before editing legacy config. The
workflow/state migration runners also call the same ensure function before
applying 010/017 and fail closed if a complete verified bundle cannot be
created. Every path that first creates or writes a 0.9 config calls the same
ensure function before conversion/write, so the manifest captures legacy or
absent config. If a 0.9 config already exists and no verified bundle exists,
migration hooks and config writers fail rather than bless the current file as a
pre-cutover backup; recovery requires restoring the original bundle or config.
An absent database is a valid manifest entry. Restore verifies all hashes,
refuses while AKM locks are active, atomically restores each originally present
file, removes files recorded absent, and leaves the backup bundle intact.
Existing config writes continue their normal backup behavior only for an
existing valid 0.9 config; recovery never mutates a rejected legacy file.

In-place downgrade to `0.9.0-rc.1` or an older binary is unsupported because
those binaries can misread IR v3 and engine config. Recovery requires stopping
AKM, restoring the pre-cutover `config.json`, `workflow.db`, and `state.db`
backups, and then running the older binary. Document exact paths and commands in
the bundled migration help and storage-location guide. Warn users not to run old
setup/config mutation commands against a final 0.9 config.

## Required Legacy Removal

Delete superseded production paths in the same PR; do not leave dormant dual
authorities:

- load-time config migration, banners, `AKM_NO_AUTO_MIGRATE`, transform/diff
  machinery, project-config scanning in migrate, and old config CLI aliases;
- `src/setup/legacy-config.ts` and profile-shaped setup adapters;
- harness v1 profile-name inference (`v1Migration`,
  `matchesV1ProfileName()`, `v1ProfilePlatform()`) after setup migration callers
  are gone;
- `HEADLESS_BUILTINS`, `AgentProfile.sdkMode/endpoint/apiKey/timeoutMs`, generic
  custom-profile builder fallback, and `AgentDispatchRequest.cwd`;
- direct SDK/CLI switches in agent, propose, reflect, tasks, wiki, and workflow;
- unused `src/llm/call-ai.ts` and `resolveValidationRunner()`;
- duplicate `capabilities.structuredOutput`, `judgeModel`, and unused
  `memoryInferenceBatchSize`;
- improve `IMPROVE_PROCESS_DEFAULTS`, default-profile rereads, improve-backed
  `FEATURE_LOCATION`/`isProcessEnabled()` branches, and silent non-LLM fallback;
- task v1 production parsing after stale-file diagnostics are active;
- workflow v1 runner/profile/inherit parsing, executable IR v2 types, null-plan
  live recompilation, unchecked plan casts, live engine/gate/scheduler config
  loading, and dispatch-time alias resolution;
- public workflow DTO/formatter fields named runner/profile;
- tests that execute v2/null plans; retain only inspection/abandon policy
  fixtures;
- delete `tests/contracts/spec-helpers.ts`; convert every
  `v1-spec-section-*.test.ts` to a descriptively named current runtime contract
  or delete it when equivalent coverage already exists. Config, orchestration,
  CLI, agent-config, and LLM/agent-boundary files become 0.9 contracts; asset,
  quality, proposal, lesson, module-layout, and extension-point files retain
  behavioral assertions but remove archived-spec text/line dependencies;
- convert `tests/contracts/improve-knowledge-authority.test.ts` to active
  CLI/runtime contracts without `SPEC_PATH`; move the generic `readDoc`,
  `extractSection`, and `MIGRATION_PATH` support used by
  `migration-baseline.test.ts` into a non-spec `doc-helpers.ts` (or inline it),
  and update `tests/contracts/README.md`;
- remove live-contract references to the archived v1 architecture spec from
  `AGENTS.md`, `docs/cli.md`, `docs/example-stash/skills/architecture-cleanup/`,
  and active technical docs. Historical review/migration/archive references may
  remain explicitly historical;
- move `docs/technical/akm-workflows-orchestration-plan.md` under `docs/archive/`
  with a superseded banner. Rewrite its active links in `docs/README.md` and
  `docs/technical/claude-code-vs-akm-workflows.md` to this plan/current workflow
  docs.

Keep historical database columns and versioned v1 result decoders because they
preserve durable history; those are not compatibility execution paths.

## Implementation Sequence

Each commit must leave the branch type-correct and focused-test clean. The
numbered phases below are dependency groups, not independently activatable
public formats or separate PRs. Everything remains in one 0.9.0 PR. Config
phases 1 through 4 activate atomically only after setup and every production
consumer can use the new shape. Workflow phases 5 and 6 activate atomically only
after the IR v3 dispatcher, strict decoder, and storage migration are ready.
Preparatory commits may add unused internals, but may not switch production
parsing or persisted output early.

### Phase 1: Config Foundation

- add engine, defaults, and strategy schemas;
- replace `mergeLoadedConfig()` and section-specific merge behavior with the
  shared deep-merge contract;
- add `EngineUseConfig`, `LlmInvocationOverrides`, and cross-field validation;
- add exact version and retired-key validation;
- stop load-time migration and runtime secret injection;
- update save sanitization, config walker, list/get/set, and errors;
- update the config generator and regenerate a 0.9 schema with required
  `configVersion: const`, engine/strategy definitions, identifier
  `propertyNames`, discriminated arms, and explicit additional-properties
  policy;
- add raw-config-safe migration backup create/restore and shared DB backup
  enforcement;
- add the manual migration guide.

Keep the 0.9 production parser active during preparatory commits. The final
config-activation commit switches schema, setup, resolution, consumers,
improve, docs, and generated artifacts together.

### Phase 2: Setup and Engine Resolution

- make setup emit only engines/strategies;
- remove legacy setup adapters;
- implement platform-based normalized engine resolution;
- implement `resolveLlmEngineUse()` for reusable OpenAI-compatible connections;
- extend `RunnerSpec` and `executeRunner()` narrowly;
- update health and diagnostics to use the same resolver.

### Phase 3: Execution Consumers

- update agent, propose, wiki, task, and prompt consumers;
- update index, remember, gates, and direct LLM consumers to resolve named
  engines rather than reading default connection objects;
- remove duplicated SDK/CLI dispatch branches;
- retain caller-specific LLM handlers;
- guarantee SDK cleanup at outer command boundaries.

### Phase 4: Improve Strategies

- rename built-in assets, types, CLI, errors, result fields, and events;
- implement complete-tree merge and `SelectedStrategy` threading;
- deep-merge strategy/process invocation overlays over one selected LLM engine;
- enforce the capability matrix and preflight;
- remove default-strategy rereads and index/feature-gate coupling;
- add the additive `improve_runs.strategy` migration.

### Phase 5: Workflow Source and IR

- add YAML v2 engine syntax and update the hand-maintained
  `schemas/akm-workflow.json` plus drift tests;
- add IR v3 types, strict decoder, canonical JSON, and execution snapshot;
- freeze models, gate judges, and symbolic credentials at start;
- update input hashing and shared work-list derivation.

Do not emit YAML v2-derived IR v3 runs until Phase 6 dispatch and migration
support is present in the same activation change.

### Phase 6: Workflow Runtime and Storage

- make `UnitDispatcher` reconstruct from frozen snapshots without config loads;
- route gate judging through the frozen invocation;
- add workflow migration 010 and repository fields;
- enforce the IR v2 read-only/abandon policy;
- update brief, report, list, status, and diagnostics.

### Phase 7: Removal and Documentation

- remove old config/profile/process/workflow paths from production code;
- remove obsolete tests rather than preserving compatibility fixtures as
  runtime behavior;
- update current docs, CLI help, examples, built-in assets, migration docs,
  `STABILITY.md`, and generated schemas;
- add terminology guards scoped to active docs and public source artifacts;
- preserve archived documents and historical changelog entries as history.

## File Inventory

Primary implementation areas:

- config: `src/core/config/config-schema.ts`, `config-types.ts`, `config.ts`,
  `config-migration.ts`, `config-walker.ts`, `src/commands/config-cli.ts`,
  `src/cli/config-migrate.ts`, backup command/helpers, and DB migration hooks;
- setup: `src/setup/setup.ts`, `src/setup/steps/**`,
  `src/setup/legacy-config.ts`;
- runtime: `src/integrations/agent/runner.ts`, `runner-dispatch.ts`,
  `config.ts`, `profiles.ts`, `model-aliases.ts`, `spawn.ts`, and the harness
  registry/builders/extractors;
- consumers: agent, proposal, wiki, tasks, improve, and `src/llm/call-ai.ts`;
- improve: `src/core/improve-types.ts`, `src/commands/improve/**`,
  `src/assets/profiles/**`, index passes, graph extraction, feature gates,
  `src/core/state/migrations.ts`,
  `src/storage/repositories/improve-runs-repository.ts`, events, health, and
  `scripts/akm-eval/**`;
- workflows: program parser/schema/compiler, IR schema/hash/decoder, runtime
  runs, native executor, scheduler, step work, brief/report,
  `src/workflows/db.ts`, `src/storage/repositories/workflow-runs-repository.ts`,
  and `src/sources/types.ts`;
- tasks: `src/tasks/{schema,parser,validator,runner,embedded}.ts`,
  `src/commands/tasks/{tasks,tasks-cli,default-tasks}.ts`, bundled task assets,
  scheduler integrations, and task-history readers;
- health/output: `src/commands/health/**`, output shapes/text formatters, agent,
  propose, wiki, and task result envelopes;
- public schemas: `schemas/akm-config.json`, `schemas/akm-workflow.json`, and
  new `schemas/akm-task.json`;
- generators/package: `scripts/gen-config-schema.ts`, `scripts/copy-assets.ts`,
  `package.json`, `.github/README.npm.md`, `CHANGELOG.md`, and migration help;
- CI/release: `.github/workflows/{ci,release,release-gates}.yml`;
- active docs: configuration, CLI, workflows, improve, agent integration,
  setup, storage locations, architecture, stability, and migration guides.

## Required Test Matrix

### Config

- exact 0.9 accepted;
- real unversioned and 0.8 profile configs emitted by current RC setup are
  rejected with manual-upgrade guidance and no mutation;
- missing, numeric, old, new, and malformed versions rejected without writes;
- absent file returns an in-memory current config without writing;
- unreadable file is an error;
- valid LLM and every registered dispatch-capable agent platform resolve;
- engine name differing from platform still gets platform defaults;
- dangling and wrong-kind defaults/process refs fail;
- retired keys fail despite passthrough;
- unknown non-retired fields round-trip;
- config load, setup apply, config update/set objects, and strategy composition
  all use the shared deep-merge contract;
- nested objects preserve less-specific siblings, arrays replace, explicit
  false/zero/empty survive, nullable null overrides, and unset deletes;
- changing an engine discriminator through a partial merge is rejected and
  opposite-kind known fields cannot hide under passthrough;
- literal credentials fail and symbolic refs survive;
- symbolic `config set` succeeds, literal `config set` fails before sanitizing,
  and failed saves leave bytes unchanged;
- setup imports verified OpenAI-compatible endpoints and rejects/skips native
  incompatible provider APIs;
- config output, cache, save, and warnings contain no credential value;
- config migrate never translates or writes old shapes;
- recovery/help commands run despite invalid config and setup rejects before
  init/prompt/write;
- concurrent config mutations use locked read-merge-validate-write without lost
  updates;
- migration backup create is idempotent, fail-closed, checksum verified, handles
  absent/live-WAL databases, and restore requires confirmation/no active locks;
- passthrough keys survive every complete writer and config CLI verb follows
  the declared unknown-key policy;
- setup detection verifies OpenAI compatibility, imports credential refs,
  enumerates harnesses, resolves collisions, and is idempotent;
- config/task/workflow schema artifacts pin version, discriminator, identifier,
  strictness, and additional-properties policy;
- setup fresh/current/legacy behavior is pinned.

### Runtime

- CLI agent, SDK, and LLM arms dispatch through `executeRunner()`;
- SDK receives the resolved LLM fallback connection;
- timeout `number | null` precedence is uniform;
- omitted, inherited, explicit, and null timeouts follow the documented LLM,
  CLI-agent, SDK, workflow-unit, and gate precedence with one authority;
- cwd, env, signal, schema dispatch, usage, session ID, and failure reasons are
  unchanged;
- every outer SDK command cleans resources on success, failure, and abort;
- agent-only consumers reject an LLM engine without fallback.
- one named OpenAI-compatible engine is reusable by index, improve, workflow,
  task, remember, gate, and SDK fallback consumers;
- nested `llm` overrides flatten into the effective connection while
  model/nullable timeout retain their explicit precedence;
- SDK `llmEngine` overrides `defaults.llmEngine` without copying endpoint or
  credentials;
- SDK without an agent model inherits the referenced LLM model;
- direct HTTP uses the full chat-completions URL while SDK lowering derives its
  base URL from the same engine;
- SDK fallback rejects non-derivable endpoint URLs and freezes the effective
  fallback identity;
- prompt task engine precedence, LLM/agent behavior, and wrong-kind `llm`
  overrides are pinned;
- every protected or secret-bearing `extraParams` key is rejected, including
  absent-typed-field and nested-authorization cases.
- SDK server registries isolate endpoint/key/bin/env configurations and allocate
  distinct ports;
- SDK fallback always uses `akm-custom`, including slash-containing models;
- frozen exact models bypass all builders/SDK alias resolution;
- late SDK create/prompt timeout races clean sessions or bound server shutdown;
- top-level CLI cleanup runs for direct SDK success, failure, and abort;
- redaction deduplicates and replaces longest values first before serialization;
- every command capability accepts/rejects engine kinds exactly as specified.

### Improve

- all 12 built-in complete-tree golden snapshots preserve RC behavior;
- complete process tree and merge precedence;
- arrays replace and explicit false/zero/empty survive;
- strategy selected by CLI/default/built-in fallback;
- unknown strategy hard error;
- every process receives the selected strategy and engine;
- strategy and process engine-use settings deep-merge over the selected named
  LLM engine, with process values winning;
- memory inference and graph extraction use their resolved process connection
  rather than rereading index/default-improve config;
- every nested generation, judge, merge, retry, summary, and contradiction call
  uses its owning resolved process catalog entry;
- improve feature wrappers perform failure handling without live strategy gates;
- every capability-matrix invalid binding fails before mutation;
- structural validation always runs; schema repair obeys validation enablement,
  `repairValidationFailures`, and the selected LLM engine;
- explicit missing engine never falls back;
- unattended reflect is LLM-only;
- triage judgment handles LLM/agent/no-judge paths;
- judgment engine and settings follow judgment -> triage -> strategy -> global
  precedence;
- requested judgment with no block uses fallback tiers, while no resolved tier
  defers and an explicit bad tier errors;
- standalone index does not consult improve strategies;
- actual index/lazy-show/curate consumer boundaries and graph settings are
  pinned; index does not gain new memory/graph phases;
- standalone extract/watch and proposal drain preserve explicit-command
  enablement while using resolved strategy/engine settings;
- preflight occurs before enrichment/locks/writes and dry-run contradiction
  detection cannot mutate files;
- new rows store strategy, historical profile rows remain unchanged;
- success, dry run, exception, and signal termination store effective strategy;
- v1/v2 result decoder covers repository, health, reports, eval, and import;
- health schema v3 and engine/default/egress behavior have JSON/text/HTML
  fixtures;
- migration 017 upgrades a real pre-017 DB, preserves historical profile rows,
  and retention treats mixed versions identically;
- events and health use strategy terminology without relabeling old JSON.

### Workflow

- YAML v2 accepts engine and rejects v1/runner/profile/inherit;
- task YAML v2 accepts engine and rejects v1/profile;
- classic Markdown compiles to IR v3;
- stale v1 YAML remains classified and receives an actionable parser error;
- complete strict DTO tests cover solo/map/route/gate/budget plans, unknown
  nested keys, IDs, topology, refs, and resource limits;
- missing or incompatible engines fail before run insertion;
- exact model precedence and one-level alias resolution for LLM/agent/SDK;
- workflow default and unit `llm` objects deep-merge and freeze in invocation
  identity;
- plan contains all referenced snapshots and no resolved secret values;
- `extraParams` with nested credentials cannot enter a workflow snapshot;
- strict decoding rejects unresolved, mismatched, and unreferenced catalog
  entries;
- frozen plan is authoritative when step-row title/instructions/criteria are
  tampered; step-spine mismatch rejects before mutation;
- frozen workflow/engine/host concurrency min rules are pinned for LLM and agent
  maps;
- config, endpoint, alias, model, bin, and args edits after start do not change
  dispatch, brief, report, resume, or gates;
- credential rotation changes runtime value but not plan or unit hashes;
- changed credential variable name changes hashes;
- SDK input identity includes the transitive frozen fallback LLM snapshot;
- native dispatch performs no config load;
- required and optional gate judge behavior uses the frozen snapshot;
- `--require-gates` changes policy without live-config judge selection;
- engine/brief/report derive identical prompts, unit IDs, and hashes;
- gate rows persist engine/runtime/model/hash and preserve loop/retry/crash
  identity and budget exclusions;
- completed replay avoids dynamic env, binary, network, and git checks;
- malformed, noncanonical, wrong-version, and hash-mismatched plans fail before
  mutation or dispatch;
- plan validation occurs before lease/lifecycle writes and contention is
  rechecked atomically;
- echoed credential, direct-secret, secret-substitution, env-asset, and
  non-allowlisted passthrough sentinel values are redacted before persistence
  or diagnostic rendering in workflow rows, task logs, proposal storage,
  improve results, events, and agent/propose output;
- IR v2/null-plan list/status/watch/abandon work and all execution mutation is
  rejected;
- command-table tests cover v2, null, future, corrupt, completed-old, and force
  start; rejected commands make no writes, while malformed-plan abandon makes
  only the allowed run-lifecycle update;
- manual report resolves declared refs for redaction-only use and rejects
  missing refs without mutation;
- migration 010 and repository/output DTO fixtures preserve historical rows and
  expose plan support plus v3 engine/runtime/platform/model fields.

### Public Artifacts

- generated schema drift tests pass;
- versioned agent/propose/health/task/wiki/improve readers and output goldens
  follow the output ledger;
- active docs and help expose only engine/strategy syntax;
- archived docs and historical changelog entries are not bulk rewritten;
- package build contains renamed strategy assets and no removed built-in paths;
- package contains migration help and all three public schemas;
- downgrade backup/restore fixtures use SQLite-consistent pre-cutover backups;
- task doctor reports stale generated commands without mutating custom commands.

## Verification Gate

Run focused tests during each phase. Before merge, run:

```sh
bunx biome check --write src/ tests/
bun run check
bun run build
```

Also run config/task/workflow schema generation and drift tests, migration
fixtures, setup/install regressions, package-content assertions, Node smoke,
compiled-binary smoke, SDK cleanup tests, and deterministic secret-sentinel
tests over plans, databases, events, task logs, results, brief/report output,
and errors. Release CI must enforce these gates rather than document them only.

## Definition of Done

The refactor is complete only when:

- every public execution selector is an engine and every improve preset is a
  strategy;
- config, setup, health, tasks, improve, workflows, and docs agree on one
  schema;
- no runtime path infers execution kind from profile-pool membership or an
  engine name;
- no workflow dispatch or gate path reselects execution from live config;
- no secret value AKM resolves from declared bindings enters durable state or
  normal diagnostic output;
- historical storage remains truthful and readable;
- no compatibility parser, legacy executor, or duplicate SDK/CLI switch remains;
- all required verification passes.

## Deliberate Exclusions

- no universal execution service;
- no engine or strategy classes;
- no adapter/plugin registry;
- no new public SDK or exports map;
- no module re-slice;
- no automatic config or workflow conversion;
- no v2 workflow executor;
- no provider, search, show, registry, or write-target behavior changes;
- no unrelated release-system redesign.
