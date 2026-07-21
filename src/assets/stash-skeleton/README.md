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
| `facts/` | Facts | Durable stash-level context; the house conventions in `facts/conventions/` are auto-surfaced to authoring agents |
| `scripts/` | Scripts | Executable helpers agents and humans can run |
| `env/`, `secrets/` | Env & Secrets | Configuration groups and single credentials; values are never content-indexed |

Add your own assets to any of these directories. AKM will index them automatically
on the next `akm index` run (or when the background improve pipeline picks them up).

## How to organize assets

A file's path under its type directory becomes part of its ref
(`knowledge/auth/oauth-refresh-races.md` → `knowledge/auth/oauth-refresh-races`),
and its segments are search terms: `akm search "auth" --type knowledge` narrows
to that subtree. Retrieval is search, not folder-browse, so pick subdirectories
deliberately. The house rules live in three convention facts under
`facts/conventions/` and are surfaced to agents automatically when they author
assets:

- **`facts/conventions/organization`** — the single path axis, chosen by asset
  type. **Scope-born** types (`memory`, `lesson`, `task`, `env`, `secret`) go
  under the current **project/client** slug; **reuse-born** types (`knowledge`,
  `skill`, `fact`, `script`) go under a stable **domain**; global types
  stay at the type root.
- **`facts/conventions/backlinks`** — how to cross-link: a provenance xref
  whenever an asset derives from another, sparse real associative links,
  corrections as new assets, canonical entity naming.
- **`facts/conventions/domains`** — the (editable) domain vocabulary for
  reuse-born assets, plus canonical entity spellings.

Per-type nuances live in `facts/conventions/assets/<type>.md`. All of these are
soft guidance — edit them to match how your stash is queried.

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
