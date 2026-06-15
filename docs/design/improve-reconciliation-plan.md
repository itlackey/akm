# `akm improve` — 0.9 reconciliation plan

> Companion to `improve-vs-brain-analysis.md` (the master map) and
> `improve-proactive-maintenance.md`. Written 2026-06-15 after the 0.9
> improve-tuning round splintered; **revised 2026-06-15** to fold in the
> three-reviewer critical review (`improve-reconciliation-plan-review.md`). This
> plan converges that round's scattered work onto a coherent architecture
> **without** abandoning the goal or reverting to the pre-0.9 state that already
> wasn't working.
>
> Revision note: the first draft's headline perf fix ("reuse the index's
> embeddings for dedup") was **wrong** — the index embeds metadata + TOC headings
> via `buildSearchText`, not memory bodies — so WS-3 below specifies a real fix (a
> content-hash-keyed body-embedding cache). Other corrections from the review are
> folded in inline and flagged `[rev]`.

## Part I — How it went off course (the explanation)

The brain-analysis doc states it plainly (§"How this session's work maps"): the
0.9 improve work — proactive lane, retrieval-as-salience, the kill-criterion,
LOOK/CHANGE — are **symptomatic fixes for Gaps 1 & 2** (no endogenous
encoding-time salience; no per-asset outcome loop). Each patch was built in
isolation, in its own module, on its own cadence.

The failure mode that produced "splintering":

1. **Every patch invented its own version of the same mechanism.** "What deserves
   attention" (salience, Gap 1) is now computed **three+ independent ways over
   the same inputs**:
   - `proactive-maintenance.ts:186` — `importance × log(1+retrievalFreq) × recencyDecay / log10(size)` (note: `recencyDecay` is currently **dead** — the caller at `improve.ts:2700` never passes `lastUseMs`, so the term is pinned to its floor)
   - `feedback-valence.ts:111` — `combinedEligibilityScore = utility·0.7 + valence·0.3` (#614, used at `improve.ts:2855`)
   - `applyFeedbackToUtilityScore` / `getUtilityScoresByIds` — MemRL utility EMA (#386)
   - plus `negativeOnlyRatio` (legacy, `improve.ts:2846`), raw retrieval-count, the high-retrieval fallback, the signal-delta gate.

   "Did improvement help" (outcome / prediction-error, Gap 2) is computed **three
   disjoint ways**: the population kill-criterion (`akm-eval`), #612 gate
   calibration, and (planned) #613 reconsolidation pressure — none of which is
   the per-asset usefulness loop the doc names as the #1 fix.

2. **Each came with its own config knob, hash, loader.** Four new
   default-off knobs this round (`dedup`, `judgedCache`, `symmetricValence`,
   `calibration`); **two** divergent content-hash *purposes* (`dedup.ts:106-117`
   lowercases+collapses for case-insensitive twin detection;
   `consolidate.ts:1087` and the pending-proposal hashes at `623/682` are
   case-/whitespace-preserving for change-detection); two memory loaders
   (`loadDedupMemories` at `dedup.ts:129` includes `.derived`; consolidate's
   `loadMemoriesForSource` at `consolidate.ts:2708` excludes them). Separately,
   `eligibilitySource` (selection-origin lane) and the **dangling** `feedbackLane`
   (set at `improve.ts:2842`, never read) are *orthogonal* fields, not competing
   taxonomies — but `feedbackLane` does nothing today.
   `[rev]` (`extract.maxSessionsPerRun` is **not** a new default-off knob — it is
   default-on at 25; it is supporting infra, see Part III.)

3. **My earlier "reconciliation" made it worse by aiming to revert** — folding
   #617 away and leaning on the existing LLM `consolidate`, i.e. retreating to
   the exact state that already couldn't keep up with 2,589+ memories (the reason
   this work exists). That mistook *one weak patch* for *the goal*.

**Thesis:** the fix is not to delete the patches and not to add a sixth. It is to
**converge them onto two seams — one salience score, one outcome loop — plus one
consolidation pipeline**, so the *real* Gap-1/2/4/5/6 work (0.10+) extends a
single coherent thing. Governed by the one non-negotiable divergence
(doc §"No lossy reconsolidation"): **never adopt lossy reconsolidation — keep raw
assets, change only through the gate.** `[rev]` (Caveat — see WS-3/Part V: the
current archive is TTL-deleted at `archiveRetentionDays`, default 90, so
"recoverable" is bounded; this plan exempts dedup/consolidate archive entries
from the TTL.)

## Part II — Target architecture: five seams

`[rev]` Each gap now maps to a seam **or** is explicitly deferred — no gap is
silently omitted (the first draft dropped Gaps 3, 5, and the decay half of 6).

| Seam | Brain stage / gap | Single coherent mechanism it should become |
|---|---|---|
| **S1 Salience** | 03b amygdala / Gap 1 (retrieval-time) | One per-asset `salience` score combining importance, retrieval, recency, valence, utility, and a (WS-2-fed) outcome term. Every selector READS it. *Encoding-time seeding (Gap 1 at `extract`) and Gap 3 schema-priming are extensions, deferred to 0.10+ — see below.* |
| **S2 Outcome loop** | 07 + ⟳ / Gap 2 | One per-asset "was this retrieval useful" signal → the dominant salience update. Calibration + verdict are *views* of it. (WS-2 establishes the seam + schema; the live signal is 0.10+.) |
| **S3 Consolidation pipeline** | 04 NREM / Gap 4 (recombination) | Tiered: cheap deterministic dedup → judged-cache-covered LLM merge → distill→lessons. One strip primitive, one loader, a shared body-embedding cache. |
| **S4 CHANGE gate** | (the non-negotiable) | One mutation gate: no-op/cosmetic suppression + per-phase auto-accept + recoverable archive; thresholds resolved in `makeGateConfig`. |
| **S5 Attribution / observability** | auditability (correct divergence, not a gap) | One taxonomy (`eligibilitySource`); telemetry / pool-saturation / calibration are health *views*. (Cross-cutting, not a brain-gap seam.) |

**Gaps without a seam home — explicitly deferred (not omitted):**
- **Gap 1 encoding-time seeding** — needs `extract` to persist an intrinsic
  importance/novelty score at capture (new field). Extends S1; 0.10+ (#608).
- **Gap 3 schema-primed extraction** — needs `extract` to read existing schemas
  and harvest novelty/contradiction. Lives in `extract`, not in S1's score. 0.10+.
- **Gap 5 procedural compilation** — detect recurring action sequences → propose
  skills/workflows. New pipeline stage feeding S3/S4. 0.10+ (#615).
- **Gap 6 forgetting/decay** — decay retrieval *priority* + archive (never delete
  content). **Partial today:** the consolidate archive TTL (`consolidate.ts:2267`)
  is a crude eviction; Gap-6 work must *extend* that, not add parallel eviction.
  Touches the stash index + state.db, not just S3. 0.10+.

## Part III — Inventory: every 0.9 improve change → its seam (nothing orphaned)

- **S1 Salience:** proactive selector + priority formula; `eligibilitySource` attribution; signal-delta gate + high-retrieval (P0-A) fallback; #614 valence (`combinedEligibilityScore`/`negativeOnlyRatio`/the dangling `feedbackLane`); utility EMA (#386); `getRetrievalCounts`; pool-saturation advisory (#603, observability of starvation).
- **S2 Outcome loop:** kill-criterion + `akm-eval` + `proactive-verdict`; #612 calibration + auto-tune; #613 reconsolidation pressure (planned — subsumed by the WS-2 seam; do not build separately); `proactive_selected`/`proactiveDueTotal`/`proactiveNeverReflected`.
- **S3 Consolidation:** `consolidate` LLM cluster+merge; #617 dedup; #581 judgedCache; #604 hot-probation intake buffer (write-path dedup — a tier of this pipeline, currently unbuilt/deferred); `incrementalSince`/`neighborsPerChanged`/`limit` (beta.6); distill + `requirePlannedRefs`; memoryInference + `minPendingCount`; the content-hash variants. *Gap 4 recombination + Gap 6 decay = future stages (see Part II).*
- **S4 CHANGE gate:** #580 empty-diff/cosmetic suppression; auto-accept gate + #577 gate-decisions + `failedByReason`; #612 threshold; #617 archive-before-delete.
- **S5 Attribution/observability:** `eligibilitySource`; LLM telemetry (#576); pool-saturation (#603); skip-reason aggregation fix; the health-report overhaul (taskId join, slice filter, deltas, snapshot-summing fixes).
- **Supporting infra (correct, not a seam — leave as-is):** `extract.maxSessionsPerRun` (#2, **default-on at 25**); `minContentChars`/`minNewSessions` (#595/#596/#554); extract active-profile gate (#593/#594); #607 per-process locks + non-blocking ensureIndex; journal sessionId (#599); consolidate event schema (#600); extract negative-examples (#601); config round-trip (#598).

## Part IV — Reconciliation work items

> **Every behavior-changing WS is gated on the Measurement protocol in Part V.**
> "Full `bun run check`" is necessary but not sufficient.

### WS-1 — Unify the SALIENCE model (S1)
**Splinter:** 3+ attention formulas (above) over overlapping inputs, in 3 modules.
**Target:** a single `salience(ref)` function/seam (new `src/commands/improve/salience.ts`) combining the inputs into one documented score.

**`[rev]` Spec — the unified formula (resolve before coding, not during):**
- **Output range:** normalize to `[0,1]` (the eligibility sort already lives there; the proactive formula does not). Map the proactive components into bounded terms: `importanceTerm`, `retrievalTerm = log(1+retrieval)/log(1+RETRIEVAL_CAP)`, `recencyTerm`, `valenceTerm = |valence|`, `utilityTerm = utility EMA`, `outcomeTerm` (WS-2, 0 until filled), `sizePenalty` (the `1/log10(size)` factor as a multiplier in `(0,1]`).
- **Weights:** start from the two existing weightings (`utility·0.7 + valence·0.3`) and the proactive product form; pick **one** documented combination (recommended: weighted sum of normalized terms × `sizePenalty`) with constants named in the file. Treat the exact weights as a tuning parameter measured per Part V, not a guess shipped blind.
- **Dead-input resolution `[rev]`:** the `recencyTerm` depends on `lastUseMs`, which is **never wired** today. Either (a) wire it — specify the source query (last-retrieval timestamp from the index/state.db) — or (b) drop the term. Do not carry a pinned-to-floor input into the canonical formula.
- **Lane preservation `[rev]`:** the three selection lanes (signal-delta, high-retrieval/P0-A, proactive) survive as **`eligibilitySource` labels over one ranking** — they all call `computeSalience`; the partition identity is retained for telemetry (do not collapse into an anonymous ranked list, which would break S5).

**Steps:**
1. Extract one `computeSalience(inputs)` per the spec above; fold in `proactive-maintenance.ts:186` and `feedback-valence.ts`'s `combinedEligibilityScore`.
2. Proactive selection (`proactive-maintenance.ts`) and the eligibility sort (`improve.ts:2855`) both call it — delete the parallel formulas and the legacy `negativeOnlyRatio` branch (`improve.ts:2834-2846`); symmetric-valence becomes the only path (drop the `symmetricValence` toggle, with the migration in WS-1 step 4).
3. Keep `eligibilitySource` lanes; **remove** the dangling `feedbackLane` (it is never read; lane-aware reflect/distill routing is filed as 0.10+ work, not silently folded).
4. **`[rev]` Migration + versioning:** removing `symmetricValence` is a behavior change for the whole user base (default was `false` = negative-only). Warn if the key is present in config, add a CHANGELOG migration line, regen `schemas/akm-config.json` via `bun scripts/gen-config-schema.ts`, update config round-trip tests. Ship behind the next minor (0.10), not a patch.
5. Leave a documented `outcomeTerm` input at 0 (wired by WS-2).
**Outcome:** one salience score; the proactive lane, eligibility sort, and valence stop disagreeing. Default behavior will shift (valence-on, unified) — gated by the Part V measurement, not parity.

### WS-2 — Unify the OUTCOME loop (S2)
**Splinter:** verdict (population) + #612 calibration (gate) + #613 (planned), disjoint.
**Target:** one per-asset outcome signal seam (the doc's #1 fix) that WS-1's `salience.outcomeTerm` reads.

**`[rev]` Scope for 0.9 — establish the seam, ship a real-but-coarse signal:**
- **Persist to existing `state.db`** (not a new file). New migration adds table
  `asset_outcome` (columns: `asset_ref TEXT`, `last_retrieved_at INTEGER`,
  `retrieval_count INTEGER`, `negative_feedback_count INTEGER`,
  `accepted_change_count INTEGER`, `outcome_score REAL`, `updated_at INTEGER`).
  Specify the DDL in the migration, extend `ensureSchema`, add isolation-helper tests.
- **v1 signal that exists today:** `outcome_score` from the **retrieval-count
  delta since last improve run** (available now via `getRetrievalCounts`) minus a
  penalty for negative feedback. This is intentionally coarse but **non-zero**, so
  WS-1's `outcomeTerm` is actually exercised rather than a permanent stub.
- **Known validity gap (documented, not hidden):** "led to an accepted change" is
  *not* a clean usefulness proxy (a confirming asset is useful yet yields no
  change). The rich in-session retrieve→act→outcome trace is **0.10+** (Gap 2
  proper); v1 deliberately uses the retrieval-delta proxy and says so.
**Steps:**
1. Add the `asset_outcome` table + writer (updates on each improve run from retrieval counts + feedback).
2. WS-1's salience reads `outcome_score` as the `outcomeTerm`.
3. #612 calibration becomes a *consumer/view* of this loop — see WS-4 for the threshold reroute (merged there to avoid a circular dependency).
4. The kill-criterion verdict stays as the population guardrail, not a competing per-asset signal.

### WS-3 — Unify the CONSOLIDATION pipeline (S3)
**Splinter:** #617 (own hash/loader/embed), #581 judgedCache, consolidate (own hash/embed), `incrementalSince`/`neighborsPerChanged`/`limit`, divergent hashes.
**Target:** tiered pipeline, shared primitives.
**Steps:**
1. **One strip primitive, two hash wrappers `[rev]`:** export a shared
   `stripFrontmatterBody()`; build `dedupHash()` (lowercase + whitespace-collapse,
   for case-insensitive twin detection) and `cacheHash()` (case/whitespace
   preserving, for change-detection) on top of it. A single hash **cannot** serve
   both (case-insensitive breaks the judged-cache; case-sensitive misses dedup
   twins). Replace `dedup.ts:106-117` with `dedupHash`, and `consolidate.ts:1087`
   + pending-proposal hashes (`623/682`) with `cacheHash`.
2. **One loader + a body-embedding cache `[rev — corrected]`:** unify on
   consolidate's loader with an `includeDerived?: boolean` param (dedup needs the
   `.derived` children; consolidate excludes them). For embeddings, **do NOT reuse
   the index vectors** — the index embeds `buildSearchText`
   (`search-fields.ts:77` = name+description+tags+hints+**TOC-headings**, lowercased),
   not the memory body, so it is the wrong comparison domain. Instead add a
   **`cacheHash`-keyed body-embedding cache** (state.db table or sidecar) so dedup
   *and* consolidate embed only **changed** bodies and reuse the rest across runs.
   This is the real fix for #617's ~200s and consolidate's recompute (`dedup.ts:405`,
   `consolidate.ts:537`).
3. **Bound the compare `[rev]`:** `planDedup`'s twin matching is O(n²)
   (`dedup.ts:252-268`) — independent of embedding source. Scope it to the
   judged-cache-miss pool (capped by `limit`) so the compare doesn't become the new
   bottleneck on large stashes.
4. **Tiers:** dedup = cheap deterministic tier (exact `dedupHash` + cached-embedding
   cosine over the bounded pool) that prunes → LLM `consolidate` merges the
   ambiguous remainder. #617 stays as the tier, fixed; it is *not* dropped.
5. **Coverage model `[rev — corrected]`:** `judgedCache` and incremental narrowing
   **compose, not replace**. Keep `incrementalSince`/`neighborsPerChanged` as the
   *candidate-selection* layer (it pulls in embedding-similar **neighbours** of
   changed memories via `getNeighborsByEntryId` — semantic context `judgedCache`
   has no equivalent for); `judgedCache` then *skips already-judged unchanged*
   content within that pool. Document the cold-start cost (empty judged-cache → a
   `limit`-bounded full sweep on first run). `limit` stays as the safety cap.
6. distill→lessons unchanged. Gap 4 (recombination) and Gap 6 (decay) are future
   stages (Part II). **Reconcile Gap-6 with the existing archive TTL** rather than
   building parallel eviction.

### WS-4 — CHANGE-gate coherence (S4) + calibration reroute (was split with WS-2)
`[rev]` **Real work, not "mostly verification."**
**Steps:**
1. **Per-phase thresholds:** `maybeAutoTuneThreshold` (`improve.ts:1034`) currently
   mutates a single global `options.autoAccept` shared by all phases (it does *not*
   "bypass" `makeGateConfig` — the value is passed in and may be clamped by
   `minimumThreshold`; the real defect is the lack of per-phase resolution).
   Resolve thresholds per-phase inside `makeGateConfig`.
2. **Tuned-threshold home:** when the global mutation is removed, persist the
   auto-tuned threshold (state.db, keyed by phase) and have `makeGateConfig` read
   it — otherwise auto-tune silently stops working. Calibration (#612) becomes a
   reader of WS-2's outcome loop + this store.
3. **Route dedup archival through the gate:** #617's `onArchive` callback
   (`dedup.ts` → consolidate) is currently a direct callback, not a gate decision.
   Either route it through the one CHANGE gate or document it as an intentionally
   separate, audited path.
4. Confirm #580 suppression, auto-accept + #577 decisions + `failedByReason`, and
   archive-before-delete flow through the one gate with recoverable archive.
5. **Archive recoverability `[rev]`:** exempt dedup/consolidate archive entries
   from the `archiveRetentionDays` TTL hard-delete (`consolidate.ts:2267-2290`), or
   surface the TTL prominently in the health report. The non-negotiable requires
   genuine recoverability, not a 90-day window.

### WS-5 — Attribution/observability (S5)
**Steps:** `eligibilitySource` is the one taxonomy; `feedbackLane` is removed in
WS-1 step 3 (not deferred to here); telemetry (#576), pool-saturation (#603),
calibration health, skip-reason aggregation are confirmed as *views* of the
unified S1/S2 model. Mostly cleanup once WS-1/2 land.

## Part V — Sequencing, measurement, constraints, scope

**Order `[rev]`:** WS-3 (consolidation: strip+hashes + body-embedding cache +
bounded tiers + composed coverage — fixes the real perf bug and the dup pipeline)
→ WS-1 (salience unification + `feedbackLane` removal + knob migration) → WS-2
(outcome seam + table + coarse signal) → **WS-4 (gate coherence + calibration
reroute, depends on WS-2's outcome store)** → WS-5 (observability cleanup). WS-3
is independent and delivers the dedup the maintainer asked for, properly; do it
first. WS-2 is the brain doc's #1 priority but is sequenced after WS-3/WS-1
because its *live* signal is 0.10+ work; the 0.9 deliverable is the seam + coarse
proxy, which has no value until WS-1 reads it.

**`[rev]` Measurement protocol (gates every behavior-changing WS — WS-1, WS-2,
WS-4):**
1. **Baseline (T0):** before WS-1, snapshot the current stash via the existing
   `scripts/akm-eval` harness + the health report; record coverage (share of
   eligible assets processed with an accepted proposal) and accepted-change-rate.
2. **Per-WS gate:** after each behavior-changing WS, re-run
   `scripts/akm-eval/bin/akm-eval-run` + `…-proactive-verdict`. **PASS requires:**
   proactive accept ≥ 0.9× reactive, reversion ≤ 0.15, retrieval-delta ≥ 0, and
   coverage/accept-rate not regressed vs T0.
3. **Timeout-sizing check:** any WS that changes how many assets a run selects must
   re-verify `reflect.limit ≤ (timeoutMs/1000)/100` (per the beta.9 SIGTERM lesson).
4. **Rollback:** if a WS fails the gate, revert that WS's behavior change (keep the
   structural refactor) and re-tune before re-shipping. "Default may shift" is only
   acceptable when the gate confirms it didn't regress.

**Per step:** full `TEST_PARALLEL=1 bun run check`; new tests use sandbox helpers;
schema regen for any config change; rebuild `dist`. No agent-velocity pile-on —
one seam at a time, reviewed.

**Non-negotiable (doc §"No lossy reconsolidation"):** keep raw assets; change only
through the gate; no lossy reconsolidation. Every WS preserves this — and WS-4
step 5 closes the archive-TTL hole that currently undercuts it.

**Out of scope here (forward roadmap, 0.10+ — the *real* Gap closures these seams
enable):** Gap 1 encoding-time salience seeding at `extract` (#608); Gap 2 rich
in-session outcome capture; Gap 3 schema-primed extraction; Gap 4 REM
recombination (#609); Gap 5 procedural compilation (#615); Gap 6 forgetting/decay
(extends the existing archive TTL — needs a new issue). This plan makes each of
those **extend one seam (or one documented deferral)** instead of adding a sixth
competing signal.
