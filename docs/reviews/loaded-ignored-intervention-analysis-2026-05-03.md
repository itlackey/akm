# loaded_ignored Intervention Analysis — 2026-05-03

**Data source:** `/tmp/bench-all-loaded-ignored.json` — 54 cases  
**Model:** shredder/qwen/qwen3.5-9b  
**Failure mode:** agent called `akm search`, found the correct asset, called `akm show`, received the correct content, then wrote from training memory rather than following the skill.

---

## 1. Event Timing Patterns

### Search and show counts

| Metric | Value |
|--------|-------|
| 83% of failures | 1 search + 1 show (single pass, no retry) |
| 9% of failures | 1 search + 2 shows (re-read same skill) |
| Mean show-to-finish time | 30.4s |
| Median show-to-finish time | 24.8s |
| Failures finishing <30s after last show | 69% (37/54) |

The 30-second post-show window at ~20 tokens/second for qwen3.5-9b yields roughly 600 output tokens — enough for a short file write, but not enough for deep re-reading or reasoning about the skill content. Agents are reading the skill once, forming an incomplete or incorrect impression, and immediately writing.

The `inkwell/workflow-configure-scaling` task stands out: 5 runs showed skill:inkwell between 2–5 times each (loop), consuming 2–5 minutes per run. This is the agent re-reading the same skill because the APPLY directive tells it to "check whether a workflow applies" — and it keeps rechecking without resolving.

### Show timing on az-cli failures

For az-cli tasks, agents finish 16–24s after show. The skill content is clearly read (the model invokes show), but the output file (`commands.txt`) either misses the exact command string or writes nothing. This is the fastest failure mode, consistent with the model recalling a memorized command variant rather than copying from the skill.

---

## 2. Verifier Error Classification

### By domain

| Domain | Failures | Primary error pattern |
|--------|----------|----------------------|
| inkwell | 21 | YAML block missing entirely (7) or present with wrong values (14) |
| docker-homelab | 14 | Wrong compose structure — v2 keys retained, wrong version, missing internal network |
| workflow-compliance | 13 | Missing exact CLI flag, wrong qualifier, wrong action key |
| az-cli | 5 | commands.txt missing the correct `az` subcommand |
| opencode | 1 | Output file not created at all |

### Error sub-patterns

**Missing block entirely (7 inkwell cases):**  
`spec.healthcheck block missing`, `spec.scaling block missing`, `spec.limits block missing`.  
Agent understands the concept but either wrote the block at the wrong YAML nesting level (directly under `spec` vs under `spec.healthcheck`) or used different key names (`failureThreshold` instead of `threshold`, `requests_per_second` instead of `rps`).

**Block present, wrong value (14 inkwell cases):**  
`expected scaling.min=2, got None`, `expected path=/readyz, got None`, `expected metadata.name=auth-proxy`.  
Agent wrote the block structure from the skill but substituted its own values or left placeholder-style None values. This is the direct consequence of the APPLY directive instructing agents not to copy example values from the schema.

**Missing exact CLI flag (13 workflow-compliance + 5 az-cli):**  
`commands.txt missing 'az aks get-credentials'`, `commands.txt missing tag selector for env=prod`, `commands.txt missing blob-type qualifier`.  
The skill contains the exact command. The agent writes a syntactically plausible but semantically incomplete command from training memory (e.g., omits `--tag env=prod` qualifier, omits `--blob-type blockBlob`).

**Structural YAML errors (14 docker-homelab):**  
`expected version 3.8, got '2'`, `expected top-level internal network`, `expected env_file on the app service`, `expected top-level pgdata volume declaration`.  
The docker-homelab skill is a large reference guide (~200 lines) that covers these patterns in examples, but does not state the rules imperatively. Agents use the skill to confirm they're working with Docker Compose, then write from training knowledge for the specific task.

---

## 3. APPLY Directive Effectiveness

### Current wording (src/output/text.ts, lines 714–723)

```
APPLY (only if no workflow step is required for this task):
  1. Find the workspace file to edit (check README.md in the current directory for the target file name).
  2. Add/edit the fields shown above using the exact field names from this schema.
  3. Use the VALUES from your task description — do not copy example values from this schema verbatim.
If a workflow applies, run `akm workflow next` instead of editing directly.
Run `akm feedback skill:inkwell --positive` after the task succeeds.
```

### Problems with current wording

**Problem A — Step 3 is causing failures in inkwell.**  
The inkwell skill shows `min: 2, max: 10, metric: rps, target: 200` as an example. Many tasks (e.g., `full-config`, `configure-scaling`) use `min: 2` as the actual correct value — the same as the schema example. The directive to "not copy example values verbatim" tells agents to substitute their own values, causing `got None` or wrong values. The distinction between *schema structure* (must copy) and *example data* (may differ) is absent from the directive.

**Problem B — Step 2's "fields shown above" is ambiguous.**  
The skill content is a Markdown document with embedded YAML code blocks. "Fields shown above" could refer to the prose descriptions or to the YAML structure. Agents that interpret it as "the descriptive text above" miss the YAML nesting entirely — producing `spec.healthcheck block missing` failures.

**Problem C — The APPLY directive is YAML-schema-centric and inappropriate for command-output tasks.**  
For az-cli tasks, the output artifact is a `commands.txt` file containing a shell command, not a YAML schema edit. Telling the agent to "add/edit fields from this schema" is semantically wrong for this task type. The agent reads the directive, gets confused, and falls back to writing a command it "knows" from training.

**Problem D — Workflow conditional creates re-read loops.**  
"If a workflow applies, run `akm workflow next`" combined with the search output "check whether a workflow applies" causes agents on workflow-adjacent tasks (e.g., `workflow-configure-scaling`) to re-show the skill 2–5 times trying to determine if a workflow applies, burning context and tokens without resolving.

---

## 4. Template vs. Reference: The Core Framing Problem

The `loaded_ignored` failure pattern matches what the RAG/tool-use literature calls "authoritative-source bypass" — the model retrieves content but treats it as reference material (something to skim) rather than as an executable template (something to copy and fill in).

Evidence:
- 69% of agents finish within 30 seconds of their last show — too fast to have re-read or deeply reasoned from the content.
- The docker-homelab skill is a 200-line reference guide. Agents read it, confirm they're working with Docker Compose, then write their own compose file from memory. The skill contains the correct patterns but presents them as *examples*, not as *the template to use*.
- The inkwell skill contains exact YAML structures for every block the task requires. The APPLY directive explicitly says "don't copy example values verbatim" — which agents apply to the YAML structures themselves, not just to the example data values.

The fix is framing: the content in the code blocks of a skill file is not "documentation of how it works" but "the exact format you must produce." The APPLY directive must state this.

---

## 5. Search Output → Show Transition

### Current search footer (src/output/text.ts, lines 923–926)

```
Next: akm show 'skill:inkwell'
After reading the asset: check whether a workflow applies before editing — if so, use `akm workflow next` instead.
```

### Assessment

The transition prompt is present but weak in two ways:

1. **Does not establish authority of the show content.** "After reading the asset" implies reading is optional context-gathering. It does not say "the show output IS the authoritative specification — treat its code blocks as the exact template."

2. **The workflow conditional creates uncertainty.** Agents that search for an inkwell task and see a workflow in the results are told to check for a workflow before editing. This uncertainty causes re-reads (the workflow-configure-scaling loop) and could cause agents to skip editing entirely on tasks that don't require a workflow.

The search result for `akm search inkwell` returns both `skill:inkwell` and `workflow:configure-inkwell-service`. The `Next:` line points to the skill ref but the workflow caveat follows immediately. For agents already uncertain about when to use a workflow vs. direct edit, this is a decision fork that burns tokens and often results in neither path being completed correctly.

---

## 6. Proposed AKM Changes (Ranked by Impact)

### Change 1 — Rewrite APPLY step 3 to distinguish structure from values

**What:** In `src/output/text.ts`, `formatShowPlain`, replace line 720:

```typescript
// Current:
"  3. Use the VALUES from your task description — do not copy example values from this schema verbatim.",

// Proposed:
"  3. COPY the exact YAML structure (key names, nesting, types) from the code blocks above. " +
"Fill in VALUES from your task description. Do not substitute key names.",
```

**Why:** Addresses root cause B (wrong nesting / missing blocks) and partially addresses root cause A (wrong values). The current directive to "not copy example values verbatim" is being applied to key names and YAML structure, not just to the data values, causing both missing blocks and wrong field names. The new wording makes the copy-structure-fill-values distinction explicit.

**Evidence:** 7 inkwell failures have the block entirely missing (agent didn't copy the YAML structure). 14 inkwell failures have wrong values (agent substituted its own values for the schema examples). All 21 inkwell cases are directly caused by this directive ambiguity.

**Estimated impact:** 15–18 of the 21 inkwell failures. Agents that understand the task but miscopy the structure will now have clear instruction to copy structure verbatim. Some remaining failures are due to skill content coverage gaps (e.g., full-config tasks where the exact expected values don't appear in the skill).

---

### Change 2 — Add a type-specific APPLY variant for non-YAML skills (command output)

**What:** In `src/output/text.ts`, `formatShowPlain`, the APPLY block is currently emitted for all `skill` and `knowledge` types. Add a skill-type branch that emits a different directive when the skill content is primarily imperative/command-based rather than schema-based.

The simplest heuristic: if `r.content` contains more fenced shell/bash blocks than YAML blocks, emit a command-output directive instead:

```
APPLY:
  1. Find the output file named in the workspace README.md.
  2. Write the EXACT command shown in the code block(s) above that matches your task.
  3. Fill in task-specific values (names, resource groups, etc.) from the task description.
  4. Do not paraphrase or reconstruct the command from memory — copy it from the skill.
```

**Why:** The current APPLY directive is YAML-schema-centric ("add/edit fields"). For az-cli tasks the artifact is a `commands.txt` file with a shell command. The word "fields" is semantically wrong and causes the model to reframe the task as schema editing. The command-output directive says "copy the command" with no ambiguity.

**Evidence:** All 5 az-cli failures and all 13 workflow-compliance failures (18 total) involve writing a commands.txt file with the correct `az` command. The skill contains the exact command in a code block. Agents are writing plausible but incomplete commands from training memory. The directive to "not copy example values verbatim" is being applied to the command syntax itself.

**Estimated impact:** 12–16 of the 18 az-cli + workflow-compliance failures. The exact command is in the skill; agents just need explicit permission and instruction to copy it directly.

---

### Change 3 — Remove "check whether a workflow applies" from search output

**What:** In `src/output/text.ts`, `formatSearchPlain`, lines 923–926, remove or simplify the workflow conditional in the non-workflow case:

```typescript
// Current:
lines.push(`Next: akm show '${topRef}'`);
lines.push(
  "After reading the asset: check whether a workflow applies before editing — if so, use `akm workflow next` instead.",
);

// Proposed:
lines.push(`REQUIRED NEXT STEP: akm show '${topRef}'`);
lines.push(
  "The show output is authoritative — its code blocks are the exact format you must produce.",
);
```

Keep the workflow-specific branch (when a workflow hit exists) but remove it from the non-workflow path. When the search results contain no workflow hit, agents should not be told to check for one.

**Why:** The "check whether a workflow applies" sentence creates a decision fork that burns tokens. For tasks like `workflow-configure-scaling`, the search returns both `skill:inkwell` and `workflow:configure-inkwell-service`, causing agents to re-read the skill 2–5 times trying to resolve the fork. For tasks with no workflow hit (most inkwell and all az-cli tasks), the conditional is irrelevant and distracts from the core imperative. The proposed change also upgrades "Next:" (weak suggestion) to "REQUIRED NEXT STEP:" (explicit mandate).

**Evidence:** 5 `workflow-configure-scaling` failures show 2–5 show calls each (the only cases with >1 show). All have the same outcome: agent reads the skill repeatedly without applying it. The workflow-conditional in search output is the proximate cause of the re-read loop. The remaining 45 single-show failures show agents that are not re-reading — for them, the workflow conditional adds friction without benefit.

**Estimated impact:** 3–5 of the 5 workflow-configure-scaling failures, plus minor positive effect (reduced confusion) across 10–15 other failures.

---

### Change 4 — Strengthen the APPLY header to assert authority

**What:** In `src/output/text.ts`, `formatShowPlain`, replace the APPLY header:

```typescript
// Current:
lines.push("APPLY (only if no workflow step is required for this task):");

// Proposed:
lines.push("---");
lines.push("AUTHORITATIVE SPECIFICATION — FOLLOW EXACTLY:");
lines.push("The code blocks above are the required format. Do not substitute from memory.");
```

And remove the parenthetical "(only if no workflow step is required)" — this hedge immediately undermines the authority of the directive. The workflow check belongs in a separate, explicit gate.

**Why:** The current header reads as optional ("only if no workflow step..."). Small models with strong priors will treat optional instructions as defaults-off. Research on instruction following in smaller LLMs consistently shows that imperative framing without hedges produces higher compliance. The "authoritative specification" framing creates the mental model that the skill content is the ground truth, not one possible reference among others.

**Evidence:** The 30.4-second average post-show window and the 69% <30s completion rate together indicate agents are not deeply processing the skill content before writing. They are forming a quick impression and writing from prior knowledge. Stronger framing at the top of the directive (not buried in step 2) is needed to interrupt the fast-retrieval default.

**Estimated impact:** Difficult to isolate from Change 1 and 2, but expected to contribute 5–10 additional recoveries by changing how agents orient to the content. Most likely impact on the "block missing" failures where the agent understood the concept but didn't treat the YAML structure as authoritative.

---

### Change 5 — Add a content-type indicator to the show header

**What:** In `src/output/text.ts`, `formatShowPlain`, after the `# skill: <name>` header, add a one-line content-type hint that signals whether the skill is a schema specification, a command reference, or a procedural guide:

```typescript
// Proposed addition after the existing header lines:
if (r.contentType) {
  lines.push(`# content-type: ${String(r.contentType)}`);
} else if (r.content) {
  // Heuristic: count code block types
  const content = String(r.content);
  const yamlBlocks = (content.match(/```ya?ml/gi) ?? []).length;
  const shBlocks = (content.match(/```(?:sh|bash|shell)/gi) ?? []).length;
  if (yamlBlocks > shBlocks && yamlBlocks > 0) {
    lines.push("# content-type: yaml-schema (the YAML code blocks define the exact structure)");
  } else if (shBlocks > 0) {
    lines.push("# content-type: command-reference (copy commands from code blocks exactly)");
  }
}
```

**Why:** The primary mismatch is that agents treat all skill content as "reference documentation" regardless of whether it is a schema specification (inkwell), a command reference (az-cli), or a procedural guide (docker-homelab). A content-type signal at the top of the output sets the agent's reading strategy before it processes the content body. This is cheap to implement and requires no changes to the skill files themselves.

**Evidence:** The failure rate is near-uniform across inkwell (schema), az-cli (command), and docker-homelab (procedural guide) domains — 21, 14, and 5 failures respectively. These are three different content types requiring different application strategies. Currently all three receive the same APPLY directive. A content-type header would allow future specialization even before full per-type APPLY variants are built.

**Estimated impact:** Low direct impact in isolation (the content-type header doesn't itself change behavior), but it amplifies the effect of Changes 1, 2, and 4 by giving agents a framing cue that increases receptivity to the type-specific APPLY directive. Estimated 3–6 additional recoveries.

---

## 7. Summary Table

| # | Change | File | Root causes | Expected recoveries |
|---|--------|------|-------------|---------------------|
| 1 | Rewrite APPLY step 3: copy structure, fill values | `src/output/text.ts` | B (wrong nesting), A (wrong values) | 15–18 of 21 inkwell |
| 2 | Add command-output APPLY variant for shell-heavy skills | `src/output/text.ts` | C (YAML-centric directive for command tasks) | 12–16 of 18 az-cli + workflow-compliance |
| 3 | Remove workflow check from search output non-workflow path | `src/output/text.ts` | D (re-read loop) | 3–5 of 5 workflow-configure-scaling |
| 4 | Strengthen APPLY header: "AUTHORITATIVE SPECIFICATION" | `src/output/text.ts` | All (hedged authority) | 5–10 across all domains |
| 5 | Add content-type indicator to show header | `src/output/text.ts` | All (strategy mismatch) | 3–6 amplifier effect |

**Total estimated recoveries: 28–40 of 54 failures (52–74%)**

Changes 1–4 all touch `src/output/text.ts` in the `formatShowPlain` and `formatSearchPlain` functions. They are low-risk, no-schema-change modifications. No stash content changes are required.

---

## 8. What This Analysis Does NOT Explain

**~14 failures are likely stash content gaps**, not AKM output format issues:

- `docker-homelab` failures (14 total): the docker-homelab skill is a general reference guide. Tasks like `compose-version-upgrade` require knowing "remove mem_limit, cpu_shares, volume_driver from v3 compose" — this rule is implied by the skill examples but not stated imperatively. Even with a perfect APPLY directive, agents may miss the removal of deprecated keys. Fixing these requires adding task-specific procedural rules to the skill content itself (not an AKM tool change).

- `inkwell/full-config` (5 failures): all produced `expected scaling.min=2, got None`. The skill shows `min: 2` in an example. After Change 1, this should recover since agents will be told to copy the YAML structure. However, if the task requires values that differ from all skill examples, agents may still default to None. The skill needs a more explicit "these are the type signatures, not the values" annotation.

- `opencode/provider-akm-feedback` (1 failure): `provider.sh missing` — the output file wasn't created. This is likely a task-setup or skill-content gap, not an AKM output format issue.
