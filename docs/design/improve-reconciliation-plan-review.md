# Critical review — `improve-reconciliation-plan.md`

> Consolidated, deduplicated, and verified findings from three independent
> critical reviews (goal-alignment lens, code-accuracy lens, executability lens),
> 2026-06-15. Each finding notes which reviewers raised it, my independent
> verification result, severity, and the concrete correction the plan needs.
>
> **Verdict:** the plan's *diagnosis* (competing salience formulas, disjoint
> outcome proxies, fragmented consolidation) is sound and well-grounded. But the
> headline fix in WS-3 (reuse index embeddings to kill the 200s) is **factually
> broken**, the plan's central architectural promise ("every gap extends one
> seam") **does not hold for 3 of 6 gaps**, and WS-1/WS-2 are **underspecified to
> the point of being unimplementable without inventing key decisions**. Fix these
> before executing.

---

## A. Verified-true blockers (must fix the plan before executing)

### A1. WS-3 "reuse index embeddings" is architecturally wrong — the index does not embed memory bodies — **CRITICAL**
*Raised by: code-accuracy #17, executability #1/#8. Independently verified.*

The plan's headline perf fix (WS-3 step 2): "dedup … reads embeddings from the index (`index.db`) instead of `embedBatch` recompute … This kills #617's ~200s."

**Verified against code:** the index embedding is generated from `buildSearchText` (`src/indexer/search/search-fields.ts:77`), which concatenates `name + description + tags + hints + content`, where `content` (per `buildSearchFields`) is **TOC headings + parameter names only**, lowercased — **not the memory body**. Dedup (`dedup.ts:405`) embeds `normalizeMemoryBody` = the full frontmatter-stripped body. These are different text domains. Substituting the index vector would make dedup's cosine similarity operate on metadata, not content — silently collapsing or sparing the **wrong** pairs.

Two further problems compound this:
- **No retrieval API exists.** `db.ts` has no `getEmbeddingByFilePath`/bulk getter; retrieval is a two-step `getEntryIdByFilePath` → `SELECT embedding`. New plumbing is required and is not in the plan.
- **The 200s is partly the O(n²) compare, not just the embed.** `planDedup`'s twin loop (`dedup.ts:252-268`) is O(n²) over the pool; removing `embedBatch` time does not remove compare time. On a 2,589+ memory stash the compare may become the new bottleneck.

**Correction:** drop the "reuse index embeddings" claim. Replace with a real fix: (a) **persist body-text embeddings** keyed by content-hash in `state.db` (or a dedicated cache) so dedup and consolidate reuse them across runs and only embed *changed* bodies; and/or (b) gate dedup's embed/compare to a **bounded pool** (only judgedCache-miss memories, capped). Either way, specify the new storage + retrieval API. This is the single most important correction — the current WS-3 step 2 cannot deliver what it claims.

### A2. "One content-hash" conflates two hashes that serve different purposes — **MAJOR**
*Raised by: goal-alignment #10, code-accuracy #6/#25, executability #12. Verified.*

WS-3 step 1 says export one `memoryContentHash()` to replace `dedup.ts:106-117`, `consolidate.ts:1087`, and the pending-proposal hashes (`623/682`). Verified: dedup's hash is **case-insensitive + whitespace-collapsed** (its job: collapse "same content, different formatting" twins). Consolidate's `computeMemoryContentHash:1087` is **case-/whitespace-preserving** (its job: detect *any* content change to invalidate the judged-cache). Lines 623/682 share consolidate's trim-only normalization — so there are **two** normalization domains, not three.

A single normalization cannot serve both: case-insensitive applied to the cache yields false "unchanged" hits (a casing edit escapes re-judgement); case-sensitive applied to dedup misses case-only duplicates.

**Correction:** "one hash" should mean **one shared frontmatter-stripping primitive**, then two thin wrappers — `dedupHash()` (case-insensitive) and `cacheHash()` (case-preserving). Say so explicitly. Note the migration hazard (A5).

### A3. `maxSessionsPerRun` mislabeled "default-off" — **MAJOR (factual error in the diagnosis)**
*Raised by: code-accuracy #19. Verified.*

Part I §2 lists five "new default-off knobs" including `maxSessionsPerRun`. Verified: `extract.ts:82` sets `DEFAULT_MAX_SESSIONS_PER_RUN = 25` and it is applied unless overridden (`0` disables) — it is **default-on**. The actual new default-off knobs are four (`dedup`, `judgedCache`, `symmetricValence`, `calibration`). Minor in isolation, but it is a factual error in the section that establishes the plan's credibility.

**Correction:** move `maxSessionsPerRun` out of the default-off list; it is supporting infra (already correctly listed in Part III's "leave as-is" bucket — Part I contradicts Part III).

### A4. `judgedCache` does **not** losslessly replace `incrementalSince` + `neighborsPerChanged` — **MAJOR**
*Raised by: goal-alignment #9, code-accuracy #18, executability #16. Verified mechanism.*

WS-3 step 4 asserts `judgedCache` "replaces" the incremental narrowing. Verified: `narrowToIncrementalCandidates` (`consolidate.ts:~2664-2700`) pulls in **embedding-similar neighbours of changed memories** via `getNeighborsByEntryId` — so an unchanged memory adjacent to a changed one still gets re-judged *in context*. `judgedCache` skips by content-hash with **no neighbour awareness**, so it loses that semantic expansion. They also differ at cold start: an empty judgedCache re-judges the **entire corpus** on first run (bounded only by `limit`), which `incrementalSince` would have scoped.

**Correction:** don't claim equivalence. Either (a) keep `incrementalSince`/neighbour-expansion as the *candidate-selection* layer and let `judgedCache` *skip already-judged* within it (they compose — they are not substitutes), or (b) explicitly accept the loss of neighbour-expansion and the cold-start full-sweep, and document why that's acceptable. Note the cold-start cost regardless.

### A5. Config-knob removals (`symmetricValence`, `incrementalSince`, `neighborsPerChanged`) have no deprecation/migration path — **MAJOR**
*Raised by: executability #4/#5/#15. Valid.*

These live in `config-types.ts`, `config-schema.ts`, and `schemas/akm-config.json` (across all profile slots). The plan removes them with no deprecation warning, no CHANGELOG note, no `bun scripts/gen-config-schema.ts` regen step, and no config-round-trip test update. Users who set them to preserve behavior will silently get the new behavior; the JSON schema will drift from the TS types until a build runs; existing round-trip tests may fail. Per the project's release gate, schema regen + round-trip is mandatory.

**Correction:** for each removed knob add: warn-if-present, CHANGELOG migration line, schema regen as a completion criterion, and a recommended replacement (`incrementalSince` → `judgedCache.enabled`).

### A6. The dedup archive is **not** permanently recoverable — TTL hard-deletes at 90 days — **MAJOR**
*Raised by: executability #11/#18. Verified.*

Part V's non-negotiable is "keep raw assets … no lossy reconsolidation," and WS-3/WS-4 lean on "archive-before-delete" to satisfy it. Verified: `consolidate.ts:2267-2290` TTL-cleans the archive with `fs.unlinkSync` for entries older than `archiveRetentionDays` (**default 90**). So a memory dedup'd >90 days ago is permanently gone. "Recoverable" is true only within the retention window. This is also a direct collision with the global data-safety stance (archive ≈ trash, but TTL ≈ rm).

**Correction:** state plainly that recoverability is bounded by `archiveRetentionDays`. Decide: surface the TTL in the health report, and/or exempt dedup/consolidate archive entries from TTL, and/or raise the default. Don't assert unbounded recoverability the code doesn't provide.

### A7. The proactive recency term is **dead code** the plan treats as a live input — **MAJOR**
*Raised by: executability #9. Verified.*

WS-1 folds `proactive-maintenance.ts:186`'s formula (which includes `recencyDecay` from `lastUseMs`) into the unified `computeSalience`. Verified: the caller `selectProactiveMaintenanceRefs` (`improve.ts:2700`) **never passes `lastUseMs`**, so `params.lastUseMs?.get(ref) ?? 0` is always 0 → `recencyDecay` is always its floor. The unified formula therefore inherits a dead input. WS-1's "preserve the inputs" framing is not behavior-preserving — one input is currently inert.

**Correction:** WS-1 must decide per input whether to wire it (specify the `lastUseMs` source query) or drop it. Don't carry dead terms into the "one true" formula.

---

## B. Verified-true gaps in the plan's architecture & specification

### B1. The central promise "every gap extends one seam" is false for Gaps 3, 5, and the decay half of 6 — **CRITICAL (doc-level)**
*Raised by: goal-alignment #2/#6/#7/#8. Cross-checked against `improve-vs-brain-analysis.md` + memory.*

- **Gap 3 (schema-primed extraction)** is silently omitted: not in the seam table mechanism, not in Part III, **absent from Part V's out-of-scope list** (which lists 1,2,4,5,6 but not 3). Gap 3 lives in `extract`, not in a salience score.
- **Gap 5 (procedural compilation)** appears once in Part V ("#615") with **no seam assignment**.
- **Gap 6** is split: S3 hosts it, but S3's steps are all hash/loader/tier/cache — nothing about retrieval-priority decay or eviction, which touch the stash index + state.db, not the consolidation pipeline.

**Correction:** either assign each of Gaps 3/5/6-decay to a concrete seam (and say which module), or explicitly mark them out-of-scope with a forward issue. Don't claim one-seam-each when three gaps have no home.

### B2. S1 says "seeded at encoding (`extract`)" but no WS step implements encoding-time seeding — **MAJOR**
*Raised by: goal-alignment #3/#13. Valid.*

WS-1's steps all fold **selection-time** formulas (proactive, eligibility sort, valence, utility EMA). None adds a call from `extract` to persist an intrinsic importance/novelty score at capture — which is Gap 1's actual fix per the brain doc. "Seeded at encoding" is aspirational copy with no implementation step or new persisted field.

**Correction:** either add an explicit encoding-time-seed step (new field + `extract` write) to WS-1, or remove "seeded at encoding" from S1 and list it under Gap-1 future work.

### B3. WS-1's unified formula is mathematically unspecified — incompatible quantities, no weights, no range — **CRITICAL (executability)**
*Raised by: executability #3/#19. Valid.*

The proactive formula is an unbounded rate-per-log-byte: `(importance × log(1+retrieval) × recencyDecay) / log10(size)`. The eligibility score is a bounded `utility·0.7 + |valence|·0.3 ∈ [0,1]`. WS-1 says "fold them into the same function" without specifying output range, how utility-EMA maps to the `importance·log(1+retrieval)` term, or the new weights. Two implementers would produce two different formulas; any choice silently re-orders selection for every user.

Also unresolved (executability #19): does WS-1 preserve the three eligibility **lanes** (signal-delta / high-retrieval / proactive, each with its own `eligibilitySource`) or collapse them into one ranked list? Collapsing breaks the `eligibilitySource` telemetry WS-5 says to keep; preserving means three paths still call one function (less "unified" than implied).

**Correction:** specify the exact unified formula — output range, per-input weights, the utility→importance mapping — and state that the three lanes survive as *labels* over one ranking. Gate behind a behavior-change measurement (see B5).

### B4. WS-2 is underspecified to the point of being unimplementable / risks shipping a zero-signal stub — **CRITICAL (executability)**
*Raised by: goal-alignment #4, executability #6/#17/#20. Valid.*

WS-2 step 1 ("define the per-asset 'retrieved-and-useful' event and persist it (events/state.db)") is one sentence with: no table name/columns, no statement of whether it's existing `state.db` (needs a migration) or a new file (needs lock lifecycle), and a v1 signal — "retrieved + not-negatively-rated + led to an accepted change" — whose three components mostly **don't exist yet** (no session↔feedback correlation; no proposal↔triggering-retrieval link). As written, `outcomeTerm` will be permanently 0 → WS-1's placeholder is never exercised → the "seam" adds schema with no behavior. Separately, the proxy "led to an accepted change" is a known-invalid usefulness signal (a confirming asset is useful but yields no change).

**Correction:** be explicit that WS-2 for 0.9 ships a **stub table + `outcomeTerm = 0`, no behavioral effect**, with the schema (table, columns) fully specified so 0.10+ doesn't need a breaking migration; OR name a real signal available *today* (e.g. retrieval-count delta since last run) as the v1 term. Acknowledge the "accepted change ≠ useful" validity problem.

### B5. No measurement baseline, success criterion, or per-WS ship/rollback gate — **CRITICAL**
*Raised by: goal-alignment #12, executability #14. Valid; reinforced by memory.*

The plan's only gate is `bun run check` (unit/integration), but it repeatedly says "measure by coverage/accept-rate, not parity." There is no defined baseline, no metric definition ("coverage" of what?), no A/B method, and no threshold that blocks shipping a WS or triggers rollback. The success metric for the reconciliation *itself* (when is it done? did it regress the system?) is undefined. The project already has an eval harness (`scripts/akm-eval/`, T0 baseline, proactive-verdict with PASS thresholds) that the plan doesn't reference.

**Correction:** add a "Measurement" section: take a T0 snapshot before WS-1; define coverage + accepted-change-rate from existing health-report fields; require the `akm-eval` proactive-verdict to hold (accept ≥ 0.9×reactive, reversion ≤ 0.15, retrieval-delta ≥ 0) before each behavior-changing WS ships; define the rollback if it regresses. Without this, "default may shift — that's intended" is unfalsifiable.

### B6. WS-4 mislabeled "mostly verification"; "bypasses `makeGateConfig`" is imprecise — **MAJOR**
*Raised by: goal-alignment #11, code-accuracy #13, executability #7/#13. Verified.*

Verified: `maybeAutoTuneThreshold` (`improve.ts:1034`) mutates `options.autoAccept` *before* the four `makeGateConfig` calls, which **do** receive it (and can clamp it via `minimumThreshold`). So it does **not** "bypass" `makeGateConfig` — the real issue is that it tunes a **single global** threshold shared by all phases, with no per-phase resolution. Also, removing the mutation (WS-2 step 3) without specifying **where the tuned value then lives** would silently disable auto-tune; and the dedup archive callback (`dedup.ts` `onArchive` → consolidate) is a **direct callback**, not routed through the gate, so "confirm it flows through the gate" is likely a code change, not verification. There is also a sequencing ambiguity/near-circularity: WS-4's only material action ("the WS-2 reroute") is owned by WS-2, yet WS-4 is sequenced "after" as cleanup.

**Correction:** restate WS-4 as real work: (1) per-phase threshold resolution in `makeGateConfig`; (2) a defined home (state.db field or run-context) for the tuned threshold once the global mutation is removed; (3) actually route dedup archival decisions through the gate (or state that it's intentionally a separate, audited path). Merge WS-4's threshold work into WS-2 to remove the circular dependency.

### B7. `feedbackLane` is genuinely dangling, and the plan defers the decision instead of making it — **MINOR→MAJOR**
*Raised by: goal-alignment #16, code-accuracy #14, executability #10. Verified dangling.*

Verified: `feedbackLane` is set at `improve.ts:2842` and **never read** anywhere (only the type def + the assignment). The plan says "fold into WS-1 or remove" — but the two options have opposite consequences: "fold" (pass the lane into reflect/distill prompts so fix vs. reinforce changes behavior) is an undocumented behavior change and is the *unbuilt second half* of the `symmetricValence` feature; "remove" silently guts that half. Carrying the choice forward repeats the "multiple interpretations" anti-pattern the plan exists to fix.

**Correction:** decide now. Recommended: mark `feedbackLane` for removal in 0.9 (it does nothing today) and file lane-aware reflect/distill routing as explicit 0.10+ work — or, if it's wanted now, specify the consumer.

---

## C. Valid-but-lower-priority findings

- **C1. WS-2 sequenced third despite being "the doc's #1 fix"** (goal-alignment #5). The brain doc prioritizes Gap-2 first; the plan defers it behind WS-3/WS-1 without justifying the inversion. At minimum, document why (WS-3 fixes the active perf bug; WS-2's real signal is 0.10+) so it isn't read as quietly dropping the top priority.
- **C2. "Two loaders"** (`loadDedupMemories` includes `.derived`; consolidate's excludes them) — verified real (code-accuracy #15, executability #2). WS-3's "reuse consolidate's loader" must say *how* (e.g. `includeDerived?` param) or it regresses `.derived` dedup.
- **C3. `eligibilitySource` vs `feedbackLane` are orthogonal fields, not "two competing taxonomies"** (code-accuracy #23) — Part I §2 overstates the conflict; one is selection-origin, the other is feedback-direction. Tighten the wording.
- **C4. Stale line references** (code-accuracy #4/#8): `clusterMemoriesBySimilarity` is at `consolidate.ts:525` (plan says ~500); `limit` check is at `consolidate.ts:1288` (plan says ~1136). Fix before the doc is used as an implementation map.
- **C5. `§35/70` citation style is fragile** (goal-alignment #17) — the numbers are currently correct lines but will rot on any edit and aren't section headers. Cite by heading text ("No lossy reconsolidation").
- **C6. Timeout-sizing re-validation missing** (goal-alignment #20) — per memory `akm-improve-delta-only-throughput-collapse`, any change to how many assets a run selects must re-check `reflect.limit ≤ (timeoutMs/1000)/100`. WS-1/WS-2 change selection; add a timeout-sizing check to the per-WS gate.
- **C7. #604 (hot-probation buffer) and #613 (reconsolidation pressure) are unaccounted** (goal-alignment #14/#15) — Part III claims "nothing orphaned" but #604 appears nowhere and #613 is named as a disjoint signal without a seam or deferral. Either map or explicitly defer both.
- **C8. Gap-6 already has a partial implementation** (executability #18) — the archive TTL (A6) *is* a crude forgetting mechanism. Part III's "Gap 6 = NOT built" is wrong; future Gap-6 work must extend the TTL, not add parallel eviction. Reconcile with A6.

---

## D. What the reviews confirmed is *correct* in the plan

So the corrections above land in context (not as a wholesale rejection):

- The **divergence diagnosis is real and verified**: two content-hash normalizations, two loaders, dual valence path (`symmetricValence` vs `negativeOnlyRatio` at `improve.ts:2834-2846`), `combinedEligibilityScore = 0.7·utility + 0.3·valence` at `feedback-valence.ts:111`, the proactive formula at `proactive-maintenance.ts:186` with no valence term, `maybeAutoTuneThreshold` mutating `options.autoAccept` at `improve.ts:1034`, `feedbackLane` dangling. Every one of these checked out against the code.
- The **converge-don't-revert thesis** is the right correction to the earlier (rejected) revert attempt.
- The **non-negotiable** (keep raw, change through the gate) is the correct governing constraint — A6 just shows the *current* archive doesn't fully honor it.
- The **tiered consolidation** shape (cheap deterministic prune → LLM merge) is sound; only its embedding-reuse mechanism (A1) is broken.

---

## E. Recommended plan revisions, in priority order

1. **Rewrite WS-3 step 2** (A1): drop index-embedding reuse; specify a content-hash-keyed body-embedding cache + bounded compare pool, with the new storage/retrieval API.
2. **Add a Measurement section** (B5): baseline + coverage/accept-rate definitions + `akm-eval` verdict as the per-WS ship gate + rollback criteria + timeout-sizing check (C6).
3. **Specify WS-1's formula** (B3): exact terms, weights, range, input mapping, dead-input resolution (A7), lane-preservation; classify the behavior change + version bump (A5).
4. **Resolve WS-2's scope** (B4): stub-table + `outcomeTerm=0` with a fully specified schema, *or* a real available v1 signal; pick one and write the table DDL.
5. **Fix the hash unification** (A2): shared strip + two wrappers; add migration note (A5).
6. **Fix WS-3 step 4** (A4): compose `judgedCache` with incremental/neighbour selection rather than replacing it, or document the accepted loss + cold-start.
7. **Reclassify WS-4** (B6): real per-phase threshold work + tuned-threshold home + gate-routing of dedup archival; merge with WS-2 to break the circular dependency.
8. **Fix the architecture promise** (B1): assign or explicitly defer Gaps 3/5/6-decay; reconcile Gap-6 with the existing TTL (C8); add `maxSessionsPerRun`/#604/#613 accounting (A3/C7).
9. **Decide `feedbackLane`** (B7), bound archive recoverability (A6), fix stale line refs + citation style + orthogonal-taxonomy wording (C3/C4/C5).
