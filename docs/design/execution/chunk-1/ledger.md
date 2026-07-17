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
