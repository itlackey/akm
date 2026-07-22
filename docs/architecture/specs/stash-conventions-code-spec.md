# Spec: code changes for the stash organization & back-linking conventions

Status: implemented (SPEC-1..8 landed 2026-07-11/12; SPEC-6 shipped capture-only — the rank-time demotion was dropped after the spec's own prescribed curate-golden measurement showed no crowding, with tests/search-convention-fact-demotion.test.ts pinning that invariant; see CHANGELOG.md for per-spec outcomes)
Author: akm
Date: 2026-07-11
Companion: [stash-organization-conventions.md](stash-organization-conventions.md)

## Overview

Implementation specs for the code changes the finalized stash-organization/back-linking conventions imply. All file paths, functions, and line anchors below were verified against the working tree at /home/user/akm (branch claude/akm-stash-conventions-69633n). Key grounding corrections discovered during the survey: (1) `akm lint` ALREADY runs a deterministic broken-ref check (`missing-ref`, src/commands/lint/base-linter.ts:593-620) over BODY text and `refs:` frontmatter arrays for memories/knowledge/lessons/facts/agents/commands/skills/workflows — the conventions' "non-wiki xrefs have no broken-link lint" claim is precisely true only for the `xrefs:`/`supersededBy:`/`contradictedBy:` FRONTMATTER channel, which is exactly the channel the conventions mandate; so candidate #1 shrinks to a small, surgical extension of the existing check rather than a new lint system. (2) `akm remember` cannot express xrefs at all today — it always wraps content in its own generated frontmatter (buildMemoryFrontmatter, src/commands/remember.ts:87-117), so an agent following the mandatory-provenance rule through the CLI would produce nested frontmatter blocks; candidate #3 is therefore load-bearing, not sugar. (3) The path-tag suppression guard (metadata.ts:1113-1115) behaves differently on the two indexing paths: the flat walk passes `path.dirname(file)` as the tag root (metadata.ts:1194,1202), so even the empty-tags fallback sees NO directory segments there — the fix should derive scope/domain tokens from `canonicalName` (the ref subpath), which is uniform across both paths. (4) Embeddings are only generated for entries lacking one (db.ts:1561-1568); changing indexed text does NOT re-embed, which constrains specs 2 and 8. Argued down (with reasons in the relevant specs): non-wiki orphan lint (orphanhood is the legitimate normal state under the finalized conventions — associative xrefs discretionary, hubs optional, bidirectionality best-effort; a per-asset orphan flag would mark most of a healthy stash); non-wiki uncited-source lint (provenance is conditional per the finalized backlinks rule "an original observation with no source carries none — never invent provenance"; a deterministic checker cannot distinguish original from derived and would incentivize fabricated provenance, the exact failure mode the review killed); xrefs feeding the entity graph (the finalized text now teaches xrefs NEVER feed the graph and body prose is the channel; deterministic ref-token edges would pollute canonical entity names and re-open the rejected typed-provenance debate); typed `sources:` channel for all types (explicitly rejected by the judge as convention-ahead-of-mechanics — stays a design-doc open question); new consolidation/promotion code (none needed — resolveStashStandards already injects the amended convention facts into consolidate.ts:1510, extract.ts:1060, distill.ts:910, recombine.ts:676, procedural.ts:371, reflect via resolveStandardsContext, propose.ts:180, schema-repair.ts:181; correction demotion is covered by SPEC-5); and surfacing lint findings in `akm health` (health checks are runtime/state-db probes — lint already has its CI gate via --fail-on-flagged).

## Specs

| ID | Priority | Title | Sizing |
|---|---|---|---|
| SPEC-1 | P0 | Extend akm lint missing-ref to frontmatter xref channels (xrefs, supersededBy, contradictedBy) | S |
| SPEC-2 | P0 | Merge path-derived scope/domain tokens into tags even when explicit tags exist | S |
| SPEC-3 | P1 | --xref on akm remember and akm import with write-time ref resolution (+ type-root placement hint) | M |
| SPEC-4 | P1 | Real ref-prefix filter: akm search "<type>:<prefix>/" translates to typed enumeration with name-prefix narrowing | M |
| SPEC-5 | P1 | --supersedes on remember/import: atomic correction + demotion of the superseded asset | S |
| SPEC-6 | P2 | Capture fact category into the index and demote category:convention facts at rank time | S |
| SPEC-7 | P2 | akm mv: rename with inbound-xref rewrite and utility-history preservation | L |
| SPEC-8 | P2 | Config-gated indexing of the self-situating body opening | M |

### SPEC-1 — Extend akm lint missing-ref to frontmatter xref channels (xrefs, supersededBy, contradictedBy)

**Priority:** P0 · **Sizing:** S — ~40 lines in one function plus tests; all helpers exist.

**Problem.** The conventions route provenance and correction links through `xrefs:`/`supersededBy:` frontmatter, and warn that renames dangle non-wiki xrefs silently. Verified gap: BaseLinter.runBaseChecks scans only ctx.body (or the `refs:` frontmatter array when present) via checkMissingRefs (base-linter.ts:243-308, invoked at :608-620); the `xrefs:`, `supersededBy:`, and `contradictedBy:` keys are never validated for ANY asset type. Wikis get broken-xref lint (src/wiki/wiki.ts lintWiki, :919-1000) but only for intra-wiki refs. So the single channel the conventions mandate is the single channel with zero checking. Orphan and uncited-source checks for non-wiki assets are ARGUED DOWN: orphanhood is the sanctioned normal state (discretionary associative links, best-effort bidirectionality), and uncited-source is undecidable without knowing whether an asset is derived — flagging it would push agents toward fabricated provenance.

**Convention rule served.** backlinks.md 'One xref is mandatory when the asset derives from another' + corrections/beliefState rules; organization.md 'Non-wiki inbound xrefs have no broken-link lint, so a rename dangles them silently'. Surface decision per mandate: akm lint (already the deterministic offline checker with missing-ref, CI-gated via --fail-on-flagged; health is runtime probes; the indexer must stay fail-open and non-judgmental).

**Design.** In BaseLinter.runBaseChecks (src/commands/lint/base-linter.ts), inside the existing `shouldRun("missing-ref")` block (:608): add a frontmatter-key pass that runs REGARDLESS of the `refs:` body-scan carve-out (that carve-out governs only the body scan). For each key of ["xrefs", "supersededBy", "contradictedBy"]: read `ctx.data[key]` through the existing `readRefsArray` helper (:348-355); if non-null, run `checkMissingRefs(values.join("\n"), ctx.stashRoot, ctx.extraStashRoots)` and emit issue type `missing-ref` with detail `missing ref: <ref> (frontmatter <key>; resolved to <relPath>)`, fixed: false. No changes to REF_RE (:158), refToRelPath (:175), or refExistsInAnyStash (:195) — those are contract-locked with akm-plugins (header block :5-39). Non-ref-shaped values (URLs, `raw/<slug>`, `<placeholder>` templates, shell vars) fall out naturally via checkMissingRefs' existing guards (:259-297). All four md linters (KnowledgeLinter, MemoryLinter, DefaultLinter/lessons, FactLinter) inherit automatically since they route through runBaseChecks; wikis stay untouched ("wikis" absent from STASH_SUBDIRS, src/commands/lint/index.ts:37-47). `lint_skip: [missing-ref]` suppresses the new pass too (it lives inside the same shouldRun gate). Cross-stash refs resolve via extraStashRoots already plumbed from resolveSourceEntries (index.ts:106-109).

**Files.**
- `src/commands/lint/base-linter.ts`
- `tests/lint.test.ts`

**Contracts & stability.** ref-resolver contract (tests/contracts/ref-resolver-contract.test.ts + akm-plugins sister copy) untouched — no resolver behavior change. LintIssueType union unchanged (reuse missing-ref; consumers keyed on issue type see no new variant). AkmLintResult shape unchanged; `ok:true` semantics preserved (findings are flagged, never errors). akm lint is not in STABILITY.md's Stable list — additive detail-string change is safe.

**Test plan.** tests/lint.test.ts, extending the existing 'missing-ref check' describe block (:476): (1) memory with `xrefs: [knowledge:auth/nonexistent]` → flagged, detail contains 'frontmatter xrefs'; (2) resolvable xref → clean; (3) `refs: []` (authoritative-empty) does NOT suppress the xrefs scan; (4) dangling `supersededBy:` → flagged; (5) URL and `<placeholder>` values in xrefs skipped; (6) `lint_skip: [missing-ref]` suppresses both body and frontmatter passes; (7) xref resolvable only in an extraStashRoot → clean. Run `bun test tests/lint.test.ts` + `bun test tests/contracts/ref-resolver-contract.test.ts`.

**Risks.** Existing stashes with already-dangling xrefs get newly flagged — intended, but note in CHANGELOG so --fail-on-flagged CI users aren't surprised. `sources:` deliberately excluded (non-wiki sources: was rejected by the judge; wiki sources: are checked by lintWiki's broken-source). `source_refs:`/`evidenceSources:` excluded — they legitimately point at merged-away/pruned assets (historical provenance) and would be noise.

### SPEC-2 — Merge path-derived scope/domain tokens into tags even when explicit tags exist

**Priority:** P0 · **Sizing:** S — one helper + one merge line + tests; the cost is coordination (canaries, doc follow-up), not code.

**Problem.** Verified footgun: extractTagsFromPath fires only when tags are empty (metadata.ts:1113-1115), so setting explicit tags silently drops the path scope/domain token from the tags FTS column (bm25 weight 3.0, db.ts:850) and from tagRankingContributor's exact-match boost (+0.15/token cap 0.3, ranking-contributors.ts:171-183) and from projectContextRankingContributor's tag field (:394-413). The finalized conventions work around this in prose ('restate the scope/domain token'), and the finalized unresolved-items list explicitly names 'always-merge path tags' as task-#6 intake. Additional verified defect: on the flat-walk path, buildEntryFromFile receives dirPath = path.dirname(file) (metadata.ts:1194→1202), so even the empty-tags fallback derives tags from the FILENAME only — directory segments are lost there today.

**Convention rule served.** organization.md footgun bullet ('path and filename tokens are auto-added to tags only when tags is empty... you lose the tag-match ranking boost') + off-axis-facets-as-tags rule; design-doc unresolved intake item 'always-merge path tags'.

**Design.** In buildEntryFromFile (src/indexer/passes/metadata.ts, around :1113-1117): (a) keep the empty-tags fallback `entry.tags = extractTagsFromPath(file, dirPath)` byte-identical (back-compat for aliases + collapse-detector canaries); (b) add an unconditional merge of DIRECTORY-segment tokens derived from `canonicalName` (the ref subpath — uniform across generateMetadata and generateMetadataFlat): new exported pure helper `extractDirTagsFromName(name: string): string[]` = name.split("/").slice(0, -1), each segment split on /[-_.]+/, lowercased, length > 1 (same tokenization as extractTagsFromPath :1337-1351). Insert `entry.tags = [...(entry.tags ?? []), ...extractDirTagsFromName(canonicalName)]` immediately before the existing `entry.tags = normalizeTerms(entry.tags ?? [])` at :1117, which dedupes. Filename tokens are deliberately NOT merged when explicit tags exist — they already live in the FTS name column at weight 10.0 and in aliases (buildAliases :1258), and merging them would inflate exact-tag matches for every filename word. Ranking impact assessed: entries with explicit tags in subdirectories gain the tag-match boost for their scope/domain token (the intended convention outcome); FTS tags column gains tokens already present in name (small bm25 delta); project-context boost unchanged in score (per-token hit counted once across fields). buildSearchText changes for affected entries → search_text/entry_json churn on next reindex.

**Files.**
- `src/indexer/passes/metadata.ts`
- `tests/metadata.test.ts`
- `tests/ranking-regression.test.ts (assert/adjust)`
- `src/assets/stash-skeleton/facts/conventions/organization.md (follow-up: soften footgun bullet AFTER task #5 lands)`
- `docs/architecture/specs/stash-organization-conventions.md (strike the intake item)`

**Contracts & stability.** No DB schema change (tags live in entry_json + FTS). R5 canary coordination REQUIRED: search-fields.ts:27-32 NOTE — changing tag content shifts collapse-detector recall baselines for existing canary sets; CHANGELOG must tell operators to re-mint via `akm improve canary --refresh`. Embeddings do NOT auto-regenerate on search_text change (db.ts:1561-1568 embeds only entries lacking a row) — drift is small here (duplicated name tokens) but note it.

**Test plan.** tests/metadata.test.ts: (1) nested asset memories/projectA/auth-tip.md with explicit `tags: [auth]` → tags contain both 'auth' and 'projecta'; (2) root-level asset with explicit tags unchanged (pins the existing package.json-keywords assertion at :262-270, ['git','diff'] stays exact); (3) empty-tags nested asset unchanged vs today on the generateMetadata path; (4) flat-walk (generateMetadataFlat) nested asset now carries dir tokens; (5) author restating the token → deduped once. Ranking: extend tests/ranking-regression.test.ts or tests/ranking-contributor-ablation.test.ts with a scoped-memory-with-explicit-tags case asserting the tag boost fires for the path token.

**Risks.** One-time index churn for every nested asset with explicit tags; canary re-mint burden on existing installs; the just-finalized convention text documents the OLD behavior ('you lose the tag-match ranking boost') — the follow-up doc edit must land in the same release or the injected fact teaches a stale model; multi-word dir segments (client-x) become two tags ('client','x'→'client' only, x dropped) — acceptable, matches existing tokenization.

### SPEC-3 — --xref on akm remember and akm import with write-time ref resolution (+ type-root placement hint)

**Priority:** P1 · **Sizing:** M — three command files, frontmatter merge logic on import, validation plumbing, and a wide test surface.

**Problem.** The conventions make one xref mandatory for derived assets, but neither CLI write flow can express xrefs: `akm remember` always generates its own frontmatter block (buildMemoryFrontmatter, remember.ts:87-117) and prepends it to the body (remember-cli.ts:149-165, 241-253) — agent-supplied frontmatter would nest and be ignored by parseFrontmatter; `akm import` (stash-cli.ts:169-223) writes content verbatim with no xref channel. There is also no write-time check that a cited ref resolves — a typo'd provenance ref becomes permanent silent noise in FTS hints.

**Convention rule served.** backlinks.md provenance rule ('cite the source ref... it also makes this asset findable from searches for its source') and the ~5 cap heuristic; mechanics: xrefs frontmatter folds into FTS hints for all md types via applyWikiFrontmatter (metadata.ts:609-626, called for all non-secret .md at :1064) — verified, so no indexer change is needed.

**Design.** remember: add repeatable `--xref <ref>` collected via parseAllFlagValues("--xref") (existing pattern at remember-cli.ts:130). Extend MemoryFrontmatterFields and buildMemoryFrontmatter (src/commands/remember.ts:34-117) with `xrefs?: string[]` serialized as a YAML list (serializeFrontmatter already handles arrays). Validation before any write: for each xref, split type:name, resolve via refToRelPath + refExistsInAnyStash imported from ../lint/base-linter (cross-command import precedent: improve/preparation.ts:23, contribute-cli.ts:33) against [writeTarget.source.path, ...resolveSourceEntries(stashRoot, cfg) roots] (mirror lint/index.ts:106-109); any unresolvable ref → UsageError (exit 2, {ok:false,error,code} envelope) listing the bad refs with hint 'akm search "<slug>" --type <type>'. More than 5 xrefs → stderr warn only (SOFT cap stays soft). --xref counts as structured metadata (hasStructuredArgs) but does NOT trigger the tags-required check. import: same flag on importKnowledgeCommand (src/commands/sources/stash-cli.ts:169); since imported docs may carry their own frontmatter, merge BEFORE writeMarkdownAsset: parseFrontmatter(content) → dedupe-append xrefs → assembleAsset(data, body) (src/core/asset/asset-serialize.ts:62), so write-path indexing (knowledge.ts:192 indexWrittenAssets) sees final content. Placement hint (surfaces the conventions to CLI writers, who never receive resolveStashStandards injection): when the asset lands at the type root (no --path and the final name has no '/') and resolveStashStandards(source.path) returns non-empty, add additive JSON output key `hint: "Wrote to the <type> root. This stash has placement conventions — see akm show fact:conventions/organization"` (parallel to search's existing `tip` key). No write-target branching added anywhere — frontmatter assembly happens before writeAssetToSource, honoring the src/core/write-source.ts boundary.

**Files.**
- `src/commands/read/remember-cli.ts`
- `src/commands/remember.ts`
- `src/commands/sources/stash-cli.ts`
- `src/commands/read/knowledge.ts (only if the hint is computed inside writeMarkdownAsset; otherwise untouched)`
- `tests/remember-frontmatter.test.ts`
- `tests/remember-unit.test.ts`
- `tests/commands/remember.test.ts`
- `tests/commands/import.test.ts`
- `docs/reference/cli.md`

**Contracts & stability.** remember/import are Stable write commands (STABILITY.md) — new flags and a new top-level output key are additive; failure path uses the standard UsageError → exit 2 envelope. CLI-surface contract test (tests/contracts/v1-spec-section-9-4-cli-surface.test.ts) pins command NAMES only — unaffected. docs/reference/cli.md needs the flag rows.

**Test plan.** (1) remember --xref with resolvable ref → frontmatter contains xrefs list; subsequent `akm search <source-slug>` returns the new memory (hints fold verified end-to-end); (2) unresolvable --xref → exit 2, {ok:false,error,code}, nothing written; (3) six xrefs → warn on stderr, still writes; (4) import --xref onto a doc WITH existing frontmatter → merged, no duplicate keys, body intact; (5) import --xref onto frontmatter-less doc → block added; (6) type-root write with convention facts present → hint key emitted; with --path → no hint; on a skeleton-less stash → no hint; (7) envelope tests via tests/commands/*-envelope patterns.

**Risks.** Hard-fail validation on a SOFT-convention channel: justified as input validation of an explicitly passed flag (precedent: --target rejects unknown source names), not convention enforcement — an agent that wants an unchecked ref can put it in the body. The commands/read → commands/lint import is established but slightly smelly; do NOT relocate refToRelPath/refExistsInAnyStash now (the contract test and akm-plugins sister pin the base-linter path); a later core/ extraction must move both contract tests in lockstep. Hint key adds minor output noise for scripted consumers — additive key, documented.

### SPEC-4 — Real ref-prefix filter: akm search "<type>:<prefix>/" translates to typed enumeration with name-prefix narrowing

**Priority:** P1 · **Sizing:** M — parser is trivial; the enumerate-path refactor plus doc/consistency coordination is the bulk.

**Problem.** The idiom the conventions were originally written around does not exist: sanitizeFtsQuery (src/indexer/search/fts-query.ts:21-35) strips ':' and '/', and entry_type is not an FTS column, so `akm search "memory:projectA/"` degenerates to the AND-query 'memory projectA' (noise). Task #5 ships docs stating the negative; the finalized open-questions intake item 1 asks to make the natural idiom real: 'Detect type:prefix/-shaped queries in search and translate to entry_type + entry_key LIKE'.

**Convention rule served.** Design-doc open-questions intake: 'Ref-prefix filter in code... making the natural idiom real (today it returns nothing)'; also restores deterministic subtree reconstruction for scope-born types (organization.md's 'akm search "projectA" --type memory' matches stray projectA tokens anywhere in name/tags/hints — prefix filtering is exact).

**Design.** New pure helper in src/indexer/search/fts-query.ts: `parseRefPrefixQuery(query: string, knownTypes: readonly string[]): { type: string; namePrefix: string } | null`. Match rules (conservative): trimmed query must be exactly `<known-type>:` (namePrefix '') or `<known-type>:<prefix>/` — trailing slash REQUIRED for a non-empty prefix so bare refs like `memory:a/b` stay ordinary searches (that's `akm show` territory); type validated against getAssetTypes() (src/core/asset/asset-spec.ts) passed in by the caller to keep fts-query dependency-free. In searchDatabase (src/indexer/search/db-search.ts:280), before the hasSearchableTokens branch (:302) and only when `searchType === "any"` (an explicit --type flag wins): if parsed, take the existing empty-query enumerate path (:314-366) with typeFilter = parsed.type plus a new predicate `ie.entry.name.startsWith(parsed.namePrefix)` — refactor that block into a shared `enumerateEntries(opts)` helper with an optional namePrefix. getAllEntries (db.ts:904) already supports typed enumeration; in-memory prefix filtering is fine at stash scale (an entry_key LIKE SQL push-down is a later optimization — entry_key is `${stashDir}:${type}:${name}` per index-written-assets.ts:88, so LIKE needs care with stashDir colons). Downstream source/scope/quality/belief filters, dedupe, and limit reuse unchanged; hits carry score 1, mode 'keyword'. Registry search path untouched.

**Files.**
- `src/indexer/search/fts-query.ts`
- `src/indexer/search/db-search.ts`
- `tests/fts-query.test.ts`
- `tests/db-scoring.test.ts or new tests/search-ref-prefix.test.ts`
- `docs/guides/concepts.md (amend the just-applied negative parenthetical)`
- `docs/architecture/specs/stash-organization-conventions.md (Review-round note + strike intake item)`
- `CHANGELOG.md`

**Contracts & stability.** akm search is Stable: this changes results for a query shape that today returns noise — additive in spirit but MUST get a CHANGELOG callout. The v1 §6 orchestration contract ('search consults the local FTS index; one query path') is respected — the enumerate path already exists and is index-backed. CRITICAL coordination with task #5: concepts.md will say 'There is no ref-prefix query syntax' and the docConsistency sweep greps for the dead idiom family — after this ships those exact sentences must flip to positive statements in the SAME PR, and the sweep's whitelist updated; convention facts may then re-adopt the idiom in a later doc pass (do not churn them immediately).

**Test plan.** fts-query unit: known type + trailing slash parses; no trailing slash → null; unknown type → null; bare `wiki:` → {type:'wiki', namePrefix:''}; whitespace tolerance. Integration (sandboxed stash + index): `memory:projectA/` returns exactly the projectA subtree and nothing else; `memory:` equals `--type memory` enumeration; explicit `--type knowledge` + query `memory:a/` does NOT trigger the branch; session exclusion irrelevant (typed path); scope/belief/source filters compose; empty subtree → hits [] with the standard tip.

**Risks.** curate's LLM-generated queries can now hit the branch — acceptable (deterministic subtree listing is strictly better than token noise). A user literally searching for the string 'memory:x/' loses fuzzy behavior — accepted, negligible. Enumeration ranking is insertion-ordered with score 1 (no utility ranking) — matches the existing empty-query contract; document it.

### SPEC-5 — --supersedes on remember/import: atomic correction + demotion of the superseded asset

**Priority:** P1 · **Sizing:** S — one ~15-line helper mirroring writeContradictEdge, flag plumbing shared with SPEC-3, plus tests.

**Problem.** The finalized corrections pattern requires TWO writes: the new correction asset (with an xref to what it corrects) AND a metadata edit on the old asset (beliefState: superseded, supersededBy: [<new ref>]) so the ranker demotes the stale incumbent (beliefStateBoost -0.25, ranking-contributors.ts:107-123, fires for ANY flagged type). Today only improve's LLM flows write belief edges (writeContradictEdge, memory-belief.ts:59-73); an agent following the convention must hand-edit the old file's frontmatter and remember to reindex it. The finalized open-questions intake names 'Automate correction demotion' explicitly.

**Convention rule served.** backlinks.md corrections bullet ('also set the old asset's beliefState: superseded and supersededBy: [<new ref>] — a metadata edit, not a content edit — so the ranker demotes the stale version') + fact.md mirror clause + intake item 'Automate correction demotion. curate/improve could set beliefState: superseded on the old asset when a correction cites it' (an explicit CLI flag is the deterministic version of that automation).

**Design.** Add `--supersedes <ref>` (repeatable) to rememberCommand and importKnowledgeCommand. Flow: (1) validate each ref resolves (SPEC-3's resolver plumbing) and locate the target file; (2) require the file to live under the resolved WRITE TARGET's source.path (or the primary stash) — honoring the 'improve/lint only operate on writable sources' constraint; a match in a read-only extra root → stderr warn, new asset still written, JSON reports `superseded: [{ref, applied: false, reason}]`; (3) fold the superseded refs into the new asset's xrefs list automatically (correction provenance per the convention); (4) after writing the new asset, call new helper `writeSupersededEdge(filePath, supersededByRef)` — sibling of writeContradictEdge in src/commands/improve/memory/memory-belief.ts, built on mutateFrontmatter (src/core/asset/frontmatter.ts:143), idempotent, sets beliefState: 'superseded' and sorted-set-appends supersededBy; (5) reindex the mutated old file via indexWrittenAssets(source.path, [oldPath]) so demotion is immediately live (write-path indexing is the writer's job, knowledge.ts:190-192); (6) order the mutation BEFORE commitWriteTargetBoundary so git targets batch both files in one commit (knowledge.ts:189). Indexer support verified pre-existing: applyCuratedFrontmatter parses beliefState/supersededBy for all md types (metadata.ts:488-492); `--belief current` filtering already excludes superseded.

**Files.**
- `src/commands/read/remember-cli.ts`
- `src/commands/sources/stash-cli.ts`
- `src/commands/improve/memory/memory-belief.ts`
- `src/commands/read/knowledge.ts (only for commit-boundary ordering if the mutation is done inside the write path)`
- `tests/commands/remember.test.ts`
- `tests/commands/import.test.ts`
- `tests/belief-state-phase1a.test.ts (assert no regression)`

**Contracts & stability.** Stable write commands — additive flags; new optional `superseded` JSON output key is additive. Does not touch the Experimental 'memory belief-state transitions' algorithm surface (it reuses the existing states verbatim). No write-target branching added — mutateFrontmatter edits a file in place under an already-resolved writable source.

**Test plan.** (1) remember --supersedes memory:projectA/old → old file frontmatter gains beliefState: superseded + supersededBy: [memory:...new]; subsequent search ranks new above old; --belief current hides old; (2) idempotent re-run (same supersededBy entry not duplicated); (3) unresolvable ref → exit 2, nothing written; (4) old asset in read-only source → new asset written, applied:false reported; (5) new asset's xrefs include the superseded ref; (6) git write target: single batch commit contains both files.

**Risks.** A write command mutating a SECOND file is new for remember/import — scoped strictly to metadata via the established mutateFrontmatter primitive; must not clobber unrelated frontmatter (mutateFrontmatter preserves other keys). Superseding a knowledge doc that is itself heavily cited leaves citers pointing at a demoted asset — correct per the convention (history preserved, demoted not deleted). Crash between write and mutation leaves the correction un-demoted — lint (SPEC-1) plus re-run idempotence make this recoverable.

### SPEC-6 — Capture fact category into the index and demote category:convention facts at rank time

**Priority:** P2 · **Sizing:** S — capture + one contributor + tests; the real cost is deciding the constant with eval data.

**Problem.** Convention facts are delivered by prompt injection (resolveStashStandards selects by category, :24,71-107), yet they also compete in untyped search: their name/description/when_to_use tokens match domain-term queries via prefix expansion (buildPrefixQuery, fts-query.ts:44-58) and carry the fact TYPE_BOOST 0.22 (ranking-contributors.ts:11-22). Verified blocker: `category` is NOT captured onto StashEntry at all today (no mention in metadata.ts) — only FactLinter reads it from raw frontmatter — so neither demotion nor exclusion is currently implementable without a capture change.

**Convention rule served.** Design-doc open-questions intake: 'Convention facts crowd domain-term queries... consider excluding category: convention facts from default untyped search (their delivery channel is prompt injection, parallel to the session default exclusion) or demoting the category at rank time.'

**Design.** Two steps. (1) Capture: add `category?: string` to StashEntry (src/indexer/passes/metadata.ts, interface near :113), read it in applyCuratedFrontmatter (`asNonEmptyString(fmData.category)`, alongside beliefState at :488) and whitelist it in the coerceEntry function (:280-398 region, mirroring beliefState at :342-344). entry_json-only — no DB migration. (2) Rank: new `conventionFactRankingContributor` in src/indexer/search/ranking-contributors.ts — appliesTo: entry.type === 'fact' && entry.category === 'convention'; adjust: -0.25 (nets the fact TYPE_BOOST 0.22 to ~-0.03, i.e. convention facts rank like an unboosted asset instead of knowledge-tier). `category: meta` facts NOT demoted (active-projects canon must surface — SPEC-alignment with domains.md's 'category: meta fact' home for slug canon). Demotion chosen over default-exclusion: exclusion on a Stable read surface silently hides results and the existing opt-back-in (`--include-sessions`, db-search.ts:308-309) is TYPE-keyed, not category-keyed — a parallel category mechanism would grow flag surface for a hypothesized problem. Exact-name boost (+2.0) and `--type fact` keep the facts fully reachable when wanted.

**Files.**
- `src/indexer/passes/metadata.ts`
- `src/indexer/search/ranking-contributors.ts`
- `tests/ranking-contributor-ablation.test.ts`
- `tests/fact-asset.test.ts`
- `tests/metadata.test.ts`

**Contracts & stability.** Search Stable surface: ordering shift only for convention facts on untyped queries — CHANGELOG note. Requires a reindex to take effect (entry_json) — note in CHANGELOG. No output-shape change. Collapse-detector canaries unaffected (FTS text unchanged — this is rank-time only).

**Test plan.** (1) metadata: fact with category: convention → entry.category captured; roundtrip through coerceEntry; (2) ablation test: untyped 'auth' query over a fixture with knowledge:auth/x and fact:conventions/backlinks → knowledge ranks first; contributor absent → previous order (pins the delta); (3) exact-name query 'backlinks' still surfaces the fact top-3; (4) --type fact ordering among facts unchanged relative to each other except convention-vs-meta.

**Risks.** Demotes user-authored convention facts they might genuinely search for — mitigated by exact-name and typed search; magnitude (-0.25) is a guess pending measurement — land AFTER a curate-golden measurement run (curate-golden-eval.test.ts) confirms crowding is real; if it isn't, drop this spec entirely (it is the most speculative of the intake items).

### SPEC-7 — akm mv: rename with inbound-xref rewrite and utility-history preservation

**Priority:** P2 · **Sizing:** L — new verb, FS+DB coordination, contract/spec/doc updates, wide test matrix.

**Problem.** The conventions' forced-rename procedure ('grep and fix inbound xrefs in the same pass') is agent-executable EXCEPT for the part only the CLI can do: a rename mints a new entries row (entry_key UNIQUE, schema.ts:96; entry_key = `${stashDir}:${type}:${name}`, index-written-assets.ts:88) which orphans utility_scores / utility_scores_scoped rows keyed by entry_id (schema.ts:175-199) plus embeddings and salience — the verified 'rename resets learned ranking' cost the review added to the no-rename rule. Rename assistance is a mandatory-candidate #4 example.

**Convention rule served.** organization.md 'A ref is chosen once. Default to not renaming... a renamed file is a new index entry, so the asset's accumulated usage-ranking history resets' + headline rule 'if forced, grep and fix inbound xrefs in the same pass'.

**Design.** New top-level verb `akm mv <ref> <new-name>` (new src/commands/mv-cli.ts registered in src/cli.ts subCommands :540-579). Scope v1 to md asset types resolvable by refToRelPath, primary writable stash only (improve/lint constraint); wiki refs rejected (wiki has its own xref+lint system); memory refs move the `.derived.md` twin together (twin coupling pinned at db.ts:384-409 — entry_key suffix relation must survive). Steps: (1) resolve old ref → absolute path (refToRelPath + existence, base-linter helpers); (2) compute new path via resolveAssetPathFromName, guard isWithin(typeRoot) + target-not-exists; (3) fs.rename (and twin); (4) inbound rewrite across the writable stash's md files (reuse collectMarkdownFiles pattern from lint/index.ts:65): replace old-ref occurrences in body AND frontmatter ref-list keys (xrefs/refs/supersededBy/contradictedBy/source_refs/currentBeliefRefs) using REF_RE-style boundary matching; rewrite inside fenced blocks too (a rename must not leave stale examples); read-only sources are scanned but NOT written — their citing files are reported as manual follow-ups; (5) index re-key in place: UPDATE entries SET entry_key/file_path/dir_path/entry_json(name)/search_text WHERE id = <old id> — preserving id keeps utility_scores, utility_scores_scoped, embeddings, and asset_salience attached; mark FTS-dirty for the row; then indexWrittenAssets for every rewritten citer; (6) JSON report {ok, from, to, rewrote:[{file,count}], readOnlyCiters:[], utilityPreserved:true}; standard error envelope + exit codes on failure; appendEvent eventType 'mv'.

**Files.**
- `src/commands/mv-cli.ts (new)`
- `src/cli.ts`
- `src/indexer/db/db.ts (re-key helper)`
- `src/commands/lint/base-linter.ts (import-only reuse)`
- `tests/commands/mv.test.ts (new)`
- `docs/technical/v1-architecture-spec.md (§9.4)`
- `tests/contracts/v1-spec-section-9-4-cli-surface.test.ts (additive command entry)`
- `docs/reference/cli.md`
- `STABILITY.md (list as Experimental)`

**Contracts & stability.** HEAVIEST contract footprint of the set: §9.4 declares the command surface exhaustive, so adding `mv` requires the spec doc §9.4 edit + the contract test's command list (additive — the test only asserts presence, but the doc freeze is the governance step). Ship as Experimental in STABILITY.md. ref-resolver contract untouched (read-only reuse).

**Test plan.** (1) e2e: move memory:projectA/old-name → memory:projectA/new-name with two citers (one body ref, one xrefs entry) → both rewritten; `akm lint` reports zero missing-ref afterward (SPEC-1 synergy); (2) utility preservation: record usage events pre-move (bumpUtilityScoresBatch path), assert post-move search still applies the utility boost to the moved asset (patterns in tests/coverage-hardening/db-utility-usage.test.ts); (3) .derived twin moves and stays belief-linked; (4) target-exists → exit 2, nothing moved; (5) read-only citer reported, not mutated; (6) fenced-block occurrence rewritten.

**Risks.** Partial-failure atomicity (rename applied, rewrite interrupted) — mitigate by ordering: compute full rewrite plan first, apply file edits, rename last, re-key index last; still not transactional across FS+DB — document and make re-runnable. Graph tables key extractions by file path (graph_files) — stale until next graph pass; acceptable (graph is a derived cache). Highest-effort, lowest-frequency operation of the set — hence P2 despite high per-use value; sequence last.

### SPEC-8 — Config-gated indexing of the self-situating body opening

**Priority:** P2 · **Sizing:** M — extraction + fold are small; config/schema/contract/canary coordination dominates.

**Problem.** Body prose is not FTS/embedding-indexed (content column = TOC headings + parameters only, search-fields.ts:63-73; embeddings built from the same field string via buildSearchText :83-88), so the conventions route orientation into description:/when_to_use:. The intake keeps the complementary code change open: 'Surface the first body paragraph into an indexed field (or embed body openings) so orientation prose pays retrieval rent.'

**Convention rule served.** Design-doc open-questions intake item 'Index self-situating body text'; backlinks.md self-situating section (body header currently serves only the entity graph and human readers).

**Design.** Minimal, gated: (1) metadata pass — in buildEntryFromFile's md branch (metadata.ts:1056-1072), extract the first non-heading, non-fence, non-empty paragraph of parsed.content, capped at 280 chars, into new StashEntry field `bodyOpening?: string` (skip secrets/env by existing guards; skip session-kind memories via the akm_memory_kind marker already recognized in base-linter patterns); (2) search fold — append bodyOpening to the `content` field (lowest bm25 weight 1.0) in buildSearchFields (search-fields.ts:63-73), NOT hints (hints carries xrefs/when_to_use and feeds no per-entry cap logic; content is the designated catch-all); (3) gate behind config `index.indexBodyOpening` (default false initially) because two verified costs trigger on ANY buildSearchFields change: the R5 collapse-detector canary baselines shift (search-fields.ts:27-32 — operators must `akm improve canary --refresh`), and embeddings do NOT regenerate for existing entries (db.ts:1561-1568 embeds only rows lacking an embedding) so semantic installs need an explicit purge/re-embed (purge helper exists at db.ts:176-189). Flip the default in a later minor once re-mint tooling and CHANGELOG guidance exist. Guardrail: this makes body headers ALSO pay rent — the shipped convention's description:/when_to_use: routing remains primary; do not re-teach body-only orientation.

**Files.**
- `src/indexer/passes/metadata.ts`
- `src/indexer/search/search-fields.ts`
- `src/core/config/config.ts (config key + schema)`
- `schemas/ (config schema, via tests/contracts/config-schema-drift.test.ts expectations)`
- `tests/metadata.test.ts`
- `tests/fts-field-weighting.test.ts`

**Contracts & stability.** config-schema-drift contract test must be updated with the new key (it pins the schema). Search Stable surface: results change only when the flag is on. Canary + embedding coordination as described — the CHANGELOG entry is part of the deliverable.

**Test plan.** (1) extraction unit tests: heading-first bodies, fenced-first bodies, frontmatter-only files, 280-char cap, session memories skipped; (2) flag off → buildSearchFields byte-identical to today (pins the default); (3) flag on → FTS query matching an orientation-only phrase returns the asset via the content column; (4) fts-field-weighting test asserts name-match still outranks body-opening-match.

**Risks.** Index size growth (bounded by cap); stale-embedding drift when the flag is toggled without purge — emit a warning from `akm index` when the flag state differs from the indexed state (store a meta key, pattern: setMeta 'hasEmbeddings' indexer.ts:375); most speculative retrieval win of the set — keep default-off until eval evidence (curate goldens) shows lift.

## Sequencing

Recommended order: SPEC-1 → SPEC-2 → SPEC-3 → SPEC-5 → SPEC-4 → SPEC-6 → SPEC-8 → SPEC-7. Rationale: SPEC-1 first — it is the P0 with zero behavioral risk (lint-only, additive findings), it makes the conventions' central warning actionable immediately, and it establishes the resolver-reuse pattern SPEC-3/5 build on; it also becomes the verification tool for everything later (SPEC-7's rewrites are checked by it). SPEC-2 second — tiny code change, but schedule its convention-text follow-up (softening the footgun bullet) AFTER task #5's apply pass lands so the same file isn't churned twice, and bundle the canary re-mint CHANGELOG note. SPEC-3 then SPEC-5 as one arc — SPEC-5 reuses SPEC-3's flag plumbing and validation helper, and together they ship the complete convention loop (provenance at write time + corrections with demotion) that agents currently cannot execute through the CLI at all. SPEC-4 after task #5 is fully verified — it must amend the exact negative sentences task #5 just wrote into concepts.md and the design doc, so sequencing it earlier guarantees doc churn and docConsistency-sweep conflicts; it is independent of all other specs code-wise. SPEC-6 only after a measurement pass (curate goldens) confirms convention-fact crowding is real — it is the most speculative item and its demotion constant should be eval-derived, not guessed. SPEC-8 after SPEC-6's capture groundwork and once canary re-mint guidance exists (it shares the R5/embedding coordination burden and is default-off anyway). SPEC-7 last — largest effort, heaviest contract/governance footprint (§9.4 surface freeze), lowest frequency of use, and it benefits from SPEC-1 (verification) and SPEC-4 (subtree enumeration for pre/post-move checks) already being in place.

## Open questions

- SPEC-4 syntax scope: should `type:prefix` WITHOUT a trailing slash also enumerate (chosen: no — it collides with exact refs, which belong to `akm show`), and should the branch fire when --type is also passed and agrees (chosen: explicit flag wins, branch fires only on searchType 'any')? Maintainer confirmation wanted before pinning tests.
- SPEC-3 failure mode: hard-fail (exit 2) on an unresolvable --xref was chosen as input validation; if maintainers prefer fail-open for SOFT-convention consistency, the alternative is stderr warn + write anyway — decide before the flag ships since flipping later is a behavior change on a Stable command.
- Embedding staleness policy: upsertEntry does not invalidate an existing embedding when search_text changes (db.ts:1561-1568 only embeds rows lacking one), which SPEC-2 mildly and SPEC-8 seriously depend on — is a general 'search_text hash → re-embed' invalidation (delete embedding row on changed hash) worth a standalone fix ahead of SPEC-8?
- SPEC-7 governance: is adding a verb to the §9.4 'exhaustive' surface acceptable pre-1.0 as an Experimental-tier addition, or should rename assistance ship as a subcommand of an existing noun group to dodge the freeze? The contract test itself is additive-safe; the freeze is a documentation/governance question.
- SPEC-2 scope: the merge is spec'd for file-derived entries via buildEntryFromFile only; entries declared in .stash.json (loadStashFile path) keep their literal tags — confirm that is intended (they are hand-curated manifests).
- Post-SPEC-4 convention-text re-adoption: once the ref-prefix idiom is real, should the skeleton convention facts switch back from `akm search "<slug>" --type <type>` to the prefix idiom (a second doc churn of the files task #5 just rewrote), or should both idioms be documented? Recommend deferring one full release to avoid teaching an idiom older CLI versions don't support.
- SPEC-6 predicate breadth: demote only category: convention, or also category: meta? Spec'd as convention-only (meta facts like active-projects canon should surface in search); flag for review since domains.md now tells agents to keep slug canon in a meta fact partly BECAUSE it is retrievable.
