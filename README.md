# akm — Agent Knowledge Manager

[![npm version](https://img.shields.io/npm/v/akm-cli)](https://www.npmjs.com/package/akm-cli)
[![CI](https://github.com/itlackey/akm/actions/workflows/ci.yml/badge.svg)](https://github.com/itlackey/akm/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/akm-cli)](LICENSE)

**Give every coding agent the capabilities your team has already built.**

Build your agent library once. Use it from any shell-capable coding agent.

## Why AKM exists

Every coding agent wants its own copy of your team's knowledge — an `AGENTS.md` here, a tool-specific skills folder there, prompts scattered across repos and chat logs. AKM indexes existing agent assets in place, loads only what a task needs, packages capabilities into shareable bundles, improves the library through reviewable proposals, and runs durable workflows — locally and without tying the library to one assistant. The core loop is `connect -> index -> curate -> show -> use/run -> feedback -> proposal` (not every task uses every stage).

## Five reasons to use it

### One library for every agent
Use the same capability library from Claude Code, OpenCode, Cursor, Aider, Windsurf, or any assistant that can run shell commands.

### Load only what the task needs
Search or curate a shortlist, then load full content by ref. No giant startup prompt is required.

### Package complete capabilities
Install and share bundles containing skills, scripts, workflows, agents, instructions, memories, and knowledge — not just prompt snippets.

### Improve through evidence, with review
Feedback influences retrieval and produces diffable proposals. Changes remain reviewable and target only writable bundles.

### Turn knowledge into repeatable work
Run persisted workflows with dispatch, gates, retries, budgets, and resume instead of reconstructing a process from prose every session.

AKM retrieves every supported capability type. It directly orchestrates defined execution surfaces such as workflows, agent dispatch, tasks, and guarded subprocess injection. It does not blindly execute arbitrary indexed content merely because that content appears in search results.

## Install

**Option 1 — npm package (recommended; requires [Node.js](https://nodejs.org) >= 22):**

```sh
npm install -g akm-cli
```

**Option 2 — Prebuilt binary (no runtime required):**

```sh
# Linux / macOS
curl -fsSL https://github.com/itlackey/akm/releases/latest/download/install.sh | bash

# Windows (PowerShell)
irm https://github.com/itlackey/akm/releases/latest/download/install.ps1 | iex
```

Upgrade in place: `akm upgrade`

The npm package always uses Node.js to bootstrap its cross-platform command. If a working [Bun](https://bun.sh) >= 1.0 is also on `PATH`, the launcher prefers Bun for execution; old, unusable, or absent Bun installations fall back to Node.js. Node.js remains required for the npm package. The standalone binaries are runtime-free.

## First useful result

```sh
akm setup --yes                          # guided first-time setup, non-interactive
akm bundle add github:itlackey/akm-stash # install the official onboarding capability bundle
akm index                                # build the search index
akm curate "deploy a Bun app"            # get a curated shortlist
akm show workflows/deploy                # load the best match by ref
```

Then tell your agent AKM exists:

```sh
akm help agents >> AGENTS.md
```

## Works with what you already have

AKM recognizes several existing directory layouts in place, each through its own adapter, alongside its own native bundle format:

| Format | What AKM does |
| --- | --- |
| Native akm bundles | Full read/write — scripts, skills, workflows, agents, instructions, memories, knowledge, and more |
| Claude Code / OpenCode tool directories | Indexes `CLAUDE.md`/`AGENTS.md`, `commands/`, `agents/`, `skills/` in place, read-only |
| Standalone Agent Skills packages | Indexes `<name>/SKILL.md` collections in place, read-only |
| OKF and LLM wikis | Indexes plain-markdown (OKF) and Karpathy-style wiki (`schema.md` + `raw/` + `pages/`) content, read-only |
| Git, npm, local dirs, and websites | Any of these can be added as a source; AKM detects the bundle format inside and indexes it |

See [Supported Formats](docs/reference/supported-formats.md) for current write support and detection rules, and [Wikis](https://github.com/itlackey/akm/blob/main/docs/guides/wikis.md) for using a living LLM wiki as a bundle.

## Common next steps

- Connect local dirs, git repos, npm packages, and websites — [Bundles](https://github.com/itlackey/akm/blob/main/docs/guides/bundles.md)
- Capture memories, import docs, and manage wikis — [Capture Knowledge](https://github.com/itlackey/akm/blob/main/docs/guides/capture-knowledge.md)
- Turn feedback and usage into reviewable proposals — [Improve the Library](https://github.com/itlackey/akm/blob/main/docs/guides/improve-the-library.md)
- Run resumable, multi-step procedures — [Workflows](docs/reference/workflows.md)
- Author strict scheduled automation — [Tasks](docs/reference/tasks.md)
- Upgrading from 0.9.1 — [0.9.2 migration guide](docs/migration/v0.9.1-to-v0.9.2.md)
- Wire akm into Claude Code, OpenCode, Cursor, and other assistants — [Use AKM With Any Agent](https://github.com/itlackey/akm/blob/main/docs/guides/use-with-any-agent.md)

Scheduling background tasks (like `akm improve`) involves reviewing and activating OS scheduler entries — see [Scheduling](https://github.com/itlackey/akm/blob/main/docs/guides/scheduling.md) for the full walkthrough.

## Local-first and privacy

AKM is local-first: it stores its index and state on disk and has no remote telemetry. The network is only used for sources and endpoints you explicitly configure — Git, npm, website sources, registries, and your own model endpoints. See [Data & Telemetry](docs/reference/data-and-telemetry.md) for the complete on-disk inventory and how to inspect or clear local data.

## Documentation and project status

| Doc | Description |
| --- | --- |
| [Documentation index](docs/README.md) | Full guide and reference index |
| [Stability policy](STABILITY.md) | Which CLI surfaces are stable, evolving, or experimental |
| [Security policy](SECURITY.md) | Threat model and how to report vulnerabilities |
| [Changelog](CHANGELOG.md) | Per-release behavior changes |

## Ecosystem

| Repo | What it is |
| --- | --- |
| [itlackey/akm-stash](https://github.com/itlackey/akm-stash) | The official onboarding capability bundle — ready-made skills, workflows, commands, and knowledge |
| [itlackey/akm-plugins](https://github.com/itlackey/akm-plugins) | Optional editor and agent integrations (OpenCode, etc.) |
| [itlackey/akm-registry](https://github.com/itlackey/akm-registry) | Official registry index — pre-configured in every akm install |
| [itlackey/akm-bench](https://github.com/itlackey/akm-bench) | Benchmark harness for measuring agent performance with akm |
| [itlackey/akm-eval](https://github.com/itlackey/akm-eval) | Eval framework and tools for akm asset quality |
| [itlackey/akm-model-eval](https://github.com/itlackey/akm-model-eval) | Public deterministic benchmark for comparing models on AKM-shaped tasks |

## License

[MPL-2.0](LICENSE)
