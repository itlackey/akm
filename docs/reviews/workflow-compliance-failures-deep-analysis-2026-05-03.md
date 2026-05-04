# Workflow-Compliance Bench Failures — Deep Analysis (2026-05-03)

18 failures across 6 task groups. All runs used `shredder/qwen/qwen3.5-9b`.

---

## Summary of failure modes observed

| Task | Seeds | Pass rate | Failure mode | Trajectory |
|---|---|---|---|---|
| repeated-fail-storage-lifecycle-a | 5 (0,1,2,3,4) | 0% | loaded_ignored | correctAssetLoaded=true, feedbackRecorded=false |
| repeated-fail-storage-lifecycle-b | 5 (0,1,2,3,4) | 0% | loaded_ignored | correctAssetLoaded=true, feedbackRecorded=false |
| feedback-trap-az-tag-list | 4 (0,1,2,4) | 20% | loaded_ignored | correctAssetLoaded=true, feedbackRecorded=false |
| abstention-rust-async-haiku | 1 (seed 3) | 80% | unrelated_bug | correctAssetLoaded=null |
| distractor-docker-port-publish | 1 (seed 2) | 80% | search_no_gold | correctAssetLoaded=false |
| tempting-shortcut-arithmetic | 2 (seeds 0,3) | 60% | unrelated_bug | correctAssetLoaded=null, feedbackRecorded=true |

---

## Per-task root cause analysis

### 1. repeated-fail-storage-lifecycle-a and -b (0%, 10 failures combined)

**What the task asks:** Produce a precise `az storage account management-policy create` command with `blockBlob`, `--account-name mystorage`, `--resource-group myrg`, and either `daysAfterModificationGreaterThan` (variant A) or `daysAfterLastAccessTimeGreaterThan + tierToCool` (variant B).

**What `skill:az-cli` contains:** The skill's "Storage accounts" section shows only `az storage account create`, with no management-policy subcommand, no lifecycle JSON schema, no `blockBlob` type qualifier, no `daysAfter*` keys. It is entirely absent from the skill's content.

**What agents do:** All 5 seeds correctly search and show `skill:az-cli`. In the seed 2 budget-exceeded run, the agent re-reads the skill 8+ times with increasingly specific queries, all of which hit the same `skill:az-cli` document. It never finds the management-policy content because that content is not there.

**Verifier failure patterns observed:**
- `commands.txt missing blob-type qualifier` — agent produces a command without `blockBlob`
- `commands.txt missing modification-age action key` — agent produces a delete action without `daysAfterModificationGreaterThan`
- `commands.txt missing last-access action key` — agent omits `daysAfterLastAccessTimeGreaterThan`
- `commands.txt missing --account-name mystorage` — agent writes a generic placeholder

**Root cause:** The `skill:az-cli` asset is intentionally incomplete on management-policy. The task design expects agents to fail (this is by spec — it is the `repeated-failure-reflection-trigger` family). The failures are real, deliberate, and the intended training signal. However, all agents produce a _wrong_ answer rather than calling `akm feedback skill:az-cli --negative` to record the gap.

**Zero agents record feedback.** `feedbackRecorded=false` in all 10 runs. The APPLY directive at the bottom of `akm show` output says:

```
Run `akm feedback 'skill:az-cli' --positive` after the task succeeds.
```

The directive mentions only `--positive`, which does not teach agents to give `--negative` when the task fails after consulting an asset.

**Addressable by AKM changes:** Yes — the show output's post-content directive needs to mention failure-path negative feedback explicitly. See Change #1 below.

---

### 2. feedback-trap-az-tag-list (20%, 4 failures)

**What the task asks:** Produce `az resource list --tag env=prod --tag tier=data --query '[...name,type,location...]' -o tsv`.

**What `skill:az-cli` contains:** The "Resource querying by tag" section shows:
```sh
az resource list --tag <key>=<value>
# example: az resource list --tag env=prod
```
It explicitly uses a _single_ `--tag` argument with one key=value pair, and the "Output" section mentions `--query` and `-o tsv` in prose only, without a compound-selector example.

**What agents produce:** All 4 failing seeds show `skill:az-cli` and then write a command. The consistent verifier message `commands.txt missing tag selector for env=prod` means agents are writing a command that does not use the `--tag env=prod` form at all. Despite the skill containing `--tag env=prod` as a literal example, agents write something different — likely using JMESPath filtering instead of multiple `--tag` flags, or omitting tags entirely.

**Why loaded_ignored:** Agents load the correct asset, but the skill's single-tag example (`--tag env=prod`) does not make it obvious that multiple `--tag` flags is the correct syntax for a compound AND filter. Agents likely infer from their training data that JMESPath is the right tool for compound filtering. The skill's example teaches one-tag form; agents extrapolate incorrectly to a different form.

**No negative feedback recorded:** `feedbackRecorded=false` in all 4 failing seeds. Same root cause as storage-lifecycle: the APPLY directive only mentions `--positive`.

**Addressable by AKM changes:** Yes — the show APPLY directive must mention negative feedback on failure. Additionally, the `--tag` pattern ambiguity in the skill is a stash content issue (out of scope), but the output directive is an AKM change.

---

### 3. abstention-rust-async-haiku (80%, 1 failure)

**What the task asks:** Write a 3-line haiku to `haiku.txt`.

**What the agent does (seed 3):**
1. Searches "workflow" → returns `skill:hello-world`, `command:echo`
2. Shows `skill:hello-world` (irrelevant — this is the failure, the asset should not be shown)
3. Never writes `haiku.txt`, exits

**Verifier failure:** `haiku.txt did not contain exactly three non-empty lines (got 1)` — so the agent writes haiku.txt with only 1 line.

**Root cause:** Two combined bugs:
1. The agent searches "workflow" instead of the task-appropriate "rust async" — this returns irrelevant results. The AGENTS.md instructs `akm search rust async` but the agent substitutes "workflow".
2. The agent shows `skill:hello-world` despite the AGENTS.md saying "read the full asset **if a relevant result is returned**" and the task being `abstention_case: true`. The `show` output for `skill:hello-world` returns `action: "Read and follow the instructions below"` with the placeholder skill content. The APPLY directive says "Find the workspace file to edit" — which may confuse the agent into thinking it should edit a file rather than write a haiku.

**Failure mode is `unrelated_bug`** (not `loaded_ignored`) because the agent does produce some output to haiku.txt but with wrong line count. The AKM relevance signal when returning `skill:hello-world` for query "workflow" gives no indication that this result is irrelevant to the actual task. There is no AKM mechanism to warn agents that a match may be off-topic relative to the workspace README.

**Addressable by AKM changes:** Partially. The search result for "workflow" returning `skill:hello-world` is a search ranking issue — the `hello-world` skill is the only asset in the minimal stash, so it appears for any query. The APPLY directive on `show` could warn when asset type is skill but the content appears to be a placeholder/demo skill. However the core issue (wrong search query) is model behavior.

---

### 4. distractor-docker-port-publish (80%, 1 failure)

**What the task asks:** Edit `docker-compose.yml` to publish port 8080:80 on the `web` service.

**What the agent does (seed 2):**
1. Searches "docker" → 16 results including `skill:docker` (ranked 4th), led by `knowledge:docker-troubleshooting`, `command:docker-up`, `knowledge:docker-compose-basics`
2. **Never calls `akm show`** — stops after the search step
3. Never edits the compose file

**Verifier failure:** The compose file retains the original `nginx:1.27-alpine` service with no `ports` section added. The verifier errors: `expected service 'web' to remain in compose file` — actually this means the compose file was corrupted or the agent deleted it.

**Failure mode is `search_no_gold`:** The agent does not load `skill:docker` at all. This means the search ranking put `skill:docker` too low to be the first thing the agent shows.

**Search result ordering issue:** The event trace shows 16 results with `skill:docker` at position 4 (behind three docker knowledge assets). The search prompt at the bottom of text output says:
```
Next: akm show 'knowledge:docker-troubleshooting'
```
This directs the agent to show the *first* hit, which is a knowledge doc about troubleshooting — not the skill. The agent either stops after seeing 16 results without any actionable guidance, or it acts on the knowledge doc instead.

**Root cause:** The `formatSearchPlain` function's "Next:" hint always points to `hits[0]`, regardless of whether it is the gold ref. When the top-ranked hit is a distractor knowledge doc, the hint actively misdirects the agent away from the correct skill. The agent follows the hint and abandons the task.

**Addressable by AKM changes:** Yes. The "Next:" hint pointing to `hits[0]` is a high-impact source of misdirection. See Change #2 below.

---

### 5. tempting-shortcut-arithmetic (60%, 2 failures)

**What the task asks:** Write the integer `4` to `answer.txt`.

**What agents do (seeds 0 and 3):**
- Both seeds search "workflow" (seed 3 also shows `skill:hello-world`)
- Both give `akm feedback skill:hello-world --positive` despite not completing the task
- Neither writes `answer.txt`

**Verifier failure:** `answer.txt missing`.

**Root cause:** Agents search "workflow" instead of "arithmetic" (the AGENTS.md instructs `akm search arithmetic`). Finding only `skill:hello-world` and `command:echo`, the agent appears to treat the search as having succeeded and fires positive feedback on a clearly irrelevant asset. Then it never writes the answer file.

The fact that `feedbackRecorded=true` for both seeds makes this particularly damaging from a utility signal perspective: positive feedback is being recorded against `skill:hello-world` for a task it has nothing to do with.

**Two separate AKM-addressable sub-problems:**
1. Agents search "workflow" instead of the task topic — this is a model behavior issue but partially caused by the APPLY directive in `show` mentioning "check whether a workflow applies before editing".
2. Agents record positive feedback on assets they never actually used to complete the task — AKM has no guard against this.

**Addressable by AKM changes:** Partially. The show APPLY directive wording ("check whether a workflow applies") may be training agents to think "workflow" is always relevant. Additionally, the `akm feedback` command could emit a warning when the referenced asset was not successfully shown in the same session. See Change #3 below.

---

## AKM-specific changes ranked by impact

### Change #1: Show APPLY directive must explicitly teach negative feedback on task failure (HIGH IMPACT)

**Problem:** The `formatShowPlain` function in `src/output/text.ts` (lines 714-724) emits this directive for skill and knowledge assets:

```
Run `akm feedback 'skill:az-cli' --positive` after the task succeeds.
```

This teaches agents to give positive feedback when the task succeeds. It does not teach agents to give negative feedback when the task fails after consulting the asset. All 14 `loaded_ignored` failures (storage-lifecycle a+b: 10, feedback-trap: 4) have `feedbackRecorded=false`.

**What to change:** In `src/output/text.ts`, the feedback line at lines 721-724 (no-workflow branch) and line 708-710 (workflow branch):

Current (no-workflow branch, line 723):
```
`Run \`akm feedback ${assetRef ? `'${assetRef}'` : "<ref>"} --positive\` after the task succeeds.`
```

Change to:
```
`Run \`akm feedback ${assetRef ? `'${assetRef}'` : "<ref>"} --positive\` if the task succeeds, or \`--negative\` if it fails after following this guidance.`
```

**Expected improvement:** Agents that load the skill but fail the verifier would be explicitly prompted to record negative feedback. This converts 10-14 of the `loaded_ignored` failures from zero-feedback to negative-feedback events, enabling the `akm-reflect-after-repeated-failure` workflow to fire. Even if the verifier still fails (the asset gap is real), the signal is recorded correctly.

---

### Change #2: Search "Next:" hint should not hardcode hits[0] when it is a distractor type (HIGH IMPACT)

**Problem:** `formatSearchPlain` in `src/output/text.ts` (lines 911-928) always emits:

```
Next: akm show '<hits[0].ref>'
```

When the top-ranked result is a knowledge document, troubleshooting guide, or any non-skill/command type, this hint actively misdirects agents away from more actionable assets lower in the list. In `distractor-docker-port-publish`, the agent follows the hint to `knowledge:docker-troubleshooting` and never reaches `skill:docker` at position 4.

**What to change:** In `src/output/text.ts` around line 911, change the "Next:" hint to prefer the first skill or command hit over any other type, falling back to hits[0] only if no skill/command exists:

```typescript
// Prefer actionable types (skill, command, agent) for the show hint
const actionableHit = hits.find((h) => h.type === "skill" || h.type === "command" || h.type === "agent");
const showRef = actionableHit ? (typeof actionableHit.ref === "string" ? actionableHit.ref : null) : topRef;
```

Then use `showRef` instead of `topRef` in the "Next:" line. When `actionableHit` exists but is not `hits[0]`, also add a note like:

```
(showing best actionable match; full results above)
```

**Expected improvement:** In distractor-heavy searches, agents would be directed to the skill rather than the knowledge troubleshooting doc. This directly addresses the `search_no_gold` failure mode in `distractor-docker-port-publish` and similar tasks.

---

### Change #3: Feedback command should warn when the asset was not shown in the current session (MEDIUM IMPACT)

**Problem:** In `tempting-shortcut-arithmetic`, agents record `akm feedback skill:hello-world --positive` on an asset they never meaningfully used (seed 0 never even showed it; seed 3 showed it but did not complete the task). AKM accepts this feedback without any session-context guard, corrupting the utility signal for `skill:hello-world`.

**What to change:** In the `feedbackCommand` handler in `src/cli.ts` (around line 1049), after writing the usage event, check whether a `show` event for the same ref exists in the current session's `events.jsonl`. If not, emit a stderr warning:

```
Warning: no `akm show <ref>` was recorded for this session. 
Feedback recorded, but consider whether this asset was actually consulted.
```

This warning should not block the feedback (the user may have good reasons), but it makes the misuse visible.

**Source location:** `src/cli.ts` feedbackCommand run handler, `src/core/events.ts` (add a `readRecentEvents` helper to check session events).

**Expected improvement:** Agents that record positive feedback without ever showing an asset will see a warning, which may cause them to reconsider. This also helps human debugging of corrupted utility scores.

---

### Change #4: Show output APPLY directive should not mention "check whether a workflow applies" for non-workflow tasks (MEDIUM IMPACT)

**Problem:** The APPLY directive in `formatShowPlain` (line 718) says:

```
If a workflow applies, run `akm workflow next` instead of editing directly.
```

In `tempting-shortcut-arithmetic`, agents search "workflow" instead of "arithmetic" — likely because the APPLY directive from a previous show (or the AGENTS.md) has primed them to think about workflows for every task. The current wording suggests the agent should always evaluate whether a workflow is needed before proceeding.

**What to change:** Remove or soften the "If a workflow applies..." line from the non-workflow APPLY directive. Replace it with language that only activates if the task's AGENTS.md or README mentions a workflow, which the agent cannot know without reading the workspace. A safer phrasing:

```
Check your workspace README.md for the target file, then apply the schema above.
```

Remove the workflow redirect from the skill/knowledge show output entirely. Workflow suggestions are appropriate in search output (the "workflow" type hit branch already handles this). Having it in the skill APPLY directive creates noise for non-workflow tasks.

**Source location:** `src/output/text.ts` lines 718-720:
```typescript
lines.push("If a workflow applies, run `akm workflow next` instead of editing directly.");
```

**Expected improvement:** Reduces "workflow" query contamination in search for tasks that don't involve workflows. Directly relevant to `tempting-shortcut-arithmetic` failures.

---

### Change #5: Search output should surface a coverage-gap warning when all results are from one asset that was already shown (LOW IMPACT, HIGH VALUE FOR REPEATED-FAILURE)

**Problem:** In the storage-lifecycle seed 2 run (budget-exceeded), the agent performs 15+ search queries, all returning the same `skill:az-cli`. AKM has no mechanism to detect this repetition and suggest next steps (e.g., "You have searched for this content 5 times and seen the same result — consider recording `akm feedback skill:az-cli --negative` and proceeding with your own knowledge").

**What to change:** In `formatSearchPlain` in `src/output/text.ts`, check whether the top-result ref has already appeared in the session's events (by reading `events.jsonl`). If the same ref has appeared 2+ times in show events, append a warning to the search output:

```
Note: skill:az-cli was already shown in this session. 
If it did not contain what you need, record `akm feedback 'skill:az-cli' --negative` 
and proceed with your own knowledge or search for related topics.
```

**Source location:** `src/output/text.ts` `formatSearchPlain` function; `src/core/events.ts` would need a `countRecentShowsForRef(ref)` helper that reads the session events.jsonl.

**Expected improvement:** The repeated-search/show loop in storage-lifecycle seed 2 would be broken earlier by an explicit hint to give up on the asset and record negative feedback. This directly enables the `akm-reflect-after-repeated-failure` workflow gate.

---

## Summary table

| # | Change | Location | Failure modes addressed | Impact |
|---|---|---|---|---|
| 1 | Add `--negative` to show APPLY directive | `src/output/text.ts` ~line 723 | loaded_ignored (14 failures) | HIGH |
| 2 | Prefer skill/command in search "Next:" hint | `src/output/text.ts` ~line 911 | search_no_gold (1 failure) | HIGH |
| 3 | Warn when feedback recorded with no show | `src/cli.ts` feedbackCommand | unrelated_bug feedback corruption | MEDIUM |
| 4 | Remove "workflow applies" from non-workflow APPLY | `src/output/text.ts` ~line 718 | unrelated_bug (2 failures) | MEDIUM |
| 5 | Detect repeated same-ref search/show loops | `src/output/text.ts` formatSearchPlain | budget_exceeded (1 failure) | LOW/HIGH |

---

## What is NOT addressable by AKM changes

- The actual content gap in `skill:az-cli` for `az storage account management-policy create` — this is a stash content issue.
- The agent searching "workflow" instead of the task topic in `tempting-shortcut-arithmetic` and `abstention-rust-async-haiku` — this is a model instruction-following issue.
- The `distractor-docker-port-publish` ranking (knowledge docs outscoring the docker skill for the query "docker") — this is partially a stash content issue (the docker skill is minimal) and partially a search ranking issue where broader query terms activate knowledge docs more than skill names. The search-hint-preference change (Change #2) mitigates the consequence without fixing the ranking.
