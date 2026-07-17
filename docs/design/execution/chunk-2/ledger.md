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

## WI-B — `akm` adapter: recognition + placement (Opus impl; Opus review, all gates re-verified)

Files (additive): `src/core/adapter/adapters/akm-adapter.ts`, `adapters/index.ts` (registers
`akmAdapter`), `tests/core/adapter/akm-adapter.test.ts`. The behavior-preserving port per §5.1.

- **recognize** — `recognizeMatch(file)` reproduces `runMatchers`'s arbitration SYNCHRONOUSLY:
  the SAME six builtin matcher functions (`extensionMatcher`/`directoryMatcher`/
  `parentDirHintMatcher`/`smartMdMatcher`/`wikiMatcher`/`workflowProgramMatcher`, imported
  from `matchers.ts`) in registration order, winner by specificity-desc then later-index-wins
  — byte-identical to `runMatchers`'s comparator. **Component root = the STASH ROOT** (not a
  per-type subdir); the matchers' own dir-hints do the classification, exactly as today. This
  is the correct model — the opposite of the reverted per-subdir/positional approach.
- conceptId via `deriveCanonicalAssetNameFromStashRoot(type, root, absPath)` (per-type
  canonical name reproduced); `type` carried separately (§0.2). Winner's renderer carried on
  `documentJson.renderer` for WI-C (no new IndexDocument field).
- **placeNew** — recovers type from the conceptId's leading `<stash-subdir>/<name>` segment
  (reverse-maps `TYPE_DIRS`) → `resolveAssetPathFromName` (unchanged); unqualified → `<root>/<id>.md`.
- **directoryList** = `TYPE_DIRS` values; **looksLikeRoot** = `detectStashRoot` logic
  (`.stash` marker or any `TYPE_DIRS` subdir present).
- **validate** = base checks only; per-type linters marked `// WI-C`.

### Fidelity proof + gates
- Parity test drives the akm adapter over the EXISTING all-types fixture: recognize().type +
  carried renderer match `recognition/all-types.json` for all 15 files (totality-asserted);
  placeNew matches `placement/all-types.json` (14 byType + edges). A fidelity test asserts
  `recognizeMatch` `toEqual` async `runMatchers` on all 15 fixture contexts + 4 hand-built
  out-of-type-dir contexts (every matcher wins ≥1) — proves the sync reproduction is exact.
- Gates (Opus re-ran un-piped): tsc 0 · cycle 18 (no copy-to-leaf needed — akm-adapter is a
  downstream-only leaf; matchers/asset-spec edges add no back-path) · lint 0 · tests/core/adapter
  69/0 · live recognition-placement golden 8/0. Nothing live touched (delegation via imports).

### Flagged (worker, grounded — for maintainer)
- **conceptId spelling asymmetry:** recognize emits the BARE per-type canonical name (type
  carried separately, §0.2); placeNew consumes the QUALIFIED `<stash-subdir>/<name>` form
  (placement is type-driven; a bare name can't recover a type). Reconciling both onto one
  canonical stored spelling is a downstream index-persistence/ref concern (Chunk 3/5).
- `extensions` on akm is a non-exhaustive HINT — recognition is `recognize()`-driven (e.g. a
  bare extensionless `secrets/<x>` is a secret), so `recognize()` is the source of truth.
- Non-`.md` types never read their body for `name` (secret/env value safety); only `hash`
  reads bytes, opaquely.

## WI-C — `akm` adapter: validate + presentation + metadata contributors (Opus impl; Opus review, gates re-verified)

Completes the `akm` adapter's four surfaces. Files: `type-presentation.ts` (extended),
`akm-adapter.ts` (validate + recognize metadata fold), new leaves `akm-lint.ts`/`akm-metadata.ts`,
tests `akm-validate.test.ts`/`akm-presentation.test.ts` (+ `akm-adapter.test.ts` extended).

- **presentation (§2)** — `Presentation` extended to `{label, renderer?, action?}` (typed over
  `KNOWN_TYPES`, exhaustive); populated for all 14 types VERBATIM from `TYPE_TO_RENDERER` +
  `ACTION_BUILDERS` (incl. the 6 static-only: script/skill/command/agent/knowledge/memory). The
  one function-valued builder (`workflow`→`buildWorkflowAction`) inlined to keep the leaf
  import-free. `presentationFor` open fallback unchanged. Renderer buildShowResponse stays in the
  live renderers (Chunk 3 repoints) — this WI is the type→renderer/action NAMING table.
- **per-type validate (§6)** — `akm-lint.ts`: recover type via `recognizeMatch` over an OVERLAY
  FileContext (`change.after ?? ctx.readFile`, no live-FS), then the winning type's extra checks
  reproduced from the linters (command/agent `missing-name-or-type`, fact `missing-category`, task
  `invalid-task-yaml`, workflow[.md-only] `placeholder-stub`+`invalid-workflow-structure`, memory
  `orphaned-stub`, skill `missing-skill-md` as a change-set dir pass, env/secret dangerous-key).
  **READ-ONLY:** placeholder-stub/orphaned-stub emit non-fixable Diagnostics, never delete.
  **Security:** `isDangerousVaultKey` is IMPORTED from `env-key-rules` (not copied — the 40+ key
  set must not drift); the `.env`-suffix scan narrowness is preserved exactly (bare `secrets/<x>`
  not scanned). Lint-golden `perType` parity: `[]` for all 15 fixture files; positive findings
  (missing-skill-md/invalid-task-yaml/dangerous-vault-key/…) verified firing.
- **metadata contributors (§2)** — `akm-metadata.ts`: all 11 `registerMetadataContributor` sites
  (9 + 2 workflow) folded into recognize keyed on the winning renderer name, importing the exact
  pure parsers so the fold can't drift; parity proof = 0 mismatches vs live
  `applyMetadataContributors` on all 15 files. Homeless extras (toc/parameters/source) ride
  `documentJson`; first-class fields (tags/searchHints/description/confidence) land directly.

### Gates (Opus re-ran un-piped): tsc 0 · cycle 18 · lint 0 · tests/core/adapter 94/0 · live lint+renderer+recognition goldens 19/0. Nothing live touched.

### Flagged (worker, grounded)
- `missing-skill-md` is a directory-structure check → reproduced as a `skills/<name>/`-keyed
  change-set pass (can't be per-file-type-keyed); `file`/`detail` identical to `SkillLinter`.
- workflow `.yaml` gets base checks only (production `collectMarkdownFiles` never lints `.yaml`;
  the golden pins it via `parseWorkflowProgram`, not a lint path).
- metadata comparison isolates the 11 contributors (minimal `{name,type}` seed) — `applyCuratedFrontmatter`
  is a separate concern (§2 scopes only the contributor sites).

## Chunk-2 parity gate status
The **`akm` adapter alone satisfies the recognition/placement/renderer/lint parity gate for all 14
akm-native formats** (byte-for-byte vs the Chunk-0b all-types goldens), and `okf` adds the
frontmatter reference path (§5). Both verified.

## Remaining
- **WI-D** — conformance suite (`looksLikeRoot` fires on own golden root, no sibling's; the
  `index()==fold(recognize)` §12.3 gate — vacuous for these non-`index()` adapters, still asserted)
  + full golden replay through the adapters + chunk close (full `bun run check`, gate CHECK_EXIT==0).
- Other format families — `llm-wiki`→Chunk 4; `claude`/`opencode`/`agent-skills`/`akm-workflow`/
  `akm-task`/`dotenv`/`website-snapshot`/`generic-files` are format families for NON-akm-workspace
  bundles (no Chunk-0b golden coverage — the only fixture is akm-native all-types). Scope/sequencing
  for these vs. deferral is a maintainer decision (flag for review).
