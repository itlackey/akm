# AKM 0.9.0 — Bundle Adapter Specification

**Status:** binding implementation spec. Companion to `akm-0.9.0-bundle-adapter-architecture-plan.md` (the *what/why/deletion* plan); this is the *how* an implementer builds the bundle/adapter core (plan Chunks 1–5) from. Every element is grounded in real code at HEAD as `file:line`, or marked **NEW** with the mandate.

**Foundational decision:** AKM bundles **are** OKF (Open Knowledge Format) bundles. OKF is the foundational metadata format and AKM is OKF-compatible **by default** — an AKM knowledge bundle *is* a valid OKF bundle, and a third-party OKF bundle indexes in AKM with no translation. AKM adopts OKF's field names and conventions directly (including the field **`type`**); it does **not** invent a parallel vocabulary. All other formats (Claude, OpenCode, Agent Skills, workflows, tasks, env, website) are adapters that either *are* OKF or *translate into* OKF concepts around this core.

---

## 0. OKF as the foundational metadata format

OKF v0.1 (Google Cloud, June 2026 — [SPEC](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)) defines a **bundle** as a directory tree of markdown "concept" files, each `--- YAML frontmatter --- ` + markdown body, where **the file path is the concept's identity** and the only required field is an open, producer-defined **`type`**. This maps onto the approved drop-ref architecture almost exactly — which is why OKF is adopted as the base, and why AKM uses OKF's fields *as-is* rather than mapping them to AKM-proprietary names.

### 0.1 OKF ⇄ AKM: same fields, no translation layer

| OKF v0.1 field/rule | AKM | Note |
|---|---|---|
| Bundle = directory tree of markdown concepts | AKM **bundle**; the `okf` adapter is the **default/foundational** adapter (§5) | an AKM knowledge component and an OKF bundle are the same thing on disk |
| **Concept ID** = file path with `.md` removed (`tables/users.md` → `tables/users`) | AKM opaque **`localId`** in `ItemRef = <bundle>/<local-id>` (§1.3) | path-based identity is the OKF contract; drop-ref *is* OKF-alignment |
| Required **`type`** (open string: `Metric`, `Playbook`, `skill`, `command`…) | AKM item **`type`** — the **same field, same name**. Open string, **authored in frontmatter**. The closed `AkmAssetType` union dies (plan §4.1); `type` survives as the open OKF string | there is **no** separate AKM "kind" and **no** `type`↔`kind` mapping |
| Recommended **`title`** | IndexDocument `name` (FTS weight 10) — read `title` first, fall back to filename; **write `title`** | OKF-compatible output |
| Recommended **`description`** | IndexDocument `description` (weight 5) | direct |
| Recommended **`tags`** | IndexDocument `tags` (weight 3) | direct |
| Recommended **`timestamp`** (ISO-8601) | provenance/`updated`; base-linter `missing-updated` reconciles to `timestamp` | OKF-compatible freshness |
| Recommended **`resource`** (URI of the underlying asset) | IndexDocument provenance (`sourceRef`) | carried, not required |
| Reserved **`index.md`** (dir listing), **`log.md`** (history) | reserved filenames — **not indexed as concepts** (§5) | |
| Bundle-relative links `[x](/tables/customers.md)` = **relationship** | the **deterministic native link graph** (§9) | replaces LLM graph extraction (audit §9.2) |
| **`okf_version: "0.1"`** in root `index.md` | bundle manifest version (§1.2) | AKM emits it on bundles it creates |
| Consumers **MUST NOT reject** unknown fields; **MUST tolerate** broken links | OKF adapter `validate` is **lenient** (§5) | interoperability guarantee |

### 0.2 What "OKF is foundational" binds

1. **`type` is the OKF field, used directly.** No rename, no synonym, no translation layer. AKM's own content authors `type` in frontmatter (`type: skill`); third-party OKF content authors whatever `type` it likes; both index identically.
2. **The normalized model (`IndexDocument`, §3) is an OKF projection.** `name`/`description`/`tags`/`type`/`updated` come straight from OKF `title`/`description`/`tags`/`type`/`timestamp`.
3. **The `okf` adapter is the default** and the default writable destination for `remember`, distill promotion, and website→native export (§5).
4. **AKM writes OKF-compatible bundles** — new files carry OKF frontmatter (`type`, `title`, `description`, `tags`, `timestamp`); bundles carry `okf_version`; cross-refs use OKF bundle-relative links.

### 0.3 The clean taxonomy — identity vs type vs adapter vs component

AKM uses the OKF field name **`type`** directly; there is no separate AKM "kind" and no `type`↔`kind` translation. The old `AkmAssetType` was a *closed union* that also did file-naming, directory routing, and state-keying (plan §6.1); 0.9.0 keeps the **name** `type`, makes it the **open OKF string**, and strips those other jobs off it. The concepts it used to conflate are now separate:

| Concept | What it is | Source | Role | NOT |
|---|---|---|---|---|
| **identity** | the one name of an item | `<bundle>/<local-id>`; local-id = OKF concept ID (path − `.md`) | refs, addressing, links, state keys | not type / adapter / component |
| **`type`** (OKF) | an open descriptive label on a document | **authored in frontmatter** for OKF-native content; **derived by an adapter** only for foreign non-OKF layouts | rendering, action, ranking, type-specific validation | not identity, not an adapter, not a directory |
| **adapter** | a format-family owner / OKF translator | static id, selected **once per component root** | recognize / place / validate a format; present a foreign format as OKF concepts | not a type; not per-item; never competes per-file |
| **component** (a.k.a. "tool directory") | a materialized root under one adapter | `bundle_id + component_id` columns | provenance, write policy, git pathspecs | not identity, not type |

**`type` is authored, not routed — the OKF-native point.** For AKM's own content, which *is* OKF, `type` lives in the file's frontmatter (`type: skill`), exactly as OKF specifies; the directory is just organization (OKF: "the directory structure is independent of the domain"). AKM does **not** infer `type` from a directory for its own bundles. Directory-*derived* `type` exists **only** inside the adapters that bridge a *foreign* layout carrying no OKF frontmatter — a `.claude` tool directory (Claude Code conveys role by `commands/`/`agents/`), a bare `SKILL.md` package, a website crawl. Those adapters are OKF **translators**: they read a non-OKF layout and present it as OKF concepts with a derived `type`. (This corrects the earlier draft, which wrongly treated directory-routing as AKM's *native* model — routing is a foreign-format shim, not the AKM steady state.)

**Orthogonality rules — each kills a specific ambiguity:**

1. **`type` ≠ adapter; the relationship is many-to-many.** One adapter emits several types (the `claude` translator → `command`, `agent`, `skill`, `instruction`). One type comes from several sources (`command` ← an OKF file whose frontmatter says `type: command`, or the `claude`/`opencode` translators deriving it). A **`type` is a label on a document; an adapter is code that reads a format.** Different axes; neither is the other.
2. **Presentation keys on `type`; validation on `(adapter, type)`.** `TYPE_PRESENTATION` (§2) renders `type: command` identically no matter the source. Type-specific validators (command frontmatter check, the Anthropic SKILL.md contract, the task-YAML schema) are written **once as plain functions** and applied by the adapter to the matching type, so `type: skill` validates identically under the `okf`, `claude`, and `agent-skills` adapters (plan §13.3: shared code, not shared adapters).
3. **A "tool directory" is just a component.** `.claude`/`.opencode` are component roots whose adapter understands a coding tool's layout; "tool directory" is a *description*, not a fourth concept. Which component/adapter a document came from is a **column** (provenance) — never in the ref, never changing identity or `type`. Re-mounting `.claude` under a different adapter re-stamps provenance columns and rekeys nothing (this is why component is not a ref segment — §1.3).
4. **Identity is path-only (OKF).** Neither `type`, adapter, nor component is part of identity. Changing a doc's `type`, revalidating it under a different adapter, or moving it between components does **not** rename it — only moving the *file* does (an explicit rekey, plan §3.2). This is the whole point of drop-ref, and it is precisely OKF's rule that "the file path is the concept's identity."

**OKF floor vs AKM value-add.** OKF supplies the portable **metadata floor**: path identity, an open `type`, `title`/`description`/`tags`/`timestamp`, and bundle-relative links. AKM adds — *on that floor, without breaking OKF-compatibility* — (a) presentation/ranking rules for the `type` values it knows (§6); (b) **type-specific validation** (SKILL.md contract, task schema, command/agent frontmatter, workflow structure); (c) **executable types** (`workflow`, `task`) with a runtime; (d) **sensitive types** (`env`, `secret`) whose values are never indexed; and (e) unified search, the FileChange transaction, and the improve loop. Markdown types are valid OKF concepts (a third-party OKF consumer reads them); executable/sensitive types are AKM extensions **beyond** OKF (OKF is markdown-concepts only). An AKM workspace is "an OKF bundle **plus** AKM's executable/sensitive extensions."

---

## 1. Bundle / component / installation model

### 1.1 Interfaces (grounded; replaces `AssetSpec`/`TYPE_DIRS`/`ConfiguredSource`)

```ts
export type BundleId = string;       // stable bundle name; first ItemRef segment. Replaces AssetRef.origin + ConfiguredSource.name (asset-ref.ts:21; config-types.ts:101)
export type ComponentId = string;    // component key, unique within a bundle; a COLUMN, not a ref segment (§1.3)
export type ItemRef = string;        // "<bundle>/<local-id>" — local-id is the OKF concept ID (§1.3)

export interface BundleInstallation {
  id: BundleId;
  revision?: string;                 // resolved git sha / npm version+integrity / snapshot digest (replaces installed[])
  source?: string;                   // transport locator, kept OUT of identity (audit invariant 3; replaces SourceSpec, config-types.ts:85)
  components: BundleComponent[];
  trusted: boolean;                  // explicit trust; installation alone grants nothing (invariants 13/14). NEW
}

export interface BundleComponent {
  id: ComponentId;
  adapter: string;                   // static adapter id, selected once per root — NO per-file competition (replaces runMatchers, file-context.ts:242-265)
  root: string;                      // absolute materialized root; workspace state NEVER written here (invariant 2; replaces walker stashRoot, walker.ts:73)
  writable: boolean;                 // per-component (was per-stash ConfiguredSource.writable, config-types.ts:109)
}
```

### 1.2 How a directory becomes a bundle (OKF-first)

Evaluated in order (replaces `resolveConfiguredSources`, config-types.ts:94):

1. **Root `index.md` with `okf_version`** — an OKF bundle self-declares. Present ⇒ the bundle is OKF; the `okf` adapter (§5) governs its markdown concepts; any tool sub-trees (`.claude/`, `workflows/`) are additional components (§8).
2. **Optional AKM bundle manifest** (`akm-bundle.yaml`, `schemaVersion: 1`) — declares heterogeneous component roots + adapters verbatim (audit §7.2). The **only** new file format 0.9.0 adds, and optional. SHOULD carry `okf_version: "0.1"` for its OKF components.
3. **Workspace config `bundles` map** (§1.4).
4. **Single-component default** — no manifest, no override ⇒ one component `{ id:"main", root:".", adapter:<selected> }`; adapter chosen by install-time root recognition (§4), defaulting to **`okf`** for a generic markdown tree.

No directory→type inference table (`DIR_TYPE_MAP`, `TYPE_DIRS`) exists in this path. A `workflows/` directory is a workflow component only because a manifest/config says so.

### 1.3 ItemRef grammar — **two segments** `<bundle>/<local-id>` (= OKF concept ID)

Core parses **only the first `/`**; everything after is the adapter-owned opaque `localId`, which for OKF **is the OKF concept ID** (file path minus `.md`). `component` is a **column** on the row, **not** a ref segment.

```
personal/http-caching            # local-id "http-caching"
team/tables/orders               # local-id "tables/orders"  (second "/" is inside local-id, unparsed by core)
project-claude/command/test      # local-id "command/test"  (claude translator prefixes by type, §7)
```

**Justification (plan §3.1/§6.2; audit §6; OKF concept-identity):** identity must not encode a reclassifiable/relocatable dimension. `type` was such a dimension (reclassifying renamed the ref); **component is equally reclassifiable** (a manifest edit moves a root between adapters). So component is **provenance (a column)**, not identity — matching OKF, where identity is purely the file path. This rejects the audit §3 three-segment sketch in favor of the plan's approved two-segment form and OKF's path-is-identity rule. `asset-ref.ts` survives as a **pure parser** (grammar + `makeAssetRef`/`refToString` + traversal/null-byte/drive-letter guards `:121-136`); the closed union `isAssetType` `:109`, `TYPE_ALIASES` `:25`, and origin `//` parsing are deleted (plan §4.1).

### 1.4 Config shape (replaces `stashDir`/`sources[]`/`installed[]`/`wikiName`)

```jsonc
{
  "defaultBundle": "personal",
  "bundles": {
    "personal": { "path": "~/knowledge",
      "components": { "main": { "root": ".", "adapter": "okf", "writable": true } } },
    "team": { "git": "https://github.com/acme/team-knowledge.git",
      "components": {
        "catalog":   { "root": "catalog",   "adapter": "okf" },
        "workflows": { "root": "workflows", "adapter": "akm-workflow" } } }
  }
}
```

Replaces `stashDir`→`bundles`+`defaultBundle`; `primary`→`defaultBundle`; per-component `writable`; `wikiName`→a component with `adapter:"llm-wiki"` (folded to `okf`/knowledge in 0.9.0, plan §4.5). Per plan §13.3, **no `workspace_bindings`/export-digest/trust-layer ships in 0.9.0** — `trusted` is a per-installation boolean; activation stays implicit.

---

## 2. The adapter contract (one interface; no facet hierarchy)

Per plan §13.3 there is **no** `AuthoringAdapter`/`ExportAdapter`/`MemoryLifecycleAdapter` hierarchy. One interface; optional capabilities are optional **methods**; renderer/action is a **data table**, not code.

```ts
export interface BundleAdapter {
  readonly id: string;                                    // "okf" | "claude" | "opencode" | "agent-skills" | "akm-workflow" | ... | "website" | "files"

  // REQUIRED — recognition + indexing (read-only over user content; invariant 9)
  index(inst: BundleInstallation, c: BundleComponent): AsyncIterable<IndexDocument>;   // full/first scan; replaces walkStashFlat + wiki branch + shouldIndexStashFile (walker.ts:73; indexer.ts:837; metadata.ts:687)
  recognize(c: BundleComponent, file: FileContext): IndexDocument | null;              // single-file primitive for the incremental + post-write path; replaces the matcher stack (matchers.ts:151-305; file-context.ts:242-265). null = not indexed here (infra file, README, index.md/log.md)

  // REQUIRED — native validation (change-transaction pre-commit + lint --fix); returns Diagnostic[]; adapter MUST NOT write. Replaces LINTER_MAP + 9 linters (lint/registry.ts:32-47)
  validate(c: BundleComponent, changes: FileChange[]): Promise<Diagnostic[]>;

  // OPTIONAL capability methods (present only where behavior differs)
  placeNew?(c: BundleComponent, localId: string): string;   // new-item path; replaces TYPE_DIRS + resolveAssetPathFromName + buildDiskCandidates (path-resolver.ts:27-38). Absent ⇒ read-only for creation
  directoryList?(c: BundleComponent): string[];             // dirs this adapter owns; feeds git exact-path staging (git-stash.ts:241) + install root detection. Absent ⇒ whole root
  looksLikeRoot?(root: string): boolean;                    // install-time default-adapter probe (§4); replaces detectStashRoot/hasExtractedRepo
}
```

**Renderer/action = data table keyed on `type`** (plan §2.3; renames `asset-registry.ts:21-58` key from the closed type-enum to the open `type` string):

```ts
export const TYPE_PRESENTATION: Record<string, { renderer: string; action: (r: ItemRef) => string }> = {
  "knowledge": { renderer: "knowledge-md", action: (r) => `akm show ${r} -> read reference material` },
  "workflow":  { renderer: "workflow-md",  action: buildWorkflowAction },
  // one row per known type; UNKNOWN type ⇒ generic renderer + `akm show <ref>` (audit §8.7 — third-party OKF `type` values are expected and never dropped)
};
```

**Forbidden (hard boundary — audit §4; plan invariants):** an adapter MUST NOT own/perform search (never called at query time, invariant 7); own a proposal store/transaction/journal (returns `FileChange[]`/`Diagnostic[]`, core applies in one transaction); run git; register/mutate renderers; replace `ItemRef`/`FileChange`/`Diagnostic`/`Proposal`; run inside `improve` stages; or write during `index`/`recognize`.

`index` may default to a core walker that calls `recognize` per file (simple adapters: okf, skills); adapters needing whole-component context (llm-wiki cross-refs, workflow multi-file programs) override `index`.

---

## 3. IndexDocument + the OKF frontmatter projection

```ts
export interface IndexDocument {
  ref: ItemRef;             // "<bundle>/<local-id>"   (local-id = OKF concept ID)
  bundle: BundleId;
  component: ComponentId;   // PROVENANCE column, not a ref segment (§1.3)
  localId: string;          // opaque; core does not parse
  path: string;             // absolute local path (the read path; invariant 8)
  hash: string;             // content hash (incrementality §4 + OKF link key §9)
  adapterId: string;
  type?: string;            // = OKF `type`; open string; from frontmatter (OKF-native) or adapter-derived (foreign). Unknown types stay searchable

  name: string;             // FTS name(10)  ← OKF `title` (fallback filename)
  description?: string;     // FTS description(5) ← OKF `description`
  tags?: string[];          // FTS tags(3)   ← OKF `tags` (+ aliases)
  hints?: string[];         // FTS hints(2)
  content?: string;         // FTS content(1) — bounded body text
  updated?: string;         // ← OKF `timestamp` (ISO-8601)
  links?: string[];         // resolved bundle-relative OKF links = relationships (§9)

  documentJson?: unknown;   // opaque adapter extras (incl. arbitrary OKF frontmatter keys); NOT an FTS field, NOT parsed by core
}
```

Persisted index.db columns migrate `entry_key/stash_dir/entry_type/entry_json` → `item_ref/bundle_id/component_id/local_id/adapter_id/type/file_path/content_hash/document_json` (audit §8.4), keeping the integer row id for FTS/vector joins and the embeddings table keyed to it.

**FTS5 schema and bm25 weights are UNCHANGED and load-bearing** (schema.ts:159; db.ts:1024 `bm25(entries_fts, 0, 10.0, 5.0, 3.0, 2.0, 1.0)`). `buildSearchFields(IndexDocument)` replaces `buildSearchFields(StashEntry)` (search-fields.ts:34-85) as a direct map:

| FTS column | Weight | IndexDocument ← OKF |
|---|---|---|
| name | **10** | `name` ← OKF `title` |
| description | **5** | `description` ← OKF `description` |
| tags | **3** | `tags` (+aliases) ← OKF `tags` |
| hints | **2** | `hints` (adapter-folded: examples/usage/whenToUse/xrefs) |
| content | **1** | bounded body |

The deterministic hybrid nDCG/MRR/recall/banned-hit benchmark (audit §8.1) gates the cutover; weights and columns do **not** move (plan §1.4).

### 3.4 Known-`type` presentation set (not a closed union, not a "pin")

The deleted closed union is **not** replaced by another closed set. AKM simply has `TYPE_PRESENTATION` (§2) + ranking rules (`ranking-contributors.ts:11` `TYPE_BOOST`, `salience.ts:135` type-encoding weights) for the **known** `type` values it renders/ranks specially. Any other `type` (a third-party OKF `Metric`) renders generically and is fully searchable (audit §8.7). A single lint keeps the *spelling* of the known-type set consistent across the presentation + ranking tables + `parseRefPrefixQuery` (`db-search.ts:320`) + base-linter `REF_RE` — it does **not** constrain what `type` values may exist.

---

## 4. Indexing loop, incrementality, registry

**Scan loop** (replaces `akmIndex` per-source walk, indexer.ts:505/828-926 + wiki branch :837-869):

```ts
for (const inst of ctx.installations)
  for (const c of inst.components) {
    const a = ctx.adapters.get(c.adapter); if (!a) { warnUnknownAdapter(c); continue; }
    const docs = []; for await (const d of a.index(inst, c)) docs.push(d);
    persistComponent(ctx.indexDb, inst.id, c.id, a.id, docs);   // one txn, truncate-and-rewrite this component's rows (fixes utility_scores_scoped, plan §7.5/B4)
  }
```

Dedup by `ItemRef` (duplicate refs = lint error, audit §12.3). **Deleted from this loop:** matcher specificity, registration-order tiebreak, `classifyBySmartMd`, wiki-root scan, `TYPE_DIRS` branches, `.stash.json` overlay (audit §8.2).

**Incrementality** (mount-scoped; replaces `hasNewerIndexableFiles`'s `ASSET_SPECS×TYPE_DIRS` loop, ensure-index.ts:84-103):

```ts
interface ComponentScanState { bundle: BundleId; component: ComponentId; scanGeneration: number; adapterVersion: string; files: Record<string, { hash: string; mtimeMs: number }>; }
```

Re-index when `adapterVersion` changed (full invalidation), or a file under `directoryList()` has newer mtime / hash mismatch / new path / deletion. A single changed file calls `recognize` for just that file and upserts one row. State lives in the regenerable index.db keyed by `(bundle,component)`.

**Registry** (replaces `registerBuiltinMatchers`, matchers.ts:316; mutable `matchers[]` + reg-order tiebreak, file-context.ts:178/257): a **static frozen** `BUILTIN_ADAPTERS` map resolved by id. One adapter per component root, selected once (§1.2), never a per-file contest. Install-time default via `looksLikeRoot` (deterministic registry order), defaulting to **`okf`**. Unknown `type` ⇒ searchable + generic renderer; unknown `adapter` id ⇒ component skipped with a warning, others index normally.

---

## 5. The foundational `okf` adapter (default)

The reference adapter; AKM's own content uses it (or a tool translator that produces the same concepts). It is pure OKF: **`type` from frontmatter, identity from path, no directory routing.**

- **recognize:** any `.md` under the component root that is **not** a reserved OKF file (`index.md`, `log.md`) → one concept. `type` = frontmatter `type` (OKF required); if absent, default `"knowledge"` and emit a `missing-type` info hint. No directory-name gate — an OKF bundle organizes concepts however it likes (OKF §1). README carve-out preserved (`matchers.ts:193`).
- **localId:** OKF concept ID = relative path minus `.md` (`markdownSpec.toCanonicalName`, asset-spec.ts:91-95). Category subdirs preserved (`tools/docker`).
- **placeNew:** writable; `<localId>` → `<localId>.md` (asset-spec.ts:96-100). New files carry OKF frontmatter (`type`, `title`, `description`, `tags`, `timestamp`).
- **directoryList:** the component root (`["."]`) — OKF concepts may live anywhere; not restricted to `knowledge/`.
- **renderer/action:** from `TYPE_PRESENTATION` keyed on the file's `type` (default `knowledge-md`).
- **validate (LENIENT — OKF interoperability):** `runBaseChecks` (unquoted-colon, missing-updated→`timestamp`, stale-path) only. **Unknown frontmatter keys never fail** (OKF: consumers MUST NOT reject unrecognized fields). `missing-ref` on OKF bundle-relative links is a **warning**, not an error (OKF: consumers MUST tolerate broken links). `missing-type` is an **info** hint (AKM defaults it).
- **Reserved files:** `index.md` (directory listing) and `log.md` (update history) are recognized as reserved, **not** indexed as concepts. Root `index.md` may carry `okf_version`. AKM does **not** regenerate `index.md` at index time (the deleted wiki regeneration, plan §12.1, does not return — `index.md` is producer-authored).

---

## 6. The `type` values AKM recognizes (AKM's OKF-type profile)

**These are `type` values, not adapters** (§0.3). Each former AKM asset type is now an OKF `type` value AKM renders/ranks/validates specially. For AKM-native content they are **authored in frontmatter** and read by the `okf` adapter; for foreign layouts they are **derived** by a translator (`claude`/`opencode`/`agent-skills`). There is **no `command` adapter or `skill` adapter** — those were the old type-routing (`ASSET_SPECS_INTERNAL`, asset-spec.ts:129-259; `matchers.ts` `DIR_TYPE_MAP`), now deleted.

The table is a **`type` reference**: for each type, the validator AKM applies (as a shared function, per §0.3 rule 2), and — for the foreign translators only — the directory/filename convention they use to derive it. Presentation (`renderer`/`action`) is keyed on `type` via `TYPE_PRESENTATION` (§2), identical across adapters.

| `type` | native OKF? | foreign-derivation convention (translators only) | type-specific validation | renderer |
|---|---|---|---|---|
| knowledge | yes | — (default when `type` absent) | base only | knowledge-md |
| command | yes | `.md` under `commands/` (matchers.ts:49) + `$ARGUMENTS`/`agent`-fm probe | `missing-name-or-type`; type∈`{command}` (command-linter.ts) | command-md |
| agent | yes | `.md` under `agents/` (matchers.ts:53) + `tools`/`toolPolicy`/`model` probe | `missing-name-or-type`; type∈`{agent}` (agent-linter.ts) | agent-md |
| skill | yes | `SKILL.md` (matchers.ts:132,152); item = the dir | `missing-skill-md` (skill-linter.ts:31) **+ NEW Anthropic contract** name≤64/desc≤1024/body<~500 lines | skill-md |
| memory | yes | `.md` under `memories/` (matchers.ts:65) | `orphaned-stub` (delete fix) (memory-linter.ts) | memory-md |
| lesson | yes | `.md` under `lessons/` (matchers.ts:73) | base | lesson-md |
| fact | yes | `.md` under `facts/` ancestor (matchers.ts:104) | `missing-category`∈`{personal,team,project,convention,meta}` (fact-linter.ts) | fact-md |
| session | yes | `.md` under `sessions/` ancestor (matchers.ts:100) | base | session-md |
| instruction | yes | root `CLAUDE.md`/`AGENTS.md` (**NEW**, tool translators) | base | knowledge-md |
| workflow | **ext** | `.md`/`.yaml`/`.yml` workflow (matchers.ts:198,300); markdown form is OKF-ish, YAML program is an AKM extension | `placeholder-stub` (delete-file fix), `invalid-workflow-structure` (workflow-linter.ts) | workflow-md / workflow-program-yaml |
| task | **AKM ext** | `.yml` under `tasks/` (asset-spec.ts:221) — YAML, not an OKF markdown concept | `invalid-task-yaml`: schedule+enabled+one target (task-linter.ts) | task-yaml |
| env | **AKM ext** | `.env`/`*.env` under `env/` — **key NAMES only, values never indexed** | dangerous-key warn scan (env-key-rules.ts) | env-file |
| secret | **AKM ext** | any file under `secrets/` minus `.lock`/`.sensitive` — **filename only, value never indexed** | dangerous-key scan; `classifyBySmartMd` bails on `secrets/` (matchers.ts:185) | secret-file |
| website | derived | website crawl snapshot (§7); read-only | base (read-only) | knowledge-md |
| script | **AKM ext** | 17 `SCRIPT_EXTENSIONS` (asset-spec.ts:104); localId keeps extension | none | script-source |

**wiki → knowledge fold** (plan §4.5, Chunk 4): `wiki` dies as a `type`; its pages become OKF `knowledge` concepts; broken-xref folds into base-linter `missing-ref`; `wikiRole`/`pageKind` drop into knowledge; everything else in `wiki/wiki.ts` (1182 LOC) is deleted. **6 renderer mappings** (script/skill/command/agent/knowledge/memory carried no `rendererName` on their old spec, plan §2.3) live only in `TYPE_PRESENTATION` now.

---

## 7. The adapter set (format families)

An **adapter is a format family** (§0.3), selected once per component root, emitting one or more **`type`** values. Markdown types are valid OKF concepts; executable/sensitive types are AKM extensions. A **"tool directory"** (`.claude`, `.opencode`) is a **component** whose adapter translates a coding tool's layout into OKF concepts — the `claude`/`opencode` adapters are foreign-format translators that *derive* `type` from directory; every other adapter reads `type` from OKF frontmatter or a native schema. No adapter competes per-file.

| adapter | format family / root | types emitted | localId | writable | owning dirs | validate | notes |
|---|---|---|---|---|---|---|---|
| **okf** (§5) | generic OKF markdown; `type` from **frontmatter**, no dir routing | any OKF `type` (default `knowledge`) | path−.md (OKF concept ID) | yes | `.` | lenient/base (§5) | **the foundation**; AKM-native content + third-party OKF |
| **akm** | AKM workspace: OKF markdown **+** AKM extensions (workflow/task/env/secret/script) under the workspace layout | the full §6 profile | OKF concept ID | yes (markdown/workflow/task); env/secret metadata-only | AKM subdirs (§6) | per-type (§6), shared fns | AKM's own workspace bundle; markdown types are OKF, the rest are extensions |
| **claude** | `.claude` tool dir — **translator**, derives `type` from dir (matchers.ts:41-113,133) | command, agent, skill, instruction | `<type>/<relpath−.md>` | yes | `commands,agents,skills` | command/agent frontmatter; skill SKILL.md contract (shared fns) | AKM workspace layout **is** `.claude` minus the prefix |
| **opencode** | `.opencode` tool dir — translator (**NEW**) | command, agent, instruction | `<type>/<relpath−.md>` | yes | `command,agent` | command/agent frontmatter | `AGENTS.md`=instruction; `config.json` **not indexed** (invariant 15) |
| **agent-skills** | standalone `SKILL.md` packages (matchers.ts:152) — translator, derives `type: skill` | skill | `<dirname>` | yes | `skills` or `.` | `missing-skill-md` + **NEW** Anthropic contract | SKILL.md codec shared with claude as functions |
| **website** | crawl snapshot (website-ingest.ts:180) — derives `type: website` | website | url slug | **no (Mode A)** | `knowledge` | base (read-only) | Mode B export routes `content` through the destination `okf` adapter + FileChange txn; **NEW** frontmatter: canonical-vs-fetched URL, contentHash, links, ETag |
| **generic-files** | any leftover file (audit §8.7) | document/script/file | path+ext | yes | `.` | base for text; integrity only | unknown-format-stays-searchable |

Instruction files (`CLAUDE.md`, `AGENTS.md`) are **NEW** (audit §12.2). Tool config files (`settings.json`, `config.json`) are runtime-config, read by `config-import.ts`, **never indexed** (invariant 15). The website snapshot machinery + all SSRF/redirect/byte/depth/wall-clock/stale-fallback protections are **preserved** (website-ingest.ts:667-731,346-378,316,265-297,122-149); `sources/wiki-fetchers/`→`snapshot-fetchers/`, the one-element youtube registry inlines (plan §13.1, §4.6).

---

## 8. Multi-component resolution (RESOLVED)

**One adapter per native tool directory, emitting the `type`s that directory natively contains** — the `claude` adapter emits command/agent/skill/instruction, **not** three sub-components. Grounded in code: recognition has always been per-file multi-type via one `DIR_TYPE_MAP` (matchers.ts:41-113) with no per-type ownership object; the audit's config example (§7.2) models `.claude` as one component/one adapter; and after drop-ref `type` is a label, not an adapter boundary — splitting by `type` would resurrect "type is identity." The multi-component invariant (a bundle may hold multiple adapter-governed components) is about **heterogeneous roots** (an `okf` knowledge component *and* a `workflows/` component *and* a `.claude/` component), not splitting one tool directory.

The single genuine cross-format overlap — `.claude/skills/<n>/SKILL.md` is byte-identical to a standalone Agent Skill — is resolved by factoring the SKILL.md contract into **shared plain functions** (recognize predicate, localId rule, the validators) imported by both the `claude` and `agent-skills` adapters. Shared code, not shared/nested adapters (plan §13.3).

```
bundle "team-knowledge" (OKF)
├── index.md  (okf_version: "0.1")          ← reserved, not a concept
├── component { root: ".",         adapter: "okf" }         → type from frontmatter (knowledge, …)
├── component { root: "workflows", adapter: "akm-workflow" } → type=workflow
└── component { root: ".claude",   adapter: "claude" }       → type=command|agent|skill|instruction (derived)
```

---

## 9. Relationships: OKF links replace LLM graph extraction

OKF bundle-relative markdown links (`[x](/tables/customers.md)`, `[y](./other.md)`) **are relationships** (OKF §4). The `okf` adapter resolves them at `index` time into `IndexDocument.links` (target concept IDs), keyed by `bundle_id + local_id + content_hash` (audit §9.3). This is the **deterministic native link graph** the plan wants first (audit §9.2), and it **decides the residual-audit graph-extraction prove-or-delete in OKF's favor**: LLM graph extraction (~4,288 LOC, plan §13.2) is superseded by deterministic OKF links for OKF/knowledge bundles. If retained at all it is an optional index processor over non-OKF formats only, gated on measured nDCG lift. Broken links are tolerated (warning, never a hard failure), so relationship extraction never blocks indexing.

---

## 10. Grounding index (what each element replaces)

| New element | Replaces | file:line |
|---|---|---|
| OKF bundle + `okf` adapter | `AssetSpec` knowledge + `stashDir` root | asset-spec.ts:142; config-types.ts:99 |
| `ItemRef` `<bundle>/<local-id>` = OKF concept ID | `AssetRef{type,name,origin}` | asset-ref.ts:11-116 |
| open OKF **`type`** (frontmatter) | closed `AkmAssetType` union + `entry_type` | common.ts:29-88; asset-ref.ts:109 |
| `IndexDocument` (OKF projection) | `StashEntry` (~40 fields) | metadata.ts:60-189 |
| `BundleAdapter.recognize/index` | `runMatchers` + `classifyBy*` + walker | file-context.ts:242-265; matchers.ts:151-305; walker.ts:73 |
| `placeNew`/`directoryList` | `TYPE_DIRS` + `resolveAssetPathFromName` | asset-spec.ts:140-226; path-resolver.ts:27-38 |
| `validate`→`Diagnostic[]` (lenient for OKF) | `LINTER_MAP` + 9 linters | lint/registry.ts:32-47 |
| `TYPE_PRESENTATION` table (keyed on open `type`) | `TYPE_TO_RENDERER`/`ACTION_BUILDERS` + spec split-brain | asset-registry.ts:21-58; asset-spec.ts:27-33 |
| OKF links → `IndexDocument.links` | LLM graph extraction | indexer/graph/* (plan §13.2) |
| static `BUILTIN_ADAPTERS` | `registerBuiltinMatchers` | matchers.ts:316-320 |
| `bundles`/`defaultBundle` + `okf_version` | `stashDir`/`sources[]`/`installed[]`/`wikiName` | config-types.ts:99-116 |

---

## References / Citations

**OKF (Open Knowledge Format)** — the foundational metadata format (§0):

- Open Knowledge Format v0.1 specification — `GoogleCloudPlatform/knowledge-catalog`, `okf/SPEC.md`: <https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md> (concept identity = file path − `.md`; required open `type`; recommended `title`/`description`/`resource`/`tags`/`timestamp`; reserved `index.md`/`log.md`; bundle-relative links as relationships; `okf_version`; consumers MUST NOT reject unknown fields and MUST tolerate broken links).
- Google Cloud, "How the Open Knowledge Format can improve data sharing" (announcement, June 12, 2026): <https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/>
- OKF annotated guide: <https://okf.md/spec/>

**Anthropic Agent Skills** — the `SKILL.md` L1 contract cited for the `skill` type and the `agent-skills` adapter (§6, §7): Anthropic, *Agent Skills* documentation (SKILL.md authoring: `name` ≤64 chars, `description` ≤1024 chars stating what+when, body kept under ~500 lines, progressive disclosure) — docs.anthropic.com, Agent Skills.

**AKM** — companion design docs in this directory (`akm-0.9.0-bundle-adapter-architecture-plan.md`, `akm-0.9.0-residual-complexity-audit.md`, `akm-0.9.0-greenfield-vs-refactor-decision.md`) and the current source at HEAD; all `file:line` references are to that tree.
