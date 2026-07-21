# Chunk 5 — execution ledger — RETROACTIVE

> **RETROACTIVE LEDGER — reconstructed 2026-07-21 from git history; NOT a
> contemporaneous record.**
>
> **Why this exists:** the 2026-07-21 0.9.0 close-out audit found chunks 3, 4, 5,
> and 6.5 landed real code but never committed the per-chunk execution ledger the
> chunk-manifest's hard gate #4 requires. `git log --grep=ledger` confirms ledger
> commits exist for chunks **0b / 1 / 1.5 / 2 / 6 / 7 / 8 / 9 / 10** (each with a
> `docs/design/execution/chunk-*/ledger.md`) but **none for 3 / 4 / 5 / 6.5**.
> This backfills chunk 5 — by commit count (54 code commits) the largest chunk of
> the entire 0.9.0 refactor.
>
> **Reconstruction note (2026-07-21):** a first pass of this ledger was itself
> materially wrong — a case-sensitive `git log --grep="chunk-5"` captured only 11
> of 54 commits and thereby (a) missed the db.ts split and the entire F4/F5 flip,
> (b) wrongly narrated F4/F5 as "deferred to chunk 8", and (c) declared false
> NO-RECORDs for gates that ARE recorded in commit bodies. This version is rebuilt
> from the **full chunk-5 commit window** (`a24f08d1` 2026-07-18 04:44 →
> `e8dbf964` 2026-07-19 23:13), established by listing every commit on HEAD's
> history in that window and classifying each. Chunk 8 opens later, at `2aeb8f27`
> (2026-07-20 01:58) — so every F4/F5 commit below (all dated 2026-07-19)
> **precedes chunk 8 and landed inside chunk 5.**
>
> **Evidence classes** (every claim traces to one):
> - **[COMMIT]** — commit hash + `git show --stat`/`--numstat` diffstat and/or a
>   verbatim quote from the commit body.
> - **[GREP@HEAD]** — grep/command run at HEAD `e3eec904`
>   (branch `claude/akm-architecture-refactor-fubvd7`) on 2026-07-21.
> - **[DOC]** — quote from a committed document (esp. the ref-grammar decision doc
>   `docs/design/akm-0.9.0-ref-grammar-decision.md`, DECIDED 2026-07-18).
> - **NO RECORD** — not answerable from the record; not reconstructed.
>
> **What could NOT be reconstructed** (marked NO RECORD inline): contemporaneous
> Opus dual-review verdicts/notes; a single chunk-close full `bun run check`
> unit+integration total (per-stage gate numbers ARE in commit bodies — see gates
> table — but no one close-out aggregate survives); escalation/re-scope events.

Chunk 5 — **"IndexDocument + ref grammar + db.ts split"** (manifest id `"5"`,
order 11, wave 2, branch-of-record `akm-090/chunk-5`; landed on
`claude/akm-architecture-refactor-fubvd7`). Plan §11 Chunk 5, §7/§7.5, §12.3,
§15.2; adapter spec §§3–4; **and the amending ref-grammar decision doc**. This is
the chunk where the `[bundle//]conceptId` grammar lands and `type:name` is retired.

**Historical context [DOC]:** the ref-grammar decision doc records that this chunk
**stalled mid-flight** — its context line reads *"Chunk 5 ~70% banked; the flip
stalled six times on the test-codemod problem."* The doc (DECIDED 2026-07-18)
dissolved the stall by re-planning the flip into stages **F0–F5** and states the
dual-input window "opens at F1 and closes at F5 **inside the same chunk**"
[DOC §4, lines 197-199], with chunk-8 scope (three-DB merge, config migration)
"untouched." The commit record confirms the flip executed and completed inside
chunk 5: F0→F5j all landed 2026-07-19, and the F5i **finale** (`99b51096`) states
*"Land the FINALE of the 0.9.0 Chunk-5 grammar deletion."*

## Landed work items — complete commit table (54 code commits)

Attributed by walking the full HEAD commit window `a24f08d1`→`e8dbf964` and
classifying each commit; diffstats via `git show --numstat`. Grouped by the
author's own stage decomposition (subjects carry the stage labels). Interleaved
non-chunk-5 commits in the same window are excluded with reasons (see below).

### Group A — db.ts split + storage repos (WI-5a / WI-5b) — manifest "split db.ts into storage repos; invert storage↔indexer arrow"

| Commit [COMMIT] | Date | +ins | −del | files | Headline |
|---|---|---|---|---|---|
| `a24f08d1` | 07-18 | 2759 | 0 | 11 | WI-5a — split `indexer/db/db` into cohesive index.db repositories. |
| `77980fc0` | 07-18 | 294 | 2885 | 98 | WI-5a — repoint index.db consumers + **invert the storage↔indexer arrow**; body: *"CYCLE_PARTICIPANT_BASELINE 13 → 10: the three trio paths leave the knot."* Single largest net-negative commit (net −2591). |
| `9e6b9855` | 07-18 | 141 | 1 | 2 | WI-5b M5 — zero-document preflight; never wipe the index on an empty/unreadable scan (#624-P1 lesson). |
| `bb95a25f` | 07-18 | 98 | 88 | 1 | Step-2 fallout — decompose `ensureSchema` (extract `ensureGraphTables`) to restore the fn-size ratchet; body: *"Chunk-5 Step-2 (3dafcbbb) added the additive item_ref/provenance DDL columns … growing it 348→372."* |

### Group B — adapter scan model (M-a / M-b)

| Commit | Date | +ins | −del | files | Headline |
|---|---|---|---|---|---|
| `8c7371c3` | 07-18 | 278 | 0 | 2 | M-a — `deriveInstallations`: `SearchSource[] → BundleInstallation[]`. |
| `170c1589` | 07-18 | 158 | 48 | 6 | Hoist `recognizeMatch` to a cycle-free leaf; add the M-b scan path. |
| `5ca3bc28` | 07-18 | 402 | 106 | 5 | M-b — full-metadata `recognize` + shadow-parity proof (body: *"PROVE it before the M-c flip"*). |

### Group C — rename + additive grammar/columns (M-d partial, Step 1, Step 2)

| Commit | Date | +ins | −del | files | Headline |
|---|---|---|---|---|---|
| `895d87d8` | 07-18 | 59 | 63 | 12 | M-d partial — rename `StashEntry` registry/config/setup family → bundle terminology (body: the member of the `grep StashEntry → 0` gate *"decoupled from the destructive M-c/M-d/M-e flip"*). |
| `e72139dd` | 07-18 | 333 | 1 | 2 | Step 1 — add `[bundle//]conceptId` grammar **alongside** `type:name` (additive; both grammars live). |
| `3dafcbbb` | 07-18 | 306 | 16 | 6 | Step 2 — additive `item_ref`/provenance `entries` columns + write-boundary derivation. |

### Group D — flip F0 / F1 / F1b / F2

| Commit | Date | +ins | −del | files | Headline |
|---|---|---|---|---|---|
| `dfac28f7` | 07-19 | 75 | 46 | 5 | **F0** — pin the D-R2 qualified conceptId spelling. Body: *"§12.3 canonical batch 57/0 … goldens 116/0, shadow-parity green"* — verified NO-OP. |
| `f9a6c766` | 07-19 | 798 | 29 | 6 | **F1** — `resolveRef`/`RefContext`/`ResolvedRef` layer + dual-keyed readers on `item_ref`. |
| `203fef7b` | 07-19 | 380 | 57 | 21 | **F1b** — accept both grammars at the CLI/API input boundaries. |
| `76dcfffc` | 07-19 | 1426 | 794 | 109 | **F2** — script-only codemod re-keys origin-less `type:name` test literals to D-R2 conceptIds. **Mutation spot-check recorded** [COMMIT]: *"corrupting 24 sampled re-keyed literals drove 11 test files red … proving the rewrites are load-bearing"* (satisfies the ≥20 gate). |

### Group E — flip proper F4a / F4b / F4c (11 commits)

| Commit | Date | +ins | −del | files | Headline |
|---|---|---|---|---|---|
| `8e23d316` | 07-19 | 58 | 0 | 2 | F4a M3 — D-R6 reserved-filename (`index.md`/`log.md`) exclusion in the akm adapter. |
| `b3e533db` | 07-19 | 145 | 0 | 2 | F4a M2 groundwork — lossless `IndexDocument→StashEntry` reconstruction. |
| `3b331bab` | 07-19 | 220 | 201 | 8 | F4a M-core-1 — **merge `StashEntry` into `IndexDocument`** (type-merge; StashEntry becomes an alias). |
| `d15fd821` | 07-19 | 454 | 56 | 7 | F4a M-core-2 — engine swap to `adapter.recognize` + **diff-persist** (upsert-by-ref, replaces truncate). |
| `3fda4a59` | 07-19 | 198 | 237 | 13 | F4a M-core-3 — **delete `generateMetadataFlat`**; flip shadow-parity to assert the persisted index. |
| `c0d3fc50` | 07-19 | 109 | 1 | 2 | F4b M1 — `displayRef` helper (output-spelling rule in one place). |
| `22e4f3d7` | 07-19 | 16 | 4 | 1 | F4b Ruling B1 — exclude `${type:…}` substitution tokens from the ref-literal ratchet. |
| `58d1f8c8` | 07-19 | 359 | 300 | 49 | F4b — flip output-ref emission to the 0.9.0 conceptId grammar (+ Ruling A re-baseline). |
| `33560ac8` | 07-19 | 348 | 69 | 4 | F4c M1 — **`REF_RE` dual-recognition** (linter + `akm mv`). |
| `013d7b99` | 07-19 | 611 | 61 | 11 | F4c M2 — **durable-state re-key of `usage_events` onto `item_ref` (§11.4)**. |
| `1f9071b8` | 07-19 | 88 | 23 | 7 | F4c M2 — feedback writer + history/`getUsageEvents` dual-arm; `displayRef` D-R5. |

### Group F — grammar finale F5 / F5b–F5j (28 commits)

| Commit | Date | +ins | −del | files | Headline |
|---|---|---|---|---|---|
| `65b89f10` | 07-19 | 17 | 9 | 1 | F5 M1 — restore bare `entry.name` for abstain-fallback recognize (double-prefix fix). |
| `8329c0c0` | 07-19 | 286 | 293 | 52 | **F5 — rename `StashEntry` alias → `IndexDocument`.** Body gate [COMMIT]: *"`grep -rn '\bStashEntry\b' src --include=*.ts \| grep -v migrate/legacy` → 0."* |
| `763eecf2` | 07-19 | 111 | 64 | 10 | F5b scope-B — move the legacy `.stash.json` reader to the migrate home. |
| `207dad67` | 07-19 | 25 | 1 | 2 | F5c Checkpoint A — mapper unlock (`concept_id`/`bundle_id`). |
| `a771de09` | 07-19 | 25 | 5 | 5 | F5d — plumb `item_ref` onto the FTS/search read path. |
| `701c6c52` | 07-19 | 43 | 5 | 1 | F5d — dual-arm the salience READ (`loadSalienceRankScores`). |
| `79f6b685` | 07-19 | 87 | 0 | 1 | F5d — the required salience dual-read test. |
| `31945bb7` | 07-19 | 19 | 0 | 2 | F5d — thread `itemRef` onto `ImproveEligibleRef`. |
| `c4367a55` | 07-19 | 54 | 19 | 3 | F5e — dual-grammar the improve dispatch (reflect/distill). |
| `5b24a014` | 07-19 | 192 | 42 | 3 | F5e — flip improve durable writers to `itemRef ?? legacy`. |
| `1611da33` | 07-19 | 17 | 2 | 2 | F5e — quality-gate dual-grammar + mv state re-key `item_ref` pairs. |
| `b318f82e` | 07-19 | 68 | 45 | 4 | F5e — decompose `persistSalienceAndReportRanks`. Body [COMMIT]: *"§12.3 nDCG=0.854 recall=0.867 mrr=0.900 (identical); relink + mv-durable …"* |
| `9fc85dfe` | 07-19 | 29 | 6 | 3 | F5e Step 6 — dual-arm the signal-delta feedback/proposal readers. |
| `d2c2b449` | 07-19 | 28 | 2 | 2 | F5f — repoint mv-recovery usage-event assertions onto the fully-qualified `item_ref`. |
| `cc47641d` | 07-19 | 73 | 13 | 4 | F5f — Step-6 writer flip (reflect/distill `itemRef`, dormant). |
| `9ebfa133` | 07-19 | 163 | 256 | 20 | F5 — codemod replay + partition (18 files freed). **F3 hand-bucket residue** [COMMIT]: files the *"codemod cannot rewrite (F3 hand bucket) → restored to legacy, kept skipped."* |
| `f22be97f` | 07-19 | 43 | 332 | 1 | F5h — port `asset-ref.test.ts` to the surviving bundle grammar (F3-planned unit-test port). |
| `99b51096` | 07-19 | 632 | 714 | 66 | **F5i — FINALE.** [COMMIT]: *"Mint `src/migrate/legacy-ref-grammar.ts` (Chunk-8 home): moves `parseAssetRef`, `makeAssetRef`, `refToString`, `AssetRef`, `TYPE_ALIASES` + `classifyRefGrammar`."* Gate: *"`grep parseAssetRef\|makeAssetRef\|refToString src (excl migrate/)` = 0."* |
| `f51c9145` | 07-19 | 19 | 22 | 3 | F5i battery — survival lookup spelling, usage-event candidate collapse, renderer golden. |
| `327eff22` | 07-19 | 17 | 17 | 4 | F5i battery — re-key CLI + journal golden fixture-ref builders to conceptId. |
| `6c5ecdd3` | 07-19 | 85 | 54 | 7 | F5j cluster 1 — mv display flip (`displayRef`) + mv-golden re-keys. |
| `36cd516b` | 07-19 | 101 | 67 | 3 | F5j cluster 2 — source-clone + source input re-keys. |
| `e0cdfaba` | 07-19 | 119 | 91 | 9 | F5j cluster 3 — show/history/feedback/events re-keys + usage-event grammar bridge. |
| `0585211e` | 07-19 | 52 | 48 | 3 | F5j cluster 4 — `remember --xref/--supersedes` dual-grammar validator. |
| `19c49e0d` | 07-19 | 41 | 14 | 5 | F5j cluster 5 — env/secret input re-keys + vault-removal signpost guard. |
| `e55a8069` | 07-19 | 76 | 66 | 8 | F5j cluster 6 — graph/workflow/tasks input re-keys. |
| `8dae9a32` | 07-19 | 19 | 6 | 3 | F5j cluster 7 — dual-grammar linter arm + show-parity/mv re-keys. |
| `ff09e78b` | 07-19 | 11 | 10 | 3 | F5j step-5 tail — ratchet floor 115→111, skip-list floor 98→97, inventory. |

### Group G — close fix

| Commit | Date | +ins | −del | files | Headline |
|---|---|---|---|---|---|
| `e8dbf964` | 07-19 | 30 | 15 | 3 | Fix proposal-golden event queries to the stored legacy ref spelling. |

### Actuals (summed over all 54 code commits, `git show --numstat`) [COMMIT]

- **Total insertions: +12,595**
- **Total deletions: −7,304**
- **Net LOC: +5,291**
- File-touches (not distinct files): 625

**Manifest target was `netLoc: "~−480"`; landed net is +5,291 — a large deviation,
and it is real, not a mis-count.** The estimate did not budget for: (1) the db.ts
split (WI-5a) relocating the monolith into verbose repo modules (+2,759 new repos
in `a24f08d1`, near-neutralised by −2,885 in `77980fc0`, but adding scaffolding);
(2) the resolver + dual-grammar + `item_ref`/provenance columns + shadow-parity
harness + the many dual-arm reader/writer arms held transiently through the F1→F5
window; (3) the test codemod's net +632 (`76dcfffc`); (4) the old-grammar deletion
**relocating** ~1,000 lines into `legacy-ref-grammar.ts` (+272 in `99b51096`)
rather than deleting them. The flip completed; the number is positive because a
single-chunk dual-grammar flip is additive-heavy by construction.

### Excluded interleaved commits (in the window, NOT chunk 5)

| Commit | Reason for exclusion |
|---|---|
| `56004179` | chunk-6.5 (`refactor(activation)`) — different chunk, has its own ledger. |
| `e9d5508e`, `670222e4` | chunk-5 **design-doc** commits (ref-grammar decision + spec amendments; +322/−3, docs only) — part of the chunk-5 story but excluded from the code-LOC actuals. Listed here for completeness. |
| `514d796e`, `cfe97954`, `cc7562e7` | repo-wide `chore(lint)`/`chore(scripts)` hygiene (promote noExplicitAny; repoint check:changed; scripts under biome) — no chunk label, not chunk-5 scope. |
| `3a5e48ed` | `docs: archive superseded design docs` — housekeeping. |

## Flip stages F0–F5 — where each landed (all inside chunk 5)

The ref-grammar decision doc §4 defines the stages [DOC]; the commit record shows
each landed in chunk 5 on 2026-07-19, **before chunk 8 opened (07-20 01:58).**

| Stage | Doc definition (§4) [DOC] | Landed? | Commits |
|---|---|---|---|
| **F0** | Pin conceptId spelling; re-run shadow-parity (must be no-op). | ✅ chunk 5 | `dfac28f7` (parity 57/0, goldens 116/0) |
| **F1 / F1b** | Resolution layer + dual-input readers on `item_ref`; accept both grammars at input edges. | ✅ chunk 5 | `f9a6c766`, `203fef7b` |
| **F2** | Script-only codemod (~4,700 literals); mutation spot-check ≥20. | ✅ chunk 5 | `76dcfffc` (24→11 red, recorded) |
| **F3** | The hand bucket (parseAssetRef unit-test port; `local//`→`{only}`; stored-key pins). | ⚠️ **partially executed, no discrete F3 commit** | Absorbed into F5h (`f22be97f`, asset-ref.test port) + F5j clusters; codemod-unhandleable origin-qualified tokens were *"restored to legacy, kept skipped (F3 hand bucket)"* per `9ebfa133`, then retired by the F5i deletion. |
| **F4** | Flip proper: `scanComponent` engine swap; `StashEntry→IndexDocument`; `item_ref` = the key; diff-persist; delete legacy stream; `REF_RE→BUNDLE_REF_RE`; §11.4 usage_events re-key. | ✅ chunk 5 | F4a `8e23d316`/`b3e533db`/`3b331bab`/`d15fd821`/`3fda4a59`; F4b `c0d3fc50`/`22e4f3d7`/`58d1f8c8`; F4c `33560ac8`/`013d7b99`/`1f9071b8` |
| **F5** | Delete the old grammar: `parseAssetRef`/`makeAssetRef`/`refToString`/`AssetRef`/`TYPE_ALIASES` moved to the frozen migrate home; `StashEntry → 0`, `parseAssetRef → 0` (excl migrate). | ✅ chunk 5 | `8329c0c0` (StashEntry gate) … `99b51096` (FINALE, parseAssetRef gate) + the F5b–F5j battery |

### Chunk 5 vs. chunk 8 — do NOT conflate

Chunk 5's F5 deletes the **`parseAssetRef` family** (old value-object grammar) and
mints `legacy-ref-grammar.ts` as its permanent home. Chunk 8's later **WI-8.5**
(2026-07-20) did a **different** job: the *writer* flip to `item_ref` for
content/frontmatter/proposal refs, and the retirement of **`parseStoredRef` /
`legacy-ref-grammar` usage outside `src/migrate/`** — different symbols, different
scope. The chunk-8 ledger's row 8.5a-d refers to those, not to chunk-5's F5.

## Gate results — verified at HEAD `e3eec904` on 2026-07-21 [GREP@HEAD]

> HEAD is post-chunk-8, but chunk 5's grammar/rename gates are stable through
> chunk 8, so HEAD attests them. Where a gate was self-reported in a commit body,
> that number is cited [COMMIT] and is the chunk-close evidence.

| Manifest gate | Command / evidence | Result |
|---|---|---|
| `grep StashEntry → 0` | `grep -rn '\bStashEntry\b' src --include=*.ts \| grep -v src/migrate` | **0. PASS.** (The chunk's own gate expression, from `8329c0c0` [COMMIT], is word-bounded and migrate-excluded; it returns 0 at HEAD. An *unbounded* `grep StashEntry` returns 44 — but those are the **unrelated** `StashEntryScope`/`ScopeKey` type family (31) + legacy-named functions/schema (`indexDocumentToStashEntry`, `validateStashEntry`, `InstalledStashEntrySchema`) + comments; there is no live `interface/type StashEntry`. The retired row type is gone.) |
| `grep parseAssetRef → 0` | `grep -rn 'parseAssetRef\|makeAssetRef\|refToString' src --include=*.ts \| grep -v src/migrate` | **0 outside `src/migrate`. PASS** — matches the `99b51096` finale gate *"(excl migrate/) = 0"*. **7 sanctioned survivors** in `src/migrate/legacy-ref-grammar.ts` — see §Sanction note. |
| `grep .stash.json / loadStashFile → 0` | `grep -rn '.stash.json\|loadStashFile' src \| grep -v src/migrate` | `loadStashFile`: 0 outside migrate (the reader was moved to the migrate home in F5b `763eecf2`). `.stash.json` literal: survives as walk **skip-guards** (`if (entry.name === ".stash.json") continue;`) — the sidecar is skipped, never read. Reader-retirement intent met. |
| §12.3 search-parity (nDCG/MRR/recall + filter + whyMatched); canary re-mint | commit bodies [COMMIT] | **RECORDED, PASS.** F0 no-op: `dfac28f7` *"§12.3 canonical batch 57/0 … goldens 116/0, shadow-parity green."* F4/F5 full run: `b318f82e` *"§12.3 nDCG=0.854 recall=0.867 mrr=0.900 (identical); relink + mv-durable …"* |
| Codemod script-only + mutation spot-check (≥20 literals → suite red) | `76dcfffc` body [COMMIT] | **RECORDED, PASS.** *"corrupting 24 sampled re-keyed literals drove 11 test files red … proving the rewrites are load-bearing."* |
| db.ts split cycle-free (db trio leaves baseline) | `77980fc0` body [COMMIT] + `bun scripts/lint-import-cycles.ts` [GREP@HEAD] | **PASS, split recorded.** `77980fc0`: *"CYCLE_PARTICIPANT_BASELINE 13 → 10: the three trio paths leave the knot."* The final **10 → 0** collapse is chunk-8's `7aee26db` (WI-8.6, 07-20) — NOT chunk 5. HEAD shows baseline 0. |

## Sanction note — the parseAssetRef survivor (REQUIRED record)

`grep parseAssetRef src/` returns **7 hits in `src/migrate/legacy-ref-grammar.ts`**
at HEAD [GREP@HEAD] — a live exported `parseAssetRef(ref: string): AssetRef` and
its call sites. This is a **deliberate, sanctioned survivor**, minted by chunk 5's
own finale:

- **Provenance [COMMIT]:** `99b51096` (F5i) explicitly *"Mint
  `src/migrate/legacy-ref-grammar.ts` … moves `parseAssetRef`, `makeAssetRef`,
  `refToString`, `AssetRef`, `TYPE_ALIASES`"* and gates on *"`grep
  parseAssetRef|makeAssetRef|refToString src (excl migrate/)` = 0."* The chunk
  **relocated** the legacy grammar into the migrate home rather than deleting it,
  because durable state.db rows still carry the legacy spelling until chunk-8's
  §11.4 one-time re-key (the file header confirms: *"Everything here retires with
  the Chunk-8 §11.4 one-time state.db re-key"* [GREP@HEAD]).
- **Sanction [DOC]:** ref-grammar decision doc §6 — *"**Frozen migrator** — never
  edited; it is where `type:name` parsing lives forever."*
- **Manifest-text mismatch:** the manifest gate reads literally `grep parseAssetRef
  → 0`, and the manifest/plan exclusion is worded `src/migrate/legacy/` (the
  *subdirectory*). `legacy-ref-grammar.ts` lives one level up in `src/migrate/`
  directly — **outside the literal `src/migrate/legacy/` exclusion path.** The
  manifest text was simply never regenerated after F5i created this home; the
  chunk's own gate (and chunk 8's) use the correct *"excl `src/migrate/`"* reading,
  which the survivor satisfies.

**Disposition:** sanctioned survivor; no action. Gate should read "outside
`src/migrate/`".

## Manifest scope items that did NOT land (dispositioned)

Four plan-named chunk-5 scope items have **no implementation at HEAD**:

| Scope item (manifest) | Evidence | Disposition |
|---|---|---|
| **`jsonColumn()` helper** ("Split db.ts into storage repos + `jsonColumn()` helper") | `grep -rn jsonColumn src/` → **0** [GREP@HEAD]. `git log -S jsonColumn` → 6 commits, all **design-doc** mentions (plan/spec/review) + one unrelated chunk-7 `derived-ref` commit (`dbc9a097`); none implement a `jsonColumn()` helper. | **NEVER LANDED.** The db split (`a24f08d1`) shipped without the named helper. |
| **`item_links` table + consumers** | `grep -rn item_links src/` → **0** [GREP@HEAD]. `git log -S item_links` → 4 commits, all **spec/comment references** (chunk-2 okf adapter comment, chunk-7, 2 docs); no table DDL. | **NEVER LANDED.** |
| **L0/L1/L2 derived index artifacts (cards/outlines, normative §15.2)** | `grep -rniE 'progressive.disclosure\|deriveCards\|deriveOutline' src/` → **0** [GREP@HEAD]. | **NEVER LANDED.** |
| **Unify scored/enumerate filter path** | `tests/fixtures/goldens/filter-behavior/scored-vs-enumerate.json` still present [GREP@HEAD] — the two chains remain pinned separate by the golden; no implementing commit found. | **NEVER LANDED** (paths still distinct). |

These are genuine scope gaps against plan §11 Chunk 5 / normative §15.2 — the chunk
delivered the grammar flip, the rename, and the db split, but not these four
derived/consolidation items.

## The M-c gap

The chunk's early commits reference a planned **"destructive M-c/M-d/M-e flip"**
[COMMIT `895d87d8`: *"decoupled from the destructive M-c/M-d/M-e flip (schema …)"*;
`5ca3bc28`: *"PROVE it before the M-c flip"*]. No commit is labelled **M-c** or
**M-e**: after the codemod stall, the ref-grammar decision doc **renumbered** the
destructive flip into the **F0–F5** stage sequence [DOC §4]. Only the one M-labelled
member decoupled from that destructive flip — the `StashEntry` registry/config
rename (`895d87d8`, "M-d partial") — landed under an M-label; everything else the
M-c/M-d/M-e plan would have covered landed as F4/F5.

## Deferrals / downstream state (tracked)

- **`.stash.json` content-migration + delete** → the *reader* moved to the migrate
  home in F5b (`763eecf2`); the WI-8.5d content migration (fold + delete) is chunk 8
  [DOC chunk-8 ledger].
- **The legacy grammar (`legacy-ref-grammar.ts`)** retires only when chunk-8's
  §11.4 re-key finishes converting every durable row — permanent migrate home per
  doc §6 [DOC].
- **The four never-landed scope items** (above) are open against §11 Chunk 5 /
  §15.2 — candidates for a follow-up.

## NO RECORD (genuine remaining gaps)

1. Contemporaneous **Opus dual-review verdicts** / review notes for any of the 54
   commits.
2. A single **chunk-close full `bun run check`** unit+integration aggregate.
   Per-stage numbers ARE in commit bodies (§12.3 302/0 in `b318f82e`; canonical
   57/0 + goldens 116/0 in `dfac28f7`; the F2 spot-check) but no one close-out
   total was captured (no ledger existed to record it).
3. **Escalation / re-scope events** beyond the documented six-time codemod stall
   (recorded in the decision doc, not per-commit).
