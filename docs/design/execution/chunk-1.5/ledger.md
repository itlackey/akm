# Chunk 1.5 — execution ledger (append-only)

Open the type token (type-only severs). netLoc −80. Branch:
`claude/akm-architecture-refactor-fubvd7`.

## Opened — grounding census + brief

- `anchors.md`: re-anchored every closed-union site at HEAD + whole-tree grep of
  AkmAssetType/isAssetType/ASSET_TYPES/ASSET_TYPE_SET (10 in-scope src files, not
  the manifest's 6); validateStashEntry + the second metadata.ts:1423 gate; the
  §2.3 typed-table candidates (TYPE_BOOST 8/14; TYPE_TO_RENDERER 14/14 but
  Chunk-3-deleted); the tool/vault correctness trap; the partial-opening phasing
  boundary; and an empirically-verified cycle win (28→18). 6 headline findings.
- `brief.md`: WI-1.5.1 (atomic sever+replacement) + WI-1.5.2 (close), decisions
  D1.5-1..7, 6-item trap list.

### Decisions recorded (MAINTAINER REVIEW — made autonomously overnight)
- D1.5-1 scope = ALL 10 in-scope files (+ 4 unnamed: collapse-detector/ranking/
  db-search/indexer-manifest + the metadata.ts:1423 gate).
- D1.5-2 fix the 2 hard-breaking test files in-chunk (direct symbol imports, not
  §15.2 ref-string churn).
- D1.5-3 atomic sever+replacement in one commit (exhaustiveness never gaps).
- D1.5-4 KNOWN_TYPES in recognition-util.ts (import-free); accessors in a stable
  (not-Chunk-3-deleted) home; open-string fallback.
- D1.5-5 TYPE_BOOST → full Record<KnownType,number> (6 missing → explicit 0;
  behavior-preserving + exhaustive).
- D1.5-6 tool/vault stay REJECTED via an explicit deny-list (correctness, not
  typing; vault has a security guard) — the key call, flagged.
- D1.5-7 trim cycle baseline 28→18 (empirically-verified win).
