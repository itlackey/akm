# Use AKM With Any Agent

AKM works from any shell-capable coding agent — Claude Code, OpenCode, Cursor,
Windsurf, Aider, and others. No plugins or SDKs are required for the core
workflow: a three-line system prompt block plus shell access is all an agent
needs to start using your bundle.

## AGENTS.md / CLAUDE.md snippet

Add this block to your `AGENTS.md`, `CLAUDE.md`, or system prompt. It tells
the agent that `akm` is available and how to discover it.

```markdown
## Resources & Capabilities

You have access to a searchable library of scripts, skills, commands, agents,
knowledge, workflows, env files, secrets, lessons, memories, tasks, sessions,
and facts via the `akm` CLI. Use `akm -h` for details.
```

That is the minimum. The agent can then run `akm curate <task>` at the start
of any complex task to pull the most relevant assets into context, and
`akm show <ref>` to load any asset by ref.

For a longer, agent-facing instruction block — usage patterns, flag guidance,
the full ref format — generate one instead of hand-writing it:

```sh
akm help agents >> AGENTS.md
```

The output is stable across patch releases and designed for agents rather
than humans: it describes the lookup workflow (`curate` → `show` →
`feedback`) and explains how refs work. It prints a short guide by default;
pass `--full` for the complete one.

## The retrieval loop: curate, show, feedback

Once an agent knows `akm` is available, the working pattern is always the
same three calls:

```sh
# 1. Curate assets for the current task
akm curate "deploy to production" --limit 3

# 2. Load the best match by ref from the curate output
akm show workflows/deploy-to-prod

# 3. Record outcome
akm feedback workflows/deploy-to-prod --positive --reason "Completed without issues"
```

**Get refs from search.** Agents should call `akm search --shape agent` or
`akm curate` to discover refs — not guess them. The `ref` field in search
results is the stable token to pass to `akm show`. Feedback closes the loop.
Record `--negative` only when the asset's content is wrong or stale; a note that
simply did not fit the task is not negative feedback, so record nothing for it.
`akm feedback <ref> --negative --reason "<what is wrong and what should change>"`
flags the asset, and the next improve run may repair its description, title or
`when_to_use` from your reason. Once you have verified the correct fact, attach
the exact fix with `--replace`, `--with` and `--source`. `--positive` records
that an asset helped (it raises its ranking) and does not trigger a rewrite. See
[Improve the Library](improve-the-library.md) for what happens to feedback after
it's recorded.

## Compatibility matrix

Not every agent surface integrates with AKM the same way. The table below
sets expectations by environment.

| Environment | Core support | Optional/extended support |
| --- | --- | --- |
| Shell-capable coding agent | `curate` / `show` / `feedback` via the CLI | Generated prompt block (`akm help agents`) or a platform plugin |
| Claude/OpenCode project layout | Indexed in place through a `BundleAdapter` — no migration needed | `akm clone` selected assets into a writable bundle for editing |
| IDE assistant without shell access | Not a direct core integration | Requires a plugin, an `akm task`, or an external bridge that can shell out on the assistant's behalf |

A Claude Code `.claude` directory or an OpenCode `.opencode` directory is
recognized and indexed automatically once added as a source — see
[Bundle Types](../reference/bundle-types.md) for the full adapter list and
which formats are read-only versus writable in the current release.
The native directory remains the source of truth: AKM translates recognized
assets while reading the bundle and does not synchronize, copy, or write them
back. The approved target execution rules for these translated agents and
commands are documented in
[Agent, Command, Engine, and Model Resolution](../architecture/specs/agent-command-engine-model-design.md).

## AKM complements, rather than replaces

AKM is not a competitor to assistant-native rules/skills or to MCP — it fills
a different layer. Assistant-native rules and skills give a specific tool
built-in, tool-specific activation. MCP exposes live tools and resources over
a protocol. AKM manages portable, versionable capability assets — and the
retrieval loop that finds and loads them — across whichever tool you're
sitting in. In short, AKM complements MCP and assistant-native skills rather
than replacing either.

## Also available

- **Tab completion.** `akm completions --install` sets up shell completions
  for subcommands and flags. See [CLI Reference](../reference/cli.md#completions).
- **Dispatching a bundle agent asset.** `akm agent agents/<name> --engine
  <engine> --prompt "..."` runs a bundle `agents/<name>` persona and model
  defaults through a named engine — including built-in model aliases like
  `sonnet` and `opus` that resolve per platform. The current CLI rejects a
  nonempty tool request at its separate authorization boundary; asset metadata
  is never authorization by itself. See
  [Configuration](../reference/configuration.md#engines) for the alias table
  and [Architecture](../architecture/architecture.md) for how dispatch is
  built into platform-specific CLI argv per backend.
- **Install refs vs. asset refs.** `npm:@scope/pkg` and `github:owner/repo`
  are install refs, accepted only by `akm bundle add`/`akm clone`, and are a
  different grammar from the `[bundle//]conceptId` refs `show`/`search` use.
  See [Refs](../reference/refs.md) for the full grammar.
- **Plugin integrations.** For tighter editor and agent integrations,
  platform-specific plugins are available in
  [akm-plugins](https://github.com/itlackey/akm-plugins) (current
  integrations include OpenCode). Plugins add richer UX — in-editor asset
  browsing, automatic context injection — but the core `akm` CLI works
  without them.

## See also

- [Configuration](../reference/configuration.md#engines) — named agent engines and model aliases
- [Discover and Load](discover-and-load.md) — the full curate → show retrieval path
- [Knowledge Management](knowledge-management.md) — capturing agent-generated memories
- [Improve the Library](improve-the-library.md) — feeding back usage signals
- [CLI Reference](../reference/cli.md) — `completions`, `agent`, and `help agents` command documentation
- [Concepts](concepts.md) — refs, origins, and the asset type system
- [Bundle Types](../reference/bundle-types.md) — how AKM indexes existing project layouts in place
