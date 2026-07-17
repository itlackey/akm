# Chunk 1 — grounding census (anchors)

Censused at HEAD `b4334024` (chunk 0b closed — WI-0b.7/0b.8, "5 gates
verified"), 2026-07-17, by direct read-only inspection (every anchor below
opened at this HEAD; none trusted from the plan/spec text alone). Authority:
manifest chunk id "1" (scope + 2 gates) and chunk id "2" (the consumer that
mints adapters against chunk 1's contract); adapter spec §§0–4 (as amended);
architecture plan §2.1, §2.3, §3.4, §11 (Chunk 1 sentence), §12.3, §15 (rules
1–2, 8); normative spec (`akm-format-neutral-bundle-workspace-spec.md`) §9.3–
9.4, §11.1/§11.4, §12.1–12.2, §14.1–14.2; chunk-0b anchors.md Section B (14-
format producer inventory) and Section E.2 (ref-spelling algebra).

**State at this HEAD, confirmed by direct probe (matches chunk-0b's finding,
still true 8 commits later):** no `src/migrate/` directory anywhere (`Glob
src/migrate/**` → 0 files); no `core/recognition-util.ts` (0 files); zero
occurrences of `interface BundleAdapter`, `ValidateContext`, `scanComponent`,
`BundleComponent`, `BundleInstallation`, or `IndexDocument` anywhere in
`src/` (grep-confirmed, 0 hits each). `docs/design/execution/chunk-1/` exists
as an empty directory (tooling-created, no prior brief/ledger). Wave 2 has
touched nothing yet — chunk 1 is genuinely first-to-land.

---

## A. The amended `BundleAdapter` interface (spec §§1–4)

**Confirmed: no `BundleAdapter` interface exists anywhere in `src/` at this
HEAD** (grep `interface BundleAdapter` across `src/` → 0 files). This matches
chunk-0b's finding and is unchanged.

### A.1 The interface to transcribe (adapter spec §2, lines 133–179 — THE
authoritative amended text)

| Method | Required? | Signature | Replaces |
|---|---|---|---|
| `id` | required (field) | `readonly string` | — |
| `version` | required (field) | `readonly string` | feeds incrementality/fingerprints |
| `extensions` | required (field) | `readonly string[]` | — |
| `recognize` | **REQUIRED** | `(c: BundleComponent, file: FileContext) => IndexDocument \| null` | `matchers.ts:151-305` global competition + `file-context.ts:242-265` specificity contest |
| `index` | optional | `(inst: BundleInstallation, c: BundleComponent) => AsyncIterable<IndexDocument>` | wiki/website special-case walks |
| `affectedItems` | optional | `(c: BundleComponent, changedPaths: string[]) => string[]` | dir-staleness whole-dir regenerate |
| `validate` | **REQUIRED** | `(c: BundleComponent, changes: FileChange[], ctx: ValidateContext) => Promise<Diagnostic[]>` | `LINTER_MAP`/`getLinterForType` + 9 per-type linter classes |
| `placeNew` | optional | `(c: BundleComponent, conceptId: string) => string` | `TYPE_DIRS[type]` + `resolveAssetPathFromName` |
| `directoryList` | optional | `(c: BundleComponent) => string[]` | `Object.values(TYPE_DIRS)` (git-stash pathspecs) |
| `looksLikeRoot` | optional | `(root: string) => boolean` | install-time probe, ordered per §1.2 |
| `getAuthoringContext`/`create` | optional (authoring facet) | — | normative §12.2 |
| `listExports`/`planBinding` | optional (export facet) | — | normative §12.3 |
| `listMemories`/`renderMemoryPlan`/`validateMemoryPlan` | optional (memory facet) | — | normative §12.4 — **Tier-B target shape, no 0.9.0 adapter implements these** |

`ValidateContext` is **not** re-stated in the adapter spec's own code block —
it is defined only in the normative spec, `akm-format-neutral-bundle-
workspace-spec.md:562-569`:

```ts
interface ValidateContext {
  readFile(path: string): Promise<string | Uint8Array | null>;
  list(dir: string): Promise<string[]>;
  resolveRef(ref: string): Promise<{ exists: boolean; path?: string }>;
}
```

### A.2 Spec-vs-spec inconsistency (flag, mirrors chunk-9's D.4 style)

Three documents show **three different completeness levels** of the same
interface:

1. **`akm-0.9.0-bundle-adapter-spec.md:133-179`** — the amended, complete
   version (recognize-required, `affectedItems` present, index-optional).
   **This is the one to implement.**
2. **`akm-format-neutral-bundle-workspace-spec.md:530-560`** (normative
   §12.1) — the SAME interface but its code block **omits `affectedItems`
   entirely** (it only appears in prose at §14.2:769, not in the §12.1 TS
   snippet), and groups `placeNew`/`directoryList`/`looksLikeRoot` under a
   separate "§12.2 Authoring methods" heading rather than inline under the
   base contract the way the adapter spec does. Not a semantic conflict —
   just an incomplete restatement a reader could copy verbatim and miss
   `affectedItems`.
3. **`akm-architecture-decision-history.md:805-823`** (§8.3) — a **stale,
   pre-amendment** shape: `index()` is REQUIRED (no `recognize` at all), no
   `ValidateContext` parameter on `validate`, no `affectedItems`. Anyone
   grepping `interface BundleAdapter` across `docs/design/*.md` and landing
   on this file first will implement the wrong contract.

### A.3 Undefined/missing supporting types — the real scope gap

The manifest's chunk-1 scope **one-liner** ("Introduce the amended
`BundleAdapter` interface... + the core-owned `scanComponent` walk") reads
narrower than what its own gate requires. The gate cites "adapter spec §§1–4
as amended" verbatim — and §1 (lines 56–75) and §3 (lines 205–241) mint a
whole type family the interface depends on, **none of which exist in `src/`
today** (grep-confirmed 0 hits for each): `BundleId`, `ComponentId`,
`ItemRef`, `BundleInstallation`, `BundleComponent`, `IndexDocument`.

- **`FileChange` already exists** — `src/core/file-change.ts:36-59` (landed
  by Chunk 6), deliberately dependency-free (file-level comment: "must never
  join an import cycle"). `BundleAdapter.validate`/`.create` can import it
  as-is; no minting needed.
- **`Diagnostic` has NO shape defined anywhere** — grepped across the
  adapter spec, the normative spec, the plan, and the decision-history doc;
  it appears only as a bare type reference in `validate(...): Promise<
  Diagnostic[]>` (both spec docs), never declared. The nearest existing
  precedent in the live codebase is `LintIssue` — `src/commands/lint/
  types.ts:19-25` (`{ file, issue: LintIssueType, detail, fixed }`) — a
  plausible template, not a mandate.
- **`IndexDocument` is explicitly Chunk 5's mint** ("Rename `StashEntry`→
  `IndexDocument`" — manifest chunk id "5", plan line 462) — yet
  `recognize`'s return type and `index?()`'s AsyncIterable element type
  **is** `IndexDocument`, and Chunk 1's own gate requires this to "compile."
  This means Chunk 1 must mint at least a provisional `IndexDocument` type
  (spec §3 shape, `akm-0.9.0-bundle-adapter-spec.md:205-241`) — file
  location unspecified in any doc — that Chunk 5 later reconciles with the
  `StashEntry` rename, rather than literally deferring the type's existence
  to Chunk 5. **This ordering is not stated anywhere and is a decision the
  brief must make explicitly** (mint a real/full IndexDocument now vs. a
  deliberately minimal placeholder Chunk 5 replaces).

### A.4 Where should the interface live?

**No document specifies a file path.** The plan's §2.1 diagram (line 55-63)
places it under "CORE (format-agnostic)" but names no module. Existing
convention: `src/core/asset/{asset-spec,asset-ref,asset-registry}.ts` house
the analogous global-registry code today; `core/recognition-util.ts` (the
util-home target, §C below) sits flat under `src/core/`, not nested in
`core/asset/`. Neither convention is dispositive — flag as an open decision
for the brief (candidates: `src/core/asset/bundle-adapter.ts`, a new
`src/core/adapter/` directory, or a flat `src/core/bundle-adapter.ts`).

---

## B. `scanComponent` — the core-owned walk

### B.1 What the spec says it is

No document gives `scanComponent` a literal TypeScript signature — only
prose/comments:

- Adapter spec, `akm-0.9.0-bundle-adapter-spec.md:141-149` (comment inside
  the `index?` JSDoc): `scanComponent(c, adapter) = core walk (git-aware,
  symlink-safe, skip-dirs, nested-root subtraction §1.2) × adapter.recognize
  per file.`
- Normative spec, `akm-format-neutral-bundle-workspace-spec.md:751-769`
  (§14.2 flow diagram): `scanComponent (core walk × adapter.recognize, or
  adapter.index override) -> DRAIN the full document stream (any scan error
  aborts before the first write) -> one write transaction: DIFF persist`.

By analogy with `index?()`'s signature, the inferred shape is
`scanComponent(inst: BundleInstallation, c: BundleComponent, adapter:
BundleAdapter): AsyncIterable<IndexDocument>` — **this is inference, not a
quoted spec signature**; the brief must design it.

Conformance requirement (adapter spec :146-149): an adapter overriding
`index()` MUST keep `recognize()` coherent — `index() == fold(recognize())`
over the walk — **or** declare item-scoped incrementality via
`affectedItems`. This specific conformance check is explicitly **Chunk 2's**
gate (manifest chunk id "2": "index() == fold(recognize) for adapters
overriding index()"; plan line 515) — Chunk 1 only needs the walk + contract
to exist and compile, not a real conformance suite (no real adapters exist
yet to conform).

### B.2 Existing walk implementations `scanComponent` parallels

| Function | file:line | Behavior | Relation to `scanComponent` |
|---|---|---|---|
| `walkStashFlat` | `src/indexer/walk/walker.ts:73-82` | Walks a WHOLE stash root (not one component); tries `walkStashGit` first, falls back to `walkStashManual` | **Closest existing parallel** for the "git-aware, symlink-safe, skip-dirs" description — but has no per-component scoping or nested-root subtraction concept at all (single-stash-root model predates multi-component bundles) |
| `walkStashGit` | `walker.ts:88-128` | `git ls-files --cached --others --exclude-standard` respecting `.gitignore`; filters `SKIP_DIRS` (`:19`, `{.git, node_modules, bin, .cache}`) and dot-dirs | The "git-aware" half |
| `walkStashManual` | `walker.ts:186-211` | Manual recursive walk; explicitly **skips symlinks** (`:197-200`, comment: "prevent potential path traversal outside stashRoot") and `SKIP_DIRS`/dot-dirs | The "symlink-safe, skip-dirs" half |
| `walkStash` (singular) | `walker.ts:32-60` | Per-`assetType` walk grouped into `DirectoryGroup[]`; filters via `isRelevantAssetFile` | **Already dead in `src/`** — plan §4.3 DELETE row confirms it's referenced only by `tests/integration/walker.test.ts`. Do not confuse with `walkStashFlat`. |
| `buildFileContext` | `src/indexer/walk/file-context.ts:65-118` | Builds one `FileContext` (eager path fields + lazy content/frontmatter/stat getters) per file | **Reused, not replaced** — `recognize(c, file: FileContext)` takes the SAME `FileContext` type (`file-context.ts:28-56`); only the matcher-competition mechanism around it is replaced |
| `runMatchers` | `file-context.ts:242-265` | Runs every registered `AssetMatcher`, ranks by specificity, ties broken by later-registration-wins | The "global competition" `recognize` replaces (plan §2.3 table row, architecture-plan.md:80) |
| `matchers.ts` matcher stack | `src/indexer/walk/matchers.ts:283-323` (`extensionMatcher`/`directoryMatcher`/`parentDirHintMatcher`/`smartMdMatcher`/`wikiMatcher`/`workflowProgramMatcher` + `registerBuiltinMatchers`) | The 6 built-in `AssetMatcher`s registered globally | Chunk 1 does **not** touch these — they die in Chunk 3 once real adapters (Chunk 2) exist to replace them |

Line-drift note (this HEAD vs. chunk-0b's capture at `3c178568`, both
post-chunk-9): `classifyBySmartMd` is now `matchers.ts:184-226` (chunk-0b
had `:181-223`, +3/+3 — WI-0b.1's task-matcher fix shifted lines slightly).
`classifyByWiki` now `:254-260` (chunk-0b: `:251`, +3). `wikiMatcher` now
`:299-301` (chunk-0b: `:296`, +3). Re-verify at implementation time per the
manifest's own §12.4 line-drift discipline.

### B.3 Nested-root subtraction — genuinely new behavior

Normative §9.3 (`akm-format-neutral-bundle-workspace-spec.md:382-388`):
component roots must not overlap except by strict nesting; a parent
component's file set is its tree **minus every other configured component
root**, computed once at mount registration. **No existing code implements
this** — the current model is single-stash-root (one `stashRoot`, walked
once). `scanComponent` is not a refactor of an existing multi-component
walker; it is new logic layered on top of the `walkStashFlat`-shaped
git/symlink/skip-dirs primitive.

---

## C. Util home — constants to relocate to `core/recognition-util.ts`

`core/recognition-util.ts` does **not** exist yet (`Glob src/core/
recognition-util.ts` → 0 files).

### C.1 Current definitions + importers

| Symbol | Definition (file:line) | Importers (file:line) |
|---|---|---|
| `SCRIPT_EXTENSIONS` | `src/core/asset/asset-spec.ts:104-121` (a `Set` of 16 extensions) | self-use `asset-spec.ts:124` (`scriptSpec`); `src/indexer/indexer.ts:7,1062`; `src/indexer/walk/matchers.ts:14,45,159` |
| `WORKFLOW_EXTENSIONS` | `asset-spec.ts:42` (`[".md",".yaml",".yml"] as const`) | self-use `asset-spec.ts:65,68,76,81` (`workflowSpec`); `src/workflows/authoring/authoring.ts:8,121`; `src/workflows/runtime/runs.ts:7,410,741`; `src/workflows/runtime/workflow-asset-loader.ts:7,89`; `src/workflows/exec/brief.ts:35,737` |
| `canonicalizeWorkflowName` | `asset-spec.ts:55-61` | `src/workflows/authoring/authoring.ts:8,204`; `runs.ts:7,410,741`; `workflow-asset-loader.ts:7,89`; `brief.ts:35,737` |

All 3 symbols are **self-contained literals/pure functions with zero
internal `src` imports today** (`WORKFLOW_EXTENSIONS` is a plain array
literal; `SCRIPT_EXTENSIONS` a plain `Set` literal; `canonicalizeWorkflowName`
only touches its own parameter + `WORKFLOW_EXTENSIONS`). This matters
directly for the cycle-risk question below.

### C.2 "Ref grammar constants" — ambiguous referent, needs a decision

The manifest/plan phrase "ref grammar constants" (chunk-1 scope line,
architecture-plan.md:154, :452) does **not** unambiguously name anything in
code:

- `parseAssetRef`/`makeAssetRef` are **functions**, and the plan explicitly
  keeps them where they are: "`asset-ref.ts` survives as a **pure parser**"
  (plan §2.2, architecture-plan.md:70; adapter spec §1.3, line 110). Not
  candidates for relocation.
- `TYPE_ALIASES` (`asset-ref.ts:25-27`) is marked for **deletion**, not
  relocation (plan §4.1 REPLACE row, architecture-plan.md:157).
- The one genuine standalone **constant** resembling `SCRIPT_EXTENSIONS`/
  `WORKFLOW_EXTENSIONS` in shape (an exported literal other modules pattern-
  match against) is `DERIVED_SUFFIX` — `src/commands/improve/memory/
  derived-ref.ts:37` (`export const DERIVED_SUFFIX = ".derived";`), consumed
  by `isDerivedMemory` (`:60-62`) and `resolveParentRef` (`:71-83`) in the
  same file, and referenced conceptually (not imported) by `mv-cli.ts`'s
  `rekeyStateDbForMove` bare/origin-qualified/`.derived` pair-construction
  logic (`mv-cli.ts:898-967`, chunk-0b anchors.md §E.2).

**Flag for the brief: decide explicitly whether "ref grammar constants"
means `DERIVED_SUFFIX` (the only real candidate), something not yet in code,
or is simply imprecise manifest wording that should be dropped from chunk
1's scope.**

### C.3 Cycle-safety of the new leaf

`scripts/lint-import-cycles.ts:189-217` — `CYCLE_PARTICIPANT_BASELINE` has
**28 entries** at this HEAD (confirmed by direct count; matches the
"ratchet is at 28" premise). The baseline is **shrink-only** — "a NEW edge
between two already-baselined files is invisible" but *new participants*
fail the gate (`checkImportCycleRatchet`, `:221-224`; final message
`:324`). Both current homes of the 3 symbols are already-baselined
participants:

- `src/core/asset/asset-spec.ts` — baseline entry (`lint-import-cycles.ts:193`)
- `src/indexer/walk/file-context.ts` — baseline entry (`:206`)

`matchers.ts`, `walker.ts`, `path-resolver.ts`, and `derived-ref.ts` are
**not** participants.

**Structural conclusion:** because `SCRIPT_EXTENSIONS`/`WORKFLOW_EXTENSIONS`/
`canonicalizeWorkflowName` (and `DERIVED_SUFFIX`, if it moves) have zero
internal `src` imports today, a new `core/recognition-util.ts` extracting
them imports nothing from `src` — it cannot structurally join a cycle
regardless of who imports FROM it (`asset-spec.ts`, `matchers.ts`,
`workflows/*`, `derived-ref.ts` would all import FROM it, never the
reverse). **The move is cycle-safe only as an invariant to actively
preserve**: `core/recognition-util.ts` must stay free of any internal `src`
import for this to hold — the moment it imports anything from a cycle
participant, it risks becoming a 29th entry, which the shrink-only ratchet
forbids outright.

---

## D. The frozen legacy resolver surface (§3.4)

`src/migrate/legacy/` does **not** exist (`Glob src/migrate/**` → 0 files).

### D.1 Scope boundary — legacy-layout.ts only, not the whole §3.4 bullet list

Plan §3.4 (architecture-plan.md:134-140) has 5 bullets under "Throwaway
migrator"; chunk 1's own scope line cites only **one**:
`migrate/legacy/legacy-layout.ts`, bullet 3. The other two artifacts named
in §3.4 are **explicitly owned by later chunks**, sharing the same
`migrate/legacy/` directory chunk 1 creates but not chunk 1's deliverable:

- **`WORKFLOW_MIGRATIONS` frozen copy** (§3.4 bullet 4, architecture-
  plan.md:139) — owned by **Chunk 8** ("delete `workflows/db.ts` +
  workflowDb locations/paths (**frozen WORKFLOW_MIGRATIONS copy retained**,
  §8.2)" — manifest chunk id "8" scope text). Do not build this in chunk 1.
- **pre-0.9 proposal legacy-import fold** (§3.4 bullet 5, `proposal/
  legacy-import.ts` — confirmed 131 LOC at this HEAD, matching the plan's
  figure exactly, no drift; `proposals-repository.ts:258-302` ledger) —
  owned by **Chunk 5** per chunk 6's own manifest notes field: "the
  legacy-import → migrator fold (the migrator home doesn't exist until
  Chunk 1)" is listed as deferred to Wave 2/Chunk 5, using the home chunk 1
  creates. Do not build this in chunk 1 either.

### D.2 The exact surface `legacy-layout.ts` must freeze-copy

Per plan §3.4 bullet 3 verbatim: "per-type `ASSET_SPECS` (stashDir /
`toAssetPath` incl. the SKILL.md directory-entry form and wiki layout /
`toCanonicalName` / `isRelevantFile`), `SCRIPT_EXTENSIONS`/
`WORKFLOW_EXTENSIONS`/`canonicalizeWorkflowName`, the ref grammar incl. bare
and `.derived` key shapes, and origin→source resolution... the migrator
enumerates the old layout by walking `TYPE_DIRS` per source and builds the
map from disk, rather than resolving each DB ref individually." Cross-
confirmed by normative §11.4 (`akm-format-neutral-bundle-workspace-
spec.md:511`): the old-ref→new-id map is computed "by walking the old
on-disk layout with a frozen copy of the old resolver — never by
reconstructing paths from `TYPE_DIRS` heuristics at migration time."

| Piece | Source (file:line, whole-file LOC) | Notes |
|---|---|---|
| `AssetSpec` interface + `ASSET_SPECS_INTERNAL` (all 14 types) + `TYPE_DIRS` + `isRelevantAssetFile`/`deriveCanonicalAssetName`/`deriveCanonicalAssetNameFromStashRoot`/`resolveAssetPathFromName` | `src/core/asset/asset-spec.ts` (359 LOC, whole file) — interface `:17-34`, `ASSET_SPECS_INTERNAL` `:129-259` (skill's `toAssetPath` dir-entry form at `:138`; wiki spec at `:197-202`), `TYPE_DIRS` `:326-328`, minting oracle `:338-353` | Skill's SKILL.md directory-entry form and wiki's `wikis` stashDir are both inline in this one map — no separate extraction needed |
| `SCRIPT_EXTENSIONS`/`WORKFLOW_EXTENSIONS`/`canonicalizeWorkflowName` | same file, `:42,55-61,104-121` | Plan is explicit this needs its **own independent copy** here, separate from the live util home (§C): "so the live util home can evolve without touching the migrator" (architecture-plan.md:138) |
| Ref grammar (bare + `.derived` key shapes) | `src/core/asset/asset-ref.ts` (140 LOC, whole file: `AssetRef` `:11-22`, `TYPE_ALIASES` `:25-27`, `makeAssetRef` `:44-50`, `parseAssetRef` `:71-117`, `validateName` `:121-136`) + `src/commands/improve/memory/derived-ref.ts:37-83` (`DERIVED_SUFFIX`, `isDerivedMemory`, `resolveParentRef`) | The concrete bare/origin-qualified/`.derived` pair algebra the frozen resolver must reproduce is demonstrated today by `rekeyStateDbForMove` (`src/commands/mv-cli.ts:898-967`, unchanged since chunk-0b's capture — good reference, though that function itself is not part of the freeze) |
| Origin→source resolution | `src/registry/origin-resolve.ts` (60 LOC, whole file: `resolveSourcesForOrigin` `:21-51`, `isRemoteOrigin` `:57-60`) + its dependency `parseRegistryRef` (`src/registry/resolve.ts`) | `src/indexer/walk/path-resolver.ts:65-86` (`resolveViaDisk`) shows the CONSUMER pattern (`TYPE_DIRS` + origin-resolve + `resolveAssetPathFromName` combined) — a good template for the migrator's walk-and-build-map logic, but `path-resolver.ts` itself is a live disk-probe slated for **deletion in Chunk 3** and should not be copied verbatim |

### D.3 A load-bearing trap: the frozen copy cannot import the live modules it's freezing

Two concrete, near-term breakages if `legacy-layout.ts` is built as shallow
re-exports rather than a true independent copy:

1. **`isAssetType`/`AkmAssetType` dependency.** `asset-ref.ts:6` imports
   `{ type AkmAssetType, isAssetType }` from `../common`. `isAssetType`
   (`src/core/common.ts:86-88`) is a **dynamic** check —
   `Object.hasOwn(TYPE_DIRS, type)` — against the LIVE, evolving
   `TYPE_DIRS`, not a frozen snapshot. `common.ts:29-88` (the whole
   `ASSET_TYPES`/`AkmAssetType`/`ASSET_TYPE_SET`/`isAssetType` block) is
   **deleted the very next chunk** (Chunk 1.5, plan line 454: "`common.ts:
   29-88` union block"). If `legacy-layout.ts`'s copy of `parseAssetRef`
   still imports `isAssetType` from `../common`, it breaks the moment
   Chunk 1.5 lands — one chunk after chunk 1 closes. The frozen copy needs
   its own inlined type-validation logic (or a private closed-union literal
   snapshotting the 14 types as they exist today), not a live import.
2. **Renderer/registry dependency.** `asset-spec.ts` itself imports
   `buildWorkflowAction` from `../../output/renderers` (`:7`) and
   `registerActionBuilder`/`registerTypeRenderer` from `./asset-registry`
   (`:8`), and `ASSET_SPECS_INTERNAL`'s workflow/env/secret/wiki/lesson/
   task/session/fact entries carry `rendererName`/`actionBuilder` fields
   that call into that registry (chunk-0b anchors.md §B.2's "8 types carry
   rendererName/actionBuilder directly" finding). Both `asset-registry.ts`
   and `output/renderers.ts`'s type-registry are **deleted in Chunk 3**
   (plan line 458). The migrator needs only the recognition/placement
   surface (`stashDir`/`isRelevantFile`/`toCanonicalName`/`toAssetPath`) to
   build an old-ref map — never rendering — so the frozen copy should
   **narrow** the `AssetSpec` shape it copies (drop `rendererName`/
   `actionBuilder`) rather than dragging in a dependency that dies two
   chunks later.

The manifest's own grep-scope note already anticipates identifier-name
staleness inside the frozen copy ("`src/migrate/legacy/` is therefore
excluded from the zero-count grep scope... do NOT rename identifiers inside
the frozen copy to appease greps" — manifest chunk-1 `notes` field) but does
**not** call out this import-dependency risk, which is a compile-time
break, not a grep-cosmetic one.

---

## E. Gate mechanics

### E.1 Gate 1 — "Amended BundleAdapter interface + scanComponent compile
and are exercised by unit tests"

Mechanically this is the manifest's general §15 rule 1 ("Per-chunk pairing.
Every chunk names its test bucket and lands it in the same chunk; the chunk
gate is not green until its bucket is" — plan line 635) applied to chunk 1's
declared bucket: "§15.1 pairing: interface + scanComponent unit tests land
here" (manifest chunk id "1" `testBucket`).

Because (per §A.3/§B.1) **no real adapter exists until Chunk 2** and
**`IndexDocument`/`BundleComponent`/`BundleInstallation` don't exist before
chunk 1 mints them**, "exercised by unit tests" for chunk 1 can only mean:

- a **type-level compile check** (the interface + `scanComponent` signature
  type-check against whatever minimal supporting types chunk 1 mints), and
- a **behavioral test of the walk** (`scanComponent`'s git-aware/symlink-
  safe/skip-dirs/nested-root-subtraction behavior) driven against a small
  **fixture/stub `BundleAdapter`** implementing only `recognize` — not the
  10 real adapters.

This is explicitly **narrower** than Chunk 2's own gate — "Adapter
conformance suite green (§12.3): `index() == fold(recognize)` for adapters
overriding `index()`" (manifest chunk id "2") — which requires REAL
adapters and is Chunk 2's job, not chunk 1's. The brief should state this
distinction explicitly so chunk 1's test author doesn't over/under-scope.

No existing precedent names a location for this test file. `tests/
architecture/` is reserved for shrink-only ratchets (`import-cycle-
ratchet.test.ts`, `run-context-adoption.test.ts`, `improve-fn-size-
ratchet.test.ts`, `src-fn-size-ratchet.test.ts`) — not a fit for a new-
feature contract test. `tests/core/` mirrors `src/core/` (has `asset-
serialize.test.ts`, `fs-txn.test.ts`, etc., but no `asset/` subdir yet) and
is the more consistent home by existing convention.

### E.2 Gate 2 — "Frozen legacy resolver copy exists at
migrate/legacy/legacy-layout.ts"

Unlike every other chunk's gates surveyed in chunk-0b/chunk-9's anchors
(zero-count greps, shrink-only ratchets, `scripts/lint-goldens-presence.ts`
sha256 pins), **no document names a mechanical verification for this gate**.
`scripts/lint-goldens-presence.ts` is scoped to `tests/fixtures/goldens/
DESIGNATIONS.json` (chunk-0b anchors.md §F.1) — unrelated to `migrate/
legacy/`. The manifest's `grepGateScope` explicitly **exempts**
`src/migrate/legacy/` from every zero-count grep ("the frozen §3.4 copy
retains dead identifiers by design"). As written, this gate is
existence-plus-eyeball only.

**Recommendation for the brief:** add an explicit shape/existence test
(e.g., asserting `legacy-layout.ts` exports an object with all 14
`ASSET_SPECS_INTERNAL` keys, the 3 relocated-constant equivalents, and the
origin-resolution functions) so the gate is mechanical rather than reviewed
by inspection — consistent with the manifest's own stated philosophy
elsewhere ("Presence and integrity are a lint, not a promise," plan line
639, re: goldens).

---

## F. Headline findings (bind the brief)

1. **The manifest's chunk-1 scope one-liner undercounts its own gate.** The
   gate cites "adapter spec §§1–4 as amended," which pulls in §1's
   `BundleId`/`ComponentId`/`ItemRef`/`BundleInstallation`/`BundleComponent`
   and §3's `IndexDocument` — none of which exist in `src/` yet — plus an
   entirely undefined `Diagnostic` type with no shape in any doc (nearest
   precedent: `LintIssue`, `src/commands/lint/types.ts:19-25`). `FileChange`
   is the one exception — it already exists (`src/core/file-change.ts:36-
   59`) and is import-ready. Chunk 1 must mint or stub this whole type
   family, not just the `BundleAdapter` method surface (§A.3).

2. **The frozen legacy copy will silently break one chunk later if built as
   shallow re-exports.** `parseAssetRef`'s `isAssetType`/`AkmAssetType`
   dependency (`asset-ref.ts:6` → `common.ts:86-88`) points at code Chunk
   1.5 deletes the very next chunk (plan line 454); `ASSET_SPECS_INTERNAL`'s
   `rendererName`/`actionBuilder` fields point at `asset-registry.ts`/
   `output/renderers.ts`, both deleted in Chunk 3. The frozen copy must be
   genuinely self-contained (inline its own type-validation logic, narrow
   the copied `AssetSpec` shape to drop renderer fields) — a textual copy
   that still imports live modules is not actually frozen (§D.3).

3. **Three documents show three different completeness levels of the same
   interface** — the amended adapter spec (§2, complete, authoritative),
   the normative spec (§12.1, missing `affectedItems` from its own code
   block), and the decision-history doc (§8.3, a stale pre-amendment shape
   with no `recognize`/`ValidateContext`/`affectedItems` at all). A reader
   who greps `interface BundleAdapter` across `docs/` can land on the wrong
   one first (§A.2).

4. **"Ref grammar constants" (the manifest's own scope phrase) has no
   unambiguous referent in code.** `parseAssetRef`/`makeAssetRef` are
   functions the plan explicitly keeps in `asset-ref.ts`; `TYPE_ALIASES` is
   marked for deletion, not relocation. The only real candidate is
   `DERIVED_SUFFIX` (`derived-ref.ts:37`). The brief must resolve this
   explicitly before Section C's move is implementable (§C.2).

5. **`scanComponent` has no literal signature anywhere — it is prose to be
   designed, not code to be lifted.** Its closest real parallel,
   `walkStashFlat` (`walker.ts:73-82`), walks a whole stash root with no
   per-component scoping; nested-root subtraction (spec §1.2/normative
   §9.3) has zero existing analog in `src/` (§B.1, B.3).

6. **Gate 2 has no described mechanical check** — unlike every other
   chunk's gates (zero-count greps, ratchets, sha256-pinned goldens), the
   "frozen legacy resolver copy exists" gate is existence-plus-eyeball only
   at present, and the manifest's own `grepGateScope` explicitly exempts
   `src/migrate/legacy/` from all greps (§E.2). Recommend adding an
   explicit shape test.

**Scope-boundary note, not a finding requiring a decision:** the
`WORKFLOW_MIGRATIONS` frozen copy (§3.4 bullet 4) and the pre-0.9 proposal
legacy-import fold (§3.4 bullet 5) both live under the same `migrate/
legacy/` directory chunk 1 creates but are owned by Chunk 8 and Chunk 5
respectively (§D.1) — confirmed from the manifest's own chunk-6/chunk-8
scope text, not left to the brief to re-derive, but worth stating plainly
so chunk 1 doesn't over-build.
