/**
 * Embedded "agent CLI hints" rendered by `akm hints` when no other source
 * is available.
 *
 * Extracted from `src/cli.ts` so it does not bloat the CLI module and so
 * docs/CI tooling can re-use the same constants. Two flavors:
 * `EMBEDDED_HINTS` (default reference, ~40 lines) and
 * `EMBEDDED_HINTS_FULL` (`--detail full`, ~250 lines).
 */

const EMBEDDED_HINTS = `# akm CLI

You have access to a searchable library of scripts, skills, commands, agents, knowledge documents, workflows, wikis, and memories via \`akm\`. Search your sources first before writing something from scratch.

## Quick Reference

\`\`\`sh
akm search "<query>"                          # Search all sources
akm curate "<task>"                          # Curate the best matches for a task
akm search "<query>" --type workflow          # Filter to workflow assets
akm search "<query>" --source both            # Also search registries
akm show <ref>                                # View asset details
akm workflow next <ref>                       # Start or resume a workflow
akm remember "Deployment needs VPN access"    # Record a memory in your stash
akm import ./notes/release-checklist.md       # Import a knowledge doc into your stash
akm wiki list                                 # List available wikis
akm wiki ingest <name>                        # Print the ingest workflow for a wiki
akm feedback <ref> --positive|--negative      # Record whether an asset helped
akm add <ref>                                 # Add a source (npm, GitHub, git, local dir)
akm clone <ref>                               # Copy an asset to the working stash (optional --dest arg to clone to specific location)
akm save                                      # Commit (and push if writable remote) changes in the primary stash
akm registry search "<query>"                 # Search all registries
\`\`\`

## Primary Asset Types

| Type | What \`akm show\` returns |
| --- | --- |
| script | A \`run\` command you can execute directly |
| skill | Instructions to follow (read the full content) |
| command | A prompt template with placeholders to fill in |
| agent | A system prompt with model and tool hints |
| knowledge | A reference doc (use \`toc\` or \`section "..."\` to navigate) |
| workflow | Parsed steps plus workflow-specific execution commands |
| memory | Recalled context (read the content for background information) |
| vault | Key names only; use vault commands to inspect or load values safely |
| wiki | A page in a multi-wiki knowledge base. For any wiki task, start with \`akm wiki list\`, then \`akm wiki ingest <name>\` for the workflow. Run \`akm wiki -h\` for the full surface. |

When an asset meaningfully helps or fails, record that with \`akm feedback\` so
future search ranking can learn from real usage.

Run \`akm -h\` for the full command reference.
`;

const EMBEDDED_HINTS_FULL = `# akm CLI — Full Reference

You have access to a searchable library of scripts, skills, commands, agents, knowledge documents, workflows, wikis, and memories via \`akm\`. Search your sources first before writing something from scratch.

## Search

\`\`\`sh
akm search "<query>"                          # Search all sources
akm curate "<task>"                          # Curate the best matches for a task
akm search "<query>" --type workflow          # Filter by asset type
akm search "<query>" --source both            # Also search registries
akm search "<query>" --source registry        # Search registries only
akm search "<query>" --limit 10               # Limit results
akm search "<query>" --detail full            # Include scores, paths, timing
\`\`\`

| Flag | Values | Default |
| --- | --- | --- |
| \`--type\` | \`skill\`, \`command\`, \`agent\`, \`knowledge\`, \`workflow\`, \`script\`, \`memory\`, \`vault\`, \`wiki\`, \`any\` | \`any\` |
| \`--source\` | \`stash\`, \`registry\`, \`both\` | \`stash\` |
| \`--limit\` | number | \`20\` |
| \`--format\` | \`json\`, \`jsonl\`, \`text\`, \`yaml\` | \`json\` |
| \`--detail\` | \`brief\`, \`normal\`, \`full\`, \`summary\`, \`agent\` | \`brief\` |
| \`--for-agent\` | boolean (deprecated — use \`--detail agent\`) | \`false\` |

## Curate

Combine search + follow-up hints into a dense summary for a task or prompt.

\`\`\`sh
akm curate "plan a release"                   # Pick top matches across asset types
akm curate "deploy a Bun app" --limit 3       # Keep the summary shorter
akm curate "review architecture" --type workflow # Restrict to one asset type
\`\`\`

## Show

Display an asset by ref. Knowledge assets support view modes as positional arguments.

\`\`\`sh
akm show script:deploy.sh                     # Show script (returns run command)
akm show skill:code-review                    # Show skill (returns full content)
akm show command:release                      # Show command (returns template)
akm show agent:architect                      # Show agent (returns system prompt)
akm show workflow:ship-release                # Show parsed workflow steps
akm show knowledge:guide toc                  # Table of contents
akm show knowledge:guide section "Auth"       # Specific section
akm show knowledge:guide lines 10 30          # Line range
akm show knowledge:my-doc                    # Show content (local or remote)
\`\`\`

| Type | Key fields returned |
| --- | --- |
| script | \`run\`, \`setup\`, \`cwd\` |
| skill | \`content\` (full SKILL.md) |
| command | \`template\`, \`description\`, \`parameters\` |
| agent | \`prompt\`, \`description\`, \`modelHint\`, \`toolPolicy\` |
| knowledge | \`content\` (with view modes: \`full\`, \`toc\`, \`frontmatter\`, \`section\`, \`lines\`) |
| workflow | \`workflowTitle\`, \`workflowParameters\`, \`steps\` |
| memory | \`content\` (recalled context) |
| vault | \`keys\`, \`comments\` |
| wiki | \`content\` (same view modes as knowledge). For any wiki task, run \`akm wiki list\` then \`akm wiki ingest <name>\` for the workflow. |

## Capture Knowledge While You Work

\`\`\`sh
akm remember "Deployment needs VPN access"     # Record a memory in your stash
akm remember --name release-retro < notes.md   # Save multiline memory from stdin
akm import ./docs/auth-flow.md                 # Import a file as knowledge
akm import - --name scratch-notes < notes.md   # Import stdin as a knowledge doc
akm workflow create ship-release               # Create a workflow asset in the stash
akm workflow validate workflows/foo.md         # Validate a workflow file or ref; lists every error
akm workflow next workflow:ship-release        # Start or resume the next workflow step
akm feedback skill:code-review --positive      # Record that an asset helped
akm feedback agent:reviewer --negative         # Record that an asset missed the mark
akm feedback memory:deployment-notes --positive # Works for memories too
akm feedback vault:prod --positive             # Records vault feedback without surfacing values
\`\`\`

Use \`akm feedback\` whenever an asset materially helps or fails so future search
ranking can learn from actual usage.

## Wikis

Multi-wiki knowledge bases (Karpathy-style). A stash-owned wiki lives at
\`<stashDir>/wikis/<name>/\`; external directories or repos can also be registered
as first-class wikis. akm owns lifecycle + raw-slug + lint + index regeneration
for stash-owned wikis; page edits use your native Read/Write/Edit tools.

\`\`\`sh
akm wiki list                                  # List wikis (name, pages, raws, last-modified)
akm wiki create research                       # Scaffold a new wiki
akm wiki register ics-docs ~/code/ics-documentation # Register an external wiki
akm wiki show research                         # Path, description, counts, last 3 log entries
akm wiki pages research                        # Page refs + descriptions (excludes schema/index/log; includes raw/)
akm wiki search research "attention"           # Scoped search (equivalent to --type wiki --wiki research)
akm wiki stash research ./paper.md             # Copy source into raw/<slug>.md (never overwrites)
echo "..." | akm wiki stash research -         # stdin form
akm wiki lint research                         # Structural checks: orphans, broken xrefs, uncited raws, stale index
akm wiki ingest research                       # Print the ingest workflow for this wiki (no action)
akm wiki remove research --force               # Delete pages/schema/index/log; preserves raw/
akm wiki remove research --force --with-sources # Full nuke, including raw/
\`\`\`

**For any wiki task, start with \`akm wiki list\`, then \`akm wiki ingest <name>\`
to get the step-by-step workflow.** Wiki pages are also addressable as
\`wiki:<name>/<page-path>\` and show up in stash-wide \`akm search\` as
\`type: wiki\`. Files under \`raw/\` and the wiki root infrastructure files
\`schema.md\`, \`index.md\`, and \`log.md\` are not indexed and do not appear in
search results. No \`--llm\` anywhere — akm never reasons about page content.

## Vaults

Encrypted-at-rest key/value stores for secrets. Each vault is a \`.env\`-format
file at \`<stashDir>/vaults/<name>.env\`.

\`\`\`sh
akm vault create prod                         # Create a new vault
akm vault set prod DB_URL postgres://...      # Set a key (or KEY=VALUE combined form)
akm vault set prod DB_URL=postgres://...      # Combined KEY=VALUE form also works
akm vault unset prod DB_URL                   # Remove a key
akm vault list vault:prod                     # List key names (no values)
akm vault show vault:prod                     # Same as list (alias)
akm vault load vault:prod                     # Print export statements to source
\`\`\`

## Workflows

Step-based workflows stored as \`<stashDir>/workflows/<name>.md\`.

\`\`\`sh
akm workflow template                         # Print a starter workflow template
akm workflow create ship-release             # Scaffold a new workflow asset
akm workflow start workflow:ship-release     # Start a new run
akm workflow next workflow:ship-release      # Advance to the next step (or auto-start)
akm workflow complete <run-id>               # Mark a step complete and advance
akm workflow status <run-id>                 # Show current run status
akm workflow resume <run-id>                 # Resume a blocked or failed run
akm workflow list                            # List all workflow runs
\`\`\`

## Clone

Copy an asset to the working stash or a custom destination for editing.

\`\`\`sh
akm clone <ref>                               # Clone to working stash
akm clone <ref> --name new-name               # Rename on clone
akm clone <ref> --dest ./project/.claude       # Clone to custom location
akm clone <ref> --force                       # Overwrite existing
akm clone "npm:@scope/pkg//script:deploy.sh"  # Clone from remote package
\`\`\`

When \`--dest\` is provided, \`akm init\` is not required first.

## Save

Commit local changes in a git-backed stash. Behaviour adapts automatically:

- **Not a git repo** — no-op (silent skip)
- **Git repo, no remote** — stage and commit only (the default stash always falls here)
- **Git repo, has remote, not writable** — stage and commit only
- **Git repo, has remote, \`writable: true\`** — stage, commit, and push

\`\`\`sh
akm save                                      # Save primary stash (timestamp message)
akm save -m "Add deploy skill"               # Save with explicit message
akm save my-skills                            # Save a named writable git stash
akm save my-skills -m "Update patterns"      # Save named stash with message
\`\`\`

The \`--writable\` flag on \`akm add\` opts a remote git stash into push-on-save:

\`\`\`sh
akm add git@github.com:org/skills.git --provider git --name my-skills --writable
\`\`\`

## Add & Manage Sources

\`\`\`sh
akm add <ref>                                 # Add a source
akm add @scope/stash                            # From npm (managed)
akm add owner/repo                            # From GitHub (managed)
akm add ./path/to/local/stash                   # Local directory
akm add git@github.com:org/repo.git --provider git --name my-skills --writable
akm enable skills.sh                          # Enable the skills.sh registry
akm disable skills.sh                         # Disable the skills.sh registry
akm list                                      # List all sources
akm list --kind managed                       # List managed sources only
akm remove <target>                           # Remove by id, ref, path, or name
akm update --all                              # Update all managed sources
akm update <target> --force                   # Force re-download
\`\`\`

## Registries

\`\`\`sh
akm registry list                             # List configured registries
akm registry add <url>                        # Add a registry
akm registry add <url> --name my-team         # Add with label
akm registry add <url> --provider skills-sh   # Specify provider type
akm registry remove <url-or-name>             # Remove a registry
akm registry search "<query>"                 # Search all registries
akm registry search "<query>" --assets        # Include asset-level results
akm registry build-index                      # Build the default cache-backed index.json
akm registry build-index --out dist/index.json # Build to a custom path
\`\`\`

## Configuration

\`\`\`sh
akm config list                               # Show current config
akm config get <key>                          # Read a value
akm config set <key> <value>                  # Set a value
akm config unset <key>                        # Remove a key
akm config path --all                         # Show all config paths
\`\`\`

## Other Commands

\`\`\`sh
akm init                                      # Initialize working stash
akm index                                     # Rebuild search index
akm index --full                              # Full reindex
akm list                                      # List all sources
akm upgrade                                   # Upgrade akm using its install method
akm upgrade --check                           # Check for updates
akm help migrate 0.6.0                        # Print migration notes for a release (or: latest)
akm hints                                     # Print this reference
akm completions                               # Print bash completion script
akm completions --install                     # Install completions
\`\`\`

## Output Control

All commands accept \`--format\` and \`--detail\` flags:

- \`--format json\` (default) — structured JSON
- \`--format jsonl\` — one JSON object per line (streaming-friendly)
- \`--format text\` — human-readable plain text
- \`--format yaml\` — YAML output
- \`--detail brief\` (default) — compact output
- \`--detail normal\` — adds tags, refs, origins
- \`--detail full\` — includes scores, paths, timing, debug info
- \`--detail summary\` — metadata only (no content/template/prompt), under 200 tokens
- \`--detail agent\` — agent-optimized output: strips non-actionable fields
- \`--for-agent\` — deprecated alias for \`--detail agent\`

Run \`akm -h\` or \`akm <command> -h\` for per-command help.
`;

export { EMBEDDED_HINTS, EMBEDDED_HINTS_FULL };
