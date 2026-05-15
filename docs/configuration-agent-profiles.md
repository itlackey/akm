# Configuring Agent Profiles and Model Aliases

## Overview

An agent profile tells akm how to spawn a specific coding-agent CLI (OpenCode,
Claude Code, Codex, Gemini, Aider, or a custom wrapper). It captures the binary
name, base arguments, stdio mode, and platform-specific dispatch strategy so
that `akm agent`, `akm reflect`, and `akm propose` can drive any CLI without
hard-coded argument logic.

You configure profiles in the `agent.profiles` block of `~/.config/akm/config.json`
(or your project's `.akm/config.json`). Every field in a built-in profile is
individually overridable — you never need to re-state the whole profile.

## Built-in profiles

Five profiles ship with akm. Each one can be used immediately without any
config (assuming the binary is on `PATH`):

| Profile | `bin` | Default `args` | `stdio` | Command builder |
| --- | --- | --- | --- | --- |
| `opencode` | `opencode` | `["run"]` | `interactive` | `opencode` |
| `claude` | `claude` | `[]` | `interactive` | `claude` |
| `codex` | `codex` | `[]` | `interactive` | `default` |
| `gemini` | `gemini` | `[]` | `interactive` | `default` |
| `aider` | `aider` | `["--no-auto-commits"]` | `interactive` | `default` |

The **command builder** column indicates which argv-construction strategy is
used when `akm agent` dispatches with a system prompt or model. The `opencode`
and `claude` builders know their respective `--system-prompt` / `--model` /
`--allowedTools` flag shapes. Profiles that use the `default` builder receive
the same flags in a generic form, but tool policy is not forwarded (no
cross-platform flag standard exists for it).

## Basic profile override

Override one or more fields in a built-in profile without restating the rest.
For example, to lock the opencode profile to a specific model by default:

```jsonc
// ~/.config/akm/config.json
{
  "agent": {
    "default": "opencode",
    "profiles": {
      "opencode": {
        "args": ["run", "--model", "opencode/claude-sonnet-4-6"]
      }
    }
  }
}
```

Only the `args` field is overridden; all other built-in values (`bin`, `stdio`,
`envPassthrough`, etc.) remain unchanged.

To change the binary path (e.g. a local dev build):

```jsonc
{
  "agent": {
    "profiles": {
      "opencode": {
        "bin": "/home/me/src/opencode/dist/opencode"
      }
    }
  }
}
```

## Configuring commandBuilder

When you define a custom profile, akm looks up a command builder by profile
name. If no builder is registered for that name, it falls back to the `default`
builder — which passes `--system-prompt` and `--model` as bare flags and the
prompt as a bare positional argument.

If your custom profile **wraps opencode or claude**, set `commandBuilder` to
get the platform-correct flag shapes (including `--print` for claude, `run`
subcommand for opencode, and `--allowedTools` for tool policies):

```jsonc
{
  "agent": {
    "default": "my-opencode",
    "profiles": {
      "my-opencode": {
        "bin": "opencode",
        "args": ["run", "--config", "~/.config/opencode/team.json"],
        "stdio": "interactive",
        "commandBuilder": "opencode"
      }
    }
  }
}
```

Without `commandBuilder: "opencode"`, dispatching `akm agent my-opencode
agent:code-reviewer --prompt "review src/"` would produce a malformed argv
(the `run` subcommand already in `args` would conflict with naive flag
injection). With the builder set, akm generates the correct:

```
opencode run --config ~/.config/opencode/team.json --system-prompt "..." --model "..." "review src/"
```

Valid `commandBuilder` values: `"opencode"`, `"claude"`. Any other value (or
omitting the field) falls back to the `default` builder.

## Model aliases

### Built-in aliases

Three convenience aliases resolve to platform-appropriate model strings
automatically. Pass them to `--model` or reference them in an agent asset's
`modelHint` field:

| Alias | opencode model | claude model |
| --- | --- | --- |
| `opus` | `opencode/claude-opus-4-7` | `claude-opus-4-7` |
| `sonnet` | `opencode/claude-sonnet-4-6` | `claude-sonnet-4-6` |
| `haiku` | `opencode/claude-haiku-4-5` | `claude-haiku-4-5-20251001` |

Aliases are case-insensitive. An unrecognised alias is passed verbatim to the
CLI as an exact model ID.

### Custom aliases

Add per-profile aliases under `agent.profiles.<name>.modelAliases`. Keys are
lowercase alias strings; values are the exact model string the CLI expects:

```jsonc
{
  "agent": {
    "default": "opencode",
    "profiles": {
      "opencode": {
        "modelAliases": {
          "fast":   "opencode/claude-haiku-4-5",
          "big":    "opencode/claude-opus-4-7",
          "local":  "opencode/qwen3-30b-a3b"
        }
      },
      "claude": {
        "modelAliases": {
          "fast":   "claude-haiku-4-5-20251001",
          "big":    "claude-opus-4-7"
        }
      }
    }
  }
}
```

User-defined aliases override built-in aliases for the same key. Only the
matching profile's alias table is consulted — `opencode.modelAliases.fast`
does not affect the `claude` profile.

```sh
# Use custom alias:
akm agent opencode --model fast --prompt "quick lint check"

# Use a built-in alias:
akm agent claude --model opus --prompt "deep architecture review"

# Pass an exact model ID (no alias lookup):
akm agent opencode --model "opencode/deepseek-v3" --prompt "review src/"
```

## Using agent assets with akm agent

A stash agent asset (`type: agent`) bundles a system prompt, an optional
`modelHint`, and an optional `toolPolicy` into a single ref. Pass the ref as
the second positional argument to `akm agent` to apply the asset's metadata to
the dispatch:

```sh
# Launch opencode embodying the code-reviewer agent:
akm agent opencode agent:code-reviewer --prompt "review src/"

# Override the asset's modelHint with an alias:
akm agent claude agent:planner --model sonnet --prompt "plan the sprint"

# Interactive session: no --prompt → agent waits for user input in the terminal:
akm agent opencode agent:architect
```

**Model precedence** (highest → lowest):

1. `--model` CLI flag — always wins.
2. `modelHint` in the agent asset frontmatter.
3. No `--model` flag passed — platform uses its configured default.

The system prompt from the asset is always forwarded to the platform builder
and injected using the platform-correct flag (`--system-prompt` for both
opencode and claude builders).

To discover available agent assets:

```sh
akm search --type agent
akm curate "code review" --type agent
```

## Full config example

A complete `agent` block showing all new fields:

```jsonc
// ~/.config/akm/config.json
{
  "agent": {
    "default": "opencode",
    "timeoutMs": 3000000,
    "profiles": {
      "opencode": {
        "bin": "opencode",
        "args": ["run"],
        "stdio": "interactive",
        "parseOutput": "text",
        "modelAliases": {
          "fast":  "opencode/claude-haiku-4-5",
          "big":   "opencode/claude-opus-4-7",
          "local": "opencode/qwen3-30b-a3b"
        }
      },
      "claude": {
        "bin": "claude",
        "args": [],
        "stdio": "interactive",
        "parseOutput": "text",
        "modelAliases": {
          "fast": "claude-haiku-4-5-20251001",
          "big":  "claude-opus-4-7"
        }
      },
      "my-opencode": {
        "bin": "opencode",
        "args": ["run", "--config", "~/.config/opencode/team.json"],
        "stdio": "interactive",
        "commandBuilder": "opencode",
        "modelAliases": {
          "fast": "opencode/claude-haiku-4-5"
        }
      },
      "local": {
        "sdkMode": true,
        "model": "qwen2.5-coder:32b"
      }
    },
    "processes": {
      "reflect": "opencode-headless",
      "propose": {
        "profile": "claude",
        "timeoutMs": 300000
      }
    }
  }
}
```

## Headless vs interactive

Each of the five built-in profiles has a `-headless` variant (e.g.
`opencode-headless`, `claude-headless`) that sets `stdio: "captured"` and
`parseOutput: "json"`. These are intended for automation contexts — `akm
reflect`, `akm propose`, and `akm tasks run` (prompt targets) — where the
agent's output must be captured and parsed by akm rather than streamed to the
terminal.

Use the interactive variants (the default) for `akm agent` sessions where you
want the agent to paint its own UI. Use headless variants (or route automation
processes via `agent.processes`) for unattended workflows:

```jsonc
{
  "agent": {
    "default": "opencode",
    "processes": {
      "reflect": "opencode-headless",
      "propose": "claude-headless"
    }
  }
}
```

Headless profiles do not appear in `akm agent --list` enumeration but can be
referenced by name anywhere a profile name is accepted (e.g. `--profile
opencode-headless` or `agent.default: "opencode-headless"`).

## See also

- [Configuration reference](configuration.md) — full `agent.*` block schema and `agent.processes`
- [Agent Integration](features/agent-integration.md) — AGENTS.md setup and dispatch workflows
- [CLI Reference](cli.md) — `akm agent` flags and examples
