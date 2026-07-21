# AKM Format-Neutral Bundle Workspace Architecture Specification

**Status:** Amended for implementation (reconciled)  
**Specification version:** 0.3  
**Date:** 2026-07-14 (v0.2 amended 2026-07-13 after the maintainer reconciliation and the design/plan review pass; v0.3 amended 2026-07-14 after the final scope decisions)  
**Target:** Next major AKM architecture  
**Reference implementation reviewed:** [`itlackey/akm`](https://github.com/itlackey/akm) at [`ddc0a1b417efc820ad73d76bfcbef65c9f87b243`](https://github.com/itlackey/akm/commit/ddc0a1b417efc820ad73d76bfcbef65c9f87b243)  
**Related proposal:** [AKM PR #718](https://github.com/itlackey/akm/pull/718)

This specification supersedes the prior directions that treated OKF as an AKM asset type, made OKF the hidden universal AKM file schema, introduced a semantic-view registry, or preserved the current asset system behind a permanent legacy adapter.

**Amendment record.** *(v0.2, 2026-07-13)* The maintainer reconciliation (DEV-1..DEV-7, `akm-plan-vs-spec-deviation-analysis.md` §4) and the review pass (`akm-target-design-review-2026-07.md`, `akm-0.9.0-plan-review-2026-07.md`) applied in place: the ref grammar is `[<bundle>//]<concept-id>[#fragment]` (§7.8, §11); the normalized field is the open **`type`** (§14.1), which MAY drive presentation/ranking/filtering and MUST NOT drive execution, identity, or storage; adapter capabilities are optional methods on one interface (§12); nested component roots have a subtraction rule (§9.3); index persistence is a diff, not truncate-and-rewrite (§14.2). *(v0.3, 2026-07-14 — final scope decisions, deviation §4.3a–3c)* This document remains the **target architecture**; release staging is explicit where target and 0.9.0 diverge: the persisted Binding record, export digests, rebind-on-update, and the bind CLI are **Tier B, deferred indefinitely** (staging note at §18); the **entire memory lifecycle (§25) is deferred** behind the claim extractor + benchmark (staging note at §25); and the v0.2 trust-clamp additions (trusted labeling in the read path, action clamping, catch-all sensitive-content refusal) are **withdrawn** — new trust/approval machinery is rejected as false-confidence machinery; only protections that exist in code today survive the port (env/secret redaction, the origin-scoped dangerous-key rule). No section of this document is superseded by a banner elsewhere; this text is current. *(v0.4, 2026-07-21 — owner ruling)* The **`akm.bundle.yaml` package manifest is removed entirely** (it was never implemented and should never have been approved), and **sub-mount / multi-component registration is replaced by adapter-owned file processing**: a bundle maps to exactly **one component = one adapter**, and that component's adapter processes the files and subdirectories of its bundle as it sees fit — the core provides the walk and the persistence, the adapter's `recognize` claims or abstains per file. Consequences applied in place: §9.2 multi-component packages and §9.3 nested-root subtraction no longer apply to a single-adapter bundle; manifest-declared `exports:` are removed (exports with independent standing, if any, are unaffected); §14.2's scan flow is the core walk × `adapter.recognize` with per-directory incremental diff persist. Adapter dispatch is live in the indexer (unknown adapter id ⇒ component skipped with a warning).

---

## 1. Normative language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as described by [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when they appear in uppercase.

---

## 2. Abstract

AKM is a format-neutral workspace for installing, indexing, searching, reading, validating, improving, distributing, and safely executing files contained in bundles.

AKM does not define one universal format for knowledge, memories, skills, agents, workflows, tasks, environment definitions, or scripts. Native file semantics belong to bundle adapters. AKM owns the cross-format operating capabilities around those files:

```text
source materialization
+ bundle installation
+ local indexing and search
+ workspace bindings
+ execution policy
+ proposals and transactions
+ evidence-driven improvement
+ bounded memory lifecycle
+ audit and recovery
```

The core architecture is:

```text
Workspace
├── installed bundles
│   ├── adapter-governed components
│   └── portable runtime exports
├── bindings and enabled schedules
├── local search index
├── durable operational state
├── engines and runtime services
├── evidence and memory lifecycle state
└── proposals and verified file changes
```

OKF is a flagship built-in adapter and preferred neutral interchange format. It is not AKM's internal schema and is not an AKM asset type.

---

## 3. Scope

This specification defines:

- the workspace, bundle, component, adapter, export, binding, and item models;
- how sources are materialized and bundles are installed;
- how native files are projected into one search index;
- how conventions and authoring rules are supplied by adapters;
- how workflows, tasks, environments, agents, skills, commands, and scripts remain portable while execution stays workspace-controlled;
- how website sources remain refreshable and can be exported into writable native bundles;
- how file changes, proposals, validation, transactions, and recovery work;
- how `akm improve` becomes evidence-driven and measurable;
- how memories are consolidated, formalized, retired, archived, and purged without unbounded growth or unsafe information loss;
- the target storage model, CLI surface, migration strategy, and acceptance gates.

---

## 4. Goals

The architecture MUST:

1. Make AKM independent of any single content format.
2. Preserve native compatibility with OKF, LLM Wiki, Claude, OpenCode, Agent Skills, website snapshots, AKM workflows, AKM tasks, dotenv-style environments, scripts, and future standards.
3. Reduce the core mental model and eliminate closed asset-type dispatch.
4. Preserve or improve current search quality and latency.
5. Keep ordinary file reads and file writes transparent and debuggable.
6. Make installation distinct from execution authority.
7. Allow reusable workflows, tasks, environment definitions, agents, skills, commands, and scripts to be distributed in bundles.
8. Centralize native conventions, authoring rules, validation, and serialization in adapters.
9. Make semantic changes proposal-first and objectively evaluated where possible.
10. Bound memory growth without making age, low use, or storage pressure sufficient evidence for deletion.
11. Preserve crash recovery, exact-path Git commits, reversible changes, and durable audit history.
12. Permit an aggressive implementation replacement without requiring a separate greenfield product.

---

## 5. Non-goals

AKM MUST NOT:

- define a universal frontmatter schema for every file;
- require native Claude, OpenCode, Agent Skills, workflow, task, environment, or script files to become OKF documents;
- inject AKM automation policy into portable document frontmatter;
- use model self-confidence as permission to publish a semantic change;
- call adapters, source providers, registries, or the network during a normal search query;
- require every adapter to implement execution or improvement;
- allow an installed bundle to grant itself tools, secret access, scheduler activation, or code-execution authority;
- place workspace state under a bundle root;
- preserve the current asset architecture indefinitely through a permanent compatibility adapter;
- introduce a general semantic-view framework or inheritance hierarchy to normalize every native format;
- create a public third-party adapter ABI before the built-in adapter contract has been proven by multiple independent implementations.

---

## 6. Architectural principles

### 6.1 Files remain primary

Native files are the portable content source of truth. The index, summaries, embeddings, graph data, bindings, usage scores, proposals, and execution records are derived or operational workspace state.

### 6.2 Adapters own format semantics

Adapters own:

- native discovery;
- native item identity;
- required files and layout;
- parsing and serialization;
- links and precedence;
- hard authoring rules;
- soft conventions;
- scaffolding;
- validation and repair generation;
- optional runtime exports;
- optional memory lifecycle rendering.

### 6.3 Core owns cross-format operations

The workspace core owns:

- installation and update orchestration;
- the unified index and query engine;
- direct reads from indexed paths;
- bindings and activation policy;
- evidence collection and ranking state;
- proposals, transactions, audit, and recovery;
- scheduling and runtime execution policy;
- memory pressure, retirement state, archives, and purge policy.

### 6.4 Installation is not activation

A bundle can be installed and searchable without being executable. Runtime use requires a workspace binding or an explicit per-invocation approval allowed by workspace policy.

### 6.5 Complexity carries a burden of proof

Any ranking feature, graph processor, self-refinement stage, evaluator loop, or improvement selector that adds significant complexity MUST demonstrate measurable value over a simpler baseline.

### 6.6 One stable snapshot per semantic run

A semantic improvement run MUST generate all candidates against one stable file/index snapshot. Accepted output MUST NOT become new semantic input during the same run.

---

## 7. Terminology

### 7.1 Workspace

The local AKM operating environment. It owns configuration, installed-bundle state, indexes, bindings, engines, proposals, evidence, schedules, logs, archives, audit history, and runtime policy.

A workspace is not a content bundle and is not a directory that must contain all user files.

### 7.2 Bundle package

A distribution and versioning unit that contains one or more native component roots. A package may be a Git repository, archive, npm package, filesystem directory, website snapshot, or subdirectory of a larger repository.

### 7.3 Bundle installation

A local materialized revision of a bundle package, registered under a stable workspace bundle ID.

### 7.4 Component

A subtree within a bundle installation interpreted by exactly one adapter.

Examples:

```text
knowledge/  -> OKF adapter
wiki/       -> LLM Wiki adapter
.claude/    -> Claude adapter
workflows/  -> workflow adapter
tasks/      -> task adapter
env/        -> environment adapter
skills/     -> Agent Skills adapter
```

A bundle may have one component or many components.

### 7.5 Materializer

The source-specific implementation that gets bytes onto the local filesystem and optionally refreshes them. Examples include filesystem, Git, archive/npm, and website materializers.

Materializers do not parse native content semantics.

### 7.6 Adapter

The implementation that understands a component's native files and rules.

### 7.7 Item

A native logical object discovered by an adapter and represented in the workspace index. An item normally resolves to one primary file but MAY reference supporting files.

### 7.8 Item ref

The workspace-unique, path-like identity of an indexed item (reconciled grammar, DEV-2):

```text
ref        := [ bundle "//" ] conceptId [ "#" fragment ]
bundle     := slug            # workspace bundle name; no "/", ":", ".", or "#"
conceptId  := path within the bundle with the adapter-recognized extension removed;
              MAY contain "/"; MUST NOT contain "#"; opaque to the core below the "//"
```

Example:

```text
team-catalog//tables/orders
release-automation//workflows/release
project-claude//.claude/skills/pdf-processing
knowledge/http-caching            # short form; CLI input sugar only (§11.1)
```

The **component** is not a ref segment. It is a provenance column derived at index time by longest-prefix matching the conceptId's leading path segments against the bundle's configured component roots. Reclassifying a component or re-mounting a root never changes a ref; only moving the file does (§11.2).

### 7.9 Export

A portable runtime capability exposed by an adapter from a bundle item. Supported export kinds are initially:

```text
workflow
task
environment
agent
command
skill
script
```

Export kind is an activation contract, not a storage type and not part of item identity.

### 7.10 Binding

A workspace-owned approval and configuration record connecting an installed export to local execution policy.

### 7.11 Proposal

A durable, reviewable set of native file changes with evidence, before-hash preconditions, evaluation results, and lifecycle status.

### 7.12 Memory-capable component

A component whose adapter implements the memory lifecycle facet and can inventory, render, validate, and retire native memory records.

---

## 8. System responsibility boundaries

### 8.1 Materializer responsibilities

A materializer MUST:

- produce a stable local root for a resolved revision;
- record source and revision/integrity information;
- protect against path traversal and unsafe archive entries;
- preserve a usable last-known revision when refresh failure policy allows;
- avoid interpreting content formats.

A materializer MAY support refresh, pull, checkout, cache expiration, conditional HTTP requests, or local writable checkouts.

### 8.2 Adapter responsibilities

An adapter MUST:

- deterministically scan its configured component root;
- emit stable conceptIds for unchanged native items;
- emit a normalized search projection;
- validate proposed changes according to native rules;
- preserve unknown native fields and formatting when safe round-tripping requires it;
- reject mutations that escape the component root;
- avoid writing files directly.

An adapter MAY implement authoring, export, or memory lifecycle facets.

### 8.3 Core responsibilities

The core MUST:

- resolve bundle installations and components before indexing;
- persist one local search index;
- read normal item content directly from indexed filesystem paths;
- apply all mutations through one transaction boundary;
- keep runtime authority in bindings and policy;
- keep durable state outside bundles;
- record source revision and content hashes used by execution and improvement;
- keep search available for unaffected bundles when one adapter fails.

### 8.4 Runtime handler responsibilities

Runtime handlers or harnesses MUST:

- execute only approved bindings or explicitly approved one-shot invocations;
- resolve engines, tools, environments, permissions, and working directories from workspace policy;
- freeze the relevant export digest and bundle revision for durable runs;
- never infer execution authority from an item kind or frontmatter field alone.

---

## 9. Bundle composition

### 9.1 Single-component bundles

Every bundle is single-component (§9.2, v0.4). Workspace configuration mounts a root directly:

```yaml
bundles:
  personal:
    path: ~/knowledge
    components:
      knowledge:
        root: .
        adapter: okf
        writable: true

defaultBundle: personal
```

### 9.2 One bundle = one component = one adapter

*(Amended v0.4, 2026-07-21 — owner ruling: the `akm.bundle.yaml` manifest and multi-component packaging are removed.)*

A bundle maps to exactly **one component**, owned by exactly **one adapter**. There is no `akm.bundle.yaml` package manifest and no manifest-declared `exports:`. A package that bundles heterogeneous content (knowledge, workflows, tasks, environment, skills) is served by the **single adapter** selected for its root: that adapter's `recognize` processes the files and subdirectories of the bundle however it sees fit — the core provides the walk and the persistence, and the adapter claims or abstains per file. Heterogeneous tool subtrees are the adapter's concern, not a reason to split the bundle into multiple components.

### 9.3 Component identity and conceptId collisions

*(Amended v0.4, 2026-07-21 — nested-root subtraction removed: a single-adapter bundle has one component, so there are no other component roots to subtract and no cross-component ref collisions.)*

Because a bundle has one component, every physical file in the walked tree is owned by that one component; refs are bundle-relative and unique. The persisted ref column is UNIQUE.

Within the component, two files reducing to the same conceptId (for example `release.md` and `release.yaml` under a workflow root) are a `duplicate-concept-id` validation diagnostic naming both paths. The adapter MUST declare a deterministic extension priority to pick the indexed winner, and the loser's path MUST be recorded so that deleting the winner later resets, rather than inherits, the ref's durable state history.

### 9.4 Adapter detection

Automatic detection MAY propose candidate component mounts. It MUST NOT establish permanent semantics without a deterministic winner or explicit configuration.

Once a component is registered, its adapter selection MUST be persisted and indexing MUST NOT rerun global format guessing.

---

## 10. Workspace configuration and resolved lock state

Workspace configuration represents desired installations and bindings. A lockfile represents resolved source state.

### 10.1 Desired configuration

```yaml
bundles:
  team-catalog:
    git: https://github.com/acme/team-catalog.git
    revision: main
    components:
      main:
        root: .
        adapter: okf

  project-claude:
    path: .
    components:
      claude:
        root: .claude
        adapter: claude
        writable: true

  typescript-docs:
    website:
      url: https://www.typescriptlang.org/docs/
      refresh: 12h
      maxPages: 250
      maxDepth: 4
    components:
      pages:
        root: .
        adapter: website-snapshot
        writable: false

bindings:
  release:
    export: team-catalog//workflows/release
    enabled: true
    options:
      engine: claude
      environment: prod-release
```

### 10.2 Lock state

Resolved lock state SHOULD include:

- bundle ID;
- source kind and locator;
- resolved version or revision;
- integrity hash when available;
- local materialized root;
- component adapter ID and version;
- installation timestamp.

Desired configuration MUST NOT duplicate resolved cache paths and revisions that belong exclusively in lock state.

---

## 11. Identity and refs

### 11.1 Canonical ref

The canonical item ref is (§7.8):

```text
ref := [ <bundle> "//" ] <concept-id> [ "#" <fragment> ]
```

The bundle slug MUST NOT contain `/`, `:`, `.`, or `#` (this keeps `bundle//` lexically distinguishable from URLs and scheme-relative links in prose). The conceptId MAY contain `/`, MUST NOT contain `#`, and is otherwise opaque to the core below the `//`.

**Canonical stored spelling.** All durable state keys, index rows, bindings, and proposal targets MUST store the fully-qualified `bundle//conceptId` form, always. The short (bundle-omitted) form is CLI input sugar; it MUST NOT be persisted as a key. (Today's `rekeyStateDbForMove` probing three legacy spellings per ref is the cost of leaving this open.)

**Short-ref resolution (amended per ref-grammar decision D-R4).** A short ref from CLI/API input resolves to the **defaultBundle** if the conceptId exists there, otherwise to the first bundle containing the conceptId in **installation priority order** (the config/`deriveInstallations` order — the same order origin-less lookups walk today). First match wins, deterministically; no match is a not-found error naming the forms tried. Short refs inside bundle *content* resolve to the **containing** bundle, never defaultBundle. Scoped lookup (the old `local//`) is an explicit resolver option (`{ only: bundleId }`), not a ref spelling.

**Short refs in portable content.** A short ref appearing inside a file that ships in a bundle resolves to the **containing** bundle, never the installer's default bundle, so intra-bundle references stay portable by construction. Native bundle-relative links (OKF links, §26.3) are the preferred intra-bundle reference form.

**Canonicalization.** conceptIds are normalized at index/parse time: path separators normalized to `/`; Unicode normalized to NFC; identity is byte-wise case-sensitive. Indexing MUST emit a `case-collision` diagnostic when two files in one component differ only under case folding or NFC/NFD normalization (they cannot round-trip through case-insensitive checkouts). The traversal, null-byte, and drive-letter guards of the current `validateName` are normative MUSTs for conceptId validation, together with a `#` rejection.

**Body-ref grammar.** Refs embedded in prose MUST use the fully-qualified `bundle//conceptId` form (the bundle-slug charset above makes it lexically anchored), or a native link form owned by the adapter. Lint's missing-ref scan and `akm mv`'s inbound-xref rewriting operate only on these anchored forms; bare short refs in prose are not recognized as refs.

### 11.2 Ref invariants

- Provider details MUST NOT appear in refs.
- Native semantic `type` MUST NOT appear in refs unless it is naturally part of the conceptId path.
- Changing a Git remote, cache path, or materializer MUST NOT change item refs.
- Reclassifying a native item (changing its `type`, re-validating under another adapter, re-mounting a root) without moving it MUST NOT change its ref.
- Moving or renaming a native item changes path-based identity and MUST use an explicit state-rekey transaction.
- The core resolves conceptId → path **only via the index**. Adapters own both stripping directions (`recognize` strips the extension; `placeNew` re-adds it, longest-match against the adapter's declared extension set so `foo.yaml.md` has one defined answer). The core MAY treat a conceptId as a `/`-segmented string for prefix matching (component derivation, ref-prefix search, derived-twin keys) but MUST NOT reconstruct filesystem paths from it.
- Clarifying note (ref-grammar decision D-R2, no rule change): "path within the bundle" means the item's path **as the adapter defines it** — a directory-item's path is its directory (a skill's id is `skills/<dir>`, not `skills/<dir>/SKILL`).

### 11.3 Export refs

An export normally uses the item ref that exposes it. If one item exposes multiple exports, the adapter MAY append a stable fragment:

```text
team//tools/toolbox#deploy
```

The fragment is adapter-owned and opaque to the core. Because `#` is forbidden inside conceptIds (§11.1), the fragment production is unambiguous.

### 11.4 Ref migration

The current `[origin//]type:name` namespace MUST be migrated once. Migration MUST rekey retained durable records such as:

- usage and feedback events;
- utility records;
- proposal targets;
- workflow and task target refs;
- accepted-change history;
- memory retirement and outcome state;
- bindings;
- graph or relationship rows retained after migration.

A permanent dual-parser is prohibited.

**Mapping and orphan policy.** The old-ref → new-id mapping MUST be computed by joining against the last-good index (entry key → file path → conceptId) or by walking the old on-disk layout with a frozen copy of the old resolver — never by reconstructing paths from `TYPE_DIRS` heuristics at migration time. Mature installations provably hold state rows for items with no file and no index row (deleted-asset salience/outcome rows, append-only usage history, retained judged-state keys), so a literal zero-orphan requirement is unsatisfiable. The migration MUST therefore classify rows:

- **Expected orphans** — old refs that map to no live item — are carried into a quarantined `legacy_state` archive table (auditable, purgeable), with counts reported; they MUST NOT abort the migration.
- **Integrity failures** — mapping collisions (two old refs → one new id without a defined merge), row-count mismatches after re-key, unparseable refs — MUST fail closed to restore.
- Rows existing under multiple legacy spellings of one logical ref (bare, `origin//`, `.derived` twins) MUST be merged by a deterministic per-table function (e.g. event rows carried as-is under the new key; scalar salience fields merged by most-recently-updated).

### 11.5 Bundle rename

Renaming a workspace bundle id is a mass identity migration (every ref in the bundle changes without any file moving). It MUST be performed by an explicit `akm bundle rename <old> <new>` that runs the same rekey transaction family as an item move — index rows, all ref-keyed state tables, bindings, and configuration, atomically. Startup MUST detect a configured bundle id whose index/state rows exist only under a missing id and refuse or warn rather than silently re-minting fresh state. Refs are workspace-scoped: two workspaces installing the same package under different bundle names produce different refs. The lock state SHOULD record the upstream package name so tooling can offer it as a resolvable alias for cross-workspace exchange; absent that, documentation MUST state that refs are not portable across workspaces.

---

## 12. Adapter contracts

### 12.1 Base contract

There is **one** adapter interface. Optional capabilities are optional methods on it (DEV-6, History §8.3) — not an `extends` hierarchy and not a semantic-view registry.

```ts
interface BundleAdapter {
  readonly id: string;
  readonly version: string;                 // feeds incrementality and fingerprints
  readonly extensions: readonly string[];   // recognized extensions, longest-match stripped (§11.2)

  // REQUIRED — the single-file recognition primitive.
  recognize(
    component: BundleComponent,
    file: FileContext,
  ): IndexDocument | null;

  // OPTIONAL — full-component scan for adapters whose layout is not per-file
  // (website snapshots, multi-file wiki semantics). When absent, the core scans:
  //   the core walk (git-aware, symlink-safe, skip-dirs) × adapter.recognize per
  //   file, drained and diff-persisted per directory (§14.2).
  // An adapter that overrides index() MUST either keep recognize() coherent with it
  // (conformance: index() output equals the fold of recognize() over the walk) or
  // declare component-level incrementality (§14.2).
  index?(
    installation: BundleInstallation,
    component: BundleComponent,
  ): AsyncIterable<IndexDocument>;

  // REQUIRED — native validation. The core supplies the context; the adapter never
  // reads the live filesystem during validation.
  validate(
    component: BundleComponent,
    changes: readonly FileChange[],
    ctx: ValidateContext,
  ): Promise<Diagnostic[]>;
}

interface ValidateContext {
  // Reads served from the run's snapshot WITH the pending changes overlaid —
  // one core overlay implementation, not one per adapter.
  readFile(path: string): Promise<string | Uint8Array | null>;
  list(dir: string): Promise<string[]>;
  // Read-only index lookup for link/xref existence checks (not search).
  resolveRef(ref: string): Promise<{ exists: boolean; path?: string }>;
}
```

The core walk is a single implementation carrying the security policy (symlink refusal, traversal containment, skip-dirs); adapters MUST NOT reimplement it. Native-shape rules belong to the adapter; **cross-component ref existence is a core base check** run on every transaction, since it belongs to no single adapter.

### 12.2 Authoring methods (optional)

```ts
  getAuthoringContext?(
    component: BundleComponent,
    target: { path?: string; conceptId?: string },
    operation: "create" | "update" | "move" | "consolidate",
  ): Promise<AuthoringContext>;

  create?(
    component: BundleComponent,
    request: CreateRequest,
  ): Promise<FileChange[]>;

  placeNew?(component: BundleComponent, conceptId: string): string;
  directoryList?(component: BundleComponent): string[];   // feeds git exact-path staging
  looksLikeRoot?(root: string): boolean;                   // install-time probe (§9.4 ordering)
```

`AuthoringContext` MUST include hashes or versions for the rules and guidance used so proposal fingerprints are reproducible.

### 12.3 Export methods (optional)

```ts
  listExports?(
    installation: BundleInstallation,
    component: BundleComponent,
  ): AsyncIterable<BundleExport>;

  planBinding?(
    component: BundleComponent,
    exported: BundleExport,
    request: BindingRequest,
  ): Promise<BindingPlan>;
```

### 12.4 Memory lifecycle methods (optional)

```ts
  listMemories?(
    installation: BundleInstallation,
    component: BundleComponent,
  ): AsyncIterable<MemoryRecord>;

  renderMemoryPlan?(
    component: BundleComponent,
    plan: MemorySemanticPlan,
  ): Promise<FileChange[]>;

  validateMemoryPlan?(
    component: BundleComponent,
    plan: MemorySemanticPlan,
    changes: readonly FileChange[],
  ): Promise<Diagnostic[]>;
```

The method groups in §12.2–§12.4 are members of the single `BundleAdapter` interface of §12.1, shown separately for readability.

### 12.5 Excluded adapter responsibilities

Adapters MUST NOT:

- implement workspace search;
- own proposal or outcome stores;
- apply filesystem changes directly;
- commit or push Git changes;
- authorize execution;
- register arbitrary stages inside every improve run;
- replace core refs, diagnostics, or file-change envelopes;
- require core code to switch on native `type`s.

### 12.6 Built-in registry first

The first implementation SHOULD use a static built-in adapter registry. A public plugin ABI is deferred until the contract is proven by multiple independently maintained adapters.

---

## 13. Conventions and authoring rules

### 13.1 Adapter ownership

Conventions and authoring rules move to adapters. They are not removed.

Each authoring-capable adapter MUST own:

- required native files and layout;
- required and optional metadata;
- hard syntax and semantic constraints;
- soft naming, style, and organizational conventions;
- guidance-file discovery and precedence;
- operation-specific instructions;
- native scaffolding;
- validation and repair generation.

### 13.2 One source for prompts and validation

Hard-rule instructions shown to humans or models and hard-rule validators MUST derive from the same adapter-owned rule definitions.

A change to a required field, naming rule, or layout constraint MUST NOT require independent edits to an unrelated central prompt and validator.

### 13.3 Native examples

- The OKF adapter follows the [OKF specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md), including open-ended concept types and permissive consumption.
- The Agent Skills adapter follows the [Agent Skills specification](https://agentskills.io/specification), including its `SKILL.md` frontmatter and progressive-disclosure layout.
- The Claude adapter follows native `CLAUDE.md`, `.claude/rules/`, skill, command, and subagent behavior documented by [Claude Code](https://code.claude.com/docs/en/memory).
- The OpenCode adapter follows native `AGENTS.md`, precedence, agent, command, and compatibility behavior documented by [OpenCode](https://opencode.ai/docs/rules/).
- The LLM Wiki adapter owns `schema.md`, `index.md`, `log.md`, raw-source, page, citation, and native ingest behavior.

### 13.4 Workspace policy

Workspace policy remains cross-format and operational. It MAY restrict:

- writable paths;
- protected files;
- execution;
- engines and tools;
- environment and secret bindings;
- scheduler registration;
- auto-apply classes;
- memory quotas and retention.

Workspace policy MUST NOT silently rewrite native format semantics.

---

## 14. Indexing

### 14.1 Normalized projection

The common content model ends at `IndexDocument`:

```ts
interface IndexDocument {
  ref: string;              // fully-qualified "bundle//conceptId" (§11.1)
  bundle: string;
  component: string;        // provenance, derived (§7.8)
  conceptId: string;
  path: string;             // absolute local path (the read path)
  hash: string;
  adapterId: string;
  type?: string;            // open; frontmatter (native) or adapter-derived (foreign)

  // FTS columns (weights pinned, §14.4)
  name: string;             // 10
  description?: string;     // 5
  tags?: string[];          // 3
  hints?: string[];         // 2
  content?: string;         // 1

  // Core-parsed query-time signals. These fields are read by ranking contributors
  // and result filters at query time and are therefore FIRST-CLASS, not folded
  // into documentJson. This list is pinned by a lint; extending it is a
  // deliberate schema change.
  aliases?: string[];       // exact-alias boost is distinct from the tags signal
  searchHints?: string[];
  quality?: string;         // curated boost + proposed-by-default exclusion filter
  confidence?: number;
  beliefState?: string;     // + boosts, score ceilings, --belief filter
  currentBeliefRefs?: string[];
  supersededBy?: string;
  scope?: Record<string, string>;   // scope_user/agent/run/channel filters
  captureMode?: string;
  lessonStrength?: number;
  pinned?: boolean;
  fileSize?: number;        // hit size + estimated tokens
  derivedFrom?: string;     // derived-twin belief inheritance
  links?: string[];         // resolved native links = relationships (§26.3)
  updated?: string;

  documentJson?: unknown;   // opaque adapter extras ONLY; not FTS; never parsed by core
}
```

`type` is an open descriptive label (the OKF field, DEV-1). It MAY drive presentation, ranking, and filtering. It MUST NOT authorize execution, be part of identity, or select the core storage/write path. Sensitivity suppression (env/secret redaction — existing behavior, ported) is keyed on the **adapter**, never on `type`, so frontmatter cannot opt out of it.

The folding rules that map richer native metadata (examples, usage, intent, xrefs, when-to-use, outline, parameters, body opening) into the FTS `hints`/`content` columns are a **core-shared helper that adapters call** — one fold, not one per adapter — because the embedding-input hashes and frozen retrieval canaries are pinned to that exact surface.

### 14.2 Scan flow and diff persistence

*(Amended v0.4, 2026-07-21 — the implemented engine: the core walk × the dispatched `adapter.recognize`, drained and diff-persisted per directory. The retired `scanComponent` wrapper and its nested-root subtraction are gone with multi-component bundles.)*

```text
materialize bundle revision
-> select the persisted component and its adapter (adapterForId(component.adapter);
   unknown id ⇒ skip the component with a warning)
-> for each walked directory: core walk (universal hygiene) × adapter.recognize
   (or adapter.index override) → DRAIN the directory's document stream
-> one write transaction: DIFF persist against the directory's existing rows
-> build FTS/vector/native-link projections incrementally
```

Persistence is a **diff, not truncate-and-rewrite**:

- upsert by `ref` (ON CONFLICT DO UPDATE), preserving the integer row id so embeddings, FTS, vector joins, and utility state survive unchanged rows; re-embedding is skipped when `hash` is unchanged;
- delete only rows whose ref disappeared, through the full related-row cascade with the usage-event detach-and-relink behavior;
- durable behavioral state (utility, usage, feedback) keys on `ref`, not the row id, so even id churn cannot destroy it;
- a scan that yields zero documents is only a legitimate mass-delete when the component root exists and is readable (a mandatory core preflight); a missing or unreadable root preserves last-known-good rows with a warning.

**Incrementality is item-scoped, not file-scoped.** The mount manifest records `{scanGeneration, adapterVersion, items: {conceptId → fileSet+hashes}}`. A changed file re-recognizes every file belonging to the affected item(s); adapters MAY implement `affectedItems(component, changedPaths)` (default: identity for single-file items) and MAY declare coupling files (e.g. a wiki `schema.md`) whose change escalates to a component rescan. Directory-scoped items (a skill directory) are one item: sibling adds/edits/deletes invalidate the item, and deleting the primary file deletes the item. The incremental FTS dirty-queue and the zero-row dir-state classification carry forward into this manifest design.

### 14.3 Query isolation

Adapters, materializers, registries, and network services MUST NOT execute during a normal search query.

If one adapter scan fails, AKM MUST preserve the last-known-good index records for that component (guaranteed by drain-before-transaction, §14.2) and continue serving unaffected bundles with a warning.

### 14.4 Search parity during migration

The initial adapter cutover MUST preserve the existing weighted fields and behavior unless a benchmarked change is separately approved:

```text
name         10
description   5
tags          3
hints         2
content       1
```

The cutover gate MUST compare:

- emitted refs and paths;
- field contents;
- embedding-input hashes;
- deterministic top-k order;
- top-k overlap;
- MRR and nDCG;
- **filter-behavior parity** — the proposed-by-default exclusion, `--belief`, and scope-filter result sets, which rank metrics alone do not catch;
- **whyMatched parity**;
- index size and build duration;
- query p50/p95 latency;
- incremental add/change/delete behavior.

The retrieval-canary set is pinned to the old field-fold surface; the cutover MUST schedule an explicit canary re-mint as a named migration step.

### 14.5 Deterministic indexing by default

Index correctness MUST NOT require an LLM.

Index-time LLM metadata or graph enrichment MAY exist only as an explicit, versioned derived processor that has demonstrated measurable value. It MUST NOT mutate bundle content.

### 14.6 Index mutability rule

`akm index` MUST write only workspace index/cache state. It MUST NOT regenerate `index.md`, rewrite frontmatter, repair links, or otherwise mutate bundles.

Native maintenance fixes belong to adapter lint/fix, import, ingest, create, or improve operations.

---

## 15. Search and read behavior

### 15.1 Local content search

`akm search` searches installed local bundle content only. Registry/package discovery is a separate operation.

Search MAY filter by:

- bundle;
- component;
- adapter;
- open native `type`;
- workspace scope or policy fields that are actually indexed.

Unknown native `type`s MUST remain searchable.

*(A v0.2 clause making the `trusted` flag load-bearing in search/show output — untrusted labeling and action clamping — was withdrawn in v0.3: new trust machinery is rejected as false-confidence machinery, deviation §4.3c. `trusted` remains reserved vocabulary on `BundleInstallation` for a possible Tier-B future; nothing reads it.)*

### 15.2 Progressive disclosure

AKM SHOULD expose three retrieval levels:

```text
L0 card      name, description, type, tags, hints
L1 overview  outline, navigation, relationships, applicability
L2 detail    full native file content and supporting resources
```

This follows the useful retrieval pattern demonstrated by [OpenViking](https://github.com/volcengine/OpenViking/blob/main/docs/en/concepts/03-context-layers.md) and [Agent Skills](https://agentskills.io/specification), but AKM MUST keep generated cards, overviews, chunks, and embeddings in the index unless the native format itself defines portable sidecar files.

### 15.3 Direct reads

Normal item reads MUST use the absolute path stored in the index:

```ts
const content = await fs.promises.readFile(indexed.path, "utf8");
```

The core SHOULD NOT add `adapter.read()`, `repository.read()`, or content-provider layers around deterministic filesystem reads.

Adapters MAY provide specialized parsing only when a runtime or authoring operation needs native structure.

**Sensitivity exception.** The raw-read rule does not apply to items in sensitivity-suppressed components: for `dotenv`/secret components, `show` and search MUST present only the safe metadata surface (key names / file name, §21.2) and MUST NOT read or print the body. This suppression is keyed on the **adapter/component**, never on the open `type`, so a frontmatter `type:` cannot opt out of redaction and a generic fallback cannot dump a credential file.

### 15.4 `show`

`show` SHOULD:

1. resolve the item ref from the index;
2. read the stored path (subject to the §15.3 sensitivity exception);
3. return native content plus indexed metadata, rendered by the named presentation function for its `type`;
4. record a usage event.

It MUST NOT run global matchers, type-competition registries, graph extraction, or wiki/type special cases.

**Presentation code home.** The `type → presentation` mapping is a data table (`TYPE_PRESENTATION`, typed over the `KNOWN_TYPES` const tuple so the compiler enforces exhaustiveness for AKM's own known set, with an open-string lookup falling back to the generic entry), but the renderer implementations it names remain a small static core module of named functions (env-keys-only, secret-name-only, script-exec-hints, markdown view modes, generic). "No renderer registry" in the acceptance criteria means no per-type *competition* registry with dynamic registration — not that renderer code disappears.

### 15.5 Context selection

The current curated result-selection logic MAY remain as a search result shape or `context` command. It SHOULD NOT remain a separate content subsystem and MUST NOT trigger hidden model work or graph extraction.

---

## 16. Website sources

Website support remains a first-class source capability.

### 16.1 Refreshable website bundle

```text
website materializer
-> bounded crawl and neutral snapshot files
-> website-snapshot adapter
-> read-only indexed component
```

The materializer MUST retain, per page where available:

- canonical URL;
- final fetched URL;
- title;
- content or converted Markdown;
- content hash;
- outgoing links;
- fetch timestamp;
- ETag and Last-Modified values;
- crawl provenance.

It MUST preserve existing protections for:

- SSRF and private-host blocking by default;
- redirect revalidation;
- response byte limits;
- page/depth limits;
- crawl deadlines;
- stale-cache fallback;
- explicit refresh/force behavior.

A refresh creates a new materialized revision. Search uses the last successful local revision.

### 16.2 Website-to-native export

AKM MUST also support transforming a website snapshot into a writable native bundle component:

```text
website snapshot
-> destination adapter authoring context
-> destination FileChange[]
-> native validation
-> proposal or application
```

Example:

```text
akm ingest typescript-docs/pages \
  --to personal/knowledge \
  --adapter okf
```

The live website installation remains refreshable and read-only. The exported destination is separately editable, versioned, and eligible for ordinary improvement.

---

## 17. Registry and package discovery

Registry search MUST be separate from local content search.

A registry entry SHOULD describe:

- package identity and version;
- source locator;
- description and tags;
- optional `akm.bundle.yaml` location;
- component adapters and roots;
- declared exports;
- integrity or signing information where supported.

Registry entries SHOULD NOT require per-item asset previews or an AKM-wide asset-type inventory.

The registry discovers installable bundle packages. The local workspace index discovers installed content.

Because default-mounting arbitrary repositories is easy under this design, integrity handling tightens for untrusted sources: installations MUST pin the resolved revision in lock state, and an unrecognized integrity format is a hard failure for an untrusted source rather than a warning. (Git commit-hash sources remain pin-by-revision; npm sources verify integrity as today.)

---

## 18. Installation, exports, bindings, and activation

**Release-staging note (2026-07-14, deviation §4.3a/§4.3c — mirrors the §25 staging pattern).** This section is target-state. What ships in 0.9.0 is **Tier A only**: §18.2's install-grants-nothing (already true in code, consolidated into one workspace activation-policy point and verified by port-preservation tests). The persisted Binding record (§18.3), digest-change detection and rebind (§18.5, §20 steps 1–5), one-shot approval checks (§18.4), and the bind CLI (§29) are **Tier B, deferred indefinitely — revisit only on concrete demand**. Deferral rationale: approval/trust machinery built ahead of demand provides false confidence and must be maintained as brittle code. The accepted Tier-A residual: enabled schedules and one-shot invocations that reference content in installed sources re-read current disk content per invocation (crontab semantics); §18.5/§20's update-review MUSTs therefore have no enforced trigger in 0.9.0 and bind (§18.1) reads as "explicit enable."

### 18.1 Lifecycle

```text
discover
-> install/materialize
-> index
-> bind or explicitly approve one-shot use
-> enable external side effects where applicable
```

### 18.2 Installation

Installation makes content locally available and searchable. It MUST NOT:

- execute scripts;
- schedule tasks;
- grant tools;
- inject environment values;
- expose secrets;
- activate agents or workflows automatically.

### 18.3 Binding

A persistent binding SHOULD record:

- binding ID and alias;
- export ref;
- bundle revision and export digest;
- resolved engine/harness;
- parameters;
- tool and permission policy;
- environment and secret mappings;
- working-directory policy;
- enabled state;
- scheduler registration identity when applicable.

### 18.4 One-shot invocation

A workspace MAY allow explicit one-shot execution without a persistent binding. Such execution MUST still pass the same approval, trust, digest, environment, and permission checks.

### 18.5 Update behavior

Updating an installed bundle MUST NOT silently alter:

- an in-flight workflow;
- an enabled task schedule;
- a bound environment contract;
- approved tools or permissions.

AKM MUST detect export digest changes and require policy-controlled review or rebinding for meaningful runtime changes.

---

## 19. Workflow exports

Workflows remain portable bundle files.

A workflow adapter MUST be able to:

- discover and validate native workflow definitions;
- index them;
- expose workflow exports;
- load a normalized workflow definition for compilation;
- provide native create/update guidance.

A workflow run MUST freeze:

- bundle revision;
- export digest;
- normalized plan;
- plan hash;
- resolved non-secret engine settings;
- relevant environment binding identities.

An installed-bundle update MUST NOT change an in-flight run.

Workflow loading SHOULD be:

```text
export ref
-> indexed absolute path
-> workflow adapter/codec
-> normalized definition
-> frozen plan
```

It SHOULD NOT depend on a universal `workflow:` ref, a core-required `workflows/` directory, or a required `workflow_documents` index table.

---

## 20. Task exports and scheduling

Task definitions remain portable bundle content.

A task definition MAY contain:

- schedule template;
- workflow, prompt, command, or script target;
- default parameters;
- timeout;
- environment requirements;
- enabled-by-default recommendation, which is advisory only.

Installation MUST NOT register an operating-system schedule.

Binding a task resolves:

- target export and digest;
- local parameters;
- environment and secret bindings;
- engine and permission policy;
- scheduler backend;
- local enabled state.

Enabling the binding registers the schedule.

When an installed task definition changes, AKM MUST:

1. detect the digest change;
2. validate the new native definition;
3. show schedule, target, and environment differences;
4. preserve the currently active binding until the update is approved;
5. retain run history across task versions.

---

## 21. Environment and secret exports

### 21.1 Portable environment content

Bundles MAY include:

- `.env` templates;
- complete private environment files;
- key contracts;
- descriptions;
- required/optional declarations;
- non-secret defaults;
- secret placeholders;
- certificates or configuration files intended for binding.

### 21.2 Indexing

The environment adapter MUST index only safe metadata:

- export name;
- key names;
- descriptions;
- required/optional status;
- non-secret defaults only when policy permits.

Values and comment text MUST NOT be indexed or printed.

### 21.3 Binding

A workspace environment binding MAY map a portable key to:

- a local process environment variable;
- an owner-only local file;
- a system keychain or external secret manager;
- an AKM secret binding;
- a literal non-secret override;
- a value already contained in a deliberately trusted private bundle.

Using values from an installed bundle requires explicit approval. Installation alone is never sufficient.

### 21.4 Secret handling

Secret-bearing content MUST preserve current protections:

- owner-only permissions where supported;
- no values in output or telemetry;
- no shell sourcing of untrusted dotenv content;
- process injection without command substitution;
- path containment;
- dangerous environment-key policy;
- redaction in logs and errors.

---

## 22. Agents, commands, skills, and scripts

### 22.1 Native formats

Claude agents, OpenCode agents, Agent Skills, commands, prompts, and scripts remain in their native files.

The core MUST NOT inject universal AKM metadata or OKF fields into native files when that would violate or distort their schema.

### 22.2 Runtime separation

The architecture SHOULD separate:

```text
BundleAdapter             native file interpretation
SessionEvidenceProvider   native session-log discovery
RuntimeHarness            execution and output normalization
```

A product such as Claude or OpenCode may implement all three, but they are distinct responsibilities.

### 22.3 Execution authority

An item carrying `type: script`, `type: skill`, or an executable export does not authorize execution. Execution requires an explicit invocation or enablement; runtime handlers never consult `type` for authority (§8.4).

This follows the useful distinction in [MCP](https://modelcontextprotocol.io/docs/learn/server-concepts) between passive resources and executable tools.

---

## 23. File changes and proposals

### 23.1 FileChange

```ts
interface FileChange {
  path: string;
  beforeHash?: string;
  after?: string | Uint8Array;
  delete?: true;
}
```

A proposal contains one or more `FileChange` records. Proposal and change set are the same durable object; AKM SHOULD NOT create a chain of candidate, proposal, mutation plan, and change-set wrappers unless a concrete requirement proves necessary.

### 23.2 Before-hash rule

Every update or deletion MUST carry the expected before hash. Application MUST fail when the current file differs.

### 23.3 Proposal evidence

A proposal SHOULD include:

```ts
interface ProposalEvidence {
  fingerprint: string;
  triggerIds: string[];
  evaluator?: string;
  passed?: boolean;
  metrics?: Record<string, number>;
  details?: unknown;
}
```

Recipe-specific details MAY remain opaque.

### 23.4 Transaction engine

The core transaction engine MUST:

1. group changes by component root;
2. validate path and symlink containment;
3. verify before hashes;
4. obtain the workspace mutation lease;
5. stage replacement content;
6. maintain a durable recovery journal;
7. apply writes, deletes, and moves;
8. invoke adapter validation;
9. roll back on validation or publication failure;
10. refresh affected index rows once;
11. commit exact Git paths when configured;
12. record proposal/change and audit outcomes.

Adapters MUST NOT apply their own writes or Git commits.

### 23.5 Change classes

| Change class | Default policy |
|---|---|
| Mechanical and deterministic | Auto-apply after validation |
| Objectively verified semantic | Auto-apply only when explicitly configured |
| Subjective semantic | Queue for review |
| Destructive | Queue unless exact and deterministic |

Model self-confidence MAY be stored as diagnostic metadata. It MUST NOT authorize publication.

### 23.6 Input fingerprint

The fingerprint SHOULD be:

```text
hash(
  recipe version
  + target before hashes
  + evidence IDs or hashes
  + applicable guidance hashes
  + relevant evaluator version
)
```

An already processed fingerprint SHOULD skip another model call unless explicitly forced.

---

## 24. Improve architecture

### 24.1 Purpose

`akm improve` is an evidence-driven, verified file-evolution loop. It is not a general maintenance daemon.

### 24.2 Semantic operations

The core supports three first-class semantic operations:

```text
revise       update an existing durable item
learn        create a new durable item from evidence
consolidate  reduce or formalize bounded memory with source retirement
```

Adapters do not register arbitrary improve processes. Recipes are core-owned, separately designed, tested, and evaluated.

### 24.3 Run flow

```text
collect corrective evidence and pressure signals
-> freeze file/index snapshot
-> select targets
-> read indexed paths directly
-> obtain adapter authoring context
-> generate candidate FileChange[]
-> validate native format and workspace policy
-> compare candidate with baseline
-> queue or apply
-> reindex affected files once
-> observe later field outcomes
```

### 24.4 Corrective evidence

Unattended semantic candidate generation MAY be triggered by:

- explicit user feedback;
- task or evaluation failure;
- native lint/conformance failure;
- broken links or missing references;
- new contradiction evidence;
- new session evidence;
- recurring independent evidence;
- memory high-water pressure;
- explicit TTL or retention expiry;
- deterministic duplicate or supersession evidence.

High retrieval, age without retention policy, low retrieval, salience, file size, or elapsed time alone MUST NOT authorize semantic rewrite or deletion.

### 24.5 Verification ladder

#### Native safety

- adapter validation;
- path and hash safety;
- protected data preservation;
- link integrity;
- no secret exposure;
- write permission;
- binding compatibility.

#### Objective comparison

- task replay;
- workflow dry run;
- tests;
- rank-aware retrieval comparison;
- required-claim/provenance coverage;
- destination-specific executable or conformance checks.

#### Field outcome

- human acceptance;
- later positive/negative feedback;
- production task success;
- survival without revert;
- measurable later use.

A generic LLM judge may support classification but is not objective proof. This caution is supported by research on self-correction limitations and judge bias, including [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798), [Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685), and [Judging the Judges](https://arxiv.org/abs/2406.07791).

### 24.6 Removed from the replacement core

The replacement MUST NOT carry forward by default:

- model-confidence auto-acceptance;
- threshold auto-tuning based on validator survival;
- live exploration promotion;
- generic self-consistency voting;
- generic self-critique loops;
- high-retrieval rewrite lanes;
- proactive semantic rewriting without corrective evidence;
- same-run multi-cycle evolution;
- procedural compilation without executable recurring evidence;
- improve-owned graph extraction;
- improve-owned event/log/database retention;
- direct semantic writes from individual processes.

Any removed mechanism MAY return only after an ablation demonstrates positive verified quality per unit cost.

---

## 25. Bounded memory lifecycle

**Release-staging note (2026-07-14, deviation §4.3b).** This entire section is **target-state; none of it is 0.9.0 scope**. 0.9.0 ships only the consolidate.ts decomposition with existing behavior preserved exactly (plan §6): the current merge/delete/promote/contradict ops through `archiveMemory`, journals, LOOK/CHANGE separation, hot-capture guard, and proposal-gating, all as today. The lifecycle state model below (operational states, water-marks/backpressure, claim coverage, sandbox evaluation, content-addressed archive, purge, overlay) begins only after the claim extractor and its benchmark exist — it is feature work, staged behind its load-bearing dependency, and gets its own design pass then.

Memory lifecycle is a first-class product requirement and remains part of improve.

### 25.1 Adapter capability

A memory-capable adapter maps native records into a narrow `MemoryRecord` inventory and renders native changes from a semantic plan. It owns serialization and native lifecycle conventions. Core owns pressure, selection, evaluation, retirement state, archive, and purge.

### 25.2 Operational states

```text
active
  -> retired
  -> purged

active
  -> quarantined
  -> restored | purged
```

- **Active:** indexed and normally retrievable.
- **Retired:** excluded from default retrieval and recoverable during a grace period.
- **Quarantined:** excluded immediately for security, privacy, corruption, or injection risk.
- **Purged:** archived bytes removed under policy.

Adapter-native relations such as superseded, contradicted, historical, or deprecated remain semantic metadata and do not replace operational lifecycle state.

### 25.3 Consolidation outcomes

#### Compact within memory

```text
many duplicate or overlapping memories
-> fewer stronger memory records
-> retire redundant sources
```

#### Formalize into durable content

```text
memory cluster
-> create or update knowledge, lesson, convention, workflow, etc.
-> verify source coverage
-> retire source memories
```

The destination is selected by bundle configuration and adapter capability, not a hard-coded core type.

#### Retire without formalization

Allowed only for:

- explicit TTL-expired ephemeral memory;
- exact duplicate with a surviving source;
- explicit supersession;
- known obsolete transient state;
- invalid or unsafe capture;
- user-requested forgetting;
- explicit policy-approved removal with adequate provenance and review.

Age or low use alone is insufficient.

### 25.4 High- and low-water policy

A memory-capable component MUST have either explicit bounds or a documented unbounded policy. The recommended bounded configuration is:

```yaml
memory:
  highWaterItems: 1000
  lowWaterItems: 800
  highWaterBytes: 52428800
  retireGraceDays: 30
  archiveRetentionDays: 180
  archiveMaxBytes: 1073741824
  backgroundIntakeWhenBlocked: skip   # default; "queue" is allowed only as a bounded queue (§25.4)
```

When a high-water threshold is exceeded:

1. deterministic cleanup runs first;
2. semantic consolidation attempts to reach the low-water mark;
3. unsafe deletion is prohibited;
4. if safe consolidation cannot reduce pressure, background extraction **stops publishing memory files** for that component;
5. explicit user-authored memory remains allowed with a warning;
6. health reports the unresolved pressure and blocked intake.

Backpressure is the required fail-safe when safe deletion cannot be proven. **The default blocked-intake behavior is SKIP-with-warning, not a new queue tier:** sessions and captured evidence already persist durably in workspace state, so a blocked extraction simply defers — re-extraction picks the evidence up when pressure clears. An implementation MAY provide an explicit evidence queue instead, but only as a bounded one (item, byte, and age limits, a defined eviction policy with an event, and drain-on-pressure-clear semantics); an unbounded queue merely displaces the unboundedness this section exists to prevent. Pressure state MUST NOT be an input to per-item disposition classification (§25.6).

### 25.5 Consolidation pipeline

```text
1. inventory and freeze snapshot
2. deterministic duplicate/supersession/TTL cleanup
3. build bounded semantic clusters
4. classify keep/compact/formalize/contradict/retire/quarantine
5. generate successor through destination adapter
6. build source-to-successor claim coverage map
7. render native FileChange[]
8. validate native formats and policy
9. build sandbox index and run retrieval/task checks
10. propose or apply
11. retire source memories
12. monitor grace period
13. purge archive when eligible
```

Two placement rules that implementations MUST NOT diverge on:

- **The step-9 sandbox is constructed from the run snapshot plus the candidate FileChanges.** The live index is not read or mutated before step 10; a lazily-reindexed live store would violate the one-snapshot rule (§6.6) and make step-9 failures unrecoverable.
- **Steps 12–13 are cross-run and do not belong to an improve run.** Grace monitoring and purge run as a deterministic lifecycle sweep at improve-run start plus an explicit `akm memory purge` command, consistent with §24.6's removal of improve-owned retention.

### 25.6 Claim coverage

For **unattended** semantic consolidation, every durable source claim MUST have one disposition:

```text
preserved in successor
preserved in another active source
explicitly superseded
intentionally discarded with recorded reason
```

A durable claim with no disposition blocks unattended retirement.

**Reviewed mode:** when a semantic consolidation is queued as a proposal (the default, §25.9), explicit human approval of the proposal satisfies the disposition requirement — the reviewer is the disposition authority. The coverage map is still produced when an extractor is available, as review evidence.

**Authority rules:**

- the coverage verifier MUST be independent of the model that generated the successor (deterministic sentence/heading anchoring cross-checked, or a separate verifier) — a self-reported coverage map from the generator is the self-assessment pattern §24.5 rejects;
- the `intentionally discarded` disposition is valid in unattended mode only when produced by a deterministic rule from an explicit policy allowlist; otherwise it forces proposal review;
- pressure state MUST NOT be an input to disposition classification (§25.4).

**Staging:** the claim extractor and its benchmark (§33) are the load-bearing prerequisite for this entire section — nothing here is built before they exist (release-staging note at the top of §25). When the lifecycle is built, unattended semantic retirement stays OFF until the extractor passes its benchmark; deterministic auto-retirement (§25.9 rows 1–4) and review-gated semantic proposals come first.

Temporal qualifiers and contradictions MUST NOT be flattened into a false single statement.

### 25.7 Retirement evaluation

Before retiring semantic source memories:

- source hashes MUST match the plan;
- destination validation MUST pass;
- all durable claims MUST have dispositions;
- provenance MUST identify source refs and hashes;
- historical queries that retrieved a source SHOULD retrieve a successor within configured rank tolerance;
- protected retrieval canaries MUST not regress;
- destination-specific tests MUST pass;
- destination publication MUST succeed before source retirement.

**Scoping.** The first shipped retirement gate is an FTS-only sandbox replay (canaries plus the logged per-source queries, with successor-following), advisory-blocking for unattended retirement; full rank-parity replay (utility/salience/graph extras) is deferred until the §26.2 ranking ablations decide which extras survive. The retrieval-canary probe and its store are **preserved infrastructure** — they are this gate's harness and are explicitly excluded from any prove-or-delete measurement of the advisory collapse-alert loop. Usage-event retention for memory-tier entries MUST be long enough (or per-source query lists snapshotted at capture time) that the replay set does not silently starve.

Cross-bundle or cross-repository formalization MUST use a recoverable two-phase protocol:

1. publish and validate destination;
2. retire sources only after destination success.

### 25.8 Retirement archive

Retired bytes MUST NOT accumulate in an unbounded bundle-local archive.

*(Decision note: this deliberately supersedes the 2026-06-15 WS-3a in-code retirement of archive-retention machinery, which relied on git history as the sole recovery path. The reversal is recorded as D27 in the decision history: read-only components, non-git-backed bundles, and format-independent recovery all require a workspace-owned archive; git history remains an additional recovery path, not the only one. The existing bundle-local `archiveMemory` move is an acceptable bounded stopgap only until this store ships — there is one retirement encoding at any given time, not two.)*

The default archive is a workspace content-addressed store:

```text
$DATA/archive/blobs/sha256/<digest>
```

The blob store and its state records MUST use owner-only filesystem modes where the platform supports them (0600 files / 0700 directories) — retired and quarantined bytes can contain sensitive captures — and the same sensitive-content redaction and quarantine handling that applies to the live index applies to archive metadata.

State records SHOULD include:

- original bundle/component/ref/path;
- source hash;
- proposal/change ID;
- retirement reason;
- successor refs;
- retired time;
- purge eligibility;
- pin or legal-hold state.

Git history is an additional recovery path, not the only one.

### 25.9 Automatic policy

| Candidate | Default action |
|---|---|
| Byte-identical duplicate | Auto-retire redundant copy |
| Equivalent normalized content and provenance | Auto-retire after deterministic proof |
| Explicit supersession with valid successor | Auto-retire |
| TTL-expired ephemeral memory | Auto-retire |
| Unsafe or sensitive capture | Quarantine |
| Semantic near-duplicate merge | Proposal by default |
| Formalization into durable content | Proposal by default |
| Contradictory memories | Preserve and qualify |
| Old or low-use memory only | Keep or de-prioritize |
| Failed coverage or retrieval evaluation | Keep active |

### 25.10 Read-only components

Workspace retirement MAY suppress a read-only installed memory from default retrieval without mutating its source. Actual source deletion or rewrite requires a writable component or a writable clone/export destination.

---

## 26. Feedback, ranking, graph, and evaluation

### 26.1 Feedback

AKM SHOULD retain explicit positive/negative feedback and usage events as workspace state.

Feedback MUST NOT mutate portable content merely to record telemetry. For example, lesson-use counters belong in state, not frontmatter.

### 26.2 Ranking baseline

Complex signals such as salience vectors, outcome scores, review pressure, project-context boosts, type boosts, replay, and forgetting-safety MUST be compared against a simpler baseline:

```text
lexical/vector relevance
+ explicit feedback utility
+ recent successful use
+ negative-feedback review priority
```

Only features that materially improve nDCG, MRR, task-context success, verified-change yield, or user preference SHOULD remain.

New `type`s receive no ranking boost by default.

### 26.3 Relationships

Adapters SHOULD expose deterministic native links and relationships first.

LLM graph extraction MAY remain as an optional derived index processor only if ablation shows material search or task-context value. It MUST NOT execute from `show`, context selection, or improve.

### 26.4 Candidate evaluation

AKM SHOULD reuse and extend its deterministic rank-aware benchmark infrastructure for before/after proposal evaluation, including:

- nDCG;
- MRR;
- recall;
- banned-hit checks;
- exact top-k and overlap;
- protected-query canaries;
- task or workflow replay;
- cost and latency.

---

## 27. Storage model

The target workspace uses three databases:

```text
state.db  durable workspace truth
index.db  fully regenerable search and derived cache
logs.db   high-volume purgeable logs
```

### 27.1 state.db

Contains durable non-regenerable state such as:

- bundle and binding state not represented in config/lock;
- events and feedback;
- proposals and changes;
- workflow runs, steps, and units;
- task history and scheduler state;
- evidence cursors;
- memory lifecycle, retirement, and purge records;
- change outcomes;
- migration ledgers.

`workflow.db` SHOULD be merged into `state.db` because both are durable workspace state and benefit from atomic run/event transitions.

### 27.2 index.db

Contains fully regenerable state such as:

- indexed documents;
- FTS tables;
- embeddings;
- derived outlines and chunks;
- deterministic native-link graph;
- optional measured LLM enrichments;
- materialized ranking features.

Deleting `index.db` and rebuilding MUST be safe.

### 27.3 logs.db

Contains high-volume, append-only, purgeable logs. It remains separate to permit aggressive retention without affecting durable state.

### 27.4 Filesystem locations

- Configuration belongs under the platform configuration directory.
- Durable state and archives belong under the platform data directory.
- Derived caches, materialized read-only sources, and temporary evaluation data belong under the cache directory.
- Bundle roots contain only intentional portable files.

AKM MUST NOT create `.akm` runtime state inside bundle roots.

---

## 28. Security and trust

### 28.1 Passive content versus executable authority

Indexing or displaying a bundle is not execution approval.

Runtime authority is granted through a binding or explicit approved invocation, following the same conceptual separation between passive resources and executable tools described by MCP.

### 28.2 Untrusted content

Untrusted bundle content MAY be indexed as text, subject to size and sensitivity policy. It MUST NOT:

- grant tools;
- change engine configuration;
- activate schedules;
- inject environment or secret values;
- execute scripts;
- write outside its component root.

*(Two v0.2 clauses — untrusted presentation clamping and a catch-all sensitive-content refusal — were withdrawn in v0.3, deviation §4.3c. Catch-all adapters remain explicit-configuration-only and never auto-selected (§9.4): a user who mounts a root with `generic-files` indexes what they pointed it at, deliberately.)*

The dangerous-environment-key policy keeps its origin asymmetry across the config migration **as a port of the existing rule** (today: `registryId`-bearing source → hard block; first-party → warn): an env export from a registry-installed source containing process-hijacking keys MUST still hard-error after `installed[]` is replaced, covered by a port-preservation conformance test. This is existing behavior surviving the migration, not new machinery.

### 28.3 Path safety

Materialization, indexing, validation, and mutation MUST enforce:

- realpath-aware containment;
- symlink escape prevention;
- safe archive extraction;
- owner-only modes for sensitive local files where supported;
- bounded file and network response sizes.

### 28.4 Secret safety

Secret values MUST NOT enter:

- search projections;
- proposal diagnostics;
- events;
- logs;
- model prompts unless explicitly required and permitted;
- generated bundle indexes;
- **`state.db` rows, including Binding records.** A Binding stores only references/handles to secrets (keychain id, secret-manager path, AKM secret ref) — never a resolved secret value; the "literal override" mapping (§21.3) is restricted to declared-non-secret values, enforced at bind time. state.db is durable and captured by backups, so a value stored there is a value exfiltrated by every backup.

---

## 29. CLI and public API direction

The logical command surface SHOULD converge toward:

```text
akm init
akm info
akm health

akm bundle create|install|list|show|items|update|remove|sync|export
akm registry search|show

akm search
akm show
akm lint
akm import
akm ingest

akm bind|unbind|bindings        # Tier B — deferred with the Binding record (§18 staging note)

akm proposal list|show|diff|accept|reject|revert
akm improve

akm workflow ...
akm task ...
akm agent ...
akm env ...
akm secret ...
```

The following concepts should be removed or folded:

- `akm wiki` into bundle/search/lint/import/ingest;
- `manifest` into bundle items or search;
- `curate` into context-shaped search, retaining an alias temporarily;
- asset `clone` into bundle install or explicit cross-bundle copy/export;
- `propose <type>` into adapter-aware creation against a selected component;
- local/registry result mixing in normal search.

Public in-process APIs SHOULD mirror CLI commands and option shapes rather than expose a separate orchestration abstraction.

---

## 30. Implementation and migration strategy

The implementation stays in the current repository. The current asset and improve centers are sacrificial modules; mature infrastructure is retained.

### Phase 0 — Freeze and measure

- Stop adding core asset types and type-specific commands.
- Freeze search, output, workflow, proposal, and migration goldens.
- Add rank-aware search and proposal-evaluation baselines.
- Add a deletion ledger and architecture dependency rules.
- Ablate graph, salience, type boosts, scoped utility, and index-time LLM enrichment.

### Phase 1 — Workspace context and bundle catalog

- Introduce explicit workspace context.
- Add bundle installations and components.
- Add desired configuration and resolved lock state.
- Move new state to XDG locations.

### Phase 2 — First native vertical slice

Implement an OKF component:

```text
install/mount
-> adapter index
-> existing FTS/vector persistence
-> search
-> direct show
-> native lint
```

No improve or mutation support is required in this slice.

### Phase 3 — New index projection

- Introduce `IndexDocument` and new schema fields.
- Dual-emit temporarily for parity comparison.
- Cut search/read consumers to the new projection.
- Remove `StashEntry` and global matchers.

### Phase 4 — Source and website lifecycle

- Refactor source providers into materializers.
- Retain website refresh and cache behavior through website-snapshot components.
- Add website-to-native export.
- Separate registry discovery from local search.

### Phase 5 — Bundle lifecycle and bindings

- ~~Add package manifests and multi-component installation.~~ *(removed v0.4, 2026-07-21 — one bundle = one component = one adapter; no `akm.bundle.yaml`.)*
- Add exports and bindings.
- Move LLM Wiki to an adapter and generic commands.
- Add workflow, task, environment, Claude, OpenCode, and Agent Skills adapters incrementally.

### Phase 6 — Proposal and transaction replacement

- Introduce multi-file `FileChange[]` proposals.
- Reuse/refactor journals, backups, exact Git boundaries, and revert.
- Add before-hash rejection.
- Route lint fixes, create, import, ingest, move, and export through one transaction engine.

### Phase 7 — Memory lifecycle

- Introduce memory adapter facet.
- Add high/low-water policy, pressure reporting, backpressure, retirement, content-addressed archive, restore, and purge.
- Port deterministic cleanup.
- Implement non-destructive semantic consolidation and formalization proposals.

### Phase 8 — Improve replacement

- Implement evidence records and fingerprints.
- Introduce revise, learn, and consolidate recipes.
- Remove confidence publication, same-run cycles, procedural compilation, and improve-owned operational maintenance.
- Add proposal-specific before/after evaluation and field outcomes.

### Phase 9 — Runtime cutovers

- Resolve workflows by installed export and indexed path.
- Merge workflow state into `state.db`.
- Separate task definitions from enabled schedules.
- Split runtime harness, session evidence, and bundle adapter responsibilities.
- Bind environments and secrets explicitly.

### Phase 10 — One-time current-layout migration

Migration MUST:

1. inventory current files and durable state — **the FROM-state is the shipped rc-train layout** (state ledger already at its final pre-cutover migration, `workflow.db` present, vault already removed), not a pristine 0.8 tree; fixtures MUST cover that FROM-state;
2. create checksummed config/state and writable-content backups — the backup set MUST include every durable table's home, including usage/feedback events wherever they physically live pre-cutover;
3. propose destination bundles, components, and adapters;
4. compute and persist the old-ref → new-id map **before any filesystem re-layout** (walk the old layout with the frozen legacy resolver; the cutover consumes only the persisted map);
5. dry-run every file, ref, binding, and state mapping;
6. write new configuration and lock state;
7. move or convert files through adapter transactions;
8. rekey durable refs under the §11.4 orphan taxonomy (expected orphans quarantined, integrity failures fail-closed);
9. validate all destination components;
10. rebuild the index — **outside the fail-closed gate**: the old index file is quarantine-renamed (never early-unlinked), durable feedback tables are migrated out of it first, and a rebuild failure does not roll back a committed state cutover (the indexer self-heals on the next run);
11. run search and runtime smoke tests;
12. produce a migration report;
13. leave the old source recoverable until verification succeeds.

### Phase 11 — Delete compatibility code

Completion requires zero production references, outside migration/archive code, to:

```text
TYPE_DIRS
AkmAssetType
parseAssetRef
wikiName
StashEntry
resolveStashDir
bundle-local .akm state
```

The migration-only old-layout reader is then deleted.

---

## 31. Testing requirements

### 31.1 Adapter conformance

Every adapter MUST have tests for:

- deterministic indexing;
- stable conceptIds;
- `index()`/`recognize()` coherence where `index()` is overridden (index output == fold of recognize over the walk);
- `looksLikeRoot` fires on its own golden root and on no sibling adapter's golden root;
- item-scoped incrementality for multi-file items (sibling edit updates the item; sibling delete does not delete it);
- unknown-field preservation where applicable;
- native validation (through `ValidateContext`, never live filesystem reads);
- authoring rule/validator consistency;
- path traversal and symlink escape;
- round-trip formatting or explicit loss reporting;
- read-only enforcement;
- multi-file fixes;
- unsupported operation behavior.

### 31.2 Search parity

Migration tests MUST compare old and new indexing on a frozen corpus and require approved thresholds for:

- exact fields;
- top-k ordering and overlap;
- MRR and nDCG;
- vector inputs;
- latency;
- index size;
- incremental behavior.

### 31.3 Transaction safety

Test:

- stale before hashes;
- crashes at every journal phase;
- rollback after adapter validation failure;
- cross-root two-phase failure;
- Git commit failure;
- symlink races;
- concurrent proposals;
- multi-file revert;
- read-only component rejection.

### 31.4 Improve and memory

Test:

- evidence fingerprint idempotency;
- no model call when inputs are unchanged;
- one-snapshot semantics;
- no same-run self-feeding;
- candidate-specific retrieval/task evaluation;
- deterministic duplicate retirement;
- semantic coverage failure preserving all sources;
- contradictions not flattened;
- high-water to low-water reduction;
- backpressure when no safe reduction exists;
- archive restore and bounded purge;
- read-only retirement overlay;
- cross-bundle formalization failure recovery.

### 31.5 Architecture contracts

Static or runtime architecture tests SHOULD prove:

- search does not import or call adapters at query time;
- adapters do not import transaction, Git, proposal, or state repositories;
- indexing writes nothing under bundle roots;
- workspace state paths cannot resolve under bundle roots;
- execution cannot be granted by native `type` alone;
- every semantic write originates from a proposal/change transaction;
- every update/delete verifies its before hash;
- unknown native `type`s remain searchable.

---

## 32. Acceptance criteria

**Staging:** these criteria describe the completed **target architecture**, not the 0.9.0 release. Criteria 11 and 13 (binding record/digests) are Tier B (§18 staging note); criteria 21–22 (memory lifecycle) are staged behind the claim extractor (§25 staging note); 0.9.0's own gates are the plan's §12.2 DoD.

The target architecture is complete when:

1. AKM installs bundles containing one or multiple native components.
2. OKF, LLM Wiki, Claude, OpenCode, Agent Skills, website snapshots, workflows, tasks, and environment definitions are supported without core asset types.
3. Search uses one local index and performs no adapter, provider, registry, or network calls.
4. Search quality meets the frozen parity gates, including filter-behavior and whyMatched parity (§14.4).
5. `show` reads the indexed absolute path directly (subject to the §15.3 sensitivity exception).
6. Indexing never mutates bundle content.
7. Conventions and authoring rules are adapter-owned.
8. Hard-rule prompt text and validation derive from one adapter rule source.
9. Installation alone grants no execution, scheduling, tools, environment values, or secrets.
10. Workflows, tasks, environments, agents, commands, skills, and scripts can be distributed as bundle exports.
11. Bindings pin export digest and local runtime policy, and store secret references only (§28.4).
12. In-flight workflows remain stable across bundle updates.
13. Enabled tasks do not silently change when package definitions update.
14. Environment and secret values never enter the index or output.
15. Website bundles refresh safely and can export into writable native bundles.
16. Proposals contain multi-file changes and before hashes.
17. Transactions are journaled, recoverable, exact-path committed, and reversible.
18. Model confidence cannot authorize semantic publication.
19. Improve implements evidence-driven revise, learn, and consolidate operations.
20. Same-run semantic self-feeding is absent.
21. Memory-capable components enforce high-water, retirement, archive, purge, and backpressure policies.
22. Unattended semantic memory retirement requires claim coverage and retrieval/task non-regression; reviewed retirement requires proposal approval (§25.6). Until the claim extractor passes its benchmark, unattended semantic retirement is off.
23. Workspace state is confined to config/data/cache locations.
24. `state.db`, `index.db`, and `logs.db` are the only databases.
25. Registry discovery is separate from installed-content search.
26. Wiki-specific core commands and `wikiName` are removed; the LLM Wiki adapter is a first-class built-in.
27. `AssetSpec`, `AkmAssetType`, `TYPE_DIRS`, global matchers, type-competition renderer/action registries, and `StashEntry` are removed.
28. The one-time old-layout migration is dry-runnable, checksummed, idempotent, recoverable, and fully tested — including an orphan-bearing fixture that completes with quarantine (§11.4).
29. All temporary compatibility seams have named deletion milestones and are deleted.
30. Production code is materially smaller and the net-complexity reduction is reported, with the restored bindings/memory-lifecycle additions accounted as a signed adds line.
*(A v0.2 criterion 31 on untrusted-content labeling/clamping was withdrawn in v0.3 — deviation §4.3c.)*

---

## 33. Deferred decisions

The following are intentionally deferred until implementation evidence is available:

- the stable public third-party adapter ABI;
- the final package-manifest filename if ecosystem compatibility suggests a better convention;
- whether `curate` remains a permanent alias or becomes `search --shape context` only;
- which current ranking extras survive ablation;
- whether LLM graph extraction survives ablation;
- exact effect-size thresholds for semantic auto-application;
- the default claim-extraction implementation for memory coverage — deferring it does **not** block the lifecycle, because §25.6 scopes the coverage MUST to unattended retirement and ships review-gated semantic retirement in the interim;
- whether portable archives are supported by individual adapters in addition to the workspace archive;
- exact UI and approval flows for one-shot executable exports.

These decisions MUST NOT block the foundational bundle, index, transaction, and memory-lifecycle work.

---

## 34. References

### Formats and progressive disclosure

1. [Open Knowledge Format specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
2. [Open Knowledge Format README and reference implementation](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/README.md)
3. [Agent Skills specification](https://agentskills.io/specification)
4. [OpenViking context layers](https://github.com/volcengine/OpenViking/blob/main/docs/en/concepts/03-context-layers.md)
5. [Model Context Protocol server concepts](https://modelcontextprotocol.io/docs/learn/server-concepts)
6. [Claude Code memory and instruction hierarchy](https://code.claude.com/docs/en/memory)
7. [Claude Code custom subagents](https://code.claude.com/docs/en/sub-agents)
8. [OpenCode rules and precedence](https://opencode.ai/docs/rules/)
9. [OpenCode agents](https://opencode.ai/docs/agents/)

### Agent improvement and evaluation

10. [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
11. [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366)
12. [Voyager: An Open-Ended Embodied Agent with Large Language Models](https://arxiv.org/abs/2305.16291)
13. [Self-Refine: Iterative Refinement with Self-Feedback](https://arxiv.org/abs/2303.17651)
14. [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798)
15. [GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning](https://arxiv.org/abs/2507.19457)
16. [Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents](https://arxiv.org/abs/2505.22954)
17. [AlphaEvolve](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/)
18. [Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685)
19. [Judging the Judges: A Systematic Study of Position Bias in LLM-as-a-Judge](https://arxiv.org/abs/2406.07791)

### Memory systems

20. [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442)
21. [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956)
22. [A-MEM: Agentic Memory for LLM Agents](https://arxiv.org/abs/2502.12110)
23. [All-Mem: Agentic Lifelong Memory via Dynamic Topology Evolution](https://arxiv.org/abs/2603.19595)
24. [E-mem: Multi-agent based Episodic Context Reconstruction for LLM Agent Memory](https://arxiv.org/abs/2601.21714)

### Modernization and delivery

25. [Martin Fowler: Strangler Fig](https://martinfowler.com/bliki/StranglerFigApplication.html)
26. [Martin Fowler: Sacrificial Architecture](https://martinfowler.com/bliki/SacrificialArchitecture.html)
27. [Joel Spolsky: Things You Should Never Do, Part I](https://www.joelonsoftware.com/2000/04/06/things-you-should-never-do-part-i/)
28. [Software Engineering at Google: Large-Scale Changes](https://abseil.io/resources/swe-book/html/ch22.html)

### AKM implementation context

29. [AKM repository](https://github.com/itlackey/akm)
30. [AKM PR #718](https://github.com/itlackey/akm/pull/718)
31. [Current asset specification](https://github.com/itlackey/akm/blob/ddc0a1b417efc820ad73d76bfcbef65c9f87b243/src/core/asset/asset-spec.ts)
32. [Current broad metadata model](https://github.com/itlackey/akm/blob/ddc0a1b417efc820ad73d76bfcbef65c9f87b243/src/indexer/passes/metadata.ts)
33. [Current proposal transaction implementation](https://github.com/itlackey/akm/blob/ddc0a1b417efc820ad73d76bfcbef65c9f87b243/src/commands/proposal/proposal.ts)
34. [Current consolidation implementation](https://github.com/itlackey/akm/blob/ddc0a1b417efc820ad73d76bfcbef65c9f87b243/src/commands/improve/consolidate.ts)
35. [Current source-provider contract](https://github.com/itlackey/akm/blob/ddc0a1b417efc820ad73d76bfcbef65c9f87b243/src/sources/provider.ts)
36. [Current portable task schema](https://github.com/itlackey/akm/blob/ddc0a1b417efc820ad73d76bfcbef65c9f87b243/src/tasks/schema.ts)
37. [Current workflow loader](https://github.com/itlackey/akm/blob/ddc0a1b417efc820ad73d76bfcbef65c9f87b243/src/workflows/runtime/workflow-asset-loader.ts)
