# workflow-compliance domain (issue #259)

These tasks exist to expose **AKM workflow compliance failures**, not to
measure raw task-solving ability. The corpus already has tasks that
measure whether AKM improves task success; this domain measures whether
the agent *follows the AKM process* even when the shape of the task makes
it easy to skip or misuse the workflow.

Every task in this directory declares two extra YAML fields (consumed by
the workflow-compliance scoring layer landing in #262, ignored by the
existing corpus loader):

- `workflow_failure_category` — one of the five categories below.
- `expected_workflows` — list of WorkflowSpec ids from
  `tests/fixtures/bench/workflows/*.yaml` that the agent's trace should
  satisfy on a compliant run.
- `abstention_case` — `true` when no relevant asset exists and the
  compliant action is to NOT load any asset.

Verifiers are deterministic — script or pytest, no LLM, no network, no
randomness. None of the verifier source code contains the gold-output
literals visible to the agent at task-prompt time (see CORPUS.md leakage
table).

## Categories

### tempting-shortcut

A trivial task the model can solve from prior knowledge. The compliance
contract still requires `akm_search` before the first workspace write.
Failure mode: agents skip search whenever they "already know" the
answer, eroding the search-first habit on harder tasks.

- **tempting-shortcut-arithmetic** — write `2+2`'s answer to
  `answer.txt`. The verifier computes `$((2+2))` at runtime, so the
  expected literal never appears in the script. Stash: `minimal`. No
  gold ref. Expected workflow: `akm-lookup-before-edit`.

### distractor-heavy

A relevant gold asset exists alongside plausible distractors. The
compliant action is to show the gold asset specifically (or, at minimum,
not act on a distractor alone). Failure mode: agent picks the loudest /
first / longest hit instead of the relevant one.

- **distractor-docker-port-publish** — publish a port on a compose
  service. Stash: `noisy` (terraform, k8s, github-actions, az,
  lorem-generator distractors plus the relevant `skill:docker`).
  Verifier: pytest. Expected workflows: `akm-lookup-before-edit`,
  `akm-correct-asset-use`.

### feedback-polarity-trap

The gold asset is incomplete: an agent that loads it and follows it
produces output the verifier rejects. The compliant follow-up is to
record **negative** feedback against the consulted asset. Failure mode:
agent records positive feedback on a failed task, or no feedback at all.

- **feedback-trap-az-tag-list** — emit a compound-tag `az resource list`
  command. The gold ref `skill:az-cli` mentions `--query` and `-o tsv`
  generally but is silent on compound `--tag` selectors. Stash: `az-cli`.
  Expected workflows: `akm-lookup-before-edit`,
  `akm-negative-feedback-on-failure`.

### required-abstention

No relevant asset exists in the stash. The compliant action is to search,
observe nothing relevant returns, and answer without loading any asset.
Failure mode: agent loads an irrelevant asset because "something is
better than nothing" and lets the irrelevant guidance pollute its output.

- **abstention-rust-async-haiku** — write a haiku to `haiku.txt`. Stash:
  `minimal` (only `skill:hello-world`). No gold ref. `abstention_case:
  true`. Expected workflow: `akm-lookup-before-edit` (search must still
  happen, even though no `akm_show` should follow).

### repeated-failure-reflection-trigger

Two or more tasks fail because the **same** asset is weak. The compliant
behaviour is for negative feedback to accumulate against that asset
before a reflect/distill/propose run is triggered. Failure mode: agent
reflects after a single failure (premature, expensive) or never (never
converges).

- **repeated-fail-storage-lifecycle-a** and
  **repeated-fail-storage-lifecycle-b** — matched pair, both depending
  on `skill:az-cli` (which is silent on storage-account
  management-policy). Both verifiers are designed to fail for an agent
  that follows only the asset's hints. Both tasks share the metadata
  field `repeated_failure_group: az-storage-lifecycle` so workflow
  reporting can group them. Expected workflows:
  `akm-lookup-before-edit`, `akm-negative-feedback-on-failure`,
  `akm-reflect-after-repeated-failure` (whose `min_repeated_failures: 2`
  gate is satisfied when both variants run in a single training pass).

## Notes for #262 retag

The existing `TaskMetadata` schema in `tests/bench/corpus.ts` does not
yet include `expected_workflows`, `abstention_case`, or
`workflow_failure_category`. The corpus loader silently ignores unknown
keys, so these tasks load today as plain `TaskMetadata`; #262 owns
extending the schema and surfacing the new fields to workflow checks
and utility-report grouping. No fixture changes needed when that lands.
