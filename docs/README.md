# Documentation

## Getting Started

- [Concepts](concepts.md) -- Stashes, registries, asset types, and refs
- [Getting Started](getting-started.md) -- Quick setup guide
- [Local Development](local-development.md) -- Dogfooding akm while editing its own source
- [Agent Install Guide](agents/agent-install.md) -- Step-by-step automated install for agents
- [Stash Maker's Guide](stash-makers.md) -- Build and share a stash on GitHub, npm, or a network directory
- [Wikis](wikis.md) -- Multi-wiki knowledge bases (Karpathy-style)

## Configuration & Data

- [Configuration](configuration.md) -- Providers, settings, and Ollama setup
- [Configuring Agent Profiles](configuration-agent-profiles.md) -- How akm runs a coding agent, CLI or API
- [Data & Telemetry](data-and-telemetry.md) -- Exactly what akm reads and writes on your machine (no remote telemetry)

## Features

- [Workflows](features/workflows.md) -- Structured, resumable multi-step procedures
- [Search & Discovery](features/search-discovery.md) -- Finding assets without knowing their exact name
- [Knowledge Management](features/knowledge-management.md) -- Lessons, incidents, and research as first-class assets
- [Sources & Registries](features/sources-registries.md) -- Where assets come from and how to find more
- [Wiki Snapshot Fetchers](features/wiki-snapshot-fetchers.md) -- Pluggable fetchers for URL-based knowledge reads
- [Agent Integration](features/agent-integration.md) -- Wiring akm into any shell-capable coding agent
- [The Improvement Loop](features/improvement-loop.md) -- How the stash adapts from usage and feedback

## Upgrading

- [Roadmap](roadmap.md) -- High-level focus for the 0.9 and 1.0 releases
- [v1 migration guide](migration/v1.md) -- The path from 0.x to v1.0
- [v0.8 -> v0.9 migration guide](migration/v0.8-to-v0.9.md) -- Current-cycle breaking changes
- [Release notes (latest: 0.9.0)](migration/release-notes/0.9.0.md) -- Per-release notes; see the [release-notes index](migration/release-notes/README.md) for every version
- [v0.5 -> v0.6 migration guide](migration/v0.5-to-v0.6.md) -- Every breaking change with before/after code, publisher checklist, and troubleshooting

## Reference

- [CLI](cli.md) -- All `akm` commands and flags
- [Registry](registry.md) -- Registries, search, hosting, and managing sources
- [akm-eval](akm-eval.md) -- Standalone toolkit for measuring whether `akm improve` is working

## Agents

- [AGENTS.md](agents/AGENTS.md) -- The system-prompt reference agents load to use akm
- [Curate Workmap](agents/curate-workmap.md) -- Read before changing `akm curate` ranking or output

## Architecture

- [Architecture](technical/architecture.md) -- How akm's sources, cache, index, and registries fit together
- [Runtime Boundary Design](architecture/runtime-boundary-design.md) -- Isolating `bun:sqlite`/`Bun.*` from the core
- [Brain Workflow (diagram)](architecture/brain-workflow.html) -- Visual map of the improve/self-learning loop

## Example Stash

- [Example Stash](example-stash/README.md) -- A documentation-backed example stash showing how asset types fit together

## Analysis

- [Indexer Vertical Slice Refactor Plan](analysis/indexer-vertical-slice-refactor-plan.md)
- [Indexer Refactor Review (Expert Options)](analysis/indexer-refactor-expert-options.md)

## Design (unshipped work)

- [Self-Improvement, Self-Learning & Memory Reference Index](design/self-improvement-learning-memory-reference-index.md) -- Master index for every unshipped improve/self-learning/memory design doc, with a subsystem-to-doc status table

Every doc under `docs/design/` must carry a `Status` / `Supersedes` / `Date` header (pre-existing docs are grandfathered until next touched). When a design ships, the shipping PR moves it to `docs/archive/` in the same PR.

## Archive

- [Archive](archive/README.md) -- Design and implementation plans whose work has already shipped, retained as ADR-style records

## Internals (technical/)

- [Filesystem](technical/filesystem.md) -- Directory layout plus `.stash.json` deprecation and migration notes
- [Search](technical/search.md) -- Hybrid search architecture and scoring
- [Indexing](technical/indexing.md) -- How the search index is built
- [Classification](technical/classification.md) -- Matcher and renderer behavior
- [Storage Locations](technical/storage-locations.md) -- Authoritative inventory of every on-disk read/write path
- [Improve Workflow](technical/improve-workflow.md) -- `akm improve` command surface and pipeline reference
- [Health Advisories](technical/health-advisories.md) -- `akm health` advisory-to-action map for operators
- [Fresh-Host Rebuild Runbook](technical/fresh-host-rebuild-runbook.md) -- Rebuild an akm install on a new machine
- [Ranking Ablation & Saturation Analysis](technical/ranking-ablation-and-saturation-analysis.md) -- Reproducible contributor-ablation measurement and the score-saturation trap
- [Functional Contract Patterns](technical/functional-contract-patterns.md) -- Quick reference for contributor pipelines and small process contracts
- [Test Coverage Guide](technical/test-coverage-guide.md) -- High-value testing areas
- [Testing Workflow](technical/testing-workflow.md) -- End-to-end, Docker, deployment, and upgrade validation
- [Ref Format](technical/ref.md) -- Wire format for asset references
- [Core Principles](technical/akm-core-principles.md) -- Design principles and constraints
- [Claude Code workflows vs. akm workflows](technical/claude-code-vs-akm-workflows.md) -- Comparing the two things that share a name
- [Extending akm workflows into a harness-agnostic orchestration engine](technical/akm-workflows-orchestration-plan.md) -- Current formalized plan, supersedes part of the doc above

## Official Ecosystem Repositories

- [itlackey/akm-stash](https://github.com/itlackey/akm-stash) -- the official onboarding stash with ready-made assets you can install with `akm add`
- [itlackey/akm-registry](https://github.com/itlackey/akm-registry) -- the official registry index that powers built-in discovery
- [itlackey/akm-plugins](https://github.com/itlackey/akm-plugins) -- optional integrations for tools like OpenCode
- [itlackey/akm-bench](https://github.com/itlackey/akm-bench) -- the standalone benchmark and evaluation repo for akm

## Posts

- [Blog posts](posts/) -- Articles and posts about akm

---

New docs, in five lines: keep one current-truth doc per subsystem, don't fork a second one. Unshipped designs live in `docs/design/` with a mandatory `Status` / `Supersedes` / `Date` header. The PR that ships the design moves its doc to `docs/archive/` in that same PR. Cite code by symbol and memories by search-terms -- not line numbers or exact refs, both rot. Nothing in `docs/` may reference `.plans/` (it's scratch -- promote the content or drop the link); no new improve-analysis docs until the 30-clean-day gate.
