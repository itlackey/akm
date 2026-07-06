# Configuring Agent Profiles

## Overview

An agent profile tells akm how to run a coding agent — either as a CLI
subprocess or as an in-process library call. Profiles are declared once in
`profiles.agent` and referenced by name from `features` process entries and
task YAMLs.

You configure profiles in `profiles.agent` inside `~/.config/akm/config.json`
(or your project's `.akm/config.json`).

**Backward compatibility note:** The old `agent.profiles` shape from v1 config
is auto-migrated to `profiles.agent` at load time. Explicitly running
`akm config migrate` rewrites the file in place.

## Platform types

The required `platform` field selects the runtime:

| `platform` | Runtime | Startup cost | Tool access |
| --- | --- | --- | --- |
| `"opencode"` | opencode CLI subprocess | ~30s/call (subprocess + session init) | Full opencode tools, MCP, plugins |
| `"claude"` | Claude Code CLI (`--print` mode) | ~30s/call | Claude tooling |
| `"opencode-sdk"` | In-process opencode programmatic API | ~10–15s/call (no subprocess) | Same surface as CLI |

The Anthropic / Claude Agent SDK is **not supported** in 0.8.0. The previous
`sdkMode: true` flag (which selected the Anthropic SDK runner) is removed.
The `sdk` mode now exclusively drives the opencode programmatic API via
`platform: "opencode-sdk"`.

## Profile field reference

### CLI subprocess profiles (`platform: "opencode"` or `"claude"`)

| Field | Required | Description |
| --- | --- | --- |
| `platform` | yes | `"opencode"` or `"claude"` |
| `bin` | yes | Command to spawn (e.g. `"opencode"`, `"claude"`) |
| `args` | no | Extra args passed when akm spawns this profile |
| `stdio` | no | `"captured"` (default for automation) or `"interactive"` (default for `akm agent`) |
| `parseOutput` | no | `"text"` or `"json"` |
| `env` | no | Extra env vars passed into the spawn |
| `envPassthrough` | no | Array of env-var names to pass through from the calling process |
| `timeoutMs` | no | Per-profile timeout override |
| `commandBuilder` | no | `"opencode"` or `"claude"`. Use when a custom profile wraps one of these runtimes to get platform-correct flag shapes |
| `modelAliases` | no | Per-profile model aliases. Keys are lowercase alias strings; values are the exact model string the CLI expects |

### In-process opencode profile (`platform: "opencode-sdk"`)

| Field | Required | Description |
| --- | --- | --- |
| `platform` | yes | `"opencode-sdk"` |
| `workspace` | no | Working directory for the opencode session (default `${PWD}`) |
| `model` | no | Model identifier passed to opencode's programmatic API |

## Declaring profiles

```jsonc
// ~/.config/akm/config.json
{
  "configVersion": "0.8.0",
  "profiles": {
    "agent": {
      // opencode CLI subprocess — full tool + plugin access
      "opencode-default": {
        "platform": "opencode",
        "bin": "opencode",
        "args": ["run"]
      },

      // Claude Code CLI — non-interactive mode
      "claude-cli": {
        "platform": "claude",
        "bin": "claude",
        "args": ["--print"]
      },

      // In-process opencode — same tool surface, no subprocess startup
      "opencode-sdk": {
        "platform": "opencode-sdk",
        "workspace": "${PWD}",
        "model": "anthropic/claude-sonnet-4-5"
      },

      // Custom opencode wrapper (team config)
      "my-opencode": {
        "platform": "opencode",
        "bin": "opencode",
        "args": ["run", "--config", "~/.config/opencode/team.json"],
        "commandBuilder": "opencode"
      }
    }
  },
  "defaults": {
    "agent": "opencode-default"
  }
}
```

## Referencing profiles from features

Process entries in `features` reference profiles by name:

```jsonc
{
  "features": {
    "improve": {
      // reflect uses LLM mode — no agent profile needed
      "reflect": { "mode": "llm", "profile": "openai-mini" },

      // propose uses in-process opencode — tool access without subprocess startup
      "propose": { "mode": "sdk", "profile": "opencode-sdk" },

      // explicit agent subprocess
      "memory_consolidation": { "mode": "agent", "profile": "opencode-default" }
    }
  }
}
```

Task YAMLs at `<stash>/tasks/<id>.yml` reference profiles the same way:

```yaml
mode: agent
profile: opencode-default
command: akm improve --auto-accept=90
schedule: "7 * * * *"
```

When `mode` is omitted from a features entry, the profile's pool determines it:
LLM profile → `"llm"`, `"opencode-sdk"` platform → `"sdk"`,
`"opencode"` / `"claude"` platform → `"agent"`.

## Built-in profiles (unchanged from v1)

Five profiles ship with akm and can be used without configuration (assuming the
binary is on `PATH`):

| Profile | `bin` | Default `args` | `stdio` | Command builder |
| --- | --- | --- | --- | --- |
| `opencode` | `opencode` | `["run"]` | `interactive` | `opencode` |
| `claude` | `claude` | `[]` | `interactive` | `claude` |
| `codex` | `codex` | `[]` | `interactive` | `default` |
| `gemini` | `gemini` | `[]` | `interactive` | `default` |
| `aider` | `aider` | `["--no-auto-commits"]` | `interactive` | `default` |

Each has a `-headless` variant (e.g. `opencode-headless`) that sets
`stdio: "captured"` and `parseOutput: "json"` for automation contexts.

In v2 config the built-in profile names still resolve — but to use them from
`profiles.agent`, declare them explicitly so the profile pool is self-contained.

## Configuring commandBuilder

When you define a custom profile, set `commandBuilder` to get the platform-correct
flag shapes. Without it, the `default` builder passes `--system-prompt` and
`--model` as bare flags.

```jsonc
{
  "profiles": {
    "agent": {
      "my-opencode": {
        "platform": "opencode",
        "bin": "opencode",
        "args": ["run", "--config", "~/.config/opencode/team.json"],
        "commandBuilder": "opencode"
      }
    }
  }
}
```

Valid `commandBuilder` values: `"opencode"`, `"claude"`. Any other value (or
omitting the field) falls back to the `default` builder.

## Model aliases

### Built-in aliases

Three convenience aliases resolve to platform-appropriate model strings:

| Alias | opencode model | claude model |
| --- | --- | --- |
| `opus` | `opencode/claude-opus-4-7` | `claude-opus-4-7` |
| `sonnet` | `opencode/claude-sonnet-4-6` | `claude-sonnet-4-6` |
| `haiku` | `opencode/claude-haiku-4-5` | `claude-haiku-4-5-20251001` |

Aliases are case-insensitive. An unrecognised alias is passed verbatim.

### Global alias tiers

The config-root `modelAliases` key defines semantic tiers once and resolves
them per-platform at dispatch time. Each alias maps platform names to the
exact model string that platform expects; the reserved `"*"` key is a
fallback for platforms without their own column. Values are always literal
model strings — never other aliases.

```jsonc
// ~/.config/akm/config.json
{
  "modelAliases": {
    "fast":     { "claude": "claude-haiku-4-5-20251001", "opencode": "opencode/claude-haiku-4-5" },
    "balanced": { "claude": "claude-sonnet-4-6",         "opencode": "opencode/claude-sonnet-4-6" },
    "deep":     { "claude": "claude-opus-4-7",           "*": "opencode/claude-opus-4-7" }
  }
}
```

```sh
akm agent claude-cli --model deep --prompt "architecture review"
akm agent opencode-default --model deep --prompt "architecture review"
# Same alias, per-platform model strings.
```

Platform keys match the platform string the profile's command builder
resolves against: `claude`, `opencode`, `opencode-sdk`, or — for custom
profiles handled by the default builder — the profile's own name. Unknown
platform keys are inert.

Resolution precedence (highest first): per-profile `modelAliases` → global
`modelAliases` (platform column, then `"*"`) → built-in aliases → verbatim
pass-through.

### Custom aliases

Add per-profile aliases under the profile's `modelAliases` key:

```jsonc
{
  "profiles": {
    "agent": {
      "opencode-default": {
        "platform": "opencode",
        "bin": "opencode",
        "args": ["run"],
        "modelAliases": {
          "fast":  "opencode/claude-haiku-4-5",
          "big":   "opencode/claude-opus-4-7",
          "local": "opencode/qwen3-30b-a3b"
        }
      }
    }
  }
}
```

```sh
akm agent opencode-default --model fast --prompt "quick lint check"
akm agent opencode-default --model opus --prompt "deep architecture review"
```

## Using agent assets with akm agent

A stash agent asset (`type: agent`) bundles a system prompt, an optional
`modelHint`, and an optional `toolPolicy` into a single ref. Pass the ref as
the second positional argument to `akm agent`:

```sh
# Launch opencode embodying the code-reviewer agent
akm agent opencode-default agent:code-reviewer --prompt "review src/"

# Override the asset's modelHint with an alias
akm agent claude-cli agent:planner --model sonnet --prompt "plan the sprint"
```

To discover available agent assets:

```sh
akm search --type agent
akm curate "code review" --type agent
```

## Headless vs interactive

Use `"stdio": "interactive"` for `akm agent` sessions where the agent paints
its own UI. Use `"stdio": "captured"` (headless) for automation contexts where
akm must capture and parse the output:

```jsonc
{
  "profiles": {
    "agent": {
      "opencode-headless": {
        "platform": "opencode",
        "bin": "opencode",
        "args": ["run"],
        "stdio": "captured",
        "parseOutput": "text"
      }
    }
  },
  "features": {
    "improve": {
      "reflect": { "mode": "agent", "profile": "opencode-headless" }
    }
  }
}
```

## See also

- [Configuration reference](configuration.md) — full v2 config shape and process entry schema
- [Agent Integration](features/agent-integration.md) — AGENTS.md setup and dispatch workflows
- [CLI Reference](cli.md) — `akm agent` flags and examples
- [Migration guide](migration/v0.7-to-v0.8.md) — old `agent.profiles` → `profiles.agent` mapping
