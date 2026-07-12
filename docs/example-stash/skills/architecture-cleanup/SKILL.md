---
description: Use when performing a behavior-preserving architectural cleanup or refactor on a codebase and you need strict guardrails against changing functionality, building a framework, or rewriting tests to fit the new design.
tags:
  - architecture
  - refactor
  - cleanup
  - solid
  - dry
  - yagni
---

# Architecture Cleanup

Use this skill for narrow architectural cleanup where the code structure should
improve but the product behavior must remain exactly the same.

## Core rules

1. No user-visible functionality changes.
2. All existing tests must continue to pass with the same validation
   expectations.
3. The only allowed test edits are import-path or symbol-import updates caused
   by file or module moves.
4. Do not rewrite assertions, fixtures, or expected outputs to make a refactor
   easier.
5. Prefer adapters first, rewrites second.
6. Stop if the work starts to resemble framework-building instead of targeted
   cleanup.

## Non-goals

This work is not for:

- building a generalized plugin framework
- adding complexity for its own sake
- introducing runtime plugin loading or dynamic discovery
- replacing simple direct code with abstract dispatch where no hotspot exists
- changing command behavior, output envelopes, scoring semantics, or feature
  scope under the banner of refactoring

## Repeated patterns

Use these patterns only when they remove a concrete maintenance problem.

### Fixed-stage pipeline

Good for:

- search
- improve
- indexing

Rule:

- keep orchestration centralized
- make stage order explicit
- do not create contributor graphs

### Ordered contributor registry

Good for:

- ranking signals
- proposal validators
- search-hit enrichers

Rule:

- define composition semantics once
- keep registration static and deterministic

### Structural contract

Good for:

- refs
- paths
- canonical naming

Rule:

- keep it small, boring, and stable

### Classification as facts

Rule:

- classification should produce facts
- downstream processes should decide how to use those facts
- avoid coupling classification directly to presentation names

## SOLID / DRY / YAGNI guidance

### SOLID

- Single Responsibility: move one kind of policy behind one seam
- Open/Closed: add behavior by registering a small contributor, not by growing a
  switchboard
- Interface Segregation: prefer several narrow contracts over one large object
- Dependency Inversion: higher-level workflows depend on small seams, not on
  concrete launchers or parsers

### DRY

- centralize repeated heuristics once per process
- do not duplicate path lookup, aggregation, or routing logic across commands

### YAGNI

- do not add a seam until it removes a specific existing maintenance problem
- do not build a generalized framework in anticipation of future use

## Agent and harness integration guidance

### Agent runners

Use one narrow `AgentRunner` seam for harness execution.

Rules:

- new harness onboarding should usually mean adding a new spawned CLI command
  path, similar to Claude Code-style CLI integration
- higher-level command flows should not branch on harness name or transport
- OpenCode SDK is the one documented CLI-free fallback harness when no CLI
  harness is configured or available

### Session-log harnesses

Use one narrow `SessionLogHarness` seam for raw event ingestion.

Rules:

- harness adapters own file discovery and parsing
- shared code owns normalization, fingerprinting, aggregation, and de-duplication
- onboarding a new harness should not require copying shared aggregation logic

## Local reference docs

Read these before or during the cleanup:

1. `docs/technical/functional-contract-patterns.md`
2. `docs/technical/implementation-plan-functional-contract-refactor.md`
3. `docs/technical/architecture.md`
4. `docs/technical/architecture.md`
5. For agent harness work:
   - `src/integrations/agent/config.ts`
   - `src/integrations/agent/spawn.ts`
   - `src/integrations/agent/sdk-runner.ts`
6. For session-log harness work:
   - `src/integrations/session-logs/index.ts`
   - `src/integrations/session-logs/types.ts`

## Suggested workflow

1. Identify the concrete hotspot.
2. Map it to one approved small pattern.
3. Define the smallest seam that removes the hotspot.
4. Establish parity checks before editing code.
5. Adapt current code behind the seam.
6. Re-run parity checks.
7. Document what changed structurally and what did not change functionally.

## Review checklist

Before calling the cleanup done, verify:

1. Did the change remove a real hotspot?
2. Did behavior stay the same?
3. Did all tests keep the same expectations?
4. Were any test edits limited to imports only?
5. Did the cleanup avoid framework-building?
6. Is the resulting code easier to read top-down than before?
