# Functional Contract Patterns

Quick reference for the repeated design patterns used in akm's refactor away
from type-centric behavior.

---

## 1. Core Rule

Model behavior around core processes, not around one large `asset type` object.

Use:

- `type` as data
- small contracts as extension seams
- fixed-stage pipelines as orchestrators

Do not use:

- one mega interface with many optional methods
- open-ended plugin graphs
- process logic hidden behind global type switches

---

## 2. Repeated Pattern

For each process:

1. define a small context object
2. define a narrow contributor interface
3. register ordered contributors
4. let each contributor decide `appliesTo(...)`
5. keep one central orchestrator for stage order

This is the standard pattern to repeat across the codebase.

Contributor invariants:

1. registration is static and in-process only
2. ordering is deterministic
3. composition semantics are declared once per seam
4. execution is sequential by default
5. contributors do not dispatch into other registries directly
6. if a seam needs more machinery than this, it is probably too abstract

---

## 3. Pattern Catalog

## 3.1 Fixed-Stage Pipeline

Use when a process already has a clear top-down flow.

Examples:

- search
- improve
- indexing

Shape:

```ts
for (const stage of stages) {
  for (const contributor of contributorsFor(stage)) {
    if (!contributor.appliesTo(ctx)) continue;
    contributor.run(ctx);
  }
}
```

Why:

- preserves readability
- makes order explicit
- prevents plugin soup

---

## 3.2 Ordered Contributor Registry

Use when one stage needs several isolated policies.

Examples:

- ranking signals
- proposal validators
- search-hit enrichers

Shape:

```ts
interface Contributor<TContext> {
  name: string;
  order?: number;
  appliesTo?(ctx: TContext): boolean;
}
```

Why:

- testable in isolation
- easy to add behavior without editing the orchestrator

---

## 3.3 Structural Contract

Use for stable physical concerns such as refs and paths.

Example:

- `PathResolver`

Why:

- storage layout is real and durable
- should not be mixed with ranking, rendering, or validation

Rule:

- keep structural contracts small and boring

---

## 3.4 Classification As Facts

Classification should produce facts, not choose downstream behavior too early.

Good output:

- `type`
- `specificity`
- annotations or reasons

Avoid:

- coupling classification directly to renderer names or search policy

---

## 3.5 Process-Local Validation

Validation belongs to the process that needs it.

Examples:

- proposal validation
- lint validation
- improve preflight validation

Avoid one shared validator that tries to know every process.

---

## 3.6 One Pipeline, Many Signals

Search must remain one pipeline.

Use contributors for:

- exact-match boosts
- type preference boosts
- belief-state boosts
- graph boosts
- utility boosts

Do not create separate per-type scoring pipelines.

---

## 3.7 Adapters Before Rewrites

First move existing behavior behind the new seam.

Only after parity is proven should behavior be reorganized.

Why:

- lower risk
- easier regression testing
- architectural progress without feature churn

---

## 3.8 Refactor-Only Safety Rule

When the work is explicitly architectural cleanup:

- no functionality changes
- all tests must pass with the same validation expectations
- the only allowed test edits are import-path or symbol-import updates caused by file moves
- do not rewrite assertions, fixtures, or expected outputs to accommodate the refactor

This keeps architectural cleanup separate from feature or bug-fix work.

---

## 3.8a Non-goals

This pattern guide is **not** permission to:

1. build a framework
2. add complexity for its own sake
3. create registries everywhere by default
4. replace simple code with abstract dispatch when no real hotspot exists
5. introduce dynamic plugin systems or runtime discovery
6. change runtime behavior under the banner of refactoring

The purpose of these patterns is to remove concrete duplication and switchboard logic while keeping the system simpler to reason about than it is today.

---

## 3.9 Agent Runner Contract

Use one narrow runner seam for agent harness execution.

Recommended onboarding model:

1. new harnesses should usually be added as spawned CLI commands
2. harness-specific launch logic lives behind one `AgentRunner`
3. higher-level command flows must not branch on harness name
4. OpenCode SDK remains the documented special-case fallback harness when no CLI harness is configured or available

This keeps the common path simple while allowing one CLI-free fallback.

---

## 3.10 Session Log Harness Contract

Use one narrow raw-event ingestion seam for harness logs and session histories.

Rule:

1. harness adapters discover files and parse raw events
2. shared AKM logic performs normalization, fingerprinting, aggregation, and de-duplication
3. new harnesses should not require edits to shared unions or duplicated aggregation logic

---

## 4. Recommended Contracts

## 4.1 `PathResolver`

For ref-to-path and canonical naming.

## 4.2 `MatchContributor`

For file classification.

## 4.3 `MetadataContributor`

For indexed-entry enrichment.

## 4.4 `RankingContributor`

For search score adjustments and explanations.

## 4.5 `SearchHitEnricher`

For post-ranking hit augmentation.

## 4.6 `ActionContributor`

For action text generation.

## 4.7 `ProposalValidator`

For proposal acceptance checks.

## 4.8 `LintContributor`

For lint rules.

## 4.9 `ImproveContributor`

For one stage of the improve pipeline.

## 4.10 `IndexPostProcessor`

For indexing side-effects after walk or persist.

## 4.11 `AgentRunner`

For CLI- and SDK-backed agent harness execution.

## 4.12 `SessionLogHarness`

For raw session-log or history ingestion from external harnesses.

---

## 5. What Stays Centralized

- source/provider model
- CLI command contracts
- DB schema and persistence boundaries
- write-target resolution
- search stage order
- final score normalization and clamping
- proposal storage

If these become pluggable, the system becomes harder to reason about.

---

## 6. What Gets Delegated

- heuristics
- enrichment
- validation rules
- process-specific side-effects
- applicability logic
- search explanations

If these stay centralized, switchboards keep growing.

---

## 7. Smells To Avoid

1. One large interface with many optional methods
2. Registries keyed only by `type`
3. Matching logic that also chooses presentation names
4. Renderers that also own indexing and search policy
5. Ad hoc per-command path lookup logic
6. Open-ended capability graphs with unclear precedence
7. Hidden special cases spread across callers instead of isolated behind one seam
8. Architectural cleanup that changes behavior or rewrites tests to fit the refactor

---

## 8. Review Checklist

When adding a new seam, ask:

1. Is this a stable process boundary?
2. Can the contributor be tested in isolation?
3. Does orchestration remain readable top-down?
4. Is ordering explicit?
5. Is `type` only an input, not the behavior object?
6. Can existing behavior be adapted before rewriting it?
7. Is this a refactor-only change with behavior preserved?
8. Does onboarding a new external harness require only one narrow adapter?

If the answer is no to several of these, the abstraction is probably too large.
