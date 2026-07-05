# Improve Pipeline & Salience — Working Reference

> **Status:** living document. Last synthesized 2026-06-22 from a 4-agent code audit
> (improve control flow, salience system, proposal lifecycle, design intent + issues).
> Keep this open when modifying anything under `src/commands/improve/`,
> `src/commands/proposal/`, or `src/core/salience*`/`state-db`. Update it when the
> facts below change — every claim carries a **file + symbol** citation (function/
> const/class name, never a line number) so it survives refactors.
> **2026-07-05 re-anchor:** after the D1 refactor split `improve.ts` (~5,400 →
> ~1,454 lines) into `preparation.ts`, `loop-stages.ts`, `eligibility.ts`,
> `triage.ts`, and moved the proposal repository from `proposals.ts` to
> `src/commands/proposal/repository.ts` and the state-table DDL from
> `state-db.ts` into `src/core/state/migrations.ts`, every citation below was
> re-verified against current source and re-anchored to a symbol.

This is the end-to-end mental model for how `akm improve` evolves the stash and how
salience steers it. It exists to stop us re-deriving the pipeline from scratch and to
list the **footguns that have already bitten us** so we don't reintroduce them.

---

## 0. TL;DR — the things most likely to trip you up

1. **The high-salience lane selects on a *type-weight stub*, not a real score.**
   `encoding_salience` *was* re-asserted to a per-type constant on *every* improve run, so
   the `>= 0.75` admission gate effectively meant "reflect every feedback-less agent /
   command / skill / lesson once." This is **#644** — **fixed pending merge**: migration
   015 adds an `encoding_source` provenance column (`content` vs `type-stub`),
   `upsertAssetSalience` no longer lowers a `content` score to a `type-stub`, and the
   improve loop reads the stored content score back and passes it to `computeSalience`.
   The single most important thing to understand before touching salience. (§2, §5-F1)

2. **LOOK vs CHANGE must stay separated.** Selecting an asset to *look at* (liberal,
   proactive) is a different decision from deciding to *change* it (gated, default
   no-op). Collapsing them caused 96% of assets to go permanently invisible. Do not
   re-gate LOOK behind the signal-delta gate. (§6, design principle #1)

3. **`gateDecision` is metadata, not status.** `deferred`/`auto-rejected`/`auto-accepted`
   live on `proposal.gateDecision`; the lifecycle state is `proposal.status`. A
   `deferred` proposal is still `pending`. Manual `accept` does **not** consult
   `gateDecision` — only `drain` skips `auto-rejected`. (§3)

4. **`force: true` bypasses all dedup/cooldown guards** and the `create` CLI path always
   sets it. Loop callers can flood the queue. Use `createProposal` with `force:false` if
   dedup matters. (§3-Guards)

5. **Several wired-but-dead fields**: `review_pressure`, `feedbackLane`, the proactive
   `recencyDecay` term. They compute and persist but don't influence selection yet. Don't
   assume they're live. (§5, §7) [Updated 2026-07-02: `outcome_salience`'s weight
   (`outcomeWeightEnabled`) is now default **ON** — see §2 below; it is no longer in the
   dead-field list.]

---

## 1. Pass inventory (what runs, in order)

`akmImprove()` (improve.ts) → its internal multi-cycle `for (cycleIndex …)` loop
(same function), each cycle = **preparation → loop → post-loop**, under three
independent locks (`triage.lock`, `consolidate.lock`, `reflect-distill.lock`).
Cycle stops early when `gateAcceptedThisCycle === 0` (fixed-point).

Post-D1, the three stages are separate exported functions: `runImprovePreparationStage()`
(preparation.ts) does everything through the salience sort; `runImproveLoopStage()`
(loop-stages.ts) does reflect/self-consistency/distill; `runImprovePostLoopStage()`
(loop-stages.ts) does memory-inference/recombine/procedural and internally calls
`runImproveMaintenancePasses()` (loop-stages.ts) for the orphan/expiry/log-purge sweep.

| Pass | Stage | file · symbol | Produces | Gating |
|---|---|---|---|---|
| triage drain | pre | improve.ts `akmImprove()` (pre-cycle triage block, before the `for (cycleIndex …)` loop) | promote/reject/defer of **backlog** proposals | `triage` enabled, `scope.mode!=="ref"`, `triage.lock` |
| ensureIndex + collectEligibleRefs | pre-cycle | eligibility.ts `collectEligibleRefs()` (called from `akmImprove()`) | `plannedRefs` | always |
| consolidation | prep 0.3 | preparation.ts `runConsolidationPass()` (called from `runImprovePreparationStage()`) | merge/delete memories → proposals | pool-delta mtime gate, `minPoolSize` (default **500**), `consolidate.lock` |
| session extract | prep 0.4 | preparation.ts `runSessionExtractPass()` (called from `runImprovePreparationStage()`) | candidate proposals from session logs | `extract` enabled, `minNewSessions` gate |
| extract backlog drain | prep | preparation.ts `runSessionExtractPass()` (same function, backlog-drain block) | promote/fail extract proposals | `autoAccept!==undefined`, not dryRun |
| validation + schema-repair | prep 1 | preparation.ts `runValidationAndRepairPass()` | `schemaRepairs` | LLM available |
| akmLint | prep 0.5 | preparation.ts `runImprovePreparationStage()` (calls `akmLint()`) | fixed/flagged | always, non-fatal |
| signal-delta partition | prep 2-3 | preparation.ts `runImprovePreparationStage()` (`eligibleRefs`/`distillOnlyRefs`/`noFeedbackPool` build) | `eligibleRefs`, `distillOnlyRefs`, `noFeedbackPool` | 30-day window; `--scope` bypasses |
| high-retrieval (P0-A) | prep 3 | preparation.ts `runImprovePreparationStage()` (`highRetrievalRefs` block) | `highRetrievalRefs` | `retrievalCount>=5`, no prior reflect proposal |
| proactive maintenance | prep 3 | preparation.ts `runImprovePreparationStage()` calling `selectProactiveMaintenanceRefs()` (proactive-maintenance.ts) | `proactiveRefs` | `proactiveMaintenance` enabled (code default OFF via `IMPROVE_PROCESS_DEFAULTS`, but the builtin `default` profile ships `enabled:true` — the 06-M5 deletion of that block is ratified-but-unexecuted) |
| high-salience admission (#608) | prep 3 | preparation.ts `runImprovePreparationStage()` (`highSalienceRefs` block) | `highSalienceRefs` (≤10% of limit) | `isContentEncodingRow()` (salience.ts; content provenance, #655) AND `encoding_salience>=0.75`, no prior reflect proposal |
| forgetting-safety | prep | preparation.ts `runImprovePreparationStage()` (forgetting-safety block) | force-add fallen refs | WS-1 rank-change report (scenario B, via `buildRankChangeReport()` in salience.ts) |
| replay | prep | preparation.ts `runImprovePreparationStage()` (replay-budget block) | append refs after `--limit` | `replayBudget>0` (**default 0**) |
| salience sort + no-op dampen | prep 4 | preparation.ts `runImprovePreparationStage()` (`loopRefs` build, using `SALIENCE_NO_OP_DAMPEN_THRESHOLD` from salience.ts) | `loopRefs` priority order | always |
| reflect loop | loop | loop-stages.ts `runImproveLoopStage()` | proposals (per ref) | non-derived, non-distillOnly, budget |
| self-consistency multi-sample | loop | loop-stages.ts `runImproveLoopStage()` (`SC_N`/`SC_THRESHOLD` block) | majority-vote winner | `utilityScore>=0.7` and `SC_N>=2` |
| distill loop | loop | loop-stages.ts `runImproveLoopStage()` (distill block) | proposals | `isDistillCandidateRef()`, cooldown, pending-dedup |
| memory inference | post | loop-stages.ts `runImproveMaintenancePasses()` (called from `runImprovePostLoopStage()`) | `.derived` memory facts on disk | `memoryInference` enabled |
| recombine | post | loop-stages.ts `runImprovePostLoopStage()` | `type:hypothesis`→`type:lesson` proposals | `recombine` enabled, `scope.mode!=="ref"` |
| procedural | post | loop-stages.ts `runImprovePostLoopStage()` | `type:workflow` proposals | `procedural` enabled (**default OFF**, #634) |
| orphan purge / expiry / log purge | post | loop-stages.ts `runImproveMaintenancePasses()` (`purgeOrphanProposals()`/`expireStaleProposals()` from `src/commands/proposal/repository.ts`; `purgeOldTaskLogs()` from `src/core/logs-db.ts`) | reject/expire/delete | retention config |

**Order gotchas:**
- **Consolidation runs BEFORE extract** (preparation.ts `runImprovePreparationStage()`
  calls `runConsolidationPass()` before `runSessionExtractPass()`, intentional):
  extract's auto-accepted writes must not re-trip consolidation's mtime gate in the
  same run. Reordering breaks the pool-delta gate.
- **Graph extraction reindexes only when `consolidationRan` AND inference didn't already
  reindex** (loop-stages.ts `runImproveMaintenancePasses()`). `consolidationRan` is
  true only when `processed>0`.

---

## 2. Salience — the data model and the formulas

Two SQLite tables in `state.db`. Table DDL now lives in `src/core/state/migrations.ts`
(moved out of `state-db.ts`, which now only re-exports `runMigrations`):

**`asset_salience`** (`src/core/state/migrations.ts`, migration `009`):
`encoding_salience` (def 0.5), `outcome_salience` (def 0.0), `retrieval_salience`
(def 0.0), `rank_score` (def 0.0), `consecutive_no_ops` (int), `updated_at`,
`homeostatic_demoted_at` (migration `011`). Index on `rank_score DESC`.

**`asset_outcome`** (`src/core/state/migrations.ts`, migration `010`):
`last_retrieved_at`, `retrieval_count`, `expected_retrieval_rate`,
`negative_feedback_count`, `accepted_change_count`, `review_pressure`, `outcome_score`.

Upsert: `upsertAssetSalience()` (salience.ts) overwrites all four score columns +
`updated_at` on every call; **does NOT touch `consecutive_no_ops`**.

### The three components (`computeSalience()`, salience.ts)

**encoding** (the "Encoding salience" block inside `computeSalience()`, salience.ts):
- If `inputs.encodingSalience` supplied → clamp & use.
- Else → `DEFAULT_TYPE_ENCODING_WEIGHTS[type] ?? 0.5`.
- The *content-based* score `scoreEncodingSalience()` (`0.40·novelty + 0.35·magnitude +
  0.25·predictionError`, encoding-salience.ts) is computed at distill time
  (`akmDistill()`, distill.ts) and persisted with `encoding_source='content'`. **Since
  #644** (fixed pending merge) the improve preparation stage READS that stored content
  score back and passes it as `encodingSalience` to `computeSalience()`
  (preparation.ts `runImprovePreparationStage()`), and `upsertAssetSalience()` refuses to
  lower it to the type-stub. A ref that has never been content-scored still gets the
  type-weight stub fallback (`encoding_source='type-stub'`). ⚠️ See §5-F1.

**retrieval** (the "Retrieval salience" block inside `computeSalience()`, salience.ts):
`rawRetrieval = log(1+freq)·recencyDecay`, soft-capped to `[0,1)`. **Updated 2026-07-02
(R4):** `recencyDecay = max(0.01, 0.1·0.5^(days/180) + 0.5^(days/21))` — 21-day
half-life on the fast term, but the floor itself now halves every 180 days instead of
staying pinned at 0.1, so stale/unreviewed assets keep drifting down instead of
parking. This folds in the decay previously done by the separate
`runHomeostaticDemotion()` pass (`homeostatic.ts`), which was deleted. This is the *only*
component with genuine time decay.

**outcome** (the "Outcome salience" block inside `computeSalience()`, salience.ts):
WS-2 row → pass-through; else warm-start from `min(utilityScore, 0.3)`. EMA update
α=0.3 (`updateAssetOutcome()`, outcome-loop.ts).

**rankScore** (the "Weight selection" + projection block inside `computeSalience()`,
salience.ts):
- **Default as of 2026-07-02 (R1):** `(0.25·enc + 0.15·out + 0.60·ret) / log10(size)`
  (`outcomeWeightEnabled` now defaults to `true` — see `computeSalience()`'s
  `inputs.outcomeWeightEnabled !== false` check).
- Opt-out (`outcomeWeightEnabled:false`): `(0.30·enc + 0.00·out + 0.70·ret) / log10(size)`
  (old parity weights).

Size penalty `1/log10(max(200,bytes))`. `outcome_score` is now capped at
`OUTCOME_SCORE_MAX = 1.5` (outcome-loop.ts, G2) before it enters this blend, so the
now-default `wo=0.15` term can't be dominated by an unbounded score.

### Type weights (`DEFAULT_TYPE_ENCODING_WEIGHTS`, salience.ts)

| type | weight | ≥0.75 gate? |
|---|---|---|
| skill | 0.9 | ✅ |
| agent | 0.9 | ✅ |
| command | 0.8 | ✅ |
| workflow | 0.8 | ✅ |
| lesson | 0.75 | ✅ |
| knowledge | 0.7 | ❌ |
| script | 0.6 | ❌ |
| memory | 0.5 | ❌ |
| *(default)* | 0.5 | ❌ |

→ Every skill/agent/command/workflow/lesson clears the default `salienceThreshold=0.75`
on the stub alone. This is why 180/181 "high-salience" assets are type-selected, not
content-selected (#644).

---

## 3. Proposal lifecycle (the bridge from "improve generated it" to "it landed")

**Note:** the proposal repository, domain service, and legacy filesystem import moved
from `proposals.ts` to `src/commands/proposal/repository.ts` (#578 storage
consolidation). The old `proposals.ts` module now holds only the two validators —
`validateProposal()` and `repairProposalContent()` — at
`src/commands/proposal/validators/proposals.ts`. All citations below are re-anchored
accordingly.

**Status state machine** (`ProposalStatus`, `src/commands/proposal/repository.ts`):
`pending → accepted | rejected`, and `accepted → reverted`. Single `proposals` table,
status is authoritative, archival = status flip on the same row. Only `pending` can be
promoted/archived; only `accepted` can be reverted (else `UsageError`).

| transition | fn | file · symbol |
|---|---|---|
| →pending | createProposal | `repository.ts` `createProposal()` |
| pending→accepted | promoteProposal→archiveProposal | `repository.ts` `promoteProposal()` → `archiveProposal()` |
| pending→rejected (explicit/orphan/TTL) | archiveProposal / purgeOrphanProposals / expireStaleProposals | `repository.ts` `archiveProposal()` / `purgeOrphanProposals()` / `expireStaleProposals()` |
| accepted→reverted | revertProposal | `repository.ts` `revertProposal()` |

**`status` vs `gateDecision`** (`ProposalGateDecisionOutcome` / `Proposal.gateDecision`,
`repository.ts`): `gateDecision.outcome` ∈ {`auto-accepted`,`deferred`,`auto-rejected`}
is *adjudication metadata* written by `recordGateDecision()` (`repository.ts`) — a
no-op if not pending, and it **never flips status**. A `deferred` proposal stays
`pending`.

**`eligibilitySource`** (`EligibilitySource`, `src/core/improve-types.ts`) — the lane
that selected the ref, stamped at partition time and threaded to proposal creation.
Full vocabulary: `signal-delta`, `high-retrieval`, **`high-salience`**, `proactive`,
`scope`, `forgetting-safety`, `replay`, `exploration`, `recombine`, `procedural`,
`unknown`. Precedence (preparation.ts `runImprovePreparationStage()`, the
`eligibilitySourceByRef` attribution block): `scope > signal-delta > high-retrieval >
proactive > high-salience`, with forgetting-safety overlaid last (same function, the
forgetting-safety block, applied after the base attribution).
*(Note: `high-salience` IS present and IS stamped — `runImprovePreparationStage()`
(preparation.ts). An earlier audit claimed it was missing; that was wrong.)*

### Guards (createProposal, `repository.ts` `createProposal()` — `force:true` bypasses the last three)

| guard | kind | blocks |
|---|---|---|
| invalid_ref / unknown_type / empty_content | hard reject | throws `UsageError`, emits `proposal_creation_rejected` |
| missing_description (consolidate only) | hard reject | same |
| duplicate_pending | dedup | pending exists for same ref+source |
| content_hash_match | dedup | SHA-256 matches pending or most-recent rejected |
| cooldown | cooldown | recent rejected within window (reflect 14d, distill 30d, default 7d) |

⚠️ `akmProposalCreate()` (`src/commands/proposal/proposal.ts`) **always passes
`force:true`** → CLI `create` skips all three dedup/cooldown guards.

### Validators (`runProposalValidators()`, `src/commands/proposal/validators/proposal-validators.ts`)

Run in order: generic → lesson → descriptionQuality → lessonContentQuality →
sourceNotSuperseded → reflectSizeGuard (the `defaultProposalValidators` /
`defaultProposalQualityValidators` arrays). **Error-level findings throw and block;
only `severity:"warn"` passes** (`ok = findings.every(f=>f.severity==="warn")`). The
only current warn is "description starts with When" (`isValidDescription()` inside
`descriptionQualityValidator`, `src/commands/proposal/validators/proposal-quality-validators.ts`).

**Hard bounds** live in `src/core/authoring-rules.ts` and are imported by the validators
(single source of truth, #645): `DESCRIPTION_MIN_CHARS/MAX_CHARS` (20–400),
`WHEN_TO_USE_MIN_CHARS/MAX_CHARS` (15–400). `authoringRulesForType(type)` emits the
matching agent-facing prose so prompt and gate cannot drift. `DESCRIPTION_TYPES` =
lesson/knowledge/memory/skill/command/agent/workflow/fact; `WHEN_TO_USE_TYPES` = lesson
only (both still verified current, `authoring-rules.ts`).

**Repair before validate** (`repairProposalContent()`,
`src/commands/proposal/validators/proposals.ts`; called from `promoteProposal()` in
`src/commands/proposal/repository.ts`): strips pseudo-frontmatter body lines, drops
stray `---` fences, repairs truncated `description`. Then **re-runs full validation** —
never a bypass. ⚠️ It persists the repaired content to the DB row (`upsertProposal()`)
*before* the asset write (`writeAssetToSource()`), both in `promoteProposal()`
(`repository.ts`); if the subsequent write fails, the row holds repaired content the
audit trail no longer matches.

### Drain (`drainProposals()`, `src/commands/proposal/drain.ts`)

Backlog-only (`excludeIds` removes this-run's fresh proposals). `classifyProposal()`
(`drain.ts`): rejectEmpty → policy.accept rule (with `max-diff-lines` /
`min-content-lines` defer bands) → policy.defer → null (leave pending). Optional judgment
tier (LLM/agent runner) resolves deferred items; the runner only judges, the engine
writes.

⚠️ **`auto-rejected` masking** (`drainProposals()`, `drain.ts`): `if
(gateDecision?.outcome === "auto-rejected") continue;` — prevents a prior concrete
rejection being overwritten with an accept. This guard exists in drain only; the
judgment tier and manual `accept` have no equivalent.

---

## 4. Standards & authoring-rules seam (HARD vs SOFT)

**Three** layers now, deliberately separate (one HARD, two SOFT):

- **HARD rules** (validator-rejecting, code-sourced): `src/core/authoring-rules.ts` →
  `authoringRulesForType()` injected verbatim into reflect/propose/distill/consolidate/
  recombine/procedural/extract/schema-repair prompts. Cannot drift from the gate (#645).
  Injected as its own block, AFTER `standardsContext`, in every prompt builder.
- **SOFT general conventions** (user-editable, advice-only, cross-type): stash `fact`
  assets with `category: convention|meta` → `resolveStashStandards(stashRoot)`
  (`resolveStashStandards()`, `src/core/standards/resolve-stash-standards.ts`). No
  enforcement — prose only. **Un-type-scoped.**
- **SOFT per-type conventions** (user-editable, advice-only, type-scoped, #646):
  `facts/conventions/assets/<type>.md` → `resolveTypeConventions(stashRoot, type)`
  (`resolveTypeConventions()`, `src/core/standards/resolve-type-conventions.ts`).
  Basename MUST be a `getAssetTypes()`-validated type; read straight from disk (no
  index rebuild); degrades to `""`. Augments the built-in `TYPE_HINTS` fallback
  (`TYPE_HINTS`, `src/integrations/agent/prompts.ts`, NOT removed) for that type. To prevent
  cross-type leakage, `resolveStashStandards` now EXCLUDES `facts/conventions/assets/*`
  so a `command` author never receives the `skill` convention.
  - **Default templates seeded by `akm init`:** the stash skeleton now ships
    starter `facts/conventions/assets/<type>.md` templates for the authored types
    (`lesson, skill, command, agent, knowledge, memory, workflow, script, fact`;
    `wiki`/`env`/`secret` excluded). They live under
    `src/assets/stash-skeleton/facts/conventions/assets/` and are mirrored
    recursively into the stash by `copyStashSkeleton`. `akm init` now seeds
    UNCONDITIONALLY (not only on first create), so re-running it backfills any
    missing skeleton/convention/meta files — absent-only, never clobbering a
    user-edited template. Each template carries `category: convention`, expands
    the matching `TYPE_HINTS` one-liner into soft starter guidance, and states
    in-body that it is advice not enforced. The HARD boundary holds: templates
    carry **no** validator-rejecting rules, so editing/deleting one cannot weaken
    the gate (#645).

Dispatch: `resolveStandardsContext(ref, stashRoot)` (resolve-standards-context.ts) is
**mutually exclusive at the A/B boundary**: genuine wiki page → `loadWikiSchema().body`
(Feature A); non-wiki → `resolveStashStandards()` (general SOFT) **plus the type-scoped
per-type SOFT section appended after it, clearly labeled "soft … guidance, not
enforced"**; wiki `raw/`/infra files → `""`. The per-type layer never fires for wiki
targets. Shipped #642 (beta.36); per-type conventions #646 (beta.38, fixed pending merge).
The HARD/SOFT boundary is intact: per-type facts are advice only and CANNOT weaken the
gate — `authoringRulesForType` remains the sole validator-enforced source.

---

## 5. The footgun list (things that have already cost us)

**F1 — encoding_salience is clobbered every run (THE big one, #644). FIXED pending merge.**
distill writes a real content score; before the fix the improve loop omitted
`encodingSalience`, recomputed the type-stub, and `upsertAssetSalience` overwrote the real
score, so the `#608` high-salience gate read the stub ("high-salience" = "is an
agent/command/skill/lesson").
**Fix (migration `015` + salience.ts + preparation.ts):**
(1) `asset_salience.encoding_source` records provenance — `"content"` (from
`scoreEncodingSalience()` at distill) vs `"type-stub"` (the type-weight fallback);
legacy NULL rows are judged by the differs-from-stub heuristic in
`isContentEncodingRow()`.
(2) `upsertAssetSalience()` refuses to lower a stored `content` score to a `type-stub`
(the `CASE` guards on encoding_salience + encoding_source).
(3) `runImprovePreparationStage()` (preparation.ts) reads the stored row before
`computeSalience()` and, when it is content-sourced, passes `encodingSalience` back in
so the rank score is computed on the real content score too. The type-weight stub
remains the genuine fallback for never-content-scored refs. (preparation.ts
`runImprovePreparationStage()`; salience.ts `upsertAssetSalience()` /
`isContentEncodingRow()`; distill.ts `akmDistill()`; `src/core/state/migrations.ts`
migration `015`)

**F1-follow-up (#655) — the high-salience gate now REQUIRES content provenance.**
Fixing the clobber (above) stopped the stub overwriting real scores, but the gate
itself still admitted on `encoding_salience >= threshold` alone, so any unscored
asset still qualified on its type-weight stub (skill/agent 0.9, command/workflow
0.8, lesson 0.75) — "high-salience" = "is an agent/command/skill/lesson" — which
selected the type-stub `lore-writer` agent every run (prod: 1 content / 37 stub /
1826 NULL). The gate now ALSO requires
`isContentEncodingRow(row, parseAssetRef(ref).type)` (preparation.ts
`runImprovePreparationStage()`, `highSalienceRefs` block), so only genuinely
content-scored rows (and NULL-legacy rows that differ from their type stub) are
admitted; type-stub rows must earn signal via the other lanes. This preserves #608's
intent — distilled assets keep their real content score and still qualify. Unchanged:
threshold, type-weight table, 10% cap, `isContentEncodingRow()`. An aggregated
`[improve] high-salience lane admitted N content-scored ref(s)` log line makes lane
composition observable; measure it after rollout (the skeptic's caveat — the lane
shrinks, by design, until more assets carry content scores).

**F2 — the high-salience gate fires exactly once, then never again.**
`!lastReflectProposalTs.has(r.ref)` (preparation.ts `runImprovePreparationStage()`, the
#643 cooldown) permanently excludes a ref after its first reflect proposal. Auto-accept
emits `promoted`, not `feedback`, so the ref never re-enters via signal-delta. It must
accumulate `retrievalCount>=5` to return via high-retrieval. Newly-distilled
high-salience assets get one pass, then freeze out.

**F3 — the no-op dampener can't fire on a churning ref.**
`resetConsecutiveNoOps()` is called on `reflectResult.ok` (loop-stages.ts
`runImproveLoopStage()`) = "a proposal was generated," not "accepted." A ref that keeps
generating rejected proposals keeps resetting its counter and never hits the `>=3`
dampen threshold (`SALIENCE_NO_OP_DAMPEN_THRESHOLD`, salience.ts). Only genuinely
*silent* assets (no-change) accumulate it.

**F4 — `force:true` on the create CLI path** bypasses dedup/cooldown (§3).

**F5 — repair persists before the write** (§3) — write failure leaves repaired content
with no matching asset.

**F6 — `reflectSizeGuardValidator` is inert at manual-accept time** — its `appliesTo()`
needs `ctx.source.content`, which the `accept` path never populates: `validateProposal()`
(`src/commands/proposal/validators/proposals.ts`) calls `runProposalValidators()` with
no context, and both its callers — `promoteProposal()` and `proposal.ts`'s validation
call site — never populate `ctx.source`
(`reflectSizeGuardValidator`, `src/commands/proposal/validators/proposal-quality-validators.ts`).
A ballooned reflect proposal can be hand-accepted without tripping the shrink/expand
guard.

**F7 — wired-but-dead signals — RE-VERIFIED 2026-07-05, two of the four original
entries are no longer accurate:**
- `review_pressure` — still dead. Computed and persisted by `updateAssetOutcome()`
  (outcome-loop.ts), but nothing in `runImprovePreparationStage()` /
  `runImproveLoopStage()` / `runImprovePostLoopStage()` reads it into any admission
  decision.
- `ValenceScore.lane` (formerly described as `feedbackLane`) — still dead. Computed by
  `computeValenceScore()` (`src/commands/improve/feedback-valence.ts`), called from
  `runImprovePreparationStage()` (preparation.ts) — but only `.valence` and
  `.attention` are read there; the `.lane` ("fix"/"reinforce" routing) field itself is
  never consumed anywhere.
- **CORRECTION — no longer dead:** the `outcome_salience` weight (`outcomeWeightEnabled`)
  defaults **ON**, not OFF (see TL;DR item 5 and §2) —
  `computeSalience()` (salience.ts) selects the WS-2 weights whenever
  `inputs.outcomeWeightEnabled !== false`, and `runImprovePreparationStage()`
  (preparation.ts) mirrors the same `!== false` default when reading the config.
- **CORRECTION — no longer dead:** the proactive `recencyDecay` term is no longer
  pinned to the floor. `runImprovePreparationStage()` (preparation.ts) now fetches real
  `lastUseMs` values via `getLastUseMsByRef()` and passes them into
  `selectProactiveMaintenanceRefs()` (proactive-maintenance.ts), which forwards
  `lastUseMs` into `computeSalience()` — the recency term now reflects genuine
  last-use timestamps for the proactive lane.

Don't assume `review_pressure` or `ValenceScore.lane` influence behavior; DO assume the
outcome weight and the proactive recency term now do.

**F8 — `minPoolSize` default 500** silently skips consolidation on small stashes
(preparation.ts `runConsolidationPass()`). Set `consolidate.minPoolSize:0` to force it.

**F9 — `archiveRetentionDays:0` disables proposal expiry** → unbounded pending queue
(`expireStaleProposals()`, `src/commands/proposal/repository.ts`).

**F10 — multi-cycle stop depends on `gateAcceptedThisCycle`** (improve.ts `akmImprove()`,
the `for (cycleIndex …)` loop). A new pass whose proposals are not auto-accepted never
contributes to termination — cycles run to `maxCycles`.

---

## 6. The brain model (why the pipeline is shaped this way)

`akm improve` is modeled as offline sleep-phase consolidation. Master reference:
`docs/design/improve-self-learning-analysis.md` (repointed 2026-07-05: the prior
reference, `improve-vs-brain-analysis.md`, plus `improve-pipeline-deep-tuning-analysis.md`,
are both archived this batch as superseded BY NAME by `improve-self-learning-analysis.md`
— see `docs/reviews/akm-meta-review/CONTEXT.md`, "From 14 docs-consolidation"). Mapping
(abridged):

| brain stage | AKM analog | status |
|---|---|---|
| sensory firehose | session logs → extract | aligned |
| attention gate | curate/search top-K | aligned |
| hippocampal encoding | extract → pending proposal | aligned |
| **amygdala salience tagging** | feedback + retrieval + utility | **Gap 1** (exogenous & sparse; #608/#644) |
| NREM replay (episodic→semantic) | consolidate + distill | aligned |
| REM divergent recombination | recombine (#625), graph/inference | Gap 4 (gated, weak) |
| glymphatic clearance | cleanup / archive / forgetting | Gap 6 (under-powered) |
| procedural/implicit | procedural pass | Gap 5 (default-OFF, over-fits, #634) |
| **predictive model / prediction-error** | passive retrieval; WS-2 outcome loop | **Gap 2** (narrowing: outcome weight is now default **ON** as of R1 2026-07-02 — was the biggest gap when this table was drafted at "outcome weight OFF"; see §2/TL;DR item 5) |
| closed reconsolidation loop | usage→proactive eligibility | Gap 2/3 |

**The one intentional divergence to PRESERVE: no lossy reconsolidation.** The brain
rewrites memories on recall (drift, confabulation); AKM preserves raw assets + additive
distill + the #580 no-op gate + git history. Backed by research showing iterated LLM
rewriting failed 54% of previously-solved tasks. **Do not** introduce in-place lossy
rewrites.

**Design principles that are load-bearing — don't undo them:**
1. **LOOK/CHANGE separation** — liberal selection, gated change. (improve-proactive-
   maintenance.md; the budget-cap design was tried and removed in 4c1700b2.)
2. **Signal-delta gate stays** — fixed the 2026-05-26 synchronized-wave incident
   (6a5e0ca4). "Usage is the gate; rate control is the scheduler's job."
3. **Salience is a 3-vector, scalarized only for ranking** — three independent reviews
   rejected a single scalar.
4. **Success metric = coverage + accepted-change rate, NOT promotion volume.** Promotion
   volume rewards churn and risks the 54% drift. (akm-improve-success-metric memory.)

---

## 7. Open issues map (as of beta.36)

| issue | state | one-liner |
|---|---|---|
| **#644** | FIXED (pending merge) | high-salience gate selected on type-weight stub, not content score (F1). Fixed via `encoding_source` provenance (migration 015) + non-lowering `upsertAssetSalience` + loop read-back. |
| **#646** | FIXED (pending merge) | per-type SOFT convention facts (`facts/conventions/assets/<type>.md`) via `resolveTypeConventions`, type-scoped, validated by `getAssetTypes()`; built-in TYPE_HINTS fallback kept; general resolver now excludes `conventions/assets/*` to stop cross-type leak; soft-only (HARD rules stay in #645). |
| #642 | MERGED b36 | standards delivery (Feature A wiki schema + Feature B stash conventions). |
| #645 | MERGED b36 | unify authoring rules into validator-sourced seam; fix stuck-proposal loop + drain masking. |
| #643 | MERGED b36 | once-per-asset cooldown on high-salience gate (F2). |
| #608 | CLOSED→0.10 | automatic encoding-time salience scoring (Gap 1 origin; only partially realized). |
| #632 | FIXED | recombine clusters = whole-stash tag buckets → bland hypotheses. Three parts: (a) graph-entity clustering DEFAULT (`relatednessSource` "tags"→"both") + `isJunkEntity`/`excludeEntities` hygiene; (b) ROOT FIX — exclude session-capture telemetry memories (`<harness>-(session\|checkpoint)-<YYYYMMDD>-<id>`, `akm_memory_kind: session_checkpoint`, ~20% of the pool) whose embedded metadata block was the source of every top noise entity; (c) SELECTION BLEND (found in review) — `selectClustersForRun` ranks `entity:` clusters ahead of `tag:` clusters (auto-tokenized filename tags are generic at every size) BUT reserves `RESERVED_TAG_SLOTS`=3 of the per-run budget for tags so tag-only topics are never starved (entities never starved below 1 slot either); reserved tags prefer TIGHTER clusters (≤`TAG_RESERVE_SOFT_CAP`=20) over broad `tag:<project>` mega-buckets; either kind backfills if the other is short; tags-only stash = capClusters parity. On live data the processed slice becomes ~2 entity (print-md, openpalm) + 3 tight tags (cli, gate, guide) instead of 5 bland `tag:<project>` mega-buckets. Tag fallback covers memories with no graph entity. |
| #633 | OPEN (fix shipped b30) | recombine confirmation loop was structurally dead (member-set hash reset streak); Jaccard match fixed it — likely closeable. |
| #634 | OPEN | procedural over-fits single-project sequences; default-OFF until cross-project gate + identifier-stripping land. |
| #636 | OPEN | reflect emits proposals missing `description` for source docs lacking one (14/16 rejects in one pass). |
| #637 | CLOSED (reverted) | "skip improve-review sessions" — built on a bad number (386 sessions = ONE Workflow run). Verify per-day counts before sizing fixes. |
| #638 | OPEN/superseded | accept-boundary cooldown; superseded by select-time `filterProactiveDue` (cooldown belongs at SELECT, before the wasted LLM call). |
| #611 | OPEN→0.10 | hierarchical abstraction for lesson clusters (Gap 4 continuation). |

---

## 8. When you modify improve/salience code — checklist

- [ ] Does your change read or write `encoding_salience`? Remember it's clobbered every
      run (F1). Don't build on the stored value without fixing the overwrite.
- [ ] New eligibility lane? Add it to `EligibilitySource` (`src/core/improve-types.ts`),
      stamp it at partition time, AND add it to the post-lock cooldown re-filter
      (improve.ts `akmImprove()`, the `reflectDistill.lock` callback).
- [ ] New auto-accepting pass? It must feed `gateAcceptedThisCycle` or multi-cycle
      termination breaks (F10).
- [ ] Touching consolidation/extract order? Consolidation MUST precede extract (§1).
- [ ] New validator finding? Decide error vs `warn` explicitly — default (no severity) is
      blocking.
- [ ] New hard bound? Put it in `authoring-rules.ts` and assert prompt↔validator parity in
      `tests/authoring-rules*`.
- [ ] Verify with `bun run check` (0 errors / 0 warnings / 0 failures) before commit.
- [ ] Sizing a fix from session/proposal counts? Verify **per-day generation** counts and
      session file paths first (`workflows/wf_*` = Workflow tool, not recurring CLI). See
      akm-verify-impact-against-artifacts.
