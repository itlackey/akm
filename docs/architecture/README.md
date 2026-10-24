# Architecture Index

How akm is built.

## Overview

- [Architecture](architecture.md) -- How bundles, sources, refs, the index, search and show, writes, registries, and the execution boundary fit together
- [Core Principles](akm-core-principles.md) -- Eleven design principles and the precedence rule for when they collide
- [Adapters](adapters.md) -- The `BundleAdapter` contract: how a bundle's files are recognized, indexed, linted, and written
- [The Workflow Engine](workflow-engine.md) -- How a workflow compiles to a frozen plan, persists run and unit state, dispatches work, and resumes without replaying completed steps
- [The Improvement Loop](improvement.md) -- How feedback becomes ranking changes and reviewable proposals, and which writes happen without review
- [Persisted-Data Compatibility](persisted-data-compat.md) -- What a reader owes data an earlier release wrote, per persisted format

## Specs

- [Ref Format](specs/ref.md) -- The `[bundle//]conceptId[#fragment]` ref grammar
- [OKF Format Support](specs/okf-support.md) -- What the built-in `okf` adapter reads, and how OKF relates to AKM Markdown

## Internals

- [Storage Locations](internals/storage-locations.md) -- Where akm reads and writes on disk
- [Indexing](internals/indexing.md) -- How the search index is built
- [Classification](internals/classification.md) -- How adapters recognize files and pick renderers
- [Improve Workflow](internals/improve-workflow.md) -- `akm improve` command surface and per-step pipeline reference
- [Health Advisories](internals/health-advisories.md) -- The `akm health` checks and what to do about each
- [Fresh-Host Rebuild Runbook](internals/fresh-host-rebuild-runbook.md) -- Rebuild an akm install on a new machine

## Testing

- [Testing Workflow](testing/testing-workflow.md) -- Test layers, isolation rules, Docker and upgrade validation
