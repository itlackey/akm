# Architecture Cleanup Checklist

Living execution checklist for the behavior-preserving architecture cleanup plan.

**Related:**

- `docs/technical/implementation-plan-functional-contract-refactor.md`
- `docs/technical/functional-contract-patterns.md`
- `docs/example-stash/workflows/architecture-cleanup.md`
- `docs/example-stash/skills/architecture-cleanup/SKILL.md`

---

## Usage Rules

1. Treat this as a living checklist during implementation.
2. Update this document immediately when an agent completes, blocks, cancels, or re-scopes an item.
3. Do not mark an item complete until the listed gate and parity checks for that item have passed.
4. Do not rewrite tests, fixtures, or expected outputs to make refactoring easier.
5. The only allowed test edits are import-path or symbol-import updates caused by file moves.
6. If a phase starts increasing complexity or resembling framework-building, stop and record that in this document before proceeding.

Suggested status markers:

- `[ ]` not started
- `[-]` in progress
- `[x]` completed
- `[!]` blocked / decision needed
- `[~]` cancelled or deferred

---

## Baseline

- [x] Re-read `docs/technical/implementation-plan-functional-contract-refactor.md` and `docs/technical/functional-contract-patterns.md`.
- [x] Confirm non-goals, behavior-parity constraints, and allowed test changes.
- [x] Create or identify the working branch for the cleanup.
- [x] Record current `git status` before any code edits.
- [x] Run targeted baseline tests for the touched areas and save before-state outputs.
- [x] Record the baseline test commands and outputs in the working notes.

---

## Phase 1 — Low-Risk Search And Validation Seams

- [x] Extract `ProposalValidator` seam from `src/core/proposals.ts` using adapters first.
- [x] Extract `ActionContributor` seam from `src/core/asset-registry.ts` and `src/indexer/db-search.ts`.
- [x] Extract `SearchHitEnricher` seam from renderer-owned enrichment paths.
- [x] Introduce `RankingContributor` registry while preserving ranking order and math.
- [x] Keep all behavior unchanged while routing logic through the new seams.

### Phase 1 Gate

- [x] Run all existing search, proposal, and show tests.
- [x] Verify no test expectation changes were required.
- [x] Review the diff and confirm the changes are architecture-only.
- [x] Complete a focused code review before moving on.
- [x] Update this checklist with pass/fail/block notes for the gate.

### Git Hygiene

- [x] Ensure the diff is small and focused.
- [x] Remove dead code and temporary scaffolding that is no longer needed.
- [x] Verify no unrelated files changed.
- [x] Only create a commit at the phase gate if commits are desired for this effort.

---

## Phase 1a — Agent Harness And Session-Log Seams

- [x] Introduce `AgentRunner` as the runtime dispatch seam for agent execution.
- [x] Keep spawned CLI harnesses as the default onboarding path for new harnesses.
- [x] Preserve OpenCode SDK as the fallback special-case harness when no CLI harness is configured or available.
- [x] Introduce `SessionLogHarness` as the raw-history ingestion seam.
- [x] Centralize session-event normalization, aggregation, and de-duplication.
- [x] Remove direct harness branching from higher-level orchestration where the seam now covers it.

### Phase 1a Gate

- [x] Run existing agent integration tests and session-log coverage, or the nearest equivalent suites.
- [x] Verify no behavior drift in agent dispatch or improve-related integration behavior.
- [x] Confirm onboarding a new harness remains a narrow adapter exercise.
- [x] Complete a focused code review before moving on.
- [x] Update this checklist with pass/fail/block notes for the gate.

### Git Hygiene

- [x] Inspect `git diff` and `git status`.
- [x] Ensure only integration-seam files changed.
- [x] Keep this patch isolated from unrelated refactors.

---

## Phase 2 — Split Presentation From Metadata Extraction

- [x] Keep show payload generation on a narrow presentation seam.
- [x] Move indexing metadata logic behind `MetadataContributor[]`.
- [x] Preserve search-hit enrichment as its own contract from Phase 1.
- [x] Keep search and show behavior stable while separating responsibilities.

### Phase 2 Gate

- [x] Run metadata, search, and show parity tests.
- [x] Verify render/search output parity.
- [x] Complete a focused code review before moving on.
- [x] Update this checklist with pass/fail/block notes for the gate.

### Git Hygiene

- [x] Review the diff against the base branch.
- [x] Keep module moves tidy.
- [x] Confirm test edits, if any, are import-only.
- [x] Avoid opportunistic cleanup outside the touched seam.

---

## Phase 3 — Structural Path Resolver

- [x] Introduce the structural `PathResolver` seam.
- [x] Replace duplicated path lookup logic in show, write, improve, and lint with the shared resolution layer.
- [x] Remove command-local path guessing where the shared resolver now applies.

### Phase 3 Gate

- [x] Run path-resolution parity tests across show, write, improve, and lint.
- [x] Confirm no command behavior changes.
- [x] Complete a focused code review before moving on.
- [x] Update this checklist with pass/fail/block notes for the gate.

### Git Hygiene

- [x] Verify path-related changes remain localized.
- [x] Confirm there are no fixture/assertion changes beyond imports.

---

## Phase 4 — Classification As Facts

- [x] Rework classification into fact-producing `MatchContributor[]`.
- [x] Remove direct renderer selection from match results.
- [x] Preserve classification precedence and current resolution behavior.

### Phase 4 Gate

- [x] Run classification precedence tests.
- [x] Run wiki/workflow regression tests.
- [x] Validate no search/show behavior drift.
- [x] Complete a focused code review before moving on.
- [x] Update this checklist with pass/fail/block notes for the gate.

### Git Hygiene

- [x] Keep the phase localized to classification and immediate callers.
- [x] Confirm import-only test edits if modules moved.

---

## Decision Checkpoint Before Phase 5

- [x] Confirm Phases 1 through 4 measurably reduced duplication and switchboard logic.
- [x] Confirm complexity did not increase materially.
- [x] Stop and simplify if the contributor pattern is turning into a framework.
- [x] Record the go / no-go decision in this checklist before continuing.

---

## Phase 5 — Improve Fixed Stages

- [x] Refactor `src/commands/improve.ts` into fixed stages with narrow stage helpers.
- [x] Preserve current stage order and all current behavior.
- [x] Keep the refactor architectural only.

### Phase 5 Gate

- [x] Run stage-level improve parity tests.
- [x] Run targeted end-to-end improve regressions.
- [x] Verify no workflow or output changes.
- [x] Complete a deeper architecture review before moving on.
- [x] Update this checklist with pass/fail/block notes for the gate.

### Git Hygiene

- [ ] Keep commits scoped by stage if committing.
- [x] Ensure no speculative abstractions leaked in.
- [ ] Verify git status is clean except for intended changes.

---

## Decision Checkpoint Before Phase 6

- [ ] Confirm index side-effect seams are justified by concrete duplication.
- [ ] Confirm the work is not introducing a registry framework.
- [ ] Record the go / no-go decision in this checklist before continuing.

---

## Phase 6 — Index Post-Processors

- [ ] Formalize index side-effects as `IndexPostProcessor[]`.
- [ ] Preserve indexing outputs, DB behavior, and workflow document handling.
- [ ] Keep this phase architectural only.

### Phase 6 Gate

- [ ] Run indexer parity tests.
- [ ] Run feature-specific regressions for graph extraction, memory inference, and workflow document handling.
- [ ] Verify no schema or behavior drift.
- [ ] Complete final architecture review.
- [ ] Update this checklist with pass/fail/block notes for the gate.

### Git Hygiene

- [ ] Keep indexing changes isolated.
- [ ] Confirm no accidental schema or output changes slipped in.

---

## Final Verification

- [ ] Review `git diff` and confirm the whole change set is architectural cleanup only.
- [ ] Remove temporary shims that are no longer needed and are safe to delete without behavior change.
- [ ] Confirm no unrelated files are included.
- [ ] Run the agreed full validation suite for all touched surfaces.
- [ ] Confirm all tests pass with unchanged expectations.
- [ ] Document the parity evidence in the working notes.

---

## Final Review And Handoff

- [ ] Summarize phase outcomes.
- [ ] Summarize review findings and any residual risks.
- [ ] Record any deferred items or follow-up cleanups that were intentionally kept out of scope.
- [ ] Update this checklist one final time with completed, blocked, or deferred states.
- [ ] Prepare commit(s) only if explicitly requested.
