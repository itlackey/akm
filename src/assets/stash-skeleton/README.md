# AKM Stash

This is an **AKM stash** — a structured knowledge repository that stores reusable
assets for you and your AI agents. AKM (Agent Knowledge Management) indexes, ranks,
and surfaces these assets at the right moment during coding sessions, improving
consistency and reducing repeated context-setting.

## What this stash contains

| Directory | Asset type | Purpose |
|-----------|-----------|---------|
| `skills/` | Skills | Step-by-step instructions agents follow for specific tasks |
| `knowledge/` | Knowledge | Reference documents, guides, architecture notes |
| `memories/` | Memories | Persistent facts and preferences learned over time |
| `commands/` | Commands | Parameterised prompt templates for common workflows |
| `agents/` | Agents | Agent definitions with system prompts and tool policies |
| `workflows/` | Workflows | Multi-step orchestration sequences |
| `tasks/` | Tasks | Scheduled or on-demand automation tasks |
| `lessons/` | Lessons | Durable lessons extracted from past sessions |

Add your own assets to any of these directories. AKM will index them automatically
on the next `akm index` run (or when the background improve pipeline picks them up).

## For agents: how to access this stash

All assets in this stash are searchable via the `akm` CLI. Use these commands to
find and read assets during a session:

```sh
# Find assets relevant to your current task (recommended first step)
akm curate "<task description including project name>"

# Full-text + semantic search
akm search "<query>"
akm search "<query>" --type skill
akm search "<query>" --type knowledge

# Show a specific asset by ref
akm show skill:<name>
akm show knowledge:<name>
akm show memory:<name>
akm show command:<name>

# List available assets by type
akm list --type skill
akm list --type knowledge
```

### Recording feedback and new knowledge

```sh
# Mark an asset as helpful (improves future rankings)
akm feedback <ref> --positive

# Capture a durable lesson or memory from the current session
akm remember "<fact or lesson>"
```

### Improving and maintaining the stash

```sh
# Run the self-improvement pipeline (extract, reflect, consolidate)
akm improve

# Check stash health and pipeline metrics
akm health

# Review pending improvement proposals
akm proposal list
akm proposal show <id>
akm proposal accept <id>
```

---

*Created by `akm init`. See `akm --help` for full command reference.*
