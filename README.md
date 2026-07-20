# akm — Agent Knowledge Manager

[![npm version](https://img.shields.io/npm/v/akm-cli)](https://www.npmjs.com/package/akm-cli)
[![CI](https://github.com/itlackey/akm/actions/workflows/ci.yml/badge.svg)](https://github.com/itlackey/akm/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/akm-cli)](LICENSE)

**A package manager for AI agent capabilities** — scripts, skills, commands, agents, knowledge, memories, workflows, wikis, vaults, lessons, and scheduled tasks — that works with any AI coding assistant that can run shell commands.

akm gives agents a curated, searchable library built from local directories, GitHub repos, npm packages, and websites. Instead of front-loading a giant prompt, agents pull exactly what they need, when they need it, and feed results back so the library improves over time.

## Install

**Option 1 — Prebuilt binary (recommended, no runtime required):**

```sh
# Linux / macOS
curl -fsSL https://github.com/itlackey/akm/releases/latest/download/install.sh | bash

# Windows (PowerShell)
irm https://github.com/itlackey/akm/releases/latest/download/install.ps1 | iex
```

**Option 2 — npm package (requires [Node.js](https://nodejs.org) >= 22):**

```sh
npm install -g akm-cli
```

Upgrade in place: `akm upgrade`

The npm package always uses Node.js to bootstrap its cross-platform command.
If a working [Bun](https://bun.sh) >= 1.0 is also on `PATH`, the launcher
prefers Bun for execution; old, unusable, or absent Bun installations fall back
to Node.js. Node.js remains required for the npm package. The standalone
binaries are runtime-free.

See [Privacy & data](docs/data-and-telemetry.md) for details on what akm stores locally.

### From source (contributors only)

```sh
git clone https://github.com/itlackey/akm.git
cd akm
bun install
bun run build
```

## What akm does

- **Manage sources** — add local dirs, git repos, npm packages, and websites as searchable asset sources [(details)](docs/features/sources-registries.md)
  ```sh
  akm add github:owner/stash        # GitHub
  akm add https://docs.example.com  # crawled website
  ```
- **Search a unified index** — one FTS5 index across all your sources [(details)](docs/features/search-discovery.md)
  ```sh
  akm search "deploy" --type script --limit 5
  ```
- **Curate a shortlist** — get the best-match assets for a task without knowing exact names [(details)](docs/features/search-discovery.md)
  ```sh
  akm curate "set up a kubernetes deployment"
  ```
- **Load assets on demand** — show the full content of any asset by ref [(details)](docs/features/search-discovery.md)
  ```sh
  akm show workflow:ship-release
  ```
- **Capture local knowledge** — save discoveries as memories, imported docs, or wiki pages [(details)](docs/features/knowledge-management.md)
  ```sh
  akm remember "Staging deploys require VPN"
  akm import ./notes/runbook.md --wiki ops
  ```
- **Run structured workflows** — parse, start, step through, and resume multi-step procedures [(details)](docs/features/workflows.md)
  ```sh
  akm workflow start workflow:onboarding
  ```
- **Improve continuously** — feedback drives proposals; proposals drive asset quality [(details)](docs/features/improvement-loop.md)
  ```sh
  akm feedback skill:code-review --positive
  akm improve && akm proposal list
  ```

## Quick start

```sh
akm setup                             # guided first-time setup
akm add github:itlackey/akm-stash     # install the official onboarding stash
akm index                             # build the search index
akm curate "deploy"                   # get a curated shortlist
akm show workflow:deploy              # load the best match
akm remember "Deployment needs VPN"  # capture a memory
akm feedback workflow:deploy --positive
```

For non-interactive setup: `akm setup --yes` (or `--dir ~/custom-stash` for a custom path).

See [docs/getting-started.md](docs/getting-started.md) for a full walkthrough.

## Asset types

| Type | What it is | Example ref |
| --- | --- | --- |
| **script** | Executable shell or code automation | `script:deploy.sh` |
| **skill** | A set of agent instructions | `skill:code-review` |
| **command** | A prompt template with placeholders | `command:summarize` |
| **agent** | System prompt + model + tool policy | `agent:reviewer` |
| **knowledge** | A reference document | `knowledge:api-guide` |
| **vault** | Key/value environment config (keys only, never secrets) | `vault:prod-env` |
| **workflow** | Structured multi-step procedure with resumable run state | `workflow:ship-release` |
| **wiki** | A page inside a multi-wiki knowledge base | `wiki:ops/runbook` |
| **lesson** | Distilled feedback insight | `lesson:prefer-dry-run` |
| **memory** | Recalled context from a previous session | `memory:vpn-note` |
| **fact** | Durable stash-level fact (identity, conventions, stash-meta) | `fact:team/tool-stack` |

See [docs/concepts.md](docs/concepts.md) for classification rules and the ref format.

## Key workflows

**Add and search a stash**
```sh
akm add github:owner/team-stash
akm index
akm search "database migration" --type script
akm show script:migrate.sh
```

**Capture and route knowledge**
```sh
akm remember "Hot-fix deploys skip staging" --target team-stash
akm import ./incident-report.md --wiki ops
akm wiki create ops
```

**Build a living wiki (Karpathy LLM wiki pattern)**
```sh
akm wiki create research                   # scaffold wikis/research/ with schema/index/log/raw/
akm wiki stash research https://arxiv.org/abs/2404.01744  # fetch raw source into raw/
akm wiki stash research ./notes/meeting.md # stash local notes as immutable raw
akm wiki ingest research                   # dispatch defaults.engine to run the ingest workflow end-to-end
```

akm implements [Andrej Karpathy's LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern: raw sources live in `raw/` (immutable), the agent writes synthesized pages alongside them, and a `schema.md` rulebook keeps the voice and structure consistent across sessions. akm surfaces paths and invariants; your agent does the writing. See [docs/wikis.md](docs/wikis.md).

**Improvement loop**
```sh
akm feedback skill:planner --negative --reason "Doesn't account for merge conflicts"
akm improve                   # generate proposals from feedback + history
akm proposal list             # review pending proposals
akm proposal accept <uuid-or-ref>   # apply a proposal
akm proposal reject <uuid-or-ref>   # discard it
```

**Clone and customize an asset**
```sh
akm clone workflow:ship-release --dest ./project/.claude
# edit the local copy — it wins in subsequent searches automatically
```

## The improvement loop

akm tracks which assets agents actually use (`select` events) and what agents think of them (`akm feedback`). Running `akm improve` processes that signal to generate proposals — suggested edits, promotions, or deprecations. Review with `akm proposal list`, then `akm proposal accept` or `akm proposal reject`. Accepted changes write back to your writable sources. Distilled lessons surface via `akm improve --distill`.

## Tell your agent about akm

Add this to your `AGENTS.md`, `CLAUDE.md`, or system prompt:

```markdown
## Resources & Capabilities

You have access to a searchable library of scripts, skills, commands, agents,
knowledge, workflows, vaults, wikis, lessons, and memories via the `akm` CLI.
Use `akm -h` for details.
```

No plugins or SDKs required. Platform-specific integrations are available in [akm-plugins](https://github.com/itlackey/akm-plugins).

## Ecosystem

| Repo | What it is |
| --- | --- |
| [itlackey/akm-stash](https://github.com/itlackey/akm-stash) | Official stash — ready-made skills, workflows, commands, and knowledge |
| [itlackey/akm-plugins](https://github.com/itlackey/akm-plugins) | Optional editor and agent integrations (OpenCode, etc.) |
| [itlackey/akm-registry](https://github.com/itlackey/akm-registry) | Official registry index — pre-configured in every akm install |
| [itlackey/akm-bench](https://github.com/itlackey/akm-bench) | Benchmark harness for measuring agent performance with akm |
| [itlackey/akm-eval](https://github.com/itlackey/akm-eval) | Eval framework and tools for akm asset quality |

## Documentation

### Features

| Feature | Description |
| --- | --- |
| [Search & Discovery](docs/features/search-discovery.md) | Build the index, search, curate a shortlist, and load assets by ref |
| [Knowledge Management](docs/features/knowledge-management.md) | Capture memories, import docs, manage wikis, and store protected env/secret assets |
| [Sources & Registries](docs/features/sources-registries.md) | Connect local dirs, git repos, npm packages, and websites; browse the registry |
| [Workflows](docs/features/workflows.md) | Structured multi-step procedures with resumable run state |
| [The Improvement Loop](docs/features/improvement-loop.md) | Feedback, history, proposals, and automated asset improvement |
| [Agent Integration](docs/features/agent-integration.md) | Wire akm into Claude Code, OpenCode, Cursor, and other coding assistants |

### Reference docs

| Doc | Description |
| --- | --- |
| [Getting Started](docs/getting-started.md) | Install, first-time setup, add sources, search, show |
| [Concepts](docs/concepts.md) | Sources, registries, asset types, refs, and the stash |
| [CLI Reference](docs/cli.md) | All commands and flags |
| [Configuration](docs/configuration.md) | Settings, providers, embedding, and Ollama setup |
| [Stash Maker's Guide](docs/stash-makers.md) | Build, publish, and share your own stashes |
| [Registry](docs/registry.md) | Registries, the index format, and private registry setup |
| [Wikis](docs/wikis.md) | Multi-wiki knowledge bases |
| [Release Notes — 0.8.0](docs/migration/release-notes/0.8.0.md) | Latest release notes and migration guide |
| [Stability policy](STABILITY.md) | Which CLI surfaces are stable, evolving, or experimental |
| [Security policy](SECURITY.md) | Threat model and how to report vulnerabilities |
| [Changelog](CHANGELOG.md) | Per-release behavior changes |

## Privacy & data

AKM stores data locally and has **no remote telemetry**. Events, proposals, and improve history are written to `~/.local/share/akm/state.db`. Registry packages and config backups go to `~/.cache/akm/`. Nothing leaves your machine except requests to sources you explicitly configure (GitHub, npm, your own LLM endpoint).

Running on a network filesystem (NFS/SMB), where SQLite's WAL mode is unsupported? Set `AKM_SQLITE_JOURNAL_MODE` (`WAL` default, or `DELETE` / `TRUNCATE`) to pick the journal mode applied at every db open. At the `WAL` default AKM auto-detects a network mount and falls back to `DELETE`. See [docs/configuration.md](docs/configuration.md) for details.

See [docs/data-and-telemetry.md](docs/data-and-telemetry.md) for the complete on-disk inventory, event type reference, and instructions for inspecting or clearing local data.

## License

[MPL-2.0](LICENSE)
