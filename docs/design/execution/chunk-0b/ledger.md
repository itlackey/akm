# Chunk 0b — execution ledger (append-only)

Migration goldens & oracles. Capture-only (netLoc 0). Branch:
`claude/akm-architecture-refactor-fubvd7` (single designated branch; the
manifest's per-chunk branch names are not used in this execution).

## Opened — grounding census + brief

- `anchors.md` (236 lines): line-drift re-anchoring (§12.4), the 14-format
  producer inventory, the `deriveCanonicalAssetNameFromStashRoot` minting
  oracle, filter/whyMatched/rank surfaces, the migration-fixture shapes for
  Chunk 8, the §15.5 golden inventory (50 DESIGNATIONS entries: 47
  frozen-migration-input + 3 re-baseline), and 6 headline findings.
- `brief.md`: 8 work items (WI-0b.1..8), decisions D0b-1..4, an 8-item trap
  list. All bound to census anchors.

### Decisions recorded (maintainer may override)
- **D0b-1** goldens under `tests/fixtures/goldens/**` (DESIGNATIONS-policed);
  parity goldens are FROZEN behavior oracles.
- **D0b-2** re-key generator = 4 key shapes ({bare,origin-qualified}×{plain,
  .derived}); harness encodes Chunk-8 invariants (most-recently-updated wins),
  exercises simultaneous-collision — the stronger rule the current
  delete-then-rename `rekeyStateDbForMove` does not implement.
- **D0b-3** designation vocabulary for frozen behavior oracles — resolved in
  WI-0b.1.
- **D0b-4** dedicated 14-type fixture stash (`minimal/` has only 5).

### Census findings carried forward (not 0b's to fix, flagged for later chunks)
- Config "discriminated schemas" = 9 named `ProcessConfigSchema` consts, not
  `z.discriminatedUnion`; wide monolith retained by design (grep trap).
- `processSession` threaded into `ExtractSessionRunCtx`, not minted RunContext.
- `src/core/eval/rank-metrics.ts` GONE → `scripts/akm-eval/src/rank-metrics.ts`.
- Micro-drifts folded into WI-0b.1: `lint-goldens-presence.ts:74` "51"→"50";
  characterization-suite count is 7 not 6.

## Work items landed

### WI-0b.1 — line-anchor record + micro-fixes + designation vocab + task-recognition fix
- Line-anchor re-measurement (§12.4, gate 2): committed in `anchors.md` at the
  opening (all drifted anchors re-verified at HEAD).
- Micro-fix (d6907567): `lint-goldens-presence.ts` empty-registry message
  "51"→"50" (actual count).
- **D0b-3 resolved**: reuse the existing `frozen-migration-input` designation
  for 0b's behavior-parity goldens — the registry `$policy` already defines it
  as "a preservation oracle a chunk that touches its surface must reproduce
  byte-for-byte," which is exactly what the parity goldens are. No lint/vocab
  change. Documented in each new entry's notes.
- **Task-recognition DEFECT FIX (ff7ee597)** — maintainer decision "fix now in
  0b" after an investigation confirmed OVERSIGHT (not intentional exclusion):
  `matchers.ts` DIR_TYPE_MAP `tasks` rule tested `.md` (stale since the 0.8.0
  .md→.yml task migration, commit 031c659f, which updated asset-spec/registry/
  renderers/linter but missed the matcher). `runMatchers` returned null for
  every `tasks/*.yml` → `akm show task:` threw, tasks were unindexed/
  unsearchable, the task-yaml metadata contributor was dead. Fixed to `.yml` +
  2 regression tests (fail-before/pass-after); 600+-test ripple sweep, 0
  regressions; no frozen golden affected. anchors.md B.1 census citation
  corrected (it mis-cited `.yml`).

### Fold-in — applyTaskMetadata plain-YAML parse (25df0a85)
Follow-on defect exposed by the recognition fix (per the maintainer's standing
fold-in-defects directive, intent verified first): the `task-yaml` metadata
contributor routed through the `---`-frontmatter helper, but task YAML is
fence-less, so schedule/workflow/prompt searchHints never populated. Fixed to
parse plain YAML (external `yaml`, no cycle); tags unconditional; best-effort.
Unit test + 442-test regression sweep, 0 fail. Cycle held at 28.

### WI-0b.2 — 14-type fixture stash (d6907567)
`tests/fixtures/stashes/all-types/` — one valid, deterministic, lint-clean
asset per ASSET_SPECS_INTERNAL type (14) + a workflow-program-yaml form. The
parity substrate for WI-0b.3/4/5.

### WI-0b.6 — orphan + rc-train migration fixtures (e5f5a2ef)
Deterministic builder modules (tests/_fixtures/migration/) that Chunk 8
consumes: orphan-bearing state.db (4 ref-spelling shapes, real migration chain)
+ rc-train FROM-state (state.db + workflow.db, no vault). Gate 3: exist + load
(smoke 2/2). NOTE: placed under `tests/_fixtures/migration/` (code builders),
reconciling brief D0b-1's `tests/fixtures/migration/` wording — these are code,
not committed data, so they live with the WI-0b.7 generator under `_fixtures`.

### WI-0b.3 — recognition + placement + minting goldens (23aba4a0)
3 frozen goldens (14 formats): runMatchers recognition, toAssetPath placement +
8 edge cases, deriveCanonicalAssetNameFromStashRoot minting (both branches, 32
cases) + mv-cli:739 call-site behavior. Captures the task fix.

### WI-0b.4 — renderer + lint goldens (cd25a769)
2 frozen goldens: per-type renderer output (one <STASH> normalization) + lint
output, with the workflow two-form render/lint split (workflowMd →
WorkflowLinter; workflowProgramYaml → parseWorkflowProgram correctness).

### WI-0b.5 — filter-behavior + whyMatched + rank goldens (e111d6f4)
3 frozen goldens on a new search-filter fixture (proposed/belief/scope/twin
variety): scored-vs-enumerate result sets, whyMatched, rank-metrics
(deterministic via semanticSearchMode:off + hand-authored contrast).
**CENSUS CORRECTION (empirically verified)**: anchors D.1's claim that the
scored path lacks `inheritDerivedTwinBeliefStates` is WRONG — it's called on
BOTH paths (:459/:636); the real asymmetry is candidate-pool construction
(FTS-token-gated scored vs query-independent enumerate). anchors.md D.1
rewritten; the golden pins the corrected mechanism for Chunk 5.

### WI-0b.7 — re-key merge property substrate (b4334024)
Deterministic seeded generator (4 key shapes, forced+randomized collisions over
asset_salience/asset_outcome/events/proposals) + the 5-invariant harness, proven
to discriminate a correct reference (passes) from mv-cli's naive delete-then-
rename clobber (fails scalar-merge-wins on every collision seed). Chunk 8
exercises it for real (≥1000 cases). Enumerated-but-out-of-scope event tables
(task_history/proposal_fingerprints/canary_queries) documented.

## WI-0b.8 — chunk close

### Five manifest gates — verified
1. **Golden fixtures committed** — 8 new frozen behavior-parity goldens
   (recognition/placement/minting/renderer/lint/filter-behavior/why-matched/
   rank-metrics), registered + sha256-pinned.
2. **Line-anchor re-measurement recorded (§12.4)** — anchors.md Section A
   (+ the B.1 and D.1 corrections applied as the captures verified reality).
3. **Orphan-bearing + rc-train FROM-state fixtures exist + load** — WI-0b.6
   builders + smoke test (2/2).
4. **§15.5 golden inventory with frozen-vs-re-baseline designation per asset**
   — DESIGNATIONS.json: 58 entries (55 frozen-migration-input + 3 re-baseline),
   every new 0b golden carries a frozen designation + sha256 + behavior-parity
   notes.
5. **Re-key merge property fixtures committed** — WI-0b.7 generator + invariant
   harness (seeded, 4 key shapes, most-recently-updated-wins), exercised-for-
   real by Chunk 8.

### Net-LOC — capture-only (netLoc 0) + 2 folded-in defect fixes
Chunk 0b's own src delta is only the two task defect fixes (matchers.ts +
renderers.ts, ~+30 LOC net); everything else is tests/fixtures + tests/_fixtures
code (goldens, stashes, migration builders, re-key substrate) — the capture-only
deliverable. (The +48/−21 over src in the b8fbc3a9^..HEAD range also includes
the maintainer's own interleaved commit 84034f7f — default-tasks/improve-result
— which is not chunk-0b work.)

### WI-0b.7 follow-up — smoke-test timeout fix (973ed2b3)
The initial WI-0b.7 smoke test passed standalone but the full `bun run check`
(the close gate) caught a real test-isolation issue: `test:unit` shards
`./tests` (incl. tests/_fixtures) across parallel processes at a 30s per-test
timeout, and the property tests built a 19-migration state.db per seed × 50
(×2 for determinism) → 33-67s under contention → timeout. Fixed
behavior-identically: build the migrated schema ONCE per process into a cached
template, copy-per-seed (migration ledger still verified, migrations no-op on
the copy); smoke seeds 50→10 (forced collisions make 10 sufficient; Chunk 8
runs ≥1000). 37s → ~7s (contention-tested). This is why the full check runs at
every chunk close — per-worker standalone gates don't catch shard-contention
timeouts.
