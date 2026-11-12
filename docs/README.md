# Documentation

AKM is a portable capability library for AI agents: one library for every
agent. This hub is organized by what you're trying to do. The
[architecture index](architecture/README.md), [maintainer docs](maintainers/README.md)
and [migration guides](migration/README.md) have their own indexes.

## Start

- [Getting Started](guides/getting-started.md) -- Install akm, connect a source, and pull a curated shortlist
- [Concepts](guides/concepts.md) -- Capabilities, bundles, adapters, and refs: the mental model in one page
- [Headless Install](guides/recipes/headless-install.md) -- The no-prompts install sequence for agents and automation
- [Upgrade from 0.10 to 0.11](migration/v0.10-to-v0.11.md) -- The current upgrade path: the order to follow, the retired `AKM_BUNDLE_DIR` and the working bundle, every removed flag and command, the output and scheduler changes, and the new error codes
- [Upgrade from 0.9 to 0.10](migration/v0.9-to-v0.10.md) -- The 0.10 changes: every removed CLI spelling, config key and workflow feature with its replacement, and what a scheduled `akm improve` now does
- `akm hints` -- The CLI guide agents load (the short guide; `akm help <command>` for one command)

## Use

- [Use AKM With Any Agent](guides/use-with-any-agent.md) -- Wire akm into Claude Code, OpenCode, Cursor, and other coding assistants
- [Discover and Load](guides/discover-and-load.md) -- Search, curate a shortlist, and load exactly the ref a task needs
- [Bundles](guides/bundles.md) -- Connect local dirs, git repos, npm packages, and websites; browse the registry
- [Capture Knowledge](guides/capture-knowledge.md) -- `akm remember`, `akm import`, and how captured material becomes available to every agent
- [Wikis](guides/wikis.md) -- Multi-wiki knowledge bases (Karpathy-style)
- [Environment & Secrets](reference/env-and-secrets.md) -- `akm env` and `akm secret`: operations and file modes
- [Run Workflows](guides/run-workflows.md) -- Start or continue a run, check on it, resume it, or abandon it
- [Scheduling](guides/scheduling.md) -- Run akm tasks through the OS scheduler (cron / launchd / schtasks)
- [Improve the Library](guides/improve-the-library.md) -- Feedback, history, and proposals: how evidence turns into reviewable changes
- Recipes: [Turn a Website into a Searchable Bundle](guides/recipes/website-source.md), [Headless Install](guides/recipes/headless-install.md)

## Build and operate

- [Bundle Author's Guide](guides/author-bundles.md) -- Build a bundle, make it discoverable, and share it
- [Author's Guide: Writing Workflows](guides/author-workflows.md) -- Write and test a workflow definition, from a minimal example to gates and outputs
- [Bundling akm](integration/bundling-akm.md) -- Ship akm inside your own product: the pin/migrate/health boot contract, plan JSON shapes, and exit codes
- [Maintainer Docs](maintainers/README.md) -- Local development and the release checklist

## Look up details

- [CLI](reference/cli.md) -- All `akm` commands and flags
- [Configuration](reference/configuration.md) -- Connections, harnesses, strategies, bundles, and settings
- [Supported Formats](reference/supported-formats.md) -- Every bundle format akm recognizes, its detection marker, and current read/write support
- [Programmatic API](reference/api.md) -- `akm-cli/api`: in-process `curate()` for the akm plugins
- [Workspace](reference/workspace.md) -- The operations of `akm-cli/workspace` and the JSON they return
- [Asset Types](reference/asset-types.md) -- The capability taxonomy, directory conventions, and per-type examples
- [Refs](reference/refs.md) -- The ref grammar `akm search` emits and `akm show` consumes
- [Memory](reference/memory.md) -- The `memory` asset type: capture, belief states, and derived memories
- [Tasks](reference/tasks.md) -- Task source v4 files, targets, triggers, scheduling, and the explicit `akm migrate apply` conversion of v2 and v3 files
- [Workflow Schema](reference/workflow-schema.md) -- Frontmatter and body syntax for a workflow asset
- [Registry](reference/registry.md) -- Registries, search, hosting, and managing sources
- [Website Sources](reference/website-sources.md) -- The fetcher API for crawling and importing URLs
- [Data & Telemetry](reference/data-and-telemetry.md) -- What akm reads and writes on your machine
- [Architecture](architecture/architecture.md) -- How akm fits together, and the invariants every command keeps; [Core Principles](architecture/akm-core-principles.md) -- How the code, tests and docs in this repo are built; [the architecture index](architecture/README.md) lists the subsystem references

## Migration

- [Migration](migration/README.md) -- The 0.10 to 0.11 and 0.9 to 0.10 upgrade guides

## Official Ecosystem Repositories

- [itlackey/akm-stash](https://github.com/itlackey/akm-stash) -- the official onboarding bundle with ready-made assets you can install with `akm bundle add`
- [itlackey/akm-registry](https://github.com/itlackey/akm-registry) -- the official registry index that powers built-in discovery
- [itlackey/akm-plugins](https://github.com/itlackey/akm-plugins) -- optional integrations for tools like OpenCode
- [itlackey/akm-bench](https://github.com/itlackey/akm-bench) -- the standalone benchmark harness for measuring agent performance with akm
- [itlackey/akm-eval](https://github.com/itlackey/akm-eval) -- the eval framework and tools for akm asset quality

---

New docs, in five lines: keep one current-truth doc per subsystem, don't fork a
second one. Plans, reviews, and analysis do not live under `docs/`; promote
conclusions into the current-truth doc or drop them. Normative specs live in
`docs/architecture/specs/`. Cite code by symbol, not line number; line numbers
rot. Check every command you document with `bun run lint:doc-examples`.
