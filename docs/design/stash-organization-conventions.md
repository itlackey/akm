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
   for every type. `akm search "memory:projectA/"` narrows by prefix. The path is
   therefore the one facet you cannot express twice and cannot change without
   breaking the ref (and every inbound reference to it).
2. **Retrieval is search, not browse.** There is no folder walk at query time —
   agents `akm search`/`akm curate`, then `akm show <ref>`. A subdirectory buys
   only a small indexing-confidence bump and a ref-prefix filter. Folders are
   invisible to the ranker.
3. **The FTS surface is `name`, `description`, `tags`, `hints`, `content`**
   (`entries_fts`, `src/indexer/db/schema.ts`). There is **no `project` field** —
   a bare `project:` frontmatter value is invisible to search. Off-axis facets
   must be `tags` to be retrievable.
4. **`xrefs:` fold into the FTS `hints` field for all types**
   (`src/indexer/search/search-fields.ts:58`). Back-links are a *retrieval*
   signal, not decoration — which means both too few and too many degrade
   ranking.
5. **Project relevance is recovered at query time, rename-proof.** Ranking blends
   a per-project usage signal — `scopedUtility * 0.7 + globalUtility * 0.3`
   (`SCOPED_UTILITY_BLEND_SCOPED`, `src/indexer/search/ranking-contributors.ts`),
   keyed by a cwd-anchor independent of the path. So a reusable asset does not
   need the *project* baked into its path to rank well inside a project.
6. **Path tags are auto-derived only when `tags` is empty**
   (`src/indexer/passes/metadata.ts:1114`). Setting `tags` explicitly *suppresses*
   the path-derived tag — a real footgun.
7. **The entity/relation graph boost extracts from body content, not the path**
   (`graph-extraction.ts`). Canonical entity naming must live in the prose.
8. **`category: convention|meta` facts are surfaced to every non-wiki authoring
   flow** (`resolveStashStandards`); `facts/conventions/assets/<type>.md` is
   surfaced type-scoped (`resolveTypeConventions`). This is the only channel that
   reaches a browse-blind agent mid-task — so conventions must ship as facts.
9. **Non-wiki xrefs have no broken-link lint.** Only wikis get
   orphan/broken-xref/stale-index/uncited-raw checks. A rename silently dangles
   non-wiki inbound links.

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
  reasoning, and the `memory:projectA/` prefix filter reconstructs the project.
- **Reuse-born types** (`knowledge`, `skill`, `wiki`, `fact`) → a stable
  **domain** from a short closed vocabulary. Project relevance is already
  recovered by scoped-utility ranking (fact 5), so spending the path on the
  project axis is redundant; the domain prefix is the only handle that
  co-locates cross-project reuse.
- **Global-by-nature types** (`command`, `agent`, `workflow`, stash-wide `env`) →
  type root or a tool slug.

Supporting rules, all shipped as convention facts:

- One path axis; depth 1 (2 max for strict containment); lowercase-hyphen
  semantic segments; **no volatile facets in the path** (status/date/version/…);
  flat type-root fallback instead of inventing a one-off domain.
- Off-axis facets go in `tags` (never a bare `project:` field), and you must
  restate the path token when you set `tags` explicitly (fact 6).
- **Exactly one mandatory xref — provenance.** Associative xrefs are discretionary
  and capped (~5). Corrections are new assets that xref the source; the source is
  never edited (Karpathy immutability inside AKM's flat model).
- **Self-situating header on every asset** — title + one-line orientation naming
  what it is, its scope/domain, and key entities in canonical spelling. Highest
  leverage, lowest cost, feeds FTS + embeddings + the entity graph + humans at
  once.
- Hubs are optional wiki assets for a few high-traffic domains, never a per-write
  obligation. The FTS index is the catalog.
- A ref is an address chosen once: **default to not renaming**; if unavoidable,
  grep the stash for the old ref and fix inbound xrefs in the same pass.

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

## Open questions / future work

- **A thin HARD floor.** Extend orphan/broken-xref/uncited-raw lint beyond wikis
  to `knowledge`/`memory`/`lesson` so provenance-xref and canonical-slug rules are
  enforced, not only advised. Soft conventions degrade under token pressure;
  non-wiki lint is code that does not yet exist.
- **Kill the tag footgun in code.** Always merge path segments into `tags` rather
  than only when `tags` is empty, removing the explicit-tags trap.
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
