# akm CLI — Full Reference

You have access to a searchable library of scripts, skills, commands, agents, knowledge documents, workflows, wikis, and memories via `akm`. Search your sources first before writing something from scratch.

## Search

```sh
akm search "<query>"                          # Search all sources
akm curate "<task>"                          # Curate the best matches for a task
akm search "<query>" --type workflow          # Filter by asset type
akm search "<query>" --source both            # Also search registries
akm search "<query>" --source registry        # Search registries only
akm search "<query>" --limit 10               # Limit results
akm search "<query>" --detail full            # Include scores, paths, timing
```

| Flag | Values | Default |
| --- | --- | --- |
| `--type` | `skill`, `command`, `agent`, `knowledge`, `workflow`, `script`, `memory`, `env`, `secret`, `wiki`, `any` | `any` |
| `--source` | `stash`, `registry`, `both` | `stash` |
| `--limit` | number | `20` |
| `--format` | `json`, `jsonl`, `text`, `yaml` | `json` |
| `--detail` | `brief`, `normal`, `full` | `brief` |
| `--shape` | `human`, `agent`, `summary` (`summary` only on `show`) | `human` |
| `--for-agent` | boolean (deprecated — use `--shape agent`) | `false` |

## Curate

Combine search + follow-up hints into a dense summary for a task or prompt.

```sh
akm curate "plan a release"                   # Pick top matches across asset types
akm curate "deploy a Bun app" --limit 3       # Keep the summary shorter
akm curate "review architecture" --type workflow # Restrict to one asset type
```

## Show

Display an asset by ref. Knowledge assets support view modes as positional arguments.

```sh
akm show script:deploy.sh                     # Show script (returns run command)
akm show skill:code-review                    # Show skill (returns full content)
akm show command:release                      # Show command (returns template)
akm show agent:architect                      # Show agent (returns system prompt)
akm show workflow:ship-release                # Show parsed workflow steps
akm show knowledge:guide toc                  # Table of contents
akm show knowledge:guide section "Auth"       # Specific section
akm show knowledge:guide lines 10 30          # Line range
akm show knowledge:my-doc                    # Show content (local or remote)
```

| Type | Key fields returned |
| --- | --- |
| script | `run`, `setup`, `cwd` |
| skill | `content` (full SKILL.md) |
| command | `template`, `description`, `parameters` |
| agent | `prompt`, `description`, `modelHint`, `toolPolicy` |
| knowledge | `content` (with view modes: `full`, `toc`, `frontmatter`, `section`, `lines`) |
| workflow | `workflowTitle`, `workflowParameters`, `steps` |
| memory | `content` (recalled context) |
| vault | `keys`, `comments` |
| wiki | `content` (same view modes as knowledge). For any wiki task, run `akm wiki list`. To ingest sources, `akm wiki ingest <name>` dispatches the configured agent (defaults.agent or `--profile`) to execute the ingest workflow. |

## Capture Knowledge While You Work

```sh
akm remember "Deployment needs VPN access"     # Record a memory in your stash
akm remember --name release-retro < notes.md   # Save multiline memory from stdin
akm remember "note" --target my-other-stash    # Route write to a named writable stash source
akm import ./docs/auth-flow.md                 # Import a file as knowledge
akm import - --name scratch-notes < notes.md   # Import stdin as a knowledge doc
akm import https://example.com/docs/auth       # Fetch one URL and import it as knowledge
akm import ./doc.md --target my-other-stash    # Route import to a named writable stash source
akm workflow create ship-release               # Create a workflow asset in the stash
akm workflow validate workflows/foo.md         # Validate a workflow file or ref; lists every error
akm workflow next workflow:ship-release        # Start or resume the next workflow step
akm feedback skill:code-review --positive      # Record that an asset helped
akm feedback agent:reviewer --negative         # Record that an asset missed the mark
akm feedback memory:deployment-notes --positive # Works for memories too
akm feedback vault:prod --positive             # Records vault feedback without surfacing values
```

Use `akm feedback` whenever an asset materially helps or fails so future search
ranking can learn from actual usage.

## Wikis

Multi-wiki knowledge bases (Karpathy-style). A stash-owned wiki lives at
`<stashDir>/wikis/<name>/`; external directories or repos can also be registered
as first-class wikis. akm owns lifecycle + raw-slug + lint + index regeneration
for stash-owned wikis; page edits use your native Read/Write/Edit tools.

```sh
akm wiki list                                  # List wikis (name, pages, raws, last-modified)
akm wiki create research                       # Scaffold a new wiki
akm wiki register ics-docs ~/code/ics-documentation # Register an external wiki
akm wiki show research                         # Path, description, counts, last 3 log entries
akm wiki pages research                        # Page refs + descriptions (excludes schema/index/log; includes raw/)
akm wiki search research "attention"           # Scoped search (equivalent to --type wiki --wiki research)
akm wiki stash research ./paper.md             # Copy source into raw/<slug>.md (never overwrites)
akm wiki stash research https://example.com/paper # Fetch one URL into raw/<slug>.md
akm wiki stash research ./paper.md --target my-stash # Route write to a named writable stash source
echo "..." | akm wiki stash research -         # stdin form
akm wiki lint research                         # Structural checks: orphans, broken xrefs, uncited raws, stale index
akm wiki ingest research                       # Dispatch defaults.agent to run the ingest workflow on this wiki
akm wiki ingest research --profile claude --model sonnet  # Override profile and model
akm wiki ingest research --timeout-ms 600000   # Override agent CLI timeout (default: profile setting)
akm wiki remove research -y                    # Delete pages/schema/index/log; preserves raw/ (--force is a deprecated alias for -y)
akm wiki remove research -y --with-sources     # Full nuke, including raw/
```

**For any wiki task, start with `akm wiki list`. Then `akm wiki ingest <name>`
dispatches the configured agent (defaults.agent or `--profile`) to execute
the wiki's ingest workflow end-to-end — schema read, source dedup, search,
page create/update, log entry, lint, reindex.** Wiki pages are also addressable as
`wiki:<name>/<page-path>` and show up in stash-wide `akm search` as
`type: wiki`. Files under `raw/` and the wiki root infrastructure files
`schema.md`, `index.md`, and `log.md` are not indexed and do not appear in
search results. No `--llm` anywhere — akm never reasons about page content.

## Vaults

Encrypted-at-rest key/value stores for secrets. Each vault is a `.env`-format
file at `<stashDir>/vaults/<name>.env`.

```sh
akm vault create prod                         # Create a new vault
akm vault set prod DB_URL postgres://...      # Set a key (or KEY=VALUE combined form)
akm vault set prod DB_URL=postgres://...      # Combined KEY=VALUE form also works
akm vault unset prod DB_URL                   # Remove a key
akm vault list                                # List all vaults across all stashes with key names
akm vault path vault:prod                     # Print the vault file path for shell loading
akm vault run vault:prod -- env               # Run one command with all vault vars injected
akm vault run vault:prod/DB_URL -- printenv DB_URL # Inject one key for one command
```

## Workflows

Step-based workflows stored as `<stashDir>/workflows/<name>.md`.

Ref-based workflow commands are scoped to the current project/worktree/directory,
so one active run does not block unrelated directories from starting the same
workflow. Direct run-id commands still target the exact run.

```sh
akm workflow template                         # Print a starter workflow template
akm workflow create ship-release             # Scaffold a new workflow asset
akm workflow start workflow:ship-release     # Start a new run in the current scope
akm workflow next workflow:ship-release      # Advance to the next step (or auto-start) in the current scope
akm workflow complete <run-id>               # Mark a step complete and advance
akm workflow status <run-id>                 # Show the exact run by id
akm workflow resume <run-id>                 # Resume a blocked or failed run
akm workflow list                            # List workflow runs in the current scope
```

## Clone

Copy an asset to the working stash or a custom destination for editing.

```sh
akm clone <ref>                               # Clone to working stash
akm clone <ref> --name new-name               # Rename on clone
akm clone <ref> --dest ./project/.claude       # Clone to custom location
akm clone <ref> --force                       # Overwrite existing
akm clone "npm:@scope/pkg//script:deploy.sh"  # Clone from remote package
```

When `--dest` is provided, `akm init` is not required first.

## Sync

Commit local changes in a git-backed stash. Behaviour adapts automatically.
(`akm save` is the deprecated 0.7 spelling — it still works but warns; removed
in 0.9.0.)

- **No `.git` directory** — no-op (silent skip)
- **Git repo, no remote** — stage and commit only (the default stash always falls here)
- **Git repo, has remote, not writable** — stage and commit only
- **Git repo, has remote, `writable: true`** — stage, commit, and push
- **Any writable repo with `--no-push`** — stage and commit only

```sh
akm sync                                      # Sync primary stash (timestamp message)
akm sync -m "Add deploy skill"               # Sync with explicit message
akm sync --no-push                            # Commit only; never push
akm sync my-skills                            # Sync a named writable git stash
akm sync my-skills -m "Update patterns"      # Sync named stash with message
```

`akm improve` also performs an end-of-run batch commit for git-backed stashes.
The `--sync` / `--no-sync` and `--push` / `--no-push` flags control this:

```sh
akm improve                                   # auto-sync per profile default (default/thorough: on; quick/memory-focus: off)
akm improve --no-sync                         # skip the end-of-run commit
akm improve --no-push                         # commit but skip push for this run
akm improve --sync                            # force sync even on profiles that disable it
```

Profile sync defaults: `default` and `thorough` auto-commit + push; `quick` and
`memory-focus` skip sync entirely. Override with `--sync` / `--no-sync` flags.

The `--writable` flag on `akm add` opts a remote git stash into push-on-sync:

```sh
akm add git@github.com:org/skills.git --provider git --name my-skills --writable
```

## Add & Manage Sources

```sh
akm add <ref>                                 # Add a source
akm add @scope/stash                            # From npm (managed)
akm add owner/repo                            # From GitHub (managed)
akm add ./path/to/local/stash                   # Local directory
akm add git@github.com:org/repo.git --provider git --name my-skills --writable
akm config enable skills.sh                   # Enable the skills.sh registry
akm config disable skills.sh                  # Disable the skills.sh registry
akm list                                      # List all sources
akm list --kind managed                       # List managed sources only
akm remove <target>                           # Remove by id, ref, path, or name
akm update --all                              # Update all managed sources
akm update <target> --force                   # Force re-download
```

## Registries

```sh
akm registry list                             # List configured registries
akm registry add <url>                        # Add a registry
akm registry add <url> --name my-team         # Add with label
akm registry add <url> --provider skills-sh   # Specify provider type
akm registry remove <url-or-name>             # Remove a registry
akm registry search "<query>"                 # Search all registries
akm registry search "<query>" --assets        # Include asset-level results
akm registry build-index                      # Build the default cache-backed index.json
akm registry build-index --out dist/index.json # Build to a custom path
```

## Configuration

```sh
akm config list                               # Show current config
akm config get <key>                          # Read a value
akm config set <key> <value>                  # Set a value
akm config unset <key>                        # Remove a key
akm config path --all                         # Show all config paths
```

## Other Commands

```sh
akm init                                      # Initialize working stash
akm index                                     # Rebuild search index (metadata enrichment when configured)
akm index --full                              # Full reindex (metadata enrichment when configured)
akm list                                      # List all sources
akm upgrade                                   # Upgrade akm using its install method
akm upgrade --check                           # Check for updates
akm help migrate 0.6.0                        # Print migration notes for a release (or: latest)
akm hints                                     # Print this reference
akm completions                               # Print bash completion script
akm completions --install                     # Install completions
```

## Proposals & Improvement (0.8.0+)

```sh
akm improve <ref>                                       # Propose improvement for an asset
akm proposal list                                       # List pending proposals
akm proposal show <id>                                  # Render the proposal body
akm proposal diff <ref-or-id>                           # Diff by ref, UUID, or 8-char prefix
akm proposal diff skill:akm-dream                       # Diff by asset ref
akm proposal accept 7c115132                            # Accept by UUID prefix
akm proposal accept <id> --target team-stash            # Accept to a named writable stash source
akm proposal reject skill:my-skill --reason "not ready" # Reject by asset ref
akm proposal reject <id> --reason "..."                 # Archive with a reason
akm proposal revert <id>                                # Restore the pre-promotion content
```

The flat verbs `akm proposals` / `akm show proposal` / `akm accept` /
`akm reject` / `akm diff` / `akm revert` still work as deprecated aliases
(warn on stderr; removed in 0.9.0).

Per-task `timeoutMs`: task markdown frontmatter may set `timeoutMs: null` to
disable the agent kill timer for long-running local-model tasks, or a number
(milliseconds) to override `config.agent.timeoutMs` for that task only.

## Output Control

All commands accept `--format`, `--detail`, and `--shape` flags:

- `--format json` (default) — structured JSON
- `--format jsonl` — one JSON object per line (streaming-friendly)
- `--format text` — human-readable plain text
- `--format yaml` — YAML output
- `--detail brief` (default) — compact output
- `--detail normal` — adds tags, refs, origins
- `--detail full` — includes scores, paths, timing, debug info
- `--shape human` (default) — standard projection
- `--shape agent` — agent-optimized output: strips non-actionable fields
- `--shape summary` — metadata only (no content/template/prompt), under 200 tokens; only valid on `akm show`
- `--for-agent` — deprecated alias for `--shape agent` (removed 0.9.0)

Run `akm -h` or `akm <command> -h` for per-command help.
