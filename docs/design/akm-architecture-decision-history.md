# AKM Architecture Decision History and Conversation Summary

## From an OKF asset proposal to a format-neutral bundle workspace with verified improvement and bounded memory

**Status:** Non-normative companion to the architecture specification  
**Date:** 2026-07-14 (2026-07-13: §5.4/§5.5 updated to the reconciled DEV-1/DEV-2 grammar; D8 framing corrected; D27–D29 added after the design/plan review pass. 2026-07-14: D30 added — final release-scope decisions)  
**Normative specification:** [AKM Format-Neutral Bundle Workspace Architecture Specification](./akm-format-neutral-bundle-workspace-spec.md) (v0.3, amended in place)  
**Repository reviewed:** [`itlackey/akm`](https://github.com/itlackey/akm)  
**Reference revision:** [`ddc0a1b417efc820ad73d76bfcbef65c9f87b243`](https://github.com/itlackey/akm/commit/ddc0a1b417efc820ad73d76bfcbef65c9f87b243)  
**Original proposal under review:** [AKM PR #718](https://github.com/itlackey/akm/pull/718)

---

## 1. Purpose of this document

This document records the complete architectural reasoning developed through the review of PR #718, the OKF specification, the current AKM implementation, adjacent standards and products, self-improving-agent research, and several rounds of adversarial design review.

It is intentionally different from the normative specification:

- The **specification** states what the target architecture requires.
- This document explains **how the design arrived there**, which alternatives were rejected or superseded, why they were rejected, which current AKM capabilities are retained, and which subtle constraints were learned through prior implementation work.

It also acts as a guard against architectural regression. Several rejected designs were locally reasonable and may be proposed again unless their failure modes are documented.

---

## 2. Executive summary

The final position is:

> **AKM does not define a universal content format or asset taxonomy. AKM is a format-neutral workspace that installs and mounts bundles, indexes native files through adapters, searches them through one local index, binds portable runtime exports under local policy, and improves files through evidence-driven, verified transactions.**

The final high-level model is:

```text
Workspace
├── installed bundles
│   ├── one or more adapter-governed components
│   ├── portable content
│   └── optional runtime exports
├── workspace bindings and enabled schedules
├── one local search index
├── durable operational state
├── execution engines and runtime handlers
├── proposals and verified file changes
└── bounded evidence and memory lifecycle
```

The major decisions are:

1. **OKF is a flagship adapter and preferred interchange format, not AKM's internal schema and not an asset type.**
2. **The closed asset-type system is removed.** Native formats and adapters own file semantics.
3. **A bundle may contain multiple components**, each governed by one adapter.
4. **Conventions and authoring rules move into adapters.** They are not deleted.
5. **Sources materialize bytes; adapters interpret files; runtime handlers execute approved capabilities.** These are separate responsibilities.
6. **Installation is not activation.** Installing and indexing a bundle never grants execution, secret, tool, or scheduling authority.
7. **The normalized core content model stops at a narrow search document.** There is no semantic-view registry.
8. **Search remains one local index.** Search never calls adapters, registries, materializers, or the network at query time.
9. **Ordinary reads use the absolute path already stored in the index.** There is no adapter read facade for deterministic file reads.
10. **Website remains a supported refreshable source**, and website snapshots may also be exported into writable native bundles.
11. **Workflows, tasks, environment definitions, agents, commands, skills, and scripts may be distributed in bundles.** Workspace binding controls local execution and activation.
12. **Proposals contain explicit file changes with before hashes, evidence, evaluation, and reversible transaction state.**
13. **Model confidence does not authorize publication.** Semantic acceptance requires review or meaningful external verification.
14. **Improve is refactored around three semantic operations: revise, learn, and consolidate.**
15. **Memory consolidation remains a first-class responsibility.** It bounds growth through deterministic cleanup, semantic compaction, formalization, reversible retirement, bounded archival, purge, and backpressure.
16. **The existing repository is retained as the host and behavioral oracle.** Incorrect architectural centers are replaced inside the same repository and then deleted; there is no separate full-product rewrite and no permanent legacy adapter.
17. **The final storage model is three databases:** `state.db`, `index.db`, and `logs.db`.

---

## 3. What AKM contributes beyond a file format

The analysis began by separating representation from lifecycle.

OKF provides a minimal interoperable representation for hierarchical Markdown knowledge: concepts, frontmatter, links, optional indexes, and optional logs. It intentionally does not prescribe a complete workspace, search engine, execution runtime, package manager, or improvement process. See the [OKF specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) and [reference README](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/README.md).

AKM's enduring value is the operating layer around native files:

```text
source materialization
+ package and bundle installation
+ unified local search
+ progressive retrieval
+ feedback and usage ranking
+ native validation
+ authoring guidance
+ proposals and review
+ safe transactions and recovery
+ workflow and task execution
+ environment and secret binding
+ scheduling
+ continuous improvement
+ memory lifecycle
+ audit and health
```

The design therefore stopped asking, “How should every AKM asset become OKF?” and started asking:

> “How should AKM safely operate across several native bundle formats while preserving one coherent workspace experience?”

---

## 4. Evolution of the architecture

### 4.1 Starting point: OKF as another asset type

PR #718 proposed adding OKF support alongside the existing `wiki` and other asset types. The first concern was that an `okf` type would create another generic Markdown category while preserving the same overloaded architecture:

```text
asset type
-> storage directory
-> matcher
-> canonical ref
-> renderer
-> validator
-> actions
```

This would make OKF a bolt-on and leave both `wiki` and `okf` as overlapping generic knowledge abstractions.

**First correction:** remove `wiki` as a core asset type and use OKF compatibility as a foundation rather than a sibling type.

### 4.2 OKF-native direction

The next design treated OKF concepts as AKM's canonical knowledge objects and separated:

```text
Workspace
-> Bundle
-> Concept
-> optional native resource
```

This established two useful distinctions:

- A **bundle** is portable content.
- A **workspace** is local state, search, engines, policy, proposals, schedules, credentials, and telemetry.

This was a major improvement over the overloaded `stash` concept.

However, it still made OKF the hidden universal semantic center of AKM.

### 4.3 Frontmatter purity and workspace metadata

The proposed `akm:` frontmatter namespace, UUIDs, and automation settings were challenged.

The important correction was:

```text
file metadata       = portable meaning owned by the native format
workspace metadata  = local behavior, policy, ranking, trust, and automation
```

Decisions from this phase:

- The AKM ref, not a UUID embedded in the file, is the item identity.
- Automation configuration does not belong in document frontmatter.
- Usage, embeddings, utility, schedules, trust, credentials, and improve policy are workspace state.
- AKM should preserve unknown extension fields but should not require an AKM frontmatter extension.

### 4.4 Conceptual simplification of the current AKM model

A deeper review found that `stash`, refs, `StashEntry`, `.meta`, wiki, and the asset registry mixed multiple unrelated responsibilities.

The proposed simplification became:

```text
Workspace
└── Bundle
    └── Concept
```

with refs based on bundle-relative paths rather than type and provider.

This phase correctly identified that:

- provider details should not determine document identity;
- type should not determine identity;
- runtime state must leave portable roots;
- wiki is a bundle-like subsystem inside another bundle-like subsystem;
- knowledge, fact, lesson, and memory are all document-like files with different policies rather than fundamentally different I/O systems.

The remaining problem was that AKM still owned the universal concept model.

### 4.5 Format-neutral bundle adapters

The architecture was then reframed from another direction:

> AKM itself defines no content formats. It knows how to install, search, read, validate, improve, and use bundles through adapters for OKF, LLM Wiki, Claude, OpenCode, Agent Skills, website snapshots, AKM workflow files, and other formats.

This was the decisive conceptual shift.

The initial adapter proposal introduced composable semantic views such as:

```text
akm.document@1
akm.concept@1
akm.skill@1
akm.agent@1
akm.workflow@1
```

The rationale was to avoid a lowest-common-denominator object and support items with several meanings.

### 4.6 Views were superseded as over-engineering

The view registry was later rejected because it risked becoming `AssetSpec 2.0`:

- another global registry;
- another version-negotiation layer;
- another dispatch vocabulary;
- another compatibility burden;
- another semantic model that adapters must map into.

The replacement was a small service-specific contract and one narrow search projection.

The core no longer needs to know whether an item “is” a skill, document, concept, script, or agent in a universal ontology. The adapter may emit an opaque `kind` for filtering and presentation, while dedicated runtime codecs can parse executable formats when invoked.

### 4.7 Search and improve were identified as high-risk seams

Two cautions changed the migration plan:

1. **Search quality must not regress while discovery is replaced.**
2. **Improve must not be generalized merely to make every adapter appear uniform.**

The current index uses intentionally weighted fields and a substantial ranking pipeline. The safe first migration is:

```text
adapter scan
-> equivalent search projection
-> current FTS/vector/ranking implementation
```

Adapters run during indexing, not during search.

Improve was initially preserved behind a narrow compatibility repository, but that was rejected as another way to retain current complexity without addressing its quality limitations.

### 4.8 Improve became verified file evolution

A deep analysis of current improve behavior found the central quality defect:

> AKM could prove that a proposal survived structural gates, but not that the accepted revision was better than the file it replaced.

The current confidence and calibration mechanisms primarily measured whether a self-scored proposal survived validators. Asset outcome tracked the item over time, not the causal outcome of one specific change.

Research on [Reflexion](https://arxiv.org/abs/2303.11366), [Voyager](https://arxiv.org/abs/2305.16291), [Self-Refine](https://arxiv.org/abs/2303.17651), [GEPA](https://arxiv.org/abs/2507.19457), [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954), and [AlphaEvolve](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/) consistently pointed toward candidate generation coupled to external, task-grounded, or environment-grounded evaluation.

The target improve loop became:

```text
corrective evidence
-> candidate file changes
-> native validation
-> baseline/candidate comparison
-> review or verified application
-> observed outcome
```

### 4.9 Three-perspective review

The plan was reviewed through three distinct lenses:

1. **Empirical learning-system reviewer:** Does the change prove real value or optimize proxies?
2. **Minimalist file-and-search reviewer:** Does the architecture remain understandable as paths, searches, hashes, and file changes?
3. **Delivery and migration reviewer:** Can the architecture be implemented without losing mature behavior or creating two products?

No independent external agent instances were available. The “debate” was performed as three explicitly separated adversarial reviews with different assumptions and success criteria.

The reviews converged on:

- a narrow normalized model;
- one local search index;
- direct file reads;
- proposal-first semantic changes;
- measured feature retention;
- modular replacement in the current repository;
- a deletion ledger for temporary seams.

### 4.10 Rewrite versus aggressive replacement

A full greenfield rewrite was considered seriously because the asset model, refs, indexing discovery, wiki, lint, writes, and improve are deeply coupled.

The final decision was not a conventional incremental refactor and not a separate rewrite. It was:

> **Aggressive modular replacement inside the existing repository.**

The current codebase remains:

- the release vehicle;
- the behavioral oracle;
- the source of security and failure-path knowledge;
- the host for new vertical slices.

The asset architecture and current improve orchestrator are sacrificial modules. They are replaced from clean boundaries and then deleted.

This follows the practical lessons in Martin Fowler's [Strangler Fig Application](https://martinfowler.com/bliki/StranglerFigApplication.html) and [Sacrificial Architecture](https://martinfowler.com/bliki/SacrificialArchitecture.html), while avoiding the failure pattern described in Joel Spolsky's [Things You Should Never Do, Part I](https://www.joelonsoftware.com/2000/04/06/things-you-should-never-do-part-i/). Google's guidance on [large-scale changes](https://abseil.io/resources/swe-book/html/ch22.html) also supports independently testable, reversible slices rather than one unmergeable replacement.

### 4.11 Repository-wide audit

The current implementation was reviewed for all areas coupled to the proposed architecture. The audit surfaced required changes beyond asset types and improve:

- source and installed-state configuration;
- registry package metadata;
- website ingestion;
- search/show/curate/manifest;
- refs, moves, feedback, and history;
- proposal transactions;
- workflows and workflow database;
- tasks and scheduler state;
- harness/session/runtime coupling;
- environment and secret handling;
- events, health, migrations, and output shaping;
- bundle-local runtime state leaks.

The repository's own July 2026 review describes a mature codebase with concentrated structural mass rather than generally poor code. See [`docs/reviews/code-quality-review-2026-07.md`](https://github.com/itlackey/akm/blob/ddc0a1b417efc820ad73d76bfcbef65c9f87b243/docs/reviews/code-quality-review-2026-07.md).

### 4.12 Final corrections: adapters, websites, portable runtime exports, and memory

Four concerns corrected the first repository-wide disposition:

1. **Conventions and authoring rules are not removed.** They move to adapters.
2. **Website remains a supported source.** It needs a neutral refreshable snapshot model and a website-to-native export path.
3. **Workflows, tasks, and environment definitions remain portable bundle content.** Workspace binding controls execution and activation.
4. **Memory consolidation cannot be reduced to generic maintenance or removed.** A supported path must prevent unbounded memory growth while preserving information and enabling formalization.

These corrections produced the final architecture in the normative specification.

---

## 5. Current architecture at a glance

### 5.1 Responsibility stack

```text
Materializer
  answers: how do bytes arrive and refresh?

Bundle package
  answers: what portable components are distributed together?

Component adapter
  answers: what do these files mean, how are they indexed,
           what rules apply, and how are native changes rendered?

Workspace index
  answers: what can be found quickly across installed components?

Binding
  answers: which portable exports are approved for local use?

Runtime handler
  answers: how is an approved workflow, task, agent, script,
           skill, command, or environment used safely?

Improve
  answers: what evidence justifies a change, did the candidate
           outperform the baseline, and can it be safely applied?
```

### 5.2 Minimal durable core concepts

The implementation should resist creating a large universal domain model. The smallest useful set is:

```text
BundleInstallation
BundleComponent
IndexDocument
FileChange
Proposal
Diagnostic
Binding
```

A native format may have richer parser types internally. Those types do not become universal kernel objects.

### 5.3 Multi-component bundles

A package may contain multiple native roots:

```yaml
schemaVersion: 1
name: release-automation
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
    adapter: akm-env
    root: env
  skills:
    adapter: agent-skills
    root: skills
```

The package manifest describes composition. It does not create a universal AKM file format.

### 5.4 Identity

*(Amended 2026-07-13 by the maintainer reconciliation, DEV-2: the three-segment form originally recorded here is superseded. Current grammar: normative spec §7.8/§11.)*

The canonical item ref is:

```text
[ <bundle> "//" ] <concept-id> [ "#" <fragment> ]
```

Examples:

```text
personal//engineering/http-caching
release-automation//workflows/release
project-claude//.claude/skills/pdf-processing
```

Component is a derived provenance column (longest-prefix match of the concept-id against configured component roots), not a ref segment. Identity excludes:

- source provider;
- cache path;
- semantic type;
- component id;
- file extension where the adapter does not treat it as meaningful;
- embedded UUIDs.

### 5.5 Search document

*(Amended 2026-07-13: the field is the open `type` (DEV-1), and the query-time ranking/filter signals are first-class fields — see normative §14.1 for the current shape. The sketch below is the historical minimal form.)*

The normalized content projection stops at search needs:

```ts
interface IndexDocument {
  ref: string;
  bundle: string;
  component: string;
  conceptId: string;
  path: string;
  hash: string;
  type?: string;

  name: string;
  description?: string;
  tags?: string[];
  aliases?: string[];
  hints?: string[];
  content?: string;
  // + the pinned query-time signal fields (normative §14.1)
}
```

`type` is an open descriptive label. It MAY drive presentation/ranking/filtering (trust-clamped for untrusted content) and never authorizes execution or selects storage, identity, or the write path.

---

## 6. Decision register

### D1. AKM is format-neutral

**Decision:** AKM does not define the native storage format for every file it manages.

**Why:** The current asset registry causes every new format to become a cross-cutting core change. It also forces unrelated formats into one taxonomy and makes storage, validation, rendering, identity, and execution depend on the same type switch.

**Consequence:** OKF, LLM Wiki, Claude, OpenCode, Agent Skills, website snapshots, workflows, tasks, environments, and future standards are integrated through adapters and runtime codecs.

### D2. OKF is a flagship adapter, not the kernel schema

**Decision:** AKM provides excellent OKF production, consumption, validation, search, conversion, and improvement support without forcing other formats through OKF.

**Why:** OKF deliberately defines a minimal interoperable representation. Treating it as AKM's hidden object model would create translation loss for native skills, agent configuration, workflow programs, tasks, scripts, and product-specific instruction systems.

**Consequence:** Plain OKF bundles remain independently valid and portable. AKM does not inject automation policy or identity UUIDs into them.

### D3. A bundle may contain several components

**Decision:** The adapter boundary is a component root, not necessarily the whole distributed package.

**Why:** Real reusable packages may contain knowledge, workflows, tasks, environment templates, scripts, and Agent Skills together. Requiring one adapter per package would either split coherent releases or force a meta-adapter to understand several unrelated formats.

**Consequence:** The bundle is the distribution/versioning unit; components are the format-governed roots.

### D4. Conventions and authoring rules belong to adapters

**Decision:** Adapters own native hard rules, soft conventions, guidance discovery, precedence, scaffolding, validation, and native serialization.

**Why:** A format cannot be safely edited if the code generating instructions and the code validating output evolve separately. Core-owned per-type convention files would reproduce the closed asset taxonomy.

**Consequence:** The adapter should derive model instructions and validators from one authoritative rule set where practical.

### D5. Workspace policy remains distinct from native rules

**Decision:** Writability, trust, protected paths, engine selection, execution approval, auto-application, quotas, and retention remain workspace concerns.

**Why:** Two workspaces may consume the same bundle under different security and operational policies. Embedding these choices in portable files would reduce interoperability and permit bundles to escalate their own authority.

### D6. Source materialization and content interpretation are separate

**Decision:** Materializers only acquire and refresh bytes. Adapters interpret native files.

**Why:** Combining transport and format creates a combinatorial architecture such as `git-okf`, `npm-claude`, and `filesystem-opencode`.

**Consequence:** Filesystem, Git, npm/archive, and website snapshot materialization can be reused with appropriate adapters.

### D7. Website is a first-class refreshable source

**Decision:** AKM retains a safe website materializer and website snapshot adapter.

**Why:** Current website support is useful and should not be discarded merely because the existing implementation emits an AKM-specific `knowledge/` tree.

**Consequence:** A website may be mounted read-only and refreshed. It may also be exported or ingested into a writable destination bundle under that destination adapter's rules.

### D8. Installation is not activation

**Decision:** Installing and indexing a bundle never activates code, schedules, tools, environment values, or secrets.

**Why:** Portable distribution and local authority are different trust decisions. A registry package must not gain execution rights simply because it is searchable.

**Consequence:** Runtime exports are explicitly bound; task schedules are explicitly enabled; secret and environment values are explicitly mapped.

**Framing correction (2026-07-13 review pass; staging finalized 2026-07-14, D30):** code verification showed the *current* install path already grants nothing (`akm add` only syncs+indexes; task sync scans only the primary writable stash; env injection is explicit and already origin-gated; workflow runs are explicit). D8 stands as design — but bindings are a **portability/correctness** capability (distributable runnable exports, digest-pinned updates, tamper detection), not a fix for a present-day escalation. Accordingly, 0.9.0 ships only the Tier-A consolidation of the existing enforcement; the record/digest machinery is Tier B, and a review-pass proposal to add an untrusted read-path clamp was considered and **rejected** as false-confidence machinery (D30, deviation §4.3c).

### D9. Portable runtime definitions remain in bundles

**Decision:** Workflows, tasks, environment definitions, agents, commands, skills, and scripts may be distributed as native files.

**Why:** Reusability and package distribution are core AKM value. Moving all definitions into private workspace state would make them difficult to version, review, share, and install.

**Consequence:** The file definition is portable; the binding is local. Runs pin a definition digest and resolved policy.

### D10. The core normalized content model stops at search

**Decision:** Core receives a narrow `IndexDocument`; it does not require universal `Concept`, `Skill`, `Agent`, or `Workflow` views.

**Why:** A richer universal semantic registry would become another asset framework and impose version negotiation on every adapter.

**Consequence:** Rich native parser types remain adapter- or runtime-specific.

### D11. Search is local and adapter-free at query time

**Decision:** Adapters and materializers run during installation, refresh, indexing, validation, and mutation—not during ordinary search.

**Why:** Query-time adapters would produce inconsistent latency, partial failures, ranking differences, network dependencies, and difficult failure isolation.

**Consequence:** A failed refresh leaves the last good indexed state available where policy permits.

### D12. Search behavior is preserved before it is simplified

**Decision:** Bundle discovery is replaced without simultaneously changing FTS weights, embedding inputs, ranking boosts, or result ordering.

**Why:** Search quality is sensitive and already has deterministic evaluation infrastructure. Combining discovery and ranking changes would make regressions ambiguous.

**Consequence:** Search simplifications and ranking ablations occur after parity.

### D13. Ordinary reads use indexed paths

**Decision:** Once the index has resolved an item to an absolute local path, `show`, improve, execution loaders, and other services read the filesystem directly.

**Why:** An `adapter.read()` or repository facade adds indirection without adding value for deterministic local files.

**Consequence:** Adapters remain responsible for parsing and native interpretation when needed, not byte retrieval.

### D14. Indexing never mutates bundles

**Decision:** `akm index` writes only derived workspace state.

**Why:** Search maintenance should not create source-control changes or unexpectedly rewrite native indexes and summaries.

**Consequence:** Native generated files such as an LLM Wiki `index.md` are repaired through explicit lint/fix, ingest, or adapter maintenance operations.

### D15. Proposals and change sets are one concept

**Decision:** A proposal directly contains one or more `FileChange` records.

**Why:** Chains such as candidate → proposal → mutation plan → change set → transaction multiply terminology and conversion code.

**Consequence:** The transaction engine applies the same changes that were reviewed and evaluated.

### D16. Every change carries a before hash

**Decision:** Updates and deletions include expected content hashes.

**Why:** Long-running model calls and review queues make stale overwrite a realistic risk.

**Consequence:** Diverged files fail safely and require regeneration or explicit conflict handling.

### D17. Model confidence is diagnostic, not authority

**Decision:** Self-reported confidence cannot auto-accept a semantic proposal.

**Why:** The candidate generator cannot be its own ground truth. Current calibration largely measures validation survival rather than usefulness.

**Consequence:** Mechanical changes may auto-apply after deterministic validation; semantic changes require objective evidence or review.

### D18. Improve is evidence-driven

**Decision:** Unattended semantic generation requires corrective evidence.

**Examples:** explicit negative feedback, failed task/eval, native validation failure, broken link, newly observed contradiction, or recurring independent session evidence.

**Not sufficient alone:** age, high retrieval, file size, salience, or elapsed time.

**Why:** Importance does not prove defect.

### D19. Improve uses one stable snapshot

**Decision:** All semantic proposals in one run read the same file/index snapshot, and accepted output does not feed another semantic cycle in the same run.

**Why:** Same-run reindex and reprocessing create echo loops, order dependence, difficult evaluation, and extra locking.

**Consequence:** Subsequent scheduled runs provide later cycles only when new evidence or changed inputs exist.

### D20. Improve has revise, learn, and consolidate

**Decision:** The durable semantic vocabulary is intentionally small:

```text
revise      improve an existing file
learn       create a new durable item from evidence
consolidate bound a memory tier while preserving knowledge
```

**Why:** Reflect, distill, recombine, inference, procedural compilation, and similar names had grown into separate orchestration paths despite sharing common mechanics.

### D21. Memory lifecycle remains a core semantic capability

**Decision:** Memory maintenance stays within improve rather than being reduced to generic workspace housekeeping.

**Why:** Without consolidation and retirement, memory files grow without bound. Operational TTL cleanup alone cannot determine whether information is duplicated, superseded, contradictory, or ready for formalization.

**Consequence:** Memory-capable adapters expose native memory records and render lifecycle changes; core owns pressure, evidence, evaluation, transactions, and archive policy.

### D22. Retirement is distinct from semantic status and purge

**Decision:** Operational lifecycle is:

```text
active -> retired -> purged
active -> quarantined -> restored | purged
```

**Why:** Native statuses such as superseded, contradicted, historical, and deprecated express meaning, while retirement expresses retrieval/storage policy. Purge is irreversible byte removal after a grace period.

### D23. Memory pressure creates backpressure, not deletion proof

**Decision:** High-water thresholds trigger required maintenance, but storage pressure alone cannot authorize unsafe semantic deletion.

**Why:** A quota cannot prove that a unique claim is expendable.

**Consequence:** If safe reduction cannot reach the low-water mark, background intake queues evidence instead of continuing to publish memory files indefinitely.

### D24. Semantic consolidation is non-destructive until verified

**Decision:** The system first creates and validates a successor, proves claim coverage and retrieval continuity, and only then retires source memories.

**Why:** LLM merge/delete decisions are vulnerable to omission, temporal flattening, and contradiction loss.

### D25. The current repository is the host, not the permanent architecture

**Decision:** Replace incorrect centers in the existing repository, then delete them.

**Why:** The mature codebase contains security fixes, migration behavior, concurrency handling, exact Git boundaries, and thousands of tests that a clean-room rewrite would have to rediscover.

**Consequence:** Temporary seams have named deletion milestones. There is no permanent `legacy-akm` format.

### D26. Three databases remain

**Decision:** The final storage model is:

```text
state.db  durable workspace truth
index.db  disposable search and derived caches
logs.db   high-volume purgeable logs
```

**Why:** `workflow.db` is durable state with the same migration discipline and should merge into `state.db`; logs remain operationally distinct.

### D27. The retirement archive supersedes the WS-3a git-only recovery decision (added 2026-07-13)

**Decision:** the workspace content-addressed archive (`$DATA/archive/blobs/sha256/<digest>`, owner-only modes, grace + purge + holds; normative §25.8) is the retirement recovery mechanism. This **explicitly supersedes** the 2026-06-15 WS-3a signoff (`consolidate.ts:1921`) that retired the archive-retention machinery in favor of "git history is the recovery path."

**Why WS-3a was right then and wrong now:** with a single git-backed writable stash, git history was a sufficient recovery path and the TTL archive scan was gold-plating. The bundle-workspace model breaks WS-3a's premise three ways: read-only installed components cannot be edited to mark retirement (the overlay needs workspace-side state), non-git-backed bundles (filesystem/npm/website materializations) have no history at all, and format-independent recovery cannot depend on one VCS. Git history remains an *additional* recovery path.

**Consequence:** one retirement encoding at a time — the bundle-local `archiveMemory` move is a bounded stopgap only until the workspace store lands in the same chunk; there are never two coexisting encodings.

### D28. The `type:name` ref contract is broken deliberately, once, with a written migration story (added 2026-07-13)

**Decision:** dropping `[origin//]type:name` breaks the top item in STABILITY.md's Stable tier and the roadmap's planned 1.0 ref-format freeze. This is done deliberately in 0.9.0 (pre-1.0, the last window where it is cheap), with: STABILITY.md/roadmap/AGENTS.md rewritten to the new grammar in the same release; the CHANGELOG carrying the breaking-change migration note per STABILITY's own policy; no read-only compat resolver for old refs post-cutover (a permanent dual-parser is prohibited, normative §11.4); and the one-time migrator handling all durable state under the orphan taxonomy.

**Why:** the ref grammar is the coupling spine the whole refactor exists to remove; carrying a compat parser would preserve the architecture the release deletes.

### D29. Canonical ref spelling, short-ref resolution, and bundle rename (added 2026-07-13)

**Decision:** durable state always stores the fully-qualified `bundle//conceptId`; the short form is CLI input sugar only; short refs inside bundle content resolve to the containing bundle (portable by construction); prose body refs use only the anchored fully-qualified form; `akm bundle rename` is a first-class rekey transaction; conceptIds are NFC-normalized, `/`-separated, byte-wise case-sensitive with case-collision diagnostics. (Normative §11.1/§11.5.)

**Why:** today's `rekeyStateDbForMove` probing three legacy spellings per ref is the measured cost of leaving canonical spelling open; installer-default resolution of in-content short refs would silently retarget shared bundles per consumer; a bundle rename without rekey orphans all ref-keyed durable state.

### D30. Release staging: demand-driven machinery only (added 2026-07-14)

**Decision:** 0.9.0 ships no machinery built ahead of demand. Concretely: **bindings at Tier A only** — the existing install≠activation enforcement consolidates into one workspace activation-policy point as ports with port-preservation tests; the persisted `Binding` record, export digests, rebind-on-update, and the bind CLI are Tier B, deferred indefinitely, revisited only on concrete demand. **The memory-lifecycle state model (§25) is deferred entirely** — 0.9.0 decomposes `consolidate.ts` with behavior preserved exactly; the lifecycle begins only when its load-bearing dependency (the claim extractor + benchmark) exists. **All new trust/approval machinery is dropped** — trusted labeling, action clamping, approval prompts, catch-all sensitive-content refusals: in practice these are not helpful, provide a false sense of security, and force maintenance of brittle code; only protections that exist in code today survive the port. **Net-LOC is a reported ledger, not a DoD gate** — deletion is gated by inventory (zero-count greps, per-chunk ledgers) and behavior tests, so the prove-or-delete tier is never pressured by a vanity number. **Sequencing is hygiene-first**: the code-quality half (decomposition, DI, one transaction, DRY) lands as Wave 1 before the identity-migration half, so its value banks independently.

**Why:** the D8 framing correction showed install already grants nothing; the external code-quality review showed the lifecycle state model was feature work in a refactor's clothing with an unshippable central gate; and the accepted residual (installed-source refs re-read current content per invocation — crontab semantics) is a deliberate operator-responsibility model, not an oversight. Guard against regression: proposals to re-add approval/trust/lifecycle machinery must name the concrete consumer that demands it.

**Consequence:** normative §18/§25 carry release-staging notes; the plan's Chunk 6.5 and §6 encode the Tier-A/deferred scopes; deviation-analysis §4.3a–3c are the decision record.

---

## 7. Choices that were superseded

| Superseded choice | Why it looked reasonable | Why it was rejected | Replacement |
|---|---|---|---|
| Add `okf` as an asset type | Small change to the current registry | Preserves closed type dispatch and duplicates wiki/knowledge semantics | Built-in OKF component adapter |
| Keep wiki and OKF as separate generic types | Preserves current commands and layout | Maintains two competing Markdown knowledge systems | LLM Wiki and OKF adapters plus generic bundle commands |
| Make every AKM-managed file native OKF | Maximizes apparent standardization | Invalidates or distorts native Agent Skills, Claude, OpenCode, YAML workflow, task, and script formats | Native adapters; optional OKF export |
| Use OKF as AKM's hidden universal object model | Gives the core one semantic vocabulary | Creates translation loss and makes the standard carry AKM concerns | Narrow search projection plus native parsers |
| Add an `akm:` frontmatter namespace by default | Portable place for IDs, provenance, and automation | Pollutes otherwise standard files and mixes workspace policy with file meaning | Preserve native fields; store operational state in workspace |
| Add persistent document UUIDs | Stable identity across moves | Duplicates transparent path identity and requires modifying third-party files | Bundle/component/local-ID refs plus explicit move rekey |
| Put automation policy in frontmatter | Keeps behavior near content | Lets a bundle prescribe local authority and makes the same file behave identically in unrelated workspaces | Workspace improve/execution policy |
| Include provider details in refs | Disambiguates multiple sources | Moving from Git cache to local checkout changes durable identity | Bundle installation name plus adapter-local ID |
| One adapter per bundle package | Simple initial model | Cannot naturally package knowledge, workflows, tasks, env, and skills together | Multi-component bundle package |
| Semantic view registry | Supports multiple meanings per item | Introduces another global ontology, dispatch system, and versioning burden | Narrow `IndexDocument`; native/runtime-specific codecs |
| Replaceable primitive base classes | Familiar extensibility pattern | Recreates inheritance and type-registry coupling | Plain adapter methods and opaque native kinds |
| `adapter.read()` for all reads | Encapsulates formats | Abstracts a deterministic `fs.readFile(path)` and obscures the actual source | Direct read by indexed path |
| Adapter-owned improve implementations | Lets each format customize improvement | Fragments quality policy and turns adapters into miniature AKM systems | Core revise/learn/consolidate with adapter guidance/validation/rendering |
| Preserve current improve unchanged behind a compatibility repository | Low migration risk | Retains proxy quality gates and orchestration complexity | Verified file-evolution refactor |
| Permanent `legacy-akm` adapter | Allows indefinite compatibility | Makes the old asset system a permanent supported format and prevents deletion | Migration-only reader, one-time conversion, removal milestone |
| Replace the whole product in a new repository | Clean architectural start | Reimplements mature safety/runtime behavior, creates two products, freezes assumptions too early | Modular replacement in the current repository |
| Website import only | Simplifies source types | Loses refreshable documentation and research use cases | Website snapshot materializer + adapter + native export |
| Put tasks and workflows only in workspace state | Clean portability boundary | Makes reusable automation difficult to distribute and version | Portable definitions plus local binding/activation |
| Forbid environment definitions in bundles | Strong default safety | Removes useful templates, key contracts, and private-bundle configurations | Portable safe definitions; explicit value binding and trust |
| Remove all improve housekeeping | Separates maintenance from semantics | Leaves memory tiers unbounded | Move operational GC out; retain semantic memory lifecycle in improve |
| Never remove semantic memories | Maximum preservation | Produces unbounded active and archived storage, degraded retrieval, and no forgetting path | Verified retirement, bounded archive, purge, and backpressure |
| Let LLM consolidation merge and delete directly | Efficient corpus reduction | Risks omitted claims, flattened contradictions, and irreversible loss | Successor-first, coverage-verified, reversible retirement |
| High retrieval or age triggers rewrite | Targets important or stale files | Importance and age do not demonstrate a defect | Corrective evidence gates; importance orders eligible work |
| Confidence threshold auto-accept | Cheap admission control | Generator self-score is not external evidence | Change-class policy plus objective verification/review |
| Auto-tune confidence thresholds | Appears to learn admission policy | Calibrates against validation survival, not user value | Tune from real outcomes only, if later justified |
| Live exploration promotion | Learns from lower-confidence candidates | Uses production bundles as an experiment | Shadow candidate evaluation |
| Same-run multiple improve cycles | Reaches a fixed point quickly | Creates self-feeding, order dependence, extra reindexing, and churn | One snapshot; future scheduled runs |
| Generic LLM quality judge for every kind | Uniform semantic gate | Rubric mismatch and documented judge biases | Recipe- and format-specific evaluators; judge as supporting signal |
| Universal task, memory, lesson, fact, and session schemas | Gives core consistent handling | Makes AKM itself a format standard and bloats `StashEntry` | Adapter-native schemas and workspace state |
| Remove conventions entirely | Simplifies core | Loses essential native authoring quality and bundle-specific rules | Move them to adapters |
| Index regenerates native `index.md` files | Keeps navigation fresh | Makes a read/cache command mutate source | Explicit adapter fix/maintenance operation |
| Registry results mixed into content search | One discovery command | Combines installed files with remote packages and incomparable ranking | Separate local search and package discovery |
| `manifest` as parallel discovery path | Cheap listing without search | Duplicates DB and filesystem discovery logic | Bundle items/search projection |
| Separate `curate` architecture | Focused context selection | Duplicates search, show, graph, and registry behavior | Search/context result-shaping mode |

---

## 8. Detailed final architecture

### 8.1 Bundle installation and component composition

A bundle installation records:

```text
stable workspace bundle name
materialized root
source revision/integrity
one or more component roots
adapter ID per component
writability and trust state
```

The bundle name is a workspace identity, not necessarily the upstream package name. Two installations of the same package may use different names when intentionally mounted twice.

Components may not overlap unless the specification and implementation explicitly support deterministic ownership. The default must reject overlapping roots because two adapters claiming the same physical file creates ambiguous identity and mutation ownership.

### 8.2 Materializers

Materializers should remain small:

```ts
interface Materializer {
  materialize(request: MaterializeRequest): Promise<MaterializedSource>;
  refresh?(installation: MaterializedSource): Promise<MaterializedSource>;
}
```

They own:

- downloading or cloning;
- cache paths;
- revision and integrity resolution;
- secure archive extraction;
- refresh behavior;
- stale-cache fallback where appropriate.

They do not own:

- indexing fields;
- item refs;
- native validation;
- authoring rules;
- execution;
- search.

### 8.3 Adapter contract

The adapter owns format semantics:

```ts
interface BundleAdapter {
  index(component: InstalledComponent): AsyncIterable<IndexDocument>;

  validate(
    component: InstalledComponent,
    changes: FileChange[],
  ): Promise<Diagnostic[]>;

  getAuthoringContext?(
    component: InstalledComponent,
    target: AuthoringTarget,
    operation: "create" | "update" | "move" | "consolidate",
  ): Promise<AuthoringContext>;

  create?(
    component: InstalledComponent,
    request: CreateRequest,
  ): Promise<FileChange[]>;
}
```

Optional facets expose runtime exports and memory lifecycle behavior. These are targeted ports, not semantic views.

### 8.4 Adapter authoring context

The authoring context should contain:

- a rule-set version;
- native format instructions;
- applicable convention or guidance files;
- path and precedence information;
- examples where useful;
- restrictions on allowed file changes.

The evidence fingerprint for a semantic proposal includes the rule-set version and hashes of the applicable guidance. A change in conventions therefore invalidates an old no-op or rejected fingerprint without relying on arbitrary time cooldowns.

### 8.5 Local search

The query path is:

```text
query
-> local FTS/vector index
-> common ranking
-> bundle/component/kind filters
-> result shaping
```

It does not perform:

- adapter calls;
- materializer refresh;
- filesystem scanning;
- remote registry search;
- website fetches;
- LLM enrichment;
- graph extraction.

The initial migration preserves the current search field composition and ranking behavior. Later ablations may remove complexity such as type boosts, graph boosts, scoped utility, or project-context heuristics only when benchmarks show no loss or a net gain.

### 8.6 Progressive disclosure

The design adopts a retrieval behavior similar to OpenViking's abstract/overview/detail layers and Agent Skills' metadata/instructions/resources structure without requiring sidecar files in every format. See [OpenViking context layers](https://github.com/volcengine/OpenViking/blob/main/docs/en/concepts/03-context-layers.md) and the [Agent Skills specification](https://agentskills.io/specification).

```text
L0 card      indexed title, summary, kind, hints
L1 overview  outline, native links, applicability, navigation
L2 detail    full native file
resources    supporting files loaded on demand
```

Derived cards, outlines, chunks, and embeddings live in `index.db` unless the native format itself defines portable equivalents.

### 8.7 Direct read and show

`show` should:

1. resolve the item ref in `index.db`;
2. verify the file remains inside its component root;
3. read the absolute path;
4. return indexed metadata and requested content detail;
5. record usage.

Format-specific parsing is performed only when the requested operation needs it. `show` does not invoke a global renderer registry.

### 8.8 Website snapshot and export

A refreshable website installation preserves page-level provenance:

```text
canonical URL
fetched URL
title
text/Markdown
content hash
outbound links
ETag/Last-Modified when available
fetch timestamp
snapshot revision
```

The current safety behavior remains important:

- private and loopback hosts denied by default;
- redirect targets revalidated;
- response byte caps;
- bounded pages/depth/queue;
- whole-crawl wall-clock cap;
- stale cache fallback;
- explicit refresh.

Export into a writable bundle runs through the destination adapter's authoring and validation rules. The exported copy and the live website snapshot are separate items with explicit provenance; refresh does not silently overwrite the curated destination.

### 8.9 Registry and package discovery

Registry search discovers installable packages and their declared components. It does not participate in local relevance ranking.

A registry entry should expose:

- package identity and description;
- source locator;
- version/revision;
- integrity metadata where available;
- component roots and adapter IDs where declared;
- trust/provenance information;
- install command.

It should not require a full inventory of every contained item.

### 8.10 Runtime exports and bindings

An adapter may expose:

```ts
interface BundleExport {
  id: string;
  kind: "workflow" | "task" | "environment" |
        "agent" | "command" | "skill" | "script";
  itemRef: string;
  digest: string;
  requirements?: BindingRequirement[];
}
```

A binding records local approval and configuration:

```text
export ref and digest
local alias
engine/runtime selection
parameters
workspace environment/secret mappings
tool and filesystem policy
approval state
update policy
enabled scheduler state where applicable
```

Bindings are workspace state and are not written back into portable files.

### 8.11 Workflow behavior

A workflow remains portable and may be run directly by full export ref or through a binding.

A run freezes:

- bundle revision;
- component/adapter version;
- export digest;
- parsed or compiled plan;
- plan hash;
- resolved non-secret parameters and engine settings;
- approved environment binding identities.

An installed update cannot mutate the definition used by an in-flight run.

### 8.12 Task behavior

A portable task describes a schedule template and target. Binding a task:

- pins its digest;
- supplies local parameters and environment bindings;
- validates the target;
- registers a scheduler entry only after explicit enablement.

A bundle update that changes the schedule, target, or requirements does not silently rewrite the active scheduler entry. AKM shows the diff and requires explicit application.

### 8.13 Environment definitions

Portable environment components may contain:

- key names and descriptions;
- required/optional declarations;
- non-secret defaults;
- `.env` templates;
- placeholders for secrets;
- trusted private environment files when intentionally distributed.

Indexing exposes only safe metadata. Values are never indexed or printed. Workspace binding maps keys to local values, files, keychains, secret stores, or approved private-bundle values.

### 8.14 Execution security

The design follows the same fundamental separation emphasized by MCP between passive resources and actionable tools: descriptive content is not execution authority. See [MCP server concepts](https://modelcontextprotocol.io/docs/learn/server-concepts).

An indexed `kind: script` or native file named `task` does not authorize execution. The workspace must have:

- a trusted adapter/runtime codec;
- an explicit binding or direct operator invocation;
- an approved runtime handler;
- applicable environment and tool policy;
- path and process controls.

---

## 9. Improve: from self-scored proposals to verified evolution

### 9.1 What current improve does well

The current implementation contains valuable mechanisms that should inform the replacement:

- candidate selection from usage, feedback, and session evidence;
- proposal queues rather than universal direct writes;
- deterministic validators;
- backups and revert;
- run metrics;
- memory-specific cleanup and contradiction handling;
- model call caching and bounded work;
- replay/evaluation infrastructure;
- collapse and churn monitoring.

The problem is not that current improve has no value. The problem is that orchestration, maintenance, selection policy, file mutation, and quality claims became entangled.

### 9.2 The proxy-quality failure

Several current signals are useful but insufficient:

- A proposal passing syntax and structure checks proves it is valid, not better.
- A model's confidence is correlated with its own generation process, not independent ground truth.
- Auto-accept calibration against validator survival measures gate throughput, not usefulness.
- An asset being retrieved more often does not establish that the most recent rewrite caused the increase.
- A generic novelty/actionability judge cannot verify every skill, workflow, script, factual document, or agent prompt.

This is consistent with research showing that intrinsic self-correction without grounded feedback is unreliable. See [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798). LLM judges are useful but exhibit known biases, including position effects; see [Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685) and [Position Bias in LLM-based Evaluators](https://arxiv.org/abs/2406.07791).

### 9.3 Target improve stages

```text
1. Collect corrective evidence.
2. Select an eligible target or learning destination.
3. Freeze paths, hashes, guidance hashes, and relevant search context.
4. Generate candidate FileChange records.
5. Run deterministic native and security validation.
6. Compare candidate with baseline using a recipe-specific evaluator.
7. Queue for review or apply under explicit policy.
8. Reindex affected paths once.
9. Observe later acceptance, task, retrieval, feedback, and revert outcomes.
```

### 9.4 Corrective evidence

Examples include:

- explicit user correction or negative feedback;
- a failed task or workflow;
- a failed retrieval or quality benchmark;
- a native adapter diagnostic;
- a broken link or unresolved resource;
- a newly detected contradiction;
- a new completed session with extractable evidence;
- recurrence across independent sessions, tasks, projects, or sources.

Importance signals such as usage, salience, and retrieval frequency may prioritize eligible items but do not independently admit semantic rewriting.

### 9.5 Input fingerprints

A stable fingerprint replaces several overlapping cooldown and duplicate mechanisms:

```text
fingerprint = hash(
  recipe version
  + target before hashes
  + evidence IDs and hashes
  + applicable guidance hashes
  + evaluator version
)
```

If the same fingerprint has already produced a no-op, rejected candidate, or completed evaluation, AKM does not spend another model call unless explicitly forced. A changed file, new evidence, changed convention, new recipe version, or new evaluator opens a new attempt naturally.

### 9.6 Verification ladder

#### Level 1: native and security safety

- format parses and validates;
- paths remain inside authorized components;
- protected fields and unknown native fields are preserved;
- links/resources remain valid;
- secrets do not enter output or indexable content;
- before hashes still match.

This proves safety, not improvement.

#### Level 2: behavioral comparison

Depending on the recipe:

- failing tests pass against the candidate;
- workflow dry run or task replay improves;
- trigger and holdout retrieval metrics improve;
- protected search canaries do not regress;
- required claims remain covered;
- native examples or conformance cases pass;
- output-size, latency, or cost improves without quality loss.

#### Level 3: field outcome

- human accepts or prefers the proposal;
- later use earns positive feedback;
- production task success improves;
- the change survives its observation period;
- the proposal is not reverted;
- downstream users select the successor rather than searching around it.

Only Level 2 or explicit review should normally authorize unattended semantic application. Level 3 improves future policy and recipe selection.

### 9.7 Change classes

| Class | Examples | Default treatment |
|---|---|---|
| Mechanical | deterministic formatting, generated index repair, exact link rewrite | Auto-apply after validation |
| Objectively verified semantic | task replay improvement, retrieval improvement with protected non-regression | Auto-apply only when workspace policy permits |
| Subjective semantic | prose rewrite, style change, unverified synthesis | Review |
| Destructive | deletion, broad merge, supersession, cross-file rewrite | Review unless deterministic and recoverable |

### 9.8 Process mapping

| Current behavior | Target behavior |
|---|---|
| Reflect | Revise recipe |
| Distill | Learn recipe |
| Extract | Evidence intake that may feed learn |
| Recombine | Multi-source learn recipe, not a separate framework |
| Memory inference | Evidence normalization or learn recipe |
| Consolidate | First-class memory consolidation |
| Procedural compilation | Removed until recurring executable traces and task-level evaluation exist |
| Graph extraction | Optional index processor |
| URL checks | Lint/health |
| Proposal expiry and orphan cleanup | Proposal maintenance |
| DB and log retention | Workspace maintenance |
| Git commit/push | Transaction/materializer boundary |

### 9.9 Features that must earn their way back

The replacement does not automatically carry forward:

- self-consistency sampling selected by text similarity;
- generic self-critique and rewrite loops;
- generic LLM quality judging;
- high-retrieval proactive rewriting;
- multi-cycle same-run execution;
- confidence-threshold auto-tuning;
- live exploration promotion;
- procedural compilation;
- LLM graph boosts;
- complex salience and homeostatic selection.

Each must beat a simpler baseline on verified quality, regressions, runtime, and cost.

Anthropic's [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) reinforces this burden-of-proof approach: use the simplest composable pattern that works, and add evaluator-optimizer loops only when criteria are clear and measurable.

---

## 10. Bounded memory lifecycle

### 10.1 Why memory is the largest unresolved design area

A system that continuously captures sessions, feedback, and observations will grow indefinitely unless it supports:

- deduplication;
- contradiction handling;
- consolidation;
- formalization;
- retirement;
- actual removal.

Removing memory housekeeping would preserve every observation but eventually degrade retrieval, increase model context pressure, increase indexing cost, and make review impossible. Conversely, aggressive automated merging and deletion can destroy unique evidence.

The final design therefore treats memory lifecycle as a required semantic capability with reversible and measurable stages.

### 10.2 Memory is a capability, not a universal AKM schema

A memory-capable adapter exposes its native memory files through a narrow operational record. The adapter owns:

- discovery;
- native metadata;
- provenance representation;
- contradiction/supersession representation;
- serialization;
- applicable conventions;
- native validation.

Core owns:

- pressure calculation;
- evidence and usage signals;
- candidate selection;
- verification;
- proposals and transactions;
- retirement overlays;
- archive and purge policy;
- scheduling and backpressure.

### 10.3 Lifecycle states

```text
active
  -> retired
  -> purged

active
  -> quarantined
  -> restored | purged
```

These operational states are distinct from native semantic states such as:

```text
asserted
active
superseded
contradicted
deprecated
historical
archived
```

A memory may be semantically contradicted yet retained for historical evidence. It may be semantically active but operationally retired because its claims were formalized into a durable successor.

### 10.4 Consolidation outcomes

#### A. Compact within the memory tier

Use when several memories repeat or fragment the same observation.

```text
source memories
-> stronger replacement memory or small coherent set
-> verified claim coverage
-> source retirement
```

#### B. Formalize into durable content

Use when recurring evidence has matured into:

- knowledge;
- a lesson;
- a convention;
- a runbook;
- a workflow;
- a task;
- an agent instruction;
- another native destination supported by an adapter.

```text
memory cluster
-> destination adapter authoring context
-> successor file changes
-> destination validation and evaluation
-> source retirement
```

The destination is workspace-configured and may be in another bundle or repository.

#### C. Retire without formalization

Valid examples:

- exact duplicate;
- explicit supersession;
- TTL-expired ephemeral state;
- obsolete temporary context;
- unsafe or privacy-sensitive capture;
- user-requested forgetting;
- invalid generated derivative.

Not every memory warrants promotion into a formal document.

### 10.5 High-water and low-water marks

A memory policy should support both item and byte pressure:

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

Behavior:

1. High-water crossing makes consolidation required.
2. Deterministic candidates are processed first.
3. Semantic work proceeds until low water is reached or no safe action remains.
4. Pressure does not lower preservation gates.
5. If the tier cannot be safely reduced, new background memory publication pauses.
6. New observations stay in a workspace evidence queue.
7. Explicit user capture may remain available with a clear warning.
8. Health reports active count, retired count, archive size, pending evidence, and unresolved pressure.

This backpressure mechanism is the safe alternative to “delete until under quota.”

### 10.6 Deterministic cleanup first

No model is needed for:

- byte-identical duplicates;
- content-identical files with equivalent provenance;
- expired ephemeral memories under explicit policy;
- derived artifacts whose source and successor are known;
- missing or invalid generated files;
- explicit supersession with a valid successor;
- known unsafe content requiring quarantine.

This is cheaper, more reliable, and reduces the semantic candidate pool.

### 10.7 Source-to-successor coverage map

Before source retirement, every durable claim receives a disposition:

```text
claim
├── preserved in successor
├── preserved in another retained source
├── explicitly superseded
└── intentionally discarded with reason and policy authority
```

An unaccounted durable claim blocks retirement.

Coverage also preserves:

- temporal qualifiers;
- uncertainty;
- attribution;
- contradictory evidence;
- source links;
- scope and applicability.

### 10.8 Retrieval and task non-regression

A consolidation proposal should be compared against the current corpus in a sandboxed index.

Evaluation should include:

- queries that retrieved each source;
- related holdout queries;
- global protected canaries;
- historical queries where the original source remains important;
- negative/banned queries;
- tasks or workflows affected by formalized content;
- destination-format validation.

A successor that simply repeats trigger keywords but loses broader retrieval should fail.

### 10.9 Cross-bundle and cross-repository formalization

True filesystem atomicity is impossible across independent repositories.

Use a recoverable two-phase protocol:

```text
Phase 1
  create, commit, and validate successor in destination

Phase 2
  retire sources in memory component
```

If Phase 2 fails, duplicate knowledge temporarily remains, which is safer than source loss. The operation journal records both phases and can resume.

### 10.10 Retirement archive

Retired bytes move to a bounded workspace content-addressed archive:

```text
$AKM_DATA/archive/blobs/sha256/<digest>
```

`state.db` stores:

- original bundle/component/ref/path;
- source content hash;
- retirement reason;
- successor refs;
- proposal/change ID;
- retired timestamp;
- grace and purge eligibility;
- legal/user hold;
- restore status.

The archive is not inside a bundle and is not normally indexed.

### 10.11 Purge

After the grace period, purge requires:

- no active hold;
- successor still valid when one exists;
- no detected retrieval or task regression;
- retention policy approval;
- archive size or age eligibility.

Git history may provide additional recovery for Git-backed bundles, but the workspace archive is the controlled, format-independent recovery mechanism.

### 10.12 Read-only bundles

A read-only source cannot be edited to mark retirement. The workspace therefore supports a retirement overlay keyed by item ref and source digest.

The overlay:

- suppresses the item from normal retrieval;
- remains workspace-local;
- invalidates automatically when source content changes materially;
- never pretends the upstream file was modified.

### 10.13 Evidence from adjacent memory systems

The design draws useful principles from, without blindly copying:

- [Generative Agents](https://arxiv.org/abs/2304.03442): observation streams plus higher-level reflections;
- [A-MEM](https://arxiv.org/abs/2502.12110): dynamic organization and linking of agent memories;
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956): temporal and historical relationship preservation;
- [All-Mem](https://arxiv.org/abs/2603.19595): explicit memory lifecycle and non-destructive consolidation ideas;
- [E-mem](https://arxiv.org/abs/2601.21714): risks of destructive preprocessing and loss of sequential context.

These systems support separating episodic evidence from consolidated semantic knowledge, but AKM still requires its own claim-coverage, retrieval, task, and recovery gates.

---

## 11. Repository implementation implications

### 11.1 Architectural centers to replace

The following are not merely renamed:

- `AssetSpec` and the asset registry;
- `AkmAssetType` and `TYPE_DIRS`;
- global file matchers and specificity scores;
- renderer and action-builder registries;
- `[origin//]type:name` refs;
- `StashEntry`;
- `.stash.json` overlays;
- `.meta` special files;
- wiki special cases;
- type-derived write paths;
- current one-file proposal payload;
- confidence auto-accept and threshold tuning;
- the current broad improve loop.

### 11.2 Infrastructure to retain

The replacement should reuse or preserve the behavior of:

- atomic file writes with data and directory sync;
- realpath and symlink containment;
- secure archive extraction;
- file locks and stale-lock recovery;
- SQLite WAL and busy-timeout handling;
- migration-ledger verification;
- `BEGIN IMMEDIATE` contention hardening;
- proposal transaction journals and crash recovery;
- exact-path Git commits;
- credential redaction and safe environment injection;
- deterministic search evaluation;
- workflow frozen-plan integrity;
- scheduler backend safety;
- typed errors and output isolation;
- test XDG/data-directory guards.

### 11.3 Source and installed-state configuration

Replace:

```text
stashDir
sources[]
installed[]
primary
defaultWriteTarget
wikiName
```

with:

```text
bundles            desired installations and component declarations
defaultBundle      default creation destination
lock state         resolved revisions, versions, integrity, and cache paths
bindings           local runtime activation
```

### 11.4 Index schema migration

The conceptual row becomes:

```text
item_ref
bundle_id
component_id
adapter_id
local_id
kind
file_path
content_hash
search projection JSON
```

The existing integer row ID can remain for FTS and vector joins. Durable feedback and usage should ultimately key by item ref so deleting/rebuilding the disposable index does not erase learning.

### 11.5 Show, manifest, and curate

- `show` becomes direct index resolution and file read.
- `manifest` becomes `bundle items` or a compact list/search projection.
- `curate` becomes context-oriented search result shaping.
- Registry discovery leaves ordinary content search.
- Lazy graph extraction leaves read paths.

### 11.6 Wiki

Move native wiki behavior into the LLM Wiki adapter and replace the command family with generic bundle/search/lint/import/ingest operations.

### 11.7 Workflows and tasks

- Load portable definitions by indexed path.
- Keep native workflow/task codecs.
- Freeze run definition digests and plans.
- Move scheduler activation into bindings.
- Merge workflow durable state into `state.db`.

### 11.8 Environment and secrets

- Keep the current secure injection and redaction behavior.
- Stop modeling values as general searchable assets.
- Permit portable definitions and private values only under explicit trust and binding policy.

### 11.9 Sessions and capture

- Session logs and summaries are workspace evidence by default.
- They may be indexed without being written into a portable bundle.
- Explicit publish can create a native destination item.
- `remember` should evolve into capture evidence or create a native item in a selected component rather than impose one universal memory schema.

### 11.10 Feedback

Feedback remains durable workspace state. It must not mutate portable files merely to record lesson strength, retrieval count, or utility.

### 11.11 Graph

Index native deterministic links first. Keep LLM graph extraction only if ablation proves meaningful value beyond FTS, embeddings, native links, and usage signals.

### 11.12 Databases

Target:

```text
state.db
  events
  proposals and changes
  bindings
  task schedules and history
  workflow runs/steps/units
  evidence/session cursors
  memory retirement and archive metadata
  change outcomes

index.db
  indexed documents
  FTS
  embeddings
  derived outlines/chunks/links
  optional measured enrichment caches

logs.db
  task/workflow/runtime log lines
```

---

## 12. Delivery strategy

### 12.1 Why not a separate rewrite

A separate rewrite would have to reproduce mature behavior in:

- source synchronization;
- package handling;
- search and ranking;
- SQLite concurrency;
- proposals and rollback;
- engines and harnesses;
- workflows and schedules;
- secret handling;
- migration and recovery;
- platform-specific execution.

Much of that behavior is encoded in tests and incident fixes rather than architecture documents.

### 12.2 Why ordinary incremental refactoring is insufficient

The asset registry, refs, index metadata, wiki, lint, writes, and improve are mutually reinforcing. Slowly renaming them in place would likely preserve the same architecture.

### 12.3 Modular replacement

Use vertical slices:

```text
new clean module
-> parity or quality gate
-> cut consumers over
-> migrate durable state/content
-> delete old implementation
```

No temporary abstraction is complete until it has a deletion milestone.

### 12.4 Recommended implementation sequence

1. Freeze current search and improve evaluation baselines.
2. Introduce workspace context, bundle installations, components, and lock state.
3. Implement the first complete OKF read/search/lint vertical slice.
4. Add the new index document and dual-compare projections.
5. Move LLM Wiki behind an adapter and replace wiki commands.
6. Separate local search from registry discovery.
7. Introduce multi-file proposals and the general transaction engine.
8. Refactor improve into evidence, revise, learn, consolidate, evaluate, and apply.
9. Add portable runtime exports and binding.
10. Cut workflows, tasks, environment, agents, skills, and scripts over.
11. Merge workflow durable state into `state.db`.
12. Implement one-time current-layout and ref migration.
13. Delete the asset architecture, old wiki subsystem, old refs, and temporary compatibility readers.

### 12.5 First vertical slice

The safest first proof is:

```text
mount one OKF component
-> adapter produces the current-equivalent search projection
-> existing index stores it
-> search ranks it
-> show reads its absolute path
-> lint runs native OKF validation
```

This slice excludes improve and runtime activation. It proves the adapter boundary without destabilizing the highest-risk systems.

### 12.6 Deletion ledger

Track explicit zero-count gates:

```text
git grep TYPE_DIRS
git grep AkmAssetType
git grep parseAssetRef
git grep wikiName
git grep StashEntry
git grep resolveStashDir
git grep '/.akm' under bundle-write code
```

Migration or archival code may temporarily retain old terms, but the final release must remove them.

---

## 13. Hard-earned details and subtle constraints

This section records details that were easy to miss and often emerged only after examining current failure paths, prior incidents, test protections, or interactions between subsystems.

### 13.1 Bundle and component are different boundaries

The bundle is the distribution and version boundary. The component is the native-format ownership boundary. Treating them as identical either prevents coherent multi-format packages or creates adapters that understand too much.

### 13.2 Installation, binding, and enabling are three different actions

```text
install  -> files are local and searchable
bind     -> a portable export is approved and locally configured
enable   -> an ongoing side effect such as a scheduler entry becomes active
```

Collapsing these creates supply-chain authority escalation.

### 13.3 Writability is not trust

A writable Git checkout means AKM may edit and push it. It does not mean the bundle may grant itself tools, secrets, or command authority. Current AKM already contains a version of this lesson in tool-policy handling: contribution permission and runtime trust are orthogonal.

### 13.4 Provider identity is not item identity

A GitHub cache, local checkout, npm package, and filesystem directory may contain the same logical bundle. Switching materialization should not rekey every item, usage event, proposal, or binding.

### 13.5 Component-local IDs remain opaque to core

The first path segment must not quietly become a new core type. The adapter may interpret `skills/foo`, `pages/bar`, or `agents/reviewer`; the kernel treats the local ID as one native identifier.

### 13.6 A path move is a real identity migration

Path-based identity is transparent and portable, but moves are not free. A safe move must:

- rewrite native links where supported;
- rekey workspace feedback and history;
- update proposal/binding targets;
- preserve retrieval utility;
- use before hashes;
- produce a migration map and audit event.

This is preferable to embedding UUIDs in every third-party file.

### 13.7 Do not abstract deterministic file reads

When the index has already resolved an absolute local path, the correct operation is usually:

```ts
fs.readFile(path, "utf8")
```

A repository, provider, or adapter read facade hides the source of truth, complicates errors, and can accidentally introduce query-time adapter behavior.

### 13.8 Adapter parsing is still necessary

Direct byte reads do not mean the core parses every format. Workflows, tasks, skills, agents, and native configuration still use their adapter/runtime codecs when structured interpretation is required.

### 13.9 Search must never depend on adapter availability at query time

A newly broken adapter should stop refresh or reindex for its component. It should not make all workspace search fail. The last valid indexed state may remain visible with a stale warning.

### 13.10 Preserve field composition before changing ranking

Current name/description/tags/hints/content weighting and ranking behavior are coupled to existing retrieval and collapse benchmarks. Replacing file discovery and ranking simultaneously destroys the ability to attribute regressions.

### 13.11 Progressive disclosure is a retrieval behavior, not a required file layout

OpenViking's layered context model is valuable, but writing `.abstract.md` and `.overview.md` beside every native file would pollute bundles and conflict with formats. Cards, outlines, chunks, and embeddings should normally remain derived index data.

### 13.12 Indexing must be read-only with respect to bundles

An index command that regenerates `index.md`, enriches frontmatter, or repairs source files makes search infrastructure a hidden author. Native maintenance requires an explicit mutation command and transaction.

### 13.13 Adapter instructions and validation must share authority

If prompt guidance says one thing while the validator enforces another, model retries cannot converge reliably. The adapter's rule-set version must be part of proposal fingerprints and diagnostics.

### 13.14 Preserve unknown native fields and formatting where practical

Adapters must avoid destructive parse-and-reserialize behavior. Native comments, ordering, extension keys, and formatting can be semantically meaningful or important to users. Source-preserving edits and golden round-trip tests are required.

### 13.15 A native kind never grants execution

An item called `Script`, a file under `tasks/`, or an OKF concept describing a workflow remains passive until a workspace runtime handler and policy authorize use.

### 13.16 Installed task updates must not silently reschedule the machine

A package update can change cron frequency, target, arguments, or environment requirements. Active scheduler state remains pinned until the operator reviews and applies the binding update.

### 13.17 Workflow runs freeze definitions

A run must not reread a moving source file after it starts. Freeze the package revision, export digest, compiled plan, and relevant settings. This preserves determinism and safe resume behavior.

### 13.18 Environment contracts are portable; secret authority is local

A bundle can state that `DATABASE_URL` and `TOKEN` are required. It cannot choose the actual local values or automatically gain access to a workspace secret store.

### 13.19 Private bundles may intentionally carry values

The architecture should not prohibit a trusted operator from distributing private environment files. It must make the trust decision explicit and continue to exclude values from search, logs, and ordinary output.

### 13.20 Website snapshot and curated export are separate identities

Refreshing a live documentation snapshot must not overwrite a human- or agent-curated wiki derived from it. The curated destination records provenance and evolves independently.

### 13.21 Redirect security must be rechecked on every hop

A public URL can redirect to loopback, link-local, or private infrastructure. Website materialization must validate every destination, not only the initial URL.

### 13.22 Proposal and file changes must not drift apart

The reviewed object should contain the exact file mutations that the transaction applies. Recomputing paths or content after approval creates a review gap.

### 13.23 Before hashes protect long-running and deferred work

Model generation, human review, and cross-repository operations may take long enough for source files to change. A stale proposal should fail instead of overwriting new work.

### 13.24 One semantic snapshot prevents self-feeding

If an accepted revision is immediately reindexed and becomes input to another process in the same run, process order affects results and the system may amplify its own wording. One snapshot makes runs understandable and comparable.

### 13.25 A model's confidence is not independent evidence

It may help debugging or analysis but cannot establish truth, usefulness, or safety. Confidence-threshold calibration against validator acceptance optimizes the gate, not the product outcome.

### 13.26 Asset outcome and change outcome are different

“Users retrieve this item often” is an item-level signal. “Revision B outperformed revision A” is a change-level causal comparison. Improve needs both, but only the second evaluates a proposal.

### 13.27 Retrieval evaluation needs holdouts and protected canaries

A model can improve the triggering query by copying its words into the file. Evaluation must include related unseen queries, negative cases, global canaries, and task behavior.

### 13.28 No corrective evidence means no unattended rewrite

A frequently used file may be excellent. Age may reflect stability. Storage size may reflect necessary detail. These signals can schedule an audit, not justify semantic mutation.

### 13.29 Independent recurrence matters

Ten observations derived from one session are not ten independent confirmations. Durable learning should distinguish separate sessions, tasks, projects, sources, and explicit human correction.

### 13.30 Retirement is not deletion

Retirement removes an item from normal active retrieval and may remove it from the active component tree. The bytes remain recoverable for a grace period. Purge is the later irreversible step.

### 13.31 Semantic state is not operational state

A contradicted memory may remain valuable evidence. A semantically active memory may be retired after its claims are formalized elsewhere. Native meaning and storage/retrieval policy must not be conflated.

### 13.32 Storage pressure cannot prove expendability

High-water marks establish that action is required, not which unique information may be discarded. When safe reduction fails, queue new background evidence instead of weakening deletion gates.

### 13.33 Archive retention must itself be bounded

Moving every removed memory to an unlimited archive only relocates unbounded growth. Archive age, size, holds, successors, and purge eligibility require explicit policy.

### 13.34 Read-only bundles need workspace retirement overlays

AKM cannot rewrite an installed package merely to hide a superseded memory. A digest-bound local overlay can suppress it without pretending the source changed. The overlay must invalidate when upstream content changes.

### 13.35 Formalization across repositories is two-phase

Publish and validate the successor first. Retire the sources second. Temporary duplication is safer than loss when the second phase fails.

### 13.36 Contradictions should not be averaged away

A consolidation model may be tempted to create a bland compromise. Contradictory claims need preserved evidence, temporal qualification, scope, or an explicit current-belief decision.

### 13.37 Claim coverage is stronger than text similarity

A merged document can look similar to its sources while omitting the most important fact. Retirement evaluation needs claim-level disposition, not only cosine or Jaccard similarity.

### 13.38 Exact duplicates and semantic duplicates need different policies

Byte/content-identical records can often be retired deterministically. Semantic near-duplicates require provenance and claim analysis.

### 13.39 Background capture must have a pressure valve

Session extraction should not continue creating active memory files when the memory component is above its high-water mark and no safe consolidation exists. Evidence can wait in workspace state.

### 13.40 Feedback should not rewrite portable files

Usage counts, lesson credit, utility, and retrieval outcomes are local observations. Writing them into frontmatter creates noisy source-control churn and makes the same bundle vary by consumer.

### 13.41 Registry and search scores are not comparable

Package popularity/relevance and local file retrieval use different corpora and scoring scales. Combining them in one ranked list produces misleading ordering.

### 13.42 Graph extraction is derived, expensive, and optional

It belongs in indexing, not `show`, `curate`, or improve. Native links are deterministic and should be indexed first. LLM graph value must be demonstrated by ablation.

### 13.43 Workspace state must never leak under bundle roots

Locks, journals, proposals, embeddings, evaluation artifacts, rejected drafts, schedules, credentials, and telemetry make a bundle non-portable and may be accidentally committed or published.

### 13.44 Three databases have distinct durability classes

- `state.db`: losing it is data loss.
- `index.db`: it can be rebuilt.
- `logs.db`: it is useful but intentionally purgeable.

This distinction should drive migration, backup, and recovery behavior.

### 13.45 Temporary compatibility is a migration tool, not a product feature

A migration reader may understand the current layout. It must not become a documented permanent adapter, or the old architecture will constrain every future change.

### 13.46 Existing tests are architectural knowledge

Tests covering path traversal, symlinks, Git exact paths, SQLite contention, interrupted transactions, secret redaction, and workflow resume are not merely implementation tests. They encode production knowledge that the new modules must preserve.

### 13.47 Not every current feature deserves migration

A sophisticated mechanism can still have negative net value. Salience, graph boosts, self-consistency voting, proactive rewrites, and process-specific caches must be evaluated against simpler alternatives.

### 13.48 Net deletion is an acceptance criterion

The adapter refactor is unsuccessful if it only adds a new layer while leaving asset specs, matchers, wiki special cases, type refs, and old improve processes intact.

---

## 14. Open and deferred decisions

The final architecture is clear, but several implementation choices should remain evidence-driven.

### 14.1 Exact bundle manifest filename and schema

A multi-component manifest is useful, but AKM should avoid making it mandatory for simple single-component installations. The final filename, discovery rules, and package metadata contract require implementation testing.

### 14.2 Third-party adapter ABI

Built-in adapters should prove the contract first. A stable external plugin API should wait until independently implemented adapters reveal what actually needs stability and isolation.

### 14.3 Adapter isolation

Built-in trusted adapters may run in process. Third-party adapters may eventually need a subprocess or sandbox boundary. The cost and threat model should be evaluated before standardizing the ABI.

### 14.4 Search ranking simplification

The refactor initially preserves current ranking. Later experiments should decide whether to retain:

- type/kind boosts;
- project-context boosts;
- scoped utility;
- graph boosts;
- belief-state boosts;
- recency and salience terms.

### 14.5 LLM index enrichment

Default indexing should be deterministic. An optional processor may return only if measured retrieval benefit exceeds cost, latency, and drift.

### 14.6 Memory claim extraction

Claim coverage is required conceptually, but the implementation may combine deterministic sentence/heading extraction, structured native fields, and an LLM. It needs a benchmark before auto-retirement depends on it.

### 14.7 Memory thresholds and archive defaults

The specification defines behavior, not universal limits. Defaults should be derived from real corpus size, index performance, and user expectations.

### 14.8 Cross-bundle transaction user experience

The two-phase safety model is clear. Resume, review, and rollback commands for partial cross-repository formalization need detailed UX design.

### 14.9 Direct invocation versus binding

Workflows and scripts may support one-shot invocation by full export ref without a persistent binding. The exact policy and prompts should remain strict enough that convenience does not become silent activation.

### 14.10 Naming of `bundle`, `component`, `binding`, and `export`

The current terms are precise and should be used unless implementation proves a simpler public vocabulary. Internal precision may exceed what every CLI command needs to expose.

---

## 15. Annotated references

### 15.1 Knowledge and bundle formats

- [Open Knowledge Format specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) — Established OKF's intentionally minimal concept, link, hierarchy, and conformance model and supported treating it as an interoperable adapter rather than a complete AKM runtime.
- [OKF reference README](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/README.md) — Reinforced the distinction between the format and optional producer/visualizer tooling.
- [Agent Skills specification](https://agentskills.io/specification) — Demonstrated that useful agent capability packages have their own strict native contract and progressive-loading structure; they should not be modified into pseudo-OKF files.
- [OpenViking context layers](https://github.com/volcengine/OpenViking/blob/main/docs/en/concepts/03-context-layers.md) — Informed metadata/overview/detail progressive disclosure while avoiding mandatory sidecar files.

### 15.2 Native agent configuration

- [Claude Code memory and instruction files](https://code.claude.com/docs/en/memory) — Informed adapter-owned scope, hierarchy, imports, and instruction precedence.
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) — Demonstrated native agent definitions with their own metadata, prompts, tool controls, and scope.
- [OpenCode rules](https://opencode.ai/docs/rules/) — Demonstrated a different instruction and fallback model that should remain native rather than normalized away.
- [OpenCode agents](https://opencode.ai/docs/agents/) — Informed native agent parsing and the separation between portable definitions and local runtime authority.
- [Model Context Protocol server concepts](https://modelcontextprotocol.io/docs/learn/server-concepts) — Reinforced the distinction between descriptive resources and actionable tools, a key execution-security boundary.

### 15.3 Effective agent and self-improvement design

- [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) — Supported simple, composable architecture and evaluator-optimizer loops only where evaluation is clear.
- [Reflexion](https://arxiv.org/abs/2303.11366) — Demonstrated improvement grounded in task feedback and stored reflections.
- [Voyager](https://arxiv.org/abs/2305.16291) — Demonstrated environment feedback, execution errors, skill accumulation, and self-verification.
- [Self-Refine](https://arxiv.org/abs/2303.17651) — Provided evidence that iterative refinement can help under appropriate tasks, but not that self-critique is universally reliable.
- [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798) — Supported rejecting ungrounded intrinsic correction as a publication gate.
- [GEPA](https://arxiv.org/abs/2507.19457) — Informed candidate generation, rollout evaluation, and retention of variants that actually perform better.
- [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954) — Reinforced benchmark-evaluated agent modification rather than trusting the modifier's self-assessment.
- [AlphaEvolve](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/) — Reinforced continuous candidate generation with automated evaluators and explicit performance signals.

### 15.4 Evaluation and judge limitations

- [Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685) — Useful background on judge-based evaluation and its role as a proxy.
- [Position Bias in LLM-based Evaluators](https://arxiv.org/abs/2406.07791) — Supported treating LLM judges as supporting evidence rather than ground truth.

### 15.5 Agent memory

- [Generative Agents](https://arxiv.org/abs/2304.03442) — Informed the distinction between an observation stream and higher-level reflection.
- [A-MEM](https://arxiv.org/abs/2502.12110) — Informed dynamic memory organization and link-based evolution.
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956) — Informed preservation of temporal history, contradiction, and relationship semantics.
- [All-Mem](https://arxiv.org/abs/2603.19595) — Informed explicit memory lifecycle and non-destructive consolidation ideas.
- [E-mem](https://arxiv.org/abs/2601.21714) — Informed caution around destructive compression and loss of sequential evidence.

### 15.6 Modernizing the current codebase

- [Martin Fowler: Strangler Fig Application](https://martinfowler.com/bliki/StranglerFigApplication.html) — Supported vertical replacement and cutover rather than a single full rewrite.
- [Martin Fowler: Sacrificial Architecture](https://martinfowler.com/bliki/SacrificialArchitecture.html) — Supported replacing architectural modules after learning while retaining mature infrastructure.
- [Joel Spolsky: Things You Should Never Do, Part I](https://www.joelonsoftware.com/2000/04/06/things-you-should-never-do-part-i/) — Highlighted the hidden operational knowledge and bug fixes lost in broad rewrites.
- [Google Software Engineering: Large-Scale Changes](https://abseil.io/resources/swe-book/html/ch22.html) — Supported independently testable, incremental, tool-assisted changes.

### 15.7 Current AKM implementation and prior analysis

- [AKM PR #718](https://github.com/itlackey/akm/pull/718) — Original OKF integration proposal that initiated the review.
- [AKM repository](https://github.com/itlackey/akm) — Current implementation analyzed for refs, asset types, indexing, improve, proposals, sources, workflows, tasks, security, and storage.
- [Current code-quality review](https://github.com/itlackey/akm/blob/ddc0a1b417efc820ad73d76bfcbef65c9f87b243/docs/reviews/code-quality-review-2026-07.md) — Provided repository scale and concentrated structural-debt context.
- [Current `SourceProvider` contract](https://github.com/itlackey/akm/blob/ddc0a1b417efc820ad73d76bfcbef65c9f87b243/src/sources/provider.ts) — Demonstrated a useful narrow materializer seam.
- [Current consolidation implementation](https://github.com/itlackey/akm/blob/ddc0a1b417efc820ad73d76bfcbef65c9f87b243/src/commands/improve/consolidate.ts) — Provided existing merge/delete/promote/contradict behavior, pressure triggers, journals, and safety mechanisms to preserve or improve.
- [Current task schema](https://github.com/itlackey/akm/blob/ddc0a1b417efc820ad73d76bfcbef65c9f87b243/src/tasks/schema.ts) — Demonstrated that task definitions are already portable and should move behind an adapter rather than disappear.
- [Current proposal substrate](https://github.com/itlackey/akm/blob/ddc0a1b417efc820ad73d76bfcbef65c9f87b243/src/commands/proposal/proposal.ts) — Provided crash-recovery, backup, acceptance, and revert behavior for the new multi-file transaction model.

---

## 16. Working-document lineage

The architecture evolved through the following generated working documents. They are historical context, not competing current specifications:

1. `akm-okf-foundation-proposal.md` — rejected OKF-as-asset direction and proposed OKF projection.
2. `akm-okf-native-architecture-proposal.md` — made OKF concepts canonical and split workspace from bundle.
3. `akm-okf-native-integration-refined.md` — removed required AKM frontmatter extensions and clarified workspace state.
4. `akm-okf-conceptual-simplification.md` — simplified stash, refs, wiki, and `StashEntry` around OKF.
5. `akm-format-neutral-bundle-adapter-architecture.md` — introduced format-neutral adapters but overdesigned semantic views.
6. `akm-bundle-adapter-simplified-safe-revision.md` — removed views and protected search/improve behavior.
7. `akm-improve-verified-evolution-refactor.md` — reframed improve around external verification and measurable change outcome.
8. `akm-three-perspective-review-and-rewrite-decision.md` — reviewed empirical value, minimalism, delivery risk, and rewrite strategy.
9. `akm-repository-wide-refactor-audit.md` — identified repository-wide replacement/removal areas.
10. `akm-repository-wide-refactor-audit-v2.md` — corrected convention ownership, website support, portable runtime definitions, and bounded memory lifecycle.
11. `akm-format-neutral-bundle-workspace-spec.md` — current normative target.

---

## 17. Final position

The architecture can be summarized without introducing another framework:

```text
AKM installs files in bundles.
Adapters explain their native formats.
The index makes them searchable.
The workspace binds approved capabilities.
Runtime handlers execute them safely.
Improve changes files only when evidence justifies it.
Memory consolidation keeps learning bounded without casually losing knowledge.
```

The core test for every future feature is:

> **Does this complexity produce measurable value that cannot be achieved with ordinary file operations, search queries, native adapter rules, explicit bindings, and verified file changes?**

If not, it does not belong in the kernel.
