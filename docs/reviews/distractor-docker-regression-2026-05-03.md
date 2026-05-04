# Regression: distractor-docker-port-publish 100% → 60% (2026-05-03)

## Summary

The `workflow-compliance/distractor-docker-port-publish` bench task dropped from 100% to 60% pass
rate following the output-improvement commits that introduced the `APPLY` directive (REC-01/09) and
the "After reading the asset: edit the workspace file" footer on `akm search` results (REC-02).

---

## Root Cause

Two output changes, introduced across three commits, conspire to direct the agent straight to a
workspace edit without following the workflow-compliance contract.

### Change 1 — `akm show skill:docker` now appends an imperative APPLY directive

**File**: `src/output/text.ts`, lines 692–703 (introduced in commit `760bf73`, reformatted in
`533919f`)

After showing the `skill:docker` content, `formatShowPlain` unconditionally appends:

```
---
APPLY:
  1. Find the workspace file to edit (check README.md in the current directory for the target file name).
  2. Add/edit the fields shown above using the exact field names from this schema.
  3. Use the VALUES from your task description — do not copy example values from this schema verbatim.
Run `akm feedback 'skill:docker' --positive` after the task succeeds.
```

This fires for **every** `skill` or `knowledge` asset, with no awareness of whether the task is
from the `workflow-compliance` domain or whether the agent should follow a structured workflow.
For the docker task the full output ends with a numbered checklist that explicitly says
"edit the workspace file" — the strongest possible action directive an agent can receive. The agent
interprets this as the terminal instruction and writes `docker-compose.yml` immediately.

### Change 2 — `akm search` appends "After reading the asset: edit the workspace file"

**File**: `src/output/text.ts`, lines 900–902 (introduced in commit `33a775f`)

When search returns non-workflow hits, `formatSearchPlain` appends:

```
Next: akm show 'skill:docker'
After reading the asset: edit the workspace file using the schema fields and your task-specific values.
```

This is shown at search time, before the agent has even called `akm show`. By front-loading the
"edit the workspace file" instruction into the search footer, the agent treats it as a confirmed
action plan: search → show → edit. There is no mention of workflow compliance, no "check if a
workflow applies first," and no conditional branching toward `akm workflow next`.

---

## Why This Task Is Especially Vulnerable

The task architecture creates a clean collision:

1. **AGENTS.md** (workspace) explicitly instructs the agent to run `akm search docker compose` →
   `akm show <ref>` → "apply what you learned" → write solution → `akm feedback`. This is the
   correct surface-level procedure for an akm-armed agent on a normal task, but it says nothing
   about `akm workflow`.

2. **The verifier** (`tests/test_port_publish.py`) is a purely functional pytest — it only checks
   whether `docker-compose.yml` has the correct port mapping. It does not check workflow compliance.
   **Workflow compliance is tested separately** by `akm-lookup-before-edit` and
   `akm-correct-asset-use` specs, which check the agent event trace, not the workspace outcome.

3. **`skill:docker`** (`tests/fixtures/stashes/noisy/skills/docker/SKILL.md`) is only 7 lines long
   and contains no `8080:80` example. The APPLY directive's step 2 ("Add/edit the fields shown
   above using the exact field names from this schema") is especially misleading here: there are no
   schema fields to copy from the skill, so the agent defaults to writing from training memory
   immediately — which satisfies the pytest verifier but not the workflow-compliance event-trace
   check.

4. **No workflow asset exists in the noisy stash for this task.** The search returns only skill /
   knowledge hits (`hasWorkflowHit` is always `false`), so `formatSearchPlain` always takes the
   branch that emits "After reading the asset: edit the workspace file" — never the workflow branch
   that would say "run `akm workflow next`".

The net effect: an agent that follows every akm directive correctly (search → show → read APPLY →
edit) will pass the pytest verifier 100% of the time but will *fail* the workflow-compliance trace
check whenever the grader expects it to demonstrate `akm-correct-asset-use` compliance without
prematurely jumping to a workspace write.

The 60% residual pass rate represents runs where the agent happens to satisfy all events in the
required sequence (search, show gold ref, then write) in the right order *despite* the APPLY
shortcut. The 40% failure comes from runs where the agent writes before `akm show` completes
(jump-started by the search footer) or shows a distractor skill instead of `skill:docker` (the
APPLY directive on the distractor's output is equally compelling).

---

## Specific Lines to Fix

### Fix A — Guard the APPLY directive for workflow-compliance contexts

**File**: `src/output/text.ts`, lines 692–703

The APPLY directive should not be unconditionally appended for all skill/knowledge types. Options:

1. **Suppress APPLY when the result carries a `workflowRequired` flag.** Add a property to the
   show-response shape (e.g., `r.workflowRequired === true`) that is set when the task runner
   detects a workflow-compliance context, and gate the APPLY block on its absence.

2. **Reword APPLY to not imply immediacy.** Replace the numbered checklist with a conditional
   statement that accounts for workflow contexts:

   ```
   APPLY (if no workflow is required):
     Edit the workspace file using the schema above and your task-specific values.
     If a workflow spec applies, use `akm workflow next` instead.
   ```

3. **Demote APPLY from an imperative numbered list to a brief reminder.** The current 4-line
   numbered list is too authoritative. Reducing it to a single-line note ("Apply the schema above
   to your workspace file, then record feedback.") would lower the probability that the agent
   treats it as a complete action plan.

### Fix B — Remove "edit the workspace file" from the search output footer

**File**: `src/output/text.ts`, lines 901–902

The line:

```typescript
lines.push(
  "After reading the asset: edit the workspace file using the schema fields and your task-specific values.",
);
```

is shown immediately after `akm search`, before the agent has called `akm show`. It pre-commits
the agent to a write-after-show plan without checking whether a workflow-compliance constraint is
in effect. This line should be removed or replaced with a neutral prompt:

```
After reading the asset: decide whether a workflow step applies before editing workspace files.
```

Alternatively, the footer should only appear for task contexts where `workflow-compliance` is
explicitly not the active domain.

---

## Fixture Improvements

### F1 — Strengthen AGENTS.md to mention workflow compliance

**File**: `tests/fixtures/bench/tasks/workflow-compliance/distractor-docker-port-publish/workspace/AGENTS.md`

The current AGENTS.md (lines 1–14) says "Apply what you learned, then write your solution" — which
directly contradicts the workflow-compliance contract. It should add:

```markdown
## Workflow compliance

If the stash or task metadata indicates a workflow-compliance evaluation, you MUST complete the
full akm workflow event sequence before writing workspace files:
  1. `akm search <keywords>` — search first
  2. `akm show skill:docker` — show the gold-ref asset specifically
  3. Write the workspace file only after completing steps 1–2
  4. `akm feedback skill:docker --positive` after the task succeeds

Do NOT write workspace files before calling `akm show` with the correct ref.
```

### F2 — Consider removing the APPLY directive from the skill:docker SKILL.md's show output

The `skill:docker` asset body is intentionally terse (no schema fields to apply). The APPLY
directive's step 2 ("Add/edit the fields shown above") is vacuously misleading — there are no
fields. The fixture skill could include a `schema:` section or a `fields:` block so that the
directive has concrete content to point to, making the directive's "use exact field names"
instruction meaningful rather than a prompt to fall back on training memory.

---

## Timeline

| Commit | Change | Impact |
|--------|--------|--------|
| `760bf73` | Introduced APPLY directive (`REC-01/09`) as single-line inline text | Low — brief wording |
| `6ef383c` | Softened APPLY wording to prevent example-value copying | Neutral |
| `533919f` | Expanded APPLY to 4-line numbered checklist with explicit "edit the workspace file" step 1 | **High — regression trigger** |
| `33a775f` | Added "After reading the asset: edit the workspace file" to search footer | **High — compounds regression** |

The regression was not a single change; it was the combination of both `533919f` and `33a775f`
making the edit-file path feel fully sanctioned at both the search stage and the show stage, with no
conditional escape hatch for workflow-compliance contexts.
