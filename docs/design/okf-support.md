# Supporting the Open Knowledge Format (OKF) in akm

**Status:** Proposal / research report
**Date:** 2026-07-12
**Author:** akm tooling

## TL;DR

Google Cloud published the [Open Knowledge Format
(OKF)](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)
v0.1 in June 2026 — a vendor-neutral spec for representing knowledge as a
directory of markdown files with YAML frontmatter, wired into a graph by
markdown links. The reference spec lives at
[`GoogleCloudPlatform/knowledge-catalog/okf`](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf).

**OKF and akm are the same idea from two directions.** Both cite Andrej
Karpathy's LLM-wiki pattern. Both are "just markdown, just files, just YAML
frontmatter." Both separate the *format* of knowledge from the *tooling* that
produces and consumes it. akm's `wiki` asset type is already ~80% of an OKF
implementation.

The gap is small and mechanical, not architectural. This report proposes
making akm a first-class **OKF consumer and producer**: `akm add` an OKF
bundle and have its concepts indexed, searched, and shown like any other
asset; and `akm export --format okf` to emit a conformant bundle from a stash.
Doing so costs one new asset type, a deterministic markdown-link graph source,
~5 optional frontmatter fields, and an import/export command pair — all of
which land on existing seams (`registerAssetType`, the graph pass, the
frontmatter capture pipeline, the wiki lint machinery).

---

## 1. What OKF actually is

OKF v0.1 is deliberately tiny — the whole normative spec fits on one page.

### 1.1 Bundle structure

An OKF **bundle** is a hierarchical directory tree of markdown files, each
representing one **concept** (a table, dataset, metric, playbook, runbook, API,
join path, …). Bundles ship as a git repo (recommended), a tarball, or a
subdirectory of a larger repo.

```
sales/
├── index.md                 # reserved: progressive-disclosure listing
├── log.md                   # reserved: chronological change history
├── datasets/
│   ├── index.md
│   └── orders_db.md
├── tables/
│   ├── index.md
│   ├── orders.md            # a concept document
│   └── customers.md
└── metrics/
    ├── index.md
    └── weekly_active_users.md
```

### 1.2 Concept document format

Every non-reserved `.md` file is a concept: **YAML frontmatter + markdown
body**.

```yaml
---
type: BigQuery Table          # the ONLY required field
title: Orders                 # recommended
description: One row per completed customer order.
resource: https://console.cloud.google.com/bigquery?...   # URI of the real asset
tags: [sales, revenue]
timestamp: 2026-05-28T14:30:00Z   # ISO 8601, last modified
---

# Schema
| Column | Type | Description |
|--------|------|-------------|
| `order_id` | STRING | Globally unique order identifier. |
| `customer_id` | STRING | FK to [customers](/tables/customers.md). |

# Joins
Joined with [customers](/tables/customers.md) on `customer_id`.
```

**Fields:**

| Field | Required | Meaning |
| --- | --- | --- |
| `type` | **Yes** | Free-form concept kind: `"BigQuery Table"`, `"Metric"`, `"Runbook"`. Non-empty string. |
| `title` | Recommended | Human-readable display name. |
| `description` | Recommended | Single-sentence summary. |
| `resource` | Recommended | URI uniquely identifying the underlying asset. |
| `tags` | Recommended | YAML list of category strings. |
| `timestamp` | Recommended | ISO 8601 datetime of last modification. |
| *(extensions)* | Optional | Producers may add any keys; consumers **must preserve unknown keys** and tolerate unrecognized fields. |

Conventional body sections: `# Schema`, `# Examples`, `# Citations`.

### 1.3 The graph — inline markdown links

Concepts link to each other with **ordinary markdown links**, turning the
directory into a directed graph that transcends the filesystem hierarchy. Two
link forms:

- **Absolute (bundle-relative)** — begins with `/`, resolved from bundle root.
  *Recommended.* e.g. `/tables/customers.md`.
- **Relative** — standard markdown relative paths.

Links are *untyped* edges; the relationship's meaning lives in the surrounding
prose. Consumers treat them as directed graph edges and **must tolerate broken
links**.

### 1.4 Reserved files

- **`index.md`** — optional, one per directory level. No frontmatter. A grouped
  listing of the concepts in/under that directory, each as
  `* [Title](url) - description` pulled from the linked concept's frontmatter.
  Enables *progressive disclosure*: an agent walks the tree level by level.
- **`log.md`** — optional. Change history, newest first, grouped under ISO
  `YYYY-MM-DD` date headings, each entry led by a bold action word
  (`**Update**`, `**Creation**`).

`index.md` and `log.md` are reserved and **must not** be used as concept
documents.

### 1.5 Conformance & versioning

A conformant bundle:
1. Includes parseable YAML frontmatter in every non-reserved `.md`.
2. Has a non-empty `type` field in every frontmatter block.
3. Follows the reserved-file structure when `index.md` / `log.md` are present.

Consumers are **permissive**: they must not reject a bundle for missing
optional fields, unknown `type` values, unknown keys, broken links, or absent
index files.

Version is `<major>.<minor>`; minor = backward-compatible additions, major =
breaking. A bundle may declare `okf_version: "0.1"` in its **root
`index.md` frontmatter**. Consumers do best-effort processing on unrecognized
versions. Extension: `.md`, UTF-8. No MIME type specified.

### 1.6 Reference implementations Google ships

- **Enrichment Agent** (producer): walks BigQuery datasets, drafts OKF concept
  docs, second LLM pass adds citations/schemas/join paths.
- **Static HTML Visualizer** (consumer): renders any bundle as an interactive
  graph in a single self-contained file, no backend.
- Sample bundles: GA4 e-commerce, Stack Overflow, Bitcoin public datasets.

---

## 2. Why akm is already most of the way there

akm and OKF converged on the same primitives. This is not a coincidence — both
descend from the Karpathy LLM-wiki gist, which akm cites directly in
`docs/wikis.md` and `README.md`.

| Concern | OKF | akm today |
| --- | --- | --- |
| Substrate | markdown files on a filesystem | markdown files on a filesystem |
| Metadata | YAML frontmatter | YAML frontmatter (`parseFrontmatter`, `yaml` lib) |
| Distribution | git repo / tarball / subdir | `git`, `filesystem`, `npm`, `website` source providers |
| Reserved files | `index.md`, `log.md` | `schema.md`, `index.md`, `log.md` (wiki infra files, already excluded from search) |
| Graph edges | inline markdown links | `xrefs:` frontmatter + LLM entity/relation extraction |
| Progressive disclosure | per-dir `index.md` | wiki `index.md` regenerated by `akm index` |
| Change log | `log.md`, newest first | wiki `log.md`, newest first |
| Philosophy | format not platform; no SDK; no registry | CLI-only; no SDK required; providers materialize to disk |
| Producer/consumer split | explicit in spec | akm both consumes (index/search/show) and produces (wiki ingest) |

**akm's wiki (`docs/wikis.md`, `src/wiki/wiki.ts`) is structurally an OKF
producer/consumer already.** The differences are naming and a few missing
fields, not design.

---

## 3. Gap analysis

Five concrete gaps stand between akm and OKF interop. Each maps to a specific
seam in the codebase.

### 3.1 The `type` collision (the one real semantic mismatch)

This is the single most important thing to get right.

- In **OKF**, `type` is a frontmatter field holding the *concept kind* — a
  free-form string like `"BigQuery Table"`. Every concept doc carries it, and
  its value is producer-defined.
- In **akm**, `type` is the *asset class* — `skill`, `agent`, `wiki`,
  `knowledge`, … — and it is **derived from the directory the file lives in**
  (`src/core/asset/asset-spec.ts`: each `AssetSpec` binds a `stashDir`), not
  read from frontmatter. It selects the renderer, the ref namespace, and the
  search facet.

So OKF's `type` cannot be mapped onto akm's `type`. It must land on a
*different* field. akm already has the right receptacles:

- **`pageKind`** (`StashEntry.pageKind`, `applyWikiFrontmatter`) — free-form,
  "any non-empty string," already surfaced in wiki `index.md` sections. This is
  the natural home for OKF `type`.
- **`category`** (`StashEntry.category`) — an alternative if we want `pageKind`
  to stay wiki-scoped.

**Decision needed:** map OKF `type` → `pageKind` (recommended — it already
means "concept archetype") and treat the akm asset `type` for an imported
bundle as a fixed class (`okf`, or `wiki`).

### 3.2 No akm asset type recognizes an arbitrary OKF tree

akm asset types bind to fixed stash directories (`skills/`, `agents/`,
`wikis/`, …) and to filename shapes (`SKILL.md`, `*.md`, `.env`). An OKF bundle
has an *arbitrary* tree (`sales/tables/orders.md`) with no akm-reserved
top-level dir. Added via `akm add github:...`, its concept docs would not be
claimed by any existing `isRelevantFile` matcher and would not be indexed as a
recognizable type.

**Seam:** `registerAssetType()` in `asset-spec.ts` is explicitly built for
this. A new `okf` type (or a bundle registered as a wiki) closes the gap.

### 3.3 The link graph is not harvested deterministically

OKF's graph *is* the inline markdown links. akm builds its graph two ways
today, neither of which reads body links:

- `xrefs:` frontmatter (`applyWikiFrontmatter`) — explicit, but OKF concepts
  don't use it.
- LLM entity/relation extraction (`src/indexer/graph/graph-extraction.ts`) —
  requires a configured provider, is non-deterministic, and extracts *entities*
  rather than *document→document* edges.

An OKF bundle's links would be invisible to akm's graph unless we add a
**deterministic markdown-link extractor** — parse `[text](/path.md)` and
`[text](rel/path.md)` from the body, resolve to concept refs, emit edges. This
is pure string work, needs no LLM, and also improves akm's own wiki graph.

### 3.4 Missing first-class frontmatter fields

`StashEntry` (`src/indexer/passes/metadata.ts`) captures `description`, `tags`,
`pageKind`, `xrefs`, `sources`, `category`, and many more — but **not**
OKF's `title`, `resource`, or `timestamp`. These are cheap additive fields
(mirror the existing `applyCuratedFrontmatter` pattern) and are required for
lossless round-tripping OKF ↔ akm.

### 3.5 No import/export bridge

There is no `akm export` at all, and no OKF-aware import beyond the generic
source providers. Both the consume and produce directions need a thin bridge:
one to normalize an OKF bundle into indexable akm entries, one to serialize akm
assets back into a conformant bundle (regenerated `index.md`, `log.md`,
bundle-relative links, `type` frontmatter).

---

## 4. Proposed design

Three capabilities, each independently shippable. Recommended order: **A → C →
B** (consume first, since it's lowest-risk and immediately useful; then align
fields; then produce).

### A. Consume OKF bundles (read path)

**Goal:** `akm add github:GoogleCloudPlatform/knowledge-catalog` (or any OKF
repo/tarball/dir), then `akm index`, and the bundle's concepts are searchable
and `akm show`-able.

The source providers already materialize the files to disk — nothing new
there. What's missing is *recognition*. Two implementation options:

**A1 — new `okf` asset type (recommended).**
Register via `registerAssetType("okf", …)`:

```ts
registerAssetType("okf", {
  stashDir: "okf",                         // conventional home under a stash
  isRelevantFile: (f) =>
    f.toLowerCase().endsWith(".md") &&
    f !== "index.md" && f !== "log.md",    // honor reserved files
  toCanonicalName: (root, fp) =>
    toPosix(path.relative(root, fp)).replace(/\.md$/, ""),  // bundle-relative
  toAssetPath: (root, name) => path.join(root, `${name}.md`),
  rendererName: "knowledge-md",            // reuse the markdown renderer
  actionBuilder: (ref) => `akm show ${ref} -> read the OKF concept`,
});
```

Refs become `okf:sales/tables/orders`. In the metadata pass
(`buildEntryFromFile`), extend the `.md` branch so that for `okf` entries we:
- map frontmatter `type` → `pageKind` (§3.1);
- capture `title`, `resource`, `timestamp` (§3.4);
- map `description`, `tags` (already handled by `applyCuratedFrontmatter`);
- preserve unknown keys (permissive consumption).

**A2 — register the bundle as a wiki.**
`akm wiki register <name> github:owner/okf-bundle`. Reuses the entire wiki
surface (search scoping, lint, index regeneration). The catch: the wiki lint
and index machinery assume the `raw/` + `pages/` layout, which OKF trees don't
follow. Would require relaxing those assumptions or a "flat OKF wiki" mode.
Lower net-new code, but bends the wiki contract.

**Recommendation:** A1. A dedicated `okf` type keeps the wiki contract clean
and gives OKF bundles their own ref namespace and search facet
(`akm search "orders" --type okf`). It is a textbook use of the
`registerAssetType` extension point.

Additionally: read `okf_version` from the bundle root `index.md` frontmatter
during import and surface it (a stash-level fact, or verbose log) so version
skew is visible.

### B. Produce OKF bundles (write/export path)

**Goal:** `akm export --format okf --out ./bundle [--type wiki,knowledge]
[--source <id>]` emits a conformant OKF bundle from selected assets.

The exporter walks selected entries and:
1. Writes each as `<concept-path>.md` with OKF frontmatter — emitting `type`
   from `pageKind` (or a mapping table), plus `title`, `description`,
   `resource`, `tags`, `timestamp`.
2. Rewrites `xrefs:` and internal refs as **bundle-relative markdown links**
   in the body (or an appended `# Related` section) so the OKF graph is
   populated from akm's edges.
3. Regenerates a per-directory `index.md` (`* [Title](url) - description`) —
   akm already regenerates wiki `index.md`; generalize that writer.
4. Generates `log.md` from the improve/event history or the wiki `log.md`.
5. Stamps `okf_version: "0.1"` into the root `index.md`.

The wiki `ingest` workflow (`docs/wikis.md` §"The ingest workflow") already
produces something structurally close; an "OKF profile" on the exporter reuses
most of it. The output is directly consumable by Google's static HTML
visualizer, which is a compelling demo.

### C. Frontmatter & graph alignment (make akm natively OKF-shaped)

Small, high-leverage changes that benefit akm regardless of import/export:

1. **Add optional fields** `title`, `resource`, `timestamp` to `StashEntry`
   and capture them in `applyCuratedFrontmatter`. Purely additive; existing
   assets unaffected.
2. **Add a deterministic markdown-link graph source** (§3.3): a non-LLM pass
   that parses body links into document→document edges, feeding the same
   `graph-db` the LLM pass writes. Register it alongside the existing extractor;
   it works with no provider configured and directly implements OKF's graph
   semantics. Also strengthens akm's own wiki graph.
3. **OKF conformance lint.** Extend `akm wiki lint` (or add `akm okf lint`)
   with the three conformance checks from §1.5 — reusing the existing
   deterministic lint framework (`broken-xref`, `orphan`, `missing-description`
   already exist; add `missing-type`, `unparseable-frontmatter`, and a
   *tolerated-but-reported* `broken-link`).

---

## 5. Codebase touchpoints

| Change | File(s) | Effort |
| --- | --- | --- |
| Register `okf` asset type | `src/core/asset/asset-spec.ts`, `src/core/asset/asset-registry.ts` | S |
| Map OKF `type`→`pageKind`, capture `title`/`resource`/`timestamp` | `src/indexer/passes/metadata.ts` (`buildEntryFromFile`, `applyCuratedFrontmatter`), `StashEntry` interface | S–M |
| Deterministic markdown-link graph source | new pass under `src/indexer/graph/`, wired into `graph-db` | M |
| OKF conformance lint | `src/commands/lint/` + wiki lint | S–M |
| `akm export --format okf` | new `src/commands/` verb + index.md/log.md writer generalized from wiki | M–L |
| `okf_version` awareness on import | source ingest / a stash-level fact | S |
| Docs: `docs/features/okf.md`, update `docs/concepts.md` asset-type table | docs | S |

Nothing here requires touching the locked provider set (§AGENTS.md: providers
stay `filesystem`/`git`/`website`/`npm`) — OKF bundles arrive through the
existing `git`/`filesystem` providers. Nothing requires an LLM. The heaviest
piece (export) is self-contained.

## 6. Risks, constraints, and non-goals

- **`type` semantics must not leak.** akm's asset `type` is load-bearing
  (renderer, ref namespace, write-source routing). The import path must never
  feed OKF's frontmatter `type` into akm's asset `type`. Guardrail: OKF `type`
  is only ever read into `pageKind`/`category`; a contract test should pin this.
- **Permissive consumption is mandatory.** Per spec, akm must not drop concepts
  for missing optional fields, unknown `type`, unknown keys, or broken links.
  akm's frontmatter parser is already lenient (`parseFrontmatterLenient`
  fallback) and unknown-key-preserving; the OKF import path must keep that
  posture and *report* rather than *reject*.
- **Unknown-key preservation on round-trip.** Export must not silently drop
  producer extension keys captured on import. Store the raw frontmatter
  (or unrecognized remainder) so export can re-emit it.
- **Reserved-file handling.** `index.md`/`log.md` must be excluded from concept
  indexing (akm already excludes wiki `index.md`/`log.md`/`schema.md` via
  `shouldIndexStashFile` / `WIKI_INFRA_FILES` — generalize the same exclusion
  to `okf` bundles).
- **Non-goals for v1:** no OKF *editing* UI, no adopting Google's visualizer
  into akm (we emit a bundle it can read, that's the interop surface), no
  attempt to model OKF's optional `# Schema`/`# Citations` body sections as
  structured data (they stay as searchable markdown).

## 7. Recommended first step

Ship **A1 (consume) + C.1 (fields)** as a single small PR: register the `okf`
asset type and capture `title`/`resource`/`timestamp` + `type`→`pageKind`.
That alone lets a user `akm add` Google's sample bundles and search/show them,
proves the model end-to-end, and de-risks the larger export work — all on
existing seams with no new provider, no LLM, and no change to the asset `type`
contract.

---

## References

- Google Cloud blog — [How the Open Knowledge Format can improve data
  sharing](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)
- OKF spec & reference implementations —
  [`GoogleCloudPlatform/knowledge-catalog/okf`](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
- Andrej Karpathy — [LLM
  wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- akm wikis — `docs/wikis.md`
- akm asset system — `src/core/asset/asset-spec.ts`, `src/indexer/passes/metadata.ts`
- akm graph extraction — `src/indexer/graph/graph-extraction.ts`
</content>
</invoke>
