# 03 — Memory that compounds: where does knowledge go to die?

> Adapts **"Memory that compounds"** from `wiki:articles/raw/blog-prompts-to-run-when-fable-comes-back`.
> This is akm's reason to exist, so it gets the most literal adaptation: audit the full capture → store → resurface → outcome loop, and answer whether the stash is getting smarter or just bigger.

## Prompt

```text
Audit akm's end-to-end memory loop: capture (extract, remember, wiki stash) → store
(index.db/state.db, salience) → resurface (search, curate, SessionStart hook, memory
recall) → outcome (feedback, rank_score, accepted-change-rate).

1. CAPTURED BUT NEVER RESURFACED: query the live databases (READ-ONLY) for assets
   that have never been returned by search/curate, never recalled, never reinforced
   since creation. Quantify: what fraction of the stash is write-only? Break down by
   asset type and by origin (hand-written vs. improve-generated vs. extracted).

2. NEVER CAPTURED: find the capture gaps — sessions skipped by extract (watermark /
   ledger / llm-unavailable skips), asset types with no capture path, knowledge that
   exists only in repo docs or the owner's head. Note the shift from checkpointing to
   explicit extraction and evaluate what fell through that transition.

3. RESURFACED BUT IGNORED: where recall happens but doesn't land — curate results
   with negative/no feedback, memories recalled into sessions that contradict current
   reality, stale .derived duplicates crowding the results.

4. SMARTER OR JUST ACCUMULATING: is there evidence retrieval quality improves as the
   stash grows (rank_score effect, feedback trends, accepted-change-rate), or is
   growth pure accumulation? state.db was recently ~4.4GB with ~3.95GB of
   improve_runs.result_json blobs — separate telemetry growth from knowledge growth.

5. Design the missing retention/decay/promotion rules: what should decay, what should
   be invalidated on contradiction (see the bi-temporal design), what should promote
   from memory → lesson → knowledge, and what should stop being written at all.
   Prefer rules that reduce writes over compaction machinery that manages them.

6. Output: findings/03-memory-compounding.md — the four leak inventories with
   numbers, the verdict on compounding vs. accumulating, and the proposed rules with
   the specific code/config touch points.

Guardrails: read-only on live DBs — never trigger improve/extract runs. Improve
metrics rows before 0.9.0-beta.50 are polluted (skips counted as rejected);
discriminate with `skippedCount IS NOT NULL`. No deletions; dispositions only.

ultracode
```

## Refs

Stash:

- `memory:akm-durable-capture-shift-to-explicit-extraction.derived` and `memory:akm-checkpointing-replaced-by-explicit-extraction.derived` — the capture-path transition to audit for gaps.
- `memory:extract-sessions-skipped-due-to-llm-unavailable.derived` — a known never-captured failure mode.
- `knowledge:projects/akm/improve-pipeline-quality-audit` — prior evidence on whether improve output resurfaces usefully.
- `lesson:akm-stats-architecture-inversion` — context on what `akm stats` can/can't tell you.

Repo:

- `docs/data-and-telemetry.md`, `docs/technical/storage-locations.md` — what is stored where, and which growth is telemetry.

Live (read-only): `~/.local/share/akm/index.db` and `state.db`, `akm stats`.
