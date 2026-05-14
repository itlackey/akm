# akm — Agent Kit Manager

[![npm version](https://img.shields.io/npm/v/akm-cli)](https://www.npmjs.com/package/akm-cli)
[![CI](https://github.com/itlackey/akm/actions/workflows/ci.yml/badge.svg)](https://github.com/itlackey/akm/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/akm-cli)](LICENSE)

**A package manager for AI agent capabilities** — scripts, skills, commands, agents, knowledge, workflows, vaults, wikis, and memories — that works with any AI coding assistant that can run shell commands.

akm gives agents a curated, searchable library built from local directories, GitHub repos, npm packages, and websites. Instead of front-loading a giant prompt, agents pull exactly what they need, when they need it, and feed results back so the library improves over time.

## Install

```sh
# Standalone binary
curl -fsSL https://raw.githubusercontent.com/itlackey/akm/main/install.sh | bash

# Or via npm / pnpm / bun
npm install -g akm-cli
pnpm add -g akm-cli
bun install -g akm-cli
```

Upgrade in place: `akm upgrade`

## What akm does

- **Manage sources** — add local dirs, git repos, npm packages, and websites as searchable asset sources
  ```sh
  akm add github:owner/stash        # GitHub
  akm add https://docs.example.com  # crawled website
  ```
- **Search a unified index** — one FTS5 index across all your sources
  ```sh
  akm search "deploy" --type script --limit 5
  ```
- **Curate a shortlist** — get the best-match assets for a task without knowing exact names
  ```sh
  akm curate "set up a kubernetes deployment"
  ```
- **Load assets on demand** — show the full content of any asset by ref
  ```sh
  akm show workflow:ship-release
  ```
- **Capture local knowledge** — save discoveries as memories, imported docs, or wiki pages
  ```sh
  akm remember "Staging deploys require VPN"
  akm import ./notes/runbook.md --wiki ops
  ```
- **Run structured workflows** — parse, start, step through, and resume multi-step procedures
  ```sh
  akm workflow start workflow:onboarding
  ```
- **Improve continuously** — feedback drives proposals; proposals drive asset quality
  ```sh
  akm feedback skill:code-review --positive
  akm improve && akm proposals
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

**Improvement loop**
```sh
akm feedback skill:planner --negative --note "Doesn't account for merge conflicts"
akm improve                   # generate proposals from feedback + history
akm proposals                 # review pending proposals
akm accept <uuid-or-ref>      # apply a proposal
akm reject <uuid-or-ref>      # discard it
```

**Clone and customize an asset**
```sh
akm clone workflow:ship-release --dest ./project/.claude
# edit the local copy — it wins in subsequent searches automatically
```

## The improvement loop

akm tracks which assets agents actually use (`select` events) and what agents think of them (`akm feedback`). Running `akm improve` processes that signal to generate proposals — suggested edits, promotions, or deprecations. Review with `akm proposals`, then `akm accept` or `akm reject`. Accepted changes write back to your writable sources. Distilled lessons surface via `akm improve --distill`.

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

## License

[MPL-2.0](LICENSE)
