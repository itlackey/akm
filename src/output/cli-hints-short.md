# akm CLI

You have access to a searchable library of scripts, skills, commands, agents, knowledge documents, workflows, wikis, and memories via `akm`. Search your sources first before writing something from scratch.

## Agent Task Loop

For any task, follow this loop:
1. `akm curate "<task>"` — find the best matching asset
2. `akm show <ref>` — read the schema (field names and structure)
3. Edit the workspace file using schema field names + task-specific values from your README
4. `akm feedback <ref> --positive` — record success

For workflow tasks:
1. `akm workflow next workflow:<name>` — get current step instructions
2. Do the step work in your workspace
3. `akm workflow complete <run-id> --step <step-id>` — mark done, get next step

Workflow runs are scoped to your current project/worktree/directory. Ref-based
commands like `workflow next workflow:<name>`, `workflow status workflow:<name>`,
and `workflow list` operate within the current scope only.

## Quick Reference

```sh
akm search "<query>"                          # Search all sources
akm curate "<task>"                          # Curate the best matches for a task
akm search "<query>" --type workflow          # Filter to workflow assets
akm search "<query>" --source both            # Also search registries
akm show <ref>                                # View asset details
akm workflow next <ref>                       # Start or resume a workflow
akm remember "Deployment needs VPN access"    # Record a memory in your stash
akm remember "note" --target my-stash         # Route write to a named writable stash source
akm import ./notes/release-checklist.md       # Import a knowledge doc into your stash
akm import ./doc.md --target my-stash         # Route import to a named writable stash source
akm wiki list                                 # List available wikis
akm wiki ingest <name>                        # Dispatch an agent to run the ingest workflow (uses defaults.agent or --profile)
akm wiki stash <name> ./paper.md --target my-stash # Route wiki stash write to a named source
akm proposal diff skill:akm-dream             # Diff proposal by ref, UUID, or 8-char prefix
akm proposal accept 7c115132                  # Accept by UUID prefix
akm proposal reject skill:my-skill --reason "..."  # Reject by ref
akm feedback <ref> --positive|--negative      # Record whether an asset helped
akm add <ref>                                 # Add a source (npm, GitHub, git, local dir)
akm clone <ref>                               # Copy an asset to the working stash (optional --dest arg to clone to specific location)
akm sync                                      # Commit (and push if writable remote) changes in the primary stash (--no-push to skip push)
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
| env | A `.env` file of related CONFIGURATION (many vars; sensitive or not — all protected); key names only. Inject with `akm env run <ref> -- <cmd>` (the agent-safe path — values stay on disk). `vault` is the deprecated alias. |
| secret | A single sensitive value for AUTHENTICATION (token, key, cert); name only. Use `akm secret path` / `akm secret run`. |
| wiki | A page in a multi-wiki knowledge base. For any wiki task, start with `akm wiki list`. To ingest sources, run `akm wiki ingest <name>` — it dispatches the configured agent profile to execute the ingest workflow against the wiki's `raw/` directory. Run `akm wiki -h` for the full surface. |

When an asset meaningfully helps or fails, record that with `akm feedback` so
future search ranking can learn from real usage.

Run `akm -h` for the full command reference.
