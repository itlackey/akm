# Workflow Enforcement Design — 2026-05-03

## Problem statement

A class of bench tasks ("workflow-compliance") requires an agent to:

1. Call `akm workflow next '<ref>'` to receive step instructions.
2. Execute the step.
3. Call `akm workflow complete '<runId>' --step '<stepId>'` before moving on.

Tasks **fail** if the agent reads a skill with `akm show` and applies its
content directly instead of going through the workflow gate. Recent output
improvements added a prominent `APPLY:` directive to `formatShowPlain` for
`skill` and `knowledge` assets (lines 688-703 of `src/output/text.ts`). This
directive is so compelling that agents skip the workflow even when one is
active, because the APPLY text appears *after* the skill body and gives a
concrete edit prescription.

---

## Current state (code facts)

### Workflow run state is fully queryable, synchronously, from any process

`workflow.db` is a SQLite file at `getCacheDir()/workflow.db` (see
`src/core/paths.ts:91-93`). The `workflow_runs` table has a `status` column
with a `CHECK` constraint on `('active', 'completed', 'blocked', 'failed')`.
Active runs are queryable with:

```sql
SELECT id, workflow_ref, workflow_title, current_step_id
FROM workflow_runs
WHERE status IN ('active', 'blocked')
ORDER BY updated_at DESC
LIMIT 1;
```

`openWorkflowDatabase()` in `src/workflows/db.ts` is a thin wrapper that
creates the schema on first open and returns a `bun:sqlite` `Database`.
It can be called from any module — there is no singleton or connection pool
to worry about. The read is cheap (indexed on `status`).

**Key conclusion**: Option A and B do not require new infrastructure. The
workflow state is already queryable in O(1) from `show` or `search`.

### Where the APPLY directive lives

`src/output/text.ts` — `formatShowPlain()`, lines 688-726.

- Lines 692-703: the `skill` / `knowledge` APPLY block (the problematic one).
- Lines 704-723: the `workflow` ACTION REQUIRED block (already good — it
  redirects to `akm workflow next`).

The APPLY directive is appended **after** the full skill content. An agent
that reads the output top-to-bottom sees: header → content → APPLY. By the
time it reaches APPLY it has already absorbed the skill schema and is
primed to act on it.

### Where search hints live

`src/output/text.ts` — `formatSearchPlain()`, lines 888-906.

The search footer (lines 888-906) already has a path for workflow hits
(`hasWorkflowHit`). It does not currently check whether an active workflow
exists — it only checks whether the *search results themselves* contain a
workflow asset type.

### What `show` does with workflow assets

`formatShowPlain()` already has a `workflow` branch (lines 704-723) that
inserts an ACTION REQUIRED directive and a NEXT STEP trailer. This works
correctly when the agent calls `akm show workflow:<name>`. The problem is
when the agent calls `akm show skill:<name>` instead of going through the
workflow.

---

## Option evaluation

### Option A — Active workflow detection in show/search (prepend warning)

When `akm show` or `akm search` is called, check for an active workflow run.
If found, prepend:

```
ACTIVE WORKFLOW: Run `akm workflow next '<runId>'` for your current step
before applying any asset directly.
```

**Feasibility**: High. `listWorkflowRuns({ activeOnly: true })` already exists
in `src/workflows/runs.ts:148-174`. A synchronous DB query with no async cost.

**Risk**: Low. The check is read-only (no state mutation). Failure mode is
silent fallback (the query fails → no banner → existing behavior unchanged).

**Weakness**: The banner *precedes* the content, so the agent sees it first —
but a strong APPLY directive at the end may still win if the agent integrates
the full response before deciding. Position matters less than salience and
specificity (see Option B).

---

### Option B — Workflow-gated APPLY directive (replace APPLY when active run exists)

When `akm show skill:<name>` is called and an active workflow run exists,
*replace* the APPLY directive with a redirect block:

```
WORKFLOW ACTIVE — do not apply this skill directly.
Run: akm workflow next '<runId>'
Current step: <stepId>
Workflow: <workflowTitle>
```

If no active workflow exists, the existing APPLY directive is shown unchanged.

**Feasibility**: High. Same DB read as Option A. The replacement happens in
`formatShowPlain()` at the point where the APPLY block would otherwise be
emitted.

**Risk**: Low. The APPLY block is the source of the failure mode, so
suppressing it is directly targeted. No new output shape. No new CLI surface.

**Strength**: This option removes the conflicting signal at its source.
An agent that reads the full output receives no APPLY directive to act on —
only a directive to call `akm workflow next`. This is the most direct
intervention.

---

### Option C — `akm workflow lock` / enforcement flag

A new "enforced mode": `akm workflow start` writes an `active-workflow` file
to XDG state; `akm show` and `akm search` read it; `akm workflow complete`
(final step) deletes it.

**Feasibility**: Medium. Requires new state file management; risk of stale
lock files (e.g. if the agent is interrupted). Adds cleanup logic in
`completeWorkflowStep()` and `resumeWorkflowRun()`.

**Risk**: Higher than A/B. Stale files would suppress APPLY directives
permanently for honest direct-show use cases. Requires explicit unlock on
workflow completion and a cleanup path for abandoned runs.

**Verdict**: Not recommended. The lock provides no information the DB doesn't
already have; it just adds a second source of truth that can diverge.

---

### Option D — Workflow-aware `akm show` output reshaping (prepend WARNING)

Similar to Option A but specifically for `akm show`, and the WARNING is placed
at the very top of the output — before the asset content — with the run ID
and current step ID embedded.

```
WARNING: A workflow is active. The content below is for reference only.
Do NOT apply it directly.
Run: akm workflow next '<runId>'
Current step: <stepId>
---
[skill content follows]
```

**Feasibility**: High (same DB read). The run ID and current step ID are
available from the first row of the query.

**Risk**: Low for show; slightly higher than B because the content still
follows the warning. Agents sometimes read instructions at the end of a block
more carefully than warnings at the top.

**Verdict**: A good complement to Option B but not a standalone fix.
When used alongside B it creates redundant reinforcement (top AND bottom).

---

### Option E — AGENTS.md / task workspace fixture

Add a mandatory AGENTS.md to every workflow-compliance task workspace:

```markdown
CRITICAL: You MUST use akm workflow commands.
Running `akm show` and applying a skill directly WILL FAIL this task.
Required sequence:
  1. akm workflow next '<ref>'
  2. Perform the step.
  3. akm workflow complete '<runId>' --step '<stepId>'
NEVER apply skill content directly.
```

**Feasibility**: High (no tool changes at all).

**Risk**: Low in isolation. High in combination with tool changes, because it
creates two enforcement layers that can become stale independently.

**Weakness**: This changes the task fixture, not the tool. The tool still
emits the APPLY directive. If a future task fixture omits the AGENTS.md, the
problem recurs. Option E is a test-harness fix, not a tool fix.

**Verdict**: Recommended as a short-term mitigation for existing bench tasks,
but should not substitute for the tool-level fix.

---

## Recommendation: Combine B + D (+ E as short-term mitigation)

**Primary fix: Option B** — replace the APPLY directive with a workflow
redirect when an active run exists.

**Secondary reinforcement: Option D** — prepend a WARNING block at the top
of `show` output when an active run exists, before the skill body.

Together, an agent that calls `akm show skill:<name>` with an active workflow
sees:

1. **Top of output**: WARNING header with run ID and next step command.
2. **Skill content**: present for reference (agents may legitimately need to
   understand the schema to interpret the step instructions).
3. **Bottom of output**: WORKFLOW ACTIVE block (replacing APPLY) with the run
   ID repeated.

This eliminates the APPLY directive that causes the failure, reinforces the
redirect at both ends of the output, and keeps the skill content visible for
legitimate inspection during a workflow step.

**Short-term only: Option E** — patch existing bench task fixtures with a
stronger AGENTS.md. This prevents failures while the tool fix is being
reviewed and integrated.

---

## Implementation spec (Options B + D combined)

### Files to change

1. `src/output/text.ts` — all changes are in `formatShowPlain()`.
2. `src/workflows/runs.ts` — add a new exported helper `getActiveWorkflowRun()`.

No changes to `show.ts`, `search.ts`, CLI definitions, or any output shape
(`shapes.ts`) are needed. The change is purely in the text renderer for the
`show` command.

---

### Step 1: Add `getActiveWorkflowRun()` to `src/workflows/runs.ts`

Add a new exported function after `listWorkflowRuns`:

```typescript
/**
 * Returns the most recently updated active (or blocked) workflow run,
 * or null if no active run exists. Used by output renderers to suppress
 * the APPLY directive and redirect agents to the workflow gate.
 *
 * This is a synchronous, read-only query. It opens and immediately closes
 * the workflow DB — safe to call from any renderer context.
 */
export function getActiveWorkflowRun(): {
  runId: string;
  workflowRef: string;
  workflowTitle: string;
  currentStepId: string | null;
} | null {
  let db: import("bun:sqlite").Database | null = null;
  try {
    db = openWorkflowDatabase();
    const row = db
      .prepare(
        `SELECT id, workflow_ref, workflow_title, current_step_id
         FROM workflow_runs
         WHERE status IN ('active', 'blocked')
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get() as
      | { id: string; workflow_ref: string; workflow_title: string; current_step_id: string | null }
      | undefined;
    return row
      ? {
          runId: row.id,
          workflowRef: row.workflow_ref,
          workflowTitle: row.workflow_title,
          currentStepId: row.current_step_id,
        }
      : null;
  } catch {
    // DB unavailable (first run, missing file, locked) — silently degrade.
    return null;
  } finally {
    if (db) closeWorkflowDatabase(db);
  }
}
```

**Edge cases handled**:
- DB file does not exist yet (first run): caught by the `try/catch`.
- DB is locked by another process: caught, returns `null`.
- Multiple active runs (shouldn't happen, but possible): returns the most
  recently updated one.
- Completed/failed runs: excluded by `WHERE status IN ('active', 'blocked')`.

---

### Step 2: Modify `formatShowPlain()` in `src/output/text.ts`

The function is currently pure (no IO). The change makes it accept an optional
active-run descriptor injected by the caller, keeping the function testable
without a real DB.

**Approach**: Change the function signature to accept an optional
`activeRun` parameter. The call site in `formatPlain()` (line 58) becomes
the only place that queries the DB — keeping the formatter pure.

#### 2a. Update `formatPlain()` call site

In `formatPlain()`, change the `case "show"` branch:

```typescript
case "show": {
  // Check for an active workflow run so formatShowPlain can suppress
  // the APPLY directive and redirect the agent through the workflow gate.
  let activeRun: ActiveWorkflowRunInfo | null = null;
  try {
    const { getActiveWorkflowRun } = await import("../workflows/runs.js");
    activeRun = getActiveWorkflowRun();
  } catch {
    // Workflow DB unavailable — degrade silently, show normal APPLY.
  }
  return formatShowPlain(r, detail, activeRun);
}
```

Note: `formatPlain()` is currently synchronous. The dynamic import approach
makes `formatPlain()` async for the `show` case only. If this is undesirable,
the query can be pushed up to the CLI layer in `src/cli.ts` or the output
shape builder and passed down through the existing result object as an
optional field (see Alternative approaches below).

**Alternative (preferred for keeping formatPlain sync)**: Have the caller
(the `show` command output path) query `getActiveWorkflowRun()` before
building the plain-text output, and pass the result into `formatPlain` via
an `options` bag or a new field on the show result object.

Concretely, since `akmShowUnified()` already returns a `ShowResponse` and
the CLI already passes it to `formatPlain`, the cleanest path is:

1. Query `getActiveWorkflowRun()` in the show command handler (the citty verb).
2. Attach the result as `activeRun` on the result object (not a typed field —
   just a transient carry field since the result is passed to `formatPlain`
   immediately and never serialized).
3. `formatShowPlain(r, detail)` reads `r.activeRun` from the result dict.

This keeps everything synchronous and avoids touching `formatPlain`'s
signature type for other commands.

#### 2b. Update `formatShowPlain()` body

Replace the current APPLY block for `skill` / `knowledge` (lines 688-723
of `src/output/text.ts`):

**Current code**:
```typescript
const assetType = typeof r.type === "string" ? r.type : null;
const assetRef = typeof r.name === "string" && assetType ? `${assetType}:${r.name}` : null;
if (assetType === "skill" || assetType === "knowledge") {
  lines.push("");
  lines.push("---");
  lines.push("APPLY:");
  lines.push("  1. Find the workspace file ...");
  lines.push("  2. Add/edit the fields ...");
  lines.push("  3. Use the VALUES from your task description ...");
  lines.push(`Run \`akm feedback ${assetRef ? ...} ...\``);
}
```

**New code** (pseudocode — the real diff goes here):
```typescript
const assetType = typeof r.type === "string" ? r.type : null;
const assetRef = typeof r.name === "string" && assetType ? `${assetType}:${r.name}` : null;

// Resolve active workflow run. The caller may inject this as r.activeRun
// (a transient carry field, never serialized). If absent, fall through to
// the normal APPLY directive.
const activeRun =
  r.activeRun && typeof r.activeRun === "object"
    ? (r.activeRun as { runId: string; workflowRef: string; workflowTitle: string; currentStepId: string | null })
    : null;

if (assetType === "skill" || assetType === "knowledge") {
  lines.push("");
  lines.push("---");
  if (activeRun) {
    // Option D: prepend warning at top (insert BEFORE skill content)
    // This is handled separately below (see top-of-output insertion).

    // Option B: replace APPLY with workflow redirect at bottom.
    lines.push("WORKFLOW ACTIVE — do not apply this skill directly.");
    lines.push(`Run: akm workflow next '${activeRun.runId}'`);
    if (activeRun.currentStepId) {
      lines.push(`Current step: ${activeRun.currentStepId}`);
    }
    lines.push(`Workflow: ${activeRun.workflowTitle}`);
    lines.push(`After completing the step: akm workflow complete '${activeRun.runId}' --step '${activeRun.currentStepId ?? "<step-id>"}'`);
  } else {
    lines.push("APPLY:");
    lines.push("  1. Find the workspace file to edit ...");
    lines.push("  2. Add/edit the fields ...");
    lines.push("  3. Use the VALUES from your task description ...");
    lines.push(`Run \`akm feedback ${assetRef ? `'${assetRef}'` : "<ref>"} --positive\` after the task succeeds.`);
  }
}
```

For Option D (top-of-output WARNING), insert a block at the **very top** of
`lines` (before the `# skill: <name>` header) when `activeRun` is non-null
and the asset type is `skill` or `knowledge`:

```typescript
// Option D: prepend WARNING block at top of output.
if (activeRun && (assetType === "skill" || assetType === "knowledge")) {
  const warningBlock = [
    "WARNING: A workflow is active. The content below is for reference only.",
    "Do NOT apply it directly.",
    `Run: akm workflow next '${activeRun.runId}'`,
    ...(activeRun.currentStepId ? [`Current step: ${activeRun.currentStepId}`] : []),
    `Workflow: ${activeRun.workflowTitle}`,
    "---",
    "",
  ];
  lines.splice(0, 0, ...warningBlock);
}
```

This splice happens *after* all the content lines are built but *before*
`return`, so the warning header appears at position 0 in the final output.

---

### What the combined output looks like

**Before (no active workflow)**:
```
# skill: deploy-config
file: /path/to/skills/deploy-config.md
description: Deploys a service configuration.

[skill content here]

---
APPLY:
  1. Find the workspace file to edit ...
  2. Add/edit the fields ...
  3. Use the VALUES from your task description ...
Run `akm feedback 'skill:deploy-config' --positive` after the task succeeds.
```

**After (active workflow run exists)**:
```
WARNING: A workflow is active. The content below is for reference only.
Do NOT apply it directly.
Run: akm workflow next 'a3f2c1d0-...'
Current step: step-2-configure-service
Workflow: Service Deployment Workflow
---

# skill: deploy-config
file: /path/to/skills/deploy-config.md
description: Deploys a service configuration.

[skill content here]

---
WORKFLOW ACTIVE — do not apply this skill directly.
Run: akm workflow next 'a3f2c1d0-...'
Current step: step-2-configure-service
Workflow: Service Deployment Workflow
After completing the step: akm workflow complete 'a3f2c1d0-...' --step 'step-2-configure-service'
```

---

### Search output

No change to `formatSearchPlain()` is recommended for the initial fix. The
search footer already has a `hasWorkflowHit` branch that mentions workflow
commands. Search is a lower-risk path than show for direct application (agents
usually show before applying).

If the bench reveals search is also a vector, apply the same `activeRun`
check in `formatSearchPlain()` — replacing the generic "Next: akm show
'<ref>'" footer with "Next: akm workflow next '<runId>'" when an active run
exists.

---

### Edge cases to handle

| Scenario | Expected behavior |
|---|---|
| No active workflow run | Existing APPLY directive shown unchanged |
| Active run but `workflow.db` missing | `getActiveWorkflowRun()` returns null → APPLY shown (fail open) |
| Active run but asset is `agent` / `command` / `memory` | APPLY is not shown for these types today → no change needed |
| Active run but `akm show workflow:<name>` is called | The `workflow` branch in `formatShowPlain()` handles this separately (ACTION REQUIRED); no overlap |
| Multiple active runs (theoretically impossible, practically possible) | Query returns most recently updated → the relevant one is almost always the latest |
| `--json` / `--jsonl` output mode | `formatShowPlain()` is not invoked for JSON output; the JSON payload is unaffected |
| `--detail brief` or `--detail summary` | These skip the content/APPLY section entirely; no change needed |
| Agent running `akm show` for legitimate inspection during a workflow step | The WARNING says "for reference only" — the skill content is still shown, just with redirect directives |

---

### What NOT to change

- Do NOT change `ShowResponse` type (`src/sources/types.ts`). `activeRun` is
  a transient carry field on the raw result dict only, never persisted or
  serialized.
- Do NOT add a new CLI flag (e.g. `--workflow-active`) — the DB is the
  source of truth.
- Do NOT change the `workflow` branch in `formatShowPlain()` — it already
  handles `akm show workflow:<name>` correctly.
- Do NOT change `formatSearchPlain()` in this initial fix. Add it as a
  follow-on if bench data shows it is also a failure vector.
- Do NOT add new `EventType` for this feature — no new events are needed.

---

### Risk assessment for the recommended fix

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| DB read fails silently → APPLY shown when it shouldn't be | Low (DB is local SQLite) | Low (agent follows APPLY for non-workflow tasks) | `try/catch` in `getActiveWorkflowRun()` degrades to null |
| False positive: stale "active" run from a previous task | Medium (if harness doesn't clean up runs) | Medium (APPLY suppressed for correct-behavior tasks) | `status IN ('active', 'blocked')` — completed runs are excluded automatically |
| Performance regression | Very low (indexed `status` column, single-row SELECT) | Negligible | Query is O(1) with an index |
| Breaking the locked v1 contract | None | — | No CLI surface, type, or output shape changes |
| Tests break | Low | Low | `formatShowPlain` remains pure if `activeRun` is injected as a parameter; test null injection covers the "no active run" path |

The stale-run risk is the highest-concern edge case. Mitigation: the bench
harness should call `akm workflow complete` (or the run naturally expires by
status) between tasks. If the harness already does this, the risk is near
zero. If not, the harness fix is simpler than defending against it in the tool.

---

### Short-term mitigation: Option E

While the tool fix is in review, patch the bench task fixtures that are
workflow-compliance tasks. Add an AGENTS.md to each task workspace directory:

```markdown
CRITICAL: You MUST use akm workflow commands for this task.
Calling `akm show` and applying a skill directly WILL FAIL this task.

Required sequence:
  1. akm workflow next '<ref>'      — get your current step
  2. Perform the step exactly as instructed.
  3. akm workflow complete '<runId>' --step '<stepId>'  — mark it done.
  4. Repeat until all steps are complete.

NEVER edit workspace files before completing each step with the workflow complete command.
```

This gives immediate bench improvement with no tool risk, and can be removed
once the B+D tool fix is deployed and validated.

---

## Summary

| Option | Recommended | Rationale |
|---|---|---|
| A (prepend banner in show/search) | Partial — merged into D | Good but weaker than B alone |
| **B (replace APPLY when active run)** | **Yes — primary fix** | Removes the failure-causing directive at its source |
| C (lock file) | No | Redundant with DB; stale-file risk |
| **D (prepend WARNING at top of show)** | **Yes — secondary reinforcement** | Gives agent the redirect before reading content |
| **E (AGENTS.md in task fixtures)** | **Yes — short-term mitigation** | Immediate bench improvement, zero tool risk |

The lowest-risk, highest-impact change is **Option B alone**. Adding Option D
is cheap incremental insurance. Option E is cheap to deploy now and removes
the dependency on tool release timing for bench improvement.
