# Meta-review shared context

Every agent spawned by `run-review.workflow.mjs` Reads this file. It holds the ground rules
and the binding decisions carried across reviews. **Keep it current:** when a review is
adjudicated, append its decisions under *Carry forward* so later reviews inherit them.

(This file is auto-injected into every review agent. Do NOT put an owner's sealed prediction
here — that must never reach an agent.)

## Ground rules (methodology)

- **READ-ONLY on live data.** Inspect `~/.local/share/akm`, `~/.config/akm/config.json`, and
  cron logs freely — but NEVER run `akm improve`/`recombine`/`extract`/`consolidate`. Open
  sqlite `mode=ro` only.
- **Verify EFFECTIVE config** (what the cron actually loads), not code defaults.
- **Prefer subtraction:** a fix that deletes machinery beats one that adds a guard/flag/wrapper.
- **No deletions.** Output *dispositions* (keep/update/merge/archive/delete); the owner approves
  any delete per-path, by name.
- **Never print secret VALUES** — reference env/secret assets by name only.
- **Metrics caveat:** improve accept/reject rows before `0.9.0-beta.50` are polluted (gated skips
  counted as rejected); discriminate with `skippedCount IS NOT NULL`.
- **Findings are local-only / gitignored** and may contain sensitive facts — never commit them.
- **Follow the constitution** - When designing, implementing, or reviewing code changes, ensure the changes comply with the coding constitution /home/founder3/akm/facts/conventions/coding-constitution.md

## Carry forward (binding decisions from completed reviews)

From **01 goal-orientation** and **05 metrics-and-evals** (adjudicated + shipped):

- akm is **BOTH pillars**: a pack-consumption channel AND a learning engine; the automation
  platform (tasks/env/secrets) is a ratified 1.0 pillar.
- Metrics are settled: **UCE** (useful context events/week) is the primary north star; **GRR**
  (per-lane 30-day external read-back rate of improve-promoted refs) is the governing number;
  minting lanes stay off below 5% GRR.
- Generation is gated on usage/feedback; proactive lanes are repointed at **ENRICHMENT**
  (metadata, graph relations), not new-content minting.
- The improve pipeline already had a **subtraction round** — PR #695 (shipped 0.9.0-beta.54)
  deleted the #691 outcome-penalty term and added event-provenance filters, two-tailed monitors,
  and an enrichment-minting rollup. **R1** (outcome weight w_o=0.15) and **R2** (salience→search
  boost) are LIVE since beta.53. Account for what's already gone; don't recommend re-deleting it.
- Security: the env comment-leak is fixed and the index rebuilt; the previously-leaked
  credentials were fake test values — no rotation needed.

From **02 bitter-lesson** (adjudicated 2026-07-03; nothing executed — dispositions only):

- **Bitter-Lesson debt map (binding framing):** the **data-side machinery LIVES** — retrieval/outcome
  salience EMAs, the `rank_score` blend and R2/utility search boosts, extract ledger/watermark,
  proposal dedup/cooldowns, drain/schema gates, and the `lesson_quality_gate` judge are the *general
  method* (usage statistics scaling with data) or harness safety, not model-compensation. Do NOT
  propose deleting them as "heuristics." The debt is the **content-judging salience heuristics**
  (13-keyword English magnitude + ref-name-bigram novelty) and the **high-salience lane** on them
  (~1.1% asset coverage, frozen at ~65 admissions/30d).
- **Approved to proceed (eval-gated, not yet executed):** (1) delete the `curate_rerank` dead
  feature key across 5 files (~−50 LOC) — gate: zero-refs grep + `bun run check`; (2) search
  contributor **ablation** (~−50 to −100 LOC) — gate: curate-golden nDCG/MRR Δ≈0 per contributor.
- **High-salience lane:** owner **pre-committed** — read-only GRR measurement authorized; **delete
  the lane if GRR < 5%** per the ratified minting-lane rule (no re-litigation). Later reviews may
  treat the lane as on-track-for-deletion pending that number.
- **Model-scored salience seam is ratified in principle:** replace the keyword/bigram encoding
  internals with model relevance scored **at distill/extract time** (zero extra LLM calls), written
  into the **same `encoding_salience` column** with `encoding_source='content'` (migration 015 seam
  — **no schema migration**), copying the `lesson_quality_gate` fail-open/timeout template. Deferred
  behind the lane-GRR gate so the swap isn't judged through a frozen lane.
- **Recombine no-embeddings constraint:** commissioned a **60-day entity-led vs embedding-led**
  accept-rate/GRR trial before any change; constraint is neither ratified nor deleted.
- **Docs:** `v1-architecture-spec.md` drift (scorer key never existed, DB_VERSION 9-vs-17, 7-vs-11
  feature keys, missing recombine, §14.6 consolidation contradiction) is **routed to review 14**.

From **03 memory-compounding** (adjudicated 2026-07-03; nothing executed — eval-gated dispositions only):

- **Governing number:** the owned stash is **98.2% write-only** (1.77% lifetime touch rate; 302/17,072 entries ever touched by any usage event). Verdict = **ACCUMULATING, not compounding** — re-adjudicate only when `improve_cycle_metrics` has **≥30 days of rows** (currently 2, same day). ~92% of state.db (4.63GB) is `improve_runs.result_json` telemetry, not knowledge.
- **Binding framing (for 04/06):** the **tool-dispatch pattern** (script/command/agent/skill/workflow — explicit, human-gated, dispatch-consumed) is the compounding **existence proof** at 40–73% reuse; auto-minted content types are 0.1–1% touched. Push content minting *toward* that pattern (read-back-gated, task-anchored, like `propose`) — **never widen auto-mint (extract's enum, remember) into the healthy dispatched types.** The capture asymmetry is a KEEP, not a gap.
- **Approved now (eval-gated):** (1) delete the two `type === "memory"` belief guards (`ranking-contributors.ts:109`, `db-search.ts:560`, net −2 lines) so `contradicted`/`superseded` penalties apply to all **2,441** flagged knowledge entries — gate: curate-golden nDCG/MRR Δ; (2) one-**directed**-edge contradiction fix (`memory-contradiction-detect.ts:314-318` currently writes mutual A↔B edges → SCC resolver erases every detected contradiction each run) — gate: edges persist across a read-only re-run. Full **bi-temporal R7 stays deferred** behind these.
- **Ratified retention/decay/promotion rules (4 subtract, 1 add):** R-1 stop `session_checkpoint` memory writes + delete downstream exclusion filters (`recombine.ts:233-258` + siblings) — the "later-extract" pointer, if wanted, goes in the **extract ledger**, not a memory asset; R-2 bulk `<path>-lesson` lane off below **5% GRR** (existing ratified rule; lane read-back 0.48%); R-3 supersede base on `.derived` write + **delete the `derivedBoost` constant** (`ranking-contributors.ts:153-162`; 1,248 twin pairs); R-4 stop persisting `content_hash` on `llm_unavailable`/`triaged_out` (existing null-hash retry unlocks 158 locked sessions); **R-5 (the only addition)** promotion memory→knowledge requires **≥2 external read-backs/30d** (reuses GRR/`usage_events`, no new tables).
- **opencode-sdk `sessionLogs=false` = a BUG** (SDK subagent sessions invisible to extract) — fix the reader; also removes any need for an R-1 memory pointer.
- **Outcome-EMA hygiene:** one-time backfill of **42** pre-#695 poisoned `asset_outcome` aggregates (load-test bursts + `tool_failure`/`slice:train` auto-signals now feed live ranking at w_o=0.15) — approved, no schema change, after confirming #695's provenance filters exclude those sources forward.
- **Docs:** `storage-locations.md` DB_VERSION=14 vs live 17 → **routed to review 14** with the 02 v1-spec DB_VERSION drift (same doc-sync batch).

From **04 stash-self-model** (adjudicated 2026-07-03; nothing executed — dispositions approved, proposal emission is an authorized follow-up):

- **Acceptance-test verdict for `improve-bitemporal-invalidation-design.md`:** the drift-prevention
  mechanism **exists and SELF-ERASES.** Contradiction detection runs unconditionally dozens of times/day
  via cron, then the **mutual A↔B edge** write (`memory-contradiction-detect.ts:314-318`) → SCC treats the
  2-cycle as a **sink** and refreshes both to active/asserted (`memory-improve.ts:392-545`) →
  `persistBeliefStateTransition` deletes the `contradictedBy` frontmatter (`memory-improve.ts:647-668`),
  all in the same run. The 169 `contradicted` base memories are lucky residue; LLM judge calls are
  re-burned on the same pairs daily. The **03-ratified one-directed-edge change is confirmed as THE
  mechanism fix** (gate: edges persist across a read-only re-run). **R7 stays deferred.**
- **staleness-detect pass (`src/indexer/passes/staleness-detect.ts`): OWNER KEPT IT OPEN** — NOT routed to
  review 06 as a deletion candidate, NOT to be enabled as the drift fix. Facts for whoever revisits it:
  feature-gated off, no `index`/`staleness` config key, exactly 1 `lastConfirmedAt` in the whole stash,
  90-day default threshold mis-fit for a ~53-day-old stash whose drift onset was 33 days. Enable-vs-delete
  stays an open question; do not treat as on-track-for-deletion.
- **Structural leak (root-caused):** archiving a base memory **strands its `.derived` twin live forever**
  (68% of memory rows are twins; 0 of 169 contradicted bases' twins carry `beliefState`; a contradicted
  base nets −0.53 while its flag-free twin nets +0.12, so the stale copy **outranks** the corrected one).
  Root fix = 03's ratified **R-3** (supersede base on `.derived` write + delete `derivedBoost`,
  `ranking-contributors.ts:153-162`) plus the two `type === "memory"` guard deletions.
- **Approved dispositions (archive-not-delete, via proposal queue; first-ever memory-type batch through
  the queue):** B1 archive 2 orphan twins; B2 archive ~300 `session_checkpoint` memories + ~18
  session-lessons (chunked ≤50, ~7 passes; source fix = R-1); B3 invalidate 3 stale version memories + the
  14-key `version-sync` cluster → 1 corrected knowledge entry (live truth: **0.9.0-beta.54**, no
  `release/0.8.0` branch, openpalm pins `^0.8.0` semver in `containers/`, not `core/`); B4 merge 4 PR #682
  "branch still open" memories → 1 (PR **MERGED 2026-07-02**); B5 merge 5 "contradiction detect is
  config-gated" memories → 1 (**no gate exists** — even the docstring at `memory-contradiction-detect.ts:26`
  lies; delete the claim, don't add the gate). B6 re-verify `openpalm-auth-evolution-roadmap` only.
- **B7 `.meta/index.md` fill APPROVED** — the one sanctioned ADDITION (~10 lines: stashDir purpose, the
  tool-dispatch-compounds/content-accumulates split, the proposal-queue rule). Placeholder scaffold since
  2026-06-22; `akm show meta` returns it verbatim over 24k entries.
- **Recall-quality note:** every flagged asset has **0 `usage_events`** (28k total) — the batch buys
  **worst-case-wrongness elimination** (version/branch/pin queries stop returning ranked falsehoods) and
  contradiction-judge-load relief, **not measurable nDCG gain**; gate code changes on **curate-golden
  Δ≈0-or-better**, not improvement.
- **KEEP bar (articulated):** freshness + verifiability (dates/numbers) + active-project relevance — do NOT
  batch-archive unverified project-state memories on suspicion (the over-correction ditch).

From **06 autonomy-ladder** (adjudicated 2026-07-03; nothing executed — dispositions only):

- **The ladder has ONE operating rung.** Proposal resolution is **100% automated** (0 of 20,726 accepted
  rows owner-annotated; 93% resolve <24h; every sampled promotion `autoAccept:true`). The docs' "owner-gated
  queue" is **fiction** — relabel it **audited-autonomous (AA)**. Per-item approval (PI) exists and works ONLY
  at `/akm-memory-promote` + `/akm-proposal accept`; do NOT demote high-volume autonomous actions to PI (that
  is the gate-costs-more-than-it-protects trap).
- **Two highest-blast-radius writes run BELOW every improve gate — both approved for removal:** (M1) the
  Claude-hook `session_checkpoint` **direct stash write** (`akm-hook.ts:1371-1451`, `remember --force`, no
  judge/confidence/schema gate) → **execute 03's ratified R-1** in the next execution batch (delete the
  `captureMemory` shell-out + the `recombine.ts:233-258` exclusion filters); (M2) the nightly `akm update --all`
  cron (`update-stashes.yml`, 14 third-party sources into the tool-dispatch tier) → **DELETE the cron**, pull
  on demand. NOTE the split: memory-*candidate* capture (regex sidecar → `/akm-memory-promote`) is the **KEEP
  reference rung**, NOT M1's `--force` write — do not conflate them.
- **Approved subtractions (eval-free, mechanical):** (M4) archive-on-validation-throw in the
  `improve-auto-accept.ts:292-312` catch (all 7 pending items are unreachable zombies; 90-day TTL fired 0× in
  2,754 passes); (M5) delete the `proactiveMaintenance:{enabled:true}` block from builtin
  `src/assets/profiles/default.json` (it silently overrides code-default false in the nightly default lane —
  the "verify effective config" trap; the weekly YAML's "disabled-by-default" claim is false); (M7) delete the
  dead `autoAccept` param/threading (`recombine.ts:131`, `loop-stages.ts:798`; drain tier never calls
  `runAutoAcceptGate`) + add `maxDiffLines` to the uncapped `PERSONAL_STASH.accept` extract rule.
- **Ratified KEEPs (defended; binding on later reviews):** consolidate **95-floor** merges (AA — 9,612 accepts,
  zero loss incidents); salience/`rank_score` **UPSERTs (A — refuse future gates**, derived/recomputable, gating
  them stops the usage-statistics learning loop); watermark/extract-ledger + index (A); memory-candidate
  capture→promote (**PI, the reference rung**).
- **Deferred:** (M6) the daily `curate-to-wiki` minting lane (`curate-agent-learning.yml`) has **no GRR number**
  and escaped scrutiny by living outside `akm improve` — GRR measurement **NOT yet authorized**; standing
  <5%-GRR deletion rule not yet armed for this lane.
- **Docs → review 14 batch:** `improve-workflow.md` narrates a human-in-the-loop review that the DB proves never
  happens (0 owner annotations); also add the M7 sentence that the drain tier is deterministic-policy-gated, not
  confidence-gated. Route with the 02/03 doc-sync items (DB_VERSION drift, v1-spec, storage-locations).
