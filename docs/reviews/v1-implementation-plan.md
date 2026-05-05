# akm v1 — Consolidated Implementation Plan

**Status:** Forward-looking implementation plan toward the future 1.0 GA freeze. Wave 1 shipped in 0.7.0; Waves 2-3 remain in flight.

This document summarizes the implementation strategy behind the detailed issue backlog in
`docs/reviews/v1-agent-reflection-issues.md`.

> _Cross-links: see [`docs/migration/release-notes/0.7.0.md`](../migration/release-notes/0.7.0.md) for what 0.7.0 actually shipped on the path to the 1.0 GA freeze, and [`docs/migration/v1.md`](../migration/v1.md) for the per-surface delta from 0.6.x. The 1.0 GA contract surface (locked at 1.0.0) is described in [`docs/technical/v1-architecture-spec.md`](../technical/v1-architecture-spec.md) §9._

## What changed

The earlier draft backlog was too incremental for a pre-release branch. It created avoidable
sequencing problems by pushing contract/docs cleanup to the end while new features were already
depending on revised CLI, config, and type semantics.

This plan is intentionally more aggressive:

- fewer waves,
- fewer handoff points,
- earlier contract/doc sync,
- earlier semantic cleanup,
- shared infrastructure for all proposal-producing commands.

## Guiding decisions

1. Contract docs move first.
The architecture spec, CLI/config references, migration guide, and contract tests need to be
updated before most of the new work lands, not after. That keeps implementation aligned with the
 surface 0.7.0 ships toward the future 1.0 GA freeze.

2. Agent foundations land as one slice.
Config schema, built-in profiles, process spawning, and setup detection are all parts of the same
runtime capability. Splitting them across several milestones adds coordination cost without much
payoff.

3. Proposal infrastructure is shared.
`akm reflect`, `akm propose`, and `akm distill` should all target one durable proposal queue with
one validation/promotion path. That queue should support multiple proposals for the same asset.

4. Naming cleanup happens before new semantics depend on it.
The old registry `curated` boolean should be removed before `quality: "proposed"` and search-hit
quality metadata are introduced more broadly.

5. Feature gates precede feature-gated commands.
`llm.features.feedback_distillation` must exist before `akm distill` depends on it.

6. Derived memory compression beats atomic fact sprawl.
The current memory-inference shape creates too many low-value child files by splitting dense parent
memories into sentence-level facts. The future direction should prefer a small number of
information-dense derived memory artifacts with rich metadata, clear provenance, and search
projections that naturally rank above the verbose parent without creating a large sibling-file fanout.

## Execution waves

### Wave 1 — Contract Sync + Agent Foundations (`0.7.0`, shipped)

- Rewrite the v1 contract baseline. _(shipped in 0.7.0 via PR #233)_
- Add agent runtime foundations. _(shipped in 0.7.0 via PR #234)_
- Lock bounded LLM/agent architecture rules. _(shipped in 0.7.0)_
- Remove the vestigial registry `curated` field and align registry/search projections. _(shipped in 0.7.0)_

Deliverable: 0.7.0 ships docs and tests that define the surface targeted toward the future 1.0 GA
freeze, and the codebase has a real agent runtime foundation to build on. The surfaces are
committed to but not contractually frozen until 1.0 GA.

### Wave 2 — Proposal Workflow + Search Semantics (`0.8.0` pre-release toward 1.0 GA)

- Add `quality: "proposed"` and search filtering.
- Build the durable proposal queue and `akm proposal *` review flow.
- Redesign memory inference around compressed derived memories instead of atomic fact splitting.
- Add search/ranking semantics so compact derived memories with richer metadata score above the
  original parent naturally, without relying on ad hoc special cases.

Deliverable: one stable proposal and review pipeline that later commands can reuse without special
cases, plus a clear search-semantic direction for high-signal derived memory artifacts that reduce
file sprawl. Committed but not frozen until 1.0 GA.

### Wave 3 — Reflection, Generation, Distillation, and 1.0 GA Lock (`0.9.x -> 1.0` GA)

- Implement `akm reflect` and `akm propose` on top of the shared queue.
- Add `lesson` and `llm.features.*` together.
- Implement `akm distill`.
- Finalize the compressed-memory write shape: one or a few properly formatted derived artifacts with
  rich metadata, explicit provenance back to the parent, and contract-tested indexing/ranking
  behavior.
- Finalize docs, migration notes, release notes, and contract locks.

Deliverable: the full reflection/proposal loop is present, feature-gated where needed, and backed
by the final 1.0 GA docs/tests at the contract freeze.

## Source documents

- Detailed issue backlog: `docs/reviews/v1-agent-reflection-issues.md`
- Contract source of truth (under active revision): `docs/technical/v1-architecture-spec.md`
- Migration baseline (under active revision): `docs/migration/v1.md`

## Working rule

If a code change would materially alter CLI shape, config schema, search projection semantics, or
proposal workflow behavior, update the corresponding docs in the same wave rather than deferring
the documentation to a later cleanup pass.
