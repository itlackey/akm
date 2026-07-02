# 14 — Docs consolidation: unify akm's scattered design/technical/plan docs

> Adapts **"Blog consolidation"** from `wiki:articles/raw/blog-prompts-to-run-when-fable-comes-back`.
> The blog consolidates writing scattered across platforms into one permanent home. akm's analog: its own knowledge is scattered across docs/design/, docs/technical/, docs/archive/, .plans/, stash memories, and design docs that describe features that may or may not have shipped. Consolidate into one canonical, non-contradictory map.

## Prompt

```text
Consolidate akm's own scattered internal documentation into a single canonical,
navigable, non-contradictory map — and mark what's stale.

1. Inventory every internal doc: docs/design/*, docs/technical/*, docs/archive/*,
   docs/migration/*, any .plans/*, plus the design/architecture knowledge assets in
   the stash. For each: what it covers, its last-meaningful-update, and its status —
   CURRENT, SUPERSEDED (by which doc), SHIPPED (design doc for a feature now in
   code — should be marked done or archived), ASPIRATIONAL (design never built), or
   CONTRADICTED (disagrees with another doc or with the code).

2. Detect contradictions and drift specifically: multiple docs describing the same
   subsystem (improve pipeline, salience, search ranking, storage) with divergent
   details; design docs whose "proposed" mechanism the code already implements
   differently; the schema↔type two-source-of-truth drift already flagged in config.
   For each conflict, determine which source is authoritative (code > current design
   doc > older design doc) and note the correction.

3. Design the consolidated structure: one canonical entry-point map (extend the
   existing self-improvement-learning-memory-reference-index rather than adding a
   competing index) that routes to the authoritative doc per subsystem, with
   superseded/shipped docs clearly marked and archived-not-deleted. Define the rule
   for where NEW design docs go so this doesn't re-scatter.

4. Output: findings/14-docs-consolidation.md — the doc inventory with statuses, the
   contradiction list with authoritative-source rulings, the proposed canonical map,
   and the archive dispositions (list only — owner approves any move/delete by name).
   Prefer archiving/merging docs over writing new ones; the deliverable should REDUCE
   the doc count.

Guardrails: read-only; propose the consolidation and dispositions, do not move or
delete any doc this pass (per-path owner approval required for any archive/delete).

ultracode
```

## Refs

Stash:

- `knowledge:akm-improve-pipeline-architecture` and `knowledge:akm-improve-salience-initial-reconstruction` — stash-side design knowledge that may duplicate or contradict the repo docs.
- `knowledge:config-system-architecture` — config-system doc to reconcile against `docs/configuration.md`.
- `akm show meta` and `akm show meta:about` — the stash's own orientation docs, if present, as a consolidation model.

Repo:

- `docs/design/self-improvement-learning-memory-reference-index.md` — the newest index; the consolidation should extend THIS, not compete with it.
- `docs/design/improve-salience-working-reference.md` — the doc that already tries to be the canonical improve/salience map; measure everything else against it.
- `docs/README.md` — the current docs entry point.
- `docs/technical/architecture.md` vs. `docs/technical/v1-architecture-spec.md` — a likely current-vs-aspirational pair to reconcile.
- `docs/design/` and `docs/technical/` full listings — the raw scatter (note the many `improve-*` design docs and `d1/d2/d3/r5-design` docs that may be shipped or superseded).
- `docs/archive/` — where superseded docs should already be going.
