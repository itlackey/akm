# Chunk 1 — execution ledger (append-only)

Adapter base + util home. netLoc ~0. Branch:
`claude/akm-architecture-refactor-fubvd7`.

## Opened — grounding census + brief

- `anchors.md`: the amended BundleAdapter interface (adapter spec §2, with the
  ValidateContext/type-family gaps), scanComponent's prose-only shape + its
  walkStashFlat parallel + the genuinely-new nested-root subtraction, the util
  home relocation targets + cycle-safety, the frozen legacy-resolver surface +
  the self-containment trap, and gate mechanics. 6 headline findings.
- `brief.md`: 5 work items (WI-1.1..5), decisions D1-1..7, 8-item trap list.

### Decisions recorded (MAINTAINER REVIEW — made autonomously overnight)
- D1-1 mint the full type family now (BundleId/ComponentId/ItemRef/
  BundleInstallation/BundleComponent/IndexDocument/Diagnostic); IndexDocument
  real-now (Chunk 5 reconciles), Diagnostic modeled on LintIssue.
- D1-2 home = new src/core/adapter/.
- D1-3 recognize takes FileContext as-is (type-only core→indexer import; no
  cycle; layering wrinkle flagged).
- D1-4 "ref grammar constants" = DERIVED_SUFFIX (only real candidate).
- D1-5 recognition-util.ts import-free invariant (cycle-safety).
- D1-6 legacy-layout.ts genuinely self-contained (inline union + narrow
  AssetSpec, own constants) — survives Chunk 1.5/3 deletions.
- D1-7 scanComponent = real core walk + nested-root subtraction × recognize,
  tested vs a stub adapter (real-adapter conformance is Chunk 2's gate).

## Work items landed

### WI-1.1 — BundleAdapter interface + type family (f2d076c3)
New src/core/adapter/ (additive). types.ts: BundleId/ComponentId/ItemRef/
BundleInstallation/BundleComponent (spec §1.1), IndexDocument (spec §3, full —
Chunk 5 reconciles with StashEntry rename), ValidateContext (normative §12.1),
Diagnostic (minted from LintIssue, issue widened to open string). bundle-adapter.ts:
the amended interface per adapter spec §2 (recognize+validate REQUIRED; index/
affectedItems/placeNew/directoryList/looksLikeRoot OPTIONAL). FileChange reused;
FileContext type-only (D1-3, no cycle). Type-conformance test 5 pass.
REVIEWER REFINEMENT of D1-1 (flagged): the spec's Tier-B authoring/export/memory
facet methods + their 8 shapeless types are DEFERRED, not committed as
Record<string,unknown> placeholders on the foundational contract; each facet's
owning chunk adds its method + real shape. Aligns with the manifest's Tier-B
deferral.

### WI-1.2 — recognition-util.ts util home (30fb1420)
core/recognition-util.ts (import-free by invariant, D1-5): SCRIPT_EXTENSIONS/
WORKFLOW_EXTENSIONS/canonicalizeWorkflowName/DERIVED_SUFFIX moved verbatim (D1-4
resolved "ref grammar constants" = DERIVED_SUFFIX). Old homes cleaned (no shims);
every importer repointed (grep-verified, incl. 2 shim-users). Cycle 28.
Invariant test asserts zero `from "..."` clauses. 677-test regression 0 fail.

### WI-1.3 — scanComponent (0e60913b)
core/adapter/scan-component.ts: the core walk (reuse walkStashFlat) + nested-root
subtraction (normative §9.3, new — boundary-safe isPathUnder, arbitrary depth) ×
adapter.recognize, async generator. Layering wrinkle flagged (core→indexer value
import). 9-case test incl. the nested-root subtraction group. Cycle 28.

### WI-1.4 — frozen self-contained legacy-layout.ts (90bd5a03)
src/migrate/legacy/legacy-layout.ts (946 LOC) — imports node: ONLY (survives the
chunk 1.5/3 deletions, D1-6): inline 14-key snapshot, narrowed AssetSpec (no
renderer/action fields), own constant copies, self-contained ref grammar +
origin resolution (documented parseRegistryRef network-fetch narrowing). 92-test
suite mechanizes gate 2 (self-containment + shape + faithfulness-vs-live +
cross-check against WI-0b.3 goldens). Cycle 28.

## WI-1.5 — chunk close

### Two manifest gates — verified
1. **Amended BundleAdapter interface + scanComponent compile and are exercised
   by unit tests** — tsc clean; tests/core/adapter (bundle-adapter conformance +
   scan-component behavioral, incl. §9.3 nested-root subtraction) 14 pass. Scoped
   narrower than Chunk 2's index()==fold(recognize) conformance (no real adapters
   exist yet — tested against a stub).
2. **Frozen legacy resolver copy exists at migrate/legacy/legacy-layout.ts** —
   exists; mechanized by the 92-test shape/self-containment/faithfulness suite
   (gate made mechanical rather than eyeball, per the census E.2 recommendation).

### Net-LOC — ~0 core delta + the frozen-copy residual
Moves (WI-1.2) net-neutral; the additive contract (WI-1.1 interface+types,
WI-1.3 scanComponent) is small; the frozen legacy-layout.ts (946 LOC) is a
migrator artifact ledgered under the §12.1 residual row (throwaway, @removeIn
next-minor), outside the chunk's ~0 core target — same accounting as the plan's
other frozen copies. Cycle ratchet held at 28 throughout.

### Decisions for maintainer review (made autonomously overnight)
D1-1 (refined: Tier-B facets deferred, not placeholder-stubbed), D1-2..D1-7 as
recorded above. All are documented in-code + here; none change existing
behavior (chunk 1 is purely additive + one net-neutral move).
