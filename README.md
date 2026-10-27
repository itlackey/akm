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
Feedback re-ranks assets right away. A negative report can carry an exact text fix, and `akm improve` repairs metadata. Edits land as diffable proposals: the default improve strategy accepts the ones its quality judge passed, the rest wait for you to accept or reject, and any accept can be reverted. Only writable bundles are changed.

### Turn knowledge into repeatable work
Run persisted workflows with dispatch, gates, retries, budgets, and resume instead of reconstructing a process from prose every session. Workflows are Experimental.

Search and show only return content; running a workflow, task, script, or agent is a separate command. See the invariants in [Architecture](docs/architecture/architecture.md#invariants).

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

Local semantic search runs its embedding model on ONNX Runtime and is offered on Linux x64 (glibc) and Apple-silicon macOS; every other platform uses keyword search or an embedding endpoint. Choosing it in `akm setup` (`--embedding local`) downloads the runtime (about 86 MB) and the model (about 127 MB) once into akm's cache; nothing native is installed with the package or carried in a standalone binary. [Getting Started](https://akm.fwdslsh.dev/docs/guides/getting-started/#local-semantic-search) has the details.

With a connection and no harness, agent work runs on akm's own runtime, a pinned OpenCode 2 binary. The first time it runs, akm downloads that binary from the npm registry (about 114 MB, once) into its cache; on Alpine/musl it needs `libstdc++` and `libgcc` (the Alpine Node image has them). See [Getting Started](https://akm.fwdslsh.dev/docs/guides/getting-started/#akms-own-agent-runtime).

## First useful result

```sh
akm setup --yes                          # guided first-time setup, non-interactive
akm bundle add github:itlackey/akm-stash # install the official onboarding capability bundle
akm index                                # build the search index
akm curate "deploy a Bun app"            # get a curated shortlist
akm show <ref>                           # load a match by the ref curate printed
```

Each step, with its success check, is in [Getting Started](https://akm.fwdslsh.dev/docs/guides/getting-started/). Then tell your agent AKM exists:

```sh
akm hints --detail brief >> AGENTS.md
```

## Works with what you already have

AKM recognizes several existing directory layouts in place, each through its own adapter, alongside its own native bundle format:

| Format | What AKM does |
| --- | --- |
| Native akm bundles | Full read/write — scripts, skills, workflows, agents, instructions, memories, knowledge, and more |
| Claude Code / OpenCode tool directories | Indexes `CLAUDE.md`/`AGENTS.md`, `commands/`, `agents/`, `skills/` in place, read-only |
| Standalone Agent Skills packages | Indexes `<name>/SKILL.md` collections in place, read-only |
| Workflow and task files | Indexes standalone `.md` workflows and task source v4 `.yml` files |
| OKF and LLM wikis | Indexes plain-markdown (OKF) and Karpathy-style wiki (`schema.md` + `raw/` + `pages/`) content, read-only |
| Git, npm, local dirs, and websites | Any of these can be added as a source; AKM detects the bundle format inside and indexes it (a website is crawled into a local snapshot) |

See [Supported Formats](https://akm.fwdslsh.dev/docs/reference/supported-formats/) for current write support and detection rules, and [Wikis](https://akm.fwdslsh.dev/docs/guides/wikis/) for using a living LLM wiki as a bundle.

## Common next steps

- Connect local dirs, git repos, npm packages, and websites — [Bundles](https://akm.fwdslsh.dev/docs/guides/bundles/)
- Capture memories, import docs, and manage wikis — [Capture Knowledge](https://akm.fwdslsh.dev/docs/guides/capture-knowledge/)
- Turn feedback and usage into reviewable proposals — [Improve the Library](https://akm.fwdslsh.dev/docs/guides/improve-the-library/)
- Run resumable, multi-step procedures — [Workflows](https://akm.fwdslsh.dev/docs/reference/workflows/)
- Author strict scheduled automation — [Tasks](https://akm.fwdslsh.dev/docs/reference/tasks/)
- Upgrading from 0.9 — [0.9 to 0.10 migration guide](https://akm.fwdslsh.dev/docs/migration/v0.9-to-v0.10/)
- Wire akm into Claude Code, OpenCode, Cursor, and other assistants — [Use AKM With Any Agent](https://akm.fwdslsh.dev/docs/guides/use-with-any-agent/)

Scheduling background tasks (like `akm improve`) involves reviewing and activating OS scheduler entries — see [Scheduling](https://akm.fwdslsh.dev/docs/guides/scheduling/) for the full walkthrough.

## Local-first and privacy

AKM is local-first: it stores its index and state on disk and has no telemetry. It makes network requests only to the endpoints you configure or the commands you run: Git, npm, website sources, registries, your own model endpoints, the Hugging Face Hub when it downloads a local embedding model, and GitHub when you run `akm upgrade` or `akm health`. See [Data & Telemetry](https://akm.fwdslsh.dev/docs/reference/data-and-telemetry/) for the complete list of destinations and the on-disk inventory.

## Documentation and project status

The full documentation is published at **[akm.fwdslsh.dev](https://akm.fwdslsh.dev/)**, built from [`docs/`](docs/) on every push and daily.

| Doc | Description |
| --- | --- |
| [Documentation index](https://akm.fwdslsh.dev/docs/README/) | Full guide and reference index |
| [Product surface](https://akm.fwdslsh.dev/docs/product-surface/) | Every feature and its status |
| [Stability policy](STABILITY.md) | Which CLI surfaces are stable, evolving, or experimental |
| [Security policy](SECURITY.md) | Supported versions and how to report a vulnerability |
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
