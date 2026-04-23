---
name: akm
description: Search, install, and manage AI agent skills, commands, tools, knowledge, workflows, wikis, vaults, and memories from any source. Works with Claude Code, OpenCode, Cursor, and any AI coding assistant.
---

# akm — Agent Kit Manager

A package manager for AI agent capabilities. Use `akm` to search, install, and
manage skills, commands, agents, knowledge, workflows, wikis, vaults, scripts,
and memories from local stashes, registries, and community sources.

## When to use this skill

Use `akm` when you need to:

- **Find a capability** you don't already have (a deployment script, a code review skill, a debugging agent)
- **Curate assets for a task** — let akm surface the best-matching assets before you start work
- **Install a kit** of assets from npm, GitHub, or a private registry
- **Search across sources** — local stash, official registry, and community skills in one query
- **Manage installed kits** — list, update, or remove
- **Capture knowledge** — record memories, import docs, or stash wiki sources while you work

## Search & Curate

```sh
# Search your stash
akm search "deploy"
akm search "code review" --type skill
akm search "auth" --source both          # include registry results

# Let akm pick the best matches for a task
akm curate "write a release workflow"
```

Asset types: `skill`, `command`, `agent`, `knowledge`, `workflow`, `script`, `memory`, `vault`, `wiki`

## Show

```sh
akm show skill:code-review               # Full skill content
akm show command:release                 # Command template
akm show agent:architect                 # Agent system prompt
akm show script:deploy.sh               # Script + run command
akm show workflow:ship-release           # Workflow steps
akm show knowledge:guide toc            # Table of contents
akm show knowledge:guide section "Auth" # Specific section
akm show knowledge:guide lines 10 30    # Line range
akm show vault:prod                     # Vault keys + comments (values never returned)
akm show wiki:research/page             # Wiki page content
```

## Capture Knowledge While You Work

```sh
akm remember "Deployment needs VPN access"       # Record a memory
akm remember --name release-retro < notes.md     # Save multiline memory from stdin
akm import ./docs/auth-flow.md                   # Import a file as knowledge
akm import - --name scratch-notes < notes.md     # Import stdin as knowledge
akm feedback skill:code-review --positive        # Record that an asset helped
akm feedback agent:reviewer --negative           # Record that an asset missed
```

Always record `akm feedback` when an asset materially helps or fails — it improves future search ranking.

## Workflows

```sh
akm workflow create ship-release         # Create a workflow asset in the stash
akm workflow next workflow:ship-release  # Resume the active run or start a new one
```

## Wikis

Multi-wiki knowledge bases. akm manages lifecycle, raw sources, linting, and index
regeneration. Page edits use native Read/Write/Edit tools.

```sh
akm wiki list                            # List wikis
akm wiki create research                 # Scaffold a new wiki
akm wiki show research                   # Summary + recent log entries
akm wiki pages research                  # Page refs + descriptions
akm wiki search research "attention"     # Scoped search
akm wiki stash research ./paper.md       # Copy source into raw/ (never overwrites)
akm wiki lint research                   # Check for orphans, broken xrefs, stale index
akm wiki ingest research                 # Print the ingest workflow (no action taken)
```

**For any wiki task: `akm wiki list`, then `akm wiki ingest <name>` to get the step-by-step workflow.**

## Add & Manage Sources

```sh
akm add @scope/kit                       # From npm (managed)
akm add owner/repo                       # From GitHub (managed)
akm add ./path/to/local/kit              # Local directory
akm add <url> --provider git --writable  # Writable git-backed stash
akm list                                 # List all sources
akm remove <target>                      # Remove by id, ref, path, or name
akm update --all                         # Update all managed sources
akm clone skill:code-review --dest ./.claude/skills  # Clone asset for editing
```

## Save (git-backed stashes)

```sh
akm save                                 # Commit primary stash
akm save -m "Add deploy skill"          # Commit with message (pushes if writable + remote)
akm save my-skills                       # Save a named writable stash
```

## Registries

```sh
akm registry list
akm registry add <url> --name my-team
akm registry search "deploy" --assets
akm registry remove <url-or-name>
```

## Output flags

All commands accept `--format` (`json` | `jsonl` | `text` | `yaml`) and
`--detail` (`brief` | `normal` | `full` | `summary`). Default: `--format json --detail brief`.

Use `--detail summary` for metadata-only output (under 200 tokens, no content body).

## Integration

Add this to your `AGENTS.md`, `CLAUDE.md`, or system prompt so any AI agent can use `akm`:

```markdown
## Resources & Capabilities

You have access to a searchable library of scripts, skills, commands, agents,
knowledge, workflows, wikis, and memories via the `akm` CLI.
Search your sources first before writing something from scratch.
Use `akm hints --detail full` for a complete reference.
```

No plugins, SDKs, or integration code required.

## Install

```sh
bun install -g akm-cli
```

## Links

- [GitHub](https://github.com/itlackey/akm) — releases, source, and docs
- [npm](https://www.npmjs.com/package/akm-cli)
- [Documentation](https://github.com/itlackey/akm/blob/main/docs/getting-started.md)
