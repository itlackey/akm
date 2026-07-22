# Architecture

How akm is built: system overview, normative specs, decision history, and
subsystem internals.

- [Architecture](architecture.md) -- How akm's bundles, cache, index, and registries fit together
- [Core Principles](akm-core-principles.md) -- Design principles and constraints
- [Runtime Boundary Design](runtime-boundary-design.md) -- Isolating `bun:sqlite`/`Bun.*` from the core
- [Architecture Decision History](akm-architecture-decision-history.md) -- ADR-style record of the major architecture rulings
- [Brain Workflow (diagram)](brain-workflow.html) -- Visual map of the improve/self-learning loop

## Specs (`specs/`)

Normative specifications and binding conventions.

- [Bundle & Adapter Spec (0.9.0)](specs/akm-0.9.0-bundle-adapter-spec.md) -- Normative spec for bundles, adapters, and stash recognition
- [Ref Grammar Decision (0.9.0)](specs/akm-0.9.0-ref-grammar-decision.md) -- The `[bundle//]conceptId` ref grammar
- [Ref Format](specs/ref.md) -- Wire format for asset references
- [Format-Neutral Bundle Workspace Spec](specs/akm-format-neutral-bundle-workspace-spec.md) -- The format-neutral workspace model
- [Fact Asset Type](specs/fact-asset-type.md) -- The `fact` asset type
- [Stash Conventions Code Spec](specs/stash-conventions-code-spec.md) -- Code-level stash conventions
- [Stash Organization Conventions](specs/stash-organization-conventions.md) -- How a stash is laid out
- [DI Seams Plan](specs/di-seams-plan.md) -- Dependency-injection seams used by the test suite
- [Improve Collapse/Churn Detector](specs/improve-collapse-churn-detector-design.md) -- Longitudinal collapse/churn detection design (§6.3 is the operator runbook referenced by `akm health`)

## Internals (`internals/`)

Current-truth subsystem references.

- [Storage Locations](internals/storage-locations.md) -- Authoritative inventory of every on-disk read/write path
- [Search](internals/search.md) -- Hybrid search architecture and scoring
- [Indexing](internals/indexing.md) -- How the search index is built
- [Classification](internals/classification.md) -- Matcher and renderer behavior
- [Improve Workflow](internals/improve-workflow.md) -- `akm improve` command surface and pipeline reference
- [Health Advisories](internals/health-advisories.md) -- `akm health` advisory-to-action map for operators
- [Functional Contract Patterns](internals/functional-contract-patterns.md) -- Quick reference for contributor pipelines and small process contracts
- [Fresh-Host Rebuild Runbook](internals/fresh-host-rebuild-runbook.md) -- Rebuild an akm install on a new machine

## Testing (`testing/`)

- [Testing Workflow](testing/testing-workflow.md) -- End-to-end, Docker, deployment, and upgrade validation, plus the coverage gap guide
- [Manual Testing Checklist](testing/manual-testing-checklist.md) -- Pre-release manual QA checklist
