# AKM 0.9.0 — Bundle/Adapter + Simplified Architecture: Final Implementation Plan

**Status:** Consensus-approved, implementation-ready. Supersedes doc1 (`improve-self-learning-analysis.md`) and doc2 (`engine-strategy-refactor-plan.md`) where they conflict.
**Branch model:** single long-lived integration branch, one cutover, ships as 0.9.0.
**Baseline commit:** `cf44e11` (already post engine/strategy cutover).

---

## 1. Executive Decision & Scope

### 1.1 What 0.9.0 is

0.9.0 is the **file-and-search kernel** cutover. AKM stops being a type-taxonomy-routed asset platform with a candidate→proposal→plan→changeset pipeline and multiple parallel learning substrates, and becomes:

- **A ref→file resolver over one normalized model.** `index()` resolves a `type:name` ref to an absolute path and emits one `SearchDocument`. `improve` reads files directly from the filesystem (from a frozen snapshot manifest, never the live tree).
- **A two-verb improve loop.** Every semantic operation is either **revise** (rewrite an existing file) or **learn** (create a new file from evidence). `extract`/`distill`/`inference`/`recombine`/`synthesis` become `learn` recipes; `reflect` is a `revise` recipe.
- **A proposal-only, snapshot-bounded run model.** One frozen input snapshot per run (hash manifest, not a copied workspace); every semantic process emits `Proposal` objects carrying `FileChange[]`; no mid-run semantic writes or reindex; one transactional apply at end; reindex affected paths once.
- **A small bundle-adapter contract.** Adapters index, provide guidance paths, validate `FileChange[]`, and optionally place new files. Adapters never own mutation.
- **A verification ladder that gates auto-apply on evidence, not self-confidence.** L1 deterministic safety, L2 behavioral/comparative evidence, L3 field outcome. Self-confidence is metadata only.

### 1.2 Single-track mandate (non-negotiable — D1)

- One aggressive refactor on **one long-lived integration branch**.
- **No intermediate releases.** 0.9.0 is the first and only release of the new architecture.
- **No staged/dual-format compatibility layer.** Migration is a one-time cutover embedded in the branch.
- Only **local iteration** for testing/verification.
- **"No intermediate release" binds releases, not commit hygiene.** The tree stays green per-commit (`bun run check`), gated by `tests/contracts` + `tests/architecture`. The staged "release/0.9 maintenance branch + releasable vertical slices + feature freeze" model from doc2 Perspective 3 is **rejected**; doc2's vertical-slice *ordering* is retained as in-branch chunk ordering (§5).

### 1.3 Explicitly out of scope for 0.9.0

Deferred to a **separate post-0.9.0 cutover** (evidence-driven, unanimous panel amendment to the rubric):

1. **Full asset-taxonomy retirement.** `AssetSpec`, type-directory mapping, closed `AkmAssetType`, type-routed lint registry, type-to-renderer/action maps, and global matcher competition/specificity **survive 0.9.0**. Neither shipped doc scoped their deletion; `src/core/asset/asset-spec.ts` is a working 359-LOC contract-tested registry; and D11's ref-remap depends on it as placement/canonical-name ground truth. Deleting it to re-implement placement across N per-format adapters is a net abstraction *increase*.
2. **Ranking saturation-harness fix** (`ranking-ablation-and-saturation-analysis.md` §4/§7/§8: displayScore clamp+quantize+alphabetical-tiebreak) and the run-to-run stability guard (#14). This is open research and stays off the critical path.
3. **Per-contributor prove-or-delete verdict** for salience/outcome and LLM graph extraction. For 0.9.0, a reversible parity config flip stands in (§8, D10).

**Rubric-amendment flags requiring maintainer sign-off** (panel consensus, not disagreement): (a) taxonomy kept for 0.9.0; (b) D10 premise corrected from "salience inert (w_o=0)" to "salience live-but-unproven/leaning-negative → parity flip"; (c) the two post-0.9.0 deferrals above.

---

## 2. Target Architecture

### 2.1 Kernel primitives

**`BundleMount`** — a mounted source of bundle files. Carries the source id/root and the adapter that indexes/validates it. Replaces bundle-local `.akm` runtime state (dies, D12) and the source `wikiName` special case (dies). Runtime state lives centrally, not per-bundle.

**`SearchDocument`** — the **only** common normalized model (D2). Already exists in `src/indexer`. Amendments:
- **Add typed source-ref/provenance fields NOW** (`sourceRef`, origin path/bundle, content hash) — load-bearing for auditable rollback (doc1 R8). Unanimous.
- **Do NOT add a first-class salience/outcome field.** Salience is live-by-default but unproven and leaning net-negative on disjoint corpora (D10/F4); committing the one kernel model to it is premature. If salience survives the post-0.9.0 measurement pass, it composes at the *ranking layer* via the existing `ctx.salienceRankScores` input, not via the kernel document. Any interim metadata rides the D4 open key/value bag.
- No semantic-views registry, no universal item hierarchy, no adapter `read()` facade.

**`FileChange`** — `{ op: 'replace'|'create'|'delete', relPath, absPath, beforeHash?, content? }`. Core-owned. `beforeHash` is the single optimistic-concurrency/drift guard (= the D7-L1 before-hash check). Replace-file **retains prior content in a recoverable archive** (never a silent hard-delete) so consolidation stays non-destructive-with-history (Zep invalidate-and-keep, arXiv:2501.13956).

**`Proposal`** — one object collapsing candidate→proposal→plan→changeset (D4):
```
Proposal {
  changes: FileChange[]        // core-owned, with beforeHash
  evidence: {                  // bounded envelope — NOT a per-process schema
    l1?: DeterministicResult   // typed
    l2?: EvaluatorResult       // typed: {score, effectSize, protectedRegression} | 'no-automatic-evaluator'
    l3?: FieldOutcome          // typed
    meta: Record<string,unknown>   // ONE open bag; self-confidence lives here, metadata-only
  }
  status: 'pending'|'auto-apply'|'review'|'applied'|'rejected'|'reverted'
}
```
Extend `tests/contracts/reflect-propose-envelope.test.ts` — do not replace it. No separate lock/lease.

**`Diagnostic`** — `validate()` return element (`Issue[]`): `{ level, code, message, path, field? }`. Emitted by adapter validation and by L1 checks (base-linter `runBaseChecks`, missing-ref, secrets, protected-fields).

### 2.2 Adapter contract — FINAL shape (D3)

```ts
interface BundleAdapter {
  index(files: string[]): SearchDocument[]
  guidancePaths: string[]                      // plain absolute paths, NOT a 'guidance' domain type
  validate(changes: FileChange[]): Issue[]
  placeNew?(evidence: EvidenceEnvelope): string  // relPath; optional
}
```
- **`planUpdate` is DROPPED.** Verified zero consumers in `src` (F7). It is the one seam that would let adapters own mutation semantics — its removal is what keeps this a file tool, not a platform. All mutation is core-owned `FileChange[]`.
- No `read()` facade. No update computation in adapters.
- Pin this exact 3-method+optional surface in `tests/contracts/extension-points.test.ts` so it cannot regrow a `read()`/`planUpdate` facade.

### 2.3 Improve as revise/learn (D5)

Two semantic verbs, both emitting `Proposal`s:

| Verb | Meaning | Recipes (former processes) |
|---|---|---|
| **revise** | rewrite an existing file | `reflect` |
| **learn** | new file from evidence | `extract`, `distill`, `inference`, `recombine`, `synthesis` |

- **consolidate/recombine are `learn` recipes emitting multi-file `FileChange[]` with non-destructive supersession** — frontmatter `supersededBy` + rank demotion on merged inputs (Mem0 ADD/UPDATE/DELETE/NOOP arXiv:2504.19413; Zep invalidate-and-keep arXiv:2501.13956), never hard-delete. This preserves auditable contradiction handling (doc1 G8/R7).
- **CLS two-timescale invariant preserved as a recipe CONFIG value** (a `minConfirmingRuns` integer in the strategy JSON), NOT a new cross-episode subsystem — otherwise it reconstitutes the multi-cycle machinery D9 deletes.
- Recipes are converted **one at a time behind a stable envelope-emitting facade** (§5); the 12 strategy JSONs in `src/assets/improve-strategies/` and `improve-cli-surface.test.ts` are the behavioral invariant each conversion must preserve.

### 2.4 Snapshot + selection — unified artifact (D6 + D8)

**One hash manifest is the run's single authority:**
```
Manifest {
  entries: { [ref]: { absPath, beforeHash } }
  configVersion, engineVersion, dbMigrationCursor   // folded into the manifest hash
}
manifestHash = hash(entries + versions + cursor)     // == the D8 input fingerprint
```
- Snapshot is a **hash manifest, never a copied/staging workspace**.
- `improve` reads files via fs **from manifest `absPath` entries only**, never the live tree — this closes the read-path reindex-contention race.
- Proposal-only run; **one end-of-run transactional apply** (reusing `sqlite-migrations` transaction discipline); **reindex affected paths once**.
- **Apply-time `beforeHash` comparison is the sole transactional guarantee** — abort the whole batch on any drift.
- **Config-ahead-of-DB skew fails closed:** because the manifest hash folds in `configVersion`/`engineVersion`/`dbMigrationCursor`, a skewed install (the documented `configVersion 0.9.0` over `state.db@016` incident, MIG-2) produces a manifest mismatch and refuses to run rather than writing over skewed state.
- **`manifestHash` is the single input fingerprint**, replacing the overlapping cooldown/dedup/grace/no-op caches. No second hashing subsystem.

**Evidence-driven selection (D8):** "No corrective evidence → no unattended semantic rewrite." Corrective evidence is defined concretely and auditably as one of: a **linked revert**, an **explicit feedback valence**, a **failed task replay**, or a **detected contradiction** on the target ref. `usage/salience/age` **only reorder within the corrective-evidence-eligible set** — they may never promote a ref out of the ineligible set, and no leaf may re-derive eligibility from ambient `loadConfig`.

### 2.5 Verification ladder (D7)

- **L1 — deterministic safety** (already exists): parse/conformance/links/protected-fields/before-hash/secrets via `base-linter.ts runBaseChecks` + `missing-ref`. **NEW: Anthropic SKILL.md contract as the skill-format L1 validator** — name ≤64, description ≤1024 stating what+when, body <~500 lines, progressive disclosure (the format-specific evaluator both docs omit; Anthropic skill-authoring best practices).
- **L2 — behavioral/comparative** (ONE evaluator, reusing existing tooling): `evaluate(): { score, effectSize, protectedRegression } | 'no-automatic-evaluator'`. Reuses `scripts/akm-eval/src/curate-bench.ts` + `src/core/eval/rank-metrics.ts` + a collapse/entropy canary. The **`'no-automatic-evaluator'` state is mandatory** — for prose/skills where AKM has no automatic evaluator, it forbids auto-apply and routes to L3 human. A judge-only verdict is never labeled "objectively verified" (guards the self-preference-bias vector, arXiv:2410.21819).
- **L3 — field outcome:** human accept, feedback, revert.

**Auto-apply policy:** auto-apply only for **mechanical (L1-only) changes** OR **objectively-verified-semantic** changes (L2 pass with effect floor + no protected regression). Encoded as a contracts test on `improve-auto-accept.ts` so it cannot regress to the current self-confidence gate (distill auto-accepts ~83–85% on self-confidence today — that gate is retired). **Self-confidence is metadata only, never authorization.**

---

## 3. Consensus Record (D1–D12)

| # | Decision | Final resolution & folded amendments | Residual |
|---|---|---|---|
| **D1** | Delivery model | **Single-track, one branch, no intermediate release.** Green-per-commit on a long-lived integration branch; `bun run check` + `tests/contracts` + `tests/architecture` as trunk gates; merge gated on `release-gates.yml` + fresh-install smoke + upgrade-from-beta.52 smoke + **curate-golden nDCG/MRR non-regression**. | none |
| **D2** | Kernel | **One `SearchDocument`; index resolves ref→absPath; improve reads via fs from snapshot manifest paths.** Add typed **provenance/source-ref fields now**; **no salience/outcome field** (unproven/leaning-negative → ranking-layer only if it survives post-0.9.0). Lint boundary forbids new `loadConfig`/`resolveStashDir` in improve leaves; drop vestigial `getImproveProcessConfig` `_config` param. | none |
| **D3** | Adapter contract | **Drop `planUpdate`** (zero consumers). `{ index→SearchDocument[], guidancePaths:string[], validate(FileChange[])→Issue[], placeNew? }`, pinned in `extension-points.test.ts`. | none |
| **D4** | Proposal = changeset | **One `FileChange[]+beforeHash+status` object.** Evidence envelope = typed L1/L2/L3 slots + one open bag; self-confidence metadata-only; `beforeHash` sole drift guard. | none |
| **D5** | Two verbs | **revise/learn.** consolidate/recombine = `learn` recipes with non-destructive supersession; CLS gate = recipe config value; convert recipe-by-recipe behind a stable facade. | none |
| **D6** | Snapshot + proposal-only | **Hash-manifest snapshot (never copied workspace); proposal-only; one transactional batch; reindex-once.** Manifest hash folds in config/engine version + DB cursor (skew fails closed). Manifest hash **is** the D8 fingerprint. | none |
| **D7** | Verification ladder | **L1 deterministic-first + SKILL.md L1 validator; L2 one evaluator with mandatory `no-automatic-evaluator` state; self-confidence metadata-only; auto-apply only mechanical or L2-verified.** | none |
| **D8** | Evidence-driven selection | **One fingerprint = manifest hash.** "No corrective evidence → no unattended rewrite"; corrective evidence defined concretely; usage/salience/age reorder within eligible set only. | none |
| **D9** | Delete-by-default | Remove from loop **AND** `config-schema.ts` (drop fields, don't gate); each deletion carries a prove-or-delete ticket with named baseline + effect floor. | none |
| **D10** | Prove-or-delete salience/graph | **Resolver third path:** naive per-contributor ablation is unmeasurable (saturation trap, F3); stack-level ablation is regime-robust and already net-negative on disjoint E6 (F4). **For 0.9.0: one-line reversible config default flip to salience parity** (`outcomeWeightEnabled:false` → w_o=0 and/or default `salience-ranking` contributor OFF) — neutralize an unproven live booster **without deleting machinery or state tables**. Stack-level ablation (`AKM_ABLATE_CONTRIBUTORS`) added as a merge gate. **Per-contributor verdict + §7/§8 clamp fix deferred post-0.9.0.** | premise corrected from "inert" to "live-but-unproven"; sign-off flagged |
| **D11** | Migration | **One-time convert+remap+re-key+backup+report; no dual-format.** Single atomic, backup-verified-restorable, idempotent/resumable; layout + state re-key + 009/010/017 + workflow-010 **before** configVersion flip (flip keyed on DB cursor, not config version). Real `profiles→engines/strategies` translation with `Fast/fast` collision handling; `--dry-run` gate; routine reads decoupled from backup enforcement. **Migration report asserts re-keyed-vs-orphaned counts for `asset_salience`/`asset_outcome`/`feedback` and fails closed to restore UNCONDITIONALLY.** | none |
| **D12** | What-dies | **Taxonomy kept for 0.9.0** (unanimous rubric amendment). Die now: wiki asset-type + wiki command (fold broken-xref into base-linter missing-ref), source `wikiName` special case, bundle-local `.akm` runtime state, direct semantic mutation, type-derived write paths. Retire post-0.9.0: `AssetSpec`, type-directory mapping, closed `AkmAssetType`, type-routed lint registry, type-to-renderer/action maps, global matcher competition. | rubric amended; sign-off flagged |

**Residual dissent:** none at decision level. Three items are **evidence-driven rubric amendments** (not panel disagreement) flagged for maintainer sign-off: D12 taxonomy-kept, D10 premise-corrected, and the two post-0.9.0 deferrals.

---

## 4. Grounded Current-State Map: What Dies / What Survives

*Census re-measured against `cf44e11`. The code-quality-review numbers (dated 2026-07-03/04) are stale — re-measure at branch start before sizing any chunk.*

### 4.1 Survives (reused, not rewritten)

| Subsystem | Path | LOC | Role in 0.9.0 |
|---|---|---|---|
| Asset taxonomy | `src/core/asset/asset-spec.ts` | 359 | **Kept.** Placement/canonical-name ground truth for migration ref-remap. |
| | `src/core/asset/asset-registry.ts` | 100 | Kept (renderer/action singletons). |
| | `src/core/asset/asset-ref.ts` | 140 | Kept. Ref parse/format for remap. |
| RunnerSpec seam | `src/integrations/agent/runner.ts:24` | — | Kept. `llm\|agent\|sdk` union; only RunnerSpec.kind switch. |
| Engine resolver | `src/integrations/agent/engine-resolution.ts` | — | Kept (:271/:282/:305). |
| SearchDocument + write-path indexer | `src/indexer/index-written-assets.ts` | 157 | Kept; already wired into proposal promotion (`repository.ts:1295`). |
| Search/ranking stack | `src/indexer/search/*` | — | Kept; `ranking-contributors.ts` salience contributor **parity-flipped** (D10), not removed. |
| Base linter | `src/commands/lint/base-linter.ts` | — | Kept; L1 engine. Extended with SKILL.md validator + wiki xref fold-in. |
| Migration ledger | `src/storage/engines/sqlite-migrations.ts` | — | Kept; single schema authority; apply-batch reuses its transaction discipline. |
| Curate/eval harness | `scripts/akm-eval/src/curate-bench.ts`, `src/core/eval/rank-metrics.ts` | — | Kept; L2 evaluator + merge gate. |
| `deepMergeConfig` | — | — | Kept; single merge impl for config/setup/strategy/overlay. |

### 4.2 Dies in 0.9.0

| What | Path / anchor | Mechanism |
|---|---|---|
| Wiki asset-type + wiki command subsystem | `src/wiki/wiki.ts` (1182, 40 exports incl. `lintWiki`), `wiki-templates.ts` | Fold `lintWiki` broken-xref (`wiki.ts:919-1000`) into base-linter missing-ref extension (SPEC-1). **Do not delete `wiki.ts` wholesale** — retire the command surface, preserve xref checks as an L1 fold-in. |
| Source `wikiName` special case | `src/sources/*` | Deleted. |
| Bundle-local `.akm` runtime state | (per-bundle) | Deleted; state centralized. |
| Direct semantic mutation processes | improve monoliths | Die via D6/D8 proposal-only + snapshot. |
| Type-derived write paths | improve/proposal write path | Already `ResolvedWriteTarget` (INT-1); residual type-derivation removed. |
| Candidate→proposal→plan→changeset intermediate types | improve/proposal | Collapsed into single `Proposal` (D4). |
| Overlapping cooldown/dedup/grace/no-op caches | improve selection | Replaced by single `manifestHash` (D8). |
| Self-confidence auto-apply gate | `improve-auto-accept.ts` | Retired; auto-apply gated on L1/L2 (D7). |
| D9 delete-list items | config-schema + loop | Removed from loop **and** `config-schema.ts`. |
| Vestigial `_config` param | `config.ts:250` `getImproveProcessConfig` | Deleted. |

### 4.3 Re-plumbed (highest blast radius)

Improve monoliths (`src/commands/improve/`, ~23.7K LOC / 38 files) converted recipe-by-recipe behind the envelope facade:
`preparation.ts` (2375; `runImprovePreparationStage`), `consolidate.ts` (3118; `akmConsolidateInner`), `reflect.ts` (1645), `improve.ts` (1565; `akmImprove`), `distill-promotion-policy.ts` (1510), `extract.ts` (1477), `loop-stages.ts` (1403), `distill.ts` (1324), `recombine.ts` (1009). Per-process files deleted **only after** all emit through the unified path.

Ambient-access debt to retire during re-plumb: `loadConfig()` 90×, `resolveStashDir()` 56×, `_set…ForTests` 22 seams. A lint guard (modeled on `scripts/lint-runtime-boundary.ts`) forbids **new** `loadConfig`/`resolveStashDir` in improve leaves.

---

## 5. Single-Track Execution Order

Each chunk is an **in-branch work unit** (not a release). Every chunk ends with `bun run check` green and its named gate passing before the next begins. Deletions happen in the **same chunk** as the replacement lands (deletion ledger), so the tree never carries dead duplicates. This reconciles doc2's dependency-first vertical-slice *ordering* with the no-release mandate: the slices are commit clusters, not shippable increments.

**Chunk 0 — Re-measure & scaffold guards.**
- Snapshot current LOC/call-site census (db.ts 2063, `.optional()` 252, `resolveStashDir` 56, `loadConfig` 90) so sizing is not off drifted numbers.
- Classify every test as **INVARIANT** (must stay green throughout) vs **EXPECTED-CHURN** (re-baselined deliberately):
  - Invariants: `tests/contracts/*` (asset-types, config-schema-drift, engine-boundary, extension-points, migration-baseline, module-boundaries, ref-resolver-contract, reflect-propose-envelope, runtime-boundaries), `tests/architecture/*`, `tests/workflows/conformance`, lint guards.
  - Churn: `tests/storage/__snapshots__`, `tests/commands/__snapshots__`, output-baseline snapshots.
- Add the ambient-read lint boundary (no new `loadConfig`/`resolveStashDir` in improve leaves).
- **Gate:** `bun run check` green; new lint guard active; census recorded.

**Chunk 1 — Freeze the kernel contracts.**
- Land `FileChange`, `Proposal` (with bounded evidence envelope), `Diagnostic`, and the 3-method adapter contract as **contracts tests first** (`extension-points.test.ts`, extend `reflect-propose-envelope.test.ts`). Drop `planUpdate`.
- Add typed provenance/source-ref fields to `SearchDocument`.
- **Deletion ledger:** remove `planUpdate` surface and any candidate/plan intermediate type stubs with no runtime consumer.
- **Gate:** contracts tests green; adapter surface pinned; `bun run check` green.

**Chunk 2 — Snapshot + proposal-only apply machinery.**
- Build the unified hash manifest `{ref→{absPath,beforeHash}}` folding in config/engine version + DB cursor; wire proposal-only run, one end-of-run transactional apply (reusing `sqlite-migrations` discipline), reindex-affected-once, abort-on-drift.
- Crash-test the apply (model on `migration-apply-crash.test.ts`).
- Still drives the **existing** processes (facade not yet built) — no behavior change yet.
- **Deletion ledger:** delete the cooldown/dedup/grace/no-op cache modules; `manifestHash` replaces them.
- **Gate:** crash test green; config-ahead-of-DB skew test fails closed; `bun run check` green.

**Chunk 3 — Recipe-by-recipe conversion to revise/learn behind the envelope facade.**
- Introduce the stable proposal-emitting facade. Convert one process at a time: `reflect` (revise) first, then `extract`/`distill`/`inference`/`recombine`/`synthesis` (learn). consolidate/recombine emit multi-file `FileChange[]` with non-destructive supersession. CLS gate becomes a `minConfirmingRuns` strategy-JSON field.
- Preserve the 12 strategy JSONs + `improve-cli-surface.test.ts` as behavioral invariants per conversion.
- **Deletion ledger (per conversion):** delete each per-process monolith's direct-mutation path and its per-process unit tests **only after** it emits through the facade; replace with envelope/recipe contract tests. Delete the `_config` param on `getImproveProcessConfig`.
- **Gate (per conversion):** `improve-cli-surface.test.ts` + strategy-JSON behavioral tests green; no new ambient reads; `bun run check` green.

**Chunk 4 — Verification ladder + auto-apply policy.**
- Wire L1 (existing base-linter/missing-ref/secrets/before-hash) + the new SKILL.md L1 validator; fold wiki broken-xref into base-linter missing-ref.
- Implement the single L2 evaluator over `curate-bench.ts`/`rank-metrics.ts` with the mandatory `'no-automatic-evaluator'` state.
- Encode the auto-apply contracts test ("L1 pass AND (L2 effect-floor + no protected regression)"); retire the self-confidence gate on `improve-auto-accept.ts`.
- **Deletion ledger:** delete the wiki command subsystem surface + `wikiName` special case; delete self-confidence auto-apply gating.
- **Gate:** auto-apply contracts test green; SKILL.md validator test green; wiki xref checks still fire via base-linter; `bun run check` green.

**Chunk 5 — D9 deletions.**
- Remove each delete-list item from the loop **and** `config-schema.ts` (drop fields). File a one-line prove-or-delete ticket per item (baseline + effect floor).
- **Deletion ledger:** self-confidence authorization, confidence-threshold auto-tuning, live-exploration promotion, Jaccard self-consistency voting, generic self-critique loops, same-run multi-cycle improve, generic cross-format lesson judge, procedural learning in core, LLM-directed semantic merge/delete, proactive rewrite without corrective evidence.
- **Gate:** `config-schema-drift.test.ts` green with **shrunk** `.optional()` count; `bun run check` green.

**Chunk 6 — D10 salience parity flip + ablation gate.**
- One-line reversible config default flip to salience parity (`outcomeWeightEnabled:false` → w_o=0 and/or default `salience-ranking` contributor OFF). Machinery and state tables **untouched**.
- Add stack-level ablation (`AKM_ABLATE_CONTRIBUTORS`) as a merge gate on curate-golden + E6.
- **Deletion ledger:** none (reversible flip, not deletion).
- **Gate:** curate-golden nDCG/MRR non-regression; stack-level ablation gate green.

**Chunk 7 — Migration (single atomic last step).**
- See §6. Runs as the final in-branch work. `akm migrate --dry-run` report; verified restorable backup; atomic layout + state re-key + 009/010/017 + workflow-010 before configVersion flip; unconditional continuity assertion.
- **Deletion ledger:** bundle-local `.akm` runtime state; type-derived write path residue; any old-layout writers.
- **Gate:** fresh-install smoke + upgrade-from-beta.52 smoke both green; migration report shows zero orphaned `asset_salience`/`asset_outcome`/`feedback` rows.

**Merge to main (the single release gate):** `release-gates.yml` + fresh-install smoke + upgrade-from-beta.52 smoke + curate-golden nDCG/MRR non-regression + stack-level ablation gate, all green.

---

## 6. Data & State Migration (one-time, embedded in the cutover)

**Authority:** driven from **existing `AssetSpec` data** (`stashDir`/`toAssetPath`/`toCanonicalName` for the 15 types) — the only ground truth for old-layout placement. This is a primary reason the taxonomy is kept for 0.9.0 (§1.3).

**Order (single atomic operation, backup-boundary-wrapped):**
1. **Layout detection** — key on the **DB migration cursor**, not config version (fixes MIG-2). Detect old-layout (`AssetSpec`/type-dirs/wiki) vs native bundle.
2. **`akm migrate --dry-run`** — emit the ref-remap + state-re-key report **before any destructive step**.
3. **Verified restorable backup** — mandatory, written **and verified restorable** before any write; refuse to proceed otherwise (the documented live incident had no valid backup).
4. **Layout conversion** — old-layout → native bundle formats.
5. **Ref remap** — `type:name` → new bundle refs, via `asset-ref.ts`.
6. **State re-key** — re-key `asset_salience` (migration 009), `asset_outcome` (010), and `feedback` rows (all ref-keyed by `type:name`, F6) to new refs. Run state 017 + workflow-010 here.
7. **Config translation** — **real** `profiles→engines/strategies` translation (diagnostic-only is wrong under no-legacy-adapter), including `Fast/fast` unified-map collision handling.
8. **`configVersion` flip — the LAST write**, gated on successful state.db (017) + workflow.db (010) migration + verified backup.
9. **Report** — assert **re-keyed-vs-orphaned counts** for `asset_salience`/`asset_outcome`/`feedback`. **Fail closed to backup-restore if any outcome history would be orphaned — UNCONDITIONALLY** (not gated on the D10 outcome; the tables persist even under the parity flip and a post-0.9.0 pass may revive outcome weighting).

**Properties:** idempotent, resumable (per `migration-apply-crash.test.ts` discipline). **Decouple routine reads/telemetry from backup enforcement** (`core/events.ts:238` → `core/state-db.ts:108` → `core/migration-backup.ts:194+`) so a partially-migrated install still reads (fixes MIG-8). **Fix the false self-update message** that claims `akm index` migrates config (it won't).

**No permanent dual-format / legacy-akm compatibility adapter.**

---

## 7. Verification & Evaluation Strategy

Grounded in existing tooling; **build no new eval platform inside improve.**

### 7.1 Frozen case sets to build
- **curate-golden** (`scripts/akm-eval`) — the deterministic retrieval fixture; L2 evaluator + merge gate on nDCG/MRR non-regression.
- **E6 disjoint-domain corpus** — for the stack-level ablation gate (regime-robust; already shows the tuned stack net-negative, meanNdcg 0.673→0.723 when all score contributors ablated).
- **Trigger / holdout / canary / negative slices** — reported **per-slice, never one aggregate** (sequentially-evolving-memory degradation hides in aggregates; arXiv:2605.15384).
- **Collapse/entropy canary** — churn/collapse detector for the L2 evaluator.
- **Task-replay set** — deterministic replay for behavioral L2 and for the "failed task replay" corrective-evidence signal.

### 7.2 Auto-apply policy per level
- **L1-only (mechanical):** auto-apply allowed.
- **L2 objectively-verified-semantic:** auto-apply allowed **iff** effect floor met **and** no protected-field regression.
- **`'no-automatic-evaluator'` (prose/skills):** auto-apply **forbidden** → route to L3 human.
- **Self-confidence:** metadata only, never a gate.
- Encoded as a contracts test on `improve-auto-accept.ts`.

### 7.3 Merge gates (the single release)
`release-gates.yml` + fresh-install smoke + upgrade-from-beta.52 smoke + curate-golden nDCG/MRR non-regression + stack-level ablation gate.

---

## 8. Prove-or-Delete Experiments

Each carries a one-line ticket recording **baseline, metric, harness, effect floor, kill criterion**. Re-entry of any D9-deleted item uses the identical bar.

| Target | Baseline | Metric / harness | Decision for 0.9.0 | Kill criterion (post-0.9.0) |
|---|---|---|---|---|
| **Salience rank-score (D10)** | BM25+vector stack without salience | Stack-level ablation (`AKM_ABLATE_CONTRIBUTORS`) on curate-golden + E6, per-slice | **Parity flip (reversible), machinery + tables kept.** Live booster neutralized; nothing deleted. | After §7 clamp fix: if per-contributor ablation on the fixed (unsaturated-regime) harness shows salience does not beat baseline by the effect floor on a disjoint corpus → delete wiring, keep tables until re-key story resolved. |
| **Outcome-weight term (D10)** | w_o=0 parity | Same harness | **Parity (w_o=0) for 0.9.0.** | Same as salience; revive only if it beats parity on the fixed harness. |
| **LLM graph extraction / boost (D10)** | BM25+vector without `graph-boost` | Stack-level ablation, per-slice, disjoint corpus | **Kept but measured**; not flipped (no evidence of live harm distinct from salience). | Delete `graph-extraction`/`graph-boost`/`graph-dedup` if it fails to beat baseline on the fixed harness. |
| **D9 deletions** (self-confidence auth, confidence auto-tuning, Jaccard voting, generic self-critique, same-run multi-cycle, generic lesson judge, procedural-in-core, LLM-directed merge/delete, proactive rewrite w/o corrective evidence) | current behavior | curate-golden + collapse-canary | **Deleted now** (from loop + config-schema). | Re-entry requires beating the named baseline + collapse-canary by the declared effect floor. |

**Blocking constraint (why per-contributor verdicts are deferred):** the in-repo ablation returns Δ=0 for 12/13 contributors on curate-golden **and** E6 as a saturation artifact (clamp+quantize+alphabetical-tiebreak). Per-contributor prove-or-delete is **unmeasurable** until the §7 clamp/sort fix + unsaturated-regime queries land (open research, off the critical path). The **stack-level** ablation is regime-robust and drives the 0.9.0 parity decision.

---

## 9. Risks of the Single-Track Approach + Mitigations

| Risk | Why it bites under single-track | Mitigation |
|---|---|---|
| **Big-bang integration / tree goes red** | D5 re-plumbs six 1.5–3K-LOC monoliths; stacking taxonomy deletion would compound it. | Recipe-by-recipe conversion behind a stable facade; **taxonomy deletion removed from 0.9.0**; deletion ledger per chunk; `tests/contracts` + `tests/architecture` as trunk gates on every commit; `check:changed` as the fast per-commit loop. |
| **Migration is one-shot with no fallback** | No intermediate release; local-only iteration; documented live config-ahead-of-DB incident with no valid backup. | Atomic backup-verified-restorable migration; DB-cursor-keyed detection; `--dry-run` report; idempotent/resumable; unconditional continuity assertion with fail-closed-to-restore; reads decoupled from backup enforcement; two migration smokes (fresh + upgrade-from-beta.52) as merge gates. |
| **Ambient config/path debt defeats engine threading** | 90× `loadConfig`, 56× `resolveStashDir`; leaves re-derive stale defaults after the orchestrator resolved the engine/strategy. | Lint boundary forbidding new ambient reads in improve leaves; delete `_config` param; snapshot-manifest-only fs reads. |
| **Silent capability loss via deletion** | D9/D12 remove code with no compile-visible signal. | Every deletion carries a prove-or-delete ticket (named baseline + effect floor); deletion removes config-schema fields so `config-schema-drift.test.ts` and `.optional()` count visibly shrink. |
| **Deleting load-bearing ranking machinery on a blind metric** | Naive prove-or-delete would delete salience/graph-boost on a saturated metric. | Defer per-contributor verdict; 0.9.0 uses reversible parity flip only; stack-level ablation (regime-robust) is the merge gate. |
| **Two hashing subsystems / evidence bloat** | D6 manifest + D8 fingerprint, and a per-process evidence schema, could ship as duplicate machinery. | One manifest hash = the fingerprint; evidence envelope bounded to typed L1/L2/L3 slots + one open bag. |
| **Local iteration cannot verify a learning system** | No field L3 before ship. | curate-golden nDCG/MRR non-regression as a hard merge gate; adopt the post-rc.2 30-clean-day `improve_cycle_metrics` window as the L3 field-outcome window single-track permits. |

**Rollback model:** because there is no intermediate release, rollback = **branch reset** (discard the integration branch) up to merge. Post-merge, the only in-field rollback is the migration's verified restorable backup — hence the unconditional backup-verify gate. **Oracle/golden tests are captured from *current* `cf44e11` behavior** (strategy JSONs, `improve-cli-surface.test.ts`, output-baseline/storage/commands snapshots) at Chunk 0 so each conversion is checked against real prior behavior, not a re-imagined spec.

---

## 10. Definition of Done for 0.9.0

0.9.0 merges to main when **all** hold:

1. **Kernel:** one `SearchDocument` with typed provenance fields; `index()` resolves ref→absPath; improve reads via fs from the snapshot manifest only. No semantic-views registry, universal item hierarchy, or adapter `read()` facade in the tree.
2. **Adapter:** 3-method+optional contract with **no `planUpdate`**, pinned in `extension-points.test.ts`.
3. **Proposal:** single `FileChange[]+beforeHash+status` object; bounded evidence envelope; candidate/plan/changeset intermediate types deleted.
4. **Improve:** only two verbs (revise/learn); all recipes emit through the unified facade; per-process monoliths' direct-mutation paths deleted; consolidate/recombine use non-destructive supersession; CLS gate is a strategy-JSON config value.
5. **Run model:** snapshot = hash manifest (no copied workspace); proposal-only; one transactional batch; reindex-once; abort-on-`beforeHash`-drift; config-ahead-of-DB skew fails closed; the manifest hash is the sole selection fingerprint (cooldown/dedup/grace/no-op caches deleted).
6. **Verification:** L1 deterministic + SKILL.md validator; wiki broken-xref folded into base-linter missing-ref; L2 single evaluator with `'no-automatic-evaluator'` state; auto-apply contracts test enforces mechanical-or-L2-verified; self-confidence gate retired.
7. **Deletions:** all D9 items removed from loop **and** `config-schema.ts`; `.optional()` count measurably reduced; each deletion has a prove-or-delete ticket. Wiki command subsystem, `wikiName` special case, bundle-local `.akm` state, type-derived write paths gone.
8. **Salience:** reversible parity flip applied; machinery + state tables intact; stack-level ablation gate green on curate-golden + E6.
9. **Migration:** `akm migrate` performs real `profiles→engines/strategies` translation with `Fast/fast` handling; atomic, backup-verified-restorable, idempotent/resumable; DB-cursor-keyed detection; configVersion flip is the last write; report shows **zero orphaned** `asset_salience`/`asset_outcome`/`feedback` rows; routine reads decoupled from backup enforcement; false self-update `akm index` message fixed.
10. **Green:** `bun run check` green on every commit of the integration branch; merge gated on `release-gates.yml` + fresh-install smoke + upgrade-from-beta.52 smoke + curate-golden nDCG/MRR non-regression + stack-level ablation gate.
11. **Taxonomy retained** (rubric-amended): `AssetSpec`/type-dirs/type-routed lint/renderer-action maps still present and contract-tested; their retirement is a signed-off post-0.9.0 cutover.
12. **Sign-off recorded** on the three evidence-driven rubric amendments (D12 taxonomy-kept, D10 premise-corrected, post-0.9.0 deferrals of the saturation fix + per-contributor prove-or-delete).