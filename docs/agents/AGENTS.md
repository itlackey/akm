# akm CLI

You have access to a searchable library of scripts, skills, commands, agents, knowledge documents, workflows, vaults, wikis, lessons, and memories via `akm`. Search your sources first before writing something from scratch.

## Quick Reference

```sh
akm search "<query>"                          # Search for assets
akm curate "<task>"                          # Curate the best matches for a task
akm search "<query>" --type workflow          # Filter to workflow assets
akm search "<query>" --source both            # Also search registries
akm show <ref>                                # View asset details
akm show knowledge:my-doc                    # Show a knowledge asset
akm workflow next workflow:ship-release       # Resume the active run or start a new one
akm remember "Deployment needs VPN access"    # Record a memory in your stash
akm remember "note" --target my-stash         # Route write to a named writable stash source
akm import ./notes/release-checklist.md       # Import a knowledge doc into your stash
akm import ./doc.md --target my-stash         # Route import to a named writable stash source
akm import https://example.com/docs/auth      # Fetch one URL into knowledge/
akm wiki list                                 # List wikis (multi-wiki knowledge bases)
akm wiki stash research https://example.com/paper # Fetch one URL into wiki raw/
akm wiki stash research ./paper.md --target my-stash # Route wiki stash write to a named source
akm wiki ingest <name>                        # Dispatch defaults.agent (or --profile) to run the ingest workflow
akm feedback <ref> --positive|--negative      # Record whether an asset helped
akm add <ref>                                 # Add a source (npm, GitHub, git, local dir)
akm clone <ref>                               # Copy an asset to the working stash (optional --dest arg to clone to specific location)
akm sync                                      # Commit (and push if writable) the primary git stash
akm sync my-skills -m "Update"               # Sync a named writable git stash
akm registry search "<query>"                 # Search all registries
```

## Primary Asset Types

| Type | What `akm show` returns |
| --- | --- |
| script | A `run` command you can execute directly |
| skill | Instructions to follow (read the full content) |
| command | A prompt template with placeholders to fill in |
| agent | A system prompt with model and tool hints |
| knowledge | A reference doc (use `toc` or `section "..."` to navigate) |
| workflow | Parsed steps plus workflow-specific execution commands |
| memory | Recalled context (read the content for background information) |
| vault | Keys only in normal output; use `akm vault path` or `akm vault run` when a command needs values |
| wiki | A page in a multi-wiki knowledge base. For any wiki task, run `akm wiki list`. `akm wiki ingest <name>` dispatches the configured agent (defaults.agent or `--profile`) to execute the wiki's ingest workflow. `akm wiki -h` for the full surface. |
| lesson | A distilled feedback lesson (`when_to_use` plus body). Read before applying related skills. Generated via `akm distill` and the proposal queue. |

When an asset meaningfully helps or fails, record that with `akm feedback` so
future search ranking can learn from real usage.

## Error Shapes and Exit Codes

Every command returns JSON by default. On failure, the shape is always:

```json
{"ok": false, "error": "<message>", "hint": "<optional remediation hint>"}
```

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Not found or general error |
| 2 | Usage / bad input |
| 78 | Configuration error |

Check `ok === false` or a non-zero exit code to detect failure. The `hint`
field, when present, describes a corrective action.

### `akm lint` exit code (0.8.0+)

`akm lint` exits **0 on every successful run regardless of findings**.
Read `summary.flagged` to detect issues, or pass `--fail-on-flagged` to
opt into the CI-friendly "exit 1 when findings exist" behavior:

```sh
akm lint --json | jq '.summary.flagged'    # always exit 0; read the count
akm lint --fail-on-flagged && deploy       # exit 1 if any flagged issues
```

This means `akm lint` runs cleanly in pipelines and reports findings
in-band; `ok: true` does NOT imply zero findings. Treat
`summary.flagged > 0` as the "needs attention" signal.

Large `--json` output (>64KB) piped directly to `jq 1.6` can truncate
mid-stream due to a Bun stdout chunking interaction. Insert `| cat |`
between akm and jq, or use `jq 1.7+`, to avoid the symptom:

```sh
akm lint --json | cat | jq '.'   # safe for any output size
```

## Proposals & improvement (0.8.0+)

`akm` ships a proposal queue so reflective edits, improvements, and feedback-distilled lessons
land out-of-band before they touch the live stash. None of these commands
mutate stash content directly — they always go through `akm accept`.

```sh
akm improve <ref>                              # Produce an improvement proposal for an existing asset
akm improve <ref> --task "tighten the description"
akm improve <type> <name> --task "..."         # Draft a new asset proposal from a description
akm improve lesson docker-cleanup --task "consolidate cleanup feedback"
akm proposal list                              # List pending proposals
akm proposal list --status pending|accepted|rejected
akm proposal show <id>                          # Render the proposal body
akm proposal diff <ref-or-id>                   # Diff by ref, UUID, or 8-char prefix (proposal positional optional)
akm proposal diff skill:akm-dream               # diff accepts full asset ref
akm proposal accept 7c115132                    # Accept by UUID prefix
akm proposal accept <id>                        # Validate + promote into the stash
akm proposal reject skill:my-skill --reason "not ready" # Reject by asset ref
akm proposal reject <id> --reason "..."         # Archive with a reason
akm search "<query>" --include-proposed        # Surface proposal-queue entries in search
akm history --ref <ref>                        # Per-asset state-change trail
```

Run `akm -h` for the full command reference.
