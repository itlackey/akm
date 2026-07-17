# Chunk 1.5 — grounding census (anchors)

Censused at HEAD `90bd5a03` (chunk 1 closed — WI-1.1..1.4, "frozen self-contained
legacy resolver" landed), 2026-07-17, by direct read-only inspection (every
anchor below opened at this HEAD; the import-cycle findings in §E are from
running `scripts/lint-import-cycles.ts`'s own exported graph-builder against
the live tree, not from prose). Authority: manifest chunk id "1.5" (scope + 2
gates + testBucket) and chunk id "1" (predecessor — froze the union in
`legacy-layout.ts`) and "3"/"5" (consumers, out of this chunk's scope); plan
§2.3 (lines 74-101, the typed-tables/open-token model), §11 Chunk 1.5 (line
454), §15 rule 4 (line 638, the taxonomy-pin/replacement pairing rule); chunk-1
anchors.md §D.3 (the trap this chunk realizes — already defused, see §E below).

**State at this HEAD, confirmed by direct probe:** `src/core/common.ts:29-88`
(the `ASSET_TYPES`/`AkmAssetType`/`ASSET_TYPE_SET`/`isAssetType` block) is
intact and unchanged since chunk-0b's capture. `src/migrate/legacy/
legacy-layout.ts` exists (946 LOC, landed by chunk 1's WI-1.4) and is
genuinely self-contained — confirmed by direct read of its own inlined
`LEGACY_TYPE_KEYS`/`isAssetType` snapshot and its import list (`node:fs`,
`node:os`, `node:path`, `node:url` only). The import-cycle ratchet
(`CYCLE_PARTICIPANT_BASELINE`) is at 28 entries, matching chunk-1's own
capture. Working tree is clean at this HEAD.

---

## A. The closed-union sites to sever — full consumer census

### A.1 Manifest-named anchors, re-verified at HEAD

| Symbol | Manifest anchor | Actual @ HEAD | Drift | What it is |
|---|---|---|---|---|
| `ASSET_TYPES`/`AkmAssetType`/`ASSET_TYPE_SET`/`isAssetType` block | `common.ts:29-88` | `src/core/common.ts:29-88` | **0** | The whole closed-union definition: `ASSET_TYPES` (frozen 14-tuple, derived from `getAssetTypes()`), `AkmAssetType` (literal union type), `ASSET_TYPE_SET` (a `Set`), `isAssetType` (`Object.hasOwn(TYPE_DIRS, type)` type-guard). Orphaned docblock at `:14-28` (the "SINGLE SOURCE OF TRUTH" comment, references a test file `tests/asset-type-union-source.test.ts` that **does not exist** — stale, low-stakes) is not separately named by the manifest but is logically part of the same deletion unit. |
| `salience.ts:52/650` | `52/650` | `src/commands/improve/salience.ts:52` (type-only import), `:650` (`makeAssetRef(indexed.entry.type as AkmAssetType, indexed.entry.name)`) | **0** | Pure type-cast: `indexed.entry.type` is already `string` (see A.2 note); the cast exists only to satisfy `makeAssetRef`'s current `type: AkmAssetType` parameter. |
| `eligibility.ts:9/39/169/477` | `9/39/169/477` | `src/commands/improve/eligibility.ts:9` (import), `:39` (`if (!isAssetType(trimmed))`), `:169`, `:478` | **0 / 0 / 0 / +1** | `:9`/`:39` are `resolveImproveScope`'s `--scope <type>` validation (a real behavioral gate, see §E). `:169`/`:478` are the same `entry.type as AkmAssetType` cast pattern as salience.ts. |
| `mv-cli.ts:51,145,154,743` | `51,145,154,743` | `src/commands/mv-cli.ts:51` (import), `:160`, `:169`, `:713` | **0 / +15 / +15 / −30** | Chunk 6 (`WI-6.3d`, fs-txn port) and Chunk 7 (`WI-7.4`, derived-ref consolidation) touched this file after the plan's figures were written; the manifest's own anchors here were never re-measured post-Wave-1 the way chunk-0b re-measured others. `:160`/`:169` are `interface RewriteContext { type: AkmAssetType; ... }` and `buildRewriteContext`'s `opts.type: AkmAssetType` field; `:713` is `resolveMoveSourcePath`'s `refType: AkmAssetType` parameter. All three are structural type annotations, not runtime checks — `mv` never calls `isAssetType` itself. |
| `asset-ref.ts:109` | `109` | `src/core/asset/asset-ref.ts:109` | **0** | `if (!isAssetType(resolvedType)) throw new UsageError(...)` inside `parseAssetRef` — the actual closed-union *rejection* site. But `AkmAssetType` also appears at `:6` (import), `:12` (`AssetRef.type` field), `:25` (`TYPE_ALIASES: Record<string, AkmAssetType>`), `:44` (`makeAssetRef`'s `type` param) — the manifest names only the rejection line; the type itself is used 4 more times in the same file and all 4 need to change too (see A.3). |

### A.2 The `StashEntry.type` field is already `string`, not `AkmAssetType`

`src/indexer/passes/metadata.ts:62` — `export interface StashEntry { ...
type: string; ... }`. The data model was never closed; only the *validation
gate* (`isAssetType`) and the *ref-construction* helper (`makeAssetRef`'s
parameter type) are closed today. This is why every `salience.ts`/
`eligibility.ts`/`collapse-detector.ts`/`ranking.ts`/`db-search.ts`/
`indexer/manifest.ts` call site below is a pure `as AkmAssetType` cast on an
already-`string` value, not a real narrowing — confirms the chunk's own title
("type-only severs").

### A.3 Complete consumer table (whole-tree grep: `AkmAssetType`, `isAssetType`, `ASSET_TYPES`, `ASSET_TYPE_SET`)

Declared grep-gate scope per manifest: `src/ + scripts/ + src/assets/`,
excluding `src/migrate/legacy/`. Direct grep of `scripts/` and `src/assets/`
→ **0 hits in both** (confirmed). All in-scope hits are under `src/`:

| File | Line(s) | Usage | Named in manifest/plan for 1.5? | Becomes under open token |
|---|---|---|---|---|
| `src/core/common.ts` | 29-88 | Definition site | **Yes** | Deleted entirely (block + orphaned docblock `:14-28`) |
| `src/core/asset/asset-ref.ts` | 6, 12, 25, 44, 109 | Import; `AssetRef.type` field; `TYPE_ALIASES` value type; `makeAssetRef` param; `isAssetType` rejection | **Yes** (only `:109` cited) | Import dropped; `type` fields become `string`; `isAssetType` call at `:109` removed (see §E for the "tool"/"vault" trap this uncovers) |
| `src/commands/improve/salience.ts` | 52, 650 | Type-only import; `as AkmAssetType` cast | **Yes** | Import dropped; cast removed (no-op once `makeAssetRef(type: string, ...)`) |
| `src/commands/improve/eligibility.ts` | 9, 39, 169, 478 | Import; `isAssetType` scope-validation gate; 2× `as AkmAssetType` cast | **Yes** | Import dropped; `:39` gate relaxed (behavioral — see §E); casts removed |
| `src/commands/mv-cli.ts` | 51, 160, 169, 713 | Import; 2× interface/param field type; 1× param type | **Yes** (stale line numbers) | Import dropped; 3 annotations become `string` |
| `src/commands/improve/collapse-detector.ts` | 31, 123, 252 | Type-only import; 2× `as AkmAssetType` cast (`makeAssetRef` call sites) | **No — not named anywhere in plan or manifest for chunk 1.5** | Import dropped; casts removed |
| `src/indexer/search/ranking.ts` | 7, 96 | Type-only import; `as AkmAssetType` cast (canary anchor-ref scoring) | **No** | Import dropped; cast removed |
| `src/indexer/search/db-search.ts` | 23, 95, 97 | Type-only import; 2× `as AkmAssetType` cast (`resolveSearchHitRef`) | **No** | Import dropped; casts removed |
| `src/indexer/passes/metadata.ts` | 14, 296, 1423 | Import; `validateStashEntry`'s gate; `generateMetadataFlat`'s gate | **Partial** — `validateStashEntry` is named in prose elsewhere in the plan (line 335, `metadata.ts:292,296`), but **`:1423` is unnamed anywhere** | See §B; `:1423` is a second, distinct correctness-relevant gate the plan text never mentions (see §E) |
| `src/indexer/manifest.ts` | 18, 53 | Type-only import; `as AkmAssetType` cast (`toManifestEntry`) | **No** | Import dropped; cast removed |

**5 of these 10 files are silent gap consumers** (collapse-detector.ts,
ranking.ts, db-search.ts, indexer/manifest.ts entirely unnamed;
metadata.ts's `:1423` site unnamed) — none appear in the manifest's chunk-1.5
scope line or anywhere in the plan's chunk-1.5 paragraph. Gate 1 ("grep
`AkmAssetType` → 0 [declared scope]") cannot pass without converting all of
them; the brief must treat this table, not the manifest's 5-file list, as the
real scope.

### A.4 `src/migrate/legacy/legacy-layout.ts` — confirmed exempt and confirmed safe

Contains its own `isAssetType`/`LEGACY_TYPE_KEYS`/`LegacyAssetType`
reimplementation (`:134-158`) plus 5 more comment references to
`isAssetType`/`AkmAssetType` (all in its own header doc, explaining *why* it
doesn't import the live symbols). Confirmed by direct read: the file's only
imports are `node:fs`, `node:os`, `node:path`, `node:url` (`:105-108`) — zero
`src/` imports. Deleting `common.ts:29-88` cannot break this file. This was
chunk 1's own anticipated risk (its header comment cites this exact chunk by
name, "deleted in Chunk 1.5, one chunk after this one closes") — already
defused, nothing left for this chunk to do here.

### A.5 Test consumers — outside the mechanical grep-gate scope, but NOT deferrable

The manifest's `grepGateScope` note says tests are swept to zero later "by
the §15.2 ratchet on the same identifiers" (§15.2 = Chunk 5's ref-literal
codemod, which targets `StashEntry`/`parseAssetRef`/`TYPE_DIRS`/type-prefix
*string literals*). That covers churn like `"skill:foo"` continuing to
compile fine under a new ref grammar. It does **not** cover these two files,
which **import the doomed symbols directly** — deleting `common.ts`'s
`AkmAssetType`/`ASSET_TYPES`/`isAssetType` exports is a hard TypeScript
compile error for them, independent of any grep-gate scope declaration or
ratchet deferral:

| File | Import (compile-breaking) | Taxonomy-pin tests in the same file |
|---|---|---|
| `tests/asset-ref.test.ts:3` | `import { type AkmAssetType, ASSET_TYPES } from "../src/core/common"` | `:188-190` "throws for invalid type" (`widget:foo`); `:192-194` "throws for removed tool type" (`tool:deploy.sh`); `:235-261` whole `describe("AkmAssetType literal union")` block (4 tests, incl. `:254`/`:257-260` unknown-type-throws) |
| `tests/integration/common.test.ts:5-14` | `isAssetType` imported alongside 6 unrelated live `common.ts` exports (`hasErrnoCode`, `isWithin`, `jsonWithByteCap`, `resolveStashDir`, `toPosix`, `ResponseTooLargeError`) — **surgical edit, not file deletion** | `:163-177` `describe("isAssetType")` (5 assertions pinning the exact closed 14-type set) |

Two more test files pin the **behavior** (not the import) and will start
failing at runtime, not compile time, once the underlying gates relax:

| File | Test | Pins |
|---|---|---|
| `tests/integration/metadata.test.ts:132-134` | `"validateStashEntry rejects entries without valid type"` — `validateStashEntry({ name: "x", type: "invalid" })` expects `null` | §B's gate directly |
| `tests/integration/source.test.ts:271-275` | `"akmShow rejects invalid asset type in ref"` — `akmShow({ ref: "widget:foo" })` expects a rejection matching `/Invalid asset type/` | `parseAssetRef`'s gate, transitively through the CLI |

No test anywhere pins `eligibility.ts`'s `resolveImproveScope` "Unknown
asset type" rejection (grep for the message and for `resolveImproveScope` in
`tests/` → 0 hits) — a real behavior surface with zero test coverage today.

---

## B. `validateStashEntry` — relax to open-token

Definition: `src/indexer/passes/metadata.ts:292-301`. Signature:
`export function validateStashEntry(entry: unknown): StashEntry | null`.
Validates and normalizes a raw (e.g. `.stash.json`-sourced) object into a
`StashEntry`; called from `loadStashFile` at `:261`.

The closed-union rejection is one line: `:296` —
`if (typeof e.type !== "string" || !isAssetType(e.type)) return null;`. The
ordering-dependency doc-comment above it (`:287-291`, "Uses `isAssetType()`
to check `entry.type`, which only recognizes custom types registered via
`registerAssetType()`...") is explicitly named for deletion by the plan
(line 335: "its ordering-dependency doc-comment (`:287-291`) is deleted").
"Relax to open-token" concretely means: drop the `isAssetType(e.type)` half
of the condition, keeping only `typeof e.type === "string" && e.type` (or
equivalent non-empty-string check) — any non-empty string type is accepted
as valid `StashEntry` data.

**A second, plan-unmentioned gate exists in the same file**:
`generateMetadataFlat` (metadata.ts:1409-1423) — the flat-walk indexing path
— has its own `isAssetType` check at `:1423`: `if (!isAssetType(assetType))
continue;`. Unlike `validateStashEntry` (which returns `null` for a caller to
handle), this one **silently skips the file entirely** during flat indexing.
Neither the plan text nor the manifest names this site; it must be relaxed
in the same spirit (accept the matcher-returned type) or the open-token goal
is only half-realized on the flat-walk path.

**Consumer/test note**: `loadStashFile` (`:261`'s caller) has no direct test
pinning rejection; the one test that does is
`tests/integration/metadata.test.ts:132-134` (§A.5 above) — this is chunk
1.5's most direct §15.4 replacement-test target for this section.

---

## C. §2.3 typed tables + `KNOWN_TYPES`

### C.1 No compile-time exhaustiveness exists anywhere today

Both existing type-keyed tables are `Record<string, X>` (loosely typed),
**not** `Record<AkmAssetType, X>` — i.e., today's closed union was never
actually used to enforce table completeness, only to gate ref
construction/validation:

- **`TYPE_TO_RENDERER`** (`src/core/asset/asset-registry.ts:21-35`) and
  **`ACTION_BUILDERS`** (`:39-58`) — both `Record<string, ...>`, and both
  are **already complete** (14/14 types present) at this HEAD. Dynamically
  mutable at runtime via `registerTypeRenderer`/`registerActionBuilder`
  (`:66-78`), called from `asset-spec.ts:257,260` when a spec carries
  `rendererName`/`actionBuilder`. Consumed widely: `db-search.ts` (5 sites),
  `search-hit-enrichers.ts`, `matchers.ts:269`, `action-contributors.ts`, via
  the `RendererRegistry` interface (`asset-registry.ts:88-100`,
  `rendererNameFor`/`actionBuilderFor` — both return `| undefined` on miss,
  **no generic-fallback object today**).
- **`asset-registry.ts` itself is deleted whole in Chunk 3** ("Delete
  asset-registry.ts, asset-spec registry/renderer/action..." — manifest
  chunk id "3"). Retyping its tables now is at most a 2-chunk-lived
  hardening before the module is replaced by per-adapter `TYPE_PRESENTATION`
  tables (Chunk 2) — a real sequencing tension for the brief: harden this
  module's typing now (throwaway in 2 chunks) vs. mint `KNOWN_TYPES`/
  `presentationFor` as a durable standalone artifact elsewhere that Chunk
  2/3 later wire adapters onto.

- **`TYPE_BOOST`** (`src/indexer/search/ranking-contributors.ts:11-22`) —
  `Record<string, number>`, the ranking-side table. **Only 8 of 14 known
  types have entries** (`skill`, `command`, `workflow`, `agent`, `script`,
  `knowledge`, `fact`, `memory`) — `env`, `secret`, `wiki`, `lesson`, `task`,
  `session` are absent and silently fall through to the existing `?? 0`
  fallback at the sole consumer, `typeRankingContributor.adjust`
  (`:198-204`, `return TYPE_BOOST[item.entry.type] ?? 0;`). This is the
  clearest, core-owned (survives past Chunk 3), currently-incomplete
  candidate for a `Record<KnownType, number>` conversion — retyping it
  **immediately forces a decision** on whether the 6 missing types were a
  deliberate "no boost" choice or an oversight, since the compiler would
  demand an explicit entry for each.

### C.2 No `presentationFor`-shaped function exists

The plan's §2.3 code example (`presentationFor(type: string | undefined):
Presentation`) has no real precedent in the codebase — the closest analogs,
`RendererRegistry.rendererNameFor`/`.actionBuilderFor`, return `undefined`
on a miss rather than a merged, guaranteed-non-null `Presentation` object.
Building a real `presentationFor` that unifies renderer name + action
builder into one typed lookup with a generic (non-`undefined`) fallback is
net-new work, not a retyping of something that exists.

### C.3 No file location specified for `KNOWN_TYPES`/`KnownType`

Neither the plan nor the manifest names a module. Candidates by existing
convention: `src/core/common.ts` itself (natural successor to the deleted
block, though the file's docblock explicitly frames it as general-purpose
utilities, not a taxonomy home); a new `src/core/asset/known-types.ts`
sitting beside `asset-spec.ts`/`asset-registry.ts`; or co-located with
whichever table (`ranking-contributors.ts`, a future presentation module) is
retyped first. Flag as an open decision for the brief.

### C.4 `KNOWN_TYPES` contents and semantics

The 14 values are exactly today's `ASSET_TYPES` (`common.ts:29-44`): `skill,
command, agent, knowledge, workflow, script, memory, env, secret, wiki,
lesson, task, session, fact`. Unlike the deleted union, `KNOWN_TYPES` is
explicitly **not a validation gate** — per plan line 101, unknown/foreign
`type` strings must still flow through as valid `IndexDocument`/`StashEntry`
data; `KNOWN_TYPES` only anchors compile-time completeness for AKM's *own*
tables (`Record<KnownType, X>` fails to compile if a key is missing) and,
later (Chunk 10, §7.3 shipped-assets lint — **does not exist yet**, grep-
confirmed 0 hits for any "shipped-assets" script), cross-checks spelling
against shipped assets/docs. `wiki` will be removed from this tuple by
Chunk 4 ("The wiki ASSET-TYPE dies") — expected future churn, not a chunk
1.5 concern.

---

## D. §15.4 taxonomy-pin deletions + §12.3 replacement tests

### D.1 Exact taxonomy-pin tests to delete/replace (same commit as the source change)

| # | File:lines | Test | Pins |
|---|---|---|---|
| 1 | `tests/asset-ref.test.ts:188-190` | `"throws for invalid type"` (`widget:foo`) | `parseAssetRef`'s closed-union rejection |
| 2 | `tests/asset-ref.test.ts:192-194` | `"throws for removed tool type"` (`tool:deploy.sh`) | Same, for the specific retired `tool` type (see the trap in §E) |
| 3 | `tests/asset-ref.test.ts:235-261` | `describe("AkmAssetType literal union")` (4 tests: typed-ref narrowing, all-types loop, `:254` unknown-type-throws, `:257-260` dynamic-unknown-throws) | Both the closed union's TS narrowing and its runtime rejection; also the file's only `AkmAssetType`/`ASSET_TYPES` import (compile-breaking, §A.5) |
| 4 | `tests/integration/common.test.ts:163-177` | `describe("isAssetType")` (5 assertions: 5 known types → `true`, 4 unknown strings incl. `""` → `false`) | The exact closed 14-type membership check |
| 5 | `tests/integration/metadata.test.ts:132-134` | `"validateStashEntry rejects entries without valid type"` | §B's gate |
| 6 | `tests/integration/source.test.ts:271-275` | `"akmShow rejects invalid asset type in ref"` (`widget:foo`) | `parseAssetRef`'s gate, transitively via the CLI |

### D.2 Replacement contract test candidates (what must prove the new model)

- **Open-token acceptance**: `parseAssetRef`/`makeAssetRef` round-trip an
  arbitrary, non-built-in type string (e.g. `"custom-adapter-type:foo"`)
  without throwing — direct successor to tests 1-3.
- **`validateStashEntry` open-token acceptance**: an entry with an
  unrecognized `type` string is no longer rejected (`!== null`) — direct
  successor to test 5. Should also cover `generateMetadataFlat`'s `:1423`
  gate (§B) since no existing test exercises it at all today.
- **`isAssetType`-shaped replacement, if any survives**: test 4's exact
  closed-membership assertions have no successor unless the brief decides
  something should still say "is this one of AKM's *known* types" (e.g. a
  `KNOWN_TYPES.includes(type)` predicate) as distinct from "is this a valid
  ref token" (now: any non-empty string). If such a predicate is minted, it
  needs its own test; if not, this is a straight deletion.
- **`KNOWN_TYPES` exhaustiveness**: best enforced by the type system itself
  (a `Record<KnownType, X>` literal missing a key is a compile error, not a
  runtime assertion) — the "replacement contract test" here may need to be
  a type-level check (e.g. a `satisfies`/assignment test asserted via
  `tsc`/a `.test-d.ts`-style file) rather than a `bun:test` runtime case, or
  a runtime test that iterates `KNOWN_TYPES` and asserts each key exists in
  the retyped table (weaker, but catches accidental `delete`).
- **`presentationFor` fallback**: call it with a foreign type string and
  assert it returns the generic/default `Presentation`, never `undefined`
  and never a throw — proves the "open string for the data space" half of
  §2.3.

### D.3 The "tool"/"vault" trap — a decision the replacement tests must resolve

Test 2 (`tool:deploy.sh`) and `asset-ref.ts`'s dedicated `vault` handling
(`:95-103`, not itself named in chunk 1.5's scope — a `UsageError` with a
migration-hint message, thrown *before* the `isAssetType` check) both exist
because **specific types were deliberately removed** from AKM, and these
sites guard against silently reintroducing them. A naive "accept any
non-empty string" open-token change makes `tool:x` succeed as an ordinary
foreign type — technically consistent with "open token," but defeats the
guard's original intent, and does so silently (no compile error, no test
failure once test 2 is deleted). The brief must decide explicitly: keep a
small denylist for `tool`/`vault` (contradicts "any non-empty string"), or
let them become ordinary unknown types (accept the regression in guidance
quality). Whichever is chosen needs its own replacement test — this is not
resolvable by grounding alone.

---

## E. Ratchet / cycle / trap impact

### E.1 Import-cycle ratchet — empirically verified, not just reasoned about

Ran `scripts/lint-import-cycles.ts`'s own exported `buildImportGraph`/
`measureCycleParticipants` against the live tree (read-only; no `src`
changes). Current cycle (SCC) containing `common.ts` has `common.ts`'s
**only** internal-`src` edge into it via `import { getAssetTypes, TYPE_DIRS
} from "./asset/asset-spec"` (`common.ts:8`) — used *exclusively* to build
`ASSET_TYPES` (`:29`) and `isAssetType` (`:87`), both deleted this chunk.
`common.ts`'s other two internal imports (`./errors`, `./paths`) do not
re-enter this SCC directly — except `paths.ts` imports `IS_WINDOWS` back
from `common.ts`, forming a small independent `common.ts <-> paths.ts`
2-cycle.

Simulating chunk 1.5's edge removals (`common.ts` drops its `asset-spec.ts`
import; `asset-ref.ts` drops its now-fully-dead `common.ts` import) against
the real graph: the cycle-participant baseline **shrinks from 28 to 18**.
10 files leave the knot as a pure side effect: `src/commands/env/env.ts`,
`src/core/asset/asset-ref.ts`, `src/core/config/config-io.ts`,
`src/core/file-lock.ts`, `src/core/migration-operation.ts`,
`src/indexer/walk/file-context.ts`, `src/sources/types.ts`,
`src/workflows/parser.ts`, `src/workflows/program/project.ts`,
`src/workflows/validator.ts`. `common.ts` **itself does not leave** — it
stays a participant via the separate `common.ts <-> paths.ts` round trip.
The ratchet is shrink-tolerant (`lint-import-cycles.ts:16-19`, "files
leaving the knot pass silently — no baseline edit required"), so this
requires **no action** for the gate to pass — but it's a substantial,
unanticipated win (10/28 of the current knot) the manifest doesn't mention
anywhere; the brief could optionally bank it by trimming
`CYCLE_PARTICIPANT_BASELINE` (`lint-import-cycles.ts:189-218`) in the same
commit, or leave it for whichever later chunk next touches the ratchet.

### E.2 Frozen `legacy-layout.ts` — confirmed unaffected

See §A.4 — genuinely self-contained, zero risk, already defused by chunk 1.

### E.3 Consumers relying on the closed union for correctness, not just typing

- **`metadata.ts:1423`** (`generateMetadataFlat`) — silently *skips indexing
  the file entirely* for any matcher-returned type outside the closed 14.
  This is real behavior, not a type annotation; opening it means
  foreign-typed files start being indexed on the flat-walk path instead of
  silently dropped (the intended outcome, but currently untested — §A.5).
- **`eligibility.ts:39`** (`resolveImproveScope`) — `akm improve --scope
  <type>` throws `"Unknown asset type"` for anything outside the closed set;
  the error message's own "Valid types" list (`:41`) is *already* stale
  today — it names only 12 of the 14 built-in types (missing `session` and
  `fact`), a pre-existing drift unrelated to this chunk but touched by it.
  No test pins this rejection at all.
- **`asset-ref.ts`'s `tool`/`vault` handling** — see §D.3, the sharpest
  trap in this census: a typing-looking change that is actually a product
  decision about whether removed types can be silently resurrected as
  "foreign" ones.
- **Other `TYPE_DIRS`/`ASSET_SPECS`-gated closed checks survive this chunk
  untouched**: `src/commands/proposal/repository.ts:416` ("Unknown asset
  type... Known types: ..." keyed on `TYPE_DIRS`), `src/core/write-source.ts:456`
  ("Unknown asset type... Cannot resolve a write path"), `src/core/asset/
  asset-spec.ts:311` (`getSpec` throws `Unknown asset type` via
  `ASSET_SPECS`). None reference `AkmAssetType`/`isAssetType` — they're
  gated on `TYPE_DIRS`/`ASSET_SPECS` directly, structures Chunk 3 deletes,
  not this chunk. **The system is only partially open after chunk 1.5
  lands**: a foreign type can round-trip through `parseAssetRef`/
  `validateStashEntry`, but will still hit a closed-set error/silent-fail at
  these other gates until Chunk 3. The brief should state this boundary
  explicitly so "open token" isn't oversold as fully realized here.

---

## F. Headline findings

1. **The manifest's own anchor list under-covers its gate.** Grep of the
   whole tree finds 10 in-scope `src/` files touching
   `AkmAssetType`/`isAssetType`; the chunk-1.5 scope line names only 6
   (common.ts, asset-ref.ts, salience.ts, eligibility.ts, mv-cli.ts, +
   validateStashEntry in prose). **4 files are entirely unnamed anywhere in
   the plan or manifest** — `collapse-detector.ts`, `ranking.ts`,
   `db-search.ts`, `indexer/manifest.ts` — plus a second, unnamed gate
   inside `metadata.ts` itself (`:1423`, `generateMetadataFlat`, distinct
   from the named `validateStashEntry` gate at `:296`). All must convert
   for gate 1 ("grep `AkmAssetType` → 0") to pass (§A.3).

2. **Two test files hard-compile-break the instant the source deletion
   lands, independent of the grep-gate's tests exemption.** The manifest's
   note that "tests are driven to zero by the §15.2 ratchet" covers
   ref-*string-literal* churn (Chunk 5's job); it does not cover
   `tests/asset-ref.test.ts` and `tests/integration/common.test.ts`, which
   `import { AkmAssetType, ASSET_TYPES }` / `{ isAssetType }` directly from
   `common.ts` — these must be fixed in this chunk's own commit regardless
   of scope declarations (§A.5).

3. **No compile-time exhaustiveness exists anywhere today, and the two real
   candidate tables point in different directions.** `TYPE_BOOST`
   (`ranking-contributors.ts:11`) is core-owned (survives past Chunk 3) but
   only covers 8/14 types today, defaulting missing ones to `0` boost —
   retyping it to `Record<KnownType, number>` forces an explicit decision
   on the 6 gaps. `TYPE_TO_RENDERER`/`ACTION_BUILDERS`
   (`asset-registry.ts:21-58`) are complete (14/14) but the whole module is
   deleted in Chunk 3 — hardening its typing now is 2-chunk-lived work.
   Neither the plan nor the manifest names a file for the new
   `KNOWN_TYPES`/`KnownType`/`presentationFor` artifacts (§C).

4. **The "tool"/"vault" rejection tests are a correctness decision wearing a
   typing costume.** `tool:deploy.sh` and `vault:*` are deliberately-removed
   types with dedicated guard tests/messages (`asset-ref.test.ts:192-194`,
   `asset-ref.ts:95-103`). A literal "accept any non-empty string" open
   token silently lets both back in as ordinary foreign types the moment
   the guard test is deleted — this needs an explicit decision (denylist
   retained vs. accepted regression), not a mechanical port (§D.3, §E.3).

5. **The system is only partially opened by this chunk.** `TYPE_DIRS`/
   `ASSET_SPECS`-gated closed-type checks in `proposal/repository.ts:416`,
   `write-source.ts:456`, and `asset-spec.ts:311` all survive untouched
   (Chunk 3's job) — a foreign type accepted by `parseAssetRef`/
   `validateStashEntry` after this chunk can still fail downstream at these
   other gates. The brief should scope "open token" claims to exactly what
   this chunk severs (§E.3).

6. **A real, unanticipated import-cycle win, empirically verified.**
   Severing `common.ts`'s dependency on `asset-spec.ts` (the only reason
   that edge existed was to build the now-deleted `ASSET_TYPES`) shrinks
   the cycle-participant baseline from 28 to 18 — confirmed by running the
   ratchet's own graph builder, not asserted from prose. `common.ts` itself
   stays in a cycle via a separate `common.ts <-> paths.ts` round trip, so
   it doesn't fully clear, but 10 other files do. Shrink-tolerant ratchet
   means this needs no action, but is worth banking or at least noting in
   the chunk report (§E.1).

**Confirmed not a risk:** `src/migrate/legacy/legacy-layout.ts` (chunk 1's
deliverable) is genuinely self-contained — it already anticipated this exact
chunk in its own header comment and inlined a private closed-union snapshot
specifically to survive it (§A.4, §E.2). Nothing to do here.

---

`docs/design/execution/chunk-1.5/anchors.md` written at this HEAD.
