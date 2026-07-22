# Documentation

Each subdirectory has its own README indexing everything inside it.

## [Guides](guides/README.md)

Task-oriented guides for using akm.

- [Getting Started](guides/getting-started.md) -- Quick setup guide
- [Concepts](guides/concepts.md) -- Bundles, adapters, asset types, and refs
- [Stash Maker's Guide](guides/stash-makers.md) -- Build and share a stash on GitHub, npm, or a network directory
- [Wikis](guides/wikis.md) -- Multi-wiki knowledge bases (Karpathy-style)
- [Local Development](guides/local-development.md) -- Dogfooding akm while editing its own source
- [Claude Code workflows vs. akm workflows](guides/claude-code-vs-akm-workflows.md) -- Comparing the two things that share a name
- Command tours: [search & discovery](guides/search-discovery.md), [sources & registries](guides/sources-registries.md), [knowledge management](guides/knowledge-management.md), [the improvement loop](guides/improvement-loop.md), [agent integration](guides/agent-integration.md)

## [Reference](reference/README.md)

- [CLI](reference/cli.md) -- All `akm` commands and flags
- [Configuration](reference/configuration.md) -- Engines, strategies, bundles, and settings
- [Workflows](reference/workflows.md) -- Workflow source formats, run state, and the YAML orchestration engine
- [Wiki Snapshot Fetchers](reference/wiki-snapshot-fetchers.md) -- The pluggable fetcher API for URL-based knowledge reads
- [Registry](reference/registry.md) -- Registries, search, hosting, and managing sources
- [Data & Telemetry](reference/data-and-telemetry.md) -- Exactly what akm reads and writes on your machine (no remote telemetry)
- [akm-eval](reference/akm-eval.md) -- Standalone toolkit for measuring whether `akm improve` is working
- [Roadmap](reference/roadmap.md) -- High-level focus for the 0.9 and 1.0 releases

## [Agents](agents/README.md)

- [AGENTS.md](agents/AGENTS.md) -- The system-prompt reference agents load to use akm
- [Agent Install Guide](agents/agent-install.md) -- Step-by-step automated install for agents
- [Curate Workmap](agents/curate-workmap.md) -- Read before changing `akm curate` ranking or output

## [Architecture](architecture/README.md)

System overview, normative specs, decision history, and subsystem internals.

- [Architecture](architecture/architecture.md) -- How akm's bundles, cache, index, and registries fit together
- [Core Principles](architecture/akm-core-principles.md) -- Design principles and constraints
- [Specs](architecture/README.md#specs-specs) -- Normative specifications (bundle/adapter model, ref grammar, stash conventions)
- [Internals](architecture/README.md#internals-internals) -- Current-truth subsystem references (storage, search, indexing, improve, health)
- [Testing](architecture/README.md#testing-testing) -- Testing workflow and pre-release checklist

## [Migration](migration/README.md)

- [v0.8 -> v0.9 migration guide](migration/v0.8-to-v0.9.md) -- Current-cycle breaking changes
- [Release notes](migration/release-notes/) -- The short per-release notes `akm help migrate <version>` prints

## [Posts](posts/README.md)

Source articles for the dev.to publishing pipeline (historical record).

## Official Ecosystem Repositories

- [itlackey/akm-stash](https://github.com/itlackey/akm-stash) -- the official onboarding stash with ready-made assets you can install with `akm add`
- [itlackey/akm-registry](https://github.com/itlackey/akm-registry) -- the official registry index that powers built-in discovery
- [itlackey/akm-plugins](https://github.com/itlackey/akm-plugins) -- optional integrations for tools like OpenCode
- [itlackey/akm-bench](https://github.com/itlackey/akm-bench) -- the standalone benchmark and evaluation repo for akm

---

New docs, in five lines: keep one current-truth doc per subsystem, don't fork a
second one. Planning, review, and analysis material lives in the untracked
`.plans/` directory, never under `docs/` -- promote conclusions into the
current-truth doc or drop them. Normative specs live in
`docs/architecture/specs/`. Cite code by symbol and memories by search-terms --
not line numbers or exact refs, both rot. Nothing in `docs/` may reference
`.plans/`.
