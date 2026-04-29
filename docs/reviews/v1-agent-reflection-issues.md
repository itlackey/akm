# GitHub Issue Set: v1 Agent Reflection & Self-Evolution

**Status:** Forward-looking design backlog. Wave 1 shipped in 0.7.0; Waves 2-3 remain on the path to the future 1.0 GA freeze.
**Source proposal:** "Agent Reflection and Self-Evolution for akm" (2026-04-26).
**Target milestone:** `1.0` GA freeze (current train: 0.7.x pre-release on the path to 1.0).

This document translates the proposal into a smaller, more aggressive GitHub issue set.
Compared to the earlier draft, it deliberately combines related work, moves contract/doc
sync to the front of the queue, and removes sequencing traps that only matter once the
1.0 GA contract is already frozen.

> _Cross-links: see [`docs/migration/release-notes/0.7.0.md`](../migration/release-notes/0.7.0.md) for what actually shipped in the 0.7.0 pre-release toward the future 1.0 GA freeze, and [`docs/migration/v1.md`](../migration/v1.md) for the per-surface delta from 0.6.x. The 1.0 GA contract surface (locked at 1.0.0) is described in [`docs/technical/v1-architecture-spec.md`](../technical/v1-architecture-spec.md) §9._

## Planning principles

- Pre-release is the right time to make larger surface changes.
- Contract docs and implementation should move together, not in separate endgame waves.
- Cleanup that affects naming or semantics should happen before new features build on top of it.
- Proposal-producing commands should share one storage and validation path.

---

## Wave 1 — Contract Sync + Agent Foundations (`0.7.0`, shipped)

> _Status: Wave 1 shipped in 0.7.0. The surfaces below are committed to but are not contractually frozen until 1.0 GA. See [`docs/migration/release-notes/0.7.0.md`](../migration/release-notes/0.7.0.md)._

### Issue 1 — Rewrite the v1 contract baseline (shipped in 0.7.0 via PR #233)
- **Title:** `docs(contract): rewrite v1 lock sections for agent/proposal/lesson surfaces`
- **Labels:** `area:docs`, `area:test`, `v0.7`, `type:chore`
- **Summary:** Update the architecture spec, CLI/config references, and migration baseline early so 0.7.0 implementation proceeds against the intended 1.0 GA surface instead of stale `v0.6` refactor docs.
- **Acceptance criteria:**
  - `docs/technical/v1-architecture-spec.md` reflects proposal queue, agent CLI integration, open quality/type rules, `lesson`, and `llm.features.*` as the surfaces 0.7.0 ships toward the future 1.0 GA freeze.
  - `docs/cli.md` and `docs/configuration.md` clearly distinguish 0.7.0-shipped behavior from surfaces still pending before 1.0 GA.
  - `docs/migration/v1.md` is updated to the 0.7.0 pre-release migration baseline instead of implying the earlier refactor is the final 1.0 GA story.
  - Contract tests cover the sections committed-but-not-frozen-until-1.0 that are actually being carried into implementation.
- **Depends on:** none.

### Issue 2 — Add agent runtime foundations (shipped in 0.7.0 via PR #234)
- **Title:** `feat(agent): add config, profiles, spawn wrapper, and setup detection`
- **Labels:** `area:agent`, `area:config`, `area:setup`, `v0.7`, `type:feature`
- **Summary:** Combine the agent config schema, built-in profile registry, CLI spawn wrapper, and setup UX into one foundation issue.
- **Acceptance criteria:**
  - Config schema accepts an optional `agent` block with documented fields.
  - Unknown `agent` keys are warn-and-ignore.
  - Missing `agent` config disables agent commands with a clear CLI error.
  - Built-in profiles resolve for `opencode`, `claude`, `codex`, `gemini`, and `aider`.
  - Spawn wrapper supports captured and interactive stdio, hard timeout, and structured failure reasons.
  - Setup detects installed agent CLIs and persists a selected default profile when available.
  - Tests cover config parsing, profile command construction, timeout handling, malformed output, and setup detection branches.
- **Depends on:** #1.

### Issue 3 — Lock bounded LLM/agent architecture rules (shipped in 0.7.0)
- **Title:** `docs(test): enforce stateless in-tree LLM and shell-out-only agent invariants`
- **Labels:** `area:docs`, `area:test`, `v0.7`, `type:chore`
- **Summary:** Document and test the intended boundary: in-tree LLM helpers stay bounded and stateless; external agents are invoked via CLI shell-out only.
- **Acceptance criteria:**
  - Architecture docs define the invariants in terms of concrete seams, not broad pattern bans.
  - Tests lock the supported integration seams and fail when prohibited paths are introduced.
  - The rules are narrow enough to be maintained without brittle grep-only enforcement.
- **Depends on:** #1.

### Issue 4 — Clean up registry/search naming before proposal semantics land (shipped in 0.7.0)
- **Title:** `feat(search): remove registry curated field and align search hit projections`
- **Labels:** `area:search`, `area:registry`, `v0.7`, `type:feature`
- **Summary:** Remove the vestigial registry `curated` boolean and align hit projections before new `quality` semantics are introduced elsewhere.
- **Acceptance criteria:**
  - Registry hit projections no longer surface the vestigial `curated` boolean.
  - Legacy registry JSON with `curated` parses and ignores the key.
  - Search hit types and renderers surface optional `warnings` fields when present.
  - Docs and tests reflect the updated registry/search contract.
- **Depends on:** #1.

---

## Wave 2 — Proposal Workflow + Search Semantics (`0.8.0` pre-release toward 1.0 GA)

> _Status: planned. The proposal queue scaffolding shipped in 0.7.0 ([`docs/migration/release-notes/0.7.0.md`](../migration/release-notes/0.7.0.md)); the surfaces below remain committed-but-not-frozen until the future 1.0 GA freeze._

### Issue 5 — Add quality/proposal semantics
- **Title:** `feat(search): add proposed quality semantics and filtering`
- **Labels:** `area:indexer`, `area:search`, `area:registry`, `v0.8`, `type:feature`
- **Summary:** Introduce `quality: "proposed"` and exclude it from default search after the older registry `curated` naming has already been removed.
- **Acceptance criteria:**
  - `generated` and `curated` remain included by default.
  - `proposed` is excluded by default and included with `--include-proposed`.
  - Unknown quality values parse, warn, and remain searchable.
  - Search hit types and renderers surface optional `quality` fields when present.
  - Docs and tests reflect the updated semantics.
- **Depends on:** #4.

### Issue 6 — Build the durable proposal queue and `akm proposal *`
- **Title:** `feat(proposals): add proposal storage, review commands, validation, and events`
- **Labels:** `area:proposals`, `area:cli`, `area:db`, `v0.8`, `type:feature`
- **Summary:** Implement one durable proposal system for all future reflection/generation flows, including queue storage, review commands, validation, and emitted events.
- **Acceptance criteria:**
  - Proposal storage is durable across restarts and supports multiple proposals for the same asset without path collisions.
  - Metadata includes `id`, `ref`, `status`, `source`, `source_run`, timestamps, and review outcome data.
  - `akm proposal list/show/accept/reject/diff` all register output shapes.
  - `accept` validates and promotes only after full checks pass.
  - `reject` archives with reason metadata.
  - `diff` shows the proposed delta prior to acceptance.
  - Usage events include `promoted`, `rejected`, `reflect_invoked`, `propose_invoked`, and `distill_invoked` at the appropriate call sites.
  - Invalid proposal files are surfaced clearly.
- **Depends on:** #5.

---

## Wave 3 — Reflection, Generation, Distillation, and 1.0 GA Lock (`0.9.x -> 1.0` GA)

> _Status: planned. This is the wave that drives toward the 1.0 GA contract freeze (spec §9). Surfaces are committed but not frozen until 1.0 GA. See [`docs/migration/v1.md`](../migration/v1.md) for the path-to-1.0 narrative._

### Issue 7 — Implement `akm reflect` and `akm propose`
- **Title:** `feat(agent): implement reflect/propose commands on top of the proposal queue`
- **Labels:** `area:agent`, `area:cli`, `area:test`, `v0.9`, `type:feature`
- **Summary:** Add both proposal-producing agent commands together so they share prompt construction, validation, queue insertion, failure handling, and profile integration tests.
- **Acceptance criteria:**
  - `akm reflect [ref]` builds prompts from asset content, feedback, and schema context, then writes only to the proposal queue.
  - `akm propose <type> <name> --task ...` generates proposals only; it never mutates live stash content directly.
  - Both commands return structured failures for CLI, timeout, parsing, or validation errors and exit non-zero on failure.
  - Both commands emit the corresponding invocation events.
  - Mock CLI tests run in CI.
  - Opt-in real-profile integration tests exist behind an env flag and cover at least OpenCode and Claude profiles.
- **Depends on:** #2, #6.

### Issue 8 — Add `lesson` and `llm.features.*` together
- **Title:** `feat(llm): add lesson asset type and per-feature LLM gates`
- **Labels:** `area:assets`, `area:llm`, `area:config`, `v0.9`, `type:feature`
- **Summary:** Introduce the new asset type and the LLM feature-gate map in one change so future distillation work depends on a real config surface instead of a placeholder.
- **Acceptance criteria:**
  - `lesson` is a first-class, well-known asset type with required `description` and `when_to_use` fields.
  - Lint validates lesson frontmatter and rendering supports lesson output.
  - Config supports `llm.features` with defaults false.
  - Feature gates support at least `curate_rerank`, `tag_dedup`, `memory_consolidation`, `feedback_distillation`, and `embedding_fallback_score`.
  - Each in-tree LLM feature falls back cleanly on disablement, timeout, or failure.
- **Depends on:** #1, #3.

### Issue 9 — Implement `akm distill <ref>`
- **Title:** `feat(distill): add feedback distillation into lesson proposals`
- **Labels:** `area:llm`, `area:cli`, `v0.10`, `type:feature`
- **Summary:** Add the bounded in-tree LLM distillation path once the `lesson` type, feature gates, and proposal queue all exist.
- **Acceptance criteria:**
  - `akm distill <ref>` is gated behind `llm.features.feedback_distillation`.
  - The command performs a single bounded in-tree LLM call.
  - Output is a lesson proposal in the queue, never a direct mutation.
  - `distill_invoked` is emitted.
  - Failures degrade cleanly when the feature is disabled or the LLM call fails.
- **Depends on:** #6, #8.

### Issue 10 — Finalize 1.0 GA docs, migration notes, and contract locks
- **Title:** `test(docs): finalize 1.0 GA contract suite, migration docs, and release notes`
- **Labels:** `area:test`, `area:docs`, `v1.0`, `type:chore`
- **Summary:** Finish the lock phase by ensuring the shipped docs, migration notes, and contract tests all describe the same surfaces that the code now implements at the 1.0 GA freeze.
- **Acceptance criteria:**
  - One test file exists per locked contract section.
  - Locked docs reflect proposal-backed workflows, new quality/type semantics, and final config/CLI surfaces.
  - Migration guidance explains proposal queue, `quality` extensions, `lesson`, `llm.features.*`, and any removed legacy fields such as registry `curated`.
  - Release notes call out the major behavioral changes between 0.6.x and the 1.0 GA freeze.
- **Depends on:** #5, #7, #9.

---

## Suggested Milestones
- **0.7.0** (shipped): #1-#4
- **0.8.0** (pre-release toward 1.0 GA): #5-#6
- **0.9.0** (pre-release toward 1.0 GA): #7-#8
- **0.10.0** (pre-release toward 1.0 GA): #9
- **1.0 GA lock + docs:** #10

## Suggested Tracking Labels
- `wave:contract-foundations`
- `wave:proposal-workflow`
- `wave:reflection-distill-lock`

## Notes on consolidation
- Earlier agent config, profile, spawn, and setup issues are intentionally merged into #2.
- Earlier proposal queue, proposal CLI, and event vocabulary issues are intentionally merged into #6.
- Earlier reflect/propose implementation and agent profile integration harness issues are intentionally merged into #7.
- Earlier lesson, feature-gate, and distill sequencing is corrected by splitting #8 and #9 in dependency order.
- Cleanup of registry `curated` is intentionally pulled forward into #4 in Wave 1 so new `quality` semantics do not overlap with stale naming.

*End of backlog.*
