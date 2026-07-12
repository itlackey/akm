# Agent Integration

akm works with any AI coding assistant that can run shell commands — Claude
Code, OpenCode, Cursor, Windsurf, Aider, and others. No plugins or SDKs are
required for the core workflow: a three-line system prompt block plus shell
access is all an agent needs to start using your stash.

## AGENTS.md / CLAUDE.md snippet

Add this block to your `AGENTS.md`, `CLAUDE.md`, or system prompt. It tells
the agent that `akm` is available and how to discover it.

```markdown
## Resources & Capabilities

You have access to a searchable library of scripts, skills, commands, agents,
knowledge, workflows, env files, secrets, wikis, lessons, and memories via the `akm` CLI.
Use `akm -h` for details.
```

That is the minimum. The agent can then run `akm curate <task>` at the start
of any complex task to pull the most relevant assets into context, and
`akm show <ref>` to load any asset by ref.

**Example: configure Claude Code to use your stash**

Add the three-line block above to `~/.claude/CLAUDE.md` (global) or
`./CLAUDE.md` (project-level). The agent will call `akm curate` and
`akm show` automatically as it discovers it needs them.

## akm hints

`akm hints` prints a longer agent-facing instruction block — including usage
patterns, flag guidance, and the full ref format — suitable for pasting
directly into an `AGENTS.md` file or system prompt when you want the agent to
be more autonomous about discovery.

```sh
akm hints
# Prints a ready-to-paste AGENTS.md section with usage guidance

# Typical use: capture into your project's AGENTS.md
akm hints >> ./AGENTS.md
```

The output is stable across patch releases and designed for agents rather than
humans: it describes the lookup workflow (`curate` → `show` → `feedback`) and
explains how refs work.

**Example: set up agent guidance for a new project**

```sh
# Initialize a project AGENTS.md with akm usage guidance
echo "# Agent Guidelines" > AGENTS.md
akm hints >> AGENTS.md
```

## akm completions

`akm completions` generates a bash completion script so tab-completion works
in your shell. Run it once to enable per-keystroke discovery of subcommands and
flags.

```sh
# Print the completion script (manual activation):
source <(akm completions)

# Or install to the XDG completions directory:
akm completions --install
```

After installation, completions are active in new shells automatically. The
script is generated dynamically from the command tree, so it always reflects
the current set of subcommands and flags.

**Example: set up tab completion**

```sh
akm completions --install
# Then open a new terminal — tab-complete akm <tab> to see all subcommands
```

## Plugin integrations

For tighter editor and agent integrations, platform-specific plugins are
available in [akm-plugins](https://github.com/itlackey/akm-plugins). Current
integrations include OpenCode. Plugins provide richer UX — in-editor asset
browsing, automatic context injection — but the core `akm` CLI works without
them.

```sh
# OpenCode integration (example):
# Install via akm-plugins — see the repo for per-platform instructions
```

## Using refs in prompts

Assets are identified by `type:name` refs. An agent that knows a ref can load
it immediately without searching.

```sh
# Common ref formats:
akm show skill:code-review
akm show workflow:ship-release
akm show script:deploy.sh
akm show knowledge:api-guide
akm show env:prod           # shows key names only; values never appear in output
akm show wiki:ops/runbook

# From a specific source (origin-qualified ref):
akm show "npm:@scope/pkg//script:deploy.sh"
akm show "github:owner/repo//workflow:release"
```

**Get refs from search.** Agents should call `akm search --shape agent` or
`akm curate` to discover refs — not guess them. The `ref` field in search
results is the stable token to pass to `akm show`.

**Example: full agent retrieval loop**

```sh
# 1. Curate assets for the current task
akm curate "deploy to production" --limit 3

# 2. Load the best match by ref from the curate output
akm show workflow:deploy-to-prod

# 3. Record outcome
akm feedback workflow:deploy-to-prod --positive --reason "Completed without issues"
```

## akm agent — dispatching with a stash agent asset

`akm agent` can embody a stash agent asset (type `agent:`) to apply that
agent's system prompt, model, and tool policy to any task. Select the named
agent engine with `--engine` and pass the asset ref positionally.

```sh
# Embody an agent asset and run a task:
akm agent agent:code-reviewer --engine opencode --prompt "review src/"

# Model override with a built-in alias (overrides the asset's modelHint):
akm agent agent:planner --engine claude --model sonnet --prompt "plan the sprint"

# Exact platform model ID override:
akm agent agent:code-reviewer --engine opencode --model opencode/claude-opus-4-7 --prompt "audit the API"

# Interactive launch with an agent asset (no prompt — interactive session):
akm agent agent:architect --engine opencode
```

**Built-in model aliases** — `fable`, `opus`, `sonnet`, and `haiku` are
resolved per platform automatically:

| Alias | opencode | claude |
| --- | --- | --- |
| `fable` | `opencode/claude-fable-5` | `claude-fable-5` |
| `opus` | `opencode/claude-opus-4-7` | `claude-opus-4-7` |
| `sonnet` | `opencode/claude-sonnet-4-6` | `claude-sonnet-4-6` |
| `haiku` | `opencode/claude-haiku-4-5` | `claude-haiku-4-5-20251001` |

Per-engine `modelAliases` in config can extend or override this table.

**Platform dispatch** — when a system prompt, model, or tool policy is
present, akm builds the CLI argv using the platform builder for the
engine. `opencode` engines use `opencode run [--system-prompt "..."]
[--model <id>] "<prompt>"`. `claude` engines use `claude
[--system-prompt "..."] [--model <id>] [--allowedTools ...] --print
"<prompt>"`. Engine platform selection chooses the registered command builder.

## See also

- [Configuration](../configuration.md#engines) — named agent engines and model aliases
- [Search & Discovery](search-discovery.md) — the full curate → show retrieval path
- [Knowledge Management](knowledge-management.md) — capturing agent-generated memories
- [Improvement Loop](improvement-loop.md) — feeding back usage signals
- [CLI Reference](../cli.md) — `hints`, `completions`, `agent` command documentation
- [Concepts](../concepts.md) — refs, origins, and the asset type system
