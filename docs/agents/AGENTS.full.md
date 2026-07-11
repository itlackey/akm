# akm CLI — Full Reference

You have access to a searchable library of scripts, skills, commands, agents, knowledge documents, workflows, env files, secrets, wikis, lessons, and memories via `akm`. Search your sources first before writing something from scratch.

## Search

```sh
akm search "<query>"                          # Search your sources
akm search "<query>" --type workflow          # Filter by asset type
akm search "<query>" --source both            # Also search registries for installable stashes
akm search "<query>" --source registry        # Search registries only
akm search "<query>" --limit 10               # Limit results
akm search "<query>" --detail full            # Include scores, paths, timing
akm curate "<task>"                          # Curate the best matches for a task
```

| Flag | Values | Default |
| --- | --- | --- |
| `--type` | `skill`, `command`, `agent`, `knowledge`, `workflow`, `script`, `memory`, `env`, `secret`, `wiki`, `lesson`, `any` | `any` |
| `--source` | `stash`, `registry`, `both` | `stash` |
| `--limit` | number | `20` |
| `--format` | `json`, `jsonl`, `text`, `yaml` | `json` |
| `--detail` | `brief`, `normal`, `full` | `brief` |
| `--shape` | `human`, `agent`, `summary` (`summary` only on `show`) | `human` |

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
akm show knowledge:my-doc                    # Show a knowledge asset
akm show wiki:research                        # Wiki summary (same as akm wiki show research)
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
| env | `keys` (values and comment text are never returned) |
| secret | metadata only (the single value is never returned) |
| wiki | `content` (same view modes as knowledge). For any wiki task, run `akm wiki list`. `akm wiki ingest <name>` dispatches the configured agent engine (defaults.engine or `--engine`) to execute the ingest workflow. |
| lesson | `content` plus `when_to_use` from frontmatter — read both before applying the lesson |

`akm show wiki:<name>` returns the same summary as `akm wiki show <name>`: path,
description from `schema.md`, page and raw counts, and the last 3 `log.md`
entries.

## Capture Knowledge While You Work

```sh
akm remember "Deployment needs VPN access"     # Record a memory in your stash
akm remember --name release-retro < notes.md   # Save multiline memory from stdin
akm remember "note" --target my-stash          # Route write to a named writable stash source
akm import ./docs/auth-flow.md                 # Import a file as knowledge
akm import - --name scratch-notes < notes.md   # Import stdin as a knowledge doc
akm import https://example.com/docs/auth       # Fetch one URL into knowledge/
akm import ./doc.md --target my-stash          # Route import to a named writable stash source
akm workflow create ship-release               # Create a workflow asset in the stash
akm workflow validate workflow:ship-release    # Validate a workflow file or ref; lists every error
akm workflow next workflow:ship-release        # Resume the active run or start a new one
akm feedback skill:code-review --positive      # Record that an asset helped
akm feedback agent:reviewer --negative         # Record that an asset missed the mark
```

Use `akm feedback` whenever an asset materially helps or fails so future search
ranking can learn from actual usage.

## Proposals & improvement (0.8.0+)

Reflective edits, new asset drafts, and feedback-distilled lessons land
in a durable proposal queue first — `akm proposal accept` is the only
path that mutates the live stash.

```sh
akm improve <ref>                              # Produce an improvement proposal for an existing asset
akm improve <ref> --task "tighten the description"
akm propose <type> <name> --task "..."         # Draft a new asset proposal from a description
akm propose lesson docker-cleanup --task "consolidate cleanup feedback"
akm proposal list                              # List pending proposals
akm proposal list --status pending|accepted|rejected
akm proposal show <id>                          # Render the proposal body and metadata
akm proposal diff <ref-or-id>                   # Diff by ref, UUID, or 8-char prefix (proposal positional optional)
akm proposal diff skill:akm-dream               # diff accepts full asset ref
akm proposal accept 7c115132                    # Accept by UUID prefix
akm proposal accept <id>                        # Validate and promote via writeAssetToSource
akm proposal reject skill:my-skill --reason "not ready" # Reject by asset ref
akm proposal reject <id> --reason "..."         # Archive with a reason; body is preserved
akm search "<query>" --include-proposed        # Surface proposal-queue entries in search
akm history                                    # Per-asset (or stash-wide) state-change trail
akm history --ref <ref>
```

`akm improve` replaces the old direct reflect workflow for existing assets.
New asset drafts use `akm propose`, and lesson distillation still lands in the
same proposal queue.
The six proposal subcommands are now accessed via the `proposal` noun group:
- `akm proposal list` (was `akm proposals`)
- `akm proposal show` (was `akm show proposal`)
- `akm proposal diff` (was `akm diff`)
- `akm proposal accept` (was `akm accept`)
- `akm proposal reject` (was `akm reject`)
- `akm proposal revert` (was `akm revert`)

The flat verbs were removed in 0.9.0; use the `akm proposal <verb>` forms.

## Wikis

Multi-wiki knowledge bases (Karpathy-style). Each wiki is a directory at
`<stashDir>/wikis/<name>/` with `schema.md`, `index.md`, `log.md`, `raw/`,
and agent-authored pages. akm owns lifecycle + raw-slug + lint + index
regeneration; page edits use your native Read/Write/Edit tools.

```sh
akm wiki list                                  # List wikis (name, pages, raws, last-modified)
akm wiki create research                       # Scaffold a new wiki
akm wiki show research                         # Path, description, counts, last 3 log entries
akm wiki pages research                        # Page refs + descriptions (excludes schema/index/log/raw)
akm wiki search research "attention"           # Scoped search (equivalent to --type wiki --wiki research)
akm wiki stash research ./paper.md             # Copy source into raw/<slug>.md (never overwrites)
akm wiki stash research https://example.com/paper # Fetch one URL into raw/<slug>.md
akm wiki stash research ./paper.md --target my-stash # Route write to a named writable stash source
echo "..." | akm wiki stash research -         # stdin form
akm wiki lint research                         # Structural checks: orphans, broken xrefs, uncited raws, stale index, broken sources
akm wiki ingest research                       # Dispatch defaults.agent to run the ingest workflow on this wiki
akm wiki ingest research --engine claude --model sonnet  # Override agent engine and model
akm wiki ingest research --timeout-ms 600000   # Override agent CLI timeout
akm wiki remove research -y                    # Delete pages/schema/index/log; preserves raw/
akm wiki remove research -y --with-sources     # Full nuke, including raw/
```

**For any wiki task, start with `akm wiki list`. Then `akm wiki ingest <name>`
dispatches the configured agent engine (defaults.engine or `--engine`) to execute
the wiki's ingest workflow end-to-end — schema read, source dedup, search,
page create/update, log entry, lint, reindex.** Wiki pages are also addressable as
`wiki:<name>/<page-path>` and show up in stash-wide `akm search` as
`type: wiki`. Files under `raw/` and the wiki root infrastructure files
`schema.md`, `index.md`, and `log.md` are not indexed and do not appear in
search results. No `--llm` anywhere — akm never reasons about page content.

`akm wiki lint` exits 1 when findings exist and 0 when the wiki is clean.
The `broken-source` finding kind flags pages whose `sources:` frontmatter
entries point to raw files that no longer exist.

See [wikis.md](wikis.md) for the full guide.

## Add & Manage Sources

```sh
akm add <ref>                                 # Add a source
akm add @scope/stash                            # From npm (managed)
akm add owner/repo                            # From GitHub (managed)
akm add ./path/to/local/stash                   # Local directory
akm list                                      # List all sources
akm list --kind managed                       # List managed sources only
akm remove <target>                           # Remove by id, ref, path, or name
akm update --all                              # Update all managed sources
akm update <target> --force                   # Force re-download
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

When `--dest` is provided, `akm setup` is not required first.

## Sync

Commit local changes in a git-backed stash. Behaviour adapts automatically.
(`akm save`, the pre-0.8 spelling, was removed in 0.9.0 — use `akm sync`.)

- **Not a git repo** — no-op (silent skip)
- **Git repo, no remote** — stage and commit only (the default stash always falls here)
- **Git repo, has remote, not writable** — stage and commit only
- **Git repo, has remote, `writable: true`** — stage, commit, and push

```sh
akm sync                                      # Sync primary stash (timestamp message)
akm sync -m "Add deploy skill"               # Sync with explicit message
akm sync --no-push                            # Commit only; never push
akm sync my-skills                            # Sync a named writable git stash
akm sync my-skills -m "Update patterns"      # Sync named stash with message
```

The `--writable` flag on `akm add` opts a remote git stash into push-on-save:

```sh
akm add git@github.com:org/skills.git --provider git --name my-skills --writable
```

To make the primary stash push on save, set `writable: true` in your config
(`~/.config/akm/config.json`):

```json
{
  "stashDir": "~/akm",
  "writable": true
}
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
akm setup                                     # Interactive setup (creates stash + configures connections)
akm setup --dir ~/custom-stash                # Initialize at a custom path
akm setup --yes                               # Non-interactive, accepts all defaults
akm index                                     # Rebuild search index
akm index --full                              # Full reindex
akm list                                      # List all sources
akm lint                                      # Structural lint over the stash; exits 0 on findings (use --fail-on-flagged for CI)
akm lint --fix                                # Auto-fix Tier 1 issues
akm lint --fail-on-flagged                    # Exit non-zero when summary.flagged > 0 (CI-friendly)
akm upgrade                                   # Upgrade akm binary
akm upgrade --check                           # Check for updates
akm hints                                     # Print this reference
```

## Tasks — Per-task timeoutMs

Task YAML supports `timeoutMs` to override the agent profile's `timeoutMs`
(set under `profiles.agent.<name>.timeoutMs`) for a single task:

- `timeoutMs: null` — disable the agent kill timer (useful for long-running local-model tasks)
- `timeoutMs: 120000` — override with a specific value in milliseconds

## Log — Accepted Event Types

`akm log list --type <type>` accepts: `add`, `remove`, `update`, `remember`,
`import`, `save`, `feedback`, `promoted`, `rejected`, `improve_invoked`,
`select`, `improve_skipped`, `reflect_completed`.

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

Run `akm -h` or `akm <command> -h` for per-command help.

### Piping JSON to jq

For any akm command emitting more than ~64KB of JSON, prefer
`akm <cmd> --json | cat | jq …` over the direct pipe. A known Bun
stdout chunking interaction with `jq 1.6` can truncate the stream
mid-document on direct pipes; `cat` re-buffers and presents a clean
pipe to jq. `jq 1.7+` tolerates the chunked writes without the
workaround.

## Error Shapes and Exit Codes

Every command returns JSON by default. On success, the shape is command-specific.
On failure, every command emits:

```json
{"ok": false, "error": "<message>", "hint": "<optional remediation hint>"}
```

The `hint` field is present only when there is an actionable next step (a
suggested flag or alternate command).

Exit codes:

| Code | Meaning | Error class |
| --- | --- | --- |
| 0 | Success | — |
| 1 | Not found or general error | `NotFoundError`, other |
| 2 | Usage / bad input | `UsageError` |
| 78 | Configuration error | `ConfigError` |

To detect failure reliably, check either:

- `ok === false` in the parsed JSON response, or
- a non-zero exit code (`$?` in shell, process exit code in SDK calls)

Both signals are always set consistently. The JSON envelope is the preferred
signal for agents parsing output programmatically; the exit code is the
preferred signal for shell scripts.
