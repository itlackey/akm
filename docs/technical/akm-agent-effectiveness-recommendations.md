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

---

## 2026-05-03 Full-Corpus Analysis (40 tasks × 5 seeds)

**Run**: 200 akm-arm runs, 40 tasks, 5 seeds, model `shredder/qwen/qwen3.5-9b`.
**Status at time of analysis**: 135/200 runs complete (67.5%). Remaining: inkwell/workflow-configure-scaling (in progress), opencode/* (6 tasks × 5), workflow-compliance/* (6 tasks × 5). All results below are partial; tasks still running are noted.
**Source data**: `/home/founder3/.cache/akm/bench/bench-partial-2026-05-03T23-32-50-041Z.json` (135 runs), `/tmp/bench-full-20260503-183249.log`.

---

### Pass/Fail Tally (135 runs completed)

| Task | Pass | Total | Rate | Notes |
|------|------|-------|------|-------|
| az-cli/aks-get-credentials | 4 | 5 | 80% | |
| az-cli/assign-managed-identity | 5 | 5 | 100% | |
| az-cli/create-resource-group | 5 | 5 | 100% | |
| az-cli/keyvault-secret-set | 4 | 5 | 80% | |
| az-cli/query-by-tag | 5 | 5 | 100% | |
| az-cli/storage-account-create | 2 | 5 | 40% | NEW FAILURE — see REC-A below |
| docker-homelab/bridge-network | 1 | 5 | 20% | NEW FAILURE — stash gap |
| docker-homelab/compose-version-upgrade | 2 | 5 | 40% | NEW FAILURE — stash gap |
| docker-homelab/env-from-file | 0 | 5 | 0% | NEW FAILURE — 2 budget_exceeded, stash misleads |
| docker-homelab/named-volume | 4 | 5 | 80% | |
| docker-homelab/redis-healthcheck | 3 | 5 | 60% | Marginal — stash coverage asymmetry |
| docker-homelab/restart-policy | 4 | 5 | 80% | |
| drillbit/backup-policy | 5 | 5 | 100% | |
| drillbit/backup-policy-train | 5 | 5 | 100% | |
| drillbit/canary-enable | 5 | 5 | 100% | |
| drillbit/provision-edge | 5 | 5 | 100% | |
| drillbit/rotate-secret | 5 | 5 | 100% | |
| drillbit/scale-replicas | 5 | 5 | 100% | |
| drillbit/scale-replicas-train | 5 | 5 | 100% | |
| inkwell/add-healthcheck | 4 | 5 | 80% | Has AGENTS.md |
| inkwell/add-healthcheck-train | 2 | 5 | 40% | NEW FAILURE — missing AGENTS.md |
| inkwell/configure-scaling | 3 | 5 | 60% | |
| inkwell/cpu-scaling | 4 | 5 | 80% | |
| inkwell/full-config | 0 | 5 | 0% | Known hard task (3-block simultaneous) |
| inkwell/new-service | 4 | 5 | 80% | Has AGENTS.md |
| inkwell/new-service-train | 3 | 5 | 60% | Missing AGENTS.md (confirmed no file) |
| inkwell/set-rate-limit | 4 | 5 | 80% | |
| inkwell/workflow-configure-scaling | — | — | — | In progress at time of analysis |
| opencode/* (6 tasks) | — | — | — | Not yet started |
| workflow-compliance/* (6 tasks) | — | — | — | Not yet started |

**Overall (135 completed)**: 98/135 = 72.6%.

---

### Root Cause Analysis: New Failures

#### inkwell/add-healthcheck-train and inkwell/new-service-train — 40% and 60%

**Pattern confirmed**: Both train-slice variants lack AGENTS.md in their workspace. Their eval-slice counterparts (add-healthcheck, new-service) have AGENTS.md and score 80%. The score gap is 40pp for add-healthcheck and 20pp for new-service.

**Root cause**: The bench system prompt (`tests/bench/driver.ts:421`) is hardcoded to instruct the agent to write output to `${workspace}/commands.txt`. For inkwell tasks, the correct output file is `service.yaml`. The AGENTS.md file for eval-slice tasks overrides this with "Edit the workspace file using the schema from step 2" — which, combined with the pre-existing `service.yaml` in the workspace and the README.md task description, causes agents to write `service.yaml` instead of `commands.txt`. Train-slice tasks have no AGENTS.md correction layer. Some agents (2–3/5) still figure it out from the README.md alone, but 2–3/5 write to the wrong file.

**Evidence**: `add-healthcheck-train/workspace/` has README.md and service.yaml but no AGENTS.md. `add-healthcheck/workspace/` has README.md, service.yaml, and AGENTS.md. The AGENTS.md content explicitly says "Edit the workspace file." The bench prompt says "write the answer to commands.txt." Without AGENTS.md to override, ~60% of agents comply with the prompt literally.

**Fix**: Add AGENTS.md to `tests/fixtures/bench/tasks/inkwell/add-healthcheck-train/workspace/` and `tests/fixtures/bench/tasks/inkwell/new-service-train/workspace/` with the same content as their eval counterparts (or equivalent). The AGENTS.md content already exists as a template in the eval-slice workspaces.

**Expected impact**: +40pp on add-healthcheck-train (2/5 → 4/5), +20pp on new-service-train (3/5 → 4/5). Effort: trivial — two new AGENTS.md files.

---

#### docker-homelab/bridge-network — 20% (1/5)

**Root cause — stash content gap**: The stash `knowledge/networking.md` shows `external: true` network patterns (for reverse proxy attachment) but does NOT show how to create a named internal bridge network. The task requires:

```yaml
networks:
  internal:
    driver: bridge
services:
  api:
    networks: [internal]
  worker:
    networks: [internal]
```

The skill.md says "Create one project network per stack" but provides no YAML example for explicitly declaring a named bridge. The knowledge/networking.md shows only the proxy-network external pattern, which is the inverse of what the task needs (external: true vs a new named internal network). Agents searching `akm search docker compose homelab` and loading `skill:docker-homelab` find prose guidance but no bridge-network YAML template.

**Secondary factor — no README in workspace**: The bench prompt instructs agents to `cat ${workspace}/README.md` in Step 3. Docker-homelab workspaces have no README.md. The task description comes only from the task title in the prompt ("Attach two services to a custom internal bridge network") and the AGENTS.md workflow hint. Without README.md and with vague YAML requirements in the stash, agents get the YAML wrong 4/5 times.

**Fix**: Add an explicit named-bridge-network YAML example to `tests/fixtures/stashes/docker-homelab/knowledge/networking.md` under a new section "Creating a named internal bridge":

```yaml
networks:
  internal:
    driver: bridge
services:
  api:
    networks: [internal]
  worker:
    networks: [internal]
```

Also add `README.md` to all docker-homelab task workspaces specifying the exact YAML change required, mirroring the inkwell task README pattern. The absence of README.md means Step 3 of the bench prompt fails silently (the agent gets "no such file" and skips to Step 4 with only the task title for guidance).

**Expected impact**: +60pp (1/5 → 4/5). The stash fix resolves the content gap; the README.md addition resolves the step-3 file-not-found issue.

---

#### docker-homelab/compose-version-upgrade — 40% (2/5)

**Root cause — stash content gap**: The task requires:
1. Setting `version: "3.8"` at the top level.
2. Removing v2-only service keys (`mem_limit`, `cpu_shares`, `volume_driver`, `cpuset`, `cpu_quota`).

The stash `skill:docker-homelab` mentions "Use docker-compose.yml (compose v3+)" but specifies no version number. There is no knowledge article covering the v2→v3 migration path or the list of keys removed in v3. An agent reading the stash knows to use "v3+" but not specifically "3.8" and does not know which v2-only keys to remove.

**Fix**: Add a knowledge article `tests/fixtures/stashes/docker-homelab/knowledge/compose-v3-migration.md` covering:
- `version: "3.8"` as the target version for v2→v3 upgrades.
- The v2-only keys to remove: `mem_limit`, `cpu_shares`, `volume_driver`, `cpu_quota`, `cpuset`.
- A minimal before/after example showing the upgrade.

Also add README.md to the compose-version-upgrade workspace with the task requirements.

**Expected impact**: +40pp (2/5 → 4/5). Effort: one new knowledge file + one README.md.

---

#### docker-homelab/env-from-file — 0% (0/5), including 2 budget_exceeded

**Root cause — stash misleads**: The task requires adding `env_file: [app.env]` (or equivalent) to the `app` service in docker-compose.yml. The stash `compose-conventions.md` mentions `env_file:` only in the context of secrets: "Secrets go in a sibling `.env.secrets` that's gitignored, loaded via `env_file:`." This framing associates `env_file:` with `.env.secrets` (a secrets file), not with the general-purpose `app.env` file the task uses. An agent reading the stash may add the wrong filename (`app.env.secrets` or `.env.secrets`) or skip `env_file:` entirely in favor of the `environment:` block.

The 2 budget_exceeded runs (360s each vs the 90s task budget — the bench was run with a higher budget override) suggest agents attempting multiple failed write-verify cycles before the wall-clock limit was hit.

**Fix (two parts)**:
1. Add a direct `env_file:` usage example to `compose-conventions.md` or a new knowledge article, showing `env_file: app.env` as the canonical pattern for loading a named env file. Keep the `.env.secrets` mention separate with a clear label ("for secrets") to prevent conflation.
2. Add README.md to the env-from-file workspace specifying exactly: "Add `env_file: [app.env]` (or `env_file: app.env`) to the `app` service."

**Expected impact**: +80–100pp (0/5 → 4-5/5). The stash currently actively misleads. A corrected stash + README will move this from 0% to near 100%. The budget_exceeded runs will also resolve since agents won't loop. Effort: one stash edit + one README.md.

---

#### docker-homelab/redis-healthcheck — 60% (3/5)

**Root cause — stash coverage asymmetry**: The stash `knowledge/healthcheck-patterns.md` has an exact Redis healthcheck YAML template:
```yaml
healthcheck:
  test: ["CMD", "redis-cli", "ping"]
  interval: 10s
  timeout: 3s
  retries: 5
```
This is correct. However, the bench AGENTS.md directs agents to `akm show skill:docker-homelab` (not `knowledge:healthcheck-patterns`). The skill.md says only "Prefer in-container probes (curl localhost, pg_isready, redis-cli ping)" — a prose mention of redis-cli with no YAML. Agents that show the skill get a hint but no template. Agents that also search for or show the knowledge article get the exact YAML.

**Fix**: Move the redis-cli healthcheck example into the skill.md `Healthchecks` section, or ensure the AGENTS.md search step returns both the skill and the knowledge article (the AGENTS.md query is `akm search docker compose homelab`, which may not rank `healthcheck-patterns` highly enough). A simpler fix: add the redis-cli YAML inline to `skill:docker-homelab` under `## Healthchecks`.

**Expected impact**: +20pp (3/5 → 4-5/5). Effort: one skill.md edit.

---

#### az-cli/storage-account-create — 40% (2/5)

**Root cause — multi-line skill format vs. single-line verifier grep**: The skill `skill:az-cli` presents all commands in a multi-line backslash-continuation format:
```sh
az storage account \
  create -n <name> -g <resource-group> --sku <sku>
```
The verifier (`verify.sh`) uses single-line grep: `grep -qE 'az storage account create'`. A multi-line continuation format does NOT match this pattern because grep operates line-by-line and `az storage account` ends line 1 while `create ...` starts line 2.

The same multi-line format appears in the AKS section (`az aks \ get-credentials`), yet `aks-get-credentials` passes 80% — because `az aks get-credentials` is a well-known command agents reproduce from training memory in single-line form. `az storage account create` with `--sku Standard_LRS` is less common, making agents more likely to copy the skill's exact multi-line presentation.

A secondary failure mode: the skill's example uses `-n mystorageacct` while the task requires `-n mystorage`. Agents that copy the example verbatim fail the name check.

**Fix (two parts)**:
1. Replace the multi-line format in `skill:az-cli` with single-line forms for all commands, since all verifiers use single-line grep. This is a stash edit with no code changes required.
2. Change the skill's storage account example from `-n mystorageacct` to a clearly-labeled placeholder `-n <storage-account-name>` to prevent literal copying of the example name.

**Expected impact**: +40pp (2/5 → 4/5). Effort: one skill.md edit.

---

### Cross-Cutting Finding: Missing README.md in Docker-Homelab Workspaces

All six docker-homelab task workspaces are missing `README.md`. The bench system prompt (`driver.ts:417`) explicitly instructs: "Step 3 — read README.md in the workspace to understand the specific task requirements." When this file is absent, the agent gets a shell error ("No such file or directory"), silently skips Step 3, and must rely on the task title in the prompt plus the stash content alone.

For inkwell tasks, the README.md is present and specifies exact requirements (field names, values). For docker-homelab tasks, the task title is the only explicit description of requirements (e.g., "Attach two services to a custom internal bridge network"), which is much less precise than a README that says "Add `networks: [internal]` to both the api and worker services."

This structural gap affects all six docker-homelab tasks. Combined with the stash content gaps above, it explains why docker-homelab tasks have the highest variance in the corpus (0%–80%) despite having AGENTS.md files.

**Fix**: Add `README.md` to every docker-homelab task workspace. Content should follow the inkwell README pattern: list the exact change required with exact field names and values, not just a prose description of the task.

---

### Cross-Cutting Finding: Hardcoded `commands.txt` in Bench System Prompt

The bench prompt (`tests/bench/driver.ts:421`) hardcodes the output file as `${workspace}/commands.txt`. Only the az-cli domain uses `commands.txt` as its output file. Inkwell tasks use `service.yaml` and docker-homelab tasks use `docker-compose.yml`.

For domains where the prompt file name is wrong, the AGENTS.md fixture serves as the correction layer ("Edit the workspace file"). When AGENTS.md is absent (train-slice inkwell tasks) or absent of the specific file to edit (docker-homelab without README.md), a fraction of agents write to `commands.txt` instead of the correct file, failing verification.

This is not a product bug (the bench prompt is a test fixture, not a product surface), but it is a fixture correctness issue that depresses observed pass rates artificially. The fix is either to generalize the prompt to say "write your answer to the appropriate file in the workspace" (removing the hardcoded filename), or to ensure every task workspace has an AGENTS.md and README.md that override the file name explicitly.

---

### Prioritized Top-5 Stash Fixes by Expected Pass-Rate Impact

The following are ordered by estimated runs gained across the 200-run corpus (40 tasks × 5 seeds), counting only the tasks seen so far:

**1. docker-homelab/env-from-file — add README.md + fix stash env_file guidance**
- Current: 0/5 (0%). Expected: 4-5/5 (80-100%). Gain: +4-5 runs.
- Two-part fix: correct `compose-conventions.md` to show `env_file: app.env` (not only secrets pattern), add README.md to workspace.
- High-urgency: the stash actively misleads, 2 runs hit budget_exceeded consuming 12 minutes of wall time.

**2. docker-homelab/bridge-network — add YAML example to networking.md + add README.md**
- Current: 1/5 (20%). Expected: 4/5 (80%). Gain: +3 runs.
- Add explicit named-bridge YAML to `knowledge/networking.md`. Add workspace README.md specifying the exact change.

**3. inkwell/add-healthcheck-train — add AGENTS.md**
- Current: 2/5 (40%). Expected: 4/5 (80%). Gain: +2 runs.
- Copy AGENTS.md from `add-healthcheck/workspace/AGENTS.md` into `add-healthcheck-train/workspace/AGENTS.md`. Trivial.

**4. docker-homelab/compose-version-upgrade — add migration knowledge + README.md**
- Current: 2/5 (40%). Expected: 4/5 (80%). Gain: +2 runs.
- Add `compose-v3-migration.md` knowledge article. Add workspace README.md with exact requirements.

**5. az-cli/storage-account-create — convert multi-line to single-line format in skill**
- Current: 2/5 (40%). Expected: 4/5 (80%). Gain: +2 runs.
- Edit `tests/fixtures/stashes/az-cli/skills/az-cli/SKILL.md` to use single-line command format matching verifier grep patterns.

Combined, these five fixes address 13 of the 37 current failures (135 runs completed), lifting the partial pass rate from 72.6% to an estimated 82.2% on the completed portion of the corpus.

Additional gains available from: redis-healthcheck stash fix (+1 run), inkwell/new-service-train AGENTS.md (+1 run), plus carry-forward of the REC-01/REC-04 recommendations from the prior analysis which remain unimplemented.

---

### Note on Tasks Still Running

At time of analysis, inkwell/workflow-configure-scaling, all opencode tasks, and all workflow-compliance tasks were not yet complete. Based on live events.jsonl from active runs, the workflow-configure-scaling agent is successfully calling `akm workflow next` and starting workflow runs (workflow_started events observed), confirming the AGENTS.md override in that workspace is working. Whether it completes the workflow correctly before writing service.yaml will determine its pass rate.

The opencode and workflow-compliance tasks were part of the prior 17-task baseline and their expected rates are documented there. No new analysis is possible until the log completes.
