# Workflows

A workflow is a structured markdown document that defines a multi-step
procedure. akm parses it, persists run state, and lets you advance through
steps one at a time — resuming after interruptions, blocking on human review
gates, and tracking completion criteria per step. The agent follows steps; the
human approves gates.

## akm workflow start

`akm workflow start` creates a new persisted run for a workflow asset. Run
state is scoped to the current project directory (nearest `.akm/config.json`,
git root, or stash root), so concurrent runs in different directories stay
independent.

```sh
akm workflow start workflow:ship-release
akm workflow start workflow:ship-release --params '{"version":"1.2.3"}'
```

The run snapshots the step list at start time. Edits to the source workflow
file after a run has started do not affect in-flight runs.

**Example: kick off a release**

```sh
akm workflow start workflow:ship-release --params '{"version":"2.0.0"}'
# → {"run": {"id":"<uuid>","status":"active","currentStepId":"validate",...}}
```

## akm workflow next

`akm workflow next` returns the current actionable step for an active run. If
no active run exists for the given ref in the current scope, it auto-starts
one. This is the primary command an agent calls in a loop.

```sh
akm workflow next workflow:ship-release
akm workflow next <run-id>
akm workflow next workflow:ship-release --params '{"version":"1.2.3"}'  # auto-start params
```

The response includes the step object (`title`, `instructions`,
`completionCriteria`) or `"done": true` when the run is complete.

**Example: step through an onboarding workflow**

```sh
# Agent loop:
akm workflow next workflow:repo-onboarding
# read instructions → perform work → mark complete → repeat
akm workflow complete <run-id> --step setup-ci --notes "CI configured in .github/workflows/"
akm workflow next workflow:repo-onboarding
```

## akm workflow status

`akm workflow status` shows the full run state — all step statuses, notes, and
evidence — for a given run ID or workflow ref.

```sh
akm workflow status <run-id>
akm workflow status workflow:ship-release
# When given a ref, resolves to the most-recently-updated run in the current scope
```

Use this to inspect where a run is after a context window break, or to verify
all steps completed cleanly before closing a PR.

## akm workflow list

`akm workflow list` shows workflow runs in the current scope.

```sh
akm workflow list              # All runs in this scope
akm workflow list --active     # Only active runs
akm workflow list --ref workflow:ship-release  # Runs for a specific workflow
```

**Example: see what is in flight**

```sh
akm workflow list --active
# → lists runs by workflow ref, status, currentStepId, and updatedAt
```

## Writing a workflow

Workflow files are plain markdown with a specific heading structure. Use
`akm workflow template` to print a valid starter, then edit it and register it
with `akm workflow create`.

```sh
akm workflow template          # Print the template
akm workflow create my-release --from ./my-release.md
akm workflow validate workflow:my-release  # Check for errors before using it
```

**Minimal workflow format:**

```markdown
---
description: Ship a tagged release to production
params:
  version: The semver version string to release
---

# Workflow: Ship Release

## Step: Validate inputs
Step ID: validate

### Instructions
Check that `version` follows semver and the tag does not already exist.

### Completion Criteria
- `git tag v<version>` does not already exist
- Version string matches `^\d+\.\d+\.\d+$`

## Step: Build and test
Step ID: build

### Instructions
Run `npm run build && npm test`. Fix any failures before proceeding.
```

Rules: one `# Workflow: <title>` heading, each step is `## Step: <title>` with
a `Step ID: <id>` line and a `### Instructions` section. Completion criteria
are optional but recommended for human-review gates.

**Example: run a print book review workflow**

```sh
akm workflow start workflow:print-book-review --params '{"draft":"v3.pdf"}'
akm workflow next workflow:print-book-review
# agent reads instructions → runs checks → completes each step in sequence
```

## Orchestrated steps: YAML workflow programs (experimental)

Alongside the stable linear markdown format above, a workflow can be written
as a **YAML orchestration program** and executed engine-driven with
`akm workflow run <run-id|workflow:ref>`: akm compiles the program into a
plan graph, freezes that plan on the run, dispatches each step's units to the
configured runner (fan-out runs units concurrently), records every unit in
`workflow_run_units`, and advances the run through the normal completion
gates. Linear markdown workflows are unaffected — they keep compiling to a
linear plan exactly as before, and the manual `next`/`complete` loop keeps
working on every run.

YAML programs live in your stash under `workflows/` with a `.yaml` or `.yml`
extension and are addressed with the same `workflow:<name>` refs. Print a
starter with **`akm workflow template --yaml`**, and lint with
`akm workflow validate <path|workflow:ref>` — validation is backed by the
published JSON Schema at `schemas/akm-workflow.json`.

```yaml
version: 1
name: review-changes
description: Review changed files and route the outcome
params:
  changed_files: { type: array, items: { type: string } }
defaults:            # run-level defaults, overridable per unit
  runner: sdk        # llm | agent | sdk | inherit
  model: balanced
  timeout: 10m
  on_error: fail

steps:
  - id: discover
    title: Discover targets
    unit:
      instructions: |
        List the files that need review for ${{ params.changed_files }}.
      output:                      # typed step artifact (JSON Schema)
        type: object
        properties: { files: { type: array, items: { type: string } } }
        required: [files]
    gate:
      criteria: [every target is listed]

  - id: review
    title: Review files
    map:
      over: ${{ steps.discover.output.files }}   # explicit producer address
      concurrency: 8
      reducer: collect
      unit:
        runner: agent
        profile: reviewer
        model: deep
        timeout: 5m
        retry: { max: 1, on: [timeout, llm_rate_limit] }
        on_error: continue
        instructions: |
          Review ${{ item }} for correctness bugs.
        output: { type: object, properties: { file: { type: string }, verdict: { type: string } }, required: [file, verdict] }
    output:                        # step artifact produced by the reducer
      type: object
      properties: { verdict: { type: string } }
    gate:
      criteria: [every changed file has a verdict]
      max_loops: 2                 # evaluator-optimizer, bounded

  - id: triage
    route:                         # routing on an explicit input
      input: ${{ steps.review.output.verdict }}
      when: { pass: ship, fail: rework }
      default: manual-triage

  - id: ship
    unit:
      instructions: Ship the change.

  - id: rework
    unit:
      instructions: Address the review findings, then re-run the review.

  - id: manual-triage
    unit:
      instructions: Summarize the ambiguous verdict for a human to triage.
```

**Format rules.** Top-level keys: `version: 1` (required), `name`,
`description?`, `params?` (name → JSON-Schema declaration), `defaults?`
(`runner`, `model`, `timeout`, `on_error`), and `steps`. Each step has an
`id`, an optional `title`, and **exactly one of** `unit` (single dispatch),
`map` (fan a unit template out over `over:` with optional `concurrency` and a
`collect` | `vote` reducer), or `route`. A unit carries `instructions`
(required) plus optional `runner`, `profile`, `model`, `timeout`, `retry`,
`on_error`, `output` (JSON Schema for the unit's structured result), and
`env` (env asset refs injected via the `akm env run` machinery — requires the
agent runner; sdk/llm units fail loudly). Timeouts are
`"<n>ms" | "<n>s" | "<n>m" | "none"`. Steps may also declare `output` (the
step-artifact schema) and `gate` (`criteria`, `max_loops`).

### The expression language

`${{ … }}` references are **parsed, not string-replaced** — a closed grammar
with exactly four reference kinds:

| Reference | Meaning |
| --- | --- |
| `${{ params.<name> }}` | A run parameter, by name. |
| `${{ steps.<id>.output.<path> }}` | A prior step's artifact, addressed by producer step id; the path walks properties (`.name`) and array indexes (`[0]`). |
| `${{ item }}` | The current fan-out item (only inside a `map` unit). |
| `${{ item_index }}` | The current item's index (only inside a `map` unit). |

Nothing else parses: no functions, no clock, no randomness, no ambient
lookup. Templates are parsed once into literal/reference segments and
resolved in a single pass — substituted content is data and is **never
re-scanned**, so a value that happens to contain `${{ params.x }}` is
inserted literally and cannot inject further references. Every reference
names its producer explicitly, and `akm workflow validate` checks each edge
(unknown step, unknown param, bad path) at lint time.

One caveat: there is **no escape syntax**. A literal `${{` cannot appear in
instructions — the validator reports a parse error if you write one.

### Frozen plans

`akm workflow start` compiles the program and freezes the resulting plan on
the run row (`plan_json` + `plan_hash`). **A run executes the plan compiled
at start; edits to the source file need a new run** — the file is never
re-read for an in-flight run, so `run`, `next`, and `resume` all see the same
program no matter what has changed on disk. Orchestration decisions are pure
functions of the frozen plan, the run params, and journaled unit results.

### Failure policy

Fail-fast is the default. Per unit (or via `defaults.on_error`):

- `on_error: fail` — the first failed unit fails the step, which fails the
  run (`akm workflow resume` re-opens it; `run` re-dispatches only
  incomplete units).
- `on_error: continue` — failures are recorded in the step's results and the
  completion gate decides whether the step passes.
- `retry: { max: <n>, on: [<failure_reason>…] }` — re-dispatches a failed
  unit up to `max` extra times when its recorded `failure_reason` is listed
  (e.g. `timeout`, `llm_rate_limit`, `spawn_failed`, `non_zero_exit`); every
  attempt is journaled separately.

A unit's `output` schema is validated on every runner; a validation miss
re-dispatches once with corrective feedback before the unit is recorded as
failed.

### Routing

A `route` step makes classify-and-dispatch first-class: the engine resolves
the explicit `input:` expression, selects the matching `when:` branch (or
`default:`), and auto-skips the unselected branch targets as the spine
reaches them. Targets must be later steps; an unroutable value with no
`default` fails the step rather than letting every branch run. Route
decisions are journaled, so a resumed run replays the same choice. Routing
(like fan-out) is an engine feature: it applies under `akm workflow run` —
the manual `next`/`complete` loop does not auto-skip.

### Not yet enforced (planned for R2)

The format carries several declarations the engine does not act on yet:

- **Typed step-artifact validation** — a step's `output` schema is parsed
  and carried, but the reducer result is not yet validated against it (unit
  `output` schemas *are* enforced).
- **Artifact-judging gates and `gate.max_loops`** — gates evaluate
  completion criteria as today; judging the typed artifact and bounded
  evaluator-optimizer loops come with the engine rework.
- **Run-lease enforcement** — the lease columns exist, but a second
  concurrent `workflow run` is not yet refused.
- **Budget ceilings, `workflow watch`, and `isolation: worktree`.**

### Model tiers

Reference semantic aliases in `model:` fields instead of exact model ids so a
workflow stays harness-agnostic. Recommended vocabulary (convention, not
hardcoded) via the config-root `modelAliases` key:

```jsonc
{
  "modelAliases": {
    "fast":     { "*": "claude-haiku-4-5" },
    "balanced": { "*": "claude-sonnet-4-6" },
    "deep":     { "claude": "claude-fable-5", "opencode": "opencode/claude-fable-5", "*": "claude-fable-5" }
  }
}
```

The built-in aliases `fable`, `opus`, `sonnet`, and `haiku` resolve per
platform with no config. Point `deep` work (review, verification, judging) at
`fable` — Anthropic's tier above Opus — and keep high-volume fan-out units on
`fast`/`balanced`.

Trust note: a workflow that fans out is authorizing **N parallel agents**, not
one — the security section below applies with multiplied blast radius. The
engine enforces a concurrency cap, a lifetime unit cap per run, and per-unit
timeouts.

## Security: workflow sources are executed code

Workflow steps that include shell commands run with **the full environment
and PATH of the user invoking `akm workflow next`** — same as if the user had
typed those commands in their shell. There is no sandbox, no env-var
allowlist, and no separation between trusted and untrusted workflows.

This is by design: a workflow is a runbook authored by you or by a stash
maintainer you trust. The flexibility of "run any shell command, read any
file, hit any network" is what makes workflows useful as automation.

The consequence is that **you should treat workflow sources the same way you
treat package dependencies**:

- **Only add workflow sources you trust.** `akm add github:<some-user>/stash`
  followed by `akm workflow next workflow:<their-thing>` is functionally
  equivalent to piping a stranger's bash script into your shell. Read the
  workflow file first (`akm show workflow:<name>`) before running it.
- **Audit before run** for any workflow that touches secrets, deploys to
  production, or writes outside the project tree. Workflow steps can read
  any environment variable visible to the akm process — including secrets
  exported by your shell or injected via `akm env run` / `akm secret run`.
- **Pin known-good versions** when adding workflow sources from a registry
  or git remote (`akm add github:owner/stash#v1.2.3`), and update
  deliberately rather than via `akm update --all`. A trusted workflow source
  can become hostile if its upstream is compromised.
- **Workflow steps cannot escape this trust model** by being labeled
  `dryRun` or `interactive` — those flags affect bookkeeping, not execution.
  An `akm workflow next` invocation always runs the next step's instructions
  in your shell.

If you operate a CI runner or shared host where untrusted workflows might be
executed, scope the process: a dedicated user account with no secrets in its
environment, ephemeral working directory, and a network/filesystem allowlist
enforced outside akm.

## See also

- [Search & Discovery](search-discovery.md) — find available workflows with `akm curate`
- [Knowledge Management](knowledge-management.md) — capture workflow outputs as memories
- [Improvement Loop](improvement-loop.md) — improve workflow assets over time
- [CLI Reference](../cli.md) — full flag documentation for all `workflow` subcommands
- [Concepts](../concepts.md) — workflow asset type and run-state storage
