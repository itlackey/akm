# AKM 0.9.0 — Bundle/Adapter + Simplified Architecture: Final Implementation Plan

**Status:** Consensus-approved, implementation-ready. Supersedes doc1 (`improve-self-learning-analysis.md`) and doc2 (`engine-strategy-refactor-plan.md`) where they conflict.
**Branch model:** single long-lived integration branch, one cutover, ships as 0.9.0.
**Baseline commit:** `cf44e11` (already post engine/strategy cutover).

**User sign-off recorded (2026-07-13):** the FULL asset-taxonomy retirement is **FOLDED INTO 0.9.0**. There is **no separate post-0.9.0 taxonomy cutover.** In the shipped 0.9.0 runtime, `AssetSpec` + the `ASSET_SPECS_INTERNAL` registry, type-directory mapping, the closed `AkmAssetType` taxonomy, the type-routed lint registry, the type-to-renderer/type-action maps, and the global matcher competition/specificity contest are all **GONE from the live path** — replaced by per-format bundle adapters + L1 validators folded in. The old-layout knowledge required by the one-time migrator ships in the 0.9.0 binary as a single **quarantined pure leaf module**, isolation-tested and `@removeIn 0.10.0`. The two remaining accepted amendments **stand**: salience is neutralized by a **reversible parity config flip** (machinery + state tables **kept, not deleted**); the ranking saturation-harness fix and the per-contributor prove-or-delete verdict stay **deferred off the single-track critical path**.

---

## 1. Executive Decision & Scope

### 1.1 What 0.9.0 is

0.9.0 is the **file-and-search kernel** cutover. AKM stops being a type-taxonomy-routed asset platform with a candidate→proposal→plan→changeset pipeline and multiple parallel learning substrates, and becomes:

- **A ref→file resolver over one normalized model.** `index()` resolves a `type:name` ref to an absolute path and emits one `SearchDocument`. `improve` reads files directly from the filesystem (from a frozen snapshot manifest, never the live tree).
- **A two-verb improve loop.** Every semantic operation is either **revise** (rewrite an existing file) or **learn** (create a new file from evidence). `extract`/`distill`/`inference`/`recombine`/`synthesis` become `learn` recipes; `reflect` is a `revise` recipe.
- **A proposal-only, snapshot-bounded run model.** One frozen input snapshot per run (hash manifest, not a copied workspace); every semantic process emits `Proposal` objects carrying `FileChange[]`; no mid-run semantic writes or reindex; one transactional apply at end; reindex affected paths once.
- **A small bundle-adapter contract with per-format ownership.** Adapters index (recognize + normalize their own format), provide guidance paths, validate `FileChange[]`, and optionally place new files. There is **no global type taxonomy, no closed `AkmAssetType`, and no matcher-competition/specificity contest** — each format is owned by exactly one adapter with explicit recognition. Adapters never own mutation.
- **A verification ladder that gates auto-apply on evidence, not self-confidence.** L1 deterministic safety (base checks + per-format L1 validators), L2 behavioral/comparative evidence, L3 field outcome. Self-confidence is metadata only.

The **taxonomy dies in 0.9.0** (§4.2, D12). "Zero taxonomy in the runtime" means zero on the **live path** — `index → search/rank → lint → improve → write`. The one-time migrator still ships in the 0.9.0 binary (it must, because `akm migrate` runs on the user install using that binary), but its knowledge of the old 15-type layout is confined to a **quarantined pure leaf module** (`src/migrate/legacy/legacy-layout.ts`) that is isolation-tested, imports nothing from the deleted registry surfaces, and is marked `@removeIn 0.10.0`.

### 1.2 Single-track mandate (non-negotiable — D1)

- One aggressive refactor on **one long-lived integration branch**.
- **No intermediate releases.** 0.9.0 is the first and only release of the new architecture.
- **No staged/dual-format compatibility layer.** Migration is a one-time cutover embedded in the branch.
- Only **local iteration** for testing/verification.
- **"No intermediate release" binds releases, not commit hygiene.** The tree stays green per-commit (`bun run check`), gated by `tests/contracts` + `tests/architecture`. The staged "release/0.9 maintenance branch + releasable vertical slices + feature freeze" model from doc2 Perspective 3 is **rejected**; doc2's vertical-slice *ordering* is retained as in-branch chunk ordering (§5). The taxonomy fold is split into an **enabling seam (Chunk 1.5) + a per-format replacement ledger (Chunk 4.5) + a migration-consuming deletion (Chunk 7)** precisely so that big-bang deletion — forbidden by Risk row 1 — never happens.

### 1.3 Explicitly out of scope for 0.9.0

Two items only remain deferred off the single-track critical path (evidence-driven, panel amendment to the rubric):

1. **Ranking saturation-harness fix** (`ranking-ablation-and-saturation-analysis.md` §4/§7/§8: displayScore clamp+quantize+alphabetical-tiebreak) and the run-to-run stability guard (#14). This is open research and stays off the critical path.
2. **Per-contributor prove-or-delete verdict** for salience/outcome and LLM graph extraction. For 0.9.0, a reversible parity config flip stands in (§8, D10); machinery and state tables are **kept, not deleted**.

**Taxonomy retirement is NO LONGER deferred.** The prior "full asset-taxonomy retirement → separate post-0.9.0 cutover" deferral is **removed by user decision**; the full retirement is folded into 0.9.0 (§4.2, §5 Chunks 1.5/4.5/7, D12). Salience stays under the reversible D10 parity flip (machinery/state tables kept).

**Rubric-amendment flags requiring maintainer sign-off** (panel consensus, not disagreement): (a) **taxonomy folded into 0.9.0 — user-approved**; (b) D10 premise corrected from "salience inert (w_o=0)" to "salience live-but-unproven/leaning-negative → parity flip"; (c) the two deferrals above.

---

## 2. Target Architecture

### 2.1 Kernel primitives

**`BundleMount`** — a mounted source of bundle files. Carries the source id/root and the adapter that indexes/validates it. Replaces bundle-local `.akm` runtime state (dies, D12) and the source `wikiName` special case (dies). Runtime state lives centrally, not per-bundle.

**`SearchDocument`** — the **only** common normalized model (D2). Already exists in `src/indexer`. Amendments:
- **Add typed source-ref/provenance fields NOW** (`sourceRef`, origin path/bundle, content hash) — load-bearing for auditable rollback (doc1 R8). Unanimous.
- **`SearchDocument.type` is an open string provenance token**, no longer a member of a closed `AkmAssetType` union. It is stamped by the recognizing adapter; consumers treat it as an opaque namespace token (§4.3 severances).
- **Do NOT add a first-class salience/outcome field.** Salience is live-by-default but unproven and leaning net-negative on disjoint corpora (D10/F4); committing the one kernel model to it is premature. If salience survives the deferred measurement pass, it composes at the *ranking layer* via the existing `ctx.salienceRankScores` input, not via the kernel document. Any interim metadata rides the D4 open key/value bag.
- No semantic-views registry, no universal item hierarchy, no adapter `read()` facade.

**Recognition is per-format and adapter-owned.** There is no global `runMatchers` specificity competition and no `DIR_TYPE_MAP`. Each adapter recognizes its own format explicitly (recognizer + `placeNew` + locally-stamped renderer/action). The old-layout recognition algorithm survives **only** inside the migrator's quarantined frozen leaf (see below), never on the live path.

**Migrator-only frozen descriptor (`src/migrate/legacy/legacy-layout.ts`).** The migrator's knowledge of the old 15-type layout ships as a single **quarantined pure leaf**: a frozen data table `{type, stashDir, recognizerId}` plus four pure functions (`isRelevantFile`, `toCanonicalName`, `toAssetPath`, `canonicalizeWorkflowName`) **extracted-and-pruned** (copied verbatim, not imported) from the old `asset-spec`, with **zero non-stdlib imports** and zero imports from `src/core/asset/*`, `src/indexer/walk/*`, or `src/commands/lint/*`. No `registerAssetType`, no renderer/action maps, no `TYPE_DIRS` export, no `AkmAssetType` union, no matcher registration. This is the **only** retained derivative of the old taxonomy, and it is deleted with the legacy path (`@removeIn 0.10.0`). It is a *copy*, not a relocation: a `git mv` of the real `asset-spec.ts` (imports `buildWorkflowAction`, `registerActionBuilder`, `registerTypeRenderer` at :7-8) or `matchers.ts` (imports `defaultRendererRegistry`, `looksLikeWorkflow`, `looksLikeWorkflowProgram`, `registerMatcher` at :13-19) would transitively drag the renderer registry, file-context matcher machinery, and both workflow parsers into the quarantine, recreating a live mini-registry and making a strict no-import isolation test unwritable. Relocate-then-prune-to-pure yields the identical artifact — the import graph, not the label, is the deliverable. Pure-JSON is also rejected: recognition is **algorithmic**, not tabular (skill = parent-dirname; workflow ext-collapse; env `.env`→`default`/`<name>.env`→`<name>`; secret = any file minus `.lock`/`.sensitive` sidecars) — a `{stashDir,extensions}` descriptor cannot express it.

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

**`Diagnostic`** — `validate()` return element (`Issue[]`): `{ level, code, message, path, field? }`. Emitted by adapter validation and by L1 checks (base-linter `runBaseChecks` + per-format L1 validators, missing-ref, secrets, protected-fields).

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
- **Each adapter owns recognition, placement, and its renderer/action locally.** `placeNew` (adapter-owned canonicalizer) replaces the deleted `resolveAssetPathFromName`/`TYPE_DIRS` write path; directory-index resolution (`SKILL.md`) and secret sidecar exclusion (`.lock`/`.sensitive`) each land in exactly one adapter with no cross-adapter leakage.
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

- **L1 — deterministic safety** (`base-linter.ts runBaseChecks` + `missing-ref` + **per-format L1 validators folded in**): parse/conformance/links/protected-fields/before-hash/secrets. Per-type linter routing (`LINTER_MAP`/`getLinterForType`) is **deleted**; the old per-type linter checks fold into `runBaseChecks` + a per-format L1 validator owned by each adapter. **NEW: Anthropic SKILL.md contract as the skill-format L1 validator** — name ≤64, description ≤1024 stating what+when, body <~500 lines, progressive disclosure (the format-specific evaluator both docs omit; Anthropic skill-authoring best practices). Wiki broken-xref folds into base-linter missing-ref.
- **L2 — behavioral/comparative** (ONE evaluator, reusing existing tooling): `evaluate(): { score, effectSize, protectedRegression } | 'no-automatic-evaluator'`. Reuses `scripts/akm-eval/src/curate-bench.ts` + `src/core/eval/rank-metrics.ts` + a collapse/entropy canary. The **`'no-automatic-evaluator'` state is mandatory** — for prose/skills where AKM has no automatic evaluator, it forbids auto-apply and routes to L3 human. A judge-only verdict is never labeled "objectively verified" (guards the self-preference-bias vector, arXiv:2410.21819).
- **L3 — field outcome:** human accept, feedback, revert.

**Auto-apply policy:** auto-apply only for **mechanical (L1-only) changes** OR **objectively-verified-semantic** changes (L2 pass with effect floor + no protected regression). Encoded as a contracts test on `improve-auto-accept.ts` so it cannot regress to the current self-confidence gate (distill auto-accepts ~83–85% on self-confidence today — that gate is retired). **Self-confidence is metadata only, never authorization.**

---

## 3. Consensus Record (D1–D12)

| # | Decision | Final resolution & folded amendments | Residual |
|---|---|---|---|
| **D1** | Delivery model | **Single-track, one branch, no intermediate release.** Green-per-commit on a long-lived integration branch; `bun run check` + `tests/contracts` + `tests/architecture` as trunk gates; merge gated on `release-gates.yml` + fresh-install smoke + upgrade-from-beta.52 smoke + **curate-golden nDCG/MRR non-regression** + **migrator-isolation test**. | none |
| **D2** | Kernel | **One `SearchDocument`; index resolves ref→absPath; improve reads via fs from snapshot manifest paths.** Add typed **provenance/source-ref fields now**; `type` is an **open string provenance token** (no closed union); **no salience/outcome field** (unproven/leaning-negative → ranking-layer only if it survives the deferred pass). Lint boundary forbids new `loadConfig`/`resolveStashDir` in improve leaves; drop vestigial `getImproveProcessConfig` `_config` param. | none |
| **D3** | Adapter contract | **Drop `planUpdate`** (zero consumers). `{ index→SearchDocument[], guidancePaths:string[], validate(FileChange[])→Issue[], placeNew? }`, pinned in `extension-points.test.ts`. Adapters own recognition + placement + local renderer/action — no global matcher competition. | none |
| **D4** | Proposal = changeset | **One `FileChange[]+beforeHash+status` object.** Evidence envelope = typed L1/L2/L3 slots + one open bag; self-confidence metadata-only; `beforeHash` sole drift guard. | none |
| **D5** | Two verbs | **revise/learn.** consolidate/recombine = `learn` recipes with non-destructive supersession; CLS gate = recipe config value; convert recipe-by-recipe behind a stable facade. | none |
| **D6** | Snapshot + proposal-only | **Hash-manifest snapshot (never copied workspace); proposal-only; one transactional batch; reindex-once.** Manifest hash folds in config/engine version + DB cursor (skew fails closed). Manifest hash **is** the D8 fingerprint. | none |
| **D7** | Verification ladder | **L1 deterministic-first (base checks + per-format L1 validators + SKILL.md validator); type-routed lint registry deleted; L2 one evaluator with mandatory `no-automatic-evaluator` state; self-confidence metadata-only; auto-apply only mechanical or L2-verified.** | none |
| **D8** | Evidence-driven selection | **One fingerprint = manifest hash.** "No corrective evidence → no unattended rewrite"; corrective evidence defined concretely; usage/salience/age reorder within eligible set only. | none |
| **D9** | Delete-by-default | Remove from loop **AND** `config-schema.ts` (drop fields, don't gate); each deletion carries a prove-or-delete ticket with named baseline + effect floor. | none |
| **D10** | Prove-or-delete salience/graph | **Resolver third path:** naive per-contributor ablation is unmeasurable (saturation trap, F3); stack-level ablation is regime-robust and already net-negative on disjoint E6 (F4). **For 0.9.0: one-line reversible config default flip to salience parity** (`outcomeWeightEnabled:false` → w_o=0 and/or default `salience-ranking` contributor OFF) — neutralize an unproven live booster **without deleting machinery or state tables**. Stack-level ablation (`AKM_ABLATE_CONTRIBUTORS`) added as a merge gate. **Per-contributor verdict + §7/§8 clamp fix deferred.** | premise corrected from "inert" to "live-but-unproven"; sign-off flagged |
| **D11** | Migration | **One-time atomic; recognition sourced from PERSISTED KEYS, not a live registry; convert+remap+re-key+backup+report; no dual-format.** Primary ground truth is the stored `type:name` strings in `asset_salience`/`asset_outcome`/`feedback` + index rows (already minted canonical names) — the migrator **re-keys off those persisted strings** and does not re-run the global matcher. The frozen `legacy-layout.ts` leaf is a verifier/relocator only (old `type:name`→old on-disk path; recognizing un-indexed on-disk files). Ref grammar `[origin//]type:name` stays byte-stable; `type` becomes an open adapter namespace token; re-key is **identity for 13 of 15 types**; only `wiki:*`→`knowledge:*` and explicit-extension workflow rows transform. `--dry-run` surfaces every collision before any destructive step; **any nonzero orphan fails closed to unconditional restore** (not gated on the D10 parity flip). Layout + state re-key + 009/010/017 + workflow-010 **before** configVersion flip (flip keyed on the DB migration cursor, fixes MIG-2). Drift on physical relocation / un-indexed files guarded by the Chunk-0 golden canonical-name oracle. | none |
| **D12** | What-dies | **Full taxonomy DIES IN 0.9.0 (user-approved fold — no separate post-0.9.0 cutover).** Deleted from the live runtime: `asset-spec.ts` (`ASSET_SPECS_INTERNAL` + `AssetSpec` + register/deregister/`TYPE_DIRS`/`resolveAssetPathFromName` etc.), `asset-registry.ts` (renderer/action singletons), closed `AkmAssetType` union in `common.ts`, closed-union validation in `asset-ref.ts`, the entire `matchers.ts` global competition + `file-context.ts` `runMatchers` specificity contest, `path-resolver.ts` type-dir probing, `lint/registry.ts` `LINTER_MAP`/per-type linters, wiki asset-type + wiki command. The four pure recognition fns survive ONLY as the frozen COPY in `src/migrate/legacy/legacy-layout.ts` (`@removeIn 0.10.0`, isolation-tested). Also die now: source `wikiName` special case, bundle-local `.akm` runtime state, direct semantic mutation, type-derived write paths, candidate/plan/changeset intermediates, cooldown/dedup/grace/no-op caches, self-confidence auto-apply gate. | user-approved: folded into 0.9.0 |

**Residual dissent:** none at decision level. Sign-off items flagged for the record: **D12 taxonomy folded into 0.9.0 (user-approved)**, D10 premise-corrected, and the two remaining deferrals (saturation-harness fix + per-contributor prove-or-delete).

---

## 4. Grounded Current-State Map: What Dies / What Survives

*Census re-measured against `cf44e11`. The code-quality-review numbers (dated 2026-07-03/04) are stale — re-measure at branch start before sizing any chunk.* **The full runtime consumer census of the taxonomy is 42 files, not the ~34 earlier estimates — it MUST be enumerated exhaustively before sizing Chunk 4.5 (§5, openItems); any missed consumer silently breaks resolution.**

### 4.1 Survives (reused, not rewritten)

| Subsystem | Path | LOC | Role in 0.9.0 |
|---|---|---|---|
| Ref parser (decoupled) | `src/core/asset/asset-ref.ts` | 140 | **Kept as a pure parser** — grammar + `makeAssetRef`/`refToString` kept; closed-union `isAssetType` validation (:109) and `TYPE_ALIASES` narrowing **removed** (`type` is now an open token). |
| RunnerSpec seam | `src/integrations/agent/runner.ts:24` | — | Kept. `llm\|agent\|sdk` union; only RunnerSpec.kind switch. |
| Engine resolver | `src/integrations/agent/engine-resolution.ts` | — | Kept (:271/:282/:305). |
| SearchDocument + write-path indexer | `src/indexer/index-written-assets.ts` | 157 | Kept; already wired into proposal promotion (`repository.ts:1295`). `type` field becomes open string provenance. |
| Search/ranking stack | `src/indexer/search/*` | — | Kept; `ranking-contributors.ts` salience contributor **parity-flipped** (D10), not removed. `TYPE_BOOST` (:11) already local `Record<string,number>`, no asset-spec import; `entry.type` string comparisons keep working. |
| Base linter | `src/commands/lint/base-linter.ts` | — | **Kept as the L1 engine**; extended with SKILL.md validator + wiki-xref fold-in + per-format L1 validators. Its `getAssetTypes()`-derived `REF_RE` and `resolveAssetPathFromName`/`TYPE_DIRS` ref-path resolution (:142-213) lose their registry source → ref-path resolution becomes **adapter-provided**. |
| Salience machinery + state tables | `src/commands/improve/salience.ts`, `asset_salience`/`asset_outcome` | — | **Kept under the reversible D10 parity flip** — NOT deleted. `import type { AkmAssetType }` (:52) → `string`; `makeAssetRef` cast (:650) → `string`; `DEFAULT_TYPE_ENCODING_WEIGHTS` (:135) already `Record<string,number>`, kept as a local table. |
| Migration ledger | `src/storage/engines/sqlite-migrations.ts` | — | Kept; single schema authority; apply-batch and state re-key reuse its transaction discipline. |
| Curate/eval harness | `scripts/akm-eval/src/curate-bench.ts`, `src/core/eval/rank-metrics.ts` | — | Kept; L2 evaluator + merge gate. |
| `deepMergeConfig` | — | — | Kept; single merge impl for config/setup/strategy/overlay. |

### 4.2 Dies in 0.9.0

| What | Path / anchor | Mechanism |
|---|---|---|
| `AssetSpec` + `ASSET_SPECS_INTERNAL` registry | `src/core/asset/asset-spec.ts` (359) | **Deleted from runtime.** `AssetSpec` interface, `ASSET_SPECS_INTERNAL`, `registerAssetType`/`deregisterAssetType`/`getAssetTypes`/`TYPE_DIRS`/`isRelevantAssetFile`/`deriveCanonicalAssetName`/`deriveCanonicalAssetNameFromStashRoot`/`resolveAssetPathFromName`. The four pure fns survive ONLY as the frozen COPY in `src/migrate/legacy/legacy-layout.ts`. |
| Type-to-renderer / type-action maps | `src/core/asset/asset-registry.ts` (100) | Deleted. `TYPE_TO_RENDERER` + `ACTION_BUILDERS` singletons + `registerTypeRenderer`/`registerActionBuilder`/`defaultRendererRegistry`. Renderers/actions become **per-adapter, locally stamped**. |
| Closed `AkmAssetType` taxonomy | `src/core/common.ts:29-86` | Deleted. Closed `AkmAssetType` union + `ASSET_TYPES`/`ASSET_TYPE_SET` (derived from `getAssetTypes()` at module-eval) + `isAssetType` (= `Object.hasOwn(TYPE_DIRS,type)`). Becomes an open adapter-namespace check or is deleted. |
| Closed-union ref validation | `src/core/asset/asset-ref.ts` | `TYPE_ALIASES` closed map + `isAssetType` validation in `parseAssetRef` (:109) + `AssetRef.type` narrowing deleted (file itself **kept** as pure parser, §4.1). |
| Global matcher competition | `src/indexer/walk/matchers.ts` | Deleted **entirely**: `DIR_TYPE_MAP`, `classifyByExtension/Directory/ParentDirHint/SmartMd/Wiki/WorkflowProgram`, specificity numbers, `registerBuiltinMatchers`. Replaced by per-format adapter recognizers with explicit ownership. |
| Matcher specificity contest | `src/indexer/walk/file-context.ts:242-257` | Deleted. `runMatchers` sort-by-specificity / later-registered-wins-ties + `registerMatcher`/`MatchResult` specificity machinery. No global competition survives. |
| Type-dir path probing | `src/indexer/walk/path-resolver.ts` | Deleted (`buildDiskCandidates` via `resolveAssetPathFromName` + `TYPE_DIRS`, :8,28-33). `directoryIndexNames:['SKILL.md']` moves into the **skill adapter**. Resolution becomes adapter-owned. |
| Type-routed lint registry | `src/commands/lint/registry.ts` | Deleted. `LINTER_MAP` subdir→linter routing + `getLinterForType`; per-type linter classes (agent/command/knowledge/memory/skill/task/fact/workflow) fold into `base-linter.runBaseChecks` + per-format L1 validators. |
| Wiki asset-type + wiki command | `src/wiki/wiki.ts` (1182), `wiki-templates.ts` | Wiki asset-type + wiki command + `classifyByWiki`/`wikiMatcher` deleted; broken-xref (`wiki.ts:919-1000`) folds into base-linter missing-ref (SPEC-1). Preserve xref checks as an L1 fold-in; retire the command surface. |
| Source `wikiName` special case | `src/sources/*` | Deleted. |
| Bundle-local `.akm` runtime state | (per-bundle) | Deleted; state centralized. |
| Direct semantic mutation processes | improve monoliths | Die via D6/D8 proposal-only + snapshot. |
| Type-derived write paths | improve/proposal write path | Already `ResolvedWriteTarget` (INT-1); residual type-derivation removed — placement becomes adapter `placeNew`. |
| Candidate→proposal→plan→changeset intermediate types | improve/proposal | Collapsed into single `Proposal` (D4). |
| Overlapping cooldown/dedup/grace/no-op caches | improve selection | Replaced by single `manifestHash` (D8). |
| Self-confidence auto-apply gate | `improve-auto-accept.ts` | Retired; auto-apply gated on L1/L2 (D7). |
| D9 delete-list items | config-schema + loop | Removed from loop **and** `config-schema.ts`. |
| Vestigial `_config` param | `config.ts:250` `getImproveProcessConfig` | Deleted. |

**Only retained taxonomy derivative:** the frozen `src/migrate/legacy/legacy-layout.ts` leaf (four extracted-and-pruned pure fns + a frozen `{type,stashDir,recognizerId}` table, zero non-stdlib imports). It is quarantined, isolation-tested, and **deleted with the legacy path (`@removeIn 0.10.0`)**. It is never on the live path.

### 4.3 Severances in kept machinery (not deletions — the tables are already string-keyed)

| Where | Anchor | Change |
|---|---|---|
| Graph extraction (kept-but-measured) | `src/indexer/graph/graph-extraction.ts:42,944,1159` | `TYPE_DIRS` is a **runtime dep** and MUST be severed to **adapter metadata** (a kept subsystem cannot import the deleted registry). Real extra fold work outside prior D10 scope — **explicitly in-scope now**; confirm the adapter-metadata directory-list interface and add it to the graph-boost subsystem's contract. |
| Salience | `salience.ts:52,650,135` | `import type { AkmAssetType }` → `string`; `makeAssetRef` cast → `string`; `DEFAULT_TYPE_ENCODING_WEIGHTS` already `Record<string,number>`, kept as a local table. |
| Ranking contributors | `ranking-contributors.ts:11,183,320,338,359` | `TYPE_BOOST` already local `Record<string,number>`, no asset-spec import; `entry.type==='memory'/'lesson'/'fact'` are plain string comparisons that keep working. No change beyond confirming no closed-union dependency. |
| ~40 further consumers | (full census, §5 openItems) | Enumerate all 42 runtime consumers exhaustively before Chunk 4.5. |

### 4.4 Re-plumbed (highest blast radius)

Improve monoliths (`src/commands/improve/`, ~23.7K LOC / 38 files) converted recipe-by-recipe behind the envelope facade:
`preparation.ts` (2375; `runImprovePreparationStage`), `consolidate.ts` (3118; `akmConsolidateInner`), `reflect.ts` (1645), `improve.ts` (1565; `akmImprove`), `distill-promotion-policy.ts` (1510), `extract.ts` (1477), `loop-stages.ts` (1403), `distill.ts` (1324), `recombine.ts` (1009). Per-process files deleted **only after** all emit through the unified path.

Ambient-access debt to retire during re-plumb: `loadConfig()` 90×, `resolveStashDir()` 56×, `_set…ForTests` 22 seams. A lint guard (modeled on `scripts/lint-runtime-boundary.ts`) forbids **new** `loadConfig`/`resolveStashDir` in improve leaves.

---

## 5. Single-Track Execution Order

Each chunk is an **in-branch work unit** (not a release). Every chunk ends with `bun run check` green and its named gate passing before the next begins. Deletions happen in the **same chunk/commit** as the replacement lands (deletion ledger), so the tree never carries dead duplicates. This reconciles doc2's dependency-first vertical-slice *ordering* with the no-release mandate: the slices are commit clusters, not shippable increments.

Because the taxonomy fold's blast radius is **42 runtime files** stacked on the improve re-plumb, and big-bang deletion is forbidden by Risk row 1, taxonomy death is split into an **enabling seam (Chunk 1.5) → a per-format replacement ledger (Chunk 4.5) → a migration-consuming deletion (Chunk 7)**, each green-per-commit.

**Chunk 0 — Re-measure, capture goldens & scaffold guards.**
- Snapshot current LOC/call-site census (db.ts 2063, `.optional()` 252, `resolveStashDir` 56, `loadConfig` 90) so sizing is not off drifted numbers.
- **Capture TWO golden fixtures from the live minting code before touching any code:**
  - **(a) Canonical-name ORACLE** over the whole corpus — capture `toCanonicalName` output from the live minting code; the extracted `legacy-layout.ts` pure fns must later reproduce it **byte-for-byte** (drift guard for physical relocation / un-indexed files).
  - **(b) Index-classification / retrieval GOLDEN** (curate-golden nDCG/MRR + `tests/commands/__snapshots__`). **Non-negotiable and belongs HERE, not at migration time:** `classifyBySmartMd` (`matchers.ts:197-222`) resolves ambiguous loose `.md` (agent/command/workflow/knowledge) by **content probe** and `runMatchers` is a genuine specificity contest (`file-context.ts:242-257`, later-registered-wins-ties). Per-format adapter ownership either replicates that probe or consciously reduces unowned `.md` to deterministic `knowledge` — a **behavior change** that can regress the single merge gate. Baseline it now.
- Add the isolation/contract-test skeleton (`tests/architecture/migrator-isolation.test.ts`).
- Classify every test as **INVARIANT** (must stay green throughout) vs **EXPECTED-CHURN** (re-baselined deliberately):
  - Invariants: `tests/contracts/*` (engine-boundary, extension-points, migration-baseline, module-boundaries, ref-resolver-contract, reflect-propose-envelope, runtime-boundaries), `tests/architecture/*`, `tests/workflows/conformance`, lint guards.
  - **Reclassified as EXPECTED-CHURN (no longer INVARIANT):** `tests/contracts/asset-types.test.ts`, `config-schema-drift.test.ts`; plus `tests/storage/__snapshots__`, `tests/commands/__snapshots__`, output-baseline snapshots.
- Add the ambient-read lint boundary (no new `loadConfig`/`resolveStashDir` in improve leaves).
- **Deletion ledger:** none yet.
- **Gate:** both goldens captured + committed; new lint guard active; census recorded; existing suite green.

**Chunk 1 — Freeze the kernel contracts.** (approved, unchanged)
- Land `FileChange`, `Proposal` (with bounded evidence envelope), `Diagnostic`, and the 3-method adapter contract as **contracts tests first** (`extension-points.test.ts`, extend `reflect-propose-envelope.test.ts`). Drop `planUpdate`.
- Add typed provenance/source-ref fields to `SearchDocument`.
- **Deletion ledger:** remove `planUpdate` surface and any candidate/plan intermediate type stubs with no runtime consumer.
- **Gate:** contracts tests green; adapter surface pinned; `bun run check` green.

**Chunk 1.5 — Open the type token (reversible seam, MANDATORY FIRST).**
- Make `type` a **string end-to-end**: `parseAssetRef`/`isAssetType` stop validating the closed union; sever the two type-only `AkmAssetType` imports (`salience.ts:52`, `:650` cast → `string`); confirm `SearchDocument.type` is string provenance.
- `ASSET_SPECS` still exists and still routes, but **NOTHING depends on its closedness.** Mandatory-first because `common.ts` derives the union from the registry at module-eval — the registry cannot die until nothing consumes its closedness.
- **Deletion ledger:** none (zero deletion).
- **Gate:** full suite green with `type` as an open string; **no closed-union dependents remain (grep-verified)**.

**Chunk 2 — Snapshot + proposal-only apply machinery.** (approved, unchanged)
- Build the unified hash manifest `{ref→{absPath,beforeHash}}` folding in config/engine version + DB cursor; wire proposal-only run, one end-of-run transactional apply (reusing `sqlite-migrations` discipline), reindex-affected-once, abort-on-drift.
- Crash-test the apply (model on `migration-apply-crash.test.ts`).
- Still drives the **existing** processes (facade not yet built) — no behavior change yet.
- **Deletion ledger:** delete the cooldown/dedup/grace/no-op cache modules; `manifestHash` replaces them.
- **Gate:** crash test green; config-ahead-of-DB skew test fails closed; `bun run check` green.

**Chunk 3 — Recipe-by-recipe conversion to revise/learn behind the envelope facade.** (approved, unchanged)
- Introduce the stable proposal-emitting facade. Convert one process at a time: `reflect` (revise) first, then `extract`/`distill`/`inference`/`recombine`/`synthesis` (learn). consolidate/recombine emit multi-file `FileChange[]` with non-destructive supersession. CLS gate becomes a `minConfirmingRuns` strategy-JSON field.
- Preserve the 12 strategy JSONs + `improve-cli-surface.test.ts` as behavioral invariants per conversion.
- **Deletion ledger (per conversion):** delete each per-process monolith's direct-mutation path and its per-process unit tests **only after** it emits through the facade. Delete the `_config` param on `getImproveProcessConfig`.
- **Gate (per conversion):** `improve-cli-surface.test.ts` + strategy-JSON behavioral tests green; no new ambient reads; `bun run check` green.

**Chunk 4 — Verification ladder + auto-apply policy.** (approved, unchanged in intent; L1 validators fold in here so they pre-exist for Chunk 4.5 reuse)
- Wire L1 (existing base-linter/missing-ref/secrets/before-hash) + the new SKILL.md L1 validator; fold wiki broken-xref into base-linter missing-ref; **fold the per-format L1 validators into `base-linter.runBaseChecks` HERE** so they pre-exist for adapter reuse.
- Implement the single L2 evaluator over `curate-bench.ts`/`rank-metrics.ts` with the mandatory `'no-automatic-evaluator'` state.
- Encode the auto-apply contracts test ("L1 pass AND (L2 effect-floor + no protected regression)"); retire the self-confidence gate on `improve-auto-accept.ts`.
- **Deletion ledger:** delete the wiki command subsystem surface + `wikiName` special case; delete self-confidence auto-apply gating.
- **Gate:** auto-apply contracts test green; SKILL.md validator test green; wiki xref checks still fire via base-linter; `bun run check` green.

**Chunk 4.5 / "T" — Per-format adapters + per-format deletion ledger.**
- Stand up **one bundle adapter per format** (recognizer + `validate` + `placeNew` + locally-stamped renderer/action), reusing the Chunk-4 folded L1 validators.
- **As each format's adapter lands, DELETE that format's slice of `matchers.ts` / lint registry / renderer map / path-resolver probe IN THE SAME COMMIT** (per-format deletion ledger). Sequence `adapter.placeNew` **before** deleting the type-derived write paths.
- **Delete the `runMatchers` specificity contest (`file-context.ts:242-257`) ONLY once every format is adapter-owned.**
- **Sever `graph-extraction` `TYPE_DIRS` → adapter metadata** (§4.3).
- Directory-index (`SKILL.md`) resolution and secret sidecar exclusion (`.lock`/`.sensitive`) each land in exactly ONE adapter with no cross-adapter leakage.
- **Resolve the content-probe decision (openItems):** if `classifyBySmartMd`'s probe is load-bearing for nDCG/MRR, an adapter must replicate it; otherwise the unowned-`.md`→`knowledge` reduction is a deliberately re-baselined behavior change — not a silent regression.
- **Deletion ledger (per-format, same-commit):** `matchers.ts` `classifyBy*` slice, lint registry entry + per-type linter, renderer/action map entry, path-resolver probe.
- **Gate (per commit):** format's adapter green + its deleted machinery gone + **Chunk-0 retrieval golden non-regressed** (re-baseline deliberately if the content-probe reduction is accepted).

**Chunk 5 — D9 deletions.** (approved, unchanged)
- Remove each delete-list item from the loop **and** `config-schema.ts` (drop fields). File a one-line prove-or-delete ticket per item (baseline + effect floor).
- **Deletion ledger:** self-confidence authorization, confidence-threshold auto-tuning, live-exploration promotion, Jaccard self-consistency voting, generic self-critique loops, same-run multi-cycle improve, generic cross-format lesson judge, procedural learning in core, LLM-directed semantic merge/delete, proactive rewrite without corrective evidence.
- **Gate:** `config-schema-drift.test.ts` green with **shrunk** `.optional()` count; `bun run check` green.

**Chunk 6 — D10 salience parity flip + ablation gate.** (approved; DEPENDS on Chunk 1.5's string-keyed tables landing first)
- One-line reversible config default flip to salience parity (`outcomeWeightEnabled:false` → w_o=0 and/or default `salience-ranking` contributor OFF). Machinery and state tables **untouched**.
- Add stack-level ablation (`AKM_ABLATE_CONTRIBUTORS`) as a merge gate on curate-golden + E6.
- **Deletion ledger:** none (reversible flip, not deletion).
- **Gate:** curate-golden nDCG/MRR non-regression; stack-level ablation gate green.

**Chunk 7 — Migration + registry death (LAST in-branch step).**
- Create `src/migrate/legacy/legacy-layout.ts` — the extracted-and-pruned four pure fns + frozen `{type,stashDir,recognizerId}` table, **zero non-stdlib imports, header `@removeIn 0.10.0`**. **Assert it reproduces the Chunk-0 canonical-name oracle byte-for-byte.**
- Run the migration (§6): `akm migrate --dry-run` collision report; verified restorable backup; recognition sourced from **persisted keys**; canonical-identity reconstruction; ref remap (identity for 13/15 types); state re-key of `asset_salience`/`asset_outcome`/`feedback` + `improve_runs.scope_value` (scope_mode='ref') inside the ONE end-of-run transaction with state-017 + workflow-010; **unconditional fail-closed-to-restore on any nonzero orphan**; configVersion flip is the LAST write, keyed on the DB migration cursor.
- **Once the runtime no longer imports the registry, DELETE** `asset-spec.ts`, `asset-registry.ts`, and the closed-union residue in `common.ts` / `asset-ref.ts` (after the migrator has consumed the frozen COPY).
- Add `tests/architecture/migrator-isolation.test.ts` (nothing outside `src/migrate/legacy/**` imports `legacy-layout`; `legacy-layout` imports nothing from the deleted registry surfaces) + a **min-supported-from-version test**.
- **Deletion ledger (same-chunk, after the migrator consumes the frozen copy):** `asset-spec.ts`, `asset-registry.ts`, `common.ts` closed-union residue; bundle-local `.akm` runtime state; type-derived write-path residue; any old-layout writers.
- **Gate:** migrator-isolation test green; `--dry-run` collision report present; unconditional restore on nonzero orphan proven by `migration-apply-crash.test.ts`; fresh-install smoke + upgrade-from-beta.52 smoke green; full suite green; **runtime import-graph free of `legacy-layout`**.

**Merge to main (the single release gate):** `release-gates.yml` + fresh-install smoke + upgrade-from-beta.52 smoke + curate-golden nDCG/MRR non-regression + stack-level ablation gate + **migrator-isolation test**, all green.

---

## 6. Data & State Migration (one-time, embedded in the cutover)

**Authority — PERSISTED KEYS, not a live registry.** The primary recognition source is the **stored `type:name` strings** already present in `asset_salience` (migration 009), `asset_outcome` (010), `feedback`, and index rows. Those strings **are** the already-minted canonical names, so the migrator re-keys state history directly from them — it does **not** re-run the global matcher competition (`runMatchers`, `file-context.ts:242`) and does **not** re-derive canonical names for state rows. The **frozen `src/migrate/legacy/legacy-layout.ts` leaf** (§2.1) is used **only** for (a) mapping an old `type:name` to its old on-disk path to physically relocate/convert the file, and (b) recognizing on-disk files that have **no persisted row**. This is why no live registry is needed at runtime: old ground truth is DATA (stored refs), not code.

**Order (single atomic operation, backup-boundary-wrapped):**
1. **Recognition** — enumerate distinct `asset_ref` across `asset_salience`/`asset_outcome`/`feedback` + index rows (all already `type:name`). Secondary/verifier only: the frozen directory-keyed recognizer for on-disk files lacking a persisted row.
2. **Layout detection** — key on the **DB migration cursor**, not config version (fixes MIG-2). Detect old-layout vs native bundle.
3. **`akm migrate --dry-run`** — emit the ref-remap + state-re-key report **and surface every collision** (§ collision handling) **before any destructive step**.
4. **Verified restorable backup** — mandatory, written **and verified restorable** before any write; refuse to proceed otherwise (the documented live incident had no valid backup).
5. **Canonical-identity reconstruction** — parse each old `type:name`. For workflow, apply the frozen `canonicalizeWorkflowName` so `workflow:foo.yaml/.yml/.md` collapse to `workflow:foo`. `env`/`secret` names are already stored canonically (`env:default`, `secret:team/deploy.key`).
6. **Layout conversion** — old-layout → native bundle formats. New on-disk placement is computed via the per-format adapter's `placeNew`/canonicalizer, **not** the frozen descriptor. Drift on physical relocation / un-indexed files is guarded by the Chunk-0 golden canonical-name oracle.
7. **Ref remap** — keep the `[origin//]type:name` grammar **byte-stable**; retire only the CLOSED union behind it (`type` becomes an open adapter-owned namespace token). Remap is **IDENTITY for 13 of 15 types** (skill/command/agent/knowledge/memory/lesson/session/fact/script/task/env/secret + collapsed workflow) — no row rewrite, zero orphan surface. Real transforms confined to: **(a) `wiki:<page>` → `knowledge:<page>`** (wiki dies, D12); **(b) workflow rows still carrying an explicit extension → collapsed.** A new ref scheme is **rejected** (would remap every state key and explode orphan risk).
8. **State re-key** — `UPDATE asset_salience/asset_outcome/feedback SET asset_ref=new WHERE asset_ref=old`, plus `improve_runs.scope_value WHERE scope_mode='ref'`, inside the ONE end-of-run transaction (reusing `sqlite-migrations` discipline); **state-017 + workflow-010 run in the same transaction.** Identity rows are no-ops. **IMPORTANT:** `mv-cli.ts` REJECTS wiki refs for re-key (`mv-cli.ts:29,77`), so the `wiki→knowledge` re-key **cannot reuse mv-cli's guard**; reuse the state-rekey SQL pattern (`rekeyStateDbForMove`, :928,957), not the wiki-refusing guard path.
9. **Config translation** — **real** `profiles→engines/strategies` translation (diagnostic-only is wrong under no-legacy-adapter), including `Fast/fast` unified-map collision handling.
10. **`configVersion` flip — the LAST write**, gated on the DB migration cursor (successful state.db 017 + workflow.db 010) + verified backup.
11. **Report** — assert **re-keyed-vs-orphaned counts** for `asset_salience`/`asset_outcome`/`feedback`. Because most re-keys are identity, the expected orphan set is empty, so **any nonzero orphan is a hard legible failure → restore UNCONDITIONALLY** (NOT gated on the D10 parity flip — the salience/outcome tables persist under the reversible flip, and the deferred pass may revive outcome weighting).

**Collision handling (required by the fold).** `wiki→knowledge` and workflow ext-collapse can map two old refs onto one new ref (`wiki:foo` + `knowledge:foo`, or `workflow:foo.md` + `workflow:foo.yaml` — two files / one key). The `--dry-run` report MUST surface **every collision before any destructive step** so operators can pre-resolve. On collision, **FAIL CLOSED to restore** (do NOT silently merge learning history; the workflow adapter's canonicalizer must detect the two-file/one-key case and the migrator must refuse rather than pick one silently).

**Properties:** idempotent, resumable (per `migration-apply-crash.test.ts` discipline). **Decouple routine reads/telemetry from backup enforcement** (`core/events.ts:238` → `core/state-db.ts:108` → `core/migration-backup.ts:194+`) so a partially-migrated install still reads (fixes MIG-8). **Fix the false self-update message** that claims `akm index` migrates config (it won't).

**External old-format bundle import (support-window policy).** With zero legacy recognition on the live path, an `akm import` of a 0.8 registry stash must either be routed through the quarantined migrator during the support window **or** be declared unsupported (migrate-at-source). This needs an explicit release-management policy line — it is the one place the mandate genuinely bites.

**No permanent dual-format / legacy-akm compatibility adapter.** The `@removeIn 0.10.0` marker on `legacy-layout.ts` + the isolation test are the only thing preventing the frozen snapshot from being re-adopted as a live registry / permanent legacy adapter. **Schedule enforcement is a PROCESS risk:** if 0.10 slips, the shipped-but-quarantined migrator becomes exactly the permanent legacy adapter the guard exists to prevent — flag to release management; the code guard cannot enforce the schedule.

---

## 7. Verification & Evaluation Strategy

Grounded in existing tooling; **build no new eval platform inside improve.**

### 7.1 Frozen case sets to build
- **Chunk-0 golden fixtures (captured from live minting code before any code change):** (a) the **canonical-name oracle** over the corpus (drift guard; the extracted `legacy-layout.ts` pure fns must reproduce it byte-for-byte); (b) the **index-classification / retrieval golden** (nDCG/MRR + `tests/commands/__snapshots__`). Any accepted content-probe-classification reduction for unowned `.md` is deliberately re-baselined, not silently regressed.
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

### 7.3 Provenance-type string set pin (replaces the lost compile-time guard)
With the closed `AkmAssetType` union deleted, the compile-time guarantee that ranking (`TYPE_BOOST`, `entry.type` hardcodes), salience (`DEFAULT_TYPE_ENCODING_WEIGHTS`), and adapters agree on the same type strings is gone. **A lint/test pins the provenance-type string set** those three surfaces must agree on. Note: `encoding_source='type-stub'` rows in `asset_salience` (`salience.ts:253/272`) become semantically stale (no live type-weight path) but harmless under the parity flip — confirm the recompute path does not choke on refs whose left token is now an adapter/format id.

### 7.4 Merge gates (the single release)
`release-gates.yml` + fresh-install smoke + upgrade-from-beta.52 smoke + curate-golden nDCG/MRR non-regression + stack-level ablation gate + migrator-isolation test.

---

## 8. Prove-or-Delete Experiments

Each carries a one-line ticket recording **baseline, metric, harness, effect floor, kill criterion**. Re-entry of any D9-deleted item uses the identical bar.

| Target | Baseline | Metric / harness | Decision for 0.9.0 | Kill criterion (deferred) |
|---|---|---|---|---|
| **Salience rank-score (D10)** | BM25+vector stack without salience | Stack-level ablation (`AKM_ABLATE_CONTRIBUTORS`) on curate-golden + E6, per-slice | **Parity flip (reversible), machinery + tables kept.** Live booster neutralized; nothing deleted. | After §7 clamp fix: if per-contributor ablation on the fixed (unsaturated-regime) harness shows salience does not beat baseline by the effect floor on a disjoint corpus → delete wiring, keep tables until re-key story resolved. |
| **Outcome-weight term (D10)** | w_o=0 parity | Same harness | **Parity (w_o=0) for 0.9.0.** | Same as salience; revive only if it beats parity on the fixed harness. |
| **LLM graph extraction / boost (D10)** | BM25+vector without `graph-boost` | Stack-level ablation, per-slice, disjoint corpus | **Kept but measured**; `TYPE_DIRS` runtime dep severed to adapter metadata (§4.3). Not flipped (no evidence of live harm distinct from salience). | Delete `graph-extraction`/`graph-boost`/`graph-dedup` if it fails to beat baseline on the fixed harness. |
| **D9 deletions** (self-confidence auth, confidence auto-tuning, Jaccard voting, generic self-critique, same-run multi-cycle, generic lesson judge, procedural-in-core, LLM-directed merge/delete, proactive rewrite w/o corrective evidence) | current behavior | curate-golden + collapse-canary | **Deleted now** (from loop + config-schema). | Re-entry requires beating the named baseline + collapse-canary by the declared effect floor. |

**Blocking constraint (why per-contributor verdicts are deferred):** the in-repo ablation returns Δ=0 for 12/13 contributors on curate-golden **and** E6 as a saturation artifact (clamp+quantize+alphabetical-tiebreak). Per-contributor prove-or-delete is **unmeasurable** until the §7 clamp/sort fix + unsaturated-regime queries land (open research, off the critical path). The **stack-level** ablation is regime-robust and drives the 0.9.0 parity decision. **Note:** this deferral is orthogonal to the taxonomy fold — the taxonomy dies in 0.9.0 regardless; only the salience/graph verdict waits on the fixed harness.

---

## 9. Risks of the Single-Track Approach + Mitigations

| Risk | Why it bites under single-track | Mitigation |
|---|---|---|
| **Big-bang integration / tree goes red — now compounded by the taxonomy fold** | D5 re-plumbs six 1.5–3K-LOC monoliths; **the fold stacks a 42-file taxonomy-consumer blast radius on top.** The prior mitigation ("taxonomy deletion removed from 0.9.0") is **REVERSED by the user decision.** | **Replacement mitigation:** Chunk 1.5 reversible seam ("open the type token" — nothing depends on registry closedness) + Chunk 4.5 per-format **same-commit deletion ledger** (each adapter deletes its own matcher/lint/renderer/path slice as it lands) + Chunk 7 migration-consuming registry death, each green-per-commit; `tests/contracts` + `tests/architecture` as trunk gates on every commit; `check:changed` as the fast per-commit loop. The **42-file blast radius stacked on the improve re-plumb raises integration-branch red-window and reviewer load under single-track/no-release — accepted.** |
| **Migration is one-shot with no fallback** | No intermediate release; local-only iteration; documented live config-ahead-of-DB incident with no valid backup. | Atomic backup-verified-restorable migration; DB-cursor-keyed detection; `--dry-run` **collision** report; recognition off persisted keys (no live registry); idempotent/resumable; **unconditional continuity assertion with fail-closed-to-restore on any nonzero orphan** (not gated on the D10 flip); reads decoupled from backup enforcement; two migration smokes (fresh + upgrade-from-beta.52) as merge gates; Chunk-0 canonical-name oracle guards physical-relocation / un-indexed drift. |
| **Frozen migrator re-adopted as a permanent legacy registry** | The old recognition algorithm still ships in the 0.9.0 binary; nothing structural stops it becoming the live path again. | `legacy-layout.ts` is a **pure leaf** (zero non-stdlib imports, zero registry imports); `tests/architecture/migrator-isolation.test.ts` asserts nothing outside `src/migrate/legacy/**` imports it and it imports nothing from the deleted surfaces; `@removeIn 0.10.0` + min-supported-from-version test. **Schedule slip is a PROCESS risk flagged to release management — the code guard cannot enforce the 0.10 removal date.** |
| **Lost compile-time type-agreement guard** | Deleting the closed `AkmAssetType` union removes the compiler's guarantee that ranking / salience / adapters agree on type strings. | A lint/test pins the provenance-type string set (§7.3). |
| **Ambient config/path debt defeats engine threading** | 90× `loadConfig`, 56× `resolveStashDir`; leaves re-derive stale defaults after the orchestrator resolved the engine/strategy. | Lint boundary forbidding new ambient reads in improve leaves; delete `_config` param; snapshot-manifest-only fs reads. |
| **Silent capability loss via deletion** | D9/D12 remove code with no compile-visible signal. | Every deletion carries a prove-or-delete ticket (named baseline + effect floor); deletion removes config-schema fields so `config-schema-drift.test.ts` and `.optional()` count visibly shrink; the Chunk-0 retrieval golden catches any classification-behavior regression from adapter recognition. |
| **Deleting load-bearing ranking machinery on a blind metric** | Naive prove-or-delete would delete salience/graph-boost on a saturated metric. | Defer per-contributor verdict; 0.9.0 uses reversible parity flip only; stack-level ablation (regime-robust) is the merge gate. |
| **Two hashing subsystems / evidence bloat** | D6 manifest + D8 fingerprint, and a per-process evidence schema, could ship as duplicate machinery. | One manifest hash = the fingerprint; evidence envelope bounded to typed L1/L2/L3 slots + one open bag. |
| **Local iteration cannot verify a learning system** | No field L3 before ship. | curate-golden nDCG/MRR non-regression as a hard merge gate; adopt the post-rc.2 30-clean-day `improve_cycle_metrics` window as the L3 field-outcome window single-track permits. |

**Rollback model:** because there is no intermediate release, rollback = **branch reset** (discard the integration branch) up to merge. Post-merge, the only in-field rollback is the migration's verified restorable backup — hence the unconditional backup-verify gate. **Oracle/golden tests are captured from *current* `cf44e11` behavior** (strategy JSONs, `improve-cli-surface.test.ts`, output-baseline/storage/commands snapshots, **plus the Chunk-0 canonical-name oracle + retrieval golden**) at Chunk 0 so each conversion is checked against real prior behavior, not a re-imagined spec.

---

## 10. Definition of Done for 0.9.0

0.9.0 merges to main when **all** hold:

1. **Kernel:** one `SearchDocument` with typed provenance fields; `type` is an **open string provenance token** (no closed union); `index()` resolves ref→absPath; improve reads via fs from the snapshot manifest only. No semantic-views registry, universal item hierarchy, or adapter `read()` facade in the tree.
2. **Adapter:** 3-method+optional contract with **no `planUpdate`**, pinned in `extension-points.test.ts`; each adapter owns recognition + placement + local renderer/action; **no global matcher competition / specificity contest survives.**
3. **Proposal:** single `FileChange[]+beforeHash+status` object; bounded evidence envelope; candidate/plan/changeset intermediate types deleted.
4. **Improve:** only two verbs (revise/learn); all recipes emit through the unified facade; per-process monoliths' direct-mutation paths deleted; consolidate/recombine use non-destructive supersession; CLS gate is a strategy-JSON config value.
5. **Run model:** snapshot = hash manifest (no copied workspace); proposal-only; one transactional batch; reindex-once; abort-on-`beforeHash`-drift; config-ahead-of-DB skew fails closed; the manifest hash is the sole selection fingerprint (cooldown/dedup/grace/no-op caches deleted).
6. **Verification:** L1 deterministic (base checks + per-format L1 validators + SKILL.md validator); **type-routed lint registry (`LINTER_MAP`/`getLinterForType`) deleted**; wiki broken-xref folded into base-linter missing-ref; L2 single evaluator with `'no-automatic-evaluator'` state; auto-apply contracts test enforces mechanical-or-L2-verified; self-confidence gate retired.
7. **Deletions:** all D9 items removed from loop **and** `config-schema.ts`; `.optional()` count measurably reduced; each deletion has a prove-or-delete ticket. Wiki command subsystem, `wikiName` special case, bundle-local `.akm` state, type-derived write paths gone.
8. **Taxonomy retired from the live runtime path** (`index → search/rank → lint → improve → write`): `asset-spec.ts` (`ASSET_SPECS_INTERNAL`/`AssetSpec`/`TYPE_DIRS`/`resolveAssetPathFromName` etc.), `asset-registry.ts` (type-to-renderer/type-action maps), the closed `AkmAssetType` union in `common.ts`, closed-union validation in `asset-ref.ts`, the `matchers.ts` global competition, and the `file-context.ts` `runMatchers` specificity contest are **all gone from the runtime**; `graph-extraction` `TYPE_DIRS` runtime dep severed to adapter metadata. `tests/architecture/migrator-isolation.test.ts` green (nothing outside `src/migrate/legacy/**` imports `legacy-layout`; `legacy-layout` imports nothing from the deleted registry surfaces); `@removeIn 0.10.0` marker + min-supported-from-version test present.
9. **Migrator-only descriptor:** the frozen `src/migrate/legacy/legacy-layout.ts` leaf is the ONLY retained taxonomy derivative, is quarantined + isolation-tested, and the **runtime import-graph is free of `legacy-layout`**. It is scheduled for deletion with the legacy path (`@removeIn 0.10.0`).
10. **Migration:** `akm migrate` re-keys `asset_salience`/`asset_outcome`/`feedback` + `improve_runs.scope_value` off the **persisted `type:name` strings** (identity for 13 of 15 types); real `profiles→engines/strategies` translation with `Fast/fast` handling; atomic, backup-verified-restorable, idempotent/resumable; DB-cursor-keyed detection; configVersion flip is the last write; **`--dry-run` surfaces every `wiki→knowledge` / workflow-ext-collapse collision before any destructive step**; any nonzero orphan **fails closed to unconditional restore (not gated on the D10 parity flip)**; report shows **zero orphaned** `asset_salience`/`asset_outcome`/`feedback` rows; routine reads decoupled from backup enforcement; false self-update `akm index` message fixed.
11. **Ref grammar:** `[origin//]type:name` stays **byte-stable**; `type` is an open adapter-owned namespace token; **no new ref scheme.**
12. **Chunk-0 golden fixtures** — canonical-name oracle AND index-classification/retrieval golden (nDCG/MRR + `__snapshots__`) — captured from the live minting code; the extracted `legacy-layout.ts` pure fns reproduce the oracle **byte-for-byte**; any accepted content-probe-classification reduction for unowned `.md` is deliberately re-baselined, not silently regressed.
13. **Type-agreement pin:** a lint/test pins the provenance-type string set that ranking (`TYPE_BOOST`, `entry.type` hardcodes) / salience (`DEFAULT_TYPE_ENCODING_WEIGHTS`) / adapters agree on, replacing the compile-time guard lost with the closed union.
14. **Salience:** reversible parity flip applied; machinery + state tables intact; stack-level ablation gate green on curate-golden + E6.
15. **Green:** `bun run check` green on every commit of the integration branch; merge gated on `release-gates.yml` + fresh-install smoke + upgrade-from-beta.52 smoke + curate-golden nDCG/MRR non-regression + stack-level ablation gate + migrator-isolation test.
16. **Sign-off recorded** on the evidence-driven rubric amendments: **D12 taxonomy folded into 0.9.0 (user-approved)**, D10 premise-corrected, and the two remaining deferrals (ranking saturation-harness fix + per-contributor prove-or-delete).

---

## Appendix — Open items to resolve before/at the named chunk

These do not change any decision above; they are load-bearing details the panel flagged.

1. **Full runtime consumer census is 42 files, not 34** — enumerate exhaustively before sizing Chunk 4.5. Beyond the experts' lists, add: `read/knowledge.ts`, `improve/session-asset.ts`, `core/action-contributors.ts`, `core/lesson-lint.ts`, `standards/resolve-type-conventions.ts`, `indexer/indexer.ts`, `indexer/passes/metadata.ts`, `search-hit-enrichers.ts`, `walker.ts`, `sources/providers/{git-provider,git-stash,provider-utils}.ts`, `workflows/{authoring,exec/brief,runtime/runs,runtime/workflow-asset-loader}.ts`, `integrations/agent/prompts.ts`. Any missed consumer silently breaks resolution.
2. **Content-probe classification decision** — confirm at Chunk 0 whether `classifyBySmartMd`'s agent/command/workflow/knowledge probe is load-bearing for retrieval (nDCG/MRR). If yes, an adapter must replicate it (net-zero abstraction, added risk) rather than reduce unowned `.md` to deterministic `knowledge`. Resolve before Chunk 4.5, not at migration time.
3. **`graph-extraction.ts` `TYPE_DIRS` severance (:42,944,1159)** to adapter metadata is real fold work outside the prior D10 "kept but measured" scope — confirm the adapter-metadata directory-list interface and add it to the graph-boost subsystem's contract.
4. **`asset-ref.ts` friendly errors are taxonomy-flavored** — decide whether the open-token parser keeps the vault-removed `UsageError` (:98-103) and `environment→env` `TYPE_ALIASES` (:26) as adapter-owned string aliases/messages or drops them; dropping degrades upgrade-path error quality.
5. **Single-adapter ownership** — directory-index resolution (`path-resolver` `directoryIndexNames:['SKILL.md']`) and secret sidecar exclusion (`.lock`/`.sensitive`) must each land in exactly ONE adapter with no cross-adapter leakage, or the "no global map" win is illusory.
6. **`encoding_source='type-stub'` rows** in `asset_salience` (`salience.ts:253/272`) become semantically stale — no live type-weight path; dormant under the D10 parity flip. Harmless (`DEFAULT_TYPE_ENCODING_WEIGHTS` kept) but document that type-stub provenance no longer reflects a live code path; confirm the recompute path does not choke on refs whose left token is now an adapter/format id.
7. **Empirically confirm which types actually hold `asset_salience`/`asset_outcome`/`feedback` rows** (wiki? secret? env?) before finalizing orphan-risk sizing — the type-stub path suggests every indexed type gets a row, so `wiki`/`env`/`secret` remap targets are load-bearing for the fail-closed guard.
8. **External old-format bundle import post-cutover** (`akm import` of a 0.8 registry stash) — with zero legacy recognition on the live path, either route import through the quarantined migrator during the support window or declare old external bundles unsupported (migrate-at-source). Needs an explicit policy line (§6).
9. **`@removeIn 0.10.0` schedule enforcement is a PROCESS risk** — if 0.10 slips, the shipped-but-quarantined migrator becomes the permanent legacy adapter the isolation guard exists to prevent. Flag to release management; the code guard cannot enforce the schedule.
10. **Workflow `foo.md` + `foo.yaml` collapsing to one ref** (two files / one key) is ambiguous — the workflow adapter's canonicalizer must detect it and the migrator must refuse (fail-closed) rather than pick one silently; verify this is covered by the `--dry-run` collision surfacing.
