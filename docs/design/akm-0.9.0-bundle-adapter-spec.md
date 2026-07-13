# AKM 0.9.0 — Bundle Adapter Specification

**Status:** binding implementation spec, reconciled with `akm-format-neutral-bundle-workspace-spec.md` (the normative RFC) and `akm-architecture-decision-history.md` (decision register). This doc is the concrete *how* for the adapter/index/ref core; it **defers to the normative spec** for bindings (§18), improve (§24), and memory lifecycle (§25) rather than duplicate them. Grounded in code at HEAD as `file:line`, or **NEW** with the mandate.

**Reconciliation decisions applied (maintainer, 2026-07-13)** — resolving the deviations in `akm-plan-vs-spec-deviation-analysis.md`:

1. **OKF = HYBRID (DEV-1).** The kernel stays **format-neutral** (History D2): OKF is the **preferred interchange format and the reference/default adapter**, not a mandatory internal schema; Claude/OpenCode/Agent-Skills/workflow/task/env formats are native and are **not** forced through OKF. AKM adopts OKF's **field names** (`type`/`title`/`description`/`tags`/`timestamp`) and OKF's **path-based concept identity** as the shared vocabulary, so AKM is OKF-compatible by default. The field is **`type`** (open), which **MAY** drive presentation/ranking/filtering but **MUST NOT** authorize execution, grant runtime authority, be part of identity, or select the core storage/write path.
2. **Ref = OKF concept ID + optional `bundle//` prefix (DEV-2).** Identity is the OKF concept ID (path within the bundle, minus `.md`); the workspace-qualified ref prepends an optional `<bundle>//`. Component is **absorbed into the path**, not a separate ref segment.
3. **Bindings/activation, full memory lifecycle, and the third `consolidate` verb are IN SCOPE for 0.9.0 (DEV-3/4/5)** — reversing the earlier §13.3 scope-down. Retained simplifications: renderer/action as a **data table**, and adapter facets expressed as **optional methods** on one interface (History §8.3), not a rigid `extends` hierarchy.
4. **LLM Wiki adapter restored (DEV-7).** The `wiki` *asset type* dies; the **LLM Wiki adapter** is a first-class built-in owning `schema.md`/`index.md`/`log.md`/raw/pages/citations/xrefs/ingest.

---

## 0. OKF: preferred interchange + reference adapter (hybrid, format-neutral kernel)

OKF v0.1 (Google Cloud, June 2026 — [SPEC](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)) defines a bundle as a directory tree of markdown "concept" files (`--- frontmatter ---` + body) where **the file path is the concept's identity** and the only required field is an open **`type`**. AKM adopts OKF as its preferred interchange format and reference adapter, and reuses OKF's identity + field vocabulary so an AKM knowledge bundle *is* a valid OKF bundle and any OKF bundle indexes with no translation. **AKM does not make OKF its kernel object model** (History D2): native Claude/OpenCode/skill/workflow/task/env formats keep their own semantics behind their own adapters.

### 0.1 OKF ⇄ AKM: shared vocabulary (no translation for OKF; adapters translate the rest)

| OKF v0.1 | AKM | Note |
|---|---|---|
| Bundle = directory tree of markdown concepts | AKM **bundle**; `okf` is the **reference/default** adapter (§5) | AKM knowledge component == an OKF bundle on disk |
| **Concept ID** = file path − `.md` (`tables/users.md` → `tables/users`) | AKM **identity** = the same path within the bundle; the ref adds an optional `<bundle>//` prefix (§1.3) | path is identity (drop-ref == OKF-alignment) |
| Required **`type`** (open string) | AKM **`type`** — same field/name; open; **from frontmatter** (OKF-native) or **adapter-derived** (foreign). Presents/ranks/filters; **never** authorizes execution or identity | not a kernel switch; not `kind` |
| **`title`** | `name` (FTS 10) — read `title` first; write `title` | OKF-compat output |
| **`description`** | `description` (FTS 5) | direct |
| **`tags`** | `tags` (FTS 3) | direct |
| **`timestamp`** | `updated`; base-linter `missing-updated`→`timestamp` | OKF-compat freshness |
| **`resource`** (URI) | provenance (`sourceRef`) | carried |
| Reserved **`index.md`**/**`log.md`** | reserved, not indexed as concepts (§5) | |
| bundle-relative links = relationship | deterministic native link graph (§9) | replaces LLM graph extraction for OKF content |
| **`okf_version`** | bundle manifest version | AKM emits on bundles it creates |
| consumers MUST tolerate unknown fields + broken links | `okf` adapter `validate` is **lenient** (§5) | interop guarantee |

### 0.2 The clean taxonomy — identity / type / adapter / component

The old `AkmAssetType` conflated five roles (source selection, classification, naming, routing, state keys — History §4.4); 0.9.0 separates them:

| Concept | Is | Source | Role | NOT |
|---|---|---|---|---|
| **identity** | the one name of an item | OKF concept ID = path within bundle − `.md`; ref `[<bundle>//]<concept-id>` (§1.3) | refs, addressing, links, state keys | not type/adapter/component |
| **`type`** (OKF) | open descriptive label | frontmatter (OKF-native) or adapter-derived (foreign) | presentation, ranking, filtering | not identity; not an adapter; **never execution authority**; not a core storage switch |
| **adapter** | format-family owner / OKF translator | static id, one per component root | recognize / place / validate; optional authoring/export/memory methods | not a type; never competes per-file |
| **component** | a materialized root under one adapter | the leading path segment(s) of the concept ID, matched to a configured root | provenance, write policy, adapter selection, git pathspecs | not a distinct ref segment; not identity; not type |

**Orthogonality:** (1) `type` ≠ adapter, many-to-many. (2) presentation/ranking key on `type`; validation keys on `(adapter, type)` via shared functions. (3) a "tool directory" (`.claude`) is a component; provenance, never identity/type. (4) identity is path-only (OKF); changing `type`, re-validating under another adapter, or re-mounting a root never renames an item — only moving the file does (an explicit rekey, normative §11.4). (5) `type` **presents but never executes** — runtime authority comes only from a binding or explicit one-shot approval (normative §18, §28; History D8).

**OKF floor vs AKM value-add.** OKF gives path identity + open `type` + `title`/`description`/`tags`/`timestamp` + links. AKM adds, format-neutrally: the reference OKF adapter + translators for foreign formats; presentation/ranking for known `type`s; type-specific validation; bindings/activation; three-verb evidence-driven improve; the bounded memory lifecycle; search/transaction. Markdown types are OKF concepts; executable/sensitive types (workflow/task/env/secret) and foreign formats (Claude/OpenCode/wiki) are handled by their adapters, not by OKF.

---

## 1. Bundle / component / installation model

### 1.1 Interfaces (replaces `AssetSpec`/`TYPE_DIRS`/`ConfiguredSource`)

```ts
export type BundleId = string;       // stable bundle name (workspace identity); the optional ref prefix
export type ComponentId = string;    // a configured root under one adapter; PROVENANCE, not a ref segment (§1.3)
export type ItemRef = string;        // "[<bundle>//]<concept-id>" (§1.3)

export interface BundleInstallation {
  id: BundleId;
  revision?: string;                 // resolved git sha / npm version+integrity / snapshot digest
  source?: string;                   // transport locator, kept OUT of identity (normative §11.2)
  components: BundleComponent[];
  trusted: boolean;                  // explicit trust; installation grants nothing (History D8)
}

export interface BundleComponent {
  id: ComponentId;
  adapter: string;                   // static adapter id, one per root — no per-file competition
  root: string;                      // absolute materialized root; workspace state NEVER written here
  writable: boolean;
}
```

`BundleInstallation`, `BundleComponent`, `IndexDocument`, `FileChange`, `Proposal`, `Diagnostic`, and **`Binding`** are the minimal durable core set (History §5.2).

### 1.2 How a directory becomes a bundle

1. **Root `index.md` with `okf_version`** ⇒ OKF bundle; the `okf` adapter governs its markdown concepts; tool sub-trees (`.claude/`, `workflows/`) are additional components.
2. **Optional manifest** `akm.bundle.yaml` (`schemaVersion: 1`) — declares heterogeneous component roots + adapters + optional `exports:` (normative §9.2). Optional; the only new file format.
3. **Workspace config `bundles` map** (normative §10.1).
4. **Single-component default** — no manifest/override ⇒ one component `{ id:"main", root:".", adapter:<selected> }`, defaulting to **`okf`**.

Component roots SHOULD NOT overlap; overlap requires deterministic, validated ownership (normative §9.3).

### 1.3 Ref grammar — OKF concept ID + optional `bundle//` prefix

**Identity = the OKF concept ID** = path within the bundle with the recognized extension removed. The workspace-qualified ref prepends an optional `<bundle>//` (the `//` echoes the old `origin//`, and disambiguates the bundle prefix from the `/`-separated path):

```
ref        := [ bundle "//" ] conceptId
bundle     := slug                      # no "/" ; workspace bundle name (not the upstream package name)
conceptId  := path-within-bundle − ext  # OKF concept ID; MAY contain "/" ; opaque to the core below the first "//"
```

```
personal//knowledge/http-caching     # bundle-qualified; component "knowledge" is the leading path segment
team-catalog//workflows/release      # component "workflows"
project-claude//.claude/commands/test# component ".claude"; type=command (derived), NOT in the id
knowledge/http-caching               # default-bundle implied (bundle omitted)
```

**Component is absorbed into the path**, not a separate segment: the leading path segment(s) of the concept ID match the bundle's configured component roots, so multi-component bundles namespace naturally (`knowledge/…` vs `workflows/…`) without a distinct `<component>` field in the ref. Component is recorded as a **provenance column** (derived at index time), used for filtering/write-policy/adapter-selection, never for identity.

**Invariants (normative §11.2):** provider details never appear in refs; `type` never appears in the ref; changing a Git remote/cache/materializer never changes a ref; reclassifying `type` without moving the file never changes the ref; moving/renaming is an explicit state-rekey. The core MUST NOT parse a file path *out of* a concept ID — it stores the ref and looks the path up in the index. `asset-ref.ts` survives as a **pure parser** (bundle-prefix split on `//`, `validateName` traversal/null-byte/drive-letter guards `:121-136`); the closed union `isAssetType` `:109`, `TYPE_ALIASES` `:25`, `type:name` parsing are deleted.

### 1.4 Config shape (normative §10.1) — replaces `stashDir`/`sources[]`/`installed[]`/`wikiName`

```jsonc
{ "defaultBundle": "personal",
  "bundles": {
    "personal": { "path": "~/knowledge", "components": { "main": { "root": ".", "adapter": "okf", "writable": true } } },
    "team-catalog": { "git": "https://github.com/acme/team-catalog.git", "manifest": "akm.bundle.yaml" }
  },
  "bindings": { "release": { "export": "team-catalog//workflows/release", "enabled": true, "options": { "engine": "claude", "environment": "prod-release" } } }
}
```

`bindings` are workspace state (normative §18), never written into portable files.

---

## 2. The adapter contract (one interface; optional methods, not a facet hierarchy)

Per History §8.3 / the reconciliation, the adapter is **one interface with optional capability methods** — not separate `extends` facets, and not a semantic-view registry. Renderer/action is a **data table** keyed on `type`.

```ts
export interface BundleAdapter {
  readonly id: string;
  readonly version: string;                                  // feeds incrementality (§4) + fingerprints

  // REQUIRED — recognition + indexing (read-only over user content)
  index(inst: BundleInstallation, c: BundleComponent): AsyncIterable<IndexDocument>;
  recognize(c: BundleComponent, file: FileContext): IndexDocument | null;  // single-file primitive; replaces the matcher stack (matchers.ts:151-305; file-context.ts:242-265)

  // REQUIRED — native validation (change-transaction pre-commit + lint --fix); adapter MUST NOT write
  validate(c: BundleComponent, changes: FileChange[]): Promise<Diagnostic[]>;

  // OPTIONAL — placement / discovery
  placeNew?(c: BundleComponent, conceptId: string): string;  // replaces TYPE_DIRS + resolveAssetPathFromName
  directoryList?(c: BundleComponent): string[];              // owned dirs; feeds git exact-path staging (git-stash.ts:241)
  looksLikeRoot?(root: string): boolean;                     // install-time default-adapter probe

  // OPTIONAL — authoring facet (normative §12.2)
  getAuthoringContext?(c: BundleComponent, target: AuthoringTarget, op: "create"|"update"|"move"|"consolidate"): Promise<AuthoringContext>;
  create?(c: BundleComponent, req: CreateRequest): Promise<FileChange[]>;

  // OPTIONAL — export facet (normative §12.3): portable runtime exports (workflow/task/env/agent/command/skill/script)
  listExports?(inst: BundleInstallation, c: BundleComponent): AsyncIterable<BundleExport>;
  planBinding?(c: BundleComponent, exp: BundleExport, req: BindingRequest): Promise<BindingPlan>;

  // OPTIONAL — memory lifecycle facet (normative §12.4, §25)
  listMemories?(inst: BundleInstallation, c: BundleComponent): AsyncIterable<MemoryRecord>;
  renderMemoryPlan?(c: BundleComponent, plan: MemorySemanticPlan): Promise<FileChange[]>;
  validateMemoryPlan?(c: BundleComponent, plan: MemorySemanticPlan, changes: FileChange[]): Promise<Diagnostic[]>;
}
```

**Renderer/action = data table keyed on the open `type`** (plan §2.3):

```ts
export const TYPE_PRESENTATION: Record<string, { renderer: string; action: (r: ItemRef) => string }> = {
  "knowledge": { renderer: "knowledge-md", action: (r) => `akm show ${r} -> read reference material` },
  "workflow":  { renderer: "workflow-md",  action: buildWorkflowAction },
  // unknown type ⇒ generic renderer + `akm show <ref>` (third-party OKF types never dropped)
};
```

**Forbidden (normative §12.5):** adapters MUST NOT implement search, own proposal/outcome stores, apply writes or Git, **authorize execution**, register arbitrary improve stages, or replace core refs/diagnostics/change envelopes. The authoring/export/memory methods are **targeted ports, not semantic views** (History §8.3).

---

## 3. IndexDocument + the OKF projection

```ts
export interface IndexDocument {
  ref: ItemRef;             // "[<bundle>//]<concept-id>"
  bundle: BundleId;
  component: ComponentId;   // PROVENANCE (derived from the concept-id path prefix), not a ref segment
  conceptId: string;        // OKF concept ID = path within bundle − ext; opaque to the core
  path: string;             // absolute local path (the read path)
  hash: string;
  adapterId: string;
  type?: string;            // = OKF `type`; open; frontmatter (native) or adapter-derived (foreign). Presents/ranks/filters; NEVER executes or identifies

  name: string;             // FTS 10 ← OKF `title` (fallback filename)
  description?: string;     // FTS 5  ← OKF `description`
  tags?: string[];          // FTS 3  ← OKF `tags` (+aliases)
  hints?: string[];         // FTS 2
  content?: string;         // FTS 1 (bounded)
  updated?: string;         // ← OKF `timestamp`
  links?: string[];         // resolved bundle-relative OKF links = relationships (§9)
  documentJson?: unknown;   // opaque adapter extras (incl. arbitrary OKF frontmatter keys); not FTS, not parsed by core
}
```

Persisted index columns migrate `entry_key/stash_dir/entry_type/entry_json` → `item_ref/bundle_id/component_id/concept_id/adapter_id/type/file_path/content_hash/document_json` (normative §14.4), keeping the integer row id for FTS/vector joins.

**FTS5 schema + bm25 weights UNCHANGED and load-bearing** (schema.ts:159; db.ts:1024 `bm25(entries_fts,0,10,5,3,2,1)`). `buildSearchFields(IndexDocument)` is a direct OKF map (name←title 10, description←description 5, tags←tags 3, hints 2, content 1). The deterministic nDCG/MRR/recall/banned-hit parity gate governs the cutover; weights/columns do not move (normative §14.4, D12).

### 3.4 Known-`type` presentation set (not a closed union)
No closed set replaces `AkmAssetType`. AKM keeps `TYPE_PRESENTATION` + ranking rules for the `type`s it renders/ranks; any other `type` renders generically and stays searchable (normative §15.1). A lint keeps the *spelling* of the known set consistent across the presentation/ranking tables + `parseRefPrefixQuery` + base-linter `REF_RE`; it never constrains what `type`s may exist.

---

## 4. Indexing loop, incrementality, registry

Scan loop (replaces `akmIndex` walk + wiki branch): for each installation → each component → `adapter.index` → `persistComponent` (one txn, truncate-and-rewrite the component's rows, fixing the `utility_scores_scoped` gap; dedup by `ItemRef`). Adapters/materializers/registry/network **never run at query time** (normative §14.3, D11). A failed component scan preserves last-known-good rows and keeps other bundles searchable.

Incrementality is mount-scoped: `{ scanGeneration, adapterVersion, files: {path → {hash, mtimeMs}} }`; re-index on adapterVersion change / newer mtime / hash mismatch / new-or-deleted path; a single changed file calls `recognize` and upserts one row.

Registry is a **static frozen `BUILTIN_ADAPTERS`** map (normative §12.6): `okf`, `llm-wiki`, `claude`, `opencode`, `agent-skills`, `akm-workflow`, `akm-task`, `dotenv`, `website-snapshot`, `generic-files`. One adapter per component root, selected once; install-time default via `looksLikeRoot`, defaulting to `okf`. Unknown `type` ⇒ searchable + generic renderer; unknown adapter id ⇒ component skipped with a warning.

---

## 5. The reference `okf` adapter (default)

Pure OKF: **`type` from frontmatter, identity from path, no directory routing.**
- **recognize:** any `.md` not named `index.md`/`log.md` → one concept; `type` = frontmatter `type` (default `knowledge` + a `missing-type` info hint if absent). No directory gate (OKF §1).
- **conceptId/localId:** path within the bundle − `.md` (markdownSpec.toCanonicalName, asset-spec.ts:91-95).
- **placeNew:** `<conceptId>.md`; new files carry OKF frontmatter (`type`,`title`,`description`,`tags`,`timestamp`).
- **directoryList:** the component root (OKF concepts live anywhere).
- **renderer/action:** `TYPE_PRESENTATION` keyed on the file's `type` (default `knowledge-md`).
- **validate (LENIENT):** base checks only; unknown frontmatter never fails; `missing-ref` on OKF links is a **warning** (consumers MUST tolerate broken links); `missing-type` is info.
- **Reserved:** `index.md`/`log.md` recognized, not indexed as concepts; root `index.md` may carry `okf_version`; `akm index` never regenerates `index.md` (normative §14.6, D14).

---

## 6. The `type` values AKM recognizes (its OKF-type profile)

These are **`type` values, not adapters**. For AKM-native content they are **authored in frontmatter** (read by `okf`/`akm`); for foreign layouts they are **derived** by translators (`claude`/`opencode`/`agent-skills`/`website-snapshot`). Table = a `type` reference (validator applied as a shared function; foreign-derivation convention for translators only). Presentation is keyed on `type` via `TYPE_PRESENTATION`.

| `type` | native OKF? | foreign-derivation convention | type-specific validation |
|---|---|---|---|
| knowledge | yes | default when `type` absent | base only |
| command | yes | `.md` under `commands/` + `$ARGUMENTS`/`agent`-fm probe | `missing-name-or-type`; type∈{command} |
| agent | yes | `.md` under `agents/` + `tools`/`toolPolicy`/`model` probe | `missing-name-or-type`; type∈{agent} |
| skill | yes | `SKILL.md`; item = the dir | `missing-skill-md` **+ NEW** Anthropic contract (name≤64/desc≤1024/body<~500) |
| memory | yes | `.md` under `memories/` | `orphaned-stub` (delete fix); memory-lifecycle (§ normative 25) |
| lesson/fact/session/instruction | yes | `lessons/`/`facts/`/`sessions/`/`CLAUDE.md`·`AGENTS.md` | base (+`missing-category` for fact) |
| workflow | ext | `.md`/`.yaml`/`.yml` workflow; markdown≈OKF, YAML program is an AKM extension | `placeholder-stub`, `invalid-workflow-structure` |
| task | AKM ext | `.yml` under `tasks/` (not OKF markdown) | `invalid-task-yaml`: schedule+enabled+one target |
| env | AKM ext | `.env`/`*.env` under `env/` — **key NAMES only, values never indexed** | dangerous-key warn scan |
| secret | AKM ext | any file under `secrets/` minus `.lock`/`.sensitive` — **filename only** | dangerous-key scan; `classifyBySmartMd` bails on `secrets/` |
| script | AKM ext | 17 `SCRIPT_EXTENSIONS`; localId keeps extension | none |
| website | derived | website crawl snapshot (§7) | base (read-only) |
| wiki page | **LLM Wiki adapter** | `.md` under an LLM Wiki root (§7) — its own `type` values | native wiki validation (§7) |

**6 renderer mappings** (script/skill/command/agent/knowledge/memory) live only in `TYPE_PRESENTATION` now (they carried no `rendererName` on their old spec, plan §2.3).

---

## 7. The adapter set (format families)

An **adapter is a format family**, one per component root, emitting one or more open `type`s. Markdown types are OKF concepts; foreign formats are translated. A **"tool directory"** (`.claude`/`.opencode`) is a component whose adapter translates a tool's layout; no adapter competes per-file.

| adapter | format / root | types | writable | notes |
|---|---|---|---|---|
| **okf** (§5) | OKF markdown; `type` from frontmatter | any OKF type | yes | **reference/default**; consumes third-party OKF |
| **akm** | AKM workspace: OKF markdown + AKM extensions (workflow/task/env/secret/script) under AKM subdirs | full §6 profile | yes (markdown/workflow/task); env/secret metadata-only | AKM's own workspace bundle |
| **llm-wiki** (**restored, DEV-7**) | LLM Wiki: `schema.md`, `index.md`, `log.md`, `raw/`, `pages/`, xrefs, citations, native ingest | wiki page kinds (adapter-owned) | yes | owns its native multi-file semantics + authoring/validation; `wiki` asset-*type* is gone but the **adapter** is first-class (normative §13.3) |
| **claude** | `.claude` tool dir — translator; derives `type` from dir | command, agent, skill, instruction | yes | AKM workspace layout **is** `.claude` minus the prefix |
| **opencode** | `.opencode` tool dir — translator (NEW) | command, agent, instruction | yes | `AGENTS.md`=instruction; `config.json` not indexed |
| **agent-skills** | standalone `SKILL.md` packages — translator | skill | yes | SKILL.md codec shared with claude as functions |
| **akm-workflow / akm-task / dotenv** | native workflow / task-YAML / dotenv formats | workflow / task / env | yes / yes / metadata-only | own executable/sensitive schemas; export facet (§ normative 18) |
| **website-snapshot** | crawl snapshot (website-ingest.ts:180) — read-only | website | **no** (Mode A) | export (Mode B) routes `content` through the destination adapter + FileChange txn; all SSRF/redirect/byte/depth/wall-clock/stale protections preserved |
| **generic-files** | any leftover file | document/script/file | yes | unknown-format-stays-searchable |

Instruction files (`CLAUDE.md`/`AGENTS.md`) are NEW; tool config files are runtime-config, never indexed. `sources/wiki-fetchers/`→`snapshot-fetchers/`; the one-element youtube registry inlines.

---

## 8. Multi-component resolution

**One adapter per component root, emitting the `type`s that root natively contains.** The `claude` adapter emits command/agent/skill/instruction from one `.claude` component — not three sub-components. The multi-component invariant is about **heterogeneous roots** (an `okf` knowledge root *and* a `workflows/` root *and* a `.claude/` root), not splitting one tool dir. The one real cross-format overlap (`.claude/skills/<n>/SKILL.md` == a standalone Agent Skill) is resolved by factoring the SKILL.md contract into **shared functions** imported by both `claude` and `agent-skills` (not nested adapters).

```
bundle "team-catalog" (OKF)
├── index.md  (okf_version: "0.1")     ← reserved, not a concept
├── component { root: ".",         adapter: "okf" }         → type from frontmatter → refs: team-catalog//<concept>
├── component { root: "workflows", adapter: "akm-workflow" } → type=workflow       → team-catalog//workflows/<id>
├── component { root: "wiki",      adapter: "llm-wiki" }     → wiki page kinds      → team-catalog//wiki/<page>
└── component { root: ".claude",   adapter: "claude" }       → command|agent|skill  → team-catalog//.claude/<...>
```

---

## 9. Relationships: OKF links (deterministic; replaces LLM graph extraction for OKF content)

OKF bundle-relative links (`[x](/tables/customers.md)`, `[y](./other.md)`) **are relationships** (OKF §4). The `okf`/`llm-wiki` adapters resolve them at `index` time into `IndexDocument.links` (target concept IDs). This is the deterministic native link graph the plan wants first; LLM graph extraction survives only as an optional index processor over non-OKF formats, gated on measured nDCG lift (normative §26.3). Broken links are tolerated (warning), so relationship extraction never blocks indexing.

---

## 10. Installation, bindings, activation (IN SCOPE — DEV-3)

Per **History D8** and normative **§18**, restored for 0.9.0 (reversing the earlier §13.3 deferral): **installation is not activation.** Lifecycle: `discover → install/materialize → index → bind (or explicit one-shot approval) → enable`. Installation makes content searchable and grants **no** execution, scheduling, tools, environment values, or secrets. A `Binding` (durable state in `state.db`, never written to portable files) records export ref + digest, engine/harness, parameters, env/secret mappings, tool/fs policy, enabled state, and scheduler identity where applicable. Export kinds (`workflow`/`task`/`environment`/`agent`/`command`/`skill`/`script`) are activation contracts, not storage types or identity. Runtime handlers execute only approved bindings/one-shots and never infer authority from a `type` or frontmatter field (normative §8.4, §28). Full binding/update/one-shot rules: normative §18–§22.

---

## 11. Improve — three semantic operations (IN SCOPE — DEV-5)

Per **History D20** and normative **§24**, restored for 0.9.0 (reversing the two-verb reduction):

```
revise       improve an existing durable item
learn        create a new durable item from evidence
consolidate  bound a memory tier while preserving knowledge (the only op that may retire source content)
```

Evidence-driven (corrective evidence required for unattended semantic change; importance only orders), one stable snapshot per run, input fingerprints, and the three-level verification ladder (native safety / objective comparison / field outcome). Model confidence is diagnostic, never authority. Full stages, corrective-evidence list, verification ladder, change classes, process mapping, and the "must earn their way back" list: normative §24 + History §9. The plan's improve *decomposition* (the god-function → passes refactor, deletions of unproven lanes) stands; the *verb count* is three, not two.

---

## 12. Bounded memory lifecycle (IN SCOPE — DEV-4)

Per **History D21–D24** and normative **§25**, restored for 0.9.0 as a first-class capability (reversing the scope-down). It is a **refactor of the existing `consolidate.ts` (~3,100 LOC)** into a proper bounded lifecycle, not a new subsystem:
- **Adapter capability** via the optional memory methods (§2); core owns pressure/selection/evaluation/transactions/archive/purge.
- **Operational states** `active → retired → purged` and `active → quarantined → restored|purged`, distinct from native semantic states (superseded/contradicted/historical).
- **High/low-water + backpressure** — deterministic cleanup first, then non-destructive semantic consolidation to low-water; pressure never lowers preservation gates; if safe reduction fails, background intake **queues** evidence instead of publishing more memory files.
- **Source-to-successor claim coverage** — every durable claim gets a disposition or retirement is blocked; temporal qualifiers/contradictions never flattened.
- **Retrieval/task non-regression** in a sandbox index before retirement; successor-first, reversible.
- **Workspace content-addressed archive** (`$DATA/archive/blobs/sha256/<digest>`, not bundle-local `.akm`), grace period, purge, read-only retirement overlay.

Full states, water-marks, coverage map, evaluation, archive, purge, and cross-bundle two-phase protocol: normative §25 + History §10.

---

## 13. Grounding index (what each element replaces)

| New | Replaces | file:line |
|---|---|---|
| OKF bundle + `okf`/`llm-wiki`/… adapters | `AssetSpec` + `stashDir` + wiki-as-type | asset-spec.ts; config-types.ts:99 |
| ref `[<bundle>//]<concept-id>` (path identity) | `AssetRef{type,name,origin}` | asset-ref.ts:11-116 |
| open OKF `type` (frontmatter) | closed `AkmAssetType` + `entry_type` | common.ts:29-88; asset-ref.ts:109 |
| `IndexDocument` (OKF projection) | `StashEntry` | metadata.ts:60-189 |
| adapter `recognize`/`index` + optional methods | `runMatchers`/`classifyBy*`/walker | file-context.ts:242-265; matchers.ts:151-305; walker.ts:73 |
| `placeNew`/`directoryList` | `TYPE_DIRS`/`resolveAssetPathFromName` | asset-spec.ts:140-226; path-resolver.ts:27-38 |
| `TYPE_PRESENTATION` (open `type`) | `TYPE_TO_RENDERER`/`ACTION_BUILDERS` + spec split-brain | asset-registry.ts:21-58 |
| `Binding` + install≠activate | (implicit activation today) | tasks/workflows/env runtime |
| three-verb improve + memory lifecycle | improve god-modules + consolidate.ts | commands/improve/* |
| OKF links → `links` | LLM graph extraction | indexer/graph/* |

---

## References / Citations

- **OKF v0.1** — [`GoogleCloudPlatform/knowledge-catalog` `okf/SPEC.md`](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md); [Google Cloud announcement (2026-06-12)](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/); [annotated guide](https://okf.md/spec/). Concept identity = path − `.md`; required open `type`; recommended `title`/`description`/`resource`/`tags`/`timestamp`; reserved `index.md`/`log.md`; links = relationships; `okf_version`; tolerate unknown fields + broken links.
- **Anthropic Agent Skills** — the `SKILL.md` L1 contract (name ≤64, description ≤1024 what+when, body <~500 lines, progressive disclosure): [Agent Skills specification](https://agentskills.io/specification); docs.anthropic.com Agent Skills.
- **AKM normative** — `akm-format-neutral-bundle-workspace-spec.md` (bindings §18, improve §24, memory §25), `akm-architecture-decision-history.md` (D1–D26), and the `akm-0.9.0-*` companions in this directory; `file:line` refs are to the current tree.
