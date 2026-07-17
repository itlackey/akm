# Chunk 1.5 — Open the type token (implementation brief)

netLoc −80. Replaces the CLOSED `AkmAssetType` union with an OPEN string token
(foreign/adapter types allowed as DATA), preserving compile-time exhaustiveness
for AKM-owned presentation/ranking tables via a `KNOWN_TYPES` tuple. Chunk 1's
frozen `legacy-layout.ts` already snapshotted the closed union, so deleting the
live one is safe. Authority: manifest chunk id "1.5" (2 gates + testBucket),
plan §2.3/§15.4, and **`docs/design/execution/chunk-1.5/anchors.md`** (the
census — trust its HEAD-verified anchors; the manifest's own line list
under-covers the gate).

## Binding decisions (Opus, made autonomously overnight — MAINTAINER: review)

- **D1.5-1 — scope is ALL 10 in-scope files, not the manifest's 6** (census
  finding 1). Convert every consumer of `AkmAssetType`/`isAssetType`/
  `ASSET_TYPES`/`ASSET_TYPE_SET` (declared scope: src/ + scripts/, excluding
  src/migrate/legacy/): the named `common.ts`/`salience.ts`/`eligibility.ts`/
  `mv-cli.ts`/`asset-ref.ts` PLUS the 4 unnamed (`collapse-detector.ts`,
  `ranking.ts`, `db-search.ts`, `indexer/manifest.ts`) AND the second unnamed
  gate at `metadata.ts:1423` (`generateMetadataFlat`, distinct from
  `validateStashEntry`). Gate 1 (`grep AkmAssetType → 0`) only passes when ALL
  convert.
- **D1.5-2 — the 2 hard-breaking test files are fixed IN THIS CHUNK** (finding
  2): `tests/asset-ref.test.ts` + `tests/integration/common.test.ts` import
  the deleted symbols directly and won't compile after the deletion. The §15.2
  "tests swept later" note covers ref-STRING churn (Chunk 5), NOT direct
  symbol imports — these must convert here.
- **D1.5-3 — atomic sever+replacement in ONE commit** (testBucket: "deletions
  land WITH their §12.3 replacement contract tests in the same commit —
  exhaustiveness guard never gaps"). WI-1.5.1 mints `KNOWN_TYPES` + the typed
  tables + `presentationFor` AND deletes the union AND converts all consumers
  AND lands the replacement contract tests, atomically.
- **D1.5-4 — `KNOWN_TYPES` lives in `core/recognition-util.ts`** (WI-1.2's
  import-free util home — a plain `as const` tuple of the 14 AKM-owned type
  keys adds no import). It is a HINT/exhaustiveness tuple, NOT a validation
  gate — unknown tokens are valid data. The typed presentation/ranking tables
  key over `KNOWN_TYPES` with an open-string fallback. `presentationFor(type)`
  + the ranking accessor return a sensible DEFAULT for unknown types. Place the
  accessors in a stable module (NOT `asset-registry.ts`/`output/renderers` —
  deleted in Chunk 3); the worker picks the concrete home and flags it.
- **D1.5-5 — TYPE_BOOST retyped as a FULL `Record<KnownType, number>`**
  (finding 3): it covers only 8/14 today (6 silently default to 0). Give the 6
  explicit `0` entries — behavior-preserving AND compile-time-exhaustive (the
  §2.3 guard: adding a KNOWN_TYPE forces a boost decision). Same pattern for any
  other AKM-owned type-keyed table converted.
- **D1.5-6 — the deliberately-removed types (`tool`/`vault`) STAY REJECTED via
  an explicit deny-list, NOT via the closed union** (finding 4 — the key
  correctness call). A literal "accept any non-empty string" would silently
  re-admit them (`vault` has a security guard — the dangerous-vault-key lint).
  The open token accepts foreign types EXCEPT the explicitly-deprecated set;
  their guard tests/messages are RETARGETED to the deny-list, not deleted.
  FLAGGED prominently — the maintainer may prefer full-open. First VERIFY what
  each guard actually rejects + why before porting.
- **D1.5-7 — bank the cycle win: trim the ratchet baseline 28 → 18** (finding 6,
  empirically verified): deleting the union severs `common.ts → asset-spec.ts`,
  clearing 10 participants (common.ts stays via a separate common↔paths edge).
  Re-verify the exact new baseline empirically and set it; shrink-only ratchet,
  so this is banking a real improvement.

## Phasing note (finding 5 — not a bug, a boundary)
Chunk 1.5 opens the token at the VALIDATION/DATA layer. The
`TYPE_DIRS`/`ASSET_SPECS`-gated downstream checks (`proposal/repository.ts:416`,
`write-source.ts:456`, `asset-spec.ts:311`) stay closed until Chunk 3 (when real
adapters provide placement/recognition). A foreign type accepted post-1.5 can
still fail at those gates — expected phasing, documented in the ledger.

## Work items

- **WI-1.5.1 — atomic sever + replacement** (one commit). (a) Mint `KNOWN_TYPES`
  (recognition-util.ts) + the typed presentation/ranking tables + `presentationFor`
  open-string fallback (§2.3). (b) Delete `common.ts:29-88` (union block). (c)
  Convert all 10 in-scope files + the 2 test files (D1.5-1/2) to the open token;
  relax `validateStashEntry` AND the `metadata.ts:1423` gate to open-token,
  preserving the `tool`/`vault` deny-list (D1.5-6). (d) Land the §12.3
  replacement contract tests (open token accepted as data; KNOWN_TYPES
  exhaustiveness compiles; presentationFor fallback; deny-list still rejects).
  (e) Trim cycle baseline 28→18 (D1.5-7). All gate-green.
- **WI-1.5.2 — close.** Gate 1 `grep AkmAssetType → 0` (declared scope). Gate 2
  `KNOWN_TYPES` + typed tables in place + `presentationFor` fallback. Full
  `bun run check` ONCE. Ledger + net-LOC + the D1.5 decisions.

## Trap list
1. Exhaustiveness guard must NEVER gap — mint the replacement in the SAME commit
   as the deletion (D1.5-3).
2. Any exhaustive `switch`/`Record<AkmAssetType,…>` that opens must gain an
   open-token FALLBACK (default arm) or it silently mis-handles foreign types
   (finding — trace each closed consumer for this, not just the type annotation).
3. tool/vault: correctness, not typing — preserve the deny-list (D1.5-6).
4. Don't touch `src/migrate/legacy/` (frozen, grep-exempt); confirm it still
   compiles independently after the live deletion (census §E — it's
   self-contained, but verify).
5. Re-verify all anchors at HEAD (drift since chunk-0b's re-measurement).
6. Full check at close — the taxonomy conversion touches ranking/search/metadata;
   run the whole suite (not just per-worker gates).
