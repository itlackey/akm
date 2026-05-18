# Reflect: Multi-Mode Execution + Config Refactor

This plan bundles two related changes:

1. **Configuration refactor** — normalize connection config into a top-level
   `profiles` section (`profiles.llm.<name>` + `profiles.agent.<name>`) and
   move per-process mode/profile selection into the section that owns the
   process (`improve.processes.<name>`).
2. **Reflect multi-mode dispatch** — let reflect run in `llm`, `agent`, or
   `sdk` mode, selected per-process via the new shape.

Phase 1 is a prerequisite for Phase 2.

## Modes

Three modes:

| Mode | Runner | Profile pool |
|---|---|---|
| `llm` | `chatCompletion(connection, messages)` — direct HTTP | `profiles.llm.<name>` |
| `agent` | `runAgent(profile, prompt)` — opencode / claude CLI subprocess | `profiles.agent.<name>` with `platform: "opencode" \| "claude"` |
| `sdk` | `runOpencodeSdk(profile, prompt)` — **in-process opencode** via its programmatic API | `profiles.agent.<name>` with `platform: "opencode-sdk"` |

**Anthropic / Claude Agent SDK is not supported.** The previous `runAgentSdk`
implementation (which dispatched to the Anthropic SDK / Claude Agent SDK)
is removed. `sdk` mode now exclusively means *in-process opencode* — it
bypasses the subprocess startup tax (~3–5s/call) while still giving access
to opencode's tool stack. opencode is the only agent runtime supported,
whether via CLI (`agent`) or in-process (`sdk`).

---

## Problem

Reflect currently always runs through the agent CLI path. For a 69-ref improve
run this takes ~35 minutes — ~30s/call dominated by opencode subprocess startup
and session init.

Reflect's *context is statically pre-assembled* by `buildReflectPrompt`, so
the agent runtime earns nothing *today*. A direct LLM call is 3–5× faster.
But the agent path is the only seam where reflect's context could later become
dynamic (embedding-based related-asset retrieval, MCP-served live signals,
user-installed opencode plugins). The plan keeps the agent path as a
first-class mode rather than treating it as legacy.

Meanwhile, today's config bolts each connection on where it was first needed:
- `config.llm` is a single connection with per-feature model overrides
  (`judgeModel`) and per-feature flags (`features.<name>`)
- `config.agent.profiles` holds both CLI and SDK profiles, distinguished by a
  `sdkMode: true` flag
- `config.agent.processes` ties named processes (`reflect`, `propose`, `task`)
  to a profile name + timeout
- `config.improve.reflectCooldownByType` lives in its own section

Users who want multiple LLM connections (cheap model, judge model, local
Ollama) end up duplicating endpoint/apiKey across overrides. Users who want
reflect on direct-LLM today have no place to express that intent in config.

## Goals

1. **One profile pool per connection kind**, declared once at the top level:
   - `profiles.llm.<name>` — endpoint + model + apiKey + tuning
   - `profiles.agent.<name>` — required `platform: "opencode" | "claude" | "opencode-sdk"`
     - `"opencode"` / `"claude"` → CLI subprocess profiles (existing builders)
     - `"opencode-sdk"` → in-process opencode (via the opencode npm package /
       programmatic API)
2. **Single `features` tree** at the top level holds every named LLM/agent
   operation in the app, grouped by the section/lifecycle that runs it:
   `features.improve.<name>`, `features.index.<name>`, `features.search.<name>`.
   Each entry uses the unified shape (`enabled`, `mode`, `profile`,
   `timeoutMs`, plus a process-specific `options` block for tuning). This
   replaces both the old top-level `features` flags AND the scattered
   `improve.processes` map — one canonical surface.
3. **Tasks resolve their runner from the task YAML**, not from akm config.
   Stash tasks (`<stash>/tasks/*.yml` from the recent MD→YAML migration)
   carry their own `mode` + `profile` fields. The task runner reads those
   from the YAML and resolves against the new profile pool. No
   `config.tasks` section exists.
4. **Reflect supports three modes** (`llm`, `agent`, `sdk`), each binding to
   a profile from the appropriate pool.

### Process entry shape (used everywhere)

Three forms, all valid at any `features.<section>.<name>` slot:

```jsonc
"X": true                                          // enabled, all defaults
"X": false                                         // disabled (replaces the old features: false)
"X": {
  "enabled": true,                                 // optional, default true
  "mode": "llm" | "agent" | "sdk",                 // optional, inferred (see Resolution rules)
  "profile": "<name>",                             // optional, falls back to defaults.<pool>
  "timeoutMs": 60000,                              // optional, null = unlimited
  "options": { /* process-specific tuning */ }     // optional, see per-process docs
}
```

This is the unified shape that replaces the old `features.<name>: boolean |
{enabled, profile}` AND the old `improve.processes.<name>: {profile,
timeoutMs}`. Same shape everywhere.

**`options`** is the home for process-specific tuning that doesn't fit
the generic shape. Examples:
- `features.improve.reflect.options.cooldown` — per-asset-type reflect
  cooldown in days (replaces the old `improve.reflectCooldownByType`)
- `features.improve.reflect.options.maxRefineIters` — self-refine cap
- `features.improve.distill.options.judgeRubric` — rubric override

Per-process `options` schemas are validated by the parser using a known
schema map keyed on `<section>.<process>` — unknown keys warn-and-ignore.

---

## Phase 1 — Configuration refactor

### Target shape

```jsonc
{
  "$schema": "https://itlackey.github.io/akm/schemas/akm-config.v2.json",
  "configVersion": 2,                  // NEW: used by load-time migration

  "profiles": {
    "llm": {
      "openai-mini":     { "endpoint": "https://api.openai.com/v1/chat/completions",
                            "model": "gpt-4o-mini", "apiKey": "${OPENAI_API_KEY}",
                            "temperature": 0.3, "supportsJsonSchema": true },
      "openai-judge":    { "endpoint": "https://api.openai.com/v1/chat/completions",
                            "model": "gpt-4o", "apiKey": "${OPENAI_API_KEY}",
                            "supportsJsonSchema": true },
      "ollama-local":    { "endpoint": "http://localhost:11434/v1/chat/completions",
                            "model": "qwen2.5-coder" }
    },
    "agent": {
      "opencode-default": { "platform": "opencode", "bin": "opencode", "args": ["run"] },
      "claude-cli":       { "platform": "claude",   "bin": "claude",   "args": ["--print"] },
      "opencode-sdk":     { "platform": "opencode-sdk",
                            // In-process. Field shape mirrors what opencode's
                            // programmatic API accepts (workspace dir, model, tools).
                            "workspace": "${PWD}",
                            "model": "anthropic/claude-sonnet-4-5" }
    }
  },

  "defaults": {
    "llm":     "openai-mini",
    "agent":   "opencode-default",
    // Section-level defaults that used to live as siblings of processes.
    // Each is just a CLI default — `--limit 50` and `--preset fast` still win.
    "improve": { "limit": 25, "preset": "custom" }
  },

  // Every named LLM/agent operation in the app lives under here, grouped by
  // the section/lifecycle that runs it. Replaces the v1 top-level `features`
  // block AND the original draft's `improve.processes` / `index.processes` /
  // `search.processes` split.
  "features": {

    // Operations during `akm improve`. Names that overlap with v1 feature
    // flags use the feature-flag spelling for consistency.
    "improve": {
      "reflect": {
        "mode": "llm", "profile": "openai-mini", "timeoutMs": 60000,
        "options": {
          // Per-asset-type reflect cooldown in days. Replaces the old
          // improve.reflectCooldownByType key.
          "cooldown": { "memory": 2, "lesson": 7, "knowledge": 30, "task": 60 }
        }
      },
      "distill":               { "mode": "llm", "profile": "openai-judge" },
      "memory_consolidation":  { "mode": "llm", "profile": "openai-mini" },
      "graph_extraction":      false,                                       // skip in improve (handled at index)
      "propose":               { "mode": "sdk", "profile": "opencode-sdk" },
      "memory_improve":        { "mode": "llm", "profile": "openai-mini" },
      "feedback_distillation": true
    },

    // Operations during `akm index`. Replaces v1's three index-time feature flags.
    "index": {
      "memory_inference": true,                                             // shorthand: enabled + defaults
      "graph_extraction": { "profile": "openai-mini" },
      "metadata_enhance": false
    },

    // Operations during `akm search` / `akm curate`. Replaces v1's curate_rerank flag.
    "search": {
      "curate_rerank": true
    }
  }
}
```

Notes:
- **No `improve.schedule`.** Scheduling is owned by stash tasks
  (`<stash>/tasks/*.yml`); akm config does not duplicate it.
- **No `tasks` section.** Task definitions live in the stash. Each task YAML
  carries `mode` + `profile` for its own dispatch.

### Resolution rules

For a process `P` in section `S` (read from `config.features[S][P]`):

1. **Entry normalization**:
   - `true` → `{ enabled: true }`
   - `false` → `{ enabled: false }`
   - Object → used as-is; missing `enabled` defaults to `true`
2. **Enabled check**: if `enabled: false`, the caller short-circuits (no
   runner resolved, no call made). This is how former feature flags disable.
3. **Mode** = entry's `mode`, else inferred:
   - `entry.profile` is set → infer from the named profile's pool
     (LLM profile → `llm`, opencode-sdk profile → `sdk`, opencode/claude
     profile → `agent`)
   - Neither set → `defaults.llm` exists → `llm`; else `defaults.agent` → `agent`
4. **Profile name** = entry's `profile`, else `defaults.llm` / `defaults.agent`
5. **Profile lookup**:
   - `mode: "llm"` → `profiles.llm[<name>]` (error if missing)
   - `mode: "agent" | "sdk"` → `profiles.agent[<name>]` (error if missing)
6. **Mode/platform consistency** validated at config load (cross-ref pass)
   AND at resolve time:
   - `mode: "llm"` ⇒ name must exist in `profiles.llm`
   - `mode: "agent"` ⇒ profile must exist with `platform: "opencode" | "claude"`
   - `mode: "sdk"` ⇒ profile must exist with `platform: "opencode-sdk"`
   - Any other combination is an error at load time with a specific diagnostic

For tasks: same resolution but the inputs come from the task YAML
(`task.mode`, `task.profile`) instead of an akm config section.

### Cross-ref validation

A new pass after `parseConfig` walks every `processes[*]` entry and feature
profile reference, collects all dangling-name / mode-pool errors, and fails
fast with one diagnostic listing every error. Caught at load, not at first
use. New file: `src/core/config-validate.ts`.

### Migration — auto-migrate with one-time notice

Adopted approach: **auto-migrate with explicit version gate**.

| | Behavior |
|---|---|
| Detection | `configVersion < 2` OR old keys present ⇒ migrate |
| Action | Migrate inline, write back, single one-time notice |
| Backup | Timestamped backup (existing `backupExistingConfig`) |
| CI safety | Cron jobs continue working through upgrade |
| Override | `AKM_NO_AUTO_MIGRATE=1` + `akm config migrate --dry-run` |

Rationale: silently breaking every unattended cron is worse than rewriting
the file. The project already writes timestamped backups on every save, and
adding `configVersion: 2` makes the migration idempotent and detectable.

**The migrator transforms the old `features` block AND the old
`improve.*` keys into the unified `features` tree**:
- `config.llm.features.{memory_inference, graph_extraction, metadata_enhance}` → `config.features.index.*`
- `config.llm.features.{memory_consolidation, feedback_distillation}` → `config.features.improve.*`
- `config.llm.features.curate_rerank` → `config.features.search.curate_rerank`
- `config.improve.reflectCooldownByType` → `config.features.improve.reflect.options.cooldown`
- `config.improve.limit` → `config.defaults.improve.limit`
- (no `improve.executionProfile` in v1 — the v2 `defaults.improve.preset` is new)

**Migration also strips `sdkMode`, `config.agent.processes["task"]`, and any
`config.improve.schedule`** — these are dropped, not transformed.

**File-locking**: `akm config migrate` and the inline auto-migrator both
acquire `<config-dir>/.akm/migrate.lock` before reading, write atomically,
release. Any `akm <cmd>` started while a migrate is in flight blocks on the
lock (or fails with a clear message if `--no-wait`).

**Multi-source config**: today config layers `~/.config/akm/config.json` <
`<project>/.akm/config.json` (walking up from cwd). The migrator:
- Visits every layer it discovers
- Rewrites each file in place, preserving which keys lived where
- Writes `configVersion: 2` into each migrated file
- If a layer is read-only → prints migrated content for manual apply

**Env vars**: `AKM_LLM_API_KEY` continues to work — it injects into the
resolved default LLM profile (`profiles.llm[defaults.llm].apiKey`). New
per-profile pattern: `AKM_PROFILE_<UPPER_NAME>_API_KEY` (e.g.
`AKM_PROFILE_OPENAI_JUDGE_API_KEY`).

### Files touched (refactor)

This list is exhaustive. Files reading old paths that aren't updated will
silently dereference `undefined` post-migration.

#### Config core
| Path | Change |
|---|---|
| `src/core/config.ts` | New `AkmConfig` shape; `parseLlmConfig` → `parseLlmProfilesMap`; remove top-level `llm`/`agent`; replace the v1 `features` block with the new `features.{improve,index,search}.<name>` tree (all leaves parsed by the same `parseProcessEntry` helper); remove top-level `improve` section (its keys move to `defaults.improve` or under specific process `options`); remove `improve.schedule` parsing; bump `configVersion: 2` |
| `src/core/config.ts:applyRuntimeEnvApiKeys` (lines 1832–1834) | `AKM_LLM_API_KEY` → inject into `profiles.llm[defaults.llm].apiKey`; add `AKM_PROFILE_<NAME>_API_KEY` loop |
| `src/core/config.ts:sanitizeConfigForWrite` (lines 780–783) | Strip `apiKey` from every `profiles.llm.*` entry, not just `config.llm` |
| `src/core/config.ts:resolveConfigSources` (lines 1845–1870) | Auto-migrate hook called between parse and validate |
| `src/core/config-validate.ts` (new) | Cross-ref pass |
| `src/core/errors.ts` (line 63) | Update `LLM_NOT_CONFIGURED` hint to reference `profiles.llm.<name>` |
| `src/cli/config-migrate.ts` (new) | `akm config migrate [--dry-run] [--no-wait]` |
| `schemas/akm-config.json` | Rewrite for v2 shape; bump to `akm-config.v2.json`; remove `sdkMode`, `tasks.processes`, `improve.schedule` fields |

#### Agent integration
| Path | Change |
|---|---|
| `src/integrations/agent/config.ts` | `parseAgentProfilesMap` moves under `profiles.agent`; required `platform: "opencode" \| "claude" \| "opencode-sdk"`; remove the old `sdkMode: true` (was Anthropic) and its `model`/`endpoint`/`apiKey` inheritance fields; `parseProcessEntry` removed; `resolveProcessAgentProfile` removed (replaced by `resolveProcessRunner`) |
| `src/integrations/agent/runner.ts` (new) | `RunnerSpec` + `resolveProcessRunner(section, processName, config)` reading `config.features[section][processName]`; `isProcessEnabled` sibling; `getProcessOptions(section, processName, config)` returns the typed `options` block |
| `src/integrations/agent/sdk-runner.ts` | **Rewrite.** Current implementation calls the Anthropic / Claude Agent SDK — remove that. Replace with `runOpencodeSdk(profile, prompt, opts)` that invokes opencode's programmatic API in-process. Public export renamed from `runAgentSdk` to `runOpencodeSdk`. Consider renaming the file to `opencode-sdk-runner.ts` for clarity. |
| `src/integrations/agent/spawn.ts` (line 22) | Extend `AgentFailureReason`: add `llm_rate_limit`, `llm_content_filter`, `llm_invalid_json` |

#### LLM consumers (must be re-routed)
| Path | Change |
|---|---|
| `src/llm/client.ts` | `chatCompletion` gains optional `responseSchema` arg for structured outputs |
| `src/llm/call-ai.ts` | Use `resolveProcessRunner` instead of reading `config.agent.default` + `config.llm` directly |
| `src/llm/feature-gate.ts` | **Replace** `isLlmFeatureEnabled(config, key)` with `isProcessEnabled(section, processName, config)` reading from the unified `processes` registry. `LlmFeatureFlags` type deleted. |
| `src/llm/index-passes.ts:resolveIndexPassLLM` | Read `index.processes.<pass>` via `resolveProcessRunner("index", ...)`; fall back to `defaults.llm` |
| `src/llm/graph-extract.ts` (line 428) | Route through `isProcessEnabled("index", "graph_extraction", config)` (or `"improve"` depending on call site) |
| `src/llm/memory-infer.ts` | Take `LlmConnectionConfig` from resolved profile, not `config.llm` |
| `src/llm/metadata-enhance.ts` | Same |
| `src/indexer/memory-inference.ts` (line 127) | Route through `isProcessEnabled("index", "memory_inference", config)` |
| `src/core/memory-contradiction-detect.ts` (lines 216, 287–288) | Read connection from resolved profile; feature gate via `isProcessEnabled` |

#### Commands (read old paths)
| Path | Change |
|---|---|
| `src/commands/distill.ts` (lines 521, 524, 725, 914, 923) | Replace `config.llm` + `config.llm.judgeModel` with `resolveProcessRunner("improve", "distill", config)` |
| `src/commands/consolidate.ts` (lines 619, 632, 685, 687, 1189, 1191) | Same; `config.llm.contextLength` becomes `profile.contextLength` |
| `src/commands/remember.ts` (lines 192, 197) | Resolve via `resolveProcessRunner("improve", "memory-improve", ...)` |
| `src/commands/improve.ts` (line 1982 + cooldown logic at 1124–1149) | Stop mutating `config.llm` inline; use `profiles.llm[<name>]` snapshot. Move cooldown read from `config.improve.reflectCooldownByType` to `getProcessOptions("improve", "reflect", config).cooldown`. Read `--limit` default from `config.defaults.improve.limit`. |
| `src/commands/health.ts` (lines 261, 273, 296) | Read `config.profiles.agent.*`, `config.defaults.agent` |
| `src/commands/tasks.ts` (lines 369–370) | `config.defaults.agent`, `listAgentProfileNames(config.profiles.agent)` |
| `src/commands/agent-support.ts` (line 27) | `parseAgentConfig(config.profiles.agent)` |
| `src/commands/propose.ts` | Uses `resolveProcessRunner("improve", "propose", config)` |
| `src/commands/reflect.ts` | (Phase 2 dispatcher, see below) |
| `src/commands/config-cli.ts` (lines 126–134, 210–217, 265–276, 334) | Rewrite `get/set/unset` key handlers for `profiles.llm.<name>.*`, `profiles.agent.<name>.*`, `improve.processes.<name>.*`; default-profile UX for unqualified paths |

#### Tasks (stash YAML, not config)
The task runner stops reading `config.agent.processes["task"]` and instead
reads `mode` + `profile` from the task YAML itself. No new config section.

| Path | Change |
|---|---|
| `src/tasks/runner.ts` (lines 137–138, 340–348) | Remove `resolveProcessAgentProfile("task", agentCfg)` call. Read `task.mode` + `task.profile` from the parsed YAML. Resolve via a lower-level `resolveRunner(mode, profileName, config)` helper that hits the global profile pools directly. |
| `src/tasks/validator.ts` (line 60) | Remove `requireAgentProfile(config.agent, ...)` call. Validate `task.profile` exists in the appropriate profile pool. |
| `src/tasks/schema.ts` (line 32; YAML schema) | Add `mode` (required) and `profile` (required) fields to the task YAML schema; deprecate any old per-task `agentProfile`/`sdkMode` keys |
| `src/templates/tasks/*.yml` (any built-in task templates) | Add `mode` and `profile` to each template so existing example tasks remain valid |

#### Setup / doctor (write old shape today)
| Path | Change |
|---|---|
| `src/setup/setup.ts` (lines 1245–1248, 1583, 1637–1638) | Read+write `profiles.*`, `defaults.*` instead of `config.agent.*`, `config.llm`; drop `sdkMode` prompts |
| `src/commands/doctor.ts` (if it touches config) | Update assertions about expected shape |

#### CLI flags / help
| Path | Change |
|---|---|
| `src/cli.ts` (lines 3583, 3705, 3823, 3898) | Help text — replace references to `config.agent.profiles`, `config.agent.default`, `config.improve.reflectCooldownByType` paths; add `--mode <llm\|agent>` and `--profile` flags on `reflect`/`improve`/`propose` |

#### Docs that teach old shape
| Path | Change |
|---|---|
| `docs/config.md` | Full rewrite |
| `docs/migration/v1.md` (lines 179, 185, 193, 290, 292) | Section appended for v1→v2 config migration; note Anthropic SDK removal |
| `docs/technical/improve-workflow.md` (lines 188, 212, 213, 229, 331, 336) | Rewrite the config snippets |
| `docs/technical/architecture.md` (lines 252, 254, 272) | Same |
| `docs/posts/release-0.8.0.md` (line 122) | Append note pointing at v2 |
| `docs/posts/release-0.7.0.md` | Add banner: "v0.7.0 config; see migration/v1.md for v2" |

#### Schema / spec contract tests
| Path | Change |
|---|---|
| `schemas/akm-config.json` | Rewrite to v2 shape |
| `tests/contracts/v1-spec-section-12-agent-config.test.ts` (lines 61–63) | Update assertions or move under `v2-spec-*` |
| `tests/contracts/v1-spec-section-14-llm-features.test.ts` (lines 22, 80, 82) | Same |
| `tests/contracts/v1-spec-section-5-configuration.test.ts` (line 28) | Same |
| `tests/contracts/config-schema-drift.test.ts` (lines 13–29) | Update locked feature-flag path to top-level `features` |

#### Test files that read old shape and will break
| Path | Change |
|---|---|
| `tests/agent/agent-config-loader.test.ts` | Rewrite for new shape |
| `tests/config-llm-features.test.ts` | Rewrite or split into `tests/config-features.test.ts` |
| `tests/core/config.test.ts` | Extend with `configVersion`, migration, cross-ref validation |
| `tests/cli/config-migrate.test.ts` (new) | Old→new conversion; backup; multi-layer; idempotent; lock contention; verify `sdkMode`/`tasks.processes`/`improve.schedule` are stripped |
| `tests/integrations/agent/runner.test.ts` (new) | `resolveProcessRunner` for each mode; mode/platform mismatch |
| `tests/integrations/agent/sdk-runner.test.ts` | Rewrite — was Anthropic-SDK fixtures; now tests `runOpencodeSdk` against a stubbed opencode programmatic API. May be renamed to `opencode-sdk-runner.test.ts` to match the source file rename. |
| `tests/tasks/runner.test.ts` | Rewrite tests so task fixtures carry `mode` + `profile` in YAML and the runner resolves through the new helper |

---

## Phase 2 — Reflect multi-mode dispatch

Built on the new config. Cannot land without Phase 1.

### RunnerSpec

```ts
// src/integrations/agent/runner.ts
export type ProcessSection = string; // extensible — "improve" | future

export type RunnerSpec =
  | { kind: "llm";   connection: LlmConnectionConfig; timeoutMs?: number }
  | { kind: "agent"; profile: AgentProfile;           timeoutMs?: number }
  | { kind: "sdk";   profile: AgentProfile;           timeoutMs?: number };

export function resolveProcessRunner(
  section: ProcessSection,
  processName: string,
  config: AkmConfig,
): RunnerSpec { /* see resolution rules above */ }

// Lower-level helper used by the task runner where (mode, profile) come
// from a task YAML rather than a config section.
export function resolveRunner(
  mode: "llm" | "agent" | "sdk",
  profileName: string,
  config: AkmConfig,
): RunnerSpec { /* same dispatch, no section lookup */ }
```

The `"sdk"` discriminant is preserved as separate from `"agent"` so the
config-level user intent ("I want in-process, not subprocess") survives all
the way to the runner. The runner is just `runOpencodeSdk` — no Anthropic
SDK path lives behind this anymore.

### Reflect dispatcher

Replace `src/commands/reflect.ts` lines ~547–556:

```ts
const runner = options.runner ?? resolveProcessRunner("improve", "reflect", config);
let iterResult: AgentRunResult;

switch (runner.kind) {
  case "llm":
    iterResult = await runReflectViaLlm({
      prompt,
      systemPrompt: REFLECT_SYSTEM_PROMPT,
      priorDraft,                       // multi-turn — see below
      iteration: iter,
      connection: runner.connection,
      timeoutMs: runner.timeoutMs,
      chat: options.chat,               // existing test seam
      responseSchema: REFLECT_JSON_SCHEMA, // structured-output where supported
    });
    break;
  case "sdk":
    iterResult = await runOpencodeSdk(runner.profile, prompt ?? "", runOptions);
    break;
  case "agent":
    iterResult = await runAgent(runner.profile, prompt, runOptions);
    break;
}
```

### Multi-turn self-refine in LLM mode

Madaan et al. *Self-Refine* (arXiv:2303.17651) and Shinn et al. *Reflexion*
(arXiv:2303.11366) both use an assistant→critique→refine turn structure.
Adopting:

```ts
// runReflectViaLlm
const messages: ChatMessage[] = [
  { role: "system", content: REFLECT_SYSTEM_PROMPT },
  { role: "user",   content: buildReflectUserPrompt(input) },
];
if (priorDraft !== undefined && iteration > 0) {
  messages.push({ role: "assistant", content: priorDraft });
  messages.push({ role: "user",      content: REFLECT_CRITIQUE_PROMPT });
}
```

Benefits: (i) prompt caching catches the system+initial-user prefix across
iterations (OpenAI automatic caching) — real cost win on iter 2+; (ii) the
model treats its prior as its own utterance, empirically a stronger
self-critique signal than labelled "Previous draft" in a fresh user turn.

**Agent and SDK modes keep the current single-shot `priorDraft` injection**
— neither subprocess sessions (agent) nor a fresh in-process opencode
session per call (sdk) carry state cleanly across iterations.

### Structured output for LLM mode

`chatCompletion` gains an optional `responseSchema` arg. When the connection
has `supportsJsonSchema: true`, send OpenAI `response_format: { type:
"json_schema", json_schema: { schema: REFLECT_JSON_SCHEMA, strict: true } }`.
Otherwise fall back to the existing `RESPONSE_CONTRACT_JSON` in-prompt
contract.

This eliminates the `llm_invalid_json` failure class for capable providers.
Ollama-style endpoints keep working via the prompt contract.

### Failure handling

`runReflectViaLlm` maps errors to extended `AgentFailureReason`:

| Cause | Reason | Outer-loop behavior |
|---|---|---|
| HTTP 429 / rate-limit error | `llm_rate_limit` | Exponential backoff, retry |
| Provider content-filter / refusal | `llm_content_filter` | Non-retryable; record + skip |
| Schema-validation failure | `llm_invalid_json` | Single re-prompt with critique; then fail |
| Network timeout | `timeout` (existing) | Existing retry logic |
| Other | `non_zero_exit` (existing) | Existing |

### CLI overrides

Add to `akm reflect`, `akm improve`, and `akm propose`:

```
--mode <llm|agent|sdk>    Override the configured mode for this run
--profile <name>          Override the configured profile for this run
--dry-run-resolve         Print the resolved RunnerSpec without executing
```

---

## Considered alternatives

1. **Section-owned `<section>.processes` maps** (intermediate draft).
   Rejected — left process-specific tuning (`improve.reflectCooldownByType`)
   stranded as a sibling of the process entry, and required two top-level
   surfaces (`features` + `improve.processes`) for one underlying operation.
   The current `features.<section>.<process>.options` shape collocates
   tuning with the process and gives a single canonical home for everything.

1a. **Single flat top-level `processes` registry** (no section grouping).
   Trivially simple resolver but loses the section-as-lifecycle grouping
   that makes the config readable. Rejected.

1b. **Keep a separate top-level `features` section** alongside section-owned
   `processes`. Rejected — two configuration surfaces for one underlying
   operation, with substantial naming overlap (`features.graph_extraction`
   vs `improve.processes.graph-extract`).

2. **Keep the Anthropic / Claude Agent SDK path.** Rejected — ties the
   project to Anthropic-specific tool-use semantics and duplicates capability
   that `llm` mode already covers via direct HTTP. The `sdk` mode is
   preserved but **only against opencode** (in-process opencode programmatic
   API); the runner internals change from "call Anthropic SDK" to "call
   opencode SDK." opencode is the only agent runtime supported, whether via
   CLI or in-process.

3. **Hard error on old config shape + manual `akm config migrate`**.
   Rejected after review pointed out cron jobs would silently fail
   mid-improve-run. Kept the explicit `akm config migrate` as an opt-in path
   for users who want to inspect before write.

4. **Persistent `opencode serve --attach` pool**. ~15–20% gain on agent path
   vs 3–5× for direct LLM. Not rejected — queued as follow-up ticket
   "opencode session pool for agent-mode reflect/propose".

5. **Add a `tasks` config section.** Rejected — tasks are stash-resident
   YAMLs (`<stash>/tasks/*.yml`, recent MD→YAML migration). Each task
   declares its own `mode`/`profile`/`schedule`. Duplicating that into
   `config.tasks.processes` would split the source of truth.

6. **`improve.schedule` in akm config.** Rejected for the same reason —
   scheduling is owned by stash task YAMLs that wrap `akm improve` calls.

---

## Tests

### Phase 1
- `tests/core/config.test.ts` — new shape parsing, `configVersion`, cross-ref validation, rejection of `sdkMode`/`tasks.processes`/`improve.schedule` keys
- `tests/cli/config-migrate.test.ts` — old→new (covers `config.llm`, `agent.profiles`, `agent.processes`, `agent.default`, `llm.judgeModel`, `llm.features.<all-six-keys>` → routed to the correct section's `processes`, `improve.schedule`, `sdkMode`); backup; multi-layer; idempotent; concurrent-migrate lock
- `tests/integrations/agent/runner.test.ts` — `resolveProcessRunner` per mode, mode/pool mismatch, missing-profile error
- `tests/tasks/runner.test.ts` — task YAML fixtures with `mode`/`profile` resolve through `resolveRunner` directly
- `tests/cli/config-cli.test.ts` — `akm config get/set/unset` against new paths

### Phase 2
- `tests/commands/reflect.test.ts` — three groups:
  - **llm mode**: `options.runner = { kind: "llm", ... }` + fake `chat` → no spawn, JSON parsed, proposal queued; multi-turn self-refine asserts correct message sequence on iter 2+; `responseSchema` honored when `supportsJsonSchema: true`
  - **sdk mode**: `options.runner = { kind: "sdk", profile }` → `runOpencodeSdk` path; no subprocess spawned
  - **agent mode**: existing spawn-based tests unchanged
- `tests/commands/reflect-failure.test.ts` (new) — each new `AgentFailureReason` variant maps correctly; backoff on `llm_rate_limit`
- `tests/integrations/agent/opencode-sdk-runner.test.ts` — exercises `runOpencodeSdk` with a stubbed opencode programmatic API
- `tests/architecture/llm-stateless-seam.test.ts` — `runReflectViaLlm` is pure (no module-level state)

### Quality parity gate (rollout)
- Sample 20 assets, run reflect under each mode, judge with existing
  `runLessonQualityJudge`. Default doesn't flip until LLM-mode mean ≥
  agent-mode mean − 0.3.

---

## Rollout

1. Implement Phase 1 (parser, validate, migrate, runner spec, every consumer in the touch list, delete `sdk-runner.ts` and its tests). All tests green.
2. Run `akm config migrate` on dev config; verify every command works.
3. Implement Phase 2 (dispatcher, `runReflectViaLlm`, multi-turn refine, structured output, CLI flags).
4. Single-scope smoke: `akm reflect <ref> --mode llm --profile openai-mini`.
5. **Quality parity gate**: 20-asset comparison run, agent vs llm. Hold default flip until parity proven.
6. Full improve pass with `improve.processes.reflect.mode = "llm"`; record timing vs 35-min baseline.
7. Update CHANGELOG with migration instructions, the breaking-change banner, and the Anthropic SDK removal notice; rewrite `docs/config.md`.
8. Merge to `release/0.8.0`.

## Expected outcome

| Metric | agent (current CLI) | sdk (in-process opencode) | llm (new) |
|---|---|---|---|
| Time/reflect call | ~30s | ~10–15s | ~6–10s |
| 69-ref run | ~35 min | ~12–17 min | ~8–10 min |
| Per-call startup | opencode boot + session | none (in-process) | none |
| Tool availability | Yes (opencode tools, MCP, plugins) | Yes (same surface, in-process) | No |
| JSON-parse failure rate | Schema enforcement via prompt | Same | Eliminated for OpenAI-class endpoints via structured output; prompt-contract fallback for others |
| Quality (self-refine) | Single-shot per iter | Single-shot per iter | Multi-turn |

## Non-goals

- **Anthropic / Claude Agent SDK support.** Removed entirely. The previous
  `sdkMode: true` flag (which selected the Anthropic SDK runner) is deleted,
  along with the SDK profile inheritance fields (`model`, `endpoint`,
  `apiKey` on agent profiles). The `sdk` mode survives but exclusively
  drives the **opencode** programmatic API.
- **`config.tasks` section.** Tasks own their own dispatch via stash YAMLs.
- **`improve.schedule` in akm config.** Scheduling lives in stash tasks.
- **Per-index-pass tuning beyond on/off + profile.** `index.processes`
  exists in Phase 1 (the three former feature flags moved here), but
  fine-grained per-pass tuning of prompts, retry counts, etc. is a
  follow-up.
- **Distill/consolidate runtime mode switching beyond config plumbing.** They
  read the new `improve.processes.<name>.{mode, profile}` for connection
  routing; their dispatch logic is preserved this iteration.
- **Persistent opencode CLI pool** (subprocess reuse via `opencode serve
  --attach`). Queued as separate ticket. The in-process `sdk` mode largely
  obviates this — keeping the CLI subprocess for users who specifically
  want a sandboxed process boundary.

## Open questions for implementer

- **`AKM_LLM_API_KEY` semantics during migration**: applies to
  `profiles.llm[defaults.llm]` post-migrate. Confirm with users running CI.
- **`akm config set llm.endpoint <url>` UX**: with no top-level `llm`, does
  the command write to `profiles.llm[defaults.llm].endpoint` (recommended)
  or require explicit `--profile`?
- **`docs/posts/release-0.8.0.md` already-published reference to old shape**:
  amend in place or leave as historical? Recommend amend with a v2 pointer.
- **Built-in task templates** (`src/templates/tasks/*.yml` if they exist):
  enumerate and add `mode`/`profile` to each. If they don't exist as a
  source of truth today, decide whether to add them in this PR or after.
