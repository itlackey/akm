# akm CLI

You have access to a searchable library of scripts, skills, commands, agents, knowledge documents, workflows, wikis, and memories via `akm`. Search your sources first before writing something from scratch.

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
akm import ./notes/release-checklist.md       # Import a knowledge doc into your stash
akm wiki list                                 # List wikis (multi-wiki knowledge bases)
akm wiki ingest <name>                        # Print the ingest workflow for a wiki
akm feedback <ref> --positive|--negative      # Record whether an asset helped
akm add <ref>                                 # Add a source (npm, GitHub, git, local dir)
akm clone <ref>                               # Copy an asset to the working stash (optional --dest arg to clone to specific location)
akm save                                      # Commit (and push if writable) the primary git stash
akm save my-skills -m "Update"               # Save a named writable git stash
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
| vault | Keys and comments only; values stay on disk and load via `akm vault load` |
| wiki | A page in a multi-wiki knowledge base. For any wiki task, run `akm wiki list` then `akm wiki ingest <name>` for the workflow. `akm wiki -h` for the full surface. |

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

Run `akm -h` for the full command reference.
