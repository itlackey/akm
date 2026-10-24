# Architecture Index

How akm is built: system overview, normative specs, and subsystem internals.

- [Architecture](architecture.md) -- How akm's bundles, cache, index, and registries fit together
- [Core Principles](akm-core-principles.md) -- How the code, tests and docs in this repo are built: the engineering rules and what enforces each
- [Adapters](adapters.md) -- The `BundleAdapter` contract: what a bundle's files *are*, how they're indexed, linted, and written
- [Architecture: The Workflow Engine](workflow-engine.md) -- How a workflow compiles to a frozen plan, persists run/unit state, dispatches work, and resumes without replaying completed steps
- [Architecture: The Improvement Loop](improvement.md) -- Purpose and boundary of the improvement loop

## Specs (`specs/`)

Normative specifications and binding conventions.

- [OKF format support](specs/okf-support.md) -- OKF is a first-class format supported through the built-in `okf` adapter
- [Ref Format](specs/ref.md) -- Wire format for asset references

## Internals (`internals/`)

Current-truth subsystem references.

- [Storage Locations](internals/storage-locations.md) -- Authoritative inventory of every on-disk read/write path
- [Indexing](internals/indexing.md) -- How the search index is built
- [Classification](internals/classification.md) -- Matcher and renderer behavior
- [Improve Workflow](internals/improve-workflow.md) -- `akm improve` command surface and pipeline reference
- [Health Advisories](internals/health-advisories.md) -- `akm health` advisory-to-action map for operators
- [Fresh-Host Rebuild Runbook](internals/fresh-host-rebuild-runbook.md) -- Rebuild an akm install on a new machine
- [Persisted-Data Compatibility Contract](persisted-data-compat.md) -- What a reader owes data an earlier release wrote, per persisted format

## Testing (`testing/`)

- [Testing Workflow](testing/testing-workflow.md) -- End-to-end, Docker, deployment, and upgrade validation, plus the coverage gap guide
