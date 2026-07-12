# Design: stash organization & back-linking conventions

Status: accepted (conventions shipped in the stash skeleton)
Author: akm
Date: 2026-07-11

## Problem

The stash skeleton already ships per-type authoring conventions
(`facts/conventions/assets/<type>.md`) that tell an agent **how to write** each
asset type. Nothing told an agent **where to place** an asset (which
subdirectory) or **how to cross-link** it. Yet placement and linking are exactly
what determine whether the same knowledge is *retrievable* two sessions later, or
re-derived from scratch — and whether cross-project reuse happens or duplicates
accumulate.

The request that drove this: define conventions that instruct agents how to
organize assets under their type directories (subdirectories for projects,
domains, etc.) and how to back-link them to improve retrieval during agentic
tasks. This document records the analysis, a structured debate, and the resulting
conventions.

## What AKM's mechanics dictate (the ground truth)

Any organization scheme has to fit how AKM actually stores and retrieves. The
load-bearing facts, each verified in code:

1. **Path becomes the ref.** A file's subpath under its type dir is part of its
   ref name — `memories/projectA/auth-tip.md` → `memory:projectA/auth-tip`. Works
   for every type. A ref-prefix query syntax exists since SPEC-4 landed
   (amended 2026-07-11): `akm search "memory:projectA/"` enumerates exactly
   that subtree (typed, recursive, `/`-boundary exact) and a bare `memory:`
   enumerates the whole type. At review time the idiom was false —
   `sanitizeFtsQuery` strips `:` and `/` and `entry_type` is not an FTS
   column, so the query degenerated to token noise (empirically tested; see
   the Review round). `akm search "projectA" --type memory` remains the
   token-match alternative. The path is
   therefore the one facet you cannot express twice and cannot change without
   breaking the ref (and every inbound reference to it).
2. **Retrieval is search, not browse — and folders are highly visible to the
   ranker.** There is no folder walk at query time — agents `akm search`/
   `akm curate`, then `akm show <ref>`. A subdirectory's real payoff: its tokens
   join the FTS `name` column at the highest bm25 weight (10.0), always merge
   into `tags` (since SPEC-2 landed; see fact 6), and match the cwd
   project-context boost (`projectContextRankingContributor`, +0.2/token,
   cap 0.5). No "indexing-confidence bump" for subdirectories exists in code.
3. **The FTS surface is `name`, `description`, `tags`, `hints`, `content`**
   (`entries_fts`, `src/indexer/db/schema.ts`). There is **no `project` field** —
   a bare `project:` frontmatter value is invisible to search. Off-axis facets
   must be `tags` to be retrievable.
4. **`xrefs:` fold into the FTS `hints` field for all types**
   (`src/indexer/search/search-fields.ts:58`). Back-links are a *retrieval*
   signal, not decoration — which means both too few and too many degrade
   ranking.
5. **Project relevance is recovered at query time.** Ranking blends
   a per-project usage signal — `scopedUtility * 0.7 + globalUtility * 0.3`
   (`SCOPED_UTILITY_BLEND_SCOPED`, `src/indexer/search/ranking-contributors.ts`),
   keyed by a cwd-anchor (a hash of the querying project root), not the asset's
   path. It is NOT rename-proof for the asset: `entry_key` includes the full
   name, so renaming a file mints a new entry row and orphans its accumulated
   global + scoped utility history — unless the rename goes through `akm mv`
   (SPEC-7, Experimental; amended 2026-07-12), which re-keys the index row in
   place so the id-keyed utility/embedding/salience history survives. A
   reusable asset does not need the *project* baked into its path to rank well
   inside a project — and a manual rename costs learned ranking.
6. **Directory (scope/domain) tokens always merge into `tags`** — since SPEC-2
   landed (`extractDirTagsFromName`, `src/indexer/passes/metadata.ts`) they are
   derived from the canonical ref subpath, so explicit `tags` no longer
   suppress the scope token, both indexing walks agree, and the exact-tag
   ranking boost fires for the path token without restating it. Filename
   tokens are still auto-derived only when `tags` is empty (they already live
   in the FTS `name` column and in aliases). The old explicit-tags footgun is
   gone; existing installs pick the merged tags up on the next reindex.
7. **The entity/relation graph boost extracts from body content, not the path**
   (`graph-extraction.ts`). Canonical entity naming must live in the prose.
8. **`category: convention|meta` facts are surfaced to every non-wiki authoring
   flow** (`resolveStashStandards`); `facts/conventions/assets/<type>.md` is
   surfaced type-scoped (`resolveTypeConventions`). This is the only channel that
   reaches a browse-blind agent mid-task — so conventions must ship as facts.
9. **Non-wiki xref breakage is caught by `akm lint`, not at write time.** The
   deterministic `missing-ref` check covers body refs, the `refs:` frontmatter
   array, and (since SPEC-1 landed) the `xrefs:`/`supersededBy:`/
   `contradictedBy:` frontmatter channels. A *manual* rename still dangles
   non-wiki inbound links silently — nothing catches them until the next
   `akm lint` run flags them; since SPEC-7 landed (amended 2026-07-12),
   `akm mv` rewrites inbound refs across the writable stash in the same pass
   as the move. Wikis are excluded from `akm lint` and instead get their own
   orphan/broken-xref/broken-source/stale-index/uncited-raw checks via
   `akm wiki lint`.

## Research inputs

Three parallel research briefs (Karpathy's LLM wiki; agent memory / RAG /
GraphRAG; PKM taxonomies — Zettelkasten, PARA, Johnny.Decimal) converged on a few
transferable principles:

- **Separate raw from synthesized, and keep raw immutable.** Karpathy's core
  invariant: interpret and correct in a synthesized layer that *cites* the raw
  source; never edit the source. Gives every claim an auditable provenance chain.
- **The index is the catalog — don't hand-maintain one.** Karpathy's `index.md`
  exists because a filesystem has no ranker. AKM already has one (plus a utility
  signal), so effort should go into per-asset *retrievability* (strong title,
  accurate first paragraph, tags, xrefs), not a hand-kept catalog.
- **Metadata/facets beat folder depth for retrieval.** The literature repeatedly
  measures metadata-enriched and "contextual"/self-situating retrieval as
  materially better (e.g. contextual headers cutting failed retrievals by a large
  margin) — because the reader is a ranker, not a browser.
- **Atomicity + sparse, real links (Zettelkasten), not dense mandatory links.**
  Backlinks help multi-hop recall, but forced density produces junk edges.
- **Controlled vocabulary prevents bucket drift**, but deep hierarchies and
  opaque codes (Johnny.Decimal) fail when nobody browses.

## The debate

Four positions were argued and adversarially critiqued:

| Position | Thesis | Verdict |
|---|---|---|
| **Domain-first taxonomy** | Path = stable subject domain; lowest rename rate, highest lexical signal. | reject-keep-ideas |
| **Scope-first namespacing** | Path = project/client/team; scope is the dominant retrieval filter. | reject-keep-ideas |
| **Flat + faceted + dense backlinks** | Minimal folders; organizing signal lives in frontmatter + a dense link graph the index can read. | adopt-with-changes |
| **Hybrid "narrowest stable scope" ladder** | One folder = the narrowest stable boundary (client > project > domain > root), rest in facets. | adopt-with-changes |

The critiques were decisive:

- **A single global axis fails both ways.** Domain-first makes project scope
  invisible (no `project` FTS field; agents that write `project:` frontmatter get
  zero retrieval benefit) and splits "everything about project A's auth" across
  three query idioms. Scope-first strands reusable assets behind an arbitrary
  project home and creates a `shared/` dumping ground.
- **The per-asset "narrowest scope" ladder is non-deterministic.** Two agents run
  the delete/archive test on equivalent insights and pick different rungs,
  fragmenting a topic across `memory:projectA/` and `knowledge/auth/` with no
  reconciliation pass — and the wrong guess is baked into an immutable ref.
- **Mandatory dense xrefs actively hurt.** Because ref strings fold into the FTS
  `hints` field, a link quota smears a popular source's ref token across dozens of
  citers (destroying its ranking signal) and fills the entity graph with
  plausible-but-wrong edges.
- **Per-namespace hub wikis rot.** As an obligation they contend on concurrent
  writes, generate stale-index lint noise, and flatten the multi-hop graph into a
  namespace-wide star.

## Decision

**Resolve the project-vs-domain tension by asset TYPE, not per-asset judgment.**
This is the one rule that is both deterministic mid-task and mechanically
justified:

- **Scope-born types** (`memory`, `lesson`, `task`, `env`, `secret`) → the
  current **project/client** slug. They are born bound to the work in front of
  the agent, so the working context *is* the answer — zero counterfactual
  reasoning, and `akm search "projectA" --type memory` reconstructs the project.
- **Reuse-born types** (`knowledge`, `skill`, `wiki`, `fact`, `script`) → a
  stable **domain** from a short closed vocabulary. Project relevance is already
  recovered by scoped-utility ranking (fact 5), so spending the path on the
  project axis is redundant; the domain prefix is the only handle that
  co-locates cross-project reuse. For a wiki, the domain names the wiki itself.
- **Global-by-nature types** (`command`, `agent`, `workflow`, stash-wide `env`) →
  type root or a tool slug.

Supporting rules, all shipped as convention facts:

- One path axis; depth 1 (2 max for strict containment); lowercase-hyphen
  semantic segments; **no volatile facets in the path** (status/date/version/…);
  flat type-root fallback instead of inventing a one-off domain.
- Off-axis facets go in `tags` (never a bare `project:` field); the path
  scope/domain token merges into `tags` automatically, so it never needs
  restating (fact 6).
- **A provenance xref is mandatory when the asset derives from another** (never
  invented for original observations). Associative xrefs are discretionary and
  capped (~5, a heuristic). Corrections are new assets that xref what they
  correct, paired with `beliefState: superseded`/`supersededBy` on the stale
  asset; immutability applies to ingested material (wiki `raw/`, vendored docs,
  transcripts) — synthesized knowledge pages are the rewritable layer (Karpathy
  immutability inside AKM's flat model).
- **Self-situating text on every asset** — the orientation line goes in
  `description:`/`when_to_use:` (the indexed fields; body prose is NOT indexed —
  FTS `content` is TOC headings + parameters only, and embeddings are built from
  the same field string, never the body). The body header still feeds the
  entity graph (extracted from body prose) and human readers at `akm show`.
  Anthropic's Contextual Retrieval figures (35%/49%/67% top-20 failure-rate
  reduction) were measured on chunk-prepended context in a chunked RAG pipeline —
  an analogy motivating the description-field placement, not a measurement of it.
- Hubs are optional wiki assets for a few high-traffic domains, never a per-write
  obligation. The FTS index is the catalog.
- A ref is an address chosen once: **default to not renaming**; if unavoidable,
  grep the stash for the old ref and fix inbound xrefs in the same pass (since
  SPEC-7 landed, `akm mv` performs that whole pass mechanically — amended
  2026-07-12).

Rejected over-builds: mandatory dense/bidirectional xrefs, per-namespace hub
wikis, the per-asset scope ladder, and any hand-maintained catalog.

## What shipped

Convention facts in the stash skeleton (`src/assets/stash-skeleton/facts/conventions/`):

- `organization.md` (`category: convention`) — the partition-by-type placement
  rules. Surfaced to every non-wiki author.
- `backlinks.md` (`category: convention`) — the cross-linking / provenance /
  canonical-naming rules. Surfaced to every non-wiki author.
- `domains.md` (`category: convention`) — the editable domain vocabulary and
  canonical entity spellings for reuse-born assets.
- A short **Placement & linking** section added to each
  `facts/conventions/assets/<type>.md`, stating that type's default axis
  (surfaced type-scoped).

Because these are `category: convention` facts, `resolveStashStandards` injects
them into the authoring context automatically — no code change was required to
enforce the surfacing. They are soft guidance; a stash owner edits them to match
how their stash is queried.

The code changes the finalized conventions imply are specced separately in
[stash-conventions-code-spec.md](stash-conventions-code-spec.md) (8 specs,
prioritized and sequenced; nothing implemented in this change).

## Review round

A two-reviewer adversarial review (retrieval mechanics / IR + KM methodology /
agent usability), with cross-rebuttals, tuned the shipped conventions. Decisive
corrections, each code-verified or empirically tested:

- **The ref-prefix search idiom was false.** `akm search "<type>:<prefix>/"`
  never worked (`sanitizeFtsQuery` strips `:` and `/`; `entry_type` is not an
  FTS column) — live-tested at zero hits. All convention text now uses
  `akm search "<slug>" --type <type>`. *Amendment (2026-07-11): SPEC-4 has
  since made the idiom real — `<type>:<prefix>/` (and bare `<type>:`) queries
  now translate to a typed subtree enumeration (`parseRefPrefixQuery`). The
  finding was correct at review time; the shipped convention facts keep the
  `--type` idiom for now (re-adoption deferred one release — see open
  questions).*
- **"Folders are invisible to the ranker" was backwards.** Subpath tokens are
  indexed in the FTS `name` column at the highest weight and earn the cwd
  project-context boost; the claimed "indexing-confidence bump" does not exist.
- **xrefs never feed the entity graph** — extraction reads body prose
  (memory + knowledge) with frontmatter stripped, so graph-relevant
  relationships must be stated in the body.
- **Body prose is not FTS/embedding-indexed** — self-situating orientation
  belongs in `description:`/`when_to_use:`; the body header serves the graph
  and human readers.
- **"Rename-proof" was misleading** — a rename orphans the asset's utility
  history (new `entry_key` row), strengthening the no-rename rule.
  *Amendment (2026-07-12): true for manual renames only since SPEC-7 landed —
  `akm mv` rewrites inbound refs and re-keys the index row in place, so a
  tooled rename preserves the learned ranking history. The no-rename default
  stands: mv cannot fix citers in read-only sources (it reports them as
  `readOnlyCiters` manual follow-ups).*
- **Corrections now pair with `beliefState: superseded`/`supersededBy`**
  (parsed for all markdown types, demoted at rank time), and immutability was
  rescoped to ingested material only, resolving a contradiction with the
  knowledge type conventions.
- Completeness: `script` joined the reuse-born bucket; wikis take the domain as
  the wiki NAME; `env` got a decision test; a `conventions` domain entered the
  vocabulary (the shipped facts had violated their own list); a two-domain
  tie-break was added; and duplicated pointer text was trimmed from the nine
  co-injected per-type files.

## Open questions / future work

Items with an implementation path were specced in
[stash-conventions-code-spec.md](stash-conventions-code-spec.md), and all
eight specs have since landed (amended 2026-07-12): the lint frontmatter
channels (SPEC-1), the tag merge (SPEC-2), `--xref` (SPEC-3), the ref-prefix
filter (SPEC-4), `--supersedes` demotion (SPEC-5), category capture (SPEC-6 —
shipped capture-only; the rank-time demotion was dropped after measurement
showed no crowding), `akm mv` (SPEC-7), and default-off body-opening indexing
(SPEC-8) — see the closed bullets below. What remains genuinely open:
vocabulary governance, scheduled consolidation (argued down in the spec — the
improve pipeline already injects the amended conventions), and the typed
provenance channel.

- **A thin HARD floor.** `akm lint` runs a deterministic `missing-ref` check
  over body text and `refs:` frontmatter for non-wiki markdown assets; the gap
  was precisely the `xrefs:`/`supersededBy:`/`contradictedBy:` frontmatter
  channels the conventions mandate — closed by SPEC-1 in
  [stash-conventions-code-spec.md](stash-conventions-code-spec.md) (implemented:
  the same check now scans those keys too). Orphan and uncited-source checks for
  non-wiki assets are argued down (orphanhood is the sanctioned normal state
  under discretionary linking; uncited-source is undecidable without knowing
  whether an asset is derived).
- **Kill the tag footgun in code.** Closed by SPEC-2 in
  [stash-conventions-code-spec.md](stash-conventions-code-spec.md)
  (implemented: directory tokens from the canonical ref subpath now always
  merge into `tags`; filename tokens still derive only when `tags` is empty).
  Takes effect on reindex; operators with collapse-detector canary sets should
  re-mint baselines via `akm improve canary --refresh`.
- **Vocabulary governance.** How an agent proposes a `fact:conventions/domains`
  addition mid-task without blocking on human review (interim: flat type-root
  fallback + a proposal note).
- **Scheduled consolidation.** A curate/consolidate trigger to dedup near-duplicate
  atoms, promote recurring memories into domain knowledge, and fix danglers —
  since no reorg pass happens organically and utility ranking is cold-start-biased
  toward incumbents.
- **Naming collision.** The convention's "scope" wording vs the existing
  `entry.scope` (user/agent/run/channel) / `scopeKey` concepts in code — the
  convention facts deliberately say "project/client slug" and "partition axis" to
  avoid cross-wiring; keep it that way.
- **Ref-prefix filter in code.** Closed by SPEC-4 in
  [stash-conventions-code-spec.md](stash-conventions-code-spec.md)
  (implemented: `parseRefPrefixQuery` detects `<type>:<prefix>/` — and bare
  `<type>:` — queries on the untyped search path and translates them to a
  typed index enumeration with name-prefix narrowing; hits carry the fixed
  browse score 1, an explicit `--type` wins over the parsed type, and the
  in-memory prefix filter leaves an `entry_key LIKE` SQL push-down as a later
  optimization). Whether the skeleton convention facts should re-adopt the
  idiom over `akm search "<slug>" --type <type>` stays deferred one release so
  older CLI versions aren't taught a query shape they don't support.
- **A tooled rename.** Closed by SPEC-7 in
  [stash-conventions-code-spec.md](stash-conventions-code-spec.md)
  (implemented, Experimental: `akm mv <ref> <new-name>` moves the file — a
  memory's `.derived.md` twin moves with it — rewrites inbound refs across
  the writable stash in the same pass, covering body prose, frontmatter ref
  lists, and fenced examples, and re-keys the index row in place so the
  asset's accumulated utility/embedding/salience history survives). The
  no-rename default stands: read-only sources are scanned but never written —
  their citing files surface as `readOnlyCiters` manual follow-ups — and the
  skeleton organization fact now names `akm mv` as the forced-rename tool
  (with the manual grep-and-fix procedure kept as the older-CLI fallback).
- **Index self-situating body text.** Closed by SPEC-8 in
  [stash-conventions-code-spec.md](stash-conventions-code-spec.md)
  (implemented, default-off: the `index.indexBodyOpening` config flag makes
  the metadata pass capture the first prose paragraph of a markdown body —
  capped at 280 chars; secrets/env and session-kind memories excluded — into
  `entry.bodyOpening`, folded into the lowest-weight `content` FTS column and
  the embedding text). Stays default-off until eval evidence (curate goldens)
  shows lift; toggling requires `akm index --full` (embeddings do not
  regenerate for already-embedded entries) plus a canary re-mint, and `akm
  index` warns while the flag diverges from the built state. The
  `description:`/`when_to_use:` orientation routing the conventions teach
  remains primary.
- **Typed provenance channel.** Evaluate `sources:` for all types, indexed
  outside `hints` — it would separate provenance from associative links and
  resolve the xref-cap tension mechanically. Rejected for the shipped
  convention because non-wiki `sources:` earns no retrieval benefit today and
  provenance-in-xrefs powers the "what did we build on this?" query.
- **Convention facts crowd domain-term queries.** Their name/description/
  when_to_use tokens (bodies are unindexed) match via prefix expansion and carry
  the fact type boost (0.22); consider excluding `category: convention` facts
  from default untyped search (their delivery channel is prompt injection,
  parallel to the `session` default exclusion) or demoting the category at rank
  time. *Amendment (2026-07-12): closed by SPEC-6 in
  [stash-conventions-code-spec.md](stash-conventions-code-spec.md), shipped
  capture-only. The `category:` key is now captured into the index as
  `entry.category` (takes effect on reindex), making a category-keyed policy
  implementable — but the spec's prescribed measurement (full skeleton
  convention facts plus a real `knowledge/auth` asset, untyped `auth` query,
  semantic off) showed NO crowding: FTS is exact-first, so prefix expansion
  onto the facts' tokens fires only when nothing matches the query exactly,
  and a real domain asset always outranks the facts. The rank-time demotion
  contributor was therefore dropped;
  `tests/search-convention-fact-demotion.test.ts` pins the no-crowding
  invariant and is the regression guard if demotion is ever revisited.*
- **Automate correction demotion.** Closed by SPEC-5 in
  [stash-conventions-code-spec.md](stash-conventions-code-spec.md)
  (implemented as the deterministic CLI form: `--supersedes <old ref>` on
  `akm remember`/`akm import` writes the correction with the xref, sets
  `beliefState: superseded` + `supersededBy: [<new ref>]` on the old asset,
  and reindexes it; demoting belief states now also cap the final search
  score so the stale incumbent cannot outrank its correction). An LLM-side
  `curate`/`improve` pass that detects citing corrections automatically
  remains open.
