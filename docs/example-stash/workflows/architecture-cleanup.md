---
description: Perform a behavior-preserving architectural cleanup that reduces duplication and switchboard logic without turning the codebase into a framework. Use when the architecture is drifting but product behavior must stay exactly the same.
tags:
  - example
  - architecture
  - refactor
  - cleanup
  - no-behavior-change
params:
  target_path: "Repository root or subdirectory to clean up. Defaults to the current workspace root."
  context_docs: "Optional comma-separated list of docs, ADRs, or specs to anchor the cleanup."
  reference_skill: "Skill to load for cleanup rules and references. Defaults to `skill:architecture-cleanup`."
  base_branch: "Branch to diff against when reviewing behavior parity. Defaults to `main`."
  workspace_dir: "Directory for run artefacts. Defaults to `.akm-run/{{ runId }}`."
  review_scope: "Optional focus area such as `search`, `indexing`, `agent integrations`, or `session logs`."
---

# Workflow: Architecture Cleanup

This workflow is for narrow, behavior-preserving architectural cleanup. The goal
is to make the codebase easier to understand and extend without changing what it
does.

## Step: Load the cleanup rules and architecture context
Step ID: load-rules

### Instructions
Before touching code, anchor the work in the documented rules.

1. Load the cleanup skill:

   ```sh
   akm show {{ reference_skill }}
   ```

2. Read the relevant local reference docs listed by the skill. At minimum,
   inspect:

   - `docs/technical/functional-contract-patterns.md`
   - `docs/technical/implementation-plan-functional-contract-refactor.md`
   - any docs passed in `{{ context_docs }}`

3. Write `{{ workspace_dir }}/rules.md` summarising:
   - what must stay behavior-identical
   - what seams are allowed to change
   - explicit non-goals
   - how tests constrain the work

### Completion Criteria
- The skill and local architecture docs are loaded.
- `rules.md` captures invariants, non-goals, and the no-behavior-change rule.

## Step: Map the current hotspots
Step ID: map-hotspots

### Instructions
The cleanup should be anchored in concrete hotspots, not aesthetics.

1. Review `{{ target_path }}` and list the specific duplication or switchboard
   problems in `{{ workspace_dir }}/hotspots.md`.
2. For each hotspot, record:
   - file path
   - why it is hard to maintain
   - which repeated pattern applies
   - what should remain centralized
   - what is a candidate for extraction
3. If `{{ review_scope }}` is set, prioritize only that slice.

### Completion Criteria
- `hotspots.md` lists concrete targets with file paths.
- Every target is mapped to an approved pattern, not a speculative abstraction.

## Step: Define the smallest safe seam
Step ID: define-seam

### Instructions
Do not jump to a large redesign. Pick the smallest seam that removes a concrete
problem.

1. For the top hotspot, write `{{ workspace_dir }}/seam.md` describing:
   - the smallest new contract or module boundary
   - how existing logic will be adapted behind it
   - why this does not create a framework
   - why this does not change behavior
2. Explicitly state the composition rule for the seam:
   - accumulate
   - first-match
   - best-match
   - mutate-in-place
3. If you cannot explain the seam in a short paragraph, it is too abstract.

### Completion Criteria
- `seam.md` defines one small contract with explicit composition semantics.
- The seam removes a real hotspot and does not broaden scope unnecessarily.

## Step: Establish parity checks before editing
Step ID: establish-parity

### Instructions
Architectural cleanup is constrained by existing behavior.

1. Identify the existing tests that cover the target hotspot.
2. Run the smallest relevant subset and save the results to
   `{{ workspace_dir }}/parity-before.log`.
3. Write `{{ workspace_dir }}/parity-plan.md` documenting:
   - which tests prove behavior parity
   - which commands or manual checks prove runtime parity
   - which tests are not allowed to change except for imports

### Completion Criteria
- A before-state test log exists.
- `parity-plan.md` names the checks that will guard the cleanup.

## Step: Refactor by adaptation, not by rewrite
Step ID: adapt-first

### Instructions
Move code behind the seam before reorganizing behavior.

1. Introduce the new seam with the thinnest possible adapter layer.
2. Keep behavior in place initially; route current code through the seam.
3. Only after parity is preserved should you simplify or delete the old
   switchboard logic.
4. Do not change fixtures, assertions, expected outputs, or product behavior.
   If a test must change for any reason other than imports, stop and treat it as
   a separate bug-fix or feature decision.

### Completion Criteria
- The seam exists and current behavior flows through it.
- Any test edits are import-only.
- No user-visible functionality changes were introduced.

## Step: Verify the cleanup did not change behavior
Step ID: verify-parity

### Instructions
Re-run the parity checks and compare the results.

1. Re-run the test subset from `parity-plan.md` and save the results to
   `{{ workspace_dir }}/parity-after.log`.
2. Run any required command-level or integration-level checks for the affected
   surface.
3. Review the diff against `{{ base_branch }}`:

   ```sh
   git diff {{ base_branch }}...HEAD
   ```

4. Confirm the diff reflects architectural cleanup only, not silent feature
   changes.

### Completion Criteria
- Before/after parity logs exist.
- The guarded tests still pass with the same expectations.
- The diff is architectural cleanup only.

## Step: Capture the architectural decision
Step ID: capture-decision

### Instructions
Leave behind enough context so the next cleanup repeats the same discipline.

1. Write `{{ workspace_dir }}/cleanup-summary.md` covering:
   - hotspot addressed
   - seam introduced
   - what stayed centralized
   - what was extracted
   - proof that behavior did not change
   - explicit non-goals that stayed out of scope
2. If the cleanup surfaced reusable heuristics, record them with:

   ```sh
   akm remember "Architectural cleanup rule: adapt behind a seam first, then simplify. Do not change tests except for imports during refactor-only work."
   ```

3. Re-index if you added or updated stash-backed architectural guidance:

   ```sh
   akm index
   ```

### Completion Criteria
- `cleanup-summary.md` explains the cleanup and the parity evidence.
- Durable heuristics are recorded when useful.
