# Chunk 3 — execution ledger — RETROACTIVE

> **RETROACTIVE LEDGER — reconstructed 2026-07-21 from git history; NOT a
> contemporaneous record.**
>
> **Why this exists:** the 2026-07-21 0.9.0 close-out audit found that chunks 3,
> 4, 5, and 6.5 landed real code on `claude/akm-architecture-refactor-fubvd7` but
> never committed the per-chunk execution ledger that the chunk-manifest's hard
> gate #4 (and the execution-workflow's per-chunk-ledger rule) requires. `git log
> --grep=ledger` shows ledger commits for chunks 0b/1/1.5/2/6/7/8/9/10 but none for
> 3/4/5/6.5. This file backfills the chunk-3 ledger from the commit record.
>
> **Evidence classes used below** (every factual claim traces to one):
> - **[COMMIT]** — a commit hash + its `git show --stat` subject/body/diffstat.
> - **[GREP@HEAD]** — a grep/command actually run at HEAD
>   `e3eec904` (`git rev-parse HEAD`, branch `claude/akm-architecture-refactor-fubvd7`)
>   on 2026-07-21. HEAD is far downstream of chunk 3 (chunks 4–10 landed after),
>   so a HEAD grep proves the *durable* end-state, not the chunk-close state.
> - **[DOC]** — a quote from an existing committed document.
> - **NO RECORD** — the historical record does not answer this; not reconstructable.
>
> **What could NOT be reconstructed** (marked NO RECORD inline):
> contemporaneous Opus review notes / dual-review verdicts, the mid-chunk vs.
> close gate-run logs, batteries-at-close pass/fail totals, and any escalation or
> re-scope events. Commit bodies quote *some* gate numbers self-reported at commit
> time; those are labelled as such and are not independently re-verifiable now.

Chunk 3 — **"Delete taxonomy globals"** (manifest id `"3"`, order 9, wave 2,
branch-of-record `akm-090/chunk-3`; landed on the integration branch
`claude/akm-architecture-refactor-fubvd7`). Companion to plan §11 Chunk 3, §12.4,
§7.2. **Chunk-2 coupling [DOC]:** chunk 2's ledger records the adapter-model pivot
— "an earlier attempt built 10 per-`type` adapters … reverted in full (`a5890bf8`)
… recognition contract pinned in spec §5.1" — and mints the `akm` adapter
additively "(globals stay live until Chunk 3 repoints consumers)". Chunk 3 is that
repoint-and-delete.

## Landed work items

Attributed by `git log --oneline --all --grep="chunk-3"` (4 commits; no other
spelling matched). Ordered chronologically.

| WI | Commit [COMMIT] | Date | Headline |
|---|---|---|---|
| 3.1 | `a519462e` | 2026-07-17 | WI-3.1 — wire adapter `directoryList()`/`looksLikeRoot()` into git-staging pathspecs + install detection, as a `??` fallback beside `TYPE_DIRS` (§12.4: wire adapter path BEFORE deleting globals). Nothing deleted. |
| 3.2 | `90cc0c03` | 2026-07-17 | Extract the pure asset-placement leaf `src/core/asset/asset-placement.ts` (AssetSpec/ASSET_SPECS/TYPE_DIRS/resolveAssetPathFromName/getAssetTypes verbatim); sever `akm-adapter` from `asset-spec.ts` so the adapter becomes a self-contained leaf — prerequisite for the atomic taxonomy cutover. Cycle count held 18. |
| 3.2b | `1fc02c84` | 2026-07-17 | Chunk-3 cutover enabler (VERIFIER-RECOVERED 2026-07-21: escaped the original lowercase `--grep="chunk-3"` because the body capitalizes "Chunk-3"): sever `matchers.ts` → `asset-registry` (resolve renderer via TYPE_PRESENTATION) — the same SCC-breaking maneuver as WI-3.2/3.3, self-described "Prereq for repointing recognition onto the akm adapter without a mid-chunk cycle regression". +6/−2, 1 file. |
| 3.3 | `f8e48d90` | 2026-07-17 | Recognition cutover: replace `runMatchers` + the matcher-competition registry with the adapter's synchronous `recognizeMatch()`; repoint metadata.ts / sources/resolve.ts / show.ts; `init.ts` stops registering matchers. Self-reported gates in body: tsc 0; cycle held 18; `grep runMatchers/registerMatcher/registerBuiltinMatchers → 0 code refs`. |
| 3.4 | `a0c3ee02` | 2026-07-18 | Delete `asset-registry.ts` + `asset-spec.ts`; typed accessors replace ambient globals (`stashDirFor`/`assetPathForName`/`placementTypes`/`placementSpecFor`); renderer registry → `type-presentation.ts`; `LINTER_MAP → LINTERS_BY_SUBDIR`; repoint every consumer + goldens. Cycle baseline tightened **18 → 13**. |

### Actuals (summed from the five `git show --stat` diffstats) [COMMIT]

| Commit | +ins | −del | files |
|---|---|---|---|
| `a519462e` | 33 | 3 | 3 |
| `90cc0c03` | 290 | 265 | 3 |
| `1fc02c84` | 6 | 2 | 1 |
| `f8e48d90` | 85 | 227 | 12 |
| `a0c3ee02` | 370 | 478 | 53 |
| **TOTAL** | **784** | **975** | **72 (file-touches; not distinct)** |

**Net LOC = −191.** Manifest target was `netLoc: "~−1000+"`. The landed net is
markedly smaller than target: the placement/presentation surface was *relocated*
(extracted to leaves + a frozen `type-presentation` snapshot) rather than net
deleted, and the frozen migrator copy in `src/migrate/legacy/legacy-layout.ts`
retains a full duplicate of the retired taxonomy (see Deletion inventory). This
is a scope-vs-actuals deviation on the LOC estimate only, not on the deletion set.

## Deletion inventory (retired surfaces) [COMMIT]

- **Files deleted:** `src/core/asset/asset-registry.ts` (−106 in `a0c3ee02`) and
  `src/core/asset/asset-spec.ts` (−87). Both confirmed absent at HEAD [GREP@HEAD]:
  `ls src/core/asset/asset-registry.ts src/core/asset/asset-spec.ts` → *No such
  file*.
- **Ambient globals removed / renamed:** mutable `TYPE_DIRS`, `ASSET_SPECS`,
  `getAssetTypes()`, `resolveAssetPathFromName` (replaced by typed accessors on
  the placement leaf); `LINTER_MAP → LINTERS_BY_SUBDIR`;
  `TYPE_TO_RENDERER`/`ACTION_BUILDERS` + `registerTypeRenderer`/
  `registerActionBuilder` wiring gone (moved to `presentationFor()`).
- **Matcher-competition removed:** `runMatchers` + `matchers[]` registry +
  `registerMatcher` + `registerBuiltinMatchers` (`f8e48d90`); recognition is now
  adapter-driven via `recognizeMatch()`.
- **Import-cycle SCC:** the taxonomy trio (asset-registry / asset-spec /
  output/renderers) + workflows/renderer + runtime/document-cache left the cycle
  knot; baseline tightened 18 → 13 [COMMIT `a0c3ee02` body].

## Gate results — verified at HEAD `e3eec904` on 2026-07-21 [GREP@HEAD]

Manifest chunk-3 gates that are expressible as a grep/command today. NOTE: these
run at HEAD, which is downstream of chunks 4–10; they attest the durable
end-state. Contemporaneous chunk-close gate logs are **NO RECORD**.

| Manifest gate | Command run | Result |
|---|---|---|
| `grep TYPE_DIRS → 0` | `grep -rn TYPE_DIRS src/` | 10 hits, **all in `src/migrate/legacy/`** (`legacy-layout.ts`, `three-db-cutover.ts`) — the frozen migrator home. 0 in live code. **PASS** (outside the migrator). |
| `grep resolveAssetPathFromName → 0` | `grep -rn resolveAssetPathFromName src/` | 2 hits, both in `src/migrate/legacy/legacy-layout.ts`. 0 live. **PASS** (outside migrator). |
| `grep runMatchers → 0` | `grep -rn runMatchers src/` | 10 hits, **all prose/doc-comment references** in `init.ts`, `recognize-match.ts`, `scan-component.ts`, `akm-adapter.ts` (e.g. `* Synchronous reproduction of file-context.ts#runMatchers`). **Zero live code refs.** Matches the commit's "0 code refs" claim. **PASS** (code refs 0; documentation of the reproduced arbitration remains, by design). |
| `grep getAssetTypes → 0` | `grep -rn getAssetTypes src/` | **0. PASS.** |
| `grep ASSET_SPECS → 0` | `grep -rn ASSET_SPECS src/` | 10 hits, **all in `src/migrate/legacy/legacy-layout.ts`** (`ASSET_SPECS_INTERNAL`/`ASSET_SPECS` frozen migrator copy). 0 live. **PASS** (outside migrator). |
| `grep LINTER_MAP → 0` | `grep -rn LINTER_MAP src/` | **0. PASS** (renamed `LINTERS_BY_SUBDIR`). |
| Taxonomy cycle participants leave the pre-armed ratchet baseline | `bun scripts/lint-import-cycles.ts` | `OK — 0 cycle participant(s) within baseline (0)`. At HEAD the whole cycle baseline has collapsed to 0 (later chunks killed the remaining knots). At **chunk-3 close** the baseline was tightened **18 → 13** per `a0c3ee02` body [COMMIT]. **PASS.** |
| git exact-path staging contract test green (§12.3/§12.4) | — | **NO RECORD** at chunk close. The staging path was wired in `a519462e` (git-stash pathspecs → `akmAdapter.directoryList()`); `a519462e` body self-reports "git-staging + install-detection tests 86/0", not independently re-verified here. |
| Install-time recognition still detects valid bundle roots | — | Wired in `a519462e` (`provider-utils.detectStashRoot` → `akmAdapter.looksLikeRoot()` fast-path; `git-provider.hasExtractedRepo` → `directoryList()`). Live test verdict at chunk close: **NO RECORD** beyond the commit's self-report. |

## Deviations from manifest scope

- **Scope item completed at close-out (2026-07-21, user ruling): the "9
  per-type linters + LINTER_MAP → runBaseChecks + adapter validate()"
  consolidation (plan §12, −250 LOC target) LANDED in the close-out pass** —
  the 9 linter classes + registry dispatch deleted (−454 net, exceeding the
  target), finding output verified identical, the lint golden re-designated
  to this chunk per the surface-owner rule (its pinned class names died with
  the classes). Original execution had skipped it (`a0c3ee02`: "the per-type
  linters stay — akmLint --fix is live and the frozen lint golden pins their
  dispatch").
- **Placement/presentation fold — ASSESSED AND CLOSED AS STRUCTURALLY
  INFEASIBLE (2026-07-21):** routing the indexer's placement/presentation
  reads through the adapter contract inverts proven import edges
  (`akm-adapter → metadata.ts → asset-placement`; `akm-adapter →
  recognize-match → matchers.ts → type-presentation`) → direct cycle,
  violating the EMPTY-absolute cycle gate; any runtime access path would be
  new machinery (forbidden). The current structure already realizes the
  plan's boundary cycle-free: the adapter exposes placement via
  `placeNew`/`directoryList` and presentation via the table it reads, with
  the shared pure-data leaves neutral so indexer and adapter both consume
  them acyclically. The leaves cannot be emptied (35 core/indexer consumers).
- **Net LOC −191 vs. target ~−1000+** (see Actuals) — surface relocated, not net
  deleted; frozen migrator retains the taxonomy duplicate. Scope-vs-actuals
  deviation on the estimate; deletion set itself matches scope.
- **`matchers.ts` retained** [COMMIT `f8e48d90` body]: the six matcher *functions*
  stay in `matchers.ts` and are imported directly by `recognizeMatch`; only the
  *registry/competition* was deleted. Manifest scope named "matchers.ts
  competition", consistent with this.
- **`registerAssetSpec`/`deregisterAssetSpec` kept** [COMMIT `a0c3ee02` body] for
  the custom-type path (adapter-owned pure functions).

## Deferrals / downstream state

- The `StashEntry → IndexDocument` rename, ref-grammar flip, and `db.ts` split
  were **not** in chunk-3 scope — they are chunk 5 (see chunk-5 ledger). Chunk 3
  left the `indexer-db` and `workflows-runtime` cycle knots alive **by design**
  [DOC manifest gate]: "indexer-db and workflows-runtime knots legitimately remain
  until Chunks 5/8 — plan DoD 11."
- Downstream close state is documented in the chunk-8 ledger (three-DB cutover,
  writer flip) and chunk-10 ledger.

## NO RECORD (declared gaps — not reconstructable)

1. Contemporaneous **Opus dual-review verdicts** and review notes for any WI.
2. **Mid-chunk vs. close gate-run logs** — only commit-body self-reported numbers
   survive (tsc 0, cycle 18→13, per-suite pass counts); not independently
   re-verifiable at those revisions now.
3. **Batteries-at-close** (full `bun run check` unit+integration pass/fail totals
   at chunk-3 close).
4. Any **escalation-ladder / re-scope** events during the chunk.
5. The **git-staging contract test** and **install-recognition** live verdicts at
   close (only the `a519462e` self-report exists).
