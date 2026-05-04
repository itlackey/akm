# Wave G Failure Analysis — 2026-05-04

**Bench run:** Wave G targeted run, 27 runs, 12 failures  
**Failure rate:** 44% (12/27)  
**Model:** (as configured for Wave G)

---

## Failure Summary

| Task | Outcome | Seeds | Primary error |
|------|---------|-------|---------------|
| inkwell/configure-scaling | budget_exceeded | 0 | 25+ tool calls, no write |
| inkwell/add-healthcheck-train | loaded_ignored | 2 | spec.healthcheck block missing |
| inkwell/full-config | loaded_ignored | 0,1,2 | scaling.min=2, got None |
| docker-homelab/env-from-file | loaded_ignored | 1 | expected env_file on app service |
| workflow-compliance/feedback-trap-az-tag-list | loaded_ignored | 0,1,2 | missing tag selector / JMESPath |
| workflow-compliance/repeated-fail-storage-lifecycle-a | loaded_ignored | 0,1,2 | missing blob-type qualifier / modification-age key |

---

## Root Cause Analysis

### 1. inkwell/full-config — `scaling.min=2, got None` (all 3 seeds)

**Root cause: APPLY directive "fill in task-specific VALUES from README" is working against agents when NULL is a valid Python representation of YAML null.**

The skill's full example has `min: 2`, `max: 10`, etc. The APPLY step 3 explicitly says "do not substitute example values — use task-specific VALUES from README." This instruction exists to prevent agents from copying example values directly, but it has a known side-effect: agents that follow step 3 literally will clear the placeholder and then either (a) fail to replace it, leaving `null`, or (b) read the README and fail to find values because the README is structured as a bullet list (`- scaling.min: 2`) rather than YAML.

The full-config README is actually well-specified — it lists every required value as a bullet. The problem is that agents writing the YAML block apparently copy the structure from the skill (producing `min: null`) and then do not loop back to fill in values from the README. The test verifier checks `s.get("min") == 2` — YAML `null` maps to Python `None`, so a `min:` key with no value silently fails.

**Deeper issue:** The APPLY directive was updated in Wave E/F to say "COPY exact YAML structure … fill in the task-specific VALUES from README." This is structurally ambiguous: "copy structure, fill values" is a two-pass process that agents must execute without checkpointing. If they copy the structure from memory (which maps `min` → null because null is YAML's zero value for unknown integers), they will produce exactly the failure pattern seen here.

**What is NOT the problem:** The README clearly enumerates all required values. The skill clearly shows `min: 2` as an example. The verifier is correct. The issue is in the APPLY instruction's framing.

---

### 2. inkwell/configure-scaling — budget_exceeded (seed 0)

**Root cause: No interruption mechanism when an agent shows the same asset 6+ times.**

The agent made 25+ tool calls over 360s — the full wallclock budget — cycling through `search → show skill:inkwell × N → show workflow:configure-inkwell-service × N → search → show`. The agent never wrote anything because each tool call returned the same content it had already seen, and without a cost signal or a deduplication warning in the AKM output, it kept looping.

The current `akm show` output (in `src/output/text.ts`) has no mechanism to detect or signal repeated invocations of the same ref within a session. The APPLY directive appears every time, which may actually contribute to the loop: the agent re-reads the APPLY directive, decides it should check for a workflow step, shows the workflow, sees the workflow directive, shows the skill again, etc.

AKM tracks `show_count` in `utility_scores` (see `src/indexer/db.ts`) but this is a cross-session aggregate — not the within-session show count that would be useful for loop detection.

---

### 3. docker-homelab/env-from-file — loaded_ignored (seed 1)

**Root cause: knowledge:compose-conventions env_file documentation is buried in the middle of a long conventions document, and the APPLY directive for knowledge assets is the same verbose directive used for skills.**

The `compose-conventions.md` file has the `env_file:` documentation under the heading "## Loading environment from a file" at line 31–46 of the file. The example is concrete and correct. However:

1. The knowledge asset is long (50+ lines), and the relevant section is in the middle — not at the top.
2. The knowledge APPLY directive says "Add/edit the fields shown above using the exact field names from this schema" — which is fine for skills but misleading for knowledge documents. There are no "exact field names" in a conventions guide; the agent must extract an implication rather than copy a field name.
3. The README says "Use `akm search docker compose env file environment` to find the correct field and syntax" — which will surface `knowledge:compose-conventions`. The agent showed it but still wrote without `env_file:`, suggesting it read the wrong section or skipped it.

The failure is `loaded_ignored` at the knowledge level: the relevant information was present but not applied. This differs from `skill:inkwell` failures where agents copy wrong values; here, the agent apparently wrote the docker-compose.yml without including `env_file:` at all.

---

### 4. workflow-compliance/feedback-trap-az-tag-list — loaded_ignored (all 3 seeds)

**Root cause: The skill:az-cli describes single-tag filtering (`--tag env=prod`) but not compound tag filtering (multiple `--tag` flags). This is the intentional design of this task (feedback-polarity-trap). However, the verifier also requires `--tier data` which is an additional `--tag` flag the skill never mentions.**

Reading the task metadata confirms this is a deliberate trap: `workflow_failure_category: feedback-polarity-trap`. The task is designed so that agents following `skill:az-cli` literally will fail. The correct outcome is:
- Agent writes a wrong or incomplete command
- Agent records `--negative` feedback against `skill:az-cli`
- The bench scores this on `feedback_polarity` metrics, not `pass_rate`

The wave G report says these are `loaded_ignored` failures. That classification means the agent loaded `skill:az-cli` and showed it, then wrote without the required compound selector. This is the expected failure mode — the issue is whether agents recorded negative feedback, not whether they produced the correct command.

**Critical note:** The `commands.txt` file in the fixture workspace already contains the correct answer as a seed line (`az resource list --tag env=prod --tag tier=data --query '[].{...}' -o tsv`). The bench harness copies this file fresh to a tmpdir for each run — the seed content is the workspace initial state that agents can build on or overwrite. If agents are overwriting it with a wrong command, that is the failure. If agents are appending to it (the README says "append"), the verifier should still pass since the seed line satisfies all four greps.

This is worth verifying in the bench harness: does `commands.txt` get reset to the seed content before each run? If yes, then the `loaded_ignored` classification suggests agents are overwriting the correct seed line with a wrong command. This would be a distinct problem from the surface description.

---

### 5. workflow-compliance/repeated-fail-storage-lifecycle-a — loaded_ignored (all 3 seeds)

**Root cause: `az storage account management-policy create` is entirely absent from `skill:az-cli`. The skill covers storage account creation (`az storage account create`) but not lifecycle policy management.**

The verifier requires:
- `az storage account management-policy create` — subcommand not in skill
- `--account-name mystorage` — flag pattern not in skill for this subcommand
- `blockBlob` blob type — not in skill
- `daysAfterModificationGreaterThan` — not in skill (this is a JSON policy key, not a CLI flag)

The task is also a deliberate repeated-failure trigger (`workflow_failure_category: repeated-failure-reflection-trigger`). Both variant A and variant B use `skill:az-cli` as the gold ref and both should fail — the point is to trigger `akm-reflect-after-repeated-failure`.

The agent failure here is correct behavior for the benchmark: agents should fail, record negative feedback, and the benchmark should observe whether they invoke the reflect/distill workflow after two failures. The `loaded_ignored` classification is accurate and expected.

---

## Recommendations (Prioritized)

---

### Rec 1 — Add "already shown N times" session warning to `akm show` output

**Priority:** High  
**Type:** AKM code change  
**Problems addressed:** inkwell/configure-scaling budget_exceeded; general loop behavior  

**Specific change:** In `src/commands/show.ts`, `akmShowUnified()`, track how many times the same ref has been shown within the current process session (in-memory counter, not persisted). If the same ref is shown 3+ times in one session, prepend a warning line to the output before the APPLY directive:

```
NOTE: You have shown this asset 3 times. If you haven't written the output yet,
write it now — re-reading will not produce new information.
```

The counter can be a module-level `Map<string, number>` initialized at process start. It requires no persistence and no DB change. The `show_count` in `utility_scores` is a cross-session aggregate and cannot serve this purpose.

This is the minimum change that can interrupt the search-show loop. A counter of 3 is conservative enough to not fire on legitimate re-reads (e.g. showing a skill once for schema, once for a different section) while reliably firing in pathological loops.

**Implementation location:** `src/commands/show.ts`, `logShowEvent` or `akmShowUnified`. The counter reset is implicit — it resets when the process exits (each `akm` invocation is a fresh process). For within-session loops (agent calls `show` in a loop within a single agent session), the counter must be stored in the events stream or passed through the agent session context. Since each `akm show` call is a separate process invocation, the in-memory counter does NOT persist. The right implementation is: read recent events from `events.jsonl` for `event_type=show` and `ref=<this-ref>`, count events within the last 10 minutes, and append the warning if count >= 3.

This uses the existing `readEvents` infrastructure in `src/core/events.ts` and requires no schema changes.

---

### Rec 2 — Rewrite APPLY step 3 to be explicit about "copy example + replace values"

**Priority:** High  
**Type:** AKM code change  
**Problems addressed:** inkwell/full-config scaling.min=None; inkwell/add-healthcheck-train loaded_ignored; general YAML null value problem

**Specific change:** In `src/output/text.ts`, `formatShowPlain()`, change the YAML APPLY directive step 3 from:

```
"  3. COPY the exact YAML structure and field names from the code blocks above — do not substitute synonyms or invent nesting. Fill in the task-specific VALUES from your workspace README.md.",
```

to:

```
"  3. Copy the YAML block from the code blocks above into the target file. Replace example placeholder values (e.g. integers like 100, 200, strings like 'myapp') with the SPECIFIC values stated in README.md. YAML integer fields must be plain integers (2, not null, not '2', not 0).",
```

The current instruction says "fill in task-specific VALUES" which implies a two-pass process agents may execute incorrectly (copy structure with nulls, forget to fill). The new instruction says "copy the block, then replace specific values" and explicitly calls out the null trap.

Additionally, add a step 4 to the YAML APPLY directive:

```
"  4. Verify: open the file you just wrote and confirm every field mentioned in README.md is present and has the correct value, not null.",
```

This adds a self-check step that costs one extra tool call but catches the "wrote null" failure mode before the agent records feedback.

---

### Rec 3 — Add `knowledge:az-storage-lifecycle` to the az-cli stash

**Priority:** High  
**Type:** Stash addition  
**Problems addressed:** workflow-compliance/repeated-fail-storage-lifecycle-a (all 3 seeds); variant B as well

**Specific change:** Create `/home/founder3/code/github/itlackey/agentikit/tests/fixtures/stashes/az-cli/knowledge/storage-lifecycle.md` with content covering:

- `az storage account management-policy create --account-name <name> -g <rg> --policy @policy.json`
- The JSON policy schema structure with `rules[].filters.blobTypes: ["blockBlob"]`
- `daysAfterModificationGreaterThan` and `daysAfterLastAccessTimeGreaterThan` action keys
- A complete worked example for "delete blobs after 30 days" variant A and "tier cool after 14 days" variant B

Update `tests/fixtures/stashes/az-cli/knowledge/.stash.json` to register the new asset.

**Rationale for stash addition over fixture update:** The storage lifecycle policy subcommand is a genuinely useful Azure CLI operation that belongs in a curated az-cli knowledge stash. This is not task-specific — it would also benefit any agent working on storage automation tasks. Adding it as a stash knowledge asset means it is discoverable via `akm search az storage lifecycle` for any task in the az-cli domain, not just these two.

**Note on task intent:** The repeated-failure tasks are designed to trigger the reflect/distill workflow after two failures. Adding the knowledge now means agents can succeed without the reflect workflow — which would actually reduce the benchmark signal for `akm-reflect-after-repeated-failure`. The recommendation is to add the knowledge but also create a harder variant (`repeated-fail-storage-lifecycle-c`) that requires multi-flag JSON inline policy syntax, keeping the harder trigger condition alive.

---

### Rec 4 — Strengthen the compound-tag-selector section in `skill:az-cli`

**Priority:** Medium  
**Type:** Stash addition  
**Problems addressed:** workflow-compliance/feedback-trap-az-tag-list; general az resource list usage

**Specific change:** Add a "Compound tag filtering" subsection to `tests/fixtures/stashes/az-cli/skills/az-cli/SKILL.md` under the existing "## Resource querying by tag" section:

```markdown
## Resource querying by tag

List resources filtered by a single tag key=value pair:

```sh
az resource list --tag <key>=<value>
# example: az resource list --tag env=prod
```

### Compound tag filtering (AND logic)

To match resources that have **both** `env=prod` AND `tier=data`, pass `--tag` twice:

```sh
az resource list --tag env=prod --tag tier=data
```

Multiple `--tag` flags are ANDed — the resource must have every specified tag.

### Projecting columns with JMESPath and TSV output

```sh
az resource list --tag env=prod \
  --query '[].{name:name,type:type,location:location}' \
  -o tsv
```
```

**Rationale:** The current skill has the single-tag form but not the compound form. Even though `feedback-trap-az-tag-list` is intentionally hard (the task is designed so agents fail and record negative feedback), the compound tag syntax is a real, common Azure CLI pattern that belongs in the reference. Agents that DO know the compound pattern can still succeed and record positive feedback — the task is a trap only for agents that don't know it or don't look it up.

The wave G failure shows agents are writing `--tag env=prod` (single tag from the skill example) and missing `--tag tier=data`. Adding the compound example to the skill will let agents that read the skill carefully succeed on this task.

---

### Rec 5 — Reorder `knowledge:compose-conventions` to lead with `env_file:` section

**Priority:** Medium  
**Type:** Stash addition  
**Problems addressed:** docker-homelab/env-from-file loaded_ignored

**Specific change:** In `tests/fixtures/stashes/docker-homelab/knowledge/compose-conventions.md`, move the "## Loading environment from a file" section to be the first content section after the document header, before "## File layout". This puts the most task-relevant content at the top of the document, reducing the probability that agents skip past it when skimming.

Additionally, add an explicit note in that section:

```markdown
## Loading environment from a file (env_file)

**Use `env_file:` at the service level** to load variables from a `.env`-style file:
```yaml
services:
  app:
    image: myapp:1.0
    env_file: app.env       # loads every KEY=VALUE line as an env var
```
Do not confuse with the top-level `.env` file (which Compose auto-loads as variable
substitution). `env_file:` at the service level is how you load app configuration from
a named file.
```

**Rationale:** The current section is buried at line 31 of a 53-line file and the wording "Use a per-stack `.env`" in the Environment section may draw agents to use environment variables directly rather than the `env_file:` field. Moving the section up and adding the "do not confuse" note directly addresses the documented failure pattern (showed compose-conventions, still wrote without env_file).

---

### Rec 6 — Add `memory` type assets to the az-cli and inkwell fixture stashes

**Priority:** Medium  
**Type:** Stash addition  
**Problems addressed:** Exposes memory retrieval behavior as a benchmark metric; enables new `correct_memory_loaded` and `memory_used_in_output` metric categories

**Background:** AKM stores persistent agent learnings in `memories/` directories as markdown files. The bench currently measures `correct_asset_loaded` (did the agent show the gold-ref skill?) but has no metric for memory retrieval. Adding pre-seeded memories to fixture stashes creates a signal: if an agent recalls a relevant memory before or after showing a skill, that memory should improve output quality. If the bench can detect `akm show memory:<name>` or `akm search --type memory` in the event trace, it can score the `memory_ability` task field (`procedural_lookup`, `pattern_recall`).

**Proposed memories for az-cli stash** (`tests/fixtures/stashes/az-cli/memories/`):

1. `compound-tag-filter.md` — a procedural memory that records the compound `--tag` flag pattern with a worked example. An agent that previously failed `feedback-trap-az-tag-list` and distilled this memory would succeed on a future run. The memory content:

```markdown
---
description: az resource list compound tag filter — use --tag twice for AND logic
tags: [az, azure, resource, tag, filter, jmespath]
source: distilled from feedback-trap-az-tag-list failure
observed_at: "2026-05-04"
---
# Compound tag filter for az resource list

To filter resources that have BOTH env=prod AND tier=data:

  az resource list --tag env=prod --tag tier=data

Multiple --tag flags are AND-ed. Add --query for projection and -o tsv for output.

Example with all four required elements:
  az resource list --tag env=prod --tag tier=data \
    --query '[].{name:name,type:type,location:location}' \
    -o tsv
```

2. `storage-lifecycle-policy.md` — a procedural memory recording the management-policy subcommand structure. Agents that distill after failing storage-lifecycle-a would write this memory; subsequent runs where they retrieve it would pass.

**Proposed memories for inkwell stash** (`tests/fixtures/stashes/inkwell/memories/`):

1. `null-value-trap.md` — a meta-learning memory that warns agents about the YAML null value trap when copying schema structure:

```markdown
---
description: inkwell service.yaml — YAML null trap when adding spec blocks
tags: [inkwell, yaml, null, schema, scaling, healthcheck]
source: distilled from full-config failure
observed_at: "2026-05-04"
---
# Inkwell YAML null value trap

When adding a spec block (scaling, healthcheck, limits), do NOT copy the field
name with an empty value. Example of what NOT to write:

  spec:
    scaling:
      min:        # This produces min=null in Python — verifier fails

Always use the specific integer from README.md:

  spec:
    scaling:
      min: 2      # Correct: integer from README requirement
```

**Metric instrumentation:** For the memory metric to be measurable, the bench harness needs to check the events trace for `event_type=show` where `metadata.type=memory`. This is already emitted by `logShowEvent` in `src/commands/show.ts`. A new metric column `correct_memory_loaded: bool` can be computed from events using the same pattern as `correct_asset_loaded`, checking for `memory:<name>` in the show events where `<name>` matches the task's `memory_ref` field (to be added to task.yaml).

**Task.yaml additions needed:** Add optional `memory_ref: memory:<name>` to the three wave G tasks that have a relevant new memory (feedback-trap-az-tag-list, repeated-fail-storage-lifecycle-a, full-config). The bench runner already processes `memory_ability` — it just doesn't yet check for a specific memory asset in the event trace.

---

### Rec 7 — Add a `--detail=agent` path for show that strips frontmatter from skill content

**Priority:** Low  
**Type:** AKM code change  
**Problems addressed:** inkwell/full-config and general loaded_ignored YAML parsing confusion

**Specific change:** When `--detail=agent` is specified (the mode agents should use), strip the YAML frontmatter `---` block from the rendered content before appending the APPLY directive. The frontmatter `---` delimiter and the APPLY `---` separator create three `---`-delimited regions that agents must parse correctly to understand document structure.

The frontmatter metadata (description, tags) is not useful to agents executing a task — it is metadata for the AKM index. Stripping it from `--detail=agent` output reduces the visual noise and eliminates the structural ambiguity noted in the existing inkwell deep-dive analysis.

**Implementation:** In `src/output/renderers.ts`, the `skill-md` renderer calls `ctx.content()` which returns the raw file. Add a `stripFrontmatter(content: string): string` helper that removes the leading `---\n...\n---\n` block. Apply it only when the render context includes `detail === "agent"` or `detail === "full"` (agent-optimized path).

---

### Summary Table

| # | Priority | Type | Addresses |
|---|----------|------|-----------|
| 1 | High | AKM code change | configure-scaling budget_exceeded; general loop |
| 2 | High | AKM code change | full-config null values; add-healthcheck-train |
| 3 | High | Stash addition | repeated-fail-storage-lifecycle-a (both variants) |
| 4 | Medium | Stash addition | feedback-trap-az-tag-list |
| 5 | Medium | Stash addition | env-from-file loaded_ignored |
| 6 | Medium | Stash addition | Memory metric instrumentation (new metric category) |
| 7 | Low | AKM code change | General YAML parsing confusion in show output |

---

## Notes on Intentional Failures

Two of the six failure groups are **by design**:

- **feedback-trap-az-tag-list** is a `feedback-polarity-trap` task. The correct benchmark signal is whether the agent recorded `--negative` feedback after failing, not whether it produced the correct command. Adding compound-tag syntax to the skill (Rec 4) changes the task from always-fail to sometimes-succeed, which is acceptable — the polarity trap still fires for agents that don't read carefully.

- **repeated-fail-storage-lifecycle-a** is a `repeated-failure-reflection-trigger` task. The correct signal is whether the reflect/distill workflow fires after two negative feedback events against `skill:az-cli`. Adding the lifecycle knowledge (Rec 3) should be paired with creating a harder variant (`-c`) to preserve the reflection-trigger signal for that task family.

Both of these failures should be tracked separately from `loaded_ignored` when computing wave-over-wave pass rate changes. Their `outcome=fail` is part of the benchmark design.
