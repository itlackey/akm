# akm v1 — Consolidated Implementation Plan

**Status:** Current pre-release implementation plan (2026-04-27).

This document summarizes the implementation strategy behind the detailed issue backlog in
`docs/reviews/v1-agent-reflection-issues.md`.

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
 intended v1 surface.

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

## Execution waves

### Wave 1 — Contract Sync + Agent Foundations (`v0.7`)

- Rewrite the v1 contract baseline.
- Add agent runtime foundations.
- Lock bounded LLM/agent architecture rules.
- Remove the vestigial registry `curated` field and align registry/search projections.

Deliverable: the docs and tests define the intended v1 surface early, and the codebase has a real
agent runtime foundation to build on.

### Wave 2 — Proposal Workflow + Search Semantics (`v0.8`)

- Add `quality: "proposed"` and search filtering.
- Build the durable proposal queue and `akm proposal *` review flow.

Deliverable: one stable proposal and review pipeline that later commands can reuse without special
cases.

### Wave 3 — Reflection, Generation, Distillation, and v1 Lock (`v0.9 -> v1.0`)

- Implement `akm reflect` and `akm propose` on top of the shared queue.
- Add `lesson` and `llm.features.*` together.
- Implement `akm distill`.
- Finalize docs, migration notes, release notes, and contract locks.

Deliverable: the full reflection/proposal loop is present, feature-gated where needed, and backed
by final v1 docs/tests.

## Source documents

- Detailed issue backlog: `docs/reviews/v1-agent-reflection-issues.md`
- Contract source of truth (under active revision): `docs/technical/v1-architecture-spec.md`
- Migration baseline (under active revision): `docs/migration/v1.md`

## Working rule

If a code change would materially alter CLI shape, config schema, search projection semantics, or
proposal workflow behavior, update the corresponding docs in the same wave rather than deferring
the documentation to a later cleanup pass.
