# akm CLI — Full Reference

You have access to a searchable library of scripts, skills, commands, agents, knowledge documents, workflows, wikis, and memories via `akm`. Search your sources first before writing something from scratch.

## Search

```sh
akm search "<query>"                          # Search your sources
akm search "<query>" --type workflow          # Filter by asset type
akm search "<query>" --source both            # Also search registries for installable kits
akm search "<query>" --source registry        # Search registries only
akm search "<query>" --limit 10               # Limit results
akm search "<query>" --detail full            # Include scores, paths, timing
akm curate "<task>"                          # Curate the best matches for a task
```

| Flag | Values | Default |
| --- | --- | --- |
| `--type` | `skill`, `command`, `agent`, `knowledge`, `workflow`, `script`, `memory`, `vault`, `wiki`, `any` | `any` |
| `--source` | `stash`, `registry`, `both` | `stash` |
| `--limit` | number | `20` |
| `--format` | `json`, `jsonl`, `text`, `yaml` | `json` |
| `--detail` | `brief`, `normal`, `full`, `summary` | `brief` |

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
| vault | `keys`, `comments` (values are never returned) |
| wiki | `content` (same view modes as knowledge). For any wiki task, run `akm wiki list` then `akm wiki ingest <name>` for the workflow. |

`akm show wiki:<name>` returns the same summary as `akm wiki show <name>`: path,
description from `schema.md`, page and raw counts, and the last 3 `log.md`
entries.

## Capture Knowledge While You Work

```sh
akm remember "Deployment needs VPN access"     # Record a memory in your stash
akm remember --name release-retro < notes.md   # Save multiline memory from stdin
akm import ./docs/auth-flow.md                 # Import a file as knowledge
akm import - --name scratch-notes < notes.md   # Import stdin as a knowledge doc
akm workflow create ship-release               # Create a workflow asset in the stash
akm workflow next workflow:ship-release        # Resume the active run or start a new one
akm feedback skill:code-review --positive      # Record that an asset helped
akm feedback agent:reviewer --negative         # Record that an asset missed the mark
```

Use `akm feedback` whenever an asset materially helps or fails so future search
ranking can learn from actual usage.

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
echo "..." | akm wiki stash research -         # stdin form
akm wiki lint research                         # Structural checks: orphans, broken xrefs, uncited raws, stale index, broken sources
akm wiki ingest research                       # Print the ingest workflow for this wiki (no action)
akm wiki remove research --force               # Delete pages/schema/index/log; preserves raw/
akm wiki remove research --force --with-sources # Full nuke, including raw/
```

**For any wiki task, start with `akm wiki list`, then `akm wiki ingest <name>`
to get the step-by-step workflow.** Wiki pages are also addressable as
`wiki:<name>/<page-path>` and show up in stash-wide `akm search` as
`type: wiki`. No `--llm` anywhere — akm never reasons about page content.

`akm wiki lint` exits 1 when findings exist and 0 when the wiki is clean.
The `broken-source` finding kind flags pages whose `sources:` frontmatter
entries point to raw files that no longer exist.

See [wikis.md](wikis.md) for the full guide.

## Add & Manage Sources

```sh
akm add <ref>                                 # Add a source
akm add @scope/kit                            # From npm (managed)
akm add owner/repo                            # From GitHub (managed)
akm add ./path/to/local/kit                   # Local directory
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

When `--dest` is provided, `akm init` is not required first.

## Save

Commit local changes in a git-backed stash. Behaviour adapts automatically:

- **Not a git repo** — no-op (silent skip)
- **Git repo, no remote** — stage and commit only (the default stash always falls here)
- **Git repo, has remote, not writable** — stage and commit only
- **Git repo, has remote, `writable: true`** — stage, commit, and push

```sh
akm save                                      # Save primary stash (timestamp message)
akm save -m "Add deploy skill"               # Save with explicit message
akm save my-skills                            # Save a named writable git stash
akm save my-skills -m "Update patterns"      # Save named stash with message
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
akm setup                                     # Guided config, init, and index
akm init                                      # Initialize working stash
akm init --dir ~/custom-stash                 # Initialize at a custom path
akm index                                     # Rebuild search index
akm index --full                              # Full reindex
akm list                                      # List all sources
akm upgrade                                   # Upgrade akm binary
akm upgrade --check                           # Check for updates
akm hints                                     # Print this reference
```

## Output Control

All commands accept `--format` and `--detail` flags:

- `--format json` (default) — structured JSON
- `--format jsonl` — one JSON object per line (streaming-friendly)
- `--format text` — human-readable plain text
- `--format yaml` — YAML output
- `--detail brief` (default) — compact output
- `--detail normal` — adds tags, refs, origins
- `--detail full` — includes scores, paths, timing, debug info
- `--detail summary` — metadata only (no content/template/prompt), under 200 tokens

Run `akm -h` or `akm <command> -h` for per-command help.

## Error Shapes and Exit Codes

Every command returns JSON by default. On success, the shape is command-specific.
On failure, every command emits:

```json
{"ok": false, "error": "<message>", "hint": "<optional remediation hint>"}
```

The `hint` field is present only when there is an actionable next step (e.g.
`"Run akm add <source> --trust to bypass the audit for this source."`).

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
