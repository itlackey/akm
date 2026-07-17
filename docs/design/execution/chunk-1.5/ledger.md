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

## WI-1.5.1 — atomic sever + replacement (fdff3dc2)

Closed AkmAssetType union DELETED; type is now an open string token. Replacement
landed in the same commit (exhaustiveness never gaps): KNOWN_TYPES (14-tuple) +
isKnownType (recognition-util.ts, still import-free); core/type-presentation.ts
with a full Record<KnownType,Presentation> + presentationFor(type) open-string
fallback ({label:"Asset"}); TYPE_BOOST → full Record<KnownType,number> (6
previously-absent types explicit 0, behavior-preserving + exhaustive) +
typeBoostFor. All 10 in-scope files converted (grep AkmAssetType → 0, incl. the
4 unnamed + the metadata.ts:1423 gate). tool/vault stay rejected via an explicit
DEPRECATED_REJECTED_TYPES deny-list at all 3 gates (messages preserved; verified
the vault security guards are separate). 2 named + 5 more taxonomy-pin test
breaks fixed; §12.3 contract tests (type-token-contract.test.ts, 21). Cycle
28→18 (severing common→asset-spec cleared 10 participants), baseline trimmed to
the exact measured set.

Worker + reviewer gates: tsc; grep→0; cycle 18; lint; unit 10060/0; integration
4519/0 (one flaky SIGKILL chaos test passed on isolated re-run); contract test
21/0; huge targeted regression 0 fail.

### BEHAVIORAL CHANGES — intended consequences of the open token (MAINTAINER: aware)
These are consequences of opening the token, NOT defects (verified intent — the
open-token model makes foreign types valid, so these behaviors are correct in
the new model; re-closing them would defeat the chunk):
1. **Message change (phasing):** a foreign type is now rejected by a DIFFERENT
   downstream gate (TYPE_DIRS/ASSET_SPECS at proposal/repository.ts:411,
   asset-spec.ts:311 — still closed until Chunk 3) with "Unknown asset type …
   Known types: …" instead of parseAssetRef's "Invalid asset type". Foreign
   types are STILL rejected end-to-end until Chunk 3 opens those gates — just
   with a different message. Transient; changes again at Chunk 3.
2. **`remember --xref <foreign>:name` fail-open:** now skips silently (a
   pre-existing dead refToRelPath branch, now live) instead of erroring. Correct
   in the open-token world — a typo'd type is indistinguishable from a
   legitimate foreign type, so erroring would wrongly reject real foreign refs.
   A UX papercut for typos, inherent to the model; flagged for a maintainer
   policy call (e.g. a warn on unknown-AND-unresolvable xref) if desired.
3. **bare-word `--scope <unknown>` no longer errors** (by design, D1.5-1); zero
   pre-chunk test coverage. resolveImproveScope narrowed so only colon-free bare
   words fall open; malformed/deny-listed colon refs still error.

## WI-1.5.2 — chunk close

### Two manifest gates — verified
1. **grep AkmAssetType → 0** (declared scope src/ + scripts/, excluding
   src/migrate/legacy/) — verified empty.
2. **KNOWN_TYPES const tuple + typed tables in place (§2.3); presentationFor()
   open-string fallback** — KNOWN_TYPES + TYPE_PRESENTATION + TYPE_BOOST all
   typed over KnownType (14/14 exhaustive); presentationFor returns the {label:
   "Asset"} default for foreign/undefined; proven by the contract test.

### Net-LOC ≈ −80 target
The union block + scattered closed-type machinery deleted; the replacement
(KNOWN_TYPES tuple + presentation table + full-Record TYPE_BOOST + contract
tests) is smaller than what it replaced across the 10 sites. Cycle baseline
28→18 (a real structural win banked). Full `bun run check` run once at close.
