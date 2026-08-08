# Workflow Schema

This is the authoritative reference for a workflow asset's exact frontmatter
and body syntax — every key, its shape, and the validation rules enforced by
the published JSON Schema (`schemas/akm-workflow.json`) and
`akm lint --type workflows`. Other pages link here instead of reproducing this
detail.

- For a task-oriented walkthrough of writing your first workflow, see the
  [Author's Guide](https://github.com/itlackey/akm/blob/main/docs/guides/author-workflows.md).
- For how a frozen plan actually executes — persistence, dispatch, resume —
  see [Architecture: The Workflow Engine](https://github.com/itlackey/akm/blob/main/docs/architecture/workflow-engine.md).
- For operating a run day to day (`run`, `status`, `resume`, `abandon`), see
  [Running Workflows](https://github.com/itlackey/akm/blob/main/docs/guides/run-workflows.md).

## One format

A workflow is an ordinary AKM markdown asset — the same envelope as every
other type, OKF-conformant frontmatter plus a markdown body — whose
frontmatter carries the entire orchestration graph (params, and how each step
dispatches, fans out, routes, and gates) and whose body carries each step's
instructions and gate rubric under plain headings, joined to the frontmatter
by step id. There is **one** format: no separate YAML "program" surface, no
`.yaml`/`.yml` workflow files.

## Frontmatter keys

Frontmatter is the standard AKM asset envelope (`type`, `description`, `tags`,
`when_to_use`, `xrefs`, `updated`/`timestamp`, and the OKF v0.2 trust/lifecycle
families) plus the orchestration keys:

- `params` — name → `{ type, description }` (JSON-Schema-typed, unlike a bare
  description string).
- `defaults` — run-level dispatch defaults (`engine`, `model`, `llm`,
  `timeout`, `on_error`), overridable per unit.
- `budget` — run-lifetime ceilings (`max_units`, `max_tokens`; see
  [Budget ceilings](#budget-ceilings) below).
- `steps` — an ordered list. Each step has an `id`
  (`[A-Za-z_][A-Za-z0-9_-]*` — no dots) and **at most one** of `unit`, `map`,
  or `route`. A step with neither is **still a unit step** — bare
  `- id: validate` is the complete minimal declaration. `unit:` is the
  optional dispatch-override bag (`engine`, `model`, `llm`, `timeout`,
  `retry`, `on_error`, `env`, `isolation`; see
  [Failure policy](#failure-policy) and
  [Worktree isolation](https://github.com/itlackey/akm/blob/main/docs/architecture/workflow-engine.md#worktree-isolation)).
- `inputs` — on a `unit`/`map` step, the prior-step artifacts this step
  consumes, as bare reference strings (sub-paths legal:
  `steps.x.output.issues`, not just `steps.x.output`). This is how a step's
  attached context sees upstream data, and how replay hashing gets its exact
  input set — a step re-dispatches only when the slice it actually consumes
  changes.
- `output` — a JSON Schema for the step's promoted artifact.
- `gate` — optional validation-loop configuration: `max_loops` bounds
  evaluator-optimizer retries (see
  [Gates and verification](#gates-and-verification)). The rubric itself lives
  in the body's `### gate` section. Without non-empty rubric text, the
  configuration is inert.

No `version:`/`name:` keys — identity is the ref, and the frozen plan already
versions execution semantics — and no step titles anywhere: a step is its id,
and the asset's human name is its `description` and H1 like any other asset
type.

## Body structure and rules

Checked by `akm lint --type workflows`:

1. Every level-2 heading must be `## <step-id>` for a step declared in
   frontmatter, exactly — no titles, no `Step:`/`Step ID:` lines, no
   `# Workflow:` prefix on the H1. (Fenced code blocks are skipped when
   scanning for headings.)
2. A `unit` or `map` step **must** have a body section — its instructions,
   or its per-item template for a map step, byte-exact to the next H2 or
   EOF. A `route` step **may** have one (documentation, plus a gate rubric
   if it is gated). Everything before the first H2 is free preamble —
   indexed for search, shown in `akm show`, never dispatched.
3. Inside a step's section, an optional `### gate` sub-heading starts that
   step's gate rubric, running to the section end — the format's **single
   reserved marker**. The judge that evaluates the step receives this whole
   section byte-exact. An omitted or empty `### gate` section needs no
   verification. A non-empty rubric enables mandatory fail-closed
   verification; frontmatter `gate:` only tunes its retry bound.

Prose is never templated — see [The reference grammar](#the-reference-grammar)
for how a step's instructions refer to run params, upstream artifacts, and a
map unit's item.

## Minimal example

```markdown
---
type: workflow
description: Ship a tagged release to production
params:
  version: { type: string, description: The semver version string to release }
steps:
  - id: validate
  - id: build
    inputs: [steps.validate.output]
---

# Ship Release

## validate

Check that the `version` parameter follows semver and the tag does not
already exist.

### gate

- `git tag v<version>` does not already exist.
- The version string matches `^\d+\.\d+\.\d+$`.

## build

Run `npm run build && npm test`, using the validation from `validate`,
attached to this unit as input. Fix any failures before proceeding.
```

## Richer example

Fan-out, routing, retries, gates, and a run budget:

```markdown
---
type: workflow
description: Review changed files and route the outcome
params:
  changed_files: { type: array, description: Files to review }
defaults: { engine: reviewer, model: balanced, timeout: 10m, on_error: fail }
budget: { max_units: 40, max_tokens: 200000 }
steps:
  - id: discover
    output: { type: object, properties: { files: { type: array } }, required: [files] }
  - id: review
    map:
      over: steps.discover.output.files
      concurrency: 8
      unit:
        engine: reviewer
        model: deep
        timeout: 5m
        retry: { max: 1, on: [timeout, llm_rate_limit] }
        on_error: continue
        isolation: worktree
        output: { type: object, properties: { file: { type: string }, verdict: { type: string } }, required: [file, verdict] }
    # `output` here describes the REDUCER RESULT, not one unit's result: the
    # default `collect` reducer folds per-item unit results into an array.
    output: { type: array }
    gate: { max_loops: 2 }
  - id: aggregate
    inputs: [steps.review.output]
    output: { type: object, properties: { verdict: { type: string } }, required: [verdict] }
  - id: triage
    route:
      input: steps.aggregate.output.verdict
      when: [{ match: pass, step: ship }, { match: fail, step: rework }]
      default: manual-triage
  - id: ship
  - id: rework
  - id: manual-triage
---

# Review Changes

## discover

List the files that need review, drawn from the `changed_files` parameter.

### gate

Every file named by `changed_files` is listed in the reported result.

## review

This section is the **map unit template** — the engine attaches each unit's
item (the file to review) and its index as context; instructions refer to
"the file you were given," never a template expression.

Review the file you were given for correctness bugs.

### gate

Every changed file has a verdict of `pass` or `fail`.

## aggregate

Combine the per-file review verdicts — attached to this unit as input via
`inputs: [steps.review.output]` above — into one overall verdict, `pass` or
`fail`.

## triage

Routes on the verdict `aggregate` reported: `pass` proceeds to `ship`, `fail`
proceeds to `rework`, anything else goes to `manual-triage`.

## ship

Ship the change.

## rework

Address the review findings. Confirming the fix is a fresh `akm workflow run`
of this workflow, not a step this run routes back to.

## manual-triage

Summarize the ambiguous verdict for a human to triage.
```

## The reference grammar

Workflow prose is **never templated** — there is no `${{ … }}`/`{{ … }}`
interpolation anywhere in a workflow's body, and no escape syntax to learn,
because there are no delimiters in prose to escape.

Bare reference strings appear in exactly three frontmatter positions, each an
unquoted-style YAML string:

| Position | What it names |
| --- | --- |
| `map.over` | The list a map step fans out over. |
| `route.input` | The value a route step matches on. |
| `inputs` (each entry) | A prior step's artifact this step consumes. |

Every reference resolves against exactly two roots:

| Reference | Meaning |
| --- | --- |
| `params.<name>` | A run parameter, by name. |
| `steps.<id>.output( .<ident> \| [<int>] )*` | A prior step's artifact, addressed by producer step id; the path walks properties (`.name`) and array indexes (`[0]`). |

Nothing else parses: no functions, no clock, no randomness, no ambient
lookup. `item` and `item_index` are **not** part of the language — a map
unit's item and its index are never referenced from anywhere in frontmatter
or body. They arrive as **attached context** instead, the same way as
everything else a unit needs.

**Context attachment, not string splicing.** Each dispatched unit receives,
alongside its byte-exact instructions, structured context:

- every run **param** (params are run-scoped — see
  [Params are not secret](#params-are-not-secret) below);
- for a **map** unit, its **item** and **item index**;
- the artifacts named by its step's **`inputs:`**.

Instructions refer to this context in plain language — "clone the repository
named by the `repo` parameter," "review the file you were given," "using the
intake step's artifact attached to this unit" — never by splicing a value
into the instruction string. This closes the injection class at the root:
data never enters the instruction string, spliced or otherwise.

`akm lint --type workflows` still checks every bare reference statically —
unknown step, unknown param, bad path — at lint time.

### Params are not secret

Run params are copied verbatim into every unit's dispatched instructions and
are part of the unit's content-derived input hash — the same hash that makes
resume-without-replay possible (see
[Resume is journaled replay](https://github.com/itlackey/akm/blob/main/docs/architecture/workflow-engine.md#resume-is-journaled-replay)).
Redacting a param would change what gets hashed and make a resumed run
diverge from the original, so params are **declared non-secret and
un-redactable** by design: secrets belong in `env:` refs instead, which carry
by name only through the plan and are resolved from akm's env/secret store
at dispatch (see [Reference: Env & Secrets](https://github.com/itlackey/akm/blob/main/docs/reference/env-and-secrets.md)).

As a best-effort guardrail, `akm workflow run` scans a new run's params for
values that *look* like credentials — secret-suggesting key names (`token`,
`password`, `apikey`, `credential`, …) or long, high-entropy strings matching
known token prefixes — and surfaces a warning naming the param path and
recommending an `env:` ref instead. This is advisory only: it never blocks a
run and never mutates params, and false positives/negatives are expected.

## What a step's output is

`steps.<id>.output` resolves to the value the step's execution produced:

- a `unit` step → the unit's structured result (when the unit declares
  `output`) or its text;
- a `map` step → the collected array of per-item results, in item order
  (under `on_error: continue`, a failed item's slot is `null`), unless the
  step's own `output` schema describes a reduced, single-value shape instead.

**An empty successful free-text output is treated as no output.** When a
schemaless unit (one that declares no `output` schema) succeeds but returns
the empty string, akm normalizes it to *absent*: nothing is journaled for its
result, and its contribution to the step artifact is `null` — a `null` slot
in a collected array, or `output = null` for a solo step. This absence is
deliberate, so a live run and a resumed run promote the identical artifact.
The practical consequence: a downstream step that declares an empty upstream
result in its `inputs:` gets nothing meaningful attached for it — akm
surfaces this loudly rather than silently attaching an empty string. A unit
that declares an `output` schema is unaffected — an empty response is not
valid JSON, so it fails as a parse error and can never satisfy a schema as a
silent `null`.

## Typed step artifacts

When a step declares `output`, the promoted step artifact (the unit's
structured result, the collected array, or a reduced single value — see
[What a step's output is](#what-a-steps-output-is) above) is validated
against that schema **before** the step can complete. A mismatch fails the
step with the validation errors in its summary. This is fail-fast on purpose:
a bounded gate loop (see [Gates and verification](#gates-and-verification))
can re-run the step with those errors as corrective feedback.

### The enforced JSON Schema subset

`output` and `params` schemas are validated **as schemas** at parse time
(`akm lint --type workflows`, `akm workflow create`), because the runtime
enforces only a subset of JSON Schema:

`type`, `enum`, `properties`, `required`, `items`, `additionalProperties:
false`, `minItems`, `maxItems`, `minLength`, `maxLength`, `minimum`,
`maximum`.

Anything outside it is an authoring **error**, not a silent no-op. A typo'd
type name (`type: strig`) and a recognized-but-unenforced keyword (`pattern`,
`format`, `const`, `$ref`, `allOf`/`anyOf`/`oneOf`, `patternProperties`,
schema-form `additionalProperties`, tuple-form `items`, …) both fail with the
offending keyword named and its location anchored to the line. A gate that
depends on a schema constraining nothing is worse than a loud failure.
Annotation keywords (`description`, `title`, `default`, `examples`) constrain
nothing in full JSON Schema either, so they pass through untouched.

### Bounds

These are enforced identically by the parser, the published JSON Schema, and
the frozen-plan decoder (they share one set of constants in
`src/workflows/resource-limits.ts`), so a document that lints clean cannot
fail later at `akm workflow run`:

| Field | Bound |
| --- | --- |
| `gate.max_loops` | 1 – 100 |
| `map.concurrency` | 1 – 64 |
| `retry.max` | 0 – 100 |
| `timeout` | ≤ 2147483647 ms (~24.8 days), or `none` |
| `engine` names | `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, ≤ 63 chars |

`timeout` is resolved **once, at freeze time**, and the frozen value is what
dispatch applies — there is no separate engine-side ceiling on top of it. The
first of these that is set wins: the unit's `timeout`, then the document's
`defaults.timeout`, then `engines.<name>.timeoutMs`, then the engine-kind
default — **10m for `kind: llm` engines, and none for agent engines**, which
manage their own process lifetime. Writing `timeout: none` is an explicit opt
out and leaves the unit genuinely unbounded; nothing later re-imposes a cap.

## Routing

A `route` step makes classify-and-dispatch first-class: the engine resolves
the explicit `input:` expression, selects the matching `when:` branch (or
`default:`), and auto-skips the unselected branch targets as the spine
reaches them. **Routes are forward-only**: every target (each `when.step`
and `default`) must be a step declared *later* in the workflow than the
routing step, and a step never routes to itself — this keeps the plan a DAG,
so termination is structural rather than a runtime budget's job. A
`default:` that names an earlier step is a lint error, not a loop. An
unroutable value with no `default` fails the step rather than letting every
branch run.

**"Go back and fix it" is a gate, not a backward route.** A failed gate
re-runs its *own* step with the judge's feedback, bounded by `gate.max_loops`
— and a declared `output:` schema the promoted artifact fails is specifically
the error a gate loop retries through. A workflow that used to describe "loop
back to an earlier step until this passes" expresses that as a bounded gate
on the step doing the work, not as routing.

Route decisions are journaled, so a resumed run replays the same choice.
Skips cascade: when a route step is itself skipped (it was the unselected
target of an earlier route), its own branch targets are skipped too — a
router that never decided selects nothing.

## Failure policy

Fail-fast is the default. Per unit (or via `defaults.on_error`):

- `on_error: fail` — the first failed unit fails the step, which fails the
  run (`akm workflow resume` re-opens it; `akm workflow run` re-dispatches
  only incomplete units).
- `on_error: continue` — failures are recorded in the step's results and the
  completion gate decides whether the step passes.
- `retry: { max: <n>, on: [<failure_reason>…] }` — re-dispatches a failed
  unit up to `max` extra times when its recorded `failure_reason` is listed
  (e.g. `timeout`, `llm_rate_limit`, `spawn_failed`, `non_zero_exit`); every
  attempt is journaled separately.

A unit's `output` schema is validated on every runner; a validation miss
re-dispatches once with corrective feedback before the unit is recorded as
failed.

## Gates and verification

**Gates judge the artifact; `max_loops` bounds the retry.** Under
`akm workflow run`, a step with a body `### gate` rubric is gated on its
**artifact**, not on engine prose: the judge receives the step's artifact as
canonical JSON (clipped at 4000 characters) alongside the `### gate` section
byte-exact, so the gate evaluates real results rather than a machine summary
like "Executed 3 units". Each engine-driven gate evaluation is itself an LLM
call and is journaled as its own unit row.

`gate.max_loops: <n>` (frontmatter) turns the gate into a bounded
evaluator-optimizer loop: on a rejection (or a typed-artifact schema
mismatch) with loop budget left, the engine re-executes the step's units
with the gate feedback and the missing-criteria list appended as attached
context. The feedback changes each unit's inputs, so the re-run naturally
dispatches fresh units instead of replaying journaled results. When the loop
budget is spent, the rejection stands exactly as in the one-shot case.

**Fail-closed verification.** With no non-empty `### gate` rubric, no
verification runs. When a rubric is present, the workflow requires
`workflow.judgeEngine` to name a configured LLM or agent engine before the
plan can be frozen — see
[Author's Guide: Troubleshooting](https://github.com/itlackey/akm/blob/main/docs/guides/author-workflows.md#troubleshooting)
if that engine isn't configured yet. That verifier invocation is frozen into
the run.

Only a well-formed `complete: true` verdict advances a criteria-bearing step.
A missing verifier, dispatch failure, or malformed result rejects the gate
instead of silently bypassing it. A well-formed `complete: false` verdict
returns its missing criteria and feedback and can trigger another bounded
`max_loops` attempt.

## Budget ceilings

The top-level `budget:` key declares run-lifetime ceilings: `max_units`
(total dispatched units) and `max_tokens` (total reported token usage). Both
counters are seeded from the unit journal, so they measure the **whole run
across resumes**, not just the current invocation. Hitting a ceiling aborts
the step's still-pending dispatches and fails the step with a
`budget exceeded (<which> ceiling)` summary — budget exhaustion is a hard
stop that ignores `on_error: continue`. Because the plan is frozen, raising a
budget means starting a new run.

## Model references

Reference semantic aliases in `model:` fields instead of exact model ids so a
workflow stays harness-agnostic. Recommended vocabulary (convention, not
hardcoded) via the config-root `modelAliases` key:

```jsonc
{
  "modelAliases": {
    "fast":     { "llm": "claude-haiku-4-5", "*": "claude-haiku-4-5" },
    "balanced": { "llm": "claude-sonnet-4-6", "*": "claude-sonnet-4-6" },
    "deep":     { "claude": "claude-fable-5", "opencode": "opencode/claude-fable-5", "*": "claude-fable-5" }
  }
}
```

For an LLM engine, resolution checks its engine-name column, then `llm`, then
`*`. Agent engines check their harness platform and then `*`. The built-in
aliases `fable`, `opus`, `sonnet`, and `haiku` resolve per platform with no
config. See the [Author's Guide](https://github.com/itlackey/akm/blob/main/docs/guides/author-workflows.md#choosing-engines-and-models)
for guidance on which tier to pick per step.

## See also

- [Running Workflows](https://github.com/itlackey/akm/blob/main/docs/guides/run-workflows.md) — operating a run day to day
- [Author's Guide: Writing Workflows](https://github.com/itlackey/akm/blob/main/docs/guides/author-workflows.md) — a task-oriented walkthrough
- [Architecture: The Workflow Engine](https://github.com/itlackey/akm/blob/main/docs/architecture/workflow-engine.md) — persistence, dispatch, and resume internals
- [CLI Reference](cli.md) — full flag documentation for `workflow` and `lint`
