# Reference

Authoritative reference documentation for the akm CLI and its data.

- [Bundle Types](bundle-types.md) -- Pointer page: where the bundle-format compatibility table and adapter internals now live
- [CLI](cli.md) -- All `akm` commands and flags
- [Configuration](configuration.md) -- Engines, strategies, bundles, and settings
- [Supported Formats](supported-formats.md) -- Formats akm can index, from its own bundle layout to other tools' existing asset directories
- [Tasks](tasks.md) -- Task source v4 grammar, executable targets, scheduling, migration, and scheduler operations
- [Workflow Schema](workflow-schema.md) -- Authoritative reference for a workflow asset's exact frontmatter and body syntax
- [Workflows](workflows.md) -- Map of the workflow documentation: running, authoring, the schema, and the engine
- [Memory](https://github.com/itlackey/akm/blob/main/docs/reference/memory.md) -- The `memory` asset type: capture, belief states, and derived memories
- [Refs](https://github.com/itlackey/akm/blob/main/docs/reference/refs.md) -- The ref grammar `akm search` emits and `akm show` consumes, rename semantics, and namespacing
- [Asset Types](https://github.com/itlackey/akm/blob/main/docs/reference/asset-types.md) -- The capability taxonomy the native `akm` adapter recognizes, bundle layout, and asset metadata
- [Environment & Secrets](https://github.com/itlackey/akm/blob/main/docs/reference/env-and-secrets.md) -- `akm env` and `akm secret`, the two protected-value asset types
- [Registry](https://github.com/itlackey/akm/blob/main/docs/reference/registry.md) -- Registries, search, hosting, and managing sources
- [Website Sources](https://github.com/itlackey/akm/blob/main/docs/reference/website-sources.md) -- The pluggable fetcher API behind `akm import <url>` and other URL-based knowledge reads
- [Data & Telemetry](data-and-telemetry.md) -- Exactly what akm reads and writes on your machine (no remote telemetry)

See also: [akm-eval](https://github.com/itlackey/akm-eval) -- the evals and benchmarks for measuring whether `akm improve` is working, and the repo-root [Roadmap](https://github.com/itlackey/akm/blob/main/ROADMAP.md) -- high-level focus for upcoming releases.
