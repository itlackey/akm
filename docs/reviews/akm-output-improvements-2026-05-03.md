# AKM Output Improvements — 2026-05-03

Synthesized from bench evaluation session. Dominant failure mode: `loaded_ignored` — agents
find the right asset (`correctAssetLoaded=True`) but do not apply it. They complete the
`search → show` chain then stop without editing any workspace file.

---

## Tier 1 — High value, very low risk (string additions to formatters only)

Each item below is a targeted string addition or change inside `src/output/text.ts`. No
architectural change; no new commands; estimated < 30 min each.

---

### T1-1  `akm show` skill/knowledge — add WHERE-to-apply context

**What:** Extend the APPLY directive in `formatShowPlain` (lines 692-695) to tell agents
which file to edit, not just what schema to use.

**Why:** Agents saw the APPLY directive but had no idea *where* to write the content. The
directive said "use the field names and structure shown above" — agents re-read the skill and
stopped. `loaded_ignored` rate stayed high because the directive addressed the *what* but not
the *where*.

**How:** In `formatShowPlain`, the `skill`/`knowledge` branch (line 689), replace the current
single APPLY line with two lines:

```
APPLY: The content above is a schema — field names and structure only.
  1. Identify the workspace file that needs editing (check the task README or workspace root
     for a .yaml, .json, or config file matching this asset type).
  2. Edit that file using the field names above and the VALUES from your task description.
  3. Do NOT copy example values verbatim.
Run `akm feedback '<ref>' --positive` after the task succeeds.
```

**Expected impact:** Directly addresses `loaded_ignored` for skill and knowledge tasks where
the workspace target is ambiguous. Agents currently stop after `akm show`; explicit step
numbering makes "edit the file" a required action, not an inference.

---

### T1-2  `akm show` workflow — add run directive at TOP, not just bottom

**What:** Move the `NEXT STEP` line to appear *before* the steps listing in
`formatShowPlain`, and repeat it as a single-line header.

**Why:** `formatWorkflowNextPlain` (line 757) emits the next-step detail at the bottom.
`formatShowPlain`'s workflow branch (line 696) adds `NEXT STEP` at the bottom too. Agents
read the step list, extract instructions manually, then skip `akm workflow next` entirely —
treating `show` output as if it were `next` output.

**How:** In `formatShowPlain`, within the `assetType === "workflow"` branch (line 696), insert
the run directive *before* the steps block rather than appending it after `---`. Also change
the wording from "NEXT STEP: Run ..." to "ACTION REQUIRED: Do not read steps manually. Run
`akm workflow next '<workflowRef>'` now to get your current step and instructions."

**Expected impact:** Eliminates the pattern where agents parse step list from `show` output
and act on step 1 without running `akm workflow next`, bypassing completion tracking.

---

### T1-3  `akm search` — include edit guidance after the "Next:" hint

**What:** Extend the `Next:` line in `formatSearchPlain` (lines 839-851) to mention the
edit step after show.

**Why:** The current hint (`Next: akm show '<ref>'  |  Tip: use 'akm show <ref>' to see full
content and usage instructions`) stops at `show`. Agents comply — they run `akm show` — but
the chain ends there. Nothing tells them that after reading the asset they should edit a file.

**How:** In `formatSearchPlain`, change the non-workflow hint (line 848) to:

```
Next: akm show '<topRef>'
After reading the asset: edit the workspace file using the schema from the show output.
```

For workflow hits, change the line (line 845) to:

```
Next: akm show '<topRef>'  |  To execute a workflow: akm workflow next '<wfRef>'
After starting: follow each step with `akm workflow complete <run-id> --step <id>`.
```

**Expected impact:** Closes the `search → show → stop` gap. Agents currently follow the
`Next:` hint to `show` then wait for further instruction that never comes.

---

### T1-4  `akm search` — no-results: suggest specific follow-up queries

**What:** Improve the no-results message in `formatSearchPlain` (line 784-785) to suggest
concrete follow-up queries rather than generic advice.

**Why:** When agents get zero results they see "No matches found. Tip: try a broader query…"
and either stop or retry with the same query. No alternative queries are suggested.

**How:** In `formatSearchPlain`, when `allHits.length === 0`, output:

```
No matches found.
Try:
  akm search '<broader-term>'        # use fewer keywords
  akm list                           # see all indexed sources
  akm search '<query>' --source both # include registries
  akm curate '<query>'               # let akm pick the best matches
```

The `r.tip` value (when present from the search layer) should still be surfaced first. The
four follow-up lines are appended unconditionally. This replaces the current single-line tip
(line 785).

**Expected impact:** Prevents agents from giving up on the first empty search. Addresses
~25/27 akm failures in the 2026-05-03 baseline that were categorised as `search_no_gold`.

---

### T1-5  `akm curate` — closing guidance names the action, not just the command

**What:** Replace the closing line in `formatCuratePlain` (line 985) with a three-line
action directive.

**Why:** The current footer (`Next: akm show <ref>  |  To search further: akm search
'<query>'`) tells agents to show an asset but not what to do after. Same `loaded_ignored`
pattern as with `search`.

**How:** In `formatCuratePlain` (line 984-985), replace the closing lines with:

```
Next steps:
  1. Run `akm show <ref>` for the top result above to read the full schema.
  2. Edit the workspace file using that schema and task-specific values.
  3. Run `akm feedback <ref> --positive` when done.
To explore: akm search '<query>'
```

**Expected impact:** Converts `curate` from a dead end (agents read, stop) into a three-step
action checklist. Matches the pattern that worked for `akm show` APPLY directive.

---

### T1-6  `akm workflow next` — add `akm workflow complete` command inline

**What:** Append the exact `akm workflow complete` command (with placeholders filled from
output data) to `formatWorkflowNextPlain` (line 757).

**Why:** Agents read the `next` output, complete the described work, then do not run `akm
workflow complete` because they don't know the exact syntax or which `run-id` and `step-id`
to use. They either call `workflow next` again (which re-shows the same step) or stop.

**How:** In `formatWorkflowNextPlain` (line 757), after the `completion` criteria lines,
append:

```
COMPLETE THIS STEP:
  akm workflow complete '<runId>' --step '<stepId>'
```

The `runId` comes from `result.run.id` (already available on the shaped result) and
`stepId` from `step.id`. Both are currently rendered in the base status block but not
combined into a copy-paste command.

**Expected impact:** Eliminates the most common workflow `loaded_ignored` variant: agent
executes step work, sees no "complete" prompt, and silently stops.

---

## Tier 2 — Medium value, low risk (small feature additions)

Items that add < 50 lines, no new commands or breaking changes.

---

### T2-1  `akm show` skill — surface `path` prominently in plain-text output

**What:** In `formatShowPlain` (line 630), always render the asset's `path` field near the
top of the output (not just when `detail === "full"`), at least when `editable` is true.

**Why:** Agents who do reach the "edit a file" step often don't know *which* file to edit.
The `path` field exists in the JSON output at all detail levels (see `shapeShowOutput` line
492 — `path` is projected outside of `detail === "full"` guard), but the plain-text renderer
only shows it in full mode (line 656). A writable asset's disk path is the most actionable
piece of information for an agent about to edit it.

**How:** In `formatShowPlain`, after the `# type: name` header (line 633), add:

```typescript
if (r.path && r.editable !== false) {
  lines.push(`path: ${String(r.path)}`);
}
```

This replaces the existing `detail === "full"` guard for `path` (line 657) with an
always-visible variant gated on editability. Keep the `detail === "full"` block for
`editable`, `editHint`, and `schemaVersion`.

**Expected impact:** Agents no longer have to infer which file to edit from the task README
alone. Paired with T1-1, this gives them both the schema (content) and the destination
(path) in a single `akm show` call.

---

### T2-2  `akm search` — surface `path` field in normal-detail hits for editable assets

**What:** Project `path` into normal-detail search hits when `editable === true`, so agents
can skip a separate `akm show` call when they already know which asset they want to edit.

**Why:** The `shapeSearchHit` function (line 431, `shapes.ts`) omits `path` at `brief` and
`normal` detail levels. Agents who use `--detail normal` (the most common non-default mode)
cannot locate the file without a follow-up `akm show`.

**How:** In `shapeSearchHit` (line 463, `shapes.ts`), in the `detail === "normal"` branch,
change the `pickFields` call to include `"path"` and `"editable"` when `hit.editable` is
true:

```typescript
const base = capDescription(
  pickFields(hit, ["type", "name", "description", "action", "score", "estimatedTokens", "warnings", "quality"]),
  NORMAL_DESCRIPTION_LIMIT,
);
if (hit.editable === true && hit.path) {
  base.path = hit.path;
  base.editable = true;
}
return base;
```

Also update `formatSearchPlain` (line 814) to render `path` when present.

**Expected impact:** Reduces round-trips for the common "search, find the right skill, edit
it directly" pattern. Current flow requires 2 commands; this makes 1 sufficient when path
is needed.

---

### T2-3  `akm show` workflow — include run-id in the top-level output

**What:** In `formatWorkflowNextPlain` (line 757), surface the run-id as a top-level
labeled field immediately after the workflow ref line.

**Why:** The run-id is buried inside the `run:` sub-block (line 735). Agents parsing the
text output to fill in `akm workflow complete '<run-id>'` have to scan several lines. A
missing or wrong run-id causes the complete call to fail.

**How:** In `formatWorkflowNextPlain`, add `runId: <run.id>` as a distinct line directly
after the `run:` line in the base block. Label it distinctly as `runId` (not `run:`) so
it does not collide with the existing `run:` workflow-ref field:

```typescript
lines.push(`runId: ${String(run.id ?? "unknown")}`);
```

Also bold-label it in the COMPLETE directive added by T1-6: `akm workflow complete
'${run.id}' --step '${step.id}'`.

**Expected impact:** Eliminates copy-paste errors when agents construct the `workflow
complete` command. Paired with T1-6, gives agents a complete, copy-paste-ready command.

---

### T2-4  `akm hints` — add agent workflow cheat sheet

**What:** Add a short "Agent workflow cheat sheet" section to `EMBEDDED_HINTS`
(in `src/output/cli-hints.ts`, line 11) that shows the 4-command loop agents should follow
for any task.

**Why:** The current `EMBEDDED_HINTS` is command-reference style — it lists commands but
does not show the *flow*. Agents who read it know what commands exist but not in which order
to chain them. The full hints (`EMBEDDED_HINTS_FULL`) has a separate Workflows section but
no "how to approach any task" recipe.

**How:** Insert before the `## Quick Reference` section:

```markdown
## Agent Task Loop

For any task, follow this 4-step loop:
1. `akm curate "<task>"` — find the best matching assets
2. `akm show <ref>` — read the schema (field names and structure)
3. Edit the workspace file using the schema fields + task-specific values
4. `akm feedback <ref> --positive` — record success for future ranking

For workflow tasks:
1. `akm search "<task>" --type workflow` — find the workflow
2. `akm workflow next workflow:<name>` — get the current step
3. Do the step work in your workspace
4. `akm workflow complete <run-id> --step <step-id>` — mark done, repeat
```

**Expected impact:** Gives agents a concise recipe that survives without AGENTS.md context.
Addresses the root cause of `loaded_ignored`: agents don't know the loop ends with an edit,
not a read.

---

### T2-5  `akm search` — distinguish between "no results" and "no sources configured"

**What:** In `formatSearchPlain` (line 784), treat the `warnings` array (surfaced when
sources are empty) as a distinct case with a setup-focused message, separate from the
"no matches" case.

**Why:** When no sources are configured, `akmSearch` returns a warning (`No stashes
configured`) but `formatSearchPlain` renders the generic no-results tip. Agents see the tip,
retry the query, and loop. The actual fix (`akm init`) is invisible.

**How:** In `formatSearchPlain`, before the no-hits branch, check for the warning:

```typescript
if (allHits.length === 0) {
  const hasSetupWarning = Array.isArray(r.warnings) &&
    r.warnings.some((w: unknown) => String(w).includes("No stashes configured"));
  if (hasSetupWarning) {
    return "No stash configured. Run `akm init` to create your working stash, then `akm index` to build the search index.";
  }
  // ... existing no-results path
}
```

**Expected impact:** Eliminates the silent setup-failure mode where agents retry a query
indefinitely on an unconfigured system. Saves ≥ 1 failed search call per empty-stash task.

---

## Tier 3 — Higher effort, medium risk (new commands or significant refactors)

Items worth doing but requiring more thought, wider testing, or new CLI surface.

---

### T3-1  `--detail agent` format for `akm show`

**What:** Add a structured machine-readable output mode (`--detail agent`) for `akm show`
that outputs a fixed-schema JSON envelope optimized for agent consumption: type, name, path,
schema (field names only, no content body), apply_target (inferred workspace file pattern),
and a `next_command` field.

**Why:** The current `--detail agent` / `--for-agent` output (in `shapeShowOutput`,
`shapes.ts` line 492) projects content fields but has no `apply_target` or `next_command`.
Agents using JSON output mode get the schema but still lack the WHERE and WHAT-NEXT fields.
This is the structured equivalent of T1-1.

**How:** Extend `shapeShowOutput` to support a new `detail === "agent"` branch that produces:

```json
{
  "type": "skill",
  "name": "configure-healthcheck",
  "path": "/path/to/stash/skills/configure-healthcheck.md",
  "editable": true,
  "schema_fields": ["interval", "timeout", "unhealthyThreshold"],
  "apply_note": "Edit the workspace config file using these field names and task-specific values.",
  "next_command": "akm feedback 'skill:configure-healthcheck' --positive"
}
```

The `schema_fields` list is extracted by scanning the content for YAML-key-like lines
(simple heuristic: lines matching `/^[a-zA-Z_]+:/` in the content body). The `apply_note`
is static per asset type.

This requires: (a) a new `detail` level or a `--for-agent` flag extension; (b) a schema
field extractor function; (c) registration in `shapeForCommand`. Estimated 60-90 min.

**Expected impact:** Enables agents using JSON output (not text) to get actionable apply
guidance without parsing the prose APPLY directive. Primarily helps automation pipelines,
not single-command agents.

---

### T3-2  `akm show` — infer apply-target file from workspace context

**What:** When `akm show` resolves an asset, scan the current working directory for likely
target files (`.yaml`, `.json`, or files whose name contains the asset name) and include
a `suggestedTarget` field in the output.

**Why:** Agents consistently fail to identify which workspace file to edit even when they
have the schema from `akm show`. The "WHERE to put it" problem (identified as a gap in the
session) is only solvable if the tool has workspace context. Currently `akm show` has no CWD
awareness.

**How:** In `showLocal` (`src/commands/show.ts`, line 265), after the renderer builds the
full response, scan `process.cwd()` for files matching patterns derived from the asset type
and name:

```typescript
const candidates = scanWorkspaceForTarget(process.cwd(), parsed.type, parsed.name);
if (candidates.length > 0) {
  fullResponse.suggestedTarget = candidates[0];
  fullResponse.suggestedTargetAlternatives = candidates.slice(1, 3);
}
```

`scanWorkspaceForTarget` is a new pure function in `src/core/workspace-scan.ts`. It walks
one level deep (not recursive) and ranks candidates by: exact name match > partial name
match > type-specific extension match. Returns at most 3 paths, relative to CWD.

Surface `suggestedTarget` in `formatShowPlain` between the header and the APPLY directive:

```
Edit target: <relative-path>  (inferred from workspace; verify before editing)
```

This is medium risk because CWD scanning can produce wrong results and may surprise users
who run `akm show` outside the workspace root. Gate behind a `--workspace` flag for the
first iteration.

**Expected impact:** If accurate (≥70% precision), directly eliminates the WHERE-to-apply
ambiguity for skill and knowledge tasks. This is the highest-potential improvement but also
the most failure-prone.

---

### T3-3  `akm curate` — output a ready-to-run action block

**What:** For each curated item, include a per-item `action_block` in both JSON and plain
text: a minimal executable snippet showing what to run or edit next for that specific item.

**Why:** `akm curate` already does the selection work. But the follow-up (`followUp` field)
is just the show command. Agents need to know: for a `script` type, run it; for a `skill`
type, read-then-edit; for a `workflow` type, run `akm workflow next`. The action differs by
type and the current output does not distinguish.

**How:** In `enrichCuratedStashHit` (`src/commands/curate.ts`, line 190), add an
`actionBlock` field to `CuratedStashItem`:

```typescript
actionBlock: buildCuratedActionBlock(shown?.type ?? hit.type, hit.ref, shown?.run),
```

Where `buildCuratedActionBlock` returns:

- `script`: `"Run: <run-command>"` (or `"akm show <ref>` to get the run command")
- `skill` / `knowledge`: `"akm show <ref>\nThen edit workspace file using the schema above."`
- `workflow`: `"akm workflow next <ref>"`
- `command`: `"akm show <ref>\nFill in the template parameters, then run the filled command."`
- `agent`: `"akm show <ref>\nUse as the system prompt for your next sub-agent call."`

Surface in `formatCuratePlain` below each item's `ref:` line as `action: <block>`.

This requires: (a) new `actionBlock` field on `CuratedStashItem`; (b) new helper function;
(c) renderer update. Estimated 45 min. Risk: action block may be wrong for non-standard
asset layouts.

**Expected impact:** Converts `akm curate` from a "here are the candidates" to a "here is
what to do with each one" output. Likely reduces `loaded_ignored` for curate-based task
flows by 30-50%.

---

### T3-4  `akm workflow next` output — add schema-vs-values clarification for data-entry steps

**What:** When `akm workflow next` returns a step whose instructions reference a config file
or YAML values, append a schema-vs-values note to the step instructions in
`formatWorkflowNextPlain`.

**Why:** The 2026-05-03 bench session showed that agents copy prose values (e.g. "10
seconds", "3 consecutive checks") verbatim from the task README or workflow instructions
into YAML, producing wrong types (string instead of integer). The workflow step instructions
don't distinguish between "this is the schema shape" and "use values from your task README."

**How:** In `formatWorkflowNextPlain` (line 757), after rendering `step.instructions`,
detect whether the instructions contain YAML-key-like patterns (heuristic: `\b\w+:\s*` with
at least 2 occurrences). When detected, append:

```
NOTE: The field names above are the schema. Use the VALUES from your task description or
      workspace README — do not copy prose descriptions as values.
      Integer values (timeouts, thresholds, counts) must be numbers, not quoted strings.
```

The heuristic is conservative (2+ YAML-key patterns) to avoid false-positives on plain-prose
steps.

This requires: (a) a simple regex check in the formatter; (b) the appended note text.
Estimated 20 min but flagged Tier 3 due to the heuristic being imprecise and potentially
annoying on non-data-entry steps.

**Expected impact:** Directly addresses the prose-to-YAML type error pattern observed in the
bench session. Reduces the class of failures where agents write `timeout: "10 seconds"`
instead of `timeout: 10`.

---

## Implementation Priority

Recommended sequencing for a single work session:

1. T1-4 (no-results improved tips) — broadest blast radius, zero risk
2. T1-6 (workflow complete command inline) — eliminates the most common workflow dead-end
3. T1-1 (show skill: WHERE-to-apply with numbered steps) — highest `loaded_ignored` impact
4. T1-2 (show workflow: directive at top) — prevents manual step-parsing bypass
5. T1-3 (search: edit guidance after show hint) — closes search→show→stop chain
6. T1-5 (curate: action checklist closing) — completes the curate→loaded_ignored fix
7. T2-1 (show: path in plain text for editable assets) — quick, high value
8. T2-4 (hints: agent task loop cheat sheet) — no-AGENTS.md fallback
9. T2-3 (workflow: run-id as labeled field) — pairs with T1-6
10. T2-5 (search: setup warning distinction) — prevents setup confusion
11. T2-2 (search: path in normal-detail hits) — reduces round trips
12. T3-3 (curate: action blocks by type) — medium effort, high curate-task impact
13. T3-4 (workflow next: schema-vs-values note) — targeted at YAML type errors
14. T3-1 (--detail agent structured envelope) — for JSON-consuming automation
15. T3-2 (show: infer apply-target from CWD) — highest potential, highest risk
