# OKF v0.1 Conformance Audit

Audit date: 2026-07-23

AKM subject: `itlackey/akm` main at
`e664fa0c669e5737ae4bb6bfa303d7446a30978c`

OKF subject: `GoogleCloudPlatform/knowledge-catalog` at
`d44368c15e38e7c92481c5992e4f9b5b421a801d`

This document records the code audit and Docker-isolated empirical evaluation
of AKM against Google's Open Knowledge Format (OKF) v0.1. It is a snapshot of
the implementation at the commits above, not a claim about later revisions.
Use [the repeat-evaluation runbook](okf-v0.1-conformance-runbook.md) after
changing AKM.

## Method

- Runtime behavior was derived from code, not AKM documentation.
- OKF requirements were read from the upstream `okf/SPEC.md`.
- The AKM image was built from the exact main commit and used a container-only
  `HOME`, XDG state, source checkout, index, and test fixtures.
- Google's GA4 bundle was cloned and indexed inside Docker.
- A second bundle exercised missing frontmatter, missing type, unknown type,
  unknown keys, unknown `okf_version`, dangling links, a missing root index,
  duplicate titles, writable OKF targets, and reserved filenames.
- The custom containers and images were removed after the evaluation. The
  developer's local AKM installation and configuration were never used.
- File and line citations in this report refer to AKM commit `e664fa0` or, when
  prefixed with `GoogleCloudPlatform/knowledge-catalog@d44368c`, the pinned
  upstream checkout.

The upstream specification defines concept identity at
`GoogleCloudPlatform/knowledge-catalog@d44368c:okf/SPEC.md:50-65`, reserved
filenames at `:95-105`, frontmatter at `:114-162`, links at `:233-267`, index
files at `:271-295`, conformance at `:341-362`, and version handling at
`:382-396`.

## Overall Verdict

AKM is partially conformant as an OKF v0.1 consumer, but it is not fully
conformant.

The initial adapter recognition is mostly permissive and correct. The principal
failures occur after recognition:

1. Path identity is undermined by `type + name` deduplication and by
   title-derived user-facing refs.
2. Resolved links are discarded before durable persistence, so AKM does not
   retain the OKF relationship graph.
3. An OKF bundle without a root `index.md` is reclassified as AKM, despite
   missing indexes being explicitly tolerated by OKF.
4. There is no general OKF round-trip operation with which to prove unknown-key
   preservation.
5. AKM has no conformant OKF bundle producer.

## Verified And Corrected Premises

Several premises that had previously been inferred from documentation did not
match the audited code.

| Premise | Code result | Evidence |
|---|---|---|
| Main is final 0.9.0 | False. The audited main reports `0.9.0-rc.9`. | `package.json:2-4` |
| An OKF adapter may not exist | False. `okfAdapter` exists and is registered as `okf`. | `src/core/adapter/adapters/okf-adapter.ts:208-214`; `src/core/adapter/adapters/index.ts:73-90` |
| The adapter landed in 0.9.0 | The implementation first landed in commit `b72832e3` while the package was `0.9.0-rc.5`; the first containing release tag is `v0.9.0-rc.6`. | `src/core/adapter/adapters/okf-adapter.ts:5-30`; `package.json:2-4` |
| Adapter selection is persisted at install | False. Sources are probed again on every index scan. | `src/indexer/indexer.ts:749-796`; `src/indexer/installations.ts:142-189` |
| Configured component adapter IDs control indexing | False. The schema accepts them, but runtime source flattening discards `components`. | `src/core/config/schema/sources-bundles.ts:121-144`; `src/core/config/config-sources.ts:50-83` |
| Unknown adapters are skipped with a warning | The branch exists, but current probe-only derivation cannot produce an unknown ID. | `src/indexer/indexer.ts:912-918`; `tests/integration/indexer/adapter-dispatch.test.ts:18-23` |
| Reserved names are globally blocked for writes and `mv` | False. Writers and `mv` do not reject `index` or `log`. | `src/commands/read/knowledge.ts:52-63`; `src/core/asset/asset-placement.ts:69-80`; `src/commands/mv-cli.ts:1198-1249` |
| The AKM adapter classifies into 13 owned types | False at this commit. `KNOWN_TYPES` contains 14 values. | `src/core/recognition-util.ts:91-106` |
| LLM Wiki edges are frontmatter-only | False. It combines `xrefs:` and body Markdown links; `sources:` is a separate citation channel. | `src/core/adapter/adapters/llm-wiki-adapter.ts:173-260`; `src/core/adapter/adapters/llm-wiki-adapter.ts:297-306` |
| The Google repository contains a separate client specification | Not found. The OKF directory contains `SPEC.md`, a reference producer, a visualizer consumer, samples, and bundles. | `GoogleCloudPlatform/knowledge-catalog@d44368c:okf/README.md:22-35`; `GoogleCloudPlatform/knowledge-catalog@d44368c:okf/src/reference_agent/cli.py:145-186` |

The OKF adapter source first appeared in commit `b72832e3`. Production dispatch
through the detected adapter was completed separately. The current index path
resolves `adapterForId(component.adapter)` and invokes that adapter's
`recognize`: `src/indexer/indexer.ts:912-964`.

## Consumer Rule Verdicts

| # | OKF v0.1 consumer rule | Verdict | Evidence and rationale |
|---|---|---|---|
| 1 | Concept ID is file path minus `.md`. | **Violated end-to-end** | Recognition derives the right value at `src/core/adapter/adapters/okf-adapter.ts:120-141`, and provenance persists it at `src/indexer/indexer.ts:1123-1143`. However, persistence deduplicates by `type + name` at `src/indexer/indexer.ts:1040-1045,1098-1113`, search loses `conceptId` through `src/indexer/scan/doc-to-entry.ts:50-102`, and user-facing refs are rebuilt from title/name at `src/indexer/search/db-search.ts:86-97`. Arbitrary OKF refs are rejected by `src/core/asset/resolve-ref.ts:262-277`. |
| 2 | `index.md` and `log.md` are reserved at every level and never concepts. | **Satisfied for the OKF adapter** | Basenames are checked case-insensitively at every depth: `src/core/adapter/adapters/okf-adapter.ts:41-55,114-119`. Nested and mixed-case behavior is tested at `tests/core/adapter/okf-adapter.test.ts:108-127`. |
| 3 | `type` is the only required field; unknown types must be tolerated. | **Satisfied** | A non-empty string is retained verbatim and missing/blank values become `knowledge`: `src/core/adapter/adapters/okf-adapter.ts:120-148`. Unknown values receive generic presentation rather than rejection: `src/core/type-presentation.ts:136-147`. |
| 4 | Missing `title` may be derived from the filename. | **Satisfied** | The final concept-ID segment is the fallback: `src/core/adapter/adapters/okf-adapter.ts:129-130`. |
| 5 | Unknown keys should be preserved on round-trip and should not cause rejection. | **Undetermined** | Unknown keys do not reject recognition, but the adapter projects only known fields and does not populate `documentJson`: `src/core/adapter/adapters/okf-adapter.ts:120-154`. Metadata mutations can preserve keys by spreading parsed data: `src/core/asset/frontmatter.ts:150-174`; `src/commands/improve/memory/memory-belief.ts:134-149`. No generic arbitrary-OKF round-trip path exists to prove the complete contract. |
| 6 | Links are untyped directed edges; root-relative and relative links resolve; broken links are tolerated. | **Violated** | Simple inline root-relative and relative links resolve during recognition: `src/core/adapter/adapters/okf-adapter.ts:71-111`. Broken targets do not block recognition: `src/core/adapter/adapters/okf-adapter.ts:192-203`. But `doc.links` is discarded by `src/indexer/scan/doc-to-entry.ts:50-102`, and the index schema has no native item-link relation: `src/storage/repositories/index-schema.ts:238-266`. |
| 7 | A missing `index.md` may be synthesized. | **Not applicable** | Synthesis is optional. AKM does not implement it. Its only generated index is hidden `.meta/index.md`, not an OKF progressive-disclosure index: `src/commands/sources/stash-skeleton.ts:55-73`. |
| 8 | A consumer must not reject for missing optional fields, unknown type, unknown keys, broken links, or missing indexes. | **Violated** | Four conditions are tolerated. A missing root `index.md`, however, prevents OKF selection and falls back to `akm`: `src/core/adapter/adapters/okf-adapter.ts:226-229`; `src/indexer/installations.ts:142-155`. Config cannot force `okf` because component configuration is dropped: `src/core/config/config-sources.ts:50-83`. |
| 9 | Unknown `okf_version` values receive best-effort consumption rather than refusal. | **Satisfied by ignorance** | The adapter checks only for the existence of root `index.md`; it never reads `okf_version`: `src/core/adapter/adapters/okf-adapter.ts:226-229`. Unknown versions therefore cannot cause refusal. |

## A. Adapter Existence And Wiring

The adapter ID is `okf`. It is exported and occupies the ninth position in the
static built-in probe list, after `llm-wiki` and before `akm`:
`src/core/adapter/adapters/index.ts:73-90`.

The registry is populated at module load and maps IDs directly to adapters:
`src/core/adapter/registry.ts:33-54`.

The full index path builds one component per source, resolves the component's
adapter, and drains every walked file through that adapter's `recognize`:
`src/indexer/indexer.ts:749-796,886-978`.

The unknown-ID skip branch is defensive rather than currently reachable. The
configuration schema allows arbitrary component adapter IDs, but the conversion
to runtime sources omits those components before `deriveInstallations` runs:
`src/core/config/schema/sources-bundles.ts:121-144`,
`src/core/config/config-sources.ts:50-83`, and
`src/indexer/installations.ts:163-189`.

## B. Recognition And Precedence

The only OKF probe is exact lowercase root `index.md` existence. It does not
inspect frontmatter, `okf_version`, concept documents, or their `type` values:
`src/core/adapter/adapters/okf-adapter.ts:226-229`.

The probe order is first-match-wins. `llm-wiki` precedes `okf`, so a root with
`schema.md`, `pages/`, and `index.md` is owned by `llm-wiki`:
`src/core/adapter/adapters/index.ts:45-90`. That precedence is pinned by
`tests/indexer/installations.test.ts:53-61` and
`tests/core/adapter/conformance.test.ts:159-188`.

`akm add` probes while locating a source root, but the selected adapter is not
stored there. Every later index run derives installations and probes again:
`src/sources/providers/provider-utils.ts:35-72`,
`src/indexer/indexer.ts:749-796`, and
`src/indexer/installations.ts:142-189`.

No probe match falls back to `akm`, not `okf`:
`src/indexer/installations.ts:73-95`. The behavior is explicitly pinned by
`tests/indexer/installations.test.ts:63-70`.

## C. Type Handling

| Stage | Result | Evidence |
|---|---|---|
| Parse | Frontmatter `type` is trimmed and copied to `IndexDocument.type`; absent, blank, or non-string values become `knowledge`. | `src/core/adapter/adapters/okf-adapter.ts:120-148` |
| Persist | The value is stored in `entry_json`, `entry_type`, and additive `type`. | `src/storage/repositories/index-entries-repository.ts:65-88` |
| FTS | `type` is not an FTS field. | `src/indexer/search/search-fields.ts:34-84` |
| Filter | `--type` uses exact SQL equality on `entry_type`. | `src/storage/repositories/index-fts-repository.ts:44-71` |
| Rank | Known AKM types receive configured boosts; foreign types receive zero. | `src/indexer/search/ranking-contributors.ts:23-56,233-239` |
| Present | Unknown types use the generic `Asset` presentation. | `src/core/type-presentation.ts:136-147` |
| Output | The original type is included in search hits. | `src/indexer/search/db-search.ts:861-881` |

Type filtering, FTS inclusion, and ranking weight are product choices rather
than OKF conformance requirements.

## D. Unknown Types

`type: Some Vendor Thing` is accepted, persisted, filterable, and presented
generically. It is not skipped or normalized. This follows from
`src/core/adapter/adapters/okf-adapter.ts:126-148`,
`src/storage/repositories/index-fts-repository.ts:57-71`, and
`src/core/type-presentation.ts:136-147`.

The Docker adversarial run confirmed that the exact value survived into
`entry_type` and an exact `--type 'Some Vendor Thing'` query returned it.

## E. Link Graph

The adapter scans bodies with a regular expression for inline Markdown links,
strips queries and fragments, resolves `/` from the component root, resolves
relative paths from the current document, rejects external/non-Markdown/root-
escaping targets, and deduplicates the resulting concept IDs:
`src/core/adapter/adapters/okf-adapter.ts:71-111`.

This parser is narrower than standard Markdown. It does not handle
reference-style links, nested parentheses, angle-bracket destinations,
space-containing destinations, or percent-decoding. The limitation follows
from the single inline-link expression and whitespace truncation at
`src/core/adapter/adapters/okf-adapter.ts:73-93`.

Recognized links are temporarily attached to `IndexDocument.links`:
`src/core/adapter/adapters/okf-adapter.ts:134-153`. They are then omitted by the
exhaustive recognize-to-entry projection at
`src/indexer/scan/doc-to-entry.ts:50-102`.

There is no `item_links` table. The graph tables in the schema belong to the
separate LLM entity-relation graph, not native concept links:
`src/storage/repositories/index-schema.ts:169-198,238-266`.

LLM Wiki body traversal is not shared code. That adapter has a duplicate body
link parser and combines those links with frontmatter xrefs:
`src/core/adapter/adapters/llm-wiki-adapter.ts:186-245`. Its links are lost by
the same generic projection.

## F. Index And Log Files

`index.md` and `log.md` are only excluded. Their content is never read by OKF
recognition because the reserved-name return occurs before file parsing:
`src/core/adapter/adapters/okf-adapter.ts:114-124`.

Consequences:

- Index listings do not support progressive disclosure.
- Links in index files do not enter a relationship graph.
- Log history is not consumed.
- Missing indexes are not synthesized.
- Root `okf_version` is not parsed.
- An unknown version is tolerated because every version is ignored.

The Google reference bundles omit `okf_version`; for example, GA4's root index
is body-only at
`GoogleCloudPlatform/knowledge-catalog@d44368c:okf/bundles/ga4/index.md:1-5`.

## G. Rejection And Drop Paths

Before adapter recognition, the core walker can omit otherwise conformant OKF
documents:

- Git sources use `git ls-files`, thereby respecting `.gitignore`:
  `src/indexer/walk/walker.ts:69-97`.
- Dot-directories, `.git`, `node_modules`, `bin`, and `.cache` are excluded:
  `src/indexer/walk/walker.ts:99-129,187-212`.
- Symlinks are excluded by the manual walker:
  `src/indexer/walk/walker.ts:197-205`.

After walking:

- An unknown adapter ID skips the entire component with a warning:
  `src/indexer/indexer.ts:912-918`.
- The OKF adapter rejects only non-`.md` files and reserved basenames:
  `src/core/adapter/adapters/okf-adapter.ts:114-119`.
- `recognize()` returning `null` silently drops a file:
  `src/indexer/scan/drain-dir.ts:69-104`.
- Missing frontmatter, missing type, unknown type, unknown fields, malformed YAML
  with recoverable scalar fields, and broken targets do not block recognition:
  `src/core/adapter/adapters/okf-adapter.ts:120-154` and
  `src/core/asset/frontmatter.ts:47-63,102-129`.
- Persistence drops duplicate `type + name` identities, regardless of distinct
  concept paths: `src/indexer/indexer.ts:1040-1113`.

`BundleAdapter.validate` is not called by production indexing or linting. The
only direct OKF validation calls are tests:
`tests/core/adapter/okf-adapter.test.ts:234-320`.

A nonconformant file does not poison the bundle. The Docker bundle containing a
plain Markdown file and a typed vendor document indexed both, with the plain
document defaulting to `knowledge`.

## H. Round-Trip Preservation And Writable Reachability

Filesystem sources default writable; all other source kinds default read-only
unless explicitly enabled where supported: `src/core/write-source.ts:135-149`.
Local `akm add` creates a filesystem bundle without setting `writable: false`:
`src/commands/sources/source-add.ts:69-103`. Git installations preserve
`writable: true` only when the operator explicitly requested it:
`src/commands/sources/source-add.ts:174-197,264-275`.

Therefore a writable OKF bundle is reachable. The Docker GA4 local source was
reported as writable, and `remember --target` successfully wrote into an OKF
root.

Write behavior is not adapter-dispatched:

- Generic writes derive an AKM `stashDirFor(type)` destination:
  `src/core/write-source.ts:454-467`.
- `remember` writes under `memories/` or `knowledge/`:
  `src/commands/read/knowledge.ts:607-649`.
- Targeted post-write indexing hardcodes `akmAdapter`, even if provenance says
  `okf`: `src/indexer/index-written-assets.ts:97-163`.
- A later full index corrects the type according to the OKF adapter, causing
  transient type drift.
- Arbitrary OKF concept IDs such as `tables/events_` cannot pass the command ref
  parser: `src/core/asset/resolve-ref.ts:227-277`.
- `mv` operates only on the primary AKM stash and known type prefixes:
  `src/commands/mv-cli.ts:1251-1276`.
- `remember --supersedes` cannot target a foreign unprefixed OKF concept, but
  when it can target a known-prefix document its frontmatter mutation spreads
  all existing keys: `src/commands/improve/memory/memory-belief.ts:134-149`.
- Reflect is restricted to known Markdown types and merges source frontmatter,
  restoring protected identity fields including `type`:
  `src/commands/improve/reflect.ts:232-269,722-770`.
- Proposal acceptance requires a known AKM ref and computes an AKM type path:
  `src/commands/proposal/repository.ts:1630-1663,1985-1993`. It publishes the
  proposal payload, rather than reconstructing an OKF document from the index:
  `src/commands/proposal/repository.ts:1461-1557`.
- Memory-to-knowledge promotion deliberately projects selected fields and drops
  arbitrary source fields: `src/commands/improve/distill-promotion-policy.ts:240-254`.

Because there is no general adapter-aware OKF edit/export path, complete Rule 5
round-trip preservation remains undetermined.

## I. Producer Side

AKM cannot emit a complete conformant OKF bundle.

- The OKF adapter exposes `placeNew`, but normal writes do not call it:
  `src/core/adapter/adapters/okf-adapter.ts:216-219` and
  `src/core/write-source.ts:454-467`.
- `remember` does not emit `type`: `src/commands/remember.ts:96-126`.
- Session generation emits `type: session`, but it is one AKM-specific document
  writer rather than a bundle producer:
  `src/commands/improve/session-asset.ts:240-268`.
- Nothing emits root `okf_version`, OKF directory indexes, or log files.
- The only index scaffolder creates hidden `.meta/index.md`, which the walker
  deliberately skips: `src/commands/sources/stash-skeleton.ts:55-73`.

The empirical `remember --target adversarial` write produced:

```yaml
---
captureMode: hot
beliefState: asserted
---
Written into an OKF source
```

That document is not a conformant OKF concept because it has no `type`.

## J. Reserved-File Breadth

Recognition exclusions are adapter-specific rather than global. OKF and AKM
exclude reserved basenames at every depth:
`src/core/adapter/adapters/okf-adapter.ts:41-55,114-119` and
`src/core/adapter/adapters/akm-adapter.ts:257-265`.

LLM Wiki reserves its structural names only at the component root, so
`pages/index.md` can become a concept:
`src/core/adapter/adapters/llm-wiki-adapter.ts:159-164,263-292`.

More importantly, there is no global writer ban. Name normalization rejects
traversal but not `index` or `log`, Markdown placement adds `.md`, and the write
helper writes the resulting file:
`src/commands/read/knowledge.ts:52-63`,
`src/core/asset/asset-placement.ts:69-80`, and
`src/core/write-source.ts:183-209`.

The Docker run confirmed that `remember --name index --target adversarial`
created `memories/index.md`. The OKF adapter then excluded it, leaving a
successfully written but unindexable file.

The existing producer-conformance test is lexical. It searches source text for
literal `index.md` or `log.md` strings and cannot detect a runtime name plus
generic `.md` composition:
`tests/integration/reserved-filename-conformance.test.ts:58-69`.

The previously hypothesized stricter-than-OKF global ban therefore does not
exist. The actual behavior is a producer defect, not a stricter deviation.

## K. Tests

Present coverage includes:

- Registry population and order: `tests/core/adapter/registry.test.ts:22-85`.
- Probe selection and fallback: `tests/indexer/installations.test.ts:47-82`.
- Cross-adapter probe ownership: `tests/core/adapter/conformance.test.ts:135-188`.
- Direct OKF type, identity, reserved-name, link, and lenient-validation tests:
  `tests/core/adapter/okf-adapter.test.ts:64-320`.
- Unknown type ranking and presentation helper tests:
  `tests/core/type-token-contract.test.ts:34-143`.
- Production adapter dispatch, but only with an LLM Wiki source:
  `tests/integration/indexer/adapter-dispatch.test.ts:78-135`.

Missing coverage includes:

- No fixture copied from Google's GA4, Stack Overflow, or Bitcoin bundles.
- No end-to-end OKF `akmIndex` test that checks persisted type, content, links,
  unknown keys, search refs, or `show`.
- No missing-index tolerance test expecting OKF semantics.
- No duplicate-title/different-path test.
- No reference-style Markdown link test.
- No durable relationship/backlink test.
- No unknown-version test.
- No writable-OKF target test.
- No reserved-name runtime writer test.
- No adapter-dispatched lint test.

The focused Docker test command ran seven relevant files with 94 passing tests
and zero failures. Those passing tests validate adapter-local behavior but do
not cover the end-to-end failures above.

## L. Lint

`akm lint` is not adapter-dispatched. It scans nine hard-coded AKM directories:
`src/commands/lint/index.ts:46-56,236-241`.

Its prose scanner recognizes only fully qualified AKM bundle refs and skips
foreign concept prefixes. It does not parse ordinary Markdown destinations:
`src/commands/lint/base-linter.ts:290-345`.

The frontmatter `xrefs`, `supersededBy`, and `contradictedBy` channels are
checked separately as AKM refs:
`src/commands/lint/base-linter.ts:400-477,682-716`.

`--fail-on-flagged` changes the exit code only after lint has produced a flagged
finding: `src/commands/agent/contribute-cli.ts:159-170`.

Docker runs of `akm lint --fail-on-flagged` returned zero findings for both the
official GA4 bundle and the adversarial dangling Markdown link. Therefore a
spec-tolerated broken OKF body link does not currently fail CI.

The OKF adapter's own validator would describe a missing target as a
non-blocking warning, but production lint never invokes it:
`src/core/adapter/adapters/okf-adapter.ts:157-205` and
`tests/core/adapter/okf-adapter.test.ts:234-320`.

## Empirical Results

### Official GA4 bundle

The container cloned Google's repository, initialized an isolated AKM stash,
added `okf/bundles/ga4` as `okf-ga4`, and ran a full index.

Results:

- The source was claimed by `okf`.
- All 11 non-reserved concept files were persisted.
- Six `index.md` files and `viz.html` were not indexed as concepts.
- `BigQuery Table`, `BigQuery Dataset`, and `Reference` survived in
  `entry_type` and search output.
- `resource`, `timestamp`/`updated`, `content`, and `links` were absent from all
  11 durable entry JSON values.
- Every GA4 FTS content column had length zero.
- `akm search orders` returned no hits.
- `akm search events` returned typed hits, but their refs were based on titles.
- `akm show okf-ga4//tables/events_` failed because `tables` is not a known AKM
  type prefix.
- `akm show` on the title-derived search ref failed for the same reason.
- Body cross-links produced no durable edges.

The GA4 events declaration and its body links are visible at
`GoogleCloudPlatform/knowledge-catalog@d44368c:okf/bundles/ga4/tables/events_.md:1-29,306-307`.

### Adversarial bundle

The bundle included a root index declaring `okf_version: "9.9"`, one plain
Markdown file, one frontmatter block without `type`, one unknown type with an
unknown key and a dangling link, and two valid link targets.

Results:

- The unknown version was claimed by `okf`.
- The plain and missing-type files indexed as `knowledge`.
- `Some Vendor Thing` survived unchanged and worked with exact type filtering.
- The dangling link did not reject or poison the bundle.
- Body, links, timestamp, and unknown metadata did not survive in entry JSON.
- `akm lint --fail-on-flagged` returned zero findings.
- A separate root without `index.md` was claimed by `akm`; its vendor type was
  replaced with `knowledge`.
- Two files with the same type and title but different paths produced one row.
- `remember --target` could write into the OKF root, but emitted no `type`.
- `remember --name index --target` succeeded and created a reserved file that
  neither targeted nor full indexing retained.
- `remember --supersedes adversarial//unknown` failed because the concept ID had
  no recognized AKM type-directory prefix.

## Genuine Conformance Gaps

1. **Rule 1: path identity collision.** `type + name` deduplication removes
   distinct path-identified concepts: `src/indexer/indexer.ts:1040-1113`.
2. **Rule 1: unusable refs.** Search emits title-based refs and `show` rejects
   arbitrary OKF paths: `src/indexer/search/db-search.ts:86-97` and
   `src/core/asset/resolve-ref.ts:262-277`.
3. **Rule 1: universal walker exclusions.** Hidden, ignored, and selected
   infrastructure directories can contain conformant concepts that are never
   offered to the adapter: `src/indexer/walk/walker.ts:69-129,187-212`.
4. **Rule 6: relationship loss.** Recognized links disappear before durable
   storage: `src/core/adapter/adapters/okf-adapter.ts:134-153` and
   `src/indexer/scan/doc-to-entry.ts:50-102`.
5. **Rule 6: incomplete Markdown link parsing.** Standard reference-style and
   other valid Markdown links are outside the adapter's regex:
   `src/core/adapter/adapters/okf-adapter.ts:71-110`.
6. **Rule 8: missing-index misclassification.** A legal missing index changes
   the owning adapter to `akm`, and explicit config cannot override it:
   `src/indexer/installations.ts:142-189` and
   `src/core/config/config-sources.ts:50-83`.

## Deviations That Are Not Consumer Violations

- Index and log files are not consumed.
- Missing indexes are not synthesized, which is allowed because synthesis is
  optional.
- Reserved-name matching is case-insensitive and therefore stricter than the
  lowercase spelling in the spec.
- Missing or malformed frontmatter is consumed more permissively than bundle
  conformance requires.
- Adapter selection is repeated at index time instead of recorded at install.
- Configured component adapters are accepted but ignored.
- Body text is not included in FTS. OKF does not prescribe search
  infrastructure, although this explains the failed `orders` query.
- Unknown types get no ranking boost. Ranking policy is outside OKF.
- AKM is consumer-only. The absence of a producer is not a consumer violation.

## Undetermined

Rule 5 round-trip fidelity remains undetermined. To settle it, AKM needs either:

- an adapter-aware generic edit/export operation for arbitrary OKF concept IDs,
  plus a test proving unknown nested keys survive; or
- an explicit decision that AKM never round-trips OKF documents, making the
  preservation recommendation not applicable to AKM's consumer role.

Do not reclassify Rule 5 as satisfied solely because recognition does not throw.
Non-rejection and preservation are separate requirements.

## Out Of Scope

The following should not be reported as OKF gaps:

- Whether `type` is an FTS term.
- Whether particular types receive ranking boosts.
- Search weighting or semantic embedding policy.
- Automatic index synthesis, because the specification says MAY.
- Absence of a producer, when evaluating consumer conformance only.
- AKM-specific graph extraction from entities and relations; it is distinct from
  the native OKF link graph.
