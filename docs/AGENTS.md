# akm CLI

You have access to a searchable library of scripts, skills, commands, agents, knowledge documents, and memories via `akm`. Search your sources first before writing something from scratch.

## Quick Reference

```sh
akm search "<query>"                          # Search for assets
akm curate "<task>"                          # Curate the best matches for a task
akm search "<query>" --type skill             # Filter by type
akm search "<query>" --source both            # Also search registries
akm show <ref>                                # View asset details
akm show knowledge:my-doc                    # Show a knowledge asset
akm remember "Deployment needs VPN access"    # Record a memory in your stash
akm import ./notes/release-checklist.md       # Import a knowledge doc into your stash
akm feedback <ref> --positive|--negative      # Record whether an asset helped
akm add <ref>                                 # Add a source (npm, GitHub, git, local dir)
akm clone <ref>                               # Copy an asset to the working stash (optional --dest arg to clone to specific location)
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
| memory | Recalled context (read the content for background information) |

When an asset meaningfully helps or fails, record that with `akm feedback` so
future search ranking can learn from real usage.

Run `akm -h` for the full command reference.
