# Chunk 2 — execution ledger (format-family adapters)

Mint the format-family `BundleAdapter`s (spec §4/§7), additive only (globals stay
live until Chunk 3). **The recognition model is fixed by spec §5.1 (BINDING):**
`okf` reads `type` from frontmatter (no directory gate); `akm` preserves current
behavior via the existing `runMatchers`/`classifyBy*` matcher stack. The 14 akm
formats are `type` VALUES, not adapters. There is NO reinterpreting census — each
WI implements directly against the cited spec sections.

> History: an earlier attempt built 10 per-`type` adapters with directory/positional
> recognition (wrong model — it conflated `type` and `adapter`, §0.2). It was
> reverted in full (`a5890bf8`) and the recognition contract pinned in spec §5.1
> (`d399514d`) so it cannot recur.

Branch: `claude/akm-architecture-refactor-fubvd7`.

## WI-A — adapter registry + `okf` adapter (Opus impl; Opus review, all gates re-verified)

Files (additive): `src/core/adapter/registry.ts`, `src/core/adapter/adapters/{okf-adapter,shared,index}.ts`,
`tests/core/adapter/{okf-adapter,registry}.test.ts`, `tests/fixtures/bundles/okf-sample/`.

- **registry.ts** — id-only format-family registry (`registerAdapter`/`getAdapters`/
  `adapterForId`/`resetAdapterRegistryForTests`). NO per-`type` mapping: `type` lives
  on `IndexDocument`, never maps to an adapter (§0.2/§6).
- **okf-adapter.ts** — spec §5 exactly: `recognize` reads `type` from frontmatter
  (`nonEmptyString(data.type) ?? "knowledge"`), NO directory gate; reserved
  `index.md`/`log.md` excluded (case-insensitive, any level); conceptId = path − `.md`;
  OKF projection (name←title / description / tags / updated←timestamp, §0.1/§3); §9
  links (both `/`-rooted and relative forms → conceptIds, matching §9's
  `item_links.dst_concept_id`); LENIENT validate (base checks; `missing-type`→info,
  `missing-ref`→non-blocking warning; `missing-updated` suppressed when `timestamp`
  present per §0.1); `placeNew`=`<root>/<conceptId>.md`; `directoryList`=`["."]`;
  `looksLikeRoot`=root `index.md` present (§1.2).
- **shared.ts** — base-check port (unquoted-colon/missing-updated/stale-path/missing-ref)
  copied to a leaf (avoids a `core/adapter → commands/lint` cycle edge); ref alternation
  from `KNOWN_TYPES`. Reused by later adapters' validate.
- **OKF fixture** — `tests/fixtures/bundles/okf-sample/` (reserved index.md/log.md at
  root + `tables/index.md`; concepts with `type: "BigQuery Table"`/`Metric`/none;
  both link forms). Dedicated OKF-conformant bundle per the maintainer decision — the
  frozen all-types stash/goldens are untouched.

### Gates (Opus re-ran each un-piped): tsc 0 · import-cycles 18 · lint 0 (58 goldens intact) · tests/core/adapter 54/0.

### Flagged decisions (worker, grounded in spec — for maintainer awareness)
- `hash` = sha256 of the FULL raw file (frontmatter+body), so a frontmatter-only edit
  invalidates incrementality (`types.ts` hash contract). `content` field is the bounded body.
- `missing-updated` suppressed when `timestamp` present — grounded in §0.1's
  `missing-updated`→`timestamp` mapping (else every OKF concept flags).
- `links` stored as bare conceptIds (matches §9's `dst_concept_id`), not bundle-prefixed refs.
- `Diagnostic` has no severity field → info/warning encoded in `issue` + `detail` text.

## Remaining
- **WI-B** — `akm` adapter (behavior-preserving port over the existing matcher stack, §5.1);
  parity = existing Chunk-0b all-types goldens byte-for-byte.
- **WI-C** — `TYPE_PRESENTATION` (renderer/action keyed on `type`, §2) + conformance
  (`looksLikeRoot` own-root-only) + full golden replay + close.
- Other format families (`llm-wiki`→Chunk 4; `claude`/`opencode`/`akm-workflow`/`akm-task`/
  `dotenv`/`agent-skills`/`website-snapshot`/`generic-files`) — scope per manifest.
