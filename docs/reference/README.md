# Reference

Reference documentation for the akm CLI, configuration and data. Run
`akm <command> --help` for the flags of any command.

## Commands and configuration

- [CLI](cli.md) -- Every command in a short per-command page, the global flags, the output envelope and the exit codes
- [Configuration](configuration.md) -- `config.json`: engines, improve strategies, bundles, registries, output defaults and environment variables
- [Data and telemetry](data-and-telemetry.md) -- What akm stores and where, and what it sends over the network

## Assets and bundles

- [Asset types](asset-types.md) -- The asset types the native `akm` layout recognizes and how files map to them
- [Refs](refs.md) -- The `[bundle//]conceptId[#fragment]` grammar, namespacing and renames
- [Memory](memory.md) -- The `memory` asset type: capture, belief states and derived memories
- [Environment and secrets](env-and-secrets.md) -- `akm env` and `akm secret`: what they print and how values reach a process
- [Supported formats](supported-formats.md) -- The 11 bundle formats akm indexes in place, with their detection markers
- [Bundle types](bundle-types.md) -- Pointer to the supported-formats table and the adapter internals

## Sources and registries

- [Registry](registry.md) -- Registries: searching, enabling skills.sh, installing bundles and hosting an index
- [Website sources](website-sources.md) -- Crawl options and the fetcher modules behind `akm import <url>` and website bundles

## Automation

- [Tasks](tasks.md) -- Task source v4, targets, scheduling and scheduler operations
- [Workflows](workflows.md) -- Map of the workflow documentation
- [Workflow schema](workflow-schema.md) -- A workflow asset's frontmatter and body syntax
