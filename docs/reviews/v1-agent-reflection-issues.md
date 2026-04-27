# GitHub Issue Set: v1 Agent Reflection & Self-Evolution

**Status:** Draft backlog for implementation.
**Source proposal:** “Agent Reflection and Self-Evolution for akm” (2026-04-26).
**Target milestone:** `v1.0` (current train: `v0.6.x` pre-release).

This document translates the proposal into actionable GitHub issues with sequencing, acceptance criteria, and dependencies.

---

## Epic 1 — Agent CLI Foundations (`v0.7`)

### Issue 1 — Add `agent` config schema and runtime parsing
- **Title:** `feat(config): add optional agent config section with profile/template support`
- **Labels:** `area:config`, `v0.7`, `type:feature`
- **Summary:** Add `agent` config block with `enabled`, `profile`, timeout, and template fields; keep behavior unchanged when omitted.
- **Acceptance criteria:**
  - Config schema accepts `agent` block with documented fields.
  - Unknown `agent` keys are warn-and-ignore.
  - `agent` absence disables agent commands with clear CLI error.
  - Tests cover valid config, unknown keys, and missing agent config.
- **Depends on:** none.

### Issue 2 — Add built-in agent profile definitions
- **Title:** `feat(agent): add built-in profiles for opencode, claude, codex, gemini, aider`
- **Labels:** `area:agent`, `v0.7`, `type:feature`
- **Summary:** Add profile modules for command/flag/prompt/output conventions.
- **Acceptance criteria:**
  - Profile registry resolves all five built-ins.
  - Profile selection by name works via config.
  - Unit tests assert profile command construction and output parsing contract.
- **Depends on:** #1.

### Issue 3 — Implement agent spawn wrapper
- **Title:** `feat(agent): add spawn wrapper with interactive/captured stdio and hard timeout`
- **Labels:** `area:agent`, `v0.7`, `type:feature`
- **Summary:** Centralized wrapper for shelling out to agent CLIs via stdin/stdout/exit code.
- **Acceptance criteria:**
  - Supports inherit/captured modes.
  - Enforces hard timeout.
  - Returns structured failure reasons (spawn fail, timeout, non-zero exit).
  - Tests include timeout and malformed output handling.
- **Depends on:** #2.

### Issue 4 — Setup wizard agent detection and config UX
- **Title:** `feat(setup): detect installed agent CLIs and persist default profile`
- **Labels:** `area:setup`, `v0.7`, `type:feature`
- **Summary:** Probe commands (`command -v`) during setup; prompt for default profile if available.
- **Acceptance criteria:**
  - Setup gracefully handles “none detected”.
  - Writes selected profile into config.
  - Tests cover detection branches.
- **Depends on:** #1, #2.

### Issue 5 — Enforce v1 architectural LLM/agent rules in docs and tests
- **Title:** `docs(test): lock architectural rules for in-tree LLM and agent shell-out`
- **Labels:** `area:docs`, `area:test`, `v0.7`, `type:chore`
- **Summary:** Document and test invariants: in-tree LLM stays stateless/single-trip; no embedded agent SDK.
- **Acceptance criteria:**
  - Architecture spec includes locked rules.
  - Contract tests fail on prohibited patterns.
- **Depends on:** none.

---

## Epic 2 — Proposal Queue + `proposed` Quality (`v0.8`)

### Issue 6 — Add `proposed` quality state and search filtering
- **Title:** `feat(index): add quality=proposed with default search exclusion`
- **Labels:** `area:indexer`, `area:search`, `v0.8`, `type:feature`
- **Summary:** Extend quality semantics; include via `--include-proposed`.
- **Acceptance criteria:**
  - `generated` and `curated` included by default.
  - `proposed` excluded by default and included with flag.
  - Unknown quality values parse, warn, and remain searchable.
- **Depends on:** #1.

### Issue 7 — Build proposal storage + metadata tracking
- **Title:** `feat(proposals): add on-disk proposal queue layout and metadata model`
- **Labels:** `area:proposals`, `v0.8`, `type:feature`
- **Summary:** Implement `proposals/<type>/<name>.md` and queue metadata.
- **Acceptance criteria:**
  - Metadata includes id/ref/status/source/source_run/timestamps.
  - Proposals survive process restarts.
  - Invalid proposal files are surfaced clearly.
- **Depends on:** #6.

### Issue 8 — Add `akm proposal` command group
- **Title:** `feat(cli): add proposal list/show/accept/reject/diff commands`
- **Labels:** `area:cli`, `area:proposals`, `v0.8`, `type:feature`
- **Summary:** CRUD + review UX for proposals.
- **Acceptance criteria:**
  - All commands register output shapes.
  - `accept` runs full validation then promotes.
  - `reject` archives with reason metadata.
  - `diff` shows pre-accept delta.
- **Depends on:** #7.

### Issue 9 — Extend usage event vocabulary
- **Title:** `feat(events): emit promoted/rejected/reflect_invoked/propose_invoked/distill_invoked`
- **Labels:** `area:db`, `v0.8`, `type:feature`
- **Summary:** Add event insertions without schema bump.
- **Acceptance criteria:**
  - Event types emitted at correct call sites.
  - Existing scoring flow remains functional.
- **Depends on:** #8.

---

## Epic 3 — Reflection/Proposal Commands via Agent CLI (`v0.9`)

### Issue 10 — Implement `akm reflect`
- **Title:** `feat(reflect): implement akm reflect [ref] using configured agent CLI`
- **Labels:** `area:agent`, `area:cli`, `v0.9`, `type:feature`
- **Summary:** Build prompt from asset + feedback + schema, invoke agent, validate result into proposal queue.
- **Acceptance criteria:**
  - Emits valid proposal or structured failure.
  - Non-zero exit on CLI or validation failure.
  - Emits `reflect_invoked` event.
- **Depends on:** #3, #8, #9.

### Issue 11 — Implement `akm propose`
- **Title:** `feat(propose): implement akm propose <type> <name> --task ...`
- **Labels:** `area:agent`, `area:cli`, `v0.9`, `type:feature`
- **Summary:** Agent-assisted generation into proposals only (never live stash write).
- **Acceptance criteria:**
  - Produces proposal file in queue.
  - Emits `propose_invoked` event.
  - Full lint/validation before queue insertion.
- **Depends on:** #3, #8, #9.

### Issue 12 — Add integration test harness for agent profiles
- **Title:** `test(agent): add mock CLI + opt-in real profile integration tests`
- **Labels:** `area:test`, `v0.9`, `type:test`
- **Summary:** Verify prompt contract, output schema, and profile wiring.
- **Acceptance criteria:**
  - Mock profile tests run in CI.
  - Real-CLI tests available behind env flag.
  - Coverage includes at least OpenCode + Claude profiles.
- **Depends on:** #10, #11.

---

## Epic 4 — Lesson Type + Distillation (`v0.10`)

### Issue 13 — Introduce `lesson` asset type
- **Title:** `feat(assets): add lesson type and frontmatter schema`
- **Labels:** `area:assets`, `v0.10`, `type:feature`
- **Summary:** First-class strategy items with required `description` + `when_to_use`.
- **Acceptance criteria:**
  - `lesson` included in open type contract as well-known value.
  - Lint validates required frontmatter.
  - Renderer supports lesson output shape.
- **Depends on:** #6.

### Issue 14 — Implement `akm distill <ref>`
- **Title:** `feat(distill): add feedback distillation command producing lesson proposals`
- **Labels:** `area:llm`, `area:cli`, `v0.10`, `type:feature`
- **Summary:** Single-round-trip in-tree LLM call for strategy distillation.
- **Acceptance criteria:**
  - Gated behind `llm.features.feedback_distillation`.
  - Produces proposal, not direct mutation.
  - Emits `distill_invoked` event.
- **Depends on:** #13, #9.

---

## Epic 5 — Contract Hardening + Cleanup (`v0.11 -> v1.0`)

### Issue 15 — Remove vestigial registry `curated` field
- **Title:** `refactor(registry): remove curated boolean from registry hit types`
- **Labels:** `area:registry`, `v0.11`, `type:breaking-pre-v1`
- **Summary:** Remove dead pass-through field and naming collision with local quality semantics.
- **Acceptance criteria:**
  - Field removed from runtime types and render paths.
  - Legacy registry JSON with `curated` parses and ignores key.
  - Tests updated to assert absence.
- **Depends on:** none.

### Issue 16 — Add `quality` + `warnings` to `SourceSearchHit`
- **Title:** `feat(search): align SourceSearchHit with v1 projection extensions`
- **Labels:** `area:search`, `v0.11`, `type:feature`
- **Summary:** Add optional fields and renderer handling.
- **Acceptance criteria:**
  - Fields surfaced in search output when present.
  - Missing fields handled gracefully.
- **Depends on:** #6.

### Issue 17 — Add `llm.features.*` map and feature gates
- **Title:** `feat(config): add llm.features map and gate all in-tree LLM extensions`
- **Labels:** `area:llm`, `area:config`, `v0.11`, `type:feature`
- **Summary:** Per-feature defaults false; independent toggles.
- **Acceptance criteria:**
  - Supports `curate_rerank`, `tag_dedup`, `memory_consolidation`, `feedback_distillation`, `embedding_fallback_score`.
  - Each feature falls back cleanly on failure/timeout.
- **Depends on:** #14.

### Issue 18 — Add contract test suite for locked v1 surfaces
- **Title:** `test(contract): add lock tests for v1 command/config/type/output contracts`
- **Labels:** `area:test`, `v1.0`, `type:test`
- **Summary:** Prevent accidental v2 breaks on locked surfaces.
- **Acceptance criteria:**
  - One test file per locked contract section.
  - Includes assertion that registry curated field is absent.
- **Depends on:** #15, #16, #17.

### Issue 19 — v1 docs and migration finalization
- **Title:** `docs(v1): finalize architecture spec, migration notes, and release docs`
- **Labels:** `area:docs`, `v1.0`, `type:chore`
- **Summary:** Lock final v1 contract docs; include migration from v0.6 and terminology updates.
- **Acceptance criteria:**
  - Architecture spec reflects proposal-backed v1 lock.
  - Migration guide documents proposal queue and quality/type extensions.
  - Release notes explicitly call out behavior changes.
- **Depends on:** #18.

---

## Suggested Milestones
- **v0.7:** #1–#5
- **v0.8:** #6–#9
- **v0.9:** #10–#12
- **v0.10:** #13–#14
- **v0.11 / v1.0 hardening:** #15–#19

## Suggested Tracking Labels
- `epic:agent-foundations`
- `epic:proposal-queue`
- `epic:reflection-loop`
- `epic:lesson-distill`
- `epic:v1-hardening`

