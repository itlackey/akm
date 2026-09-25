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

## 3.9 Execution Pipeline Contract

Every execution crosses the same plain functions:

1. `resolveExecution()` selects the engine (nearest layer, `defaults.engine`,
   then the `opencode-sdk` fallback), merges the engine's defaults with the
   caller's layers (nearest wins), expands a `models.json` alias once,
   authorizes tools against `execution.allowedTools`, and returns the
   `ResolvedExecutionRequestV1`, the engine's `RunnerSpec` with the request
   applied, and per-field provenance. Credentials stay symbolic.
2. `buildExecution()` hands the request to the harness's own builder (derived
   from `HARNESS_REGISTRY`), or builds chat messages for a direct LLM. A field
   the transport cannot carry becomes a secret-free notice; a tool policy it
   cannot enforce, or a denied tool selection, is a pre-dispatch error.
3. `buildExecutionFromWire()` does the same from a journaled
   `{ request, runner }` without reading config, aliases, environment
   variables, or credentials — workflow resume.
4. `runExecution()` reads credentials for the call, runs the agent CLI, the
   OpenCode SDK, or the chat transport (an exhaustive switch over
   `llm | agent | sdk`), and redacts every secret the child could have seen.

A prompt-free interactive native-agent launch (`akm agent`) resolves its
engine directly; it carries no request to build.

Diagnostic provenance is field metadata (`field`, `layer`, `kind`, `via`), not
resolved values or content. Lowering notices are secret-free records with a
fixed public vocabulary; arbitrary authored inference keys are represented by
wildcard field names rather than copied into diagnostics.

---

## 3.10 Session Log Harness Contract

Use one narrow raw-event ingestion seam for harness logs and session histories.

Rule:

1. harness adapters discover files and parse raw events
2. shared AKM logic performs normalization, fingerprinting, aggregation, and de-duplication
3. new harnesses should not require edits to shared unions or duplicated aggregation logic

---

## 4. Implemented Contracts

**[0.9.0 change, ruled Q-06/Q-16]** This section previously listed twelve
"recommended" contracts; seven had no implementation anywhere in `src/`
(`PathResolver`, `MatchContributor`, `MetadataContributor`,
`LintContributor`, `ImproveContributor`, `IndexPostProcessor`,
`AgentRunner`) and were aspirational, not a contract any code followed.
Trimmed to the five contributor contracts below. The engine-owned
`AgentRequestLowerer` is the separate structural boundary documented in
§3.9, not a revival of the removed generic `AgentRunner`. See the [drift
register](../specs/0.9.0-docs-code-drift-register.md#q-16--functional-contract-patternsmd-4-aspiration-or-contract)
if a removed entry needs reviving; add it back only alongside a real
implementation.

## 4.1 `RankingContributor`

For search score adjustments and explanations.

## 4.2 `SearchHitEnricher`

For post-ranking hit augmentation.

## 4.3 `ActionContributor`

For action text generation.

## 4.4 `ProposalValidator`

For proposal acceptance checks.

## 4.5 `SessionLogHarness`

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
