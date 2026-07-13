# AKM Format-Neutral Bundle Workspace Architecture Specification

**Status:** Draft for implementation review  
**Specification version:** 0.1  
**Date:** 2026-07-13  
**Target:** Next major AKM architecture  
**Reference implementation reviewed:** [`itlackey/akm`](https://github.com/itlackey/akm) at [`ddc0a1b417efc820ad73d76bfcbef65c9f87b243`](https://github.com/itlackey/akm/commit/ddc0a1b417efc820ad73d76bfcbef65c9f87b243)  
**Related proposal:** [AKM PR #718](https://github.com/itlackey/akm/pull/718)

This specification supersedes the prior directions that treated OKF as an AKM asset type, made OKF the hidden universal AKM file schema, introduced a semantic-view registry, or preserved the current asset system behind a permanent legacy adapter.

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

The workspace-unique, path-like identity of an indexed item:

```text
<bundle-id>/<component-id>/<adapter-local-id>
```

Example:

```text
team-catalog/knowledge/tables/orders
release-automation/workflows/release
project-claude/skills/pdf-processing
```

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
- emit stable adapter-local IDs for unchanged native items;
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

A single native root does not require an AKM manifest. Workspace configuration MAY mount it directly:

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

### 9.2 Multi-component packages

A package MAY include an optional `akm.bundle.yaml` outside its native component roots:

```yaml
schemaVersion: 1
name: release-automation
description: Reusable release knowledge, workflows, tasks, and environment contracts.

components:
  knowledge:
    adapter: okf
    root: knowledge

  workflows:
    adapter: akm-workflow
    root: workflows

  tasks:
    adapter: akm-task
    root: tasks

  environment:
    adapter: dotenv
    root: env

  skills:
    adapter: agent-skills
    root: skills

exports:
  release:
    kind: workflow
    component: workflows
    item: release

  nightly-release:
    kind: task
    component: tasks
    item: nightly-release

  release-env:
    kind: environment
    component: environment
    item: release
```

The manifest defines package composition and export declarations only. It MUST NOT redefine the native schemas inside component roots.

### 9.3 Component overlap

Component roots SHOULD NOT overlap. When overlap is required, ownership of each physical file MUST be deterministic and validated. A physical file MUST NOT be indexed as two independent writable items unless the duplication is intentional and explicitly declared.

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
    manifest: akm.bundle.yaml

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
    export: team-catalog/workflows/release
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
- manifest digest;
- component adapter IDs and versions;
- installation timestamp.

Desired configuration MUST NOT duplicate resolved cache paths and revisions that belong exclusively in lock state.

---

## 11. Identity and refs

### 11.1 Canonical ref

The canonical item ref is:

```text
<bundle-id>/<component-id>/<adapter-local-id>
```

The bundle and component IDs MUST NOT contain `/`. The adapter-local ID MAY contain `/` and is otherwise opaque to the core.

### 11.2 Ref invariants

- Provider details MUST NOT appear in refs.
- Native semantic kind MUST NOT appear in refs unless it is naturally part of the adapter-local ID.
- Changing a Git remote, cache path, or materializer MUST NOT change item refs.
- Reclassifying a native item without moving it SHOULD NOT change its ref.
- Moving or renaming a native item changes path-based identity and MUST use an explicit state-rekey transaction.
- The core MUST NOT infer a file path by parsing an adapter-local ID.

### 11.3 Export refs

An export normally uses the item ref that exposes it. If one item exposes multiple exports, the adapter MAY append a stable fragment:

```text
team/tools/toolbox#deploy
```

The fragment is adapter-owned and opaque to the core.

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

---

## 12. Adapter contracts

### 12.1 Base contract

```ts
interface BundleAdapter {
  readonly id: string;
  readonly version: string;

  index(
    installation: BundleInstallation,
    component: BundleComponent,
  ): AsyncIterable<IndexDocument>;

  validate(
    component: BundleComponent,
    changes: readonly FileChange[],
  ): Promise<Diagnostic[]>;
}
```

### 12.2 Authoring facet

```ts
interface AuthoringAdapter extends BundleAdapter {
  getAuthoringContext(
    component: BundleComponent,
    target: { path?: string; localId?: string },
    operation: "create" | "update" | "move" | "consolidate",
  ): Promise<AuthoringContext>;

  create?(
    component: BundleComponent,
    request: CreateRequest,
  ): Promise<FileChange[]>;
}
```

`AuthoringContext` MUST include hashes or versions for the rules and guidance used so proposal fingerprints are reproducible.

### 12.3 Export facet

```ts
interface ExportAdapter extends BundleAdapter {
  listExports(
    installation: BundleInstallation,
    component: BundleComponent,
  ): AsyncIterable<BundleExport>;

  planBinding(
    component: BundleComponent,
    exported: BundleExport,
    request: BindingRequest,
  ): Promise<BindingPlan>;
}
```

### 12.4 Memory facet

```ts
interface MemoryLifecycleAdapter extends BundleAdapter {
  listMemories(
    installation: BundleInstallation,
    component: BundleComponent,
  ): AsyncIterable<MemoryRecord>;

  renderMemoryPlan(
    component: BundleComponent,
    plan: MemorySemanticPlan,
  ): Promise<FileChange[]>;

  validateMemoryPlan?(
    component: BundleComponent,
    plan: MemorySemanticPlan,
    changes: readonly FileChange[],
  ): Promise<Diagnostic[]>;
}
```

### 12.5 Excluded adapter responsibilities

Adapters MUST NOT:

- implement workspace search;
- own proposal or outcome stores;
- apply filesystem changes directly;
- commit or push Git changes;
- authorize execution;
- register arbitrary stages inside every improve run;
- replace core refs, diagnostics, or file-change envelopes;
- require core code to switch on native kinds.

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
  ref: string;
  bundle: string;
  component: string;
  localId: string;
  path: string;
  hash: string;
  kind?: string;

  name: string;
  description?: string;
  tags?: string[];
  aliases?: string[];
  hints?: string[];
  content?: string;
}
```

`kind` is descriptive adapter metadata. It MUST NOT select storage, execution, rendering, or write behavior.

### 14.2 Scan flow

```text
materialize bundle revision
-> select persisted components and adapters
-> adapter.index(component)
-> persist IndexDocument records
-> build FTS/vector/native-link projections
```

### 14.3 Query isolation

Adapters, materializers, registries, and network services MUST NOT execute during a normal search query.

If one adapter scan fails, AKM SHOULD preserve the last-known-good index records for that component and continue serving unaffected bundles with a warning.

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
- index size and build duration;
- query p50/p95 latency;
- incremental add/change/delete behavior.

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
- opaque native kind;
- workspace scope or policy fields that are actually indexed.

Unknown native kinds MUST remain searchable.

### 15.2 Progressive disclosure

AKM SHOULD expose three retrieval levels:

```text
L0 card      name, description, kind, tags, hints
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

### 15.4 `show`

`show` SHOULD:

1. resolve the item ref from the index;
2. read the stored path;
3. return native content plus indexed metadata;
4. record a usage event.

It MUST NOT run global matchers, renderer registries, graph extraction, or wiki/type special cases.

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

---

## 18. Installation, exports, bindings, and activation

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

An adapter exposing `kind: script`, `kind: skill`, or an executable export does not authorize execution. A workspace binding or explicit one-shot approval is required.

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
  backgroundIntakeWhenBlocked: queue
```

When a high-water threshold is exceeded:

1. deterministic cleanup runs first;
2. semantic consolidation attempts to reach the low-water mark;
3. unsafe deletion is prohibited;
4. if safe consolidation cannot reduce pressure, background extraction queues evidence instead of publishing more memory files;
5. explicit user-authored memory remains allowed with a warning;
6. health reports the unresolved pressure and blocked intake.

Backpressure is the required fail-safe when safe deletion cannot be proven.

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

### 25.6 Claim coverage

For semantic consolidation, every durable source claim MUST have one disposition:

```text
preserved in successor
preserved in another active source
explicitly superseded
intentionally discarded with recorded reason
```

A durable claim with no disposition blocks retirement.

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

Cross-bundle or cross-repository formalization MUST use a recoverable two-phase protocol:

1. publish and validate destination;
2. retire sources only after destination success.

### 25.8 Retirement archive

Retired bytes MUST NOT accumulate in an unbounded bundle-local archive.

The default archive is a workspace content-addressed store:

```text
$DATA/archive/blobs/sha256/<digest>
```

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

New adapter kinds receive no ranking boost by default.

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
- generated bundle indexes.

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

akm bind|unbind|bindings

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

- Add package manifests and multi-component installation.
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

1. inventory current files and durable state;
2. create checksummed config/state and writable-content backups;
3. propose destination bundles, components, and adapters;
4. dry-run every file, ref, binding, and state mapping;
5. write new configuration and lock state;
6. move or convert files through adapter transactions;
7. rekey durable refs;
8. validate all destination components;
9. rebuild the index;
10. run search and runtime smoke tests;
11. produce a migration report;
12. leave the old source recoverable until verification succeeds.

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
- stable local IDs;
- unknown-field preservation where applicable;
- native validation;
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
- execution cannot be granted by native kind alone;
- every semantic write originates from a proposal/change transaction;
- every update/delete verifies its before hash;
- unknown native kinds remain searchable.

---

## 32. Acceptance criteria

The target architecture is complete when:

1. AKM installs bundles containing one or multiple native components.
2. OKF, LLM Wiki, Claude, OpenCode, Agent Skills, website snapshots, workflows, tasks, and environment definitions are supported without core asset types.
3. Search uses one local index and performs no adapter, provider, registry, or network calls.
4. Search quality meets the frozen parity gates.
5. `show` reads the indexed absolute path directly.
6. Indexing never mutates bundle content.
7. Conventions and authoring rules are adapter-owned.
8. Hard-rule prompt text and validation derive from one adapter rule source.
9. Installation alone grants no execution, scheduling, tools, environment values, or secrets.
10. Workflows, tasks, environments, agents, commands, skills, and scripts can be distributed as bundle exports.
11. Bindings pin export digest and local runtime policy.
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
22. Semantic memory retirement requires claim coverage and retrieval/task non-regression.
23. Workspace state is confined to config/data/cache locations.
24. `state.db`, `index.db`, and `logs.db` are the only databases.
25. Registry discovery is separate from installed-content search.
26. Wiki-specific core commands and `wikiName` are removed.
27. `AssetSpec`, `AkmAssetType`, `TYPE_DIRS`, global matchers, renderer/action registries, and `StashEntry` are removed.
28. The one-time old-layout migration is dry-runnable, checksummed, idempotent, recoverable, and fully tested.
29. All temporary compatibility seams have named deletion milestones and are deleted.
30. Production code is materially smaller and the net-complexity reduction is reported.

---

## 33. Deferred decisions

The following are intentionally deferred until implementation evidence is available:

- the stable public third-party adapter ABI;
- the final package-manifest filename if ecosystem compatibility suggests a better convention;
- whether `curate` remains a permanent alias or becomes `search --shape context` only;
- which current ranking extras survive ablation;
- whether LLM graph extraction survives ablation;
- exact effect-size thresholds for semantic auto-application;
- the default claim-extraction implementation for memory coverage;
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
