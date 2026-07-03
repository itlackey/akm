# 10 — What 10×s and what dies: akm against frontier AI's trajectory

> Merges **"What 10×s and what dies"** and **"Big picture"** from `wiki:articles/raw/blog-prompts-to-run-when-fable-comes-back`.
> The blog aims these at a person's career. Here they aim at akm's subsystems: given where models are going (longer context, native retrieval, cheaper inference, better tool use), which parts of akm become obsolete, which become the wedge, and what is the honest 1.0 shape.

## Prompt

```text
Given where frontier AI is actually heading — million-token context, native/model
retrieval, near-free inference, strong agentic tool use, better long-horizon
memory — tell akm which parts to kill and which to pour into.

1. Score each subsystem on a 2-year horizon:
   - DIES: the model does this natively soon, or the cost pressure it solves
     disappears. (Test hard: hybrid ranking heuristics, hand-tuned salience,
     transcript summarization, chunking strategies — do these survive cheap long
     context + native retrieval?)
   - 10×s / WEDGE: gets dramatically more valuable as models improve, or is the
     thing models will NOT provide for the owner: durable cross-session provenance,
     owner-specific intent and preferences, an auditable trail of what was learned
     and why, curation/trust of third-party knowledge, the write-side capture the
     model can't do for itself.
   - MOAT-QUESTION: is akm's real, defensible value the store, or the taste (what to
     keep, what to resurface, what to trust)? Argue it.

2. Separate stop-investing-now from pour-into-now. Be concrete and this-year: which
   files/subsystems to freeze or delete, which to double down on, what NOT to build
   because the model will render it moot before it ships.

3. Define the 1.0 shape this implies. Reconcile it against the existing v1
   architecture spec and roadmap — call out where they're building things that DIE.
   State the single-sentence positioning: what akm is FOR that a frontier model with
   a long context window still can't do for the owner.

4. Output: findings/10-what-10xs-what-dies.md — the subsystem scorecard, the
   stop/pour lists with file-level specificity, the 1.0 shape, and the positioning
   sentence. Prefer a smaller, sharper 1.0 (subtract) over a feature-complete one.

Guardrails: read-only; this is a strategy artifact, not code changes. Be willing to
recommend deleting subsystems the owner has invested heavily in — that's the point.

ultracode
```

## Refs

Stash:

- `knowledge:projects/akm/consolidation-future-vision` — the existing forward vision to pressure-test.
- `knowledge:akm-hybrid-rendering-architecture` — a candidate DIES/LIVES subsystem to score.
- `lesson:recombined/akm-8e69a3a1` — a recombined lesson worth reading for where the pipeline's value actually landed.
- `memory:akm-cli-version-stability-roadmap.derived` — the CLI-stabilization roadmap that assumes the current shape.

Repo:

- `docs/technical/v1-architecture-spec.md` — the 1.0 shape to reconcile against (and cut from).
- `docs/roadmap.md` — what's currently planned; flag the DIES items.
- `docs/technical/akm-core-principles.md` — the principles that should define the wedge.
- `docs/technical/search.md` / `docs/technical/indexing.md` — the ranking/retrieval subsystems most exposed to "native retrieval kills this."
- `docs/concepts.md` — the substrate story to update.
