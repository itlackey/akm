# Documentation

## Getting Started

- [Concepts](concepts.md) -- Stashes, registries, asset types, and refs
- [Getting Started](getting-started.md) -- Quick setup guide
- [Agent Install Guide](agents/agent-install.md) -- Step-by-step automated install for agents
- [Stash Maker's Guide](stash-makers.md) -- Build and share a stash on GitHub, npm, or a network directory
- [Wikis](wikis.md) -- Multi-wiki knowledge bases (Karpathy-style)

## Upgrading

- [v1 migration guide](migration/v1.md) -- The path from 0.x to v1.0, including the `.stash.json` removal scheduled for v0.8.0
- [Release notes (latest: 0.7.0)](migration/release-notes/0.7.0.md) -- Per-release notes drop into `migration/release-notes/`, including current pre-release removals
- [v0.5 → v0.6 migration guide](migration/v0.5-to-v0.6.md) -- Every breaking change with before/after code, publisher checklist, and troubleshooting

## Reference

- [CLI](cli.md) -- All `akm` commands and flags
- [Registry](registry.md) -- Registries, search, hosting, and managing sources
- [Configuration](configuration.md) -- Providers, settings, and Ollama setup
- [Filesystem](technical/filesystem.md) -- Directory layout plus `.stash.json` deprecation and migration notes

## Official Ecosystem Repositories

- [itlackey/akm-stash](https://github.com/itlackey/akm-stash) -- the official onboarding stash with ready-made assets you can install with `akm add`
- [itlackey/akm-registry](https://github.com/itlackey/akm-registry) -- the official registry index that powers built-in discovery
- [itlackey/akm-plugins](https://github.com/itlackey/akm-plugins) -- optional integrations for tools like OpenCode
- [itlackey/akm-bench](https://github.com/itlackey/akm-bench) -- the standalone benchmark and evaluation repo for akm

## Internals

- [Search](technical/search.md) -- Hybrid search architecture and scoring
- [Indexing](technical/indexing.md) -- How the search index is built
- [Classification](technical/classification.md) -- Matcher and renderer behavior
- [Show Response](technical/show-response.md) -- `akm show` output fields by asset type
- [Testing Workflow](technical/testing-workflow.md) -- End-to-end, Docker, deployment, and upgrade validation
- [Ref Format](technical/ref.md) -- Wire format for asset references
- [Test Coverage Guide](technical/test-coverage-guide.md) -- High-value testing areas
- [Core Principles](technical/akm-core-principles.md) -- Design principles and constraints
- [akm-bench](technical/benchmark.md) -- Search-quality benchmark suite

## Posts

- [Blog posts](posts/) -- Articles and posts about akm
