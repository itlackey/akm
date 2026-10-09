# Documentation

AKM is a portable capability library for AI agents: one library for every
agent. This hub is organized by what you're trying to do, not by directory —
start here, then follow links out to the guides, reference, and architecture
pages as you need more depth. Each subdirectory also has its own README
indexing everything inside it.

Full per-directory indexes: [Guides](guides/README.md),
[Reference](reference/README.md), [Agents](agents/README.md),
[Architecture](architecture/README.md), [Maintainers](maintainers/README.md),
[Migration](migration/README.md), [Posts](posts/README.md).

## Start

- [Product Surface](product-surface.md) -- Every feature and its status
- [Getting Started](guides/getting-started.md) -- Install akm, connect a source, and pull a curated shortlist in five to seven minutes
- [Concepts](guides/concepts.md) -- Capabilities, bundles, adapters, asset types, and refs -- the mental model in one page
- [Agent Install Guide](agents/agent-install.md) -- Step-by-step automated (non-interactive) install for agents
- `akm help agents` (short guide by default; `akm help agents --full` for the complete guide) -- The CLI reference agents load to use akm; always the embedded corpus at `src/assets/hints/cli-hints-{full,short}.md`

## Use

One library for every agent: connect what you already have, load only what
the task needs, and capture what you learn along the way.

- [Use AKM With Any Agent](guides/use-with-any-agent.md) -- Wire akm into Claude Code, OpenCode, Cursor, and other coding assistants with a three-line system prompt block
- [Discover and Load](guides/discover-and-load.md) -- Search, curate a shortlist, and load exactly the ref a task needs
- [Bundles](guides/bundles.md) -- Connect local dirs, git repos, npm packages, and websites; browse the registry
- [Capture Knowledge](guides/capture-knowledge.md) -- `akm remember`, `akm import`, and how captured material becomes available to every agent
- [Wikis](guides/wikis.md) -- Multi-wiki knowledge bases (Karpathy-style)
- [Environment & Secrets](reference/env-and-secrets.md) -- `akm env` and `akm secret`: exact operations, file modes, and the security guarantee
- [Run Workflows](guides/run-workflows.md) -- Start or continue a run, check on it, resume it, or abandon it
- [Scheduling](guides/scheduling.md) -- Run akm tasks through the OS scheduler (cron / launchd / schtasks) safely
- [Migrate to 0.9.2](migration/v0.9.1-to-v0.9.2.md) -- Convert task-v2 sources safely and understand workflow resume compatibility
- [Improve the Library](guides/improve-the-library.md) -- Feedback, history, and proposals -- how evidence turns into reviewable changes
- Recipes: [Turn a Website into a Searchable Bundle](guides/recipes/website-source.md), [Headless Install](guides/recipes/headless-install.md)

## Build and operate

Package complete capabilities and turn knowledge into repeatable work.

- [Bundle Author's Guide](guides/author-bundles.md) -- Build a bundle, make it discoverable, and share it so others can install it with `akm bundle add`
- [Author's Guide: Writing Workflows](guides/author-workflows.md) -- Write and test a workflow definition, from a minimal example to gates and outputs
- [Claude Code workflows vs. akm workflows](guides/claude-code-vs-akm-workflows.md) -- Short decision guide for choosing between a session-native workflow and an akm workflow ([full technical comparison](architecture/comparisons/claude-code-vs-akm-workflows-full.md))
- [Bundling akm](integration/bundling-akm.md) -- Ship akm inside your own product: the pin/migrate/health boot contract, plan JSON shapes, and exit codes for bundlers

### Maintainers

Working on akm itself, not just using it.

- [Maintainer Docs](maintainers/README.md) -- Start here: local development, measuring improvement, and the curate contract
- [Local Development](maintainers/local-development.md) -- Dogfooding akm while editing its own source
- [Curate Workmap](maintainers/curate-workmap.md) -- The current `akm curate` contract and the highest-value next fixes

## Look up details

- [CLI](reference/cli.md) -- All `akm` commands and flags
- [Configuration](reference/configuration.md) -- Engines, strategies, bundles, and settings
- [Supported Formats](reference/supported-formats.md) -- Every bundle format akm recognizes, its detection marker, and current read/write support
- [Tasks](reference/tasks.md) -- Task-v3 files, targets, triggers, and fail-closed migration
- [Asset Types](reference/asset-types.md) -- The capability taxonomy, directory conventions, and per-type examples
- [Refs](reference/refs.md) -- The ref grammar `akm search` emits and `akm show` consumes
- [Memory](reference/memory.md) -- The `memory` asset type: capture, belief states, and derived memories
- [Workflow Schema](reference/workflow-schema.md) -- Authoritative frontmatter/body syntax for a workflow asset
- [Workflows (overview)](reference/workflows.md) -- Short map across the workflow schema, engine, and how-to guides
- [Registry](reference/registry.md) -- Registries, search, hosting, and managing sources
- [Website Sources](reference/website-sources.md) -- The pluggable fetcher API for URL-based knowledge reads
- [Data & Telemetry](reference/data-and-telemetry.md) -- Exactly what akm reads and writes on your machine (no remote telemetry)
- [Architecture Overview](architecture/architecture.md) -- How akm's bundles, cache, index, and registries fit together
- [Core Principles](architecture/akm-core-principles.md) -- Design principles and constraints
- [Adapters](architecture/adapters.md) -- How akm picks an adapter, indexes, validates, and writes into a bundle
- [The Workflow Engine](architecture/workflow-engine.md) -- How a frozen plan is stored, dispatched, and resumed without replaying completed units
- [The Improvement Loop](architecture/improvement.md) -- How a feedback signal becomes a ranking change, and how evidence becomes a proposal
- [Runtime Boundary Design](architecture/runtime-boundary-design.md) -- Isolating `bun:sqlite`/`Bun.*` from the core
- [Architecture Decision History](architecture/akm-architecture-decision-history.md) -- ADR-style record of the major architecture rulings
- [Specs](architecture/README.md#specs-specs) -- Normative specifications (bundle/adapter model, ref grammar, bundle conventions)
- [Internals](architecture/README.md#internals-internals) -- Current-truth subsystem references (storage, search, indexing, improve, health)
- [Testing](architecture/README.md#testing-testing) -- Testing workflow and pre-release checklist
- [Migration](migration/README.md) -- Upgrade guides and per-release migration notes
- [Roadmap](https://github.com/itlackey/akm/blob/main/ROADMAP.md) -- High-level focus for the releases from here through 1.0

## Execution boundary

AKM retrieves every supported capability type. It directly orchestrates
defined execution surfaces such as workflows, agent dispatch, tasks, and
guarded subprocess injection. It does not blindly execute arbitrary indexed
content merely because that content appears in search results. See
[Core Principles](architecture/akm-core-principles.md) for the full boundary,
and [The Improvement Loop](architecture/improvement.md) for how that boundary
applies to akm's own self-generated changes.

## Posts

Source articles for the dev.to publishing pipeline (historical record). See
[posts index](posts/README.md).

## Official Ecosystem Repositories

- [itlackey/akm-stash](https://github.com/itlackey/akm-stash) -- the official onboarding bundle with ready-made assets you can install with `akm bundle add`
- [itlackey/akm-registry](https://github.com/itlackey/akm-registry) -- the official registry index that powers built-in discovery
- [itlackey/akm-plugins](https://github.com/itlackey/akm-plugins) -- optional integrations for tools like OpenCode
- [itlackey/akm-bench](https://github.com/itlackey/akm-bench) -- the standalone benchmark harness for measuring agent performance with akm
- [itlackey/akm-eval](https://github.com/itlackey/akm-eval) -- the eval framework and tools for akm asset quality

---

New docs, in five lines: keep one current-truth doc per subsystem, don't fork a
second one. Planning, review, and analysis material lives in the untracked
`.plans/` directory, never under `docs/` -- promote conclusions into the
current-truth doc or drop them. Normative specs live in
`docs/architecture/specs/`. Cite code by symbol and memories by search-terms --
not line numbers or exact refs, both rot. Nothing in `docs/` may reference
`.plans/`.
