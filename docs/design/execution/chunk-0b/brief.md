# Chunk 0b — Migration goldens & oracles (implementation brief)

Capture-only (netLoc 0). Builds the fixtures/oracles Chunks 2 (adapter parity)
and 8 (migration cutover, re-key merge) depend on, and formalizes the
line-anchor re-measurement. Authority: manifest chunk id "0b" (5 gates),
plan §11/§12.3/§12.4/§15.5, and **`docs/design/execution/chunk-0b/anchors.md`**
(the census — every file:line here is verified there; trust it over the plan).

## Binding decisions (brief author, Opus — maintainer may override, all ledgered)

- **D0b-1 — goldens live under `tests/fixtures/goldens/**` policed by
  `DESIGNATIONS.json`.** Gate 4 ("§15.5 golden inventory committed with
  frozen-vs-re-baseline designation per asset") only has meaning through that
  registry. Recognition/placement/renderer/lint/filter/whyMatched/rank goldens
  are **FROZEN behavior oracles** (Chunk 2 mints adapters that must reproduce
  them byte-for-byte; Chunk 5 unifies the filter paths against them). The
  migration DB fixtures (orphan, rc-train) go under a new
  `tests/fixtures/migration/` tree and, if sha-pinned, get `DESIGNATIONS.json`
  entries; the re-key generator+harness is test **code** (`tests/_fixtures/`
  helper module), not a golden file.
- **D0b-2 — the re-key generator covers 4 concrete key shapes**
  (`{bare, origin-qualified} × {plain, .derived-twin}` → one canonical
  fully-qualified key; anchors E.2), NOT 3 flat categories. The invariant
  harness encodes **Chunk 8's REQUIRED invariants** (no key lost; event rows
  carried as-is with counts preserved; scalar fields **most-recently-updated
  (`updated_at`) wins**; deterministic; idempotent) and MUST exercise the
  simultaneous-collision case (a bare-spelled row AND an origin-qualified row
  for the same conceptual asset present together with different `updated_at`)
  — the case the single-item `rekeyStateDbForMove` (delete-then-rename,
  target-clobbers) was never asked to handle. The generator hard-codes NO
  assumption about where Chunk 8's full-table function will live (it doesn't
  exist yet — no `src/migrate/`).
- **D0b-3 — designation vocabulary.** `DESIGNATIONS.json` today has two kinds:
  `frozen-migration-input` (sha256-pinned) and `re-baseline` (+`reBaselineChunk`).
  0b's parity goldens are frozen behavior oracles, not migration inputs. WI-0b.1
  determines whether to (a) reuse `frozen-migration-input` semantics under a
  broader name, or (b) add a `frozen-behavior-oracle` designation to
  `lint-goldens-presence.ts` (chunk-0a-owned; extend, don't rewrite). Prefer the
  minimal change that keeps the sha256-integrity guarantee for frozen oracles.
  Land the vocab decision in the ledger.
- **D0b-4 — fixture stash for the 14 formats.** `minimal/` has only 5 types.
  Build a dedicated **14-type** fixture stash (all `ASSET_SPECS_INTERNAL` keys:
  skill, command, agent, knowledge, workflow, script, memory, env, secret, wiki,
  lesson, task, session, fact) as the parity substrate — one minimal valid asset
  per type, plus the workflow's two renderer forms (`workflow-md` +
  `workflow-program-yaml`).

## Work items (land as independent commits; each: fixtures + DESIGNATIONS entry + green gate)

- **WI-0b.1 — line-anchor record + micro-fixes.** Commit `anchors.md` (the
  §12.4 re-measurement — gate 2). Fold the two census micro-drifts:
  `lint-goldens-presence.ts:74` message "51" → "50" (matches actual count);
  add a one-line note (not a plan edit — Chunk 10 owns docs) that the
  characterization-suite count is 7, not 6. Resolve D0b-3 (designation vocab)
  here since later WIs depend on it.
- **WI-0b.2 — 14-type fixture stash** (D0b-4). One valid asset per type under a
  new `tests/fixtures/stashes/all-types/` (+ `MANIFEST.json`). Loads clean
  through `buildFileContext`/`runMatchers`.
- **WI-0b.3 — recognition + placement parity goldens (14 formats).** Snapshot
  `runMatchers`/`classifyBy*` recognition results and `toAssetPath` placement
  for every type, PLUS the `deriveCanonicalAssetNameFromStashRoot` minting
  oracle (anchors C: def asset-spec.ts:338-353 + both call-site usages
  mv-cli.ts:739/1239 — freeze output AND the canonical-name reject/derive
  behavior). FROZEN.
- **WI-0b.4 — renderer + lint parity goldens (14 formats).** Snapshot each
  type's renderer output (anchors B.1 renderer column, incl. workflow's two)
  and lint output (dedicated linter or DefaultLinter fallthrough). FROZEN.
- **WI-0b.5 — filter-behavior + whyMatched + rank goldens.** Capture BOTH the
  scored (`searchDatabase`) and enumerate (`enumerateEntries`) filter chains'
  result sets across proposed/belief/scope combinations (anchors D.1) —
  pinning the derived-twin belief-inheritance asymmetry (enumerate has
  `inheritDerivedTwinBeliefStates`, scored does not) BEFORE Chunk 5 unifies
  them. Capture `buildWhyMatched` output alongside the ranked hit set (anchors
  D.2), and a rank-metric snapshot via `scripts/akm-eval/src/rank-metrics.ts`
  (NOT the removed `src/core/eval/*`). FROZEN.
- **WI-0b.6 — migration DB fixtures.** (a) Orphan-bearing fixture: run the FULL
  migration chain (→ `019-proposal-fingerprints`, latest at capture — re-verify
  the ceiling), then seed `asset_salience`/`asset_outcome` orphan rows (refs
  with no on-disk asset) in all 4 spellings (anchors E.1/E.2/E.3). (b) rc-train
  FROM-state fixture: full chain + `workflow.db` present + no `vault` (anchors
  E.4). Gate 3: both exist and LOAD. Do NOT hand-write DDL — apply real
  migrations. Do NOT resurrect `recombine_hypotheses`/`review_pressure`
  (dropped by migration 018).
- **WI-0b.7 — re-key merge property fixtures** (D0b-2; the Chunk-8 gate
  substrate). Seeded RNG generator over the 4 key shapes + invariant harness;
  exercised for real ≥1000 cases by Chunk 8, but 0b lands the generator+harness
  and a smoke run proving they produce/validate randomized state. Invariants
  per anchors E.5. The harness is the ORACLE for a function that does not exist
  yet — it must fail against `rekeyStateDbForMove`'s clobber semantics on the
  collision case (proving it tests the stronger rule), documented in the ledger.
- **WI-0b.8 — inventory + close.** Every new golden gets its `DESIGNATIONS.json`
  entry (frozen vs re-baseline per D0b-1/3); `lint-goldens-presence` green; the
  §15.5 inventory (gate 4) committed; full `bun run check` ONCE; ledger closed
  with the frozen-vs-re-baseline table and the D0b decisions.

## Trap list (census-derived)

1. **4 key shapes, not 3** (finding #2). The generator must treat `.derived` as
   an orthogonal modifier bit, and the harness must test simultaneous collision
   with differing `updated_at` — the current single-item function does NOT prove
   "most-recently-updated wins."
2. Recognition/placement/renderer/lint surface is **100% greenfield** — build
   the fixture stash + goldens from production code; nothing to port (B.3).
3. `discriminatedUnion` grep is a false-negative — chunk-9's config schemas are
   9 named `ProcessConfigSchema` consts; the wide monolith stays by design (A.2).
4. Rank metrics import path is `scripts/akm-eval/src/rank-metrics.ts` — `src/core/eval/*` is GONE (A.1).
5. Every new file under `tests/fixtures/goldens/**` MUST get a `DESIGNATIONS.json`
   entry or `lint-goldens-presence` fails the gate mechanically (F.1).
6. Migration fixtures: apply the real chain, never hand-write DDL; don't
   resurrect `recombine_hypotheses`/`review_pressure` (E.1); `legacy_state` is
   Chunk-8 scope — 0b only seeds orphan ROWS (E.3).
7. Un-piped gates before commits; frozen txn oracles are chunk-6/7 territory —
   0b adds NEW registry entries, never touches the 50 existing ones (F.1).
8. `processSession` is now `ExtractSessionRunCtx`-threaded (A.1) — irrelevant to
   0b's captures but don't be surprised by the shape if a fixture touches extract.
