# Configuration

AKM reads one user configuration file: `$XDG_CONFIG_HOME/akm/config.json`
(normally `~/.config/akm/config.json` on Linux and macOS, or
`%APPDATA%\akm\config.json` on Windows). Set `AKM_CONFIG_DIR` to override the
directory. Project `.akm/config.json` files are not merged.

## Version 0.9

A present configuration file must set `configVersion` to exactly `"0.9.0"`.
Missing, older, newer, numeric, and malformed versions are rejected by ordinary
commands without rewriting the file. `akm migrate status` reports config and
database state independently; it exits nonzero when migration is blocked.
`akm migrate apply` installs an operator-prepared 0.9 config and applies pending
database migrations, but it never guesses profile-to-engine mappings. See [the
migration guide](../migration/v0.8-to-v0.9.md) before editing an existing
installation.

Canonical config and durable database access fail closed while a restore or
migration-apply journal is pending. Use `akm migrate status` to inspect the
phase and `akm migrate apply` to resume; do not delete journal files manually.

AKM 0.8 does not provide these migration commands. To cross from 0.8 to 0.9,
prepare the target and an independent filesystem backup first, install or stage
the 0.9 binary manually, then invoke that new binary with `migrate apply
--config`. Do not use `upgrade --migration-config` from 0.8; that installed 0.8
code cannot enforce safeguards introduced by 0.9.

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

An agent engine may set `bin`, `args`, `workspace`, `model`, `timeoutMs`, and
`modelAliases`. Only `platform: "opencode-sdk"` may set `llmEngine`; it names
the LLM engine used as that SDK engine's fallback connection.

Config-root `modelAliases` resolve by exact engine/platform column first, then
the shared `llm` column for direct and fallback LLM engines, then `"*"`. The
resolved exact model is used consistently by direct dispatch, SDK fallback,
health evidence, and frozen workflow plans.

`defaults.engine` names an LLM or agent engine. `defaults.llmEngine` must name
an LLM engine. There is no first-engine fallback.

Index passes select engines through `index.defaults.engine` or
`index.<pass>.engine`. Per-pass `model`, `timeoutMs`, and `llm` fields are
invocation overrides; `enabled: false` disables that pass. Connection fields
such as `endpoint`, `provider`, and `apiKey` belong only on named engines.

`workflow.maxConcurrency` is the native workflow engine ceiling. An explicit
value is clamped to `1..64`. When absent, AKM derives the cap once from the CPU
count (`min(16, max(1, cores - 2))`) and freezes it into the run plan, so resume
does not change policy on a different host or after config edits.

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

## Indexing

`index.indexBodyOpening` defaults to `false`. When enabled, AKM captures the
first prose paragraph of each Markdown asset body, capped at 280 characters,
into the lowest-weight search content and embedding text. Secret and env files
are never read for this field, and session-kind memories are excluded.

Changing this option changes indexed text. Run `akm index --full` after
toggling it so all entries and embeddings are rebuilt consistently. If the
setting differs from the state used to build the current index, AKM warns until
that full rebuild completes.

## Managing Config

```sh
akm config list
akm config get engines.fast
akm config set engines.fast '{"kind":"llm","endpoint":"http://localhost:11434/v1/chat/completions","model":"qwen3"}'
akm config set engines.fast.apiKey '$LOCAL_LLM_API_KEY'
akm config unset engines.old
akm config validate
akm migrate status
akm migrate status --config ./prepared-0.9.json
akm migrate apply --config ./prepared-0.9.json --dry-run
akm migrate apply --config ./prepared-0.9.json
```

Object values passed to `config set` deep-merge with their current value.
Arrays replace, `null` is only valid for nullable fields, and `config unset` is
the only deletion operation. `configVersion` cannot be set or unset with the
generic walker.

## Environment

| Variable | Purpose |
| --- | --- |
| `AKM_CONFIG_DIR` | Override the user config directory |
| `AKM_ENGINE_<NAME>_API_KEY` | Fallback credential for LLM engine `<name>` |
| `AKM_LLM_API_KEY` | Fallback only for the selected `defaults.llmEngine` |
| `AKM_EMBED_API_KEY` | Embedding credential |
| `AKM_STASH_DIR` | Override the stash directory |
| `AKM_SQLITE_JOURNAL_MODE` | SQLite journal mode: `WAL` (default), `DELETE`, or `TRUNCATE` |

For an engine named `fast`, its fallback variable is
`AKM_ENGINE_FAST_API_KEY`. An explicit `apiKey` symbolic reference is
authoritative and does not fall through to another variable.

Use `AKM_SQLITE_JOURNAL_MODE=DELETE` or `TRUNCATE` when WAL is unavailable,
such as on some NFS/SMB mounts. With the default `WAL` setting, AKM detects a
network filesystem for the data directory and falls back to `DELETE`.

## Retired Configuration

`profiles`, `llm`, `agent`, `features`, `stashes`, `defaults.llm`,
`defaults.agent`, and `defaults.improve` are rejected in 0.9. Recreate the
configuration using `engines`, `defaults.engine`, `defaults.llmEngine`, and
`improve.strategies`; AKM deliberately does not infer or rename ambiguous
profile identities.
