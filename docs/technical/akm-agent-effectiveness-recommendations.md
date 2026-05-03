# AKM Agent Effectiveness Recommendations

## Executive Summary

The 2026-05-03 Qwen 9B baseline (85 runs, 17 tasks, 5 seeds) reveals that the dominant failure pattern is not discovery failure but compliance failure: agents search, load the correct asset, and then ignore its content when writing the output file. The single highest-impact opportunity is making `akm search` output explicitly prescribe the next action (`akm show <top-ref>`) and making `akm show` output reinforce that the content must be applied before writing. A secondary cluster of failures on workflow and conflict-resolution tasks points to missing search-signal differentiation and an absent system-prompt hook for the `akm workflow` command path.

## Evidence Base

- **Baseline JSON**: `tests/bench/baseline-qwen9b-2026-05-03.json` — 85 akm-arm runs, 17 tasks, 5 seeds, model `shredder/qwen/qwen3.5-9b`, commit `32c70aa`.
- **Overall pass rate**: 68.2% (58/85). Established tasks (pre-2026-05-03): 96%. New hard tasks: 0–60%.
- **Failure modes**: 25/27 failures labelled `search_no_gold`. However, 24/25 of those runs have `correct_asset_loaded=True` (verified directly from the `runs[]` array trajectory fields). The label is a classifier artifact, not a true description of agent behavior.
- **Trajectory**: `correct_asset_loaded` is True in 78/85 runs (91.8%). `feedback_recorded` is True in only 14/85 runs (16.5%), falling to 0% for drillbit (all 5 tasks), inkwell/set-rate-limit, inkwell/workflow-configure-scaling, and opencode/select-correct-skill.
- **Workflow compliance**: `strict_pass_rate` is 0.3% (1 run out of 320 applicable). Every spec is partial at best. `akm-lookup-before-edit` scores 0.758, `akm-workflow-followed` scores 0.757. 496 violations recorded across 320 applicable checks.
- **Review documents**: `docs/reviews/bench-e2e-review-2026-05-02.md`, `docs/reviews/akm-e2e-review-2026-05-02.md`, `docs/reviews/akm-e2e-review-2026-05-02-issues.md`.
- **Source files read**: `src/output/text.ts`, `src/output/shapes.ts`, `src/output/context.ts`, `src/commands/search.ts`, `src/commands/show.ts`, `src/core/asset-spec.ts`, `src/workflows/renderer.ts`.
- **Fixture files read**: inkwell SKILL.md, drillbit SKILL.md, configure-inkwell-service workflow, task READMEs (configure-scaling, workflow-configure-scaling, full-config, select-correct-skill).

---

## The Critical Paradox: `search_no_gold` Labels Are Misleading

The failure mode classifier (`classifyFailureMode`) operates by scanning `verifierStdout` for numbered result lists from `akm search` and checking whether the gold ref appears in those lines. It cannot detect `akm show` calls reliably because those depend on the verifier echoing the exact invocation string. The structured events path (`events.jsonl`) now records `show` events, but the classifier does not read from it.

The result: 24/25 `search_no_gold` failures actually have `correct_asset_loaded=True`. The agents are finding and loading the gold asset. The real failure mode across most of the 27 failing runs is closer to `loaded_ignored` — the agent read `skill:inkwell` or `skill:opencode` content but then wrote a YAML block from its training-data memory instead of applying what the asset says. This distinction matters: fixing search ranking does nothing to fix a `loaded_ignored` failure.

---

## Recommendations

### Priority 1 — Critical (directly causes the loaded_ignored failures)

#### REC-01: Add an explicit "Apply this content now" instruction to the `akm show` text output

**Problem**: After an agent runs `akm show skill:inkwell`, the output presents the skill content but gives no directive to apply it before writing the workspace file. The agent reads the content, notes the field names, then writes from its parametric memory anyway — partially or incorrectly.

**Evidence**: All 5 inkwell/full-config failures have `correct_asset_loaded=True` and `failure_mode=search_no_gold` (a classifier artifact). The agent loaded `skill:inkwell` in every run and still produced incorrect multi-block YAML. The skill doc itself is accurate and complete (it covers `scaling`, `healthcheck`, and `limits` with exact field names and examples). The content is not the problem; the agent's treatment of it is.

**Proposed change**: At the end of `formatShowPlain` in `src/output/text.ts`, append a separator line and a terse directive that names the asset and tells the agent what to do with it. For `skill` and `knowledge` types:

```
---
APPLY: Use only the field names, values, and formats shown above. Do not substitute
your own approximations. Refer back to this output as you write.
```

For `workflow` types, append:

```
---
NEXT: Advance this workflow run with `akm workflow complete <run-id> --status completed`.
Do not write workspace files without first completing the current step.
```

The directive should appear after the content block in every `akm show` response regardless of detail level, because the agent will encounter it regardless of how it invoked the command.

**Expected impact**: Targets the loaded_ignored pattern, which accounts for an estimated 15–18 of the 27 failures (all inkwell tasks with `correct_asset_loaded=True` and wrong field values). Estimated +15–20pp on the inkwell task cluster.

**Effort**: Low. Single function in `src/output/text.ts`.

---

#### REC-02: Emit `akm show <top-ref>` as the last line of every `akm search` result

**Problem**: `formatSearchPlain` in `src/output/text.ts` prints hit metadata then stops. Nothing in the output tells the agent that the next required step is `akm show <ref>`. The agent sees a result list and moves on to write the file, skipping the show step entirely in many runs.

**Evidence**: The `akm-lookup-before-edit` workflow spec requires `akm_search` before `first_workspace_write` AND (implicitly through `akm-correct-asset-use`) requires that the shown asset is correct. The spec's compliance score is 0.758 — below the others — which reflects the frequency with which agents skip the show step. The AGENTS.md system prompt at `tests/fixtures/bench/tasks/docker-homelab/bridge-network/workspace/AGENTS.md` tells agents to run step 2 (`akm show <ref>`) but many inkwell tasks have no task-level AGENTS.md at all (confirmed: `find tests/fixtures/bench/tasks/inkwell -name AGENTS.md` returns nothing).

**Proposed change**: When `hits.length >= 1`, append a single action line to the `formatSearchPlain` output:

```
Next: akm show <top-ref>
```

where `<top-ref>` is `hits[0].ref` (the highest-scoring stash hit). For the `brief` detail level, `ref` is currently stripped by `shapeSearchHit` (`src/output/shapes.ts:455`). Either promote `ref` to the `brief` shape for stash hits, or read it from the raw result before shaping. The action line should not be conditional on detail level — it must appear in the default (`brief`) output because that is what agents see.

**Expected impact**: Removes the step-skip gap for agents that read the search output and execute the suggested command. Estimated +8–12pp across inkwell tasks and distractor-docker-port-publish.

**Effort**: Low. Two files: `src/output/text.ts` (append line), `src/output/shapes.ts` (promote `ref` to `brief`).

---

#### REC-03: Promote `ref` into the `brief` search hit shape unconditionally

**Problem**: `shapeSearchHit` in `src/output/shapes.ts` strips `ref` from stash hits at detail level `brief` (`return pickFields(hit, ["type", "name", "action", "estimatedTokens"])`). The default detail level (`resolveOutputMode` in `src/output/context.ts:89`) is `brief`. Agents running `akm search` without flags never see the ref they need to run `akm show`.

**Evidence**: The `shapeSearchHitForAgent` function (used when `--detail agent` or `--for-agent`) correctly includes `ref`. But agents in the bench run do not use `--detail agent` — they invoke bare `akm search "<query>"`. The `action` field says `akm show <ref>` but the literal ref string it contains is the correct ref for `akm show`. This means the `action` field already carries the ref — an agent could parse it — but that is fragile and invisible in the formatted plain-text output, which shows `action: akm show skill:inkwell` as a separate field, not as the closing instruction.

**Proposed change**: Add `ref` to the `brief` stash hit pick list: `pickFields(hit, ["type", "name", "ref", "action", "estimatedTokens"])`. This is a one-line change. The `ref` is already present in the internal hit object; the pick list is the only barrier.

**Expected impact**: Enables REC-02 to work without additional logic (the top-ref value is available in the output shape). Independently, any agent that writes its own follow-up logic from search output now has the ref available. No measurable direct pp lift, but it unblocks REC-02 and the `shapeSearchHitForAgent` path becomes consistent with the default path.

**Effort**: Trivial. One line in `src/output/shapes.ts`.

---

#### REC-04: Add AGENTS.md to every inkwell task workspace

**Problem**: The docker-homelab tasks have per-workspace AGENTS.md files that explicitly tell agents to run `akm search`, then `akm show <ref>`, then `akm feedback`. The inkwell tasks have no such file. The only instruction in inkwell task READMEs is a one-line hint like `Use akm show skill:inkwell for exact field names`. That hint is a passive suggestion, not a directive.

**Evidence**: `find tests/fixtures/bench/tasks/inkwell -name AGENTS.md` returns nothing. The docker-homelab AGENTS.md says: "You MUST search it before attempting the task" and lists the 4-step sequence explicitly. Drillbit tasks all pass at 100% — they have the same schema-conformance challenge as inkwell (exact field names and formats) but the drillbit stash benefits from more distinctive keyword matching (CLI flags vs YAML field names). Inkwell's README-only hint is easier for the model to treat as optional guidance rather than a required protocol.

**Proposed change**: Create `tests/fixtures/bench/tasks/inkwell/*/workspace/AGENTS.md` for each of the 6 inkwell eval tasks. Content:

```markdown
## Using AKM (when AKM_STASH_DIR is set)

If you see AKM_STASH_DIR in your environment, the inkwell schema stash is available.
You MUST follow these steps:

1. `akm search inkwell service configuration` — find the schema skill
2. `akm show skill:inkwell` — read the full schema (do not skip this step)
3. Apply the exact field names and value types from the schema output — do not approximate
4. `akm feedback skill:inkwell --positive` or `--negative` after writing service.yaml

The schema defines exact integer types, exact metric names (e.g. `rps` not `requests_per_second`),
and exact field names (e.g. `burst` not `burstCapacity`). Your training data may differ.
```

**Expected impact**: Aligns inkwell with the docker-homelab protocol that produces 100% pass rates. The directive text addresses the specific failure pattern: agents use approximate field names from training memory. Estimated +20–25pp on inkwell tasks (configure-scaling, set-rate-limit, new-service, add-healthcheck, cpu-scaling).

**Effort**: Low. 6 new AGENTS.md files in fixture directories.

---

### Priority 2 — High (workflow compliance and conflict resolution)

#### REC-05: Fix the `akm workflow` invocation pathway for the workflow-configure-scaling task

**Problem**: `inkwell/workflow-configure-scaling` passes 0/5 seeds. The task README says to use `akm workflow next 'workflow:configure-inkwell-service'`. All 5 seeds show `failure_mode=search_no_gold` with `correct_asset_loaded=True` (3 seeds load `skill:inkwell`, 1 seed loads both `skill:inkwell` and `workflow:configure-inkwell-service`). The model reads the README and then edits YAML directly instead of invoking `akm workflow next`.

**Evidence**: Only 1 of 5 seeds (seed 3) loaded `workflow:configure-inkwell-service`. The README specifies `akm workflow next 'workflow:configure-inkwell-service'` as the required path. The workflow search action field says `Resume the active run or start a new run with 'akm workflow next 'workflow:configure-inkwell-service''` — a correct and complete action hint, but it only appears in `akm show workflow:configure-inkwell-service` output, which requires the agent to first search for and show the workflow asset rather than the skill.

The task README itself is too terse. It says "Use `akm workflow next 'workflow:configure-inkwell-service'` to follow the step-by-step process" but gives no reason why this is required over direct YAML editing.

**Proposed change** (two parts):

1. Strengthen the task README to explain consequences:

```markdown
# Task: configure autoscaling via workflow

Edit `service.yaml` to configure autoscaling on the inkwell service.

Requirements:
- `min: 2`, `max: 20`, `metric: rps`, `target: 100`

REQUIRED: Use the workflow — do not edit service.yaml directly without first running:
  `akm workflow next 'workflow:configure-inkwell-service'`

The workflow provides the correct schema reference and verification steps.
Editing YAML directly without the workflow will fail verification.
```

2. Add an AGENTS.md to `tests/fixtures/bench/tasks/inkwell/workflow-configure-scaling/workspace/` that mirrors the docker-homelab pattern but names the workflow command explicitly.

**Expected impact**: Targets 5 failures directly. Even partial improvement (2–3 seeds starting the workflow) would produce +4–6pp on this task. Full compliance requires the model to chain: search → show workflow → follow steps. Estimated +4–6pp.

**Effort**: Low. README edit + 1 new AGENTS.md file.

---

#### REC-06: Add search-signal keywords to the `skill:opencode` asset to differentiate it from docker/terraform distractors

**Problem**: `opencode/select-correct-skill` passes 0/5 seeds despite `correct_asset_loaded=True` in all 5 runs. The agent loads `skill:opencode` every time but still fails verification. Analysis: the task README says the workspace is an opencode project and asks the agent to find the opencode skill, not docker or other skills. The task fails because the verification check requires the agent to write `AGENTS.md` content that references opencode-specific guidance, but the agent either writes generic akm-search guidance or docker-specific guidance.

The `skill:opencode` description is "Run coding tasks with the opencode agent CLI". The `skill:docker` description is "Build and run Docker containers and compose stacks". For a query like "akm search opencode configuration", the opencode skill should rank first unambiguously, but the AGENTS.md content the agent writes draws from its memory rather than the loaded skill content.

**Evidence**: All 5 failing runs have `correct_asset_loaded=True` with `assets_loaded=['skill:opencode']`. This is a `loaded_ignored` failure (the classifier labels it `search_no_gold` because the numbered result list in verifier stdout does not include the ref, not because the agent failed to load it). The fix is to make the skill content more directive about what to write — it currently describes what opencode does, not what an AGENTS.md entry for opencode should contain.

**Proposed change**: Add a section to `tests/fixtures/stashes/multi-domain/skills/opencode/SKILL.md` (or wherever it lives) with an explicit "AGENTS.md snippet" block:

```markdown
## Recommended AGENTS.md entry

When configuring an opencode project, add this to AGENTS.md:

```markdown
## Using AKM with opencode

Search the akm stash before each task:
1. `akm search "<query>"` — find the relevant skill or command
2. `akm show <ref>` — read the full asset
3. Apply the guidance, then `akm feedback <ref> --positive|--negative`
```
```

This gives the agent concrete copy-pasteable content to put in AGENTS.md, matching what the verifier checks for.

**Expected impact**: Targets all 5 opencode/select-correct-skill failures. Estimated +6pp (5 tasks at 0% → 60–80%).

**Effort**: Low. One SKILL.md edit.

---

#### REC-07: Fix the failure mode classifier to use `events.jsonl` data instead of verifier stdout scraping

**Problem**: `classifyFailureMode` in `tests/bench/metrics.ts` determines failure labels by regex-scanning `verifierStdout` for numbered result lists containing the gold ref. This produces incorrect labels: 24/25 `search_no_gold` failures actually have `correct_asset_loaded=True`, meaning the agent loaded the gold asset (detected via `events.jsonl`) but the classifier didn't see the gold ref in the numbered list. The real failure mode in those 24 cases is `loaded_ignored` or `followed_wrong`.

**Evidence**: 24 `search_no_gold` failures with `correct_asset_loaded=True` confirmed by direct run-array analysis. The `classifyFailureMode` function receives a `RunResult` that includes `trajectory.correctAssetLoaded`. The classifier does not use this field. If `correctAssetLoaded=True` and the run failed, the agent loaded the gold asset and then produced wrong output — this is `loaded_ignored` or `followed_wrong`, not `search_no_gold`.

**Proposed change**: In `classifyFailureMode`, add a short-circuit: if `run.trajectory.correctAssetLoaded === true` and `outcome === 'fail'`, classify as `loaded_ignored` rather than `search_no_gold` (or `followed_wrong` if the verifier output indicates the field values were wrong but the structure was right). The stdout-based `search_no_gold` path should only fire when `correctAssetLoaded` is not true. This change makes the failure taxonomy actionable: teams working on "search ranking" will stop getting false signals, while teams working on "content clarity" and "directive framing" get the correct signal.

**Expected impact**: Zero direct pp lift (this is measurement, not product), but correctly identifies that content/directive improvements (REC-01, REC-04) address 24/25 failures, not search ranking. Changes the evolve track's improvement targets.

**Effort**: Low. 5–10 line change in `tests/bench/metrics.ts`.

---

#### REC-08: Make the `akm search` output in workflow-asset hits explicitly say "run this workflow, not edit YAML directly"

**Problem**: When `akm search` returns a `workflow` type asset, the `action` field says `Resume the active run or start a new run with 'akm workflow next '<ref>''`. This is correct but it appears as one field among several (type, name, description, action) in the formatted text output. An agent scanning search results for "what do I do next" sees the action string but can choose to ignore it in favor of direct YAML editing.

**Evidence**: `buildWorkflowAction` in `src/workflows/renderer.ts:23` generates the action string. In `formatSearchPlain`, the action field is formatted as `  action: <string>`. It has no visual weight compared to the description. The workflow task README says "Use `akm workflow next`" but the model overrides this with direct editing.

**Proposed change**: For workflow-type hits in `formatSearchPlain`, elevate the action rendering:

Instead of:
```
workflow: configure-inkwell-service
  action: Resume the active run or start a new run with `akm workflow next 'workflow:configure-inkwell-service'`.
```

Render as:
```
workflow: configure-inkwell-service
  WORKFLOW: Do NOT edit files directly. Run: akm workflow next 'workflow:configure-inkwell-service'
```

The uppercase `WORKFLOW:` prefix and `Do NOT edit files directly` constraint make the action hint behaviorally explicit. This affects the text output path only (plain format).

**Expected impact**: Increases the probability that an agent routes through the workflow path instead of direct editing. Combined with REC-05, estimated +4–6pp on workflow-configure-scaling.

**Effort**: Low. Conditional branch in `formatSearchPlain` based on hit type.

---

#### REC-09: Raise feedback recording from 16.5% to a target of 50%+ by adding a persistent post-task reminder

**Problem**: `feedback_recorded=True` in only 14/85 runs (16.5%). The AGENTS.md system prompt includes `akm feedback <ref> --positive|--negative` as step 4 in the usage sequence. Most agents complete steps 1–3 but skip step 4. Drillbit tasks record 0% feedback despite 100% pass rates.

**Evidence**: Drillbit: 0/25 runs with `feedback_recorded=True`. inkwell: 9/30 runs (30%). opencode: 2/10 runs (20%). workflow-compliance: 3/10 runs (30%). The drillbit 0% rate despite 100% task success is particularly clear evidence that the feedback step is invisible to the model — it succeeds, considers the task done, and stops.

**Proposed change**: Add a reminder at the end of `formatShowPlain` for `skill` and `knowledge` types — the asset types that agents most commonly load and apply:

```
---
REQUIRED FINAL STEP: After applying this content, run:
  akm feedback <this-ref> --positive   (if it helped)
  akm feedback <this-ref> --negative   (if it was wrong or unhelpful)
```

where `<this-ref>` is replaced with the actual ref string (e.g., `skill:inkwell`). This means every `akm show skill:inkwell` output ends with an explicit, specific, non-optional-sounding feedback reminder. Additionally, add the same reminder to the `akm-feedback-after-use` workflow spec violation message so the bench report makes the gap visible.

**Expected impact**: Estimated feedback rate improvement from 16.5% to 40–60%. The learning loop effectiveness compounds over time: higher feedback rates improve search ranking quality for future runs.

**Effort**: Low. One change in `formatShowPlain` (`src/output/text.ts`), one fixture edit for drillbit/inkwell AGENTS.md files.

---

### Priority 3 — Medium (polish, precision, and measurement integrity)

#### REC-10: Fix the `akm-workflow-followed` spec domain filter to cover `inkwell` tasks

**Problem**: `akm-workflow-followed.yaml` has `task_domains: ["workflow-compliance", "inkwell"]` (already updated per verification status in `bench-e2e-review-2026-05-02.md`), but the only workflow-asset task (`inkwell/workflow-configure-scaling`) is in the `inkwell` domain. If the domain filter only lists `workflow-compliance`, the spec never fires against the only task that exercises `akm workflow start/next/complete`.

**Evidence**: bench-e2e-review S4 confirms this gap. The verification status shows it was partially addressed. Confirm: `cat tests/fixtures/bench/workflows/akm-workflow-followed.yaml | grep task_domains` — if it still only says `["workflow-compliance"]`, update it.

**Proposed change**: `task_domains: ["workflow-compliance", "inkwell"]`. One-line YAML edit.

**Expected impact**: Makes the `akm-workflow-followed` spec fire against the 5 workflow-configure-scaling runs, producing 5 additional compliance data points. No direct pp lift.

**Effort**: Trivial. One-line YAML edit if not already done.

---

#### REC-11: Add `akm_keywords` to the inkwell task YAML definitions to improve search ranking

**Problem**: The inkwell task YAML files define the gold ref as `skill:inkwell` but if they have sparse or generic `akm_keywords`, the FTS5 scoring cannot boost the gold asset when the agent queries on task-specific terms. The `configure-scaling` task's README says to search for "inkwell service configuration" but the skill's tags are `inkwell`, `inkwell/v2`, `service-configuration`, `scaling`, `healthcheck`, `limits`. The tag set is good but may not match agent query terms for `new-service` or `set-rate-limit` tasks.

**Evidence**: `tests/bench/baseline-qwen9b-2026-05-03.json` `perAsset` shows the loaded asset but not the query that found it. The `inkwell/new-service` task passes only 40% (2/5 seeds), and 3 seeds load `skill:inkwell` yet still fail — the ranking is not the issue, but the query may be driving the agent to search with terms like "inkwell new service" that do not match "rate" or "limit" well.

**Proposed change**: Add `akm_keywords` to each inkwell task's `task.yaml`:
- `inkwell/new-service`: `akm_keywords: ["inkwell", "service", "yaml", "apiVersion", "kind"]`
- `inkwell/set-rate-limit`: `akm_keywords: ["inkwell", "limits", "rps", "burst", "rate"]`
- `inkwell/configure-scaling`: `akm_keywords: ["inkwell", "scaling", "min", "max", "metric", "rps"]`

**Expected impact**: Improves FTS5 ranking precision for the 3 currently-failing inkwell tasks. Estimated +4–6pp.

**Effort**: Low. 3 YAML edits.

---

#### REC-12: Separate `full-config` into two subtasks or reduce required blocks to two

**Problem**: `inkwell/full-config` requires writing 3 distinct YAML blocks simultaneously (`scaling`, `healthcheck`, `limits`). It passes 0/5 seeds. The project memory note (`project_bench_hard_tasks_2026_05_03.md`) explicitly states: "Beyond Qwen 9B's reliable simultaneous multi-block output. Either simplify to two blocks, or run evolve to improve the stash guidance."

**Evidence**: 5/5 seeds fail, all with `correct_asset_loaded=True`. The skill doc covers all 3 blocks correctly. The failure is model capacity for simultaneous multi-block output, not knowledge retrieval. No AKM improvement can fix this for a 9B model without reducing task complexity.

**Proposed change**: Split `inkwell/full-config` into:
- `inkwell/full-config-a` — scaling + healthcheck (2 blocks)
- `inkwell/full-config-b` — all 3 blocks, labelled `difficulty: hard` and excluded from the established-task average

Alternatively, change the task to require only scaling + healthcheck and relabel it `inkwell/two-block-config`.

**Expected impact**: Allows the established-task baseline to include a 2-block config task at >60% rather than reporting 0% for a task that tests model capacity rather than AKM effectiveness. No effect on the 3-block version's pass rate.

**Effort**: Low. New task.yaml + README + verifier changes.

---

#### REC-13: Add `loaded_ignored` and `followed_wrong` failure modes with trajectory-aware classification

**Problem**: The existing failure taxonomy (`no_search`, `search_no_gold`, `search_low_rank`, `loaded_wrong`, `loaded_ignored`, `followed_wrong`, `unrelated_bug`) is complete on paper, but the classifier does not use `trajectory.correctAssetLoaded` to distinguish `search_no_gold` from `loaded_ignored`. As a result, 24 `loaded_ignored` failures are reported as `search_no_gold`, driving teams toward search improvements that will not fix the actual problem.

**Evidence**: 24/25 `search_no_gold` failures have `correct_asset_loaded=True`. The classifier currently ignores `RunResult.trajectory.correctAssetLoaded`. This is the same issue as REC-07 but deserves a separate recommendation because it requires extending the failure mode test suite as well as the classifier.

**Proposed change**: Update `classifyFailureMode` to consult `run.trajectory.correctAssetLoaded`:
1. If `correctAssetLoaded === true` and outcome is fail: return `loaded_ignored` (or `followed_wrong` if the verifier stdout contains "pattern mismatch" / field-value error indicators).
2. Only fall through to the stdout-based `search_no_gold` path when `correctAssetLoaded` is false or null.

Update `tests/bench/failure-modes.test.ts` with test cases for this path. Update `aggregateFailureModes` to include the two previously-missing modes in the output.

**Expected impact**: Measurement improvement only; redirects improvement effort to the correct causes. Combined with REC-07, this change would reclassify 24 failures correctly.

**Effort**: Medium. `metrics.ts` classifier update + test additions.

---

#### REC-14: Emit the gold ref in `akm show` output footer for workflow-type assets

**Problem**: When `akm show workflow:configure-inkwell-service` runs, the output shows the workflow steps but does not remind the agent of the exact command to invoke the next step. The steps are listed as titles, but the run-management commands (`akm workflow start`, `akm workflow next`, `akm workflow complete`) are mentioned nowhere in the plain-text output — they only appear in the action field of the search hit.

**Evidence**: `formatShowPlain` in `src/output/text.ts:660–682` renders steps as `1. title [id]`. The footer is blank for workflow type assets. In the one seed (seed 3) that loaded `workflow:configure-inkwell-service`, the agent still failed — it did not know how to advance the workflow after reading its content.

**Proposed change**: For workflow type in `formatShowPlain`, append after steps:

```
---
NEXT STEP: Start or resume this workflow with:
  akm workflow next 'workflow:<name>'

Then after each step: akm workflow complete <run-id> --status completed
```

**Expected impact**: Combined with REC-05 and REC-08, makes the workflow execution path self-documenting. Estimated +2–4pp on workflow-configure-scaling.

**Effort**: Low. Conditional append in `formatShowPlain`.

---

#### REC-15: Add `akm search` / `akm show` event types as named members of the `EventType` union

**Problem**: `src/core/events.ts` `EventType` union does not include `"search"` or `"show"` as named members. These events are emitted via `appendEvent` (fixed in the bench-e2e-review) and fall through to the `| string` catch-all. Future callers that check `event.eventType === "search"` will work correctly, but IDE autocompletion, type narrowing, and static analysis will not catch typos.

**Evidence**: bench-e2e-review-2026-05-02.md N2: "Adding them as named members would harden the type contract, prevent typos in callers, and make it clear to future readers that these are first-class event types."

**Proposed change**: Add `"search"` and `"show"` to the `EventType` union in `src/core/events.ts`. One-line change.

**Expected impact**: No pp lift. Prevents future measurement regressions.

**Effort**: Trivial.

---

## Implementation Order

The three changes to do first, in order:

**1. REC-04 (Add AGENTS.md to inkwell task workspaces)** — highest direct pp impact for the least code change. This is a fixture edit, not a source change. It brings inkwell tasks in line with the docker-homelab tasks that produce 100% pass rates. Do this first because it validates whether the AGENTS.md protocol is the primary driver of drillbit's 100% rate or whether there is another factor.

**2. REC-02 + REC-03 (Add "Next: akm show <top-ref>" to search output, promote ref to brief shape)** — these two changes are coupled and together address the step-skip gap between search and show. They are source changes with no risk of regressions on existing behavior (they add a line, not remove anything). Run the bench immediately after landing these to get the first post-intervention data point.

**3. REC-01 (Add "APPLY:" directive to akm show plain output)** — closes the loop between the agent loading a skill and actually applying its content. Pairs with REC-02 to make the full chain explicit: search → "Next: akm show <ref>" → show → "APPLY: use only these field names" → write → feedback. This addresses the loaded_ignored pattern that accounts for 24 of the 27 failures.

After these three, the expected pass rate on inkwell tasks should rise from the current 60% average to 80%+. The second run will confirm whether the remaining failures are field-level errors (suggesting the skill content needs richer examples) or model capacity issues (suggesting task recalibration per REC-12).
