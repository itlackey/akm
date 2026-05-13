# Implementation Plan: Functional Contract Refactor

**Status:** Draft — ready for implementation planning and phased delivery  
**Related:** `docs/technical/architecture.md`, `docs/technical/v1-architecture-spec.md`, `docs/technical/functional-contract-patterns.md`

---

## 1. Goal

Refactor akm away from `asset type` as the primary extension abstraction.

Keep:

- `AssetRef` and `type` as data
- minimal `SourceProvider`
- one search pipeline
- centralized orchestration for core commands

Change:

- move behavior onto small process-local functional contracts
- introduce fixed-stage contributor pipelines
- make low-level structural rules explicit and reusable

The target architecture is:

1. one small structural contract for physical layout and ref/path resolution
2. one small registry per core process
3. fixed pipeline stages with ordered contributors
4. process orchestrators that compose contributors rather than branching on type

---

## 2. Design Direction

### 2.1 What stays centralized

- source loading and sync
- write-target resolution
- search pipeline topology
- score normalization and final clamping
- proposal store and promotion flow
- CLI contracts and output envelopes
- index schema and DB boundaries

### 2.2 What becomes pluggable by function

- file classification contributions
- ref/path resolution
- metadata extraction
- search ranking contributions
- search-hit enrichment
- action text generation
- proposal validation
- lint rules
- improve sub-steps
- indexing side-effects

### 2.3 Guiding rule

Use `type` as input data to contributors, not as the architecture's dispatch object.

### 2.4 Contributor invariants

Every new functional seam in this refactor must declare these rules explicitly:

1. composition model: accumulate, first-match, best-match, or mutate-in-place
2. ordering model: deterministic and explicit
3. execution model: sequential by default unless the seam explicitly proves safe parallelism
4. error model: fail-fast or best-effort must be declared once per seam
5. registration model: static in-process registration only; no runtime plugin loading
6. dispatch model: contributors do not call other registries directly

If a proposed seam cannot state these rules simply, the seam is too abstract.

### 2.5 Refactor safety constraint

This is a focused architectural cleanup refactor.

Constraints:

1. no user-visible functionality is allowed to change
2. all existing tests must continue to pass with the same validation expectations
3. the only allowed test changes are import-path or symbol-import updates required by file/module moves
4. no assertions, fixtures, or expected outputs should change unless a prior bug is separately approved and documented
5. adapters and compatibility shims are preferred over behavior rewrites until parity is proven

### 2.6 Non-goals

This refactor is explicitly **not** for:

1. building a generalized internal plugin framework
2. introducing runtime plugin loading or dynamic extension discovery
3. adding abstraction layers that do not remove a specific existing hotspot
4. increasing architectural surface area without reducing duplication or switchboard logic
5. changing command behavior, output envelopes, scoring semantics, or feature scope
6. rewriting tests, fixtures, or expected results to fit new abstractions
7. replacing simple direct code with registries where a seam has not yet proven necessary

If a proposed change adds complexity without removing a concrete maintenance problem, it is out of scope for this plan.

---

## 3. Pattern-To-Code Map

This section maps each repeated design pattern to the current code that should move toward it.

| Pattern | Current code | Current problem | Target shape |
| --- | --- | --- | --- |
| Structural path contract | `src/core/asset-spec.ts`, `src/sources/resolve.ts`, `src/commands/show.ts`, `src/commands/improve.ts` | path rules duplicated across commands | `PathResolver[]` registry with shared resolution helpers |
| Classification contributors | `src/indexer/matchers.ts`, `src/indexer/file-context.ts` | classification returns `type + renderer` too early | ordered `MatchContributor[]` returning classification facts |
| Metadata contributors | `src/output/renderers.ts`, `src/indexer/metadata.ts` | metadata extraction mixed with presentation | ordered `MetadataContributor[]` run by indexing |
| Search ranking contributors | `src/indexer/ranking.ts` | one large scoring function | ordered `RankingContributor[]` inside one ranking phase |
| Search-hit enrichers | `src/output/renderers.ts`, `src/indexer/db-search.ts` | search enrichment coupled to renderers | ordered `SearchHitEnricher[]` after hit assembly |
| Action contributors | `src/core/asset-registry.ts`, `src/indexer/db-search.ts` | action text tied to type registry | `ActionContributor[]` with first-match or best-match semantics |
| Proposal validators | `src/core/proposals.ts` | validation grows by type branching | ordered `ProposalValidator[]` |
| Lint contributors | `src/commands/lint/registry.ts` | good pattern, but only local to lint | evolve into `LintContributor[]` with `appliesTo` |
| Improve contributors | `src/commands/improve.ts` | one god orchestrator with embedded process policy | fixed improve stages with `ImproveContributor[]` |
| Index post-processors | `src/indexer/indexer.ts`, `src/indexer/graph-extraction.ts` | post-walk side-effects hardcoded in indexer | phase-based `IndexPostProcessor[]` |

---

## 4. Target Contracts

The target contracts are intentionally small and process-specific.

### 4.1 Structural contract

```ts
interface PathResolver {
  name: string;
  supportsRef(ref: AssetRef): boolean;
  resolvePaths(input: { sourceRoot: string; ref: AssetRef }): string[];
  canonicalName(input: { stashRoot: string; filePath: string; type: string }): string | undefined;
}
```

### 4.2 Classification

```ts
interface MatchContributor {
  name: string;
  order?: number;
  match(ctx: FileContext): MatchContribution | null;
}

interface MatchContribution {
  type: string;
  specificity: number;
  annotations?: Record<string, unknown>;
  reasons?: string[];
}
```

### 4.3 Metadata

```ts
interface MetadataContributor {
  name: string;
  appliesTo(ctx: MetadataContext): boolean;
  contribute(entry: StashEntry, ctx: MetadataContext): void | Promise<void>;
}
```

### 4.4 Search

```ts
interface RankingContributor {
  name: string;
  appliesTo(item: RankedEntryInput, ctx: RankingContext): boolean;
  adjust(item: RankedEntryInput, ctx: RankingContext): ScoreAdjustment | null;
}

interface SearchHitEnricher {
  name: string;
  appliesTo(ctx: SearchHitContext): boolean;
  enrich(hit: SourceSearchHit, ctx: SearchHitContext): void | Promise<void>;
}

interface ActionContributor {
  name: string;
  appliesTo(ctx: ActionContext): boolean;
  buildAction(ctx: ActionContext): string | undefined;
}
```

### 4.5 Validation and lint

```ts
interface ProposalValidator {
  name: string;
  appliesTo(proposal: Proposal): boolean;
  validate(proposal: Proposal): ProposalValidationFinding[];
}

interface LintContributor {
  name: string;
  appliesTo(ctx: LintContext): boolean;
  lint(ctx: LintContext): LintIssue[];
}
```

### 4.6 Improve and indexing

```ts
interface ImproveContributor {
  name: string;
  phase: "plan" | "validate" | "execute" | "finalize";
  appliesTo(ctx: ImproveContext): boolean;
  run(ctx: ImproveContext): Promise<ImproveStepResult>;
}

interface IndexPostProcessor {
  name: string;
  phase: "after-walk" | "after-persist" | "finalize";
  run(ctx: IndexProcessContext): Promise<void>;
}
```

### 4.7 Agent harness integration

This refactor also needs one explicit seam for onboarding new agent harnesses.

Rule:

- agent command flows and proposal/improve pipelines must not branch on harness name or `sdkMode`
- harness-specific launch logic must live behind one runner contract
- onboarding a new harness should usually mean adding a new spawned CLI command profile and one runner implementation, similar to existing Claude Code style CLI integration

The only documented special case is OpenCode SDK:

- OpenCode SDK is the CLI-free fallback harness when no other agent CLIs are configured or available
- it remains a special case because it is an embedded SDK path, not a normal spawned CLI harness
- this special case should still sit behind the same runner seam as CLI-backed harnesses

```ts
interface AgentRunner {
  name: string;
  supports(profile: AgentProfile): boolean;
  run(input: AgentRunRequest): Promise<AgentRunResult>;
}
```

Recommended rule for runner selection:

1. prefer configured or detected CLI-backed harness profiles
2. if none are configured or available, allow the OpenCode SDK runner as the fallback harness
3. keep setup-time CLI detection separate from runtime runner dispatch

### 4.8 Session log harness integration

The refactor should also explicitly support onboarding new harness history/session-log sources.

Rule:

- each harness owns raw file discovery and parsing
- AKM owns normalization, fingerprinting, aggregation, and de-duplication once
- onboarding a new harness should not require editing shared unions or duplicating aggregation heuristics

```ts
interface SessionEvent {
  harness: string;
  sessionId?: string;
  ts?: number;
  role?: "user" | "assistant" | "system" | "tool" | "unknown";
  text: string;
  filePath?: string;
}

interface SessionLogHarness {
  name: string;
  isAvailable(): boolean;
  readEvents(input: { sinceMs: number }): Iterable<SessionEvent>;
}
```

---

## 5. Implementation Strategy

Refactor in phases that establish one repeated pattern early, then reuse it.

The repeated pattern is:

1. define one small contract for one process
2. add a registry module with ordered contributors
3. adapt existing logic into contributors without changing behavior
4. keep a central orchestrator that runs them
5. move tests to target the new seam directly

---

## 6. Phases

## Phase 1 — Foundation Through Low-Risk Search/Validation Seams

**Goal:** establish the repeated contributor pattern in places with high test coverage and low domain risk.

**Why first:** this phase proves the architecture without touching provider boundaries, DB schema, or major command flows.

### Scope

1. Extract `ProposalValidator` contributors from `src/core/proposals.ts`
2. Extract `ActionContributor` from `src/core/asset-registry.ts` and `src/indexer/db-search.ts`
3. Extract `SearchHitEnricher` from renderer-owned enrichment calls in `src/output/renderers.ts` and `src/indexer/db-search.ts`
4. Introduce `RankingContributor` registry, but keep the same ranking order and math from `src/indexer/ranking.ts`

### Files to change

- `src/core/proposals.ts`
- `src/core/asset-registry.ts`
- `src/indexer/db-search.ts`
- `src/indexer/ranking.ts`
- `src/output/renderers.ts`
- new registry files under a stable home, for example:
  - `src/core/action-contributors.ts`
  - `src/indexer/search-hit-enrichers.ts`
  - `src/indexer/ranking-contributors.ts`
  - `src/core/proposal-validators.ts`

### Deliverables

1. first ordered contributor registries in production code
2. adapters that preserve current behavior
3. tests that assert contributor ordering and applicability

### Acceptance criteria

- no user-facing behavior change in search, show, or proposal acceptance
- all existing tests in these areas stay green
- at least one process uses contributors without any type switch in its orchestrator

### Risk

Low.

### Constraint reminder

- do not change runtime behavior in this phase
- do not change test expectations in this phase
- only import updates in tests are allowed if modules move

---

## Phase 2 — Split Presentation From Metadata Extraction

**Goal:** stop using one renderer abstraction for three different processes.

### Scope

1. keep `ShowContributor` for show payload generation
2. move metadata extraction from `AssetRenderer.extractMetadata` into `MetadataContributor[]`
3. keep search-hit enrichment on its own contract from Phase 1

### Files to change

- `src/indexer/file-context.ts`
- `src/output/renderers.ts`
- `src/indexer/metadata.ts`
- `src/commands/show.ts`

### Deliverables

1. show rendering stays renderer-like
2. indexing uses metadata contributors directly
3. renderer modules no longer need to own search enrichment and metadata extraction together

### Acceptance criteria

- no search result regressions for workflow, vault, task, lesson, wiki, and script assets
- metadata extraction logic is testable without invoking show rendering

### Risk

Low to medium.

---

## Phase 3 — Introduce A Real Structural Path Contract

**Goal:** centralize ref-to-path and canonical-name logic behind one reusable contract.

### Scope

1. extract `PathResolver[]` from `src/core/asset-spec.ts`
2. replace ad hoc path lookup in `src/commands/improve.ts` and lint helpers
3. make show/write/import/improve call the same resolution layer

### Files to change

- `src/core/asset-spec.ts`
- `src/sources/resolve.ts`
- `src/commands/show.ts`
- `src/commands/improve.ts`
- `src/commands/lint/base-linter.ts`
- `src/core/write-source.ts`

### Deliverables

1. one shared path-resolution API
2. removal of `findAssetFilePath()`-style command-local logic
3. removal of duplicated folder maps in lint

### Acceptance criteria

- vault, skill, wiki, lesson, task, and markdown-backed refs resolve through one shared mechanism
- no path-resolution differences across show, write, and improve

### Risk

Medium.

---

## Phase 4 — Rework Classification Into Fact Contributors

**Goal:** classification should produce facts, not choose presentation too early.

### Scope

1. introduce `MatchContributor[]`
2. stop returning renderer names directly from `MatchResult`
3. resolve presentation later from show/search contributors

### Files to change

- `src/indexer/matchers.ts`
- `src/indexer/file-context.ts`
- `src/commands/show.ts`
- `src/indexer/metadata.ts`

### Deliverables

1. explicit classification pipeline
2. weaker coupling between matcher logic and presentation names
3. more reusable annotations for downstream processes

### Acceptance criteria

- classification precedence remains stable
- wiki override and workflow markdown behavior remain unchanged

### Risk

Medium.

---

## Phase 5 — Refactor `improve` Into Fixed Stages

**Goal:** turn `src/commands/improve.ts` into a stage orchestrator rather than a policy monolith.

### Scope

Break improve into fixed ordered stages:

1. planning
2. candidate prioritization
3. validation/schema repair
4. execute reflect/distill
5. finalize consolidation, dead-link checks, eval cases

Then introduce `ImproveContributor[]` per stage.

### Files to change

- `src/commands/improve.ts`
- `src/commands/reflect.ts`
- `src/commands/distill.ts`
- `src/commands/consolidate.ts`
- `src/commands/schema-repair.ts`
- `src/commands/url-checker.ts`

### Deliverables

1. a readable stage orchestrator
2. dedicated contributors for memory cleanup, cooldown checks, reflect, distill, consolidation, dead-link checks, eval-case capture
3. tests per stage instead of broad end-to-end-only coverage

### Acceptance criteria

- behavior remains identical for memory-heavy improve runs
- each stage can be tested with fake contributors

### Risk

Medium to high.

### Gate

Only start this phase if Phases 1 through 4 show measurable simplification in branching, test setup, and module coupling without behavior changes.

---

## Phase 6 — Formalize Index Side-Effects As Post-Processors

**Goal:** shrink indexer knowledge of feature-specific side-effects.

### Scope

1. extract post-processing hooks for workflow documents, graph extraction, memory inference, and other finalize steps
2. keep one index pipeline with explicit phases

### Files to change

- `src/indexer/indexer.ts`
- `src/indexer/graph-extraction.ts`
- `src/indexer/memory-inference.ts`
- `src/indexer/metadata.ts`

### Deliverables

1. ordered `IndexPostProcessor[]`
2. smaller indexer orchestration
3. clearer ownership of index-time features

### Acceptance criteria

- indexing output parity stays intact
- no DB schema changes are introduced accidentally by the refactor itself

### Risk

Medium.

### Gate

Only start this phase if earlier phases prove that the contributor pattern reduces real duplication instead of creating a registry framework.

---

## Phase 1a — Agent Harness And Session-Log Seams

**Goal:** add the missing integration seams without changing harness behavior.

**Why early:** these integrations already have clear onboarding pressure and are otherwise likely to grow ad hoc while the core refactor progresses.

### Scope

1. introduce `AgentRunner` as the runtime dispatch seam for agent execution
2. keep spawned CLI harnesses as the default onboarding path for new harnesses
3. document OpenCode SDK as the fallback harness when no CLI harness is configured or available
4. introduce `SessionLogHarness` as the raw-history ingestion seam
5. centralize session-event normalization and aggregation logic

### Files to change

- `src/integrations/agent/config.ts`
- `src/integrations/agent/spawn.ts`
- `src/integrations/agent/sdk-runner.ts`
- `src/integrations/agent/index.ts`
- `src/integrations/agent/pipeline.ts`
- `src/commands/agent-dispatch.ts`
- `src/integrations/session-logs/index.ts`
- `src/integrations/session-logs/types.ts`
- `src/integrations/session-logs/providers/opencode.ts`
- `src/integrations/session-logs/providers/claude-code.ts`

### Deliverables

1. one runner dispatch seam for CLI and SDK-backed harnesses
2. one raw event ingestion seam for session logs
3. shared aggregation and de-duplication for session-log signals
4. removal of direct harness-branching from higher-level orchestration

### Acceptance criteria

- adding a new spawned CLI harness requires one profile, one runner or runner registration, and optional setup detection
- OpenCode SDK remains the only documented CLI-free fallback harness
- no changes to existing agent command behavior or improve behavior
- no test expectation changes beyond imports

### Risk

Low to medium.

---

## 7. High-Value First Moves

These changes deliver the most architectural value for the least operational risk.

### 7.1 First move: Proposal validators

Why:

- tiny surface area
- easy to preserve behavior
- establishes contributor registration and ordered execution

Current hotspot:

- `src/core/proposals.ts`

### 7.2 Second move: Ranking contributors

Why:

- central hotspot with strong tests
- natural fit for ordered small functions
- proves the "one pipeline, many contributors" design

Current hotspots:

- `src/indexer/ranking.ts`
- `src/indexer/db-search.ts`

### 7.3 Third move: Search-hit enrichers and action contributors

Why:

- currently coupled to renderers and type registry
- low runtime risk
- reinforces the repeated pattern before larger refactors

Current hotspots:

- `src/output/renderers.ts`
- `src/core/asset-registry.ts`
- `src/indexer/db-search.ts`

### 7.4 Parallel high-value integration move: Agent runners and session-log harnesses

Why:

- clear onboarding pressure already exists
- current abstractions already have real duplication and special-casing
- these seams are narrow and do not require a general plugin framework

Current hotspots:

- `src/integrations/agent/config.ts`
- `src/integrations/agent/spawn.ts`
- `src/integrations/agent/sdk-runner.ts`
- `src/integrations/session-logs/index.ts`
- `src/integrations/session-logs/types.ts`

---

## 8. Suggested Module Layout

One possible end state:

```text
src/
  core/
    path-resolvers.ts
    proposal-validators.ts

  indexer/
    match-contributors.ts
    metadata-contributors.ts
    ranking-contributors.ts
    search-hit-enrichers.ts
    index-post-processors.ts

  output/
    show-contributors/

  commands/
    improve/
      pipeline.ts
      contributors/
```

The exact paths can vary. The important part is one registry per process.

---

## 9. Testing Plan By Phase

### Phase 1

- unit tests for contributor ordering and applicability
- parity tests for search scores and proposal validation output
- no assertion changes; import-only test changes allowed if modules move

### Phase 2

- metadata extraction parity tests
- show response parity tests
- no assertion changes; import-only test changes allowed if modules move

### Phase 3

- path resolution parity tests across show/write/improve/lint
- no assertion changes; import-only test changes allowed if modules move

### Phase 4

- classification precedence tests
- wiki/workflow override regression tests
- no assertion changes; import-only test changes allowed if modules move

### Phase 5

- stage-level improve tests with fake contributors
- targeted end-to-end improve regression tests
- no assertion changes; import-only test changes allowed if modules move

### Phase 6

- indexer parity tests
- workflow document and graph extraction regressions
- no assertion changes; import-only test changes allowed if modules move

### Phase 1a

- contract tests for `AgentRunner` parity
- regression tests proving CLI-backed harnesses still spawn exactly as before
- regression tests proving OpenCode SDK fallback still works as fallback only
- fixture tests for session-log normalization and cross-harness de-duplication
- no assertion changes; import-only test changes allowed if modules move

---

## 10. Rollout Notes

1. prefer adapters first, rewrites second
2. preserve behavior until the contributor seam is proven
3. keep old APIs as temporary shims for one phase when useful
4. do not couple this refactor to major CLI or schema changes
5. update docs as each phase lands so architectural intent stays visible
6. do not change user-facing behavior while establishing new seams
7. do not relax or rewrite test expectations during refactor-only phases
8. stop and simplify if a phase starts to resemble framework-building rather than targeted cleanup

---

## 11. Definition Of Done

This refactor is successful when:

1. core processes are readable as fixed pipelines
2. most process-local behavior is registered, not hardcoded inline
3. `type` is no longer the primary behavior object
4. the same contributor pattern is reused across search, validation, improve, and indexing
5. the repo has a stable quick reference for these patterns
6. agent harness onboarding is explicit and narrow: usually add one spawned CLI harness path, with OpenCode SDK remaining the documented fallback special case
7. session-log harness onboarding is explicit and narrow: add one raw event adapter, not a new aggregation pipeline
