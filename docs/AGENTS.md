# akm CLI

You have access to a searchable library of scripts, skills, commands, agents, knowledge documents, and memories via `akm`. Search the stash first before writing something from scratch.

## Quick Reference

```sh
akm search "<query>"                          # Search for assets
akm search "<query>" --type skill             # Filter by type
akm search "<query>" --source both            # Search stashes and registries for assets
akm show <ref>                                # View asset details
akm show viking://resources/my-doc           # Show remote OpenViking content
akm add <ref>                                 # Install a kit (npm, GitHub, git, local)
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

Run `akm -h` for the full command reference.
