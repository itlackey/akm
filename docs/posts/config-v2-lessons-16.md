---
title: 'One Schema to Rule Them All: The Config v2 Rewrite'
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm-knowledge
description: 'How replacing ~1.4k LOC of hand-written config parsers with a single Zod schema eliminated silent failures, auto-generates the JSON schema, and makes adding a new config field a one-line change.'
tags:
  - ai
  - agents
  - cli
  - configuration
published: true
id: 3814550
date: '2026-06-04T00:32:02Z'
---

This is part sixteen in a series about managing the growing pile of skills, scripts, and context that AI coding agents depend on. The [0.8.0 release notes](https://dev.to/itlackey/akm-080-cli-redesign-task-assets-and-belief-aware-memory-335a) cover the storage and pipeline changes that shipped alongside this rewrite; [Part thirteen](https://dev.to/itlackey/from-30-minutes-to-8-how-llm-mode-reflect-works-5epl) covers how the new `profiles.improve` config drives the improve pipeline.

Config files are where projects go to accumulate technical debt quietly. Each new feature gets a new key. Each new key gets a new parser. Each parser has slightly different error handling, slightly different defaults, and slightly different ideas about what "invalid" means. Nobody notices until a user files an issue that says "I had a typo in my config and akm just silently used defaults for three weeks."

That was the state of akm's config layer going into 0.8.0.

## What the Old Shape Looked Like

The v1 config had three top-level blocks that grew independently over two years: `llm.*` for LLM connection settings, `agent.*` for agent process settings, and `llm.features.*` boolean flags gating per-feature LLM calls. The features block was nested under `llm` for historical reasons even though many features used the agent, not the LLM. The agent's per-process map lived under `agent.processes`, while LLM-gated features used `llm.features.index.metadata_enhance` style dotted paths.

Each block had its own parser function. `parseLlmConfig`, `parseEmbeddingConfig`, `parseIndexConfig`, and a dozen more. The comment at the top of the new `config-schema.ts` is blunt about it: the Zod schema "replaces the ~1.4k LOC of legacy per-shape parsers."

The problems that accumulated in that ~1.4k LOC:

**Unknown keys were silently accepted.** If you wrote `llm.temperaure` (typo), the parser ignored it and fell back to the default temperature. No warning. You tuned a key that did nothing.

**Bad JSON was masked.** The config loader caught JSON parse errors and fell back to `DEFAULT_CONFIG` — the compiled-in defaults. Your entire config file could be corrupt and akm would start without complaint, using defaults across the board.

**Missing files fell back to defaults.** Same behavior. A missing config file and a present-but-corrupt one looked identical at runtime.

**Adding a field meant adding a parser.** Want a new boolean flag under a feature? Find the right parser function, add the extraction logic, add the type declaration, add the hint string, add the test. The cost of a new field was not one line — it was a small PR touching four or five places.

## What Zod Gives You

The 0.8.0 rewrite consolidates all of that into `src/core/config-schema.ts`: a single Zod schema that is the source of truth for the on-disk shape.

Zod handles the parse, transform, and validate steps that were previously scattered across ~1.4k LOC of hand-written code. A new config field is a one-line schema addition. Type inference means the TypeScript types for `AkmConfig` are derived from the schema automatically — no parallel maintenance between the schema and the type declarations.

The schema design makes deliberate tradeoffs between strictness and resilience:

The top-level object uses `.passthrough()` so unknown future keys round-trip intact. If a user upgrades and then downgrades, keys added by the newer version survive without triggering errors on the older version. `sanitizeConfigForWrite` decides what to strip on write.

Nested sub-objects use `.catch(undefined)` for field-level shape errors so that a typo in one field does not destroy an otherwise valid config. This preserves the legacy parser's warn-and-ignore semantics for individual fields while still catching structural problems.

`.strict()` walls gate the records that are most typo-prone: `registries[]`, `sources[]`, and `profiles.*` sub-shapes. A typo in a profile name or a source type now produces a validation error at load time.

Two cases are hard-rejected by `superRefine` rather than silently dropped: the old `stashes[]` key (replaced by `sources[]`) and a legacy source type that had been removed. Both have explicit migration paths — silently ignoring them would mask user data loss.

## The Silent Failure Fixes

The new loader changed three behaviors that were causing silent failures in the field.

**Unknown keys now error at the profile level.** A typo in `profiles.llm.my-profile` is caught at load time rather than ignored. The error message names the unexpected key and points at the profile block.

**Bad JSON now throws.** If `config.json` is not valid JSON, akm throws a `ConfigError` with the file path and the parse error. No fallback to defaults. The user finds out immediately.

**Missing files stay missing.** A missing config file is a different situation from a corrupt one, and akm treats them differently now. First run with no config: `akm setup` or an explicit `akm config set` creates the file. A missing file during a subsequent run is an error, not a silent fallback.

## Auto-Generated JSON Schema

With a Zod schema as the source of truth, generating a JSON schema for editor autocompletion is a natural output. The `schemas/akm-config.json` file is generated from the Zod schema and checked in. A CI drift test fails if the checked-in file is out of sync with the schema source — there is no manual step to remember when adding a field.

Point your editor at the schema and you get field completion and inline documentation in `config.json`:

```jsonc
{
  "$schema": "https://itlackey.github.io/akm/schemas/akm-config.0.8.0.json",
  "configVersion": "0.8.0"
}
```

The `$schema` key is optional. VSCode and other JSON Schema-aware editors pick it up automatically for field completion and inline docs.

## The New Config Shape

The 0.8.0 shape replaces the scattered `llm.*`, `agent.*`, and `llm.features.*` blocks with a unified `profiles` tree and first-class feature sections.

| Old location | New location |
|---|---|
| `llm.endpoint`, `llm.model`, `llm.apiKey` | `profiles.llm.<name>.endpoint`, `.model`, `.apiKey` |
| `agent.platform`, `agent.bin`, `agent.args` | `profiles.agent.<name>.platform`, `.bin`, `.args` |
| `agent.processes.<name>.*` | `profiles.improve.<name>.processes.*` |
| `llm.features.index.metadata_enhance` | `index.metadataEnhance.enabled` |
| `llm.features.search.curate_rerank` | `search.curateRerank.enabled` |

Named LLM connections live under `profiles.llm.<name>`, declared once and referenced by name from process entries. Named agent connections live under `profiles.agent.<name>`. The improve profile (`profiles.improve.<name>.processes.*`) binds processes to specific LLM or agent profiles and controls per-process gating. Non-improve features (`index.metadataEnhance`, `index.stalenessDetection`, `search.curateRerank`) are first-class top-level entries.

The `configVersion` field is the version gate. Configs without it, or with a pre-0.8.0 value, are auto-migrated at first run.

## The Minimal Working Config

The smallest config that gets you a fully functional 0.8.0 installation with a cloud LLM for improve operations:

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
          "reflect": { "enabled": true, "mode": "llm", "profile": "openai-mini" },
          "distill": { "enabled": true, "mode": "llm", "profile": "openai-mini" },
          "consolidate": { "enabled": true, "mode": "llm", "profile": "openai-mini" },
          "memoryInference": { "enabled": true },
          "graphExtraction": { "enabled": true, "profile": "openai-mini" }
        }
      }
    }
  },
  "defaults": {
    "llm": "openai-mini",
    "agent": "opencode-default",
    "improve": "default"
  },
  "embedding": {
    "endpoint": "http://localhost:11434/v1/embeddings",
    "model": "nomic-embed-text",
    "dimension": 384
  },
  "stashDir": "~/akm"
}
```

This is a trimmed example focused on the core profiles and defaults. The full minimal config in [docs/configuration.md](https://github.com/itlackey/akm/blob/main/docs/configuration.md) also includes `feedbackDistillation`, `index`, and `search` top-level blocks with their defaults. If you omit those blocks, akm uses compiled-in defaults for them.

For local models, swap `openai-mini` for an Ollama or LM Studio profile and drop the `apiKey` field. The `supportsJsonSchema` flag tells akm to use structured JSON output for providers that support it — set it to `true` for OpenAI-compatible endpoints that honor `response_format: {type: "json_schema"}`, leave it off for local models that do not.

## Migrating from v1

If you are on 0.7.x, you do not need to hand-edit your config. The migration command handles the key remapping:

```sh
# Preview the transformation without writing
akm config migrate --dry-run

# Apply migration — writes a timestamped backup first
akm config migrate
```

`--dry-run` shows which keys move and what the new shape looks like without writing anything. When you run without `--dry-run`, akm writes a timestamped backup to `~/.cache/akm/config-backups/` before touching the live file. Locate it with:

```sh
ls -1t ~/.cache/akm/config-backups/ | head
```

Auto-migration also runs on the first command after upgrade — a one-time notice prints to stderr with the backup path and a reminder to set `AKM_NO_AUTO_MIGRATE=1` to suppress future auto-migration. That env flag is useful for read-only CI mounts where you want to run `akm config migrate` explicitly in a deploy step.

After migration, verify the result:

```sh
akm config get configVersion
# "0.8.0"

akm config
# Full config in the new shape
```

The complete old-to-new key mapping is in [docs/migration/v0.7-to-v0.8.md](https://github.com/itlackey/akm/blob/main/docs/migration/v0.7-to-v0.8.md).

## What Adding a Field Looks Like Now

Before the rewrite, adding a new per-process option involved touching the parser function, the type declaration, the hint string, and the test. In the Zod schema, the same change is one line in the relevant sub-schema object. TypeScript picks up the new field automatically through inference. The JSON schema regenerates on the next build. The CI drift test catches it if the regeneration step is skipped.

The cost of that improvement is worth making concrete: the schema file is 641 LOC. The migration logic is another 643 LOC. The config loader itself is 590 LOC. That is 1,874 lines total (approximate) — replacing the ~1.4k LOC of parsers while also adding the migration pipeline, the strict validation, and the structured error reporting that were not present before. The maintenance surface per feature is lower, not higher.

---

Config v2 is in akm 0.8.0. The full configuration reference is in [docs/configuration.md](https://github.com/itlackey/akm/blob/main/docs/configuration.md). The [0.8.0 release notes](https://dev.to/itlackey/akm-080-cli-redesign-task-assets-and-belief-aware-memory-335a) cover the broader storage and pipeline changes that landed alongside the config rewrite. If you are running the improve pipeline and want to see how the `profiles.improve` config behaves in practice, [Your Agent Has a Memory That Runs While You Sleep](https://dev.to/itlackey/your-agent-has-a-memory-that-runs-while-you-sleep-20oh) covers 24 hours of autonomous operation with the full process config in place.

If you are upgrading, start with `akm config migrate --dry-run` and check that the output matches your expectations before applying.
