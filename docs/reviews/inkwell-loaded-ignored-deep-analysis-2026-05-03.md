# Inkwell `loaded_ignored` Failures — Deep Analysis (2026-05-03)

21 failures across 9 inkwell task variants. All runs used `shredder/qwen/qwen3.5-9b`.
Every run had `correctAssetLoaded=True` — agents found and read `skill:inkwell`, then
wrote incorrect or missing YAML.

---

## 1. What agents wrote wrong — specific error patterns

### Failure taxonomy (21 failures total)

| Pattern | Count | Tasks |
|---|---|---|
| Entire required block absent from service.yaml | 7 | add-healthcheck (2 seeds), configure-scaling (2 seeds), cpu-scaling (1 seed), set-rate-limit (1 seed), add-healthcheck (seed 2) |
| spec.scaling block absent after workflow run | 5 | workflow-configure-scaling (all 5 seeds) |
| spec.scaling block absent in multi-block task | 5 | full-config (all 5 seeds, fails at `scaling.min=None`) |
| service.yaml not created at all | 2 | new-service (seed 0), new-service-train (seed 0) |
| Wrong field name within present block | 1 | add-healthcheck-train seed 1: block present, `path` key is `None` |
| Wrong task-specific value (used example value) | 1 | new-service-train seed 3: `metadata.name` wrong |

### Error message patterns from `verifierStdout`

```
AssertionError: spec.healthcheck block missing           -- 3 failures
AssertionError: spec.scaling block missing               -- 3 failures  
AssertionError: spec.limits block missing                -- 1 failure
AssertionError: expected scaling.min=2, got None        -- 5 failures (full-config: scaling block absent entirely)
AssertionError: expected min=2, got None                -- 5 failures (workflow-configure-scaling: same)
AssertionError: expected path=/readyz, got None         -- 1 failure (block present, wrong field name)
AssertionError: expected metadata.name=auth-proxy       -- 1 failure
FileNotFoundError: No such file or directory: 'service.yaml' -- 2 failures
```

The dominant pattern (16/21) is "the required YAML block is entirely absent." The agent
loaded the skill, read the schema, then wrote a service.yaml that either omitted the
required block or did not create the file at all.

The `full-config` failures (5 seeds, 0% pass rate) all fail at the FIRST assertion
(`scaling.min=2, got None`). The verifier never reaches the `healthcheck` or `limits`
assertions. This is consistent with the agent writing only partial blocks (e.g., adding
healthcheck and limits but not scaling) or writing a `scaling:` key at the wrong nesting
level (`root` instead of `spec.scaling`).

The `add-healthcheck-train` seed 1 failure is distinctive: the spec.healthcheck block IS
present, but `hc.get("path")` returns `None`. This implies the agent wrote the block with
an incorrect field name — most likely using Kubernetes-style nesting such as
`httpGet.path` or `endpoint` instead of the flat `path:` key shown in the skill.

---

## 2. Analysis of current `akm show` output format and its contribution to `loaded_ignored`

### 2a. The APPLY directive is vague about which block to add

The APPLY directive appended by `formatShowPlain` (in `src/output/text.ts`, lines 713–723)
reads:

```
---
APPLY (only if no workflow step is required for this task):
  1. Find the workspace file to edit (check README.md in the current directory for the target file name).
  2. Add/edit the fields shown above using the exact field names from this schema.
  3. Use the VALUES from your task description — do not copy example values from this schema verbatim.
If a workflow applies, run `akm workflow next` instead of editing directly.
Run `akm feedback 'skill:inkwell' --positive` after the task succeeds.
```

Step 2 says "the fields shown above" — but the skill document contains FOUR distinct
configuration blocks (runtime, scaling, healthcheck, limits), each with its own YAML
snippet. "The fields shown above" is ambiguous. An agent with a task to "add scaling"
must infer that it should add the `spec.scaling` block specifically. Training memory
knows what "scaling" looks like in common container systems (Kubernetes, Nomad) and can
override the specific schema fields seen in the document.

There is no directive that says: "To add a specific block to service.yaml, insert ONLY
the YAML block for that feature under `spec:`." The lack of specificity lets training
memory fill the gap.

### 2b. The skill content is shown raw, including YAML frontmatter

`skillMdRenderer.buildShowResponse` in `src/output/renderers.ts` (line 233–243) sets
`content: ctx.content()`. `ctx.content()` returns the raw file including the frontmatter
YAML delimiters:

```
---
description: inkwell/v2 YAML schema — apiVersion, kind, spec.scaling, ...
tags:
  - inkwell
  ...
---
```

This means the show output begins with a `---` block that looks like YAML document
metadata. Agents trained on YAML formats may interpret this as part of the schema rather
than documentation metadata. More concretely, the opening `---` and the APPLY section's
`---` separator create three `---`-delimited regions that agents must parse correctly to
understand document structure. This adds cognitive overhead.

### 2c. The workflow-active WARNING contradicts the workflow step's instructions

This is the root cause for all 5 `workflow-configure-scaling` failures.

When a workflow run is active and the agent calls `akm show skill:inkwell`, the output is
prepended with (from `src/output/text.ts`, lines 696–709):

```
---
WARNING: WORKFLOW ACTIVE (run: <runId>)
Do NOT apply this asset directly. Complete your workflow step first:
  akm workflow complete '<runId>' --step '<stepId>'
```

Meanwhile, the workflow step `apply-config` (in
`tests/fixtures/stashes/inkwell/workflows/configure-inkwell-service.md`) instructs:

> Edit `service.yaml` in the workspace to add the required configuration block.

**These two directives directly contradict each other.** The skill show output says "Do
NOT apply this asset directly." The workflow step says "Edit service.yaml." The agent is
trained to treat prominent warnings at the top of a response as high-priority
instructions. Result: the agent runs `akm workflow complete` without ever editing
`service.yaml`, marking the step done without doing the work.

Evidence: In the workflow-configure-scaling runs, agents make 2–5 `show` calls to
`skill:inkwell` (visible in the events), repeatedly encountering the WARNING, then emit a
`workflow_step_completed` event without a corresponding file write. The verifier then
reports `spec.scaling block missing`.

### 2d. The APPLY directive does not name the target file

Step 1 of the APPLY directive says: "Find the workspace file to edit (check README.md in
the current directory for the target file name)."

This is indirect. Agents have already read `README.md` before calling `akm show` (that
is where they learned the task). By the time the APPLY directive fires, the agent already
knows the target file is `service.yaml`. The instruction to "check README.md" adds a
redirect loop: the agent may re-read README.md, find the same file name it already knew,
then proceed. More importantly, it does not say "Edit `service.yaml`" explicitly. This
makes the directive generic rather than actionable.

### 2e. The show output does not distinguish schema reference from copyable template

The skill contains both explanatory prose and YAML code blocks. The YAML blocks are
presented as examples (e.g., `name: api-gateway`, `target: 200`). The APPLY directive
says "do not copy example values from this schema verbatim." But the skill's code block
for scaling uses `min: 2 / max: 20 / target: 100`, which happen to match the
configure-scaling task's exact requirements — creating a confusing overlap where copying
verbatim would actually be correct for THAT task but wrong for others. The directive
creates doubt.

More critically, there is no "COPY THIS TEMPLATE" section that clearly separates "here
is the block structure to insert" from "here is explanatory prose." Agents must scan a
125-line document to extract the relevant YAML structure, which training memory can
preempt with a cached approximation.

---

## 3. Proposed AKM output format changes, ranked by expected impact

### Change #1 — Fix the workflow-active WARNING to permit file editing (IMPACT: HIGH)

**Location:** `src/output/text.ts`, lines 697–702

**Current text:**
```
WARNING: WORKFLOW ACTIVE (run: <runId>)
Do NOT apply this asset directly. Complete your workflow step first:
  akm workflow complete '<runId>' --step '<stepId>'
```

**Problem:** "Do NOT apply this asset directly" is interpreted as "do not edit the
workspace file." But the workflow step itself requires editing the file. The WARNING
blocks the required action.

**Proposed change:** Replace the current warning with one that clarifies that the skill is
being shown for REFERENCE to complete the current workflow step, not as a command to
execute independently:

```
WORKFLOW ACTIVE (run: <runId>, step: <stepId>)
You are in a workflow step. This skill is shown as a REFERENCE for your current step.
Read the schema above, then return to your workflow step and follow its instructions.
When done: akm workflow complete '<runId>' --step '<stepId>'
```

This eliminates the "Do NOT" instruction that blocks file editing, while still anchoring
the agent in the workflow context. The agent can then read the skill, understand the
schema, and edit `service.yaml` as the workflow step instructs.

**Why it reduces `loaded_ignored`:** 5 of 21 failures are workflow-configure-scaling. All
5 show the same pattern: multiple skill show calls + workflow_step_completed with no file
edit. Removing the contradictory prohibition directly unblocks correct behavior.

---

### Change #2 — Add explicit schema-block identifiers to make the APPLY directive actionable (IMPACT: HIGH)

**Location:** `src/output/text.ts`, lines 713–723 (the APPLY directive block)

**Problem:** "Add/edit the fields shown above" is underspecified. The agent does not know
which of the four spec blocks (runtime, scaling, healthcheck, limits) to add, or that it
must use `spec.<blockname>:` nesting.

**Proposed change:** Replace step 2 with a more specific instruction that names the YAML
nesting requirement:

```
APPLY (only if no workflow step is required for this task):
  1. Open the target file (service.yaml or the file named in README.md).
  2. Identify which spec block your task requires (e.g. spec.scaling, spec.healthcheck,
     spec.limits). Add that block verbatim under `spec:` using the exact field names
     and value types shown in the schema above.
  3. Use the VALUES from your task description — do not copy example values verbatim.
  IMPORTANT: Add the block as a child of `spec:`, NOT at the root of the document.
If a workflow applies, run `akm workflow next` instead of editing directly.
Run `akm feedback 'skill:inkwell' --positive` after the task succeeds.
```

The added `IMPORTANT` line directly addresses the most common wrong-nesting failure mode
(writing `scaling:` at root instead of under `spec:`).

**Why it reduces `loaded_ignored`:** The 7 "block entirely missing" failures (Groups 1 and
2 in the taxonomy) are caused by agents that read the skill but do not extract the correct
structure to write. A clear instruction about YAML nesting reduces the chance that training
memory provides a flat-structure approximation.

---

### Change #3 — Strip frontmatter from skill content before output (IMPACT: MEDIUM)

**Location:** `src/output/renderers.ts`, lines 233–243 (skillMdRenderer.buildShowResponse)

**Problem:** `ctx.content()` returns the raw file including YAML frontmatter delimiters.
The show output thus begins with:

```
# skill: inkwell
file: /path/to/SKILL.md
# Read and follow the instructions below

---
description: inkwell/v2 YAML schema — ...
tags:
  - inkwell
  ...
---
# inkwell
```

The leading `---` frontmatter block is not part of the schema agents should apply. It is
documentation metadata. However, it occupies the top-of-output position (high salience)
and uses `---` delimiters that conflict visually with the APPLY section's `---` separator.

**Proposed change:** In `skillMdRenderer.buildShowResponse`, strip frontmatter using
`parseFrontmatter` before setting `content`, and separately surface the `description`
field:

```typescript
// In skillMdRenderer.buildShowResponse:
const parsed = parseFrontmatter(ctx.content());
return {
  type: "skill",
  name,
  path: ctx.absPath,
  action: "Read and follow the instructions below",
  description: toStringOrUndefined(parsed.data.description),  // surfaced explicitly
  content: parsed.content,  // frontmatter stripped
};
```

Then in `formatShowPlain`, `r.description` (already handled at line 639) would show the
description as a labeled field rather than embedded in a YAML fence. The skill body would
begin directly at the first `#` heading.

**Why it reduces `loaded_ignored`:** Reduces visual noise at output start. The opening
`---` block is removed, eliminating possible confusion between frontmatter YAML and target
schema YAML. The description is surfaced as a labeled hint ("description: inkwell/v2 YAML
schema — exact field names...") in a prominent position before the content, giving agents
a faster orientation to what they are about to read.

---

### Change #4 — Add a "SCHEMA FIELDS" summary block to skill show output (IMPACT: MEDIUM)

**Location:** `src/output/text.ts`, `formatShowPlain`, inserted before the APPLY
directive for skill and knowledge assets

**Problem:** Agents must scan 117 lines of skill content to locate relevant field names.
The content is explanatory prose interspersed with YAML examples. Training memory can
"recognize" the task (e.g., "add healthcheck") and substitute its cached approximation
without carefully reading the correct schema. A concise, prominent schema summary at the
end of the content (before APPLY) would give agents a second, high-salience signal of the
exact field names.

**Proposed change:** If the skill's frontmatter `description` contains field names (as
inkwell's does), surface them as a compact reminder. Alternatively, add a standard
`SCHEMA FIELDS` header and extract the field names from the content body. However, this
requires parsing the markdown structure.

A simpler, universally applicable approach: insert a fixed reminder before the APPLY
block for skill assets:

```
---
SCHEMA REMINDER: Use ONLY the field names shown in the code blocks above. Field names in
this skill are exact — do not substitute synonyms from other systems (e.g. use `threshold`
not `failureThreshold`, use `path` not `httpGet.path`, use `rps` not `rate`).
```

This surfaces the anti-substitution instruction in a prominent position immediately before
the APPLY directive, making it the last thing an agent reads before deciding what to write.

**Why it reduces `loaded_ignored`:** The `add-healthcheck-train` seed 1 failure
(`path` key is `None`) indicates the agent substituted a Kubernetes-style field path
(`httpGet.path`) for the flat `path:` key. The SCHEMA REMINDER explicitly prohibits
this substitution class.

---

### Change #5 — Make the non-workflow APPLY directive name the target file explicitly (IMPACT: LOW–MEDIUM)

**Location:** `src/output/text.ts`, lines 715–716

**Current:** "Find the workspace file to edit (check README.md in the current directory
for the target file name)."

**Problem:** This sends agents to re-read README.md, adding an indirect loop. For `new-service`
(2 failures: file not created at all), the agent may have interpreted "find the workspace
file" as "the file already exists and needs editing" rather than "you may need to CREATE
this file."

**Proposed change:**

```
  1. Write or edit the target file (typically service.yaml — check README.md if unsure).
     If the file does not yet exist, CREATE it with the full structure shown in the schema.
```

The addition of "If the file does not yet exist, CREATE it" directly addresses the 2
new-service failures where agents showed the skill but never created `service.yaml`. The
task README says "Create `service.yaml`" and the skill shows the full structure — but the
APPLY directive's phrasing ("Find the workspace file to edit") implies the file already
exists, which may cause agents to abandon the task when they don't find it.

**Why it reduces `loaded_ignored`:** 2 of 21 failures are file-not-created cases. The
explicit `CREATE it` instruction directly covers this failure mode. The impact is lower
than changes #1–3 because only 2 failures are in this category, but the fix is
low-risk and low-cost.

---

## 4. Summary table

| Change | Location | Failure mode addressed | Failures potentially fixed |
|---|---|---|---|
| #1 Fix workflow-active WARNING | `src/output/text.ts` L697–702 | Workflow-active contradicts workflow step | 5 (workflow-configure-scaling) |
| #2 Explicit YAML nesting in APPLY | `src/output/text.ts` L713–723 | Block absent or at wrong nesting | 7 (add-healthcheck, configure-scaling, cpu-scaling, set-rate-limit) |
| #3 Strip frontmatter from skill content | `src/output/renderers.ts` L233–243 | Noise/confusion at output top | Cross-cutting (reduces cognitive load) |
| #4 SCHEMA REMINDER before APPLY | `src/output/text.ts` L712–713 insert | Wrong field names from training memory | 1 direct (add-healthcheck-train seed 1), cross-cutting for field-name failures |
| #5 APPLY step 1: include CREATE instruction | `src/output/text.ts` L715–716 | File not created | 2 (new-service, new-service-train) |

Changes #1 and #2 together address 12/21 failures by fixing a direct contradiction
(#1) and a structural ambiguity (#2). Changes #3–5 are lower direct impact but address
real output quality issues. All five changes are within `src/output/text.ts` and
`src/output/renderers.ts`; none require changes to stash content.

---

## 5. Event timing findings

Across all 21 failures, agents took 13–88 seconds between the last `akm show` event and
task completion. This rules out "insufficient processing time" as a cause. Agents had
adequate time to apply the schema. The failures are content-driven, not timing-driven.

8 of 21 runs have `feedbackRecorded=true` with positive signal despite the task failing.
This confirms that agents are hallucinating success — they believe they wrote the correct
YAML but the verifier disagrees. The APPLY directive's feedback instruction (`Run akm
feedback skill:inkwell --positive`) fires before the agent verifies its own output, and
the agent may give positive feedback based on its own (incorrect) assessment.

This is out of scope for AKM output changes (it would require the agent to re-read
`service.yaml` after writing it), but it explains why feedbackRecorded is not a reliable
success signal for these tasks.
