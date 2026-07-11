# Archived plans and superseded docs

Completed implementation/design plans — plus superseded analyses and specs — moved
here once their work shipped (or their claims were overtaken) so the active
`docs/technical/` and `docs/design/` directories only hold live plans and enduring
references. These are retained as design-decision records (ADRs) — the rationale is
still useful even though the work is done. Each doc carries a 2-line banner naming
why it was archived and where current truth lives.

| Doc | Shipped in / superseded by | Proof |
| --- | --- | --- |
| `0.9.0-improve-tuning-implementation-plan.md` | 0.9.0 | #617 dedup, #581 judgedCache, #604 hot-probation, #614 feedback-valence, #612 calibration |
| `akm-eval-implementation-plan.md` | 0.9.0 | `scripts/akm-eval/` (all 8 phases; CI-gated) |
| `architecture-refactor-plan.md` | 0.9.0 | R1–R9, X1–X3, D1–D3, X4 (PRs #667/#669/#670/#671) |
| `akm-workflows-orchestration-plan.md` | 0.9.0 engine/strategy cutover | Current workflow docs and frozen engine execution |
| `configuration-agent-profiles.md` | 0.9.0 | Replaced by named engines in `configuration.md` |
| `env-asset-refactor-plan.md` | 0.9.0 | `vault` removed; `env`/`secret` asset types |
| `improve-reconciliation-plan.md` | 0.9.0 | WS-0…WS-5 (salience, `asset_outcome`, homeostatic) |
| `per-asset-commit-unification-plan.md` | 0.9.0 | #507 — per-asset commit retired (`src/core/write-source.ts`) |
| `proposal-triage-implementation-plan.md` | 0.9.0 | `src/commands/improve/triage.ts` + drain integration |
| `standards-wiki-schema-PLAN.md` | 0.9.0 | `src/core/standards/` |
| `v1-architecture-spec.md` | superseded (never a live contract) | code-contradicted 5 ways (spec DB_VERSION 9 vs live 17); 1.0 freeze declined (review 10-Q1) |
| `d1-design.md` | 0.9.0 | `improve.ts` 5,395→~1,454 LOC; `eligibility.ts` extracted |
| `d2-design.md` | 0.9.0 | `state-db.ts` thin facade over `src/core/state/` |
| `d3-design.md` | 0.9.0 | `src/commands/improve/consolidate/` split (PR #669) |
| `r5-design.md` | 0.9.0 | `InstallKind` in `src/registry/types.ts` |
| `health-command-enhancements.md` | 0.8.0 | `akm health` --since/--group-by/--window-compare/--windows |
| `proposal-storage.md` | 0.9.0 | proposal queue in state.db (`src/core/state/`) |
| `improve-pipeline-analysis-0.8.0.md` | superseded by `docs/design/improve-self-learning-analysis.md` | historical May-2026 analysis |
| `index-consistency-adr.md` | 0.9.0 (accepted 2026-05-16) | `src/indexer/` |
| `akm-production-readiness-findings.md` | superseded by ratified positioning (review 10-Q4) | no pg client exists; single-owner deployment is the product |
| `improve-vs-brain-analysis.md` | superseded by `docs/design/improve-self-learning-analysis.md` | neuroscience framing = inspiration, not justification (review 09) |
| `improve-pipeline-deep-tuning-analysis.md` | superseded by `docs/design/improve-self-learning-analysis.md` | tuning frozen per 12-D2 |

Live docs are routed from [`docs/README.md`](../README.md); unshipped designs live
in `docs/design/` until their shipping PR moves them here.
