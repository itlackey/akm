# Chunk 1 — Adapter base + util home (implementation brief)

netLoc ~0 (moves + additive contract). Foundation for Chunk 2 (adapter
minting) through Chunk 8. Authority: manifest chunk id "1" (2 gates), adapter
spec (`akm-0.9.0-bundle-adapter-spec.md`) §§0–4 as amended (THE authoritative
interface — §2 lines 133-179), normative spec §9.3–9.4/§11.4/§12.1–12.2,
plan §2.1/§2.3/§3.4, and **`docs/design/execution/chunk-1/anchors.md`** (the
census — trust its verified anchors over the plan/spec text; re-verify line
numbers at implement time per §12.4).

## Binding decisions (brief author, Opus — made autonomously; MAINTAINER: review these)

- **D1-1 — mint the full supporting type family in chunk 1** (census finding 1/§A.3).
  The gate cites "adapter spec §§1–4 as amended," which requires `BundleId`,
  `ComponentId`, `ItemRef`, `BundleInstallation`, `BundleComponent`,
  `IndexDocument`, `Diagnostic` to compile — none exist in src yet. Mint them
  all against the spec §1 (lines 56–75) + §3 (lines 205–241) shapes. `FileChange`
  is reused as-is (`src/core/file-change.ts`, dependency-free). **`IndexDocument`:
  mint a REAL/full type now** (spec §3 shape), not a deferred placeholder —
  Chunk 5 reconciles it with the `StashEntry`→`IndexDocument` rename (it merges,
  not re-creates). **`Diagnostic`: define a concrete shape modeled on the
  existing `LintIssue`** (`src/commands/lint/types.ts:19-25`: `{file, issue,
  detail, fixed}`) — the spec never declares it, so we mint a minimal sensible
  shape and note it for the maintainer.
- **D1-2 — home: a new `src/core/adapter/` directory.** `bundle-adapter.ts`
  (the interface + the supporting types, or a sibling `types.ts`), `scan-component.ts`
  (the walk). Format-agnostic core, matching plan §2.1's "CORE" placement.
  (No doc specifies a path — §A.4 open decision, resolved here.)
- **D1-3 — `recognize` takes `FileContext` as-is** (`src/indexer/walk/file-context.ts`,
  type-only import). This is a core→indexer *layering* import (not a cycle —
  `core/adapter` is a new sink, imported only by tests in chunk 1, so it adds
  no cycle participant; verified against the shrink-only 28-baseline). FLAGGED
  for the maintainer: FileContext arguably belongs in core long-term; moving it
  is out of chunk 1's netLoc-0 scope. Type-only import keeps the ratchet green.
- **D1-4 — "ref grammar constants" = `DERIVED_SUFFIX`** (census finding 4/§C.2).
  It is the only real standalone-constant candidate (`derived-ref.ts:37`).
  `parseAssetRef`/`makeAssetRef` stay in `asset-ref.ts` (functions the plan
  keeps); `TYPE_ALIASES` is delete-scheduled, not relocated. Relocate
  `SCRIPT_EXTENSIONS`, `WORKFLOW_EXTENSIONS`, `canonicalizeWorkflowName`, and
  `DERIVED_SUFFIX` to `core/recognition-util.ts`.
- **D1-5 — `core/recognition-util.ts` MUST stay free of any internal `src`
  import** (census §C.3). All four relocated symbols are self-contained literals/
  pure functions today, so the leaf imports nothing from src and cannot become a
  29th cycle participant. This is an invariant to actively preserve, enforced by
  a test (WI-1.2).
- **D1-6 — the frozen `legacy-layout.ts` is a GENUINELY SELF-CONTAINED copy, not
  shallow re-exports** (census finding 2/§D.3 — the load-bearing trap). It must
  compile-survive Chunk 1.5 (deletes `common.ts:29-88`, the `isAssetType`/
  `AkmAssetType` union `parseAssetRef` depends on) AND Chunk 3 (deletes
  `asset-registry.ts` + `output/renderers.ts` type-registry that
  `ASSET_SPECS_INTERNAL`'s `rendererName`/`actionBuilder` fields call into).
  Therefore the copy: (a) inlines its own closed-union of the 14 type keys
  (snapshot, not a live `isAssetType` import); (b) NARROWS the copied `AssetSpec`
  to recognition/placement only (`stashDir`/`isRelevantFile`/`toCanonicalName`/
  `toAssetPath`) — dropping `rendererName`/`actionBuilder` (the migrator builds
  an old-ref map, never renders); (c) copies its OWN `SCRIPT_EXTENSIONS`/
  `WORKFLOW_EXTENSIONS`/`canonicalizeWorkflowName` (independent of the WI-1.2
  util home, per plan:138 "so the live util home can evolve without touching the
  migrator"); (d) copies the ref grammar (bare/origin-qualified/.derived shapes)
  + origin→source resolution (`registry/origin-resolve.ts`), self-contained.
  It imports NOTHING from a module scheduled for deletion in 1.5/3.
- **D1-7 — scanComponent scope** (census §B): implement a REAL, testable core
  walk — git-aware/symlink-safe/skip-dirs (reuse the `walker.ts` primitive shape)
  + nested-root subtraction (normative §9.3, genuinely new) × `adapter.recognize`
  per file. Signature (inferred, §B.1): `scanComponent(inst: BundleInstallation,
  c: BundleComponent, adapter: BundleAdapter): AsyncIterable<IndexDocument>`.
  Exercised against a STUB adapter implementing only `recognize` — NOT real
  adapters (those + the `index()==fold(recognize)` conformance suite are Chunk
  2's gate). If reusing `walker.ts` from core creates an unacceptable layering
  import, the walk primitive may be duplicated minimally into core — decide at
  implement time, prefer reuse, flag either way.

## Work items (independent commits; each gate-green; netLoc ~0)

- **WI-1.1 — supporting types + BundleAdapter interface** (`src/core/adapter/`).
  Transcribe the amended interface from adapter spec §2 (lines 133-179) VERBATIM
  (recognize REQUIRED, index/affectedItems/placeNew/directoryList/looksLikeRoot
  OPTIONAL, validate REQUIRED with `ValidateContext` from normative
  spec:562-569). Mint the type family (D1-1) from spec §1/§3. Reuse `FileChange`.
  Gate: compiles; a type-level conformance test (a stub adapter typechecks
  against the interface). Do NOT copy the stale decision-history §8.3 shape or
  the affectedItems-omitting normative §12.1 block (finding 3).
- **WI-1.2 — `core/recognition-util.ts` util home** (D1-4/D1-5). Move the 4
  symbols; repoint every importer (census §C.1 lists them: asset-spec self-use,
  indexer.ts, matchers.ts, workflows/{authoring,runs,workflow-asset-loader,brief},
  derived-ref.ts). A test asserts recognition-util.ts has zero internal src
  imports (the cycle-safety invariant). Cycle ratchet stays 28.
- **WI-1.3 — `scanComponent`** (`src/core/adapter/scan-component.ts`, D1-7). The
  core walk + nested-root subtraction × recognize. Behavioral unit test vs a
  stub adapter (git/symlink/skip-dirs + a nested-component-root subtraction case).
- **WI-1.4 — frozen `src/migrate/legacy/legacy-layout.ts`** (D1-6). Self-contained
  copy of the narrowed 14-type spec map + own extension constants + ref grammar +
  origin resolution. A shape/existence test (WI-1.5 gate 2 mechanization) asserts
  all 14 keys + the constants + origin-resolution are present AND that the file
  imports nothing from `common`/`asset-registry`/`output/renderers`/the live
  `recognition-util` (self-containment).
- **WI-1.5 — chunk close.** Both gates verified (interface+scanComponent compile
  + unit-tested; frozen copy exists + shape test green). Full `bun run check`
  ONCE. Ledger with net-LOC + the D1 decisions.

## Trap list (census-derived)

1. **Frozen copy self-containment** (D1-6) — the #1 trap. A textual copy that
   still imports `common.ts` (isAssetType) breaks at Chunk 1.5; one importing
   the renderer registry breaks at Chunk 3. Inline + narrow.
2. **Three interface shapes in three docs** (finding 3) — implement adapter spec
   §2 ONLY; ignore normative §12.1 (missing affectedItems) and decision-history
   §8.3 (stale, no recognize).
3. **recognition-util.ts must import nothing from src** (D1-5) — the moment it
   imports a cycle participant it risks a 29th baseline entry (shrink-only ⇒ hard
   fail).
4. **`IndexDocument` minted now, reconciled (not re-created) by Chunk 5** — don't
   defer its existence; Chunk 1's gate needs it to compile.
5. **scanComponent is designed, not lifted** — no literal signature exists;
   nested-root subtraction has no existing analog.
6. **Line drift** — re-verify matchers.ts/file-context.ts/walker.ts anchors at
   implement time (WI-0b.1's task fix shifted matchers.ts lines +3; §12.4).
7. **Do NOT build the other `migrate/legacy/` artifacts** — WORKFLOW_MIGRATIONS
   (Chunk 8) and the proposal legacy-import fold (Chunk 5) share the dir but
   aren't chunk 1's (census §D.1).
8. Un-piped gates; the full check catches shard-contention timeouts per-worker
   gates miss (learned at WI-0b.7) — run it at the close.
