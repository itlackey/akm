# Archived plans

Completed implementation/design plans, moved here once their work shipped so the
active `docs/technical/` and `docs/design/` directories only hold live plans and
enduring references. These are retained as design-decision records (ADRs) — the
rationale is still useful even though the work is done.

| Plan | Shipped in | Proof |
| --- | --- | --- |
| `0.9.0-improve-tuning-implementation-plan.md` | 0.9.0 | #617 dedup, #581 judgedCache, #604 hot-probation, #614 feedback-valence, #612 calibration |
| `akm-eval-implementation-plan.md` | 0.9.0 | `scripts/akm-eval/` (all 8 phases; CI-gated) |
| `architecture-refactor-plan.md` | 0.9.0 | R1–R9, X1–X3, D1–D3, X4 (PRs #667/#669/#670/#671) |
| `env-asset-refactor-plan.md` | 0.9.0 | `vault` removed; `env`/`secret` asset types |
| `improve-reconciliation-plan.md` | 0.9.0 | WS-0…WS-5 (salience, `asset_outcome`, homeostatic) |
| `per-asset-commit-unification-plan.md` | 0.9.0 | #507 — per-asset commit retired (`src/core/write-source.ts`) |
| `proposal-triage-implementation-plan.md` | 0.9.0 | `src/commands/improve/triage.ts` + drain integration |
| `standards-wiki-schema-PLAN.md` | 0.9.0 | `src/core/standards/` |

Plans NOT yet complete (still in `docs/technical/`) are tracked in
`.plans/pending.md`.
