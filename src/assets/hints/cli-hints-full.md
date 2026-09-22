# akm CLI — Full Reference

You have access to a searchable library of scripts, skills, commands, agents, knowledge documents, workflows, env files, secrets, lessons, and memories via `akm`. Search your sources first before writing something from scratch.

## Search

```sh
akm search "<query>"                          # Search all sources
akm curate "<task>"                          # Curate the best matches for a task
akm search "<query>" --type workflow          # Filter by asset type
akm search "<query>" --from all                # Also search registries
akm search "<query>" --from registry           # Search registries only
akm search "<query>" --limit 10               # Limit results
akm search "<query>" --detail full            # Include scores, paths, timing
akm search "memories/projectA/"               # Enumerate a subtree (conceptId prefix; trailing slash required)
akm search "knowledge/"                       # List every knowledge item
akm search "team-catalog//"                   # List every item in one bundle
```

| Flag | Values | Default |
| --- | --- | --- |
| `--type` | free-form. Built-ins: `skill`, `command`, `agent`, `knowledge`, `workflow`, `script`, `memory`, `lesson`, `task`, `session`, `fact`, `env`, `secret`, `instruction` — plus any adapter-defined type (`website`, `wiki-source`, a wiki `pageKind`). Exact match; an unknown type returns no hits. | `any` |
| `--from` | `local`, `registry`, `all`, or a configured bundle name | `local` |
| `--limit` | number | `20` |
| `--format` | `json`, `jsonl`, `text`, `yaml`, `md`, `html` | `json` |
| `--detail` | `brief`, `normal`, `full` | `brief` |
| `--shape` | `human`, `agent`, `summary` (`summary` only on `show`) | `human` |

Ref-prefix queries (a conceptId prefix ending in `/`, optionally bundle-qualified)
return a deterministic listing, not a relevance ranking. Drop the trailing slash
and the same text becomes an ordinary keyword search — resolving a single asset
by its `<subdir>/<name>` id is `akm show`'s job. Because prefixes match
conceptIds, you can paste a ref prefix straight from search output back into a
query.

`search` and `curate` results include an additive `tip` field (a plain-text
suggestion, e.g. "Run `akm index` to build one" or "No matching assets were
found") whenever the result set is empty; it is omitted when there are hits.

## Curate

Combine search + follow-up hints into a dense summary for a task or prompt.

```sh
akm curate "plan a release"                   # Pick top matches across asset types
akm curate "deploy a Bun app" --limit 3       # Keep the summary shorter
akm curate "review architecture" --type workflow # Restrict to one asset type
```

## Show

Display an asset by ref from the local index and materialized bundle files only.
On a markdown document `#fragment` selects one section by heading slug.

```sh
akm show scripts/deploy.sh                    # Show script (returns run command)
akm show skills/code-review                   # Show skill (returns full content)
akm show commands/release                     # Show command (returns template)
akm show agents/architect                     # Show agent (returns system prompt)
akm show workflows/ship-release               # Show parsed workflow steps
akm show knowledge/guide                      # Whole document
akm show knowledge/guide#auth                 # Just the "Auth" section
akm show knowledge/guide#nope                 # Lists the available fragment slugs
akm show knowledge/my-doc                     # Show materialized local content
```

| Type | Key fields returned |
| --- | --- |
| script | `run`, `setup`, `cwd` |
| skill | `content` (full SKILL.md) |
| command | `template`, `description`, `parameters` |
| agent | `prompt`, `description`, `modelHint`, `toolPolicy` |
| knowledge | `content` (whole document, or one section via `#fragment`) |
| workflow | `workflowTitle`, `workflowParameters`, `steps` |
| memory | `content` (recalled context) |
| env | `keys` (key names only — values and comment text never returned) |
| secret | `name` only (the whole file is the value — never returned) |
| lesson | `content` plus `action` (rendered from the `when_to_use` frontmatter) — read both before applying the lesson |

## Capture Knowledge While You Work

```sh
akm remember "Deployment needs VPN access"     # Record a memory in your bundle
akm remember --name release-retro < notes.md   # Save multiline memory from stdin
akm remember "note" --bundle my-other-bundle    # Route write to a named writable bundle source
akm remember "note" --xref knowledge/auth-flow # Cite provenance in frontmatter xrefs (repeatable; ref must resolve)
akm remember "fix" --supersedes memories/old-note # Write a correction AND demote the old asset (beliefState: superseded)
akm import ./docs/auth-flow.md                 # Import a file as knowledge
akm import ./doc.md --xref knowledge/auth-flow # Merge provenance xrefs into the imported doc's frontmatter
akm import ./new.md --supersedes knowledge/old # Import a correction AND demote the doc it replaces
akm import - --name scratch-notes < notes.md   # Import stdin as a knowledge doc
akm import https://example.com/docs/auth       # Fetch one URL and import it as knowledge
akm import ./doc.md --target my-other-bundle    # Route import to a named writable bundle source
akm workflow create ship-release               # Create a workflow asset in the bundle
akm lint --type workflows                      # Parse and compile every .md/.yml workflow source; list every error
akm workflow run workflows/ship-release        # Start or resume and execute the workflow
akm feedback skills/code-review --positive     # Record that an asset helped
akm feedback agents/reviewer --negative --reason "wrong framework" # Record why an asset missed the mark
akm feedback memories/deployment-notes --positive # Works for memories too
akm feedback env/prod --positive               # Records env feedback without surfacing values
```

Use `akm feedback` whenever an asset materially helps or fails so future search
ranking can learn from actual usage.

## LLM Wiki bundles

An LLM Wiki (Karpathy-style knowledge base) is a **bundle format**, not an akm
asset type — there is no `akm wiki` command family. akm's LLM Wiki adapter
recognizes one deterministically at install time: a bundle component whose root
holds a `schema.md` plus a `pages/` directory is mounted as an `llm-wiki`
component. Its pages are then indexed like any other content and resolve to
`bundle//conceptId` refs (e.g. `team-catalog//pages/attention`).

Install one as a source, then search and read its pages with the ordinary
commands — no wiki-specific verbs:

```sh
akm bundle add owner/llm-wiki-repo                    # Install an LLM Wiki bundle as a source (npm, GitHub, git, or local dir)
akm search "attention"                         # Wiki pages surface in ordinary search results
akm show team-catalog//pages/attention          # Read a page by its bundle//conceptId ref (copy the ref from search)
akm bundle list                                       # Confirm the bundle is installed
```

Files under the bundle's `raw/` directory and the wiki infrastructure files
`schema.md`, `index.md`, and `log.md` are not indexed and do not appear in
search results. No `--llm` anywhere — akm never reasons about page content.

## Env files

Configuration an app or service loads together, in one `.env` file at
`<bundle>/env/<name>.env`, sourced/injected wholesale. Key names are
discoverable; values and comment text stay on disk and never reach stdout or
the index (comments can contain commented-out credentials). akm does not edit
entries — you edit the file with your own editor and akm loads it.

```sh
akm env create prod                           # Create an empty env file
akm env create prod --from-file ./.env        # Ingest an existing .env
akm env list                                  # List all env files across bundles with key names
akm show env/prod                             # Inspect key names (never values or comments)
akm env run env/prod -- ./deploy.sh           # Run a command with the whole .env injected (the safe path)
akm env run env/prod -- $SHELL                # Open an interactive shell with values injected
akm env export env/prod --out ./env.sh        # Write a sourceable script to a file (mode 0600)
akm env path env/prod --quiet                 # Print the raw file path (for Docker `_FILE` / `--env-file`)
akm env remove env/prod                       # Delete the env file
```

## Secrets

A single sensitive value used on its own for authentication (a token, key, or
cert) — one file = one value at `<bundle>/secrets/<name>`. The ENTIRE file is
the value; only the name is ever surfaced.

```sh
printf '%s' "$TOKEN" | akm secret set secrets/deploy-token  # Store a single value
akm secret list                                             # List secrets (names only)
akm secret run secrets/deploy-token GITHUB_TOKEN -- gh release create v1.0.0  # Inject into one env var
```

## Workflows

Workflows live under `<bundle>/workflows/` as peer `.md` and `.yml` sources.
Both compile to the same source IR; see `docs/reference/workflow-schema.md` for
the bounded GitHub-shaped YAML subset.

Ref-based workflow commands are scoped to the current project/worktree/directory,
so one active run does not block unrelated directories from starting the same
workflow. Direct run-id commands still target the exact run.

```sh
akm workflow create ship-release --print     # Print a starter workflow template, without writing
akm workflow create ship-release             # Scaffold a new workflow asset
akm workflow run workflows/ship-release --version=1.2.3  # Start and execute with exact-name parameter flags
akm workflow run <run-id> --max-retries 2 --timeout 10m  # Resume with invocation-wide controls
akm workflow status <run-id>                 # Show the exact run by id
akm workflow resume <run-id>                 # Resume a blocked or failed run
akm workflow list                            # List workflow runs in the current scope
```

## Clone

Copy an asset to the working bundle or a custom destination for editing.

```sh
akm clone <ref>                               # Clone to working bundle
akm clone <ref> --name new-name               # Rename on clone
akm clone <ref> --dest ./project/.claude       # Clone to custom location
akm clone <ref> --force                       # Overwrite existing
akm clone "npm:@scope/pkg//scripts/deploy.sh" # Clone from remote package
```

When `--dest` is provided, `akm bundle create` is not required first.

## Move / Rename

**A rename is delete plus create**: the new path is a new identity, so the
destination starts with fresh learned state (utility, salience, usage history)
and inbound refs to the old path dangle. Prefer NOT renaming — a ref is chosen
once. When a rename is unavoidable:

```sh
mv ~/akm/memories/projectA/old-note.md ~/akm/memories/projectA/new-note.md
# update any intentional refs (fully qualified: bundle//memories/projectA/old-note)
akm index
akm lint                                             # confirms nothing dangles
```

A memory's `.derived.md` twin must move with its base. Moving an item between
bundles is `akm clone` (or a copy) followed by deleting the source — both the
bundle and the concept identity change.

There is no `akm mv` — the procedure above is the whole story. To carry an
asset's earned signal (feedback, usage, salience/outcome history) across the
rename instead of starting fresh, run `bun scripts/rekey-asset-ref.ts <old-ref>
<new-ref>` from a source clone after the move and before `akm index`
(`--dry-run` previews the row counts).

## Sync

Commit local changes in a git-backed bundle. Behaviour adapts automatically.
(`akm save` was the pre-0.8 spelling; it was removed in 0.9.0 — use `akm sync`.)

- **No `.git` directory** — no-op (silent skip)
- **Git repo, no remote** — stage and commit only (the default bundle always falls here)
- **Git repo, has remote, not writable** — stage and commit only
- **Git repo, has remote, `writable: true`** — stage, commit, and push
- **Any writable repo with `--no-push`** — stage and commit only

```sh
akm sync                                      # Sync primary bundle (timestamp message)
akm sync -m "Add deploy skill"               # Sync with explicit message
akm sync --no-push                            # Commit only; never push
akm sync my-skills                            # Sync a named writable git bundle
akm sync my-skills -m "Update patterns"      # Sync named bundle with message
```

`akm improve` also performs an end-of-run batch commit for git-backed bundles.
The `--sync` / `--no-sync` and `--push` / `--no-push` flags control this:

```sh
akm improve                                   # auto-sync per strategy default (most strategies: on; proactive-maintenance/reflect-distill: off)
akm improve --no-sync                         # skip the end-of-run commit
akm improve --no-push                         # commit but skip push for this run
akm improve --sync                            # force sync even on strategies that disable it
```

Strategy sync defaults: `catchup`, `consolidate`, `default`,
`graph-refresh`, `quick`, and `thorough` auto-commit + push;
`proactive-maintenance` and `reflect-distill` skip sync entirely. Override
with `--sync` / `--no-sync` flags.

The `--writable` flag on `akm bundle add` opts a remote git bundle into push-on-sync:

```sh
akm bundle add git@github.com:org/skills.git --provider git --name my-skills --writable
```

## Add & Manage Sources

```sh
akm bundle add <ref>                                 # Add a source
akm bundle add @scope/pkg                            # From npm (managed)
akm bundle add owner/repo                            # From GitHub (managed)
akm bundle add ./path/to/local/bundle                   # Local directory
akm bundle add git@github.com:org/repo.git --provider git --name my-skills --writable
akm bundle add https://github.com/org/private.git --provider git --credential '$GIT_READ_TOKEN'
akm registry add https://skills.sh --name skills.sh --provider skills-sh  # Add the skills.sh registry
akm registry remove skills.sh                 # Remove the skills.sh registry
akm bundle list                                      # List all sources
akm bundle list --kind git                           # Filter by provider (filesystem, git, npm, website)
akm bundle remove <target>                           # Remove by id, ref, path, or name
akm bundle update --all                              # Update all managed sources
akm bundle update <target> --force                   # Force re-download
akm bundle update <target> --allow-dangerous-env-keys # Approve reviewed dangerous env keys
akm bundle update --all --skip-if-locked             # Scheduled refresh; exit 0 on DB contention
```

Git bundles refresh only when `akm bundle update` runs. Schedule that command
when automatic refresh is desired.

## Registries

```sh
akm registry list                             # List configured registries
akm registry add <url>                        # Add a registry
akm registry add <url> --name my-team         # Add with label
akm registry add <url> --provider skills-sh   # Specify provider type
akm registry remove <url-or-name>             # Remove a registry
akm search "<query>" --from registry          # Search all registries (registry search was folded into search)
akm search "<query>" --from registry --assets # Include asset-level results
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
akm bundle create                                      # Initialize working bundle (scaffold only)
akm setup                                     # Interactive wizard: bundle + LLM/embedding + agent + registry config
akm setup --dir ~/custom-bundle                # Run the wizard against a custom bundle path
akm setup --yes                               # Non-interactive, accepts all defaults
akm index                                     # Rebuild search index (metadata enrichment when configured)
akm index --full                              # Full reindex (metadata enrichment when configured)
akm bundle list                                      # List all sources
akm lint                                      # Structural lint over the bundle; exits 0 regardless of findings
akm lint --fix                                # Auto-fix Tier 1 issues
akm lint --fail-on-flagged                    # Exit non-zero when summary.flagged > 0 (CI-friendly)
akm upgrade                                   # Upgrade akm using its install method
akm upgrade --check                           # Check for updates
akm help migrate 0.6.0                        # Print migration notes for a release (or: latest)
akm help bundle                               # Print options and subcommands for one command
akm help agents --full                        # Print this reference
akm hints                                     # Print this complete agent guide
akm completions                               # Print bash completion script
akm completions --install                     # Install completions
```

`akm bundle create` only scaffolds the bundle directory and registers it in config;
`akm setup` additionally walks through embedding/LLM connections, agent
profiles, sources, and registries. Use `setup` for first-time onboarding,
`bundle create` when you just need a bare bundle.

## Proposals & Improvement (0.8.0+)

```sh
akm improve <ref>                                       # Propose improvement for an asset
akm proposal list                                       # List pending proposals
akm proposal show <id>                                  # Render the proposal body
akm proposal diff <ref-or-id>                           # Diff by ref, UUID, or 8-char prefix
akm proposal diff skills/akm-dream                      # Diff by asset ref
akm proposal accept 7c115132                            # Accept by UUID prefix
akm proposal accept <id> --target team-bundle            # Accept to a named writable bundle source
akm proposal reject skills/my-skill --reason "not ready" # Reject by asset ref
akm proposal reject <id> --reason "..."                 # Archive with a reason
akm proposal revert <id>                                # Restore the pre-promotion content
akm proposal new <type> <name> --task "..."             # Agent-author a NEW asset as a proposal
akm proposal extract --auto                             # Mine native session files into proposals
akm proposal extract --type claude                 # Restrict extraction to one harness
```

The flat verbs `akm proposals` / `akm show proposal` / `akm accept` /
`akm reject` / `akm diff` / `akm revert` were removed in 0.9.0 — use the
`akm proposal <verb>` forms above. `akm extract` and `akm propose` moved
here as `proposal extract` / `proposal new`.

## Scheduled Tasks

Tasks are pure-YAML assets at `<bundle>/tasks/<id>.yml`, bound to the OS
scheduler (cron / launchd / schtasks). The file is the source of truth:
`task sync` reconciles files to scheduler entries, so editing or deleting a
file plus one `sync` is a complete workflow.

```sh
akm task add nightly-improve --schedule "@daily" --command "akm improve --strategy default"
akm task add briefing --schedule "0 9 * * *" --prompt "Draft the morning briefing"  # Inline command task
akm task enable <bundle>//tasks/<id>           # Enable locally and sync that bundle
akm task disable <bundle>//tasks/<id>          # Disable locally and unschedule it
akm task sync                                  # Reconcile activated refs from every enabled configured bundle
akm task sync --rebind                         # Also re-pin the scheduler's akm binary/spelling
akm task doctor                                # Scheduler binding + runtime eligibility diagnosis
akm task history                               # Recent run rows (status, timing)
akm task run <id>                              # Run one task immediately (works when disabled)
akm task explain <ref>                         # Read-only: declared inputs, target, schedule — spawns nothing
akm search --type task                         # Enumerate task assets (there is no `task list`)
```

Task files use task source v4 (`version: 4`). There is no `akm:` options bag
or `on:` block — every control (`schedule`, `timeout`, `engine`, `model`,
`redact`, `maxSteps`, `maxRetries`, …) is a top-level key now. Typed
`inputs:` declarations and a bounded `output:` schema work like a
workflow's (`output:` replaces v3's `akm.outputSchema`). Task source never
controls activation: use `akm task enable` / `disable`, which update the
host-local config allow-list and sync. To remove one, delete the YAML and run
`akm task sync` — the scheduler entry is unbound. Top-level
`timeout:` may be `null` (disable the invocation timer) or a duration/number
overriding the selected engine invocation timeout. Preview old task-v2/v3
conversion with `akm migrate apply --dry-run`.

## Agent Dispatch

```sh
akm agent --prompt "summarize open proposals"   # Dispatch the configured agent CLI
akm agent agents/architect --prompt "..."       # Embody a bundle agent asset (system prompt, model, tool policy)
akm command run commands/release                # Canonical reusable-command dispatch
akm agent --model sonnet --prompt "..."         # Model override (aliases or exact IDs)
```

## Health, Info, and the Event Log

```sh
akm info                                       # Capabilities, bundle dir, index stats, semantic-search status
akm health                                     # Runtime diagnostics; exit 0 ok / 4 warn / 1 fail
akm health --report                            # Adds accept-rate and graph-coverage metrics
akm log                                        # Append-only event stream (mutations, feedback, indexing)
akm log --ref <ref>                            # One asset's event trail
akm log --since @offset:<id>                   # Durable row-id cursor — poll this to follow the stream
akm log --run <run-id>                         # Events for one workflow-engine run
```

## Output Control

Result-envelope commands accept `--format`, `--detail`, and `--shape` flags:

- `--format json` (default) — structured JSON
- `--format jsonl` — one JSON object per line (streaming-friendly)
- `--format text` — human-readable plain text
- `--format yaml` — YAML output
- `--format md` — Markdown output
- `--format html` — HTML output
- `--detail brief` (default) — compact output
- `--detail normal` — adds tags, refs, origins
- `--detail full` — includes scores, paths, timing, debug info
- `--shape human` (default) — standard projection
- `--shape agent` — agent-optimized output: strips non-actionable fields
- `--shape summary` — metadata only (no content/template/prompt), under 200 tokens; only `akm show` has a dedicated summary projection — elsewhere it falls back to `agent` with a warning

Run `akm help <command>` or `akm <command> -h` for per-command help. Run
`akm --help` for the sectioned command overview.

### Piping JSON to jq

For any akm command emitting more than ~64KB of JSON, prefer
`akm <cmd> | cat | jq …` over the direct pipe. A known Bun stdout chunking
interaction with `jq 1.6` can truncate the stream mid-document on direct
pipes; `cat` re-buffers and presents a clean pipe to jq. `jq 1.7+` tolerates
the chunked writes without the workaround.

## Error Shapes and Exit Codes

Every command returns JSON by default. On success, the shape is command-specific.
On failure, every command emits a JSON envelope on **stderr** (stdout is
normally left empty):

```json
{"ok": false, "error": "<message>", "code": "<optional machine-readable code>", "hint": "<optional remediation hint>"}
```

`code` is present for errors akm classifies (e.g. `INVALID_FLAG_VALUE`,
`ASSET_NOT_FOUND`, `UNKNOWN_COMMAND`); an unexpected internal error omits it.
The `hint` field is present only when there is an actionable next step (a
suggested flag or alternate command).

Exit codes:

| Code | Meaning | Error class |
| --- | --- | --- |
| 0 | Success | — |
| 1 | Not found or command-reported failure | `NotFoundError`, command result |
| 2 | Usage / bad input | `UsageError` |
| 4 | Health warning (`akm health` only) | — |
| 70 | Internal / unclassified error | unexpected throw |
| 78 | Configuration error | `ConfigError` |

To detect failure reliably, check either:

- `ok === false` in the parsed JSON response, or
- a non-zero exit code (`$?` in shell, process exit code in SDK calls)

On result-envelope surfaces, both signals are always set consistently. The JSON
envelope is the preferred signal for agents parsing output programmatically;
the exit code is the preferred signal for shell scripts. Passthrough surfaces
below preserve the child's own streams and status instead.

`env run`, `secret run`, and `migrate` are process passthroughs and preserve
the spawned process's exact status. `task run` preserves configuration failures
as exit 78; successful task results exit 0 and other failures exit 1, while a
command child's exact status remains in `result.detail.exitCode`. `agent` maps
a failed dispatch to 1 and retains the child status in its final result envelope.

`akm lint` is the one command that does not follow the exit-code table above:
it exits **0 on every successful run regardless of findings**. Read
`summary.flagged` to detect issues, or pass `--fail-on-flagged` to opt into
the CI-friendly "exit 1 when findings exist" behavior:

```sh
akm lint | jq '.summary.flagged'              # always exit 0; read the count
akm lint --fail-on-flagged && deploy          # exit 1 if any flagged issues
```
