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

<!-- Append 04/06 … decisions here as they adjudicate. -->
