# AKM 0.9.0 — Bundle Adapter Specification

**Status:** binding implementation spec. Companion to `akm-0.9.0-bundle-adapter-architecture-plan.md` (the *what/why/deletion* plan); this is the *how* an implementer builds the bundle/adapter core (plan Chunks 1–5) from. Every element is grounded in real code at HEAD as `file:line`, or marked **NEW** with the mandate.

**Foundational decision:** AKM bundles are **OKF (Open Knowledge Format)** bundles. OKF is the foundational metadata format; AKM is OKF-compatible **by default** — an AKM knowledge bundle *is* a valid OKF bundle, and a third-party OKF bundle indexes in AKM with no translation. All other formats (Claude, OpenCode, Agent Skills, workflows, tasks, env, website) are adapters layered around the OKF core, expressing their native metadata into the same OKF-shaped normalized model.

---

## 0. OKF as the foundational metadata format

OKF v0.1 (Google Cloud, June 2026 — [SPEC](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)) defines a **bundle** as a directory tree of markdown "concept" files, each `--- YAML frontmatter --- ` + markdown body, where **the file path is the concept's identity** and the only required field is an open, producer-defined **`type`**. This maps onto the approved drop-ref architecture almost exactly — which is why OKF is adopted as the base rather than an AKM-proprietary metadata schema.

### 0.1 OKF ⇄ AKM mapping (the foundation every adapter conforms to)

| OKF v0.1 | AKM bundle-adapter model | Consequence |
|---|---|---|
| Bundle = directory tree of markdown concepts | AKM **bundle**; the `okf` adapter is the **default/foundational** adapter (§5) | An AKM knowledge component and an OKF bundle are the same thing on disk |
| **Concept ID** = file path with `.md` removed (`tables/users.md` → `tables/users`) | AKM opaque **`localId`** in `ItemRef = <bundle>/<local-id>` (§1.3) | Path-based identity is not an AKM invention — it is the OKF contract; drop-ref *is* OKF-alignment |
| Required **`type`** (short open string: `Metric`, `Playbook`, `BigQuery Table`) | AKM **`kind`** — open descriptive provenance string, **not** identity, pinned only by §3.4 | AKM drops `type` from the *ref*, keeps it as the OKF `type` *frontmatter field*; every AKM concept carries an OKF `type` |
| Recommended **`title`** | IndexDocument `name` (FTS weight 10) — read `title` first, fall back to `name`/filename; **write `title`** | OKF-compatible output |
| Recommended **`description`** | IndexDocument `description` (weight 5) | direct |
| Recommended **`tags`** (YAML list) | IndexDocument `tags` (weight 3) | direct |
| Recommended **`timestamp`** (ISO-8601 last change) | provenance/`updated`; the base-linter `missing-updated` check reconciles to `timestamp` | OKF-compatible freshness |
| Recommended **`resource`** (URI of the underlying asset) | IndexDocument provenance (`sourceRef`) / a hint | carried, not required |
| Reserved **`index.md`** (directory listing), **`log.md`** (update history) | reserved filenames — **not indexed as ordinary concepts** (§5.3) | AKM must not treat `index.md`/`log.md` as concepts |
| Bundle-relative markdown links `[x](/tables/customers.md)` = a **relationship** | the **deterministic native link/relationship graph** (§9) | replaces LLM graph extraction (audit §9.2 "deterministic native links first"); the residual-audit's graph-extraction prove-or-delete is decided in OKF's favor |
| **`okf_version: "0.1"`** in root `index.md` frontmatter | bundle manifest version field (§1.2) | AKM emits `okf_version` on bundles it creates |
| Consumers **MUST NOT reject** unknown fields; **MUST tolerate** broken links | OKF adapter `validateL1` is **lenient**: base checks only; unknown frontmatter is fine; broken bundle-relative links are a **warning**, never a hard error (§5.4) | interoperability guarantee |

### 0.2 What "OKF is foundational" binds

1. **The normalized model (`IndexDocument`, §3) is an OKF projection.** Its `name`/`description`/`tags`/`kind`/`updated` map to OKF `title`/`description`/`tags`/`type`/`timestamp`. Non-OKF adapters (Claude, workflow, task…) project their native metadata *into* these same fields, so search is uniform and OKF-shaped.
2. **The `okf` adapter is the default adapter** for a generic markdown bundle and the default writable destination for `remember`, distill promotion, and website→native export (§5).
3. **AKM writes OKF-compatible bundles.** New knowledge files carry OKF frontmatter (`type`, `title`, `description`, `tags`, `timestamp`); bundles AKM creates carry `okf_version` and may carry `index.md`/`log.md`; cross-references use OKF bundle-relative links.
4. **`kind` is OKF `type`.** The closed `AkmAssetType` union dies (plan §4.1); `kind` becomes the open OKF `type` string, guarded by a provenance-string-set lint (§3.4), never a union.

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

1. **Root `index.md` with `okf_version`** — an OKF bundle self-declares. Present ⇒ the bundle is OKF; the `okf` adapter (§5) governs its markdown concepts, and any tool sub-trees (`.claude/`, `workflows/`) are additional components (§8).
2. **Optional AKM bundle manifest** (`akm-bundle.yaml`, `schemaVersion: 1`) — declares heterogeneous component roots + adapters verbatim (audit §7.2). The **only** new file format 0.9.0 adds, and it is optional. It SHOULD carry `okf_version: "0.1"` for the OKF components it declares.
3. **Workspace config `bundles` map** (§1.4).
4. **Single-component default** — no manifest, no override ⇒ one component `{ id:"main", root:".", adapter:<selected> }`; the adapter is chosen by install-time root recognition (§4.3), defaulting to **`okf`** for a generic markdown tree.

There is no directory→type inference table (`DIR_TYPE_MAP`, `TYPE_DIRS`) in this path. A `workflows/` directory is a workflow component only because a manifest/config says so, not because the name matched a global rule.

### 1.3 ItemRef grammar — **two segments** `<bundle>/<local-id>` (= OKF concept ID)

Core parses **only the first `/`**; everything after is the adapter-owned opaque `localId`, which for the OKF adapter **is the OKF concept ID** (file path minus `.md`). `component` is a **column** on the row (§3), **not** a ref segment.

```
personal/http-caching            # local-id "http-caching"        (OKF: knowledge/http-caching.md? no — component root; see below)
team/tables/orders               # local-id "tables/orders"       (OKF concept ID, second "/" is inside local-id)
project-claude/command/test      # local-id "command/test"        (claude adapter kind-prefixed, §7)
```

**Justification (plan §3.1/§6.2; audit §6; OKF §Concept Identity):** identity must not encode a reclassifiable/relocatable dimension. `type` was such a dimension (reclassifying renamed the ref); **component is equally reclassifiable** (a manifest edit moves a root between adapters). So component is **provenance (a column)**, not identity — matching OKF, where identity is purely the file path. This deliberately rejects the audit §3 three-segment `<bundle>/<component>/<local-id>` sketch in favor of the plan's approved two-segment form and OKF's path-is-identity rule. `asset-ref.ts` survives as a **pure parser** (grammar + `makeAssetRef`/`refToString` + traversal/null-byte/drive-letter guards `:121-136`); the closed union `isAssetType` `:109`, `TYPE_ALIASES` `:25`, and origin `//` parsing are deleted (plan §4.1).

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

Replaces: `stashDir`→`bundles`+`defaultBundle`; `ConfiguredSource.primary`→`defaultBundle`; `ConfiguredSource.writable`→per-component `writable`; `wikiName`→a component with `adapter:"llm-wiki"` (folded to `okf`/knowledge in 0.9.0, see plan §4.5). Per plan §13.3, **no `workspace_bindings`/export-digest/trust-layer ships in 0.9.0** — `trusted` is a per-installation boolean; activation stays implicit.

---

## 2. The adapter contract (one interface; no facet hierarchy)

Per plan §13.3 there is **no** `AuthoringAdapter`/`ExportAdapter`/`MemoryLifecycleAdapter` hierarchy. One interface; optional capabilities are optional **methods**; renderer/action is a **data table**, not code.

```ts
export interface BundleAdapter {
  readonly id: string;                                    // "okf" | "claude" | "opencode" | "agent-skills" | "akm-workflow" | ... | "website" | "files"

  // REQUIRED — recognition + indexing (read-only over user content; invariant 9)
  index(inst: BundleInstallation, c: BundleComponent): AsyncIterable<IndexDocument>;   // full/first scan; replaces walkStashFlat + wiki branch + shouldIndexStashFile (walker.ts:73; indexer.ts:837; metadata.ts:687)
  recognize(c: BundleComponent, file: FileContext): IndexDocument | null;              // single-file primitive for the incremental + post-write path; replaces the whole matcher stack (matchers.ts:151-305; file-context.ts:242-265). null = not indexed by this adapter (infra file, README, index.md/log.md)

  // REQUIRED — native validation (called by the change transaction pre-commit, and by lint --fix); returns Diagnostic[]; adapter MUST NOT write. Replaces LINTER_MAP + 9 linters (lint/registry.ts:32-47)
  validate(c: BundleComponent, changes: FileChange[]): Promise<Diagnostic[]>;

  // OPTIONAL capability methods (present only where behavior differs)
  placeNew?(c: BundleComponent, localId: string): string;   // new-item path; replaces TYPE_DIRS + resolveAssetPathFromName + buildDiskCandidates (path-resolver.ts:27-38). Absent ⇒ read-only for creation
  directoryList?(c: BundleComponent): string[];             // dirs this adapter owns; feeds git exact-path staging (git-stash.ts:241) + install root detection. Absent ⇒ whole root
  looksLikeRoot?(root: string): boolean;                    // install-time default-adapter probe (§4.3); replaces detectStashRoot/hasExtractedRepo
}
```

**Renderer/action = data table** (plan §2.3; renames `asset-registry.ts:21-58` key from `type`→`kind`):

```ts
export const KIND_PRESENTATION: Record<string, { renderer: string; action: (r: ItemRef) => string }> = {
  "knowledge": { renderer: "knowledge-md", action: (r) => `akm show ${r} -> read reference material` },
  "workflow":  { renderer: "workflow-md",  action: buildWorkflowAction },
  // one row per kind; UNKNOWN kind ⇒ generic renderer + `akm show <ref>` (audit §8.7 — OKF open `type` values are expected and never dropped)
};
```

**Forbidden (hard boundary — audit §4; plan invariants):** an adapter MUST NOT own/perform search (never called at query time, invariant 7); own a proposal store/transaction/journal (returns `FileChange[]`/`Diagnostic[]`, core applies in one transaction); run git; register/mutate renderers; replace `ItemRef`/`FileChange`/`Diagnostic`/`Proposal`; run inside `improve` stages (no arbitrary hook); or write during `index`/`recognize`.

`index` may default to a core walker that calls `recognize` per file (simple single-file adapters: okf, skills, commands); adapters needing whole-component context (llm-wiki cross-refs, workflow multi-file programs) override `index`.

---

## 3. IndexDocument + the OKF frontmatter projection

```ts
export interface IndexDocument {
  ref: ItemRef;             // "<bundle>/<local-id>"   (local-id = OKF concept ID)
  bundle: BundleId;
  component: ComponentId;   // PROVENANCE column, not a ref segment (§1.3)
  localId: string;          // opaque; core does not parse
  path: string;             // absolute local path (the read path; invariant 8)
  hash: string;             // content hash (incrementality §4 + OKF link/relationship key §9)
  adapterId: string;
  kind?: string;            // = OKF `type` — open descriptive string; unknown kinds stay searchable

  name: string;             // FTS name(10)  ← OKF `title` (fallback `name`, then filename)
  description?: string;     // FTS description(5) ← OKF `description`
  tags?: string[];          // FTS tags(3)   ← OKF `tags` (+ aliases)
  hints?: string[];         // FTS hints(2)
  content?: string;         // FTS content(1) — bounded body text
  updated?: string;         // ← OKF `timestamp` (ISO-8601)
  links?: string[];         // resolved bundle-relative OKF links = relationships (§9)

  documentJson?: unknown;   // opaque adapter extras (incl. arbitrary OKF frontmatter keys); NOT an FTS field, NOT parsed by core
}
```

Persisted index.db columns migrate `entry_key/stash_dir/entry_type/entry_json` → `item_ref/bundle_id/component_id/local_id/adapter_id/kind/file_path/content_hash/document_json` (audit §8.4), keeping the integer row id for FTS/vector joins and the embeddings table keyed to it.

**FTS5 schema and bm25 weights are UNCHANGED and load-bearing** (schema.ts:159; db.ts:1024 `bm25(entries_fts, 0, 10.0, 5.0, 3.0, 2.0, 1.0)`). `buildSearchFields(IndexDocument)` replaces `buildSearchFields(StashEntry)` (search-fields.ts:34-85) as a direct map:

| FTS column | Weight | IndexDocument ← OKF |
|---|---|---|
| name | **10** | `name` ← OKF `title` |
| description | **5** | `description` ← OKF `description` |
| tags | **3** | `tags` (+aliases) ← OKF `tags` |
| hints | **2** | `hints` (adapter-folded: examples/usage/whenToUse/xrefs) |
| content | **1** | bounded body |

The deterministic hybrid nDCG/MRR/recall/banned-hit benchmark (audit §8.1) gates the cutover; weights and columns do **not** move (plan §1.4).

### 3.4 Provenance-type (`kind`) string-set pin

The deleted closed union is replaced by a lint/test pinning the open `kind` set (= the OKF `type` values AKM's own adapters emit), sourced from adapter metadata, covering every consumer that parsed the old closed list: `db-search.ts:320` `parseRefPrefixQuery`, base-linter `REF_RE`, `ranking-contributors.ts:11` `TYPE_BOOST`, `salience.ts:135` `DEFAULT_TYPE_ENCODING_WEIGHTS`. Third-party OKF `type` values not in the set are still fully searchable (audit §8.7) — the pin governs only AKM's own kind-keyed logic.

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

Dedup by `ItemRef` (duplicate refs = lint error, audit §12.3), replacing cross-stash `(type+filename+description)` identity (indexer.ts:948). **Deleted from this loop:** matcher specificity, registration-order tiebreak, `classifyBySmartMd`, wiki-root scan, `TYPE_DIRS` branches, `.stash.json` overlay (audit §8.2).

**Incrementality** (mount-scoped; replaces `hasNewerIndexableFiles`'s `ASSET_SPECS×TYPE_DIRS` loop, ensure-index.ts:84-103):

```ts
interface ComponentScanState { bundle: BundleId; component: ComponentId; scanGeneration: number; adapterVersion: string; files: Record<string, { hash: string; mtimeMs: number }>; }
```

Re-index when `adapterVersion` changed (full invalidation), or a file under `directoryList()` has newer mtime / hash mismatch / new path / deletion. A single changed file calls `recognize` for just that file and upserts one row. State lives in the regenerable index.db keyed by `(bundle,component)`.

**Registry** (replaces `registerBuiltinMatchers`, matchers.ts:316; mutable `matchers[]` + reg-order tiebreak, file-context.ts:178/257): a **static frozen** `BUILTIN_ADAPTERS` map resolved by id. One adapter per component root, selected once (§1.2), never a per-file contest. Install-time default via `looksLikeRoot` (deterministic registry order), defaulting to **`okf`**. Unknown `kind` ⇒ searchable + generic renderer; unknown `adapter` id ⇒ component skipped with a warning, others index normally.

---

## 5. The foundational `okf` adapter (default)

The reference adapter; every other markdown adapter is a specialization of it.

- **recognize:** any `.md` under the component root that is **not** a reserved OKF file (`index.md`, `log.md`) → one concept. `kind` = frontmatter `type` (OKF required) if present, else `"knowledge"` (AKM default). No directory-name gate — an OKF bundle organizes concepts however it likes (OKF §1). README carve-out preserved (`matchers.ts:193`).
- **localId:** OKF concept ID = relative path minus `.md` (`markdownSpec.toCanonicalName`, asset-spec.ts:91-95). Category subdirs preserved (`tools/docker`).
- **placeNew:** writable; `<localId>` → `<localId>.md` (asset-spec.ts:96-100). New files are written with OKF frontmatter (`type`, `title`, `description`, `tags`, `timestamp`).
- **directoryList:** the component root (`["."]`) — OKF concepts may live anywhere in the tree; not restricted to `knowledge/`. (An AKM-native stash's `knowledge/` subdir is just one OKF bundle layout.)
- **renderer/action:** `knowledge-md` / `akm show <ref> -> read the knowledge doc` (one of the 6 static-only mappings, plan §2.3 — stamped locally).
- **validateL1 (LENIENT — OKF interoperability):** `runBaseChecks` (unquoted-colon, missing-updated→reconciled to OKF `timestamp`, stale-path) only. **Unknown frontmatter keys never fail** (OKF: consumers MUST NOT reject unrecognized fields). `missing-ref` on OKF bundle-relative links is a **warning**, not an error (OKF: consumers MUST tolerate broken links). Optional `missing-type` **info** hint (OKF requires `type`; AKM defaults it, so this is advisory).
- **§5.3 reserved files:** `index.md` (directory listing) and `log.md` (update history) are recognized as reserved, **not** indexed as concepts. Root `index.md` may carry `okf_version`. AKM does **not** regenerate `index.md` at index time (the deleted wiki `index.md` regeneration, plan §12.1, does not return as OKF behavior — `index.md` is producer-authored).

---

## 6. AKM-native format adapters (OKF concepts with a native `kind`)

Each current AKM asset type becomes an OKF concept whose `type`/`kind` is the type name; recognition/placement/validation are faithful re-expressions of `ASSET_SPECS_INTERNAL` (asset-spec.ts:129-259), `matchers.ts`, the per-type linters, and `asset-registry.ts`. Full field-level detail (recognize rule, localId, placeNew, directoryList, renderer, validateL1) per format is in the native-format spec; summary:

| kind | recognize (source) | localId | placeNew | directoryList | validateL1 delta over base | renderer source |
|---|---|---|---|---|---|---|
| skill | `SKILL.md` (matchers.ts:132,152) — dir is the item | dir name (asset-spec.ts:133) | `<name>/SKILL.md` (:138) | `skills` | `missing-skill-md` (skill-linter.ts:31) **+ NEW Anthropic contract** name≤64/desc≤1024/body<~500 lines | static-only |
| command | `.md` under `commands/` + `$ARGUMENTS`/`agent`-fm probe (matchers.ts:49,209) | path−.md | `<name>.md` | `commands` | `missing-name-or-type`, type∈`{command}` (command-linter.ts) | static-only |
| agent | `.md` under `agents/` + `tools`/`toolPolicy`/`model` fm probe (matchers.ts:53,205) | path−.md | `<name>.md` | `agents` | `missing-name-or-type`, type∈`{agent}` (agent-linter.ts) | static-only |
| knowledge | `.md` under `knowledge/` (matchers.ts:57) — **= the OKF adapter §5** | path−.md | `<name>.md` | `knowledge` | base only (knowledge-linter.ts) | static-only |
| workflow | ext∈`.md/.yaml/.yml` + body/program probe (matchers.ts:198,300) | path−ext, `.md`>`.yaml`>`.yml` collapse (asset-spec.ts:66) | ext-aware (asset-spec.ts:73) | `workflows` | `placeholder-stub` (delete-file fix), `invalid-workflow-structure` (workflow-linter.ts) | spec-carried |
| script | ext∈17 SCRIPT_EXTENSIONS (asset-spec.ts:104) | path, **ext preserved** (:125) | verbatim (:126) | `scripts` | none (no linter) | static-only |
| memory | `.md` under `memories/` (matchers.ts:65) | path−.md | `<name>.md` | `memories` | `orphaned-stub` (delete fix) (memory-linter.ts) | static-only |
| lesson | `.md` under `lessons/` (matchers.ts:73) | path−.md | `<name>.md` | `lessons` | base (DefaultLinter) | spec-carried |
| task | `.yml` under `tasks/` (asset-spec.ts:221) | path−.yml | `<name>.yml` | `tasks` | `invalid-task-yaml`: schedule+enabled+one target (task-linter.ts) | spec-carried |
| session | `.md` under `sessions/` ancestor (matchers.ts:100) | path−.md | `<harness>/<id>.md` | `sessions` | none | spec-carried |
| fact | `.md` under `facts/` ancestor (matchers.ts:104) | path−.md | `<name>.md` | `facts` | `missing-category` ∈`{personal,team,project,convention,meta}` (fact-linter.ts) | spec-carried |
| env | `.env`/`*.env` under `env/` (asset-spec.ts:160) — **KEY NAMES ONLY, never values** | `.env`→`default`, `<n>.env`→`<n>` (:161) | `.env`/`<n>.env` | `env` | dangerous-key warn scan (env-key-rules.ts) | spec-carried |
| secret | any file under `secrets/` minus `.lock`/`.sensitive` (asset-spec.ts:190) — **filename only, value never indexed** | path (:191) | verbatim | `secrets` | dangerous-key scan; `classifyBySmartMd` bails on `secrets/` (matchers.ts:185) | spec-carried |

**wiki → knowledge fold** (plan §4.5, Chunk 4): `wiki` dies as a kind; its pages become OKF `knowledge` concepts; broken-xref folds into base-linter `missing-ref`; `wikiRole`/`pageKind` drop into knowledge; everything else in `wiki/wiki.ts` (1182 LOC) is deleted. **6 static-only renderer mappings** (script/skill/command/agent/knowledge/memory carry no `rendererName` on their spec) must be stamped by their adapters from `KIND_PRESENTATION` or the port loses them (plan §2.3).

---

## 7. Integration-format adapters (layered around the OKF core)

| adapter | root/recognize | kinds emitted | localId | writable | directoryList | validateL1 delta | notes |
|---|---|---|---|---|---|---|---|
| **claude** | `.claude/` dir-segment (matchers.ts:41-113,133) | command, agent, skill, instruction | `<kind>/<relpath−.md>` | yes | `commands,agents,skills` | command/agent type-check; skill SKILL.md contract (shared fns) | AKM stash layout **is** `.claude` minus the prefix; cheap relocation |
| **opencode** | `.opencode/` dir-segment (**NEW**) | command, agent, instruction | `<kind>/<relpath−.md>` | yes | `command,agent` | command/agent type-check | `AGENTS.md`=instruction; `config.json` **not indexed** (env-var keys, invariant 15) |
| **agent-skills** | `SKILL.md` (matchers.ts:152) | skill | `<dirname>` | yes | `skills` or `.` | `missing-skill-md` + **NEW** Anthropic name≤64/desc≤1024/body contract | standalone skill packages; SKILL.md codec shared with claude as functions |
| **okf** (§5) | any non-reserved `.md` | `type`/knowledge | path−.md (OKF concept ID) | yes | `.` | lenient/base only | **the foundation** |
| **website** | crawl-cache `knowledge/*.md` (website-ingest.ts:180) | website | url slug | **no (Mode A)** | `knowledge` | base (read-only no-op) | Mode B export routes `content` through the destination `okf` adapter + FileChange txn; **NEW** frontmatter: canonical-vs-fetched URL, contentHash, links, ETag |
| **generic-files** | any leftover file | document/script/file | path+ext | yes | `.` | base for text; integrity only otherwise | audit §8.7 unknown-kind-stays-searchable |

Instruction files (`CLAUDE.md`, `AGENTS.md`) are **NEW** (audit §12.2). Tool config files (`settings.json`, `config.json`) are runtime-config, read by `config-import.ts`, **never indexed** (invariant 15). The website snapshot machinery + all SSRF/redirect/byte/depth/wall-clock/stale-fallback protections are **preserved** (website-ingest.ts:667-731,346-378,316,265-297,122-149); `sources/wiki-fetchers/`→`snapshot-fetchers/`, the one-element youtube registry inlines (plan §13.1, §4.6).

---

## 8. Multi-component resolution (RESOLVED)

**One adapter per native tool directory, emitting the kinds that directory natively contains.** A `.claude` component uses the single `claude` adapter emitting command/agent/skill/instruction — **not** three sub-components. Grounded in code: recognition has always been per-file multi-kind via one `DIR_TYPE_MAP` (matchers.ts:41-113) with no per-type ownership object; the audit's own config example (§7.2) models `.claude` as one component/one adapter; and after drop-ref `kind` is a label, not an adapter boundary — splitting by kind would resurrect "type is identity." The multi-component invariant (a bundle may hold multiple adapter-governed components) is about **heterogeneous roots** (a bundle with an `okf` knowledge component *and* a `workflows/` component *and* a `.claude/` component), not splitting one tool directory.

The single genuine cross-format overlap — `.claude/skills/<n>/SKILL.md` is byte-identical to a standalone Agent Skill — is resolved by factoring the SKILL.md contract into **shared plain functions** (recognize predicate, localId rule, the three validateL1 layers) imported by both the `claude` and `agent-skills` adapters. Shared code, not shared/nested adapters (plan §13.3).

```
bundle "team-knowledge" (OKF)
├── index.md  (okf_version: "0.1")          ← reserved, not a concept
├── component { root: ".",         adapter: "okf" }         → kind=<type>/knowledge concepts
├── component { root: "workflows", adapter: "akm-workflow" } → kind=workflow
└── component { root: ".claude",   adapter: "claude" }       → kind=command|agent|skill|instruction
```

---

## 9. Relationships: OKF links replace LLM graph extraction

OKF bundle-relative markdown links (`[x](/tables/customers.md)`, `[y](./other.md)`) **are relationships** (OKF §4). The `okf` adapter resolves them at `index` time into `IndexDocument.links` (target concept IDs), keyed by `bundle_id + local_id + content_hash` (audit §9.3). This is the **deterministic native link/relationship graph** the plan wants first (audit §9.2), and it **decides the residual-audit graph-extraction prove-or-delete in OKF's favor**: LLM graph extraction (~4,288 LOC, §13.2) is superseded by deterministic OKF links for OKF/knowledge bundles. If retained at all it is an optional index processor over non-OKF formats only, gated on measured nDCG lift (§13.2). Broken links are tolerated (warning, never a hard failure), so relationship extraction never blocks indexing.

---

## 10. Grounding index (what each element replaces)

| New element | Replaces | file:line |
|---|---|---|
| OKF bundle + `okf` adapter | `AssetSpec` knowledge + `stashDir` root | asset-spec.ts:142; config-types.ts:99 |
| `ItemRef` `<bundle>/<local-id>` = OKF concept ID | `AssetRef{type,name,origin}` | asset-ref.ts:11-116 |
| `kind` = OKF `type` (open) | closed `AkmAssetType` union | common.ts:29-88; asset-ref.ts:109 |
| `IndexDocument` (OKF projection) | `StashEntry` (~40 fields) | metadata.ts:60-189 |
| `BundleAdapter.recognize/index` | `runMatchers` + `classifyBy*` + walker | file-context.ts:242-265; matchers.ts:151-305; walker.ts:73 |
| `placeNew`/`directoryList` | `TYPE_DIRS` + `resolveAssetPathFromName` | asset-spec.ts:140-226; path-resolver.ts:27-38 |
| `validate`→`Diagnostic[]` (lenient for OKF) | `LINTER_MAP` + 9 linters | lint/registry.ts:32-47 |
| `KIND_PRESENTATION` table | `TYPE_TO_RENDERER`/`ACTION_BUILDERS` + spec split-brain | asset-registry.ts:21-58; asset-spec.ts:27-33 |
| OKF links → `IndexDocument.links` | LLM graph extraction | indexer/graph/* (§13.2) |
| static `BUILTIN_ADAPTERS` | `registerBuiltinMatchers` | matchers.ts:316-320 |
| `bundles`/`defaultBundle` + `okf_version` | `stashDir`/`sources[]`/`installed[]`/`wikiName` | config-types.ts:99-116 |

---

## Sources

- OKF v0.1 spec — GoogleCloudPlatform/knowledge-catalog `okf/SPEC.md`; Google Cloud announcement (June 12, 2026).
- AKM plan/audit companions in this directory; current code at HEAD.
