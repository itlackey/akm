# Architecture

How akm is built: system overview, normative specs, decision history, and
subsystem internals.

- [Architecture](architecture.md) -- How akm's bundles, cache, index, and registries fit together
- [Core Principles](akm-core-principles.md) -- Design principles and constraints
- [Adapters](adapters.md) -- The `BundleAdapter` contract: what a bundle's files *are*, how they're indexed, linted, and written
- [Architecture: The Workflow Engine](workflow-engine.md) -- How a workflow compiles to a frozen plan, persists run/unit state, dispatches work, and resumes without replaying completed steps
- [Architecture: The Improvement Loop](improvement.md) -- Purpose and boundary of the improvement loop
- [Runtime Boundary Design](runtime-boundary-design.md) -- Isolating `bun:sqlite`/`Bun.*` from the core
- [Architecture Decision History](akm-architecture-decision-history.md) -- ADR-style record of the major architecture rulings

## Specs (`specs/`)

Normative specifications and binding conventions.

- [OKF format support](specs/okf-support.md) -- OKF is a first-class format supported through the built-in `okf` adapter
- [0.9.0 surface decisions](specs/0.9.0-decisions.md) -- The decision record (D1-D12) behind the 0.9.0 breaking changes
- [Bundle & Adapter Spec (0.9.0)](specs/akm-0.9.0-bundle-adapter-spec.md) -- Normative spec for bundles, adapters, and bundle recognition
- [Ref Grammar Decision (0.9.0)](specs/akm-0.9.0-ref-grammar-decision.md) -- The `[bundle//]conceptId` ref grammar
- [Ref Format](specs/ref.md) -- Wire format for asset references
- [Format-Neutral Bundle Workspace Spec](specs/akm-format-neutral-bundle-workspace-spec.md) -- The format-neutral workspace model
- [Agent, Command, Engine, and Model Resolution](specs/agent-command-engine-model-design.md) -- Approved target semantics for native agent/command bundles, configuration cascading, model maps, and dispatch
- [0.9.2 Agent/Command/Task/Workflow Implementation Plan](../plans/0.9.2-agent-command-workflow-plan.md) -- Sequenced work packages, [GitHub milestone tracker](https://github.com/itlackey/akm/issues/801), migration rules, support boundaries, and release evidence for the coherent execution MVP
- [Fact Asset Type](specs/fact-asset-type.md) -- The `fact` asset type
- [Bundle Conventions Code Spec](specs/stash-conventions-code-spec.md) -- Code-level bundle conventions
- [Bundle Organization Conventions](specs/stash-organization-conventions.md) -- How a bundle is laid out
- [DI Seams Plan](specs/di-seams-plan.md) -- Dependency-injection seams used by the test suite
- [Improve Collapse/Churn Detector](specs/improve-collapse-churn-detector-design.md) -- Longitudinal collapse/churn detection design (§6.3 is the operator runbook referenced by `akm health`)

Historical review registers (0.9.0 release-review audit trail, kept for provenance, not normative going forward):

- [0.9.0 Docs–Code Drift Register](specs/0.9.0-docs-code-drift-register.md) -- Ruled record of places documentation and code disagreed, and open-intent questions (Q-01..Q-19)
- [0.9.0 Public API Issue Backlog](specs/0.9.0-public-api-issue-backlog.md) -- Implementation-only findings from the CLI surface review
- [0.9.0 Release Surface Review](specs/0.9.0-release-surface-review.md) -- Reconciled action list from the end-to-end user-facing surface sweep

## Internals (`internals/`)

Current-truth subsystem references.

- [Storage Locations](internals/storage-locations.md) -- Authoritative inventory of every on-disk read/write path
- [Search](internals/search.md) -- Hybrid search architecture and scoring
- [Indexing](internals/indexing.md) -- How the search index is built
- [Classification](internals/classification.md) -- Matcher and renderer behavior
- [Improve Workflow](internals/improve-workflow.md) -- `akm improve` command surface and pipeline reference
- [Health Advisories](internals/health-advisories.md) -- `akm health` advisory-to-action map for operators
- [Registry Network Boundary](internals/registry-network-boundary.md) -- Outbound registry request inventory, destination policy, redirects, and DNS guarantees
- [Functional Contract Patterns](internals/functional-contract-patterns.md) -- Quick reference for contributor pipelines and small process contracts
- [Fresh-Host Rebuild Runbook](internals/fresh-host-rebuild-runbook.md) -- Rebuild an akm install on a new machine
- [Persisted-Data Compatibility Contract](persisted-data-compat.md) -- What a reader owes data an earlier release wrote, per persisted format

## Reviews (`reviews/`)

Point-in-time architecture reviews of a specific subsystem question.

- [Runtime secret resolution for in-process source fetchers](reviews/env-secret-access.md) -- Why secret reads are injected as a `SecretResolver` capability instead of imported inside the fetcher subgraph

## Comparisons (`comparisons/`)

- [Workflow architecture: Claude Code workflows vs. akm workflows](comparisons/claude-code-vs-akm-workflows-full.md) -- Full technical comparison of the Claude Code `Workflow` tool and akm workflows; see [the short vendor-neutral guide](../guides/claude-code-vs-akm-workflows.md) for the decision-level version

## Testing (`testing/`)

- [Testing Workflow](testing/testing-workflow.md) -- End-to-end, Docker, deployment, and upgrade validation, plus the coverage gap guide
- [Manual Testing Checklist](testing/manual-testing-checklist.md) -- Pre-release manual QA checklist
- [OKF v0.2 Conformance Re-Evaluation Runbook](testing/okf-v0.2-conformance-runbook.md) -- Acceptance procedure to re-run after changing adapters, indexing, refs, writes, or lint behavior
