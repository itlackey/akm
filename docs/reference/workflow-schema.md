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
  optional dispatch-override bag (`exec`, `engine`, `model`, `llm`, `timeout`,
  `retry`, `on_error`, `env`, `isolation`; see
  [Exec (shell) units](#exec-shell-units),
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
  step's own `output` schema describes a reduced, single-value shape instead;
- an [exec unit](#exec-shell-units) → its stdout (trailing newlines stripped),
  or the JSON value stdout parsed to when the unit declares an `output` schema.

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
`maximum`, `allOf`, `anyOf`, `oneOf`, `not`.

Anything outside it is an authoring **error**, not a silent no-op. A typo'd
type name (`type: strig`) and a recognized-but-unenforced keyword (`$ref`,
`$defs`, `const`, `pattern`, `format`, `patternProperties`, `if`/`then`/`else`,
`uniqueItems`, `multipleOf`, `exclusiveMinimum`/`exclusiveMaximum`,
tuple-form `items`, schema-form `additionalProperties`, …) both fail with the
offending keyword named, a suggested replacement where one exists (`const` →
a single-value `enum`; `$ref` → inline the schema), and the location anchored
to the line. A gate that depends on a schema constraining nothing is worse
than a loud failure. Annotation keywords (`description`, `title`, `default`,
`examples`) constrain nothing in full JSON Schema either, so they pass through
untouched.

`pattern` is among the unsupported keywords. Matching an author-supplied regex
inside a synchronous gate decision would have to be bounded before the match
starts — a static safety analysis — and any such analysis also refuses regexes
authors legitimately write. Rather than carry machinery that fails authoring
for no benefit, the subset does not evaluate `pattern` at all and says so at
the point of authoring. Where a string's shape matters, list the allowed values
with `enum`, bound its size with `minLength`/`maxLength`, or check the shape in
the step's gate rubric, which can explain a mismatch in a way a regex cannot.

Evaluation is bounded: schema nesting is capped at 64 levels and one validation
may make at most 100 000 checks. Exhausting either is reported as an error — a
truncated evaluation never reports a value as valid.

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
| parse errors reported | first 50, then a `... N more errors not shown` trailer |

`timeout` is resolved **once, at freeze time**, and the frozen value is what
dispatch applies — there is no separate engine-side ceiling on top of it. The
first of these that is set wins: the unit's `timeout`, then the document's
`defaults.timeout`, then `engines.<name>.timeoutMs`, then the engine-kind
default — **10m for `kind: llm` engines, and none for agent engines**, which
manage their own process lifetime. Writing `timeout: none` is an explicit opt
out and leaves the unit genuinely unbounded; nothing later re-imposes a cap.

## Exec (shell) units

A step whose `unit:` block declares `exec:` runs a **shell command** instead of
dispatching to an engine. Deterministic work — running the test suite, building,
linting, copying a file, invoking a script — is a command, not a prompt, and
paying for an LLM or agent dispatch to get it done buys nondeterminism, latency,
and tokens in exchange for nothing.

```yaml
steps:
  - id: test
    unit:
      exec:
        command: ["bun", "run", "test:unit"]
        cwd: packages/core        # optional, relative
      timeout: "10m"
      retry: { max: 1, on: [timeout] }
```

An exec unit names **no engine**. It carries no `engine`, `model`, or `llm` (the
parser rejects those alongside `exec:`), it consumes no tokens, and a workflow
made only of exec steps freezes and runs on an install with no engine configured
at all. Everything else about a unit still applies unchanged: `timeout`, `retry`,
`on_error`, `output`, `env`, `isolation`, `map` fan-out and its concurrency, the
unit journal, budget accounting, and replay/reuse.

The step's body prose is still required (it is the step's section, like any
other unit step) and is **not** passed to the command — it documents what the
command does, for the human reading the workflow.

### `command` is an argv array, never a shell string

There is deliberately **no shell-string spelling**. The child is spawned
directly, so nothing ever parses the words: `;`, `|`, `&&`, `$(…)`, backticks,
`>`, and `*` inside an argument are inert literal bytes. The entire
quoting/injection class a `sh -c "<string>"` surface opens is *structurally
absent*, not defended against — a value that happens to contain `; rm -rf /`
is one argument containing those characters, and always was.

If you genuinely want a pipeline or a shell builtin, name the interpreter
yourself:

```yaml
        command: ["bash", "-lc", "bun run build | tee build.log"]
```

That is allowed and sometimes right — but it is now a visible, reviewable line
in the frontmatter diff rather than something the format did for you silently.

Bounds: 1–64 argv entries, each a non-empty string of at most 4096 bytes.

### `cwd`

Optional and **relative**. It resolves inside the unit's working directory —
the engine invocation's working directory normally, or the unit's fresh
detached worktree under `isolation: worktree`. Absolute paths, Windows drive
letters, `~`, and `..` segments are rejected by the parser *and* by the
frozen-plan decoder, and containment is re-checked against the *resolved* base
(symlinks included) immediately before the command is spawned. An exec unit
cannot step outside the tree its isolation promised.

### The output rule

- **No `output:` schema** → the artifact is the command's **stdout**, with
  trailing newlines stripped (exactly like shell `$(…)`). Empty stdout follows
  the ordinary [empty-output rule](#what-a-steps-output-is): it is treated as
  *no output*.
- **With an `output:` schema on the unit** → stdout must be **exactly one JSON
  value** (surrounding whitespace tolerated, nothing else), which is parsed and
  validated against the schema. This is a *strict* parse, unlike the forgiving
  embedded-JSON scan used for model output: a command that claims a schema
  prints JSON, and log noise that happens to contain a JSON object must never
  be promoted as the artifact. Non-JSON stdout fails as `parse_error`; JSON that
  misses the schema fails as `validation_error`.
- **stderr is never part of the artifact.** It is a diagnostic channel: the tail
  of a failed command's stderr is included (clipped, redacted) in the unit's
  failure diagnostic and its journal row. Because a failing command's stderr is
  frequently the *only* explanation of the failure, that diagnostic is durable —
  it survives to `akm workflow status --units` and to the step's summary in the
  run output, not just to the in-memory result. It is clipped to 2000 characters
  and goes through the same redaction contract as everything else journaled.
- **Retained output is bounded at 8 MiB per stream.** akm keeps at most that much
  of stdout and of stderr; past the cap it keeps *reading* and discards, so the
  command still runs to completion and its exit code still decides the unit. See
  [Output limits](#output-limits) — the artifact is then explicitly marked
  truncated, never silently shortened, and only a unit with a declared `output:`
  schema fails for it.
- **An incomplete capture is a failure, not a partial artifact.** Exiting 0 is
  not on its own proof that stdout was fully read: a pipe can error, and a
  background descendant that keeps the stdout handle open after the command
  leader exits will hold the pipe past the drain deadline. Either way the
  captured text is a *prefix* of the real output, so the unit fails
  `spawn_failed` (the same reason the agent-dispatch path reports for the same
  condition) rather than promoting the prefix. If you hit this, have the command
  wait for its children or redirect their output.

Note that a schema failure is **not** retried by the corrective-feedback loop
that model units use. Re-prompting is meaningless to a fixed argv — the same
command cannot produce different output — but re-running it *can* deploy twice.
A declared `retry:` still applies, because that is a policy you opted into per
failure reason.

### Exit codes and failure reasons

| Outcome | `failure_reason` | In `retry.on`? |
| --- | --- | --- |
| exit 0 | — (unit succeeds) | — |
| non-zero exit | `non_zero_exit` | yes |
| exceeded `timeout` | `timeout` | yes |
| run cancelled (`Ctrl-C`, `--timeout`, budget) | `aborted` | yes |
| binary missing / working directory unusable | `spawn_failed` | yes |
| output capture never completed | `spawn_failed` | yes |
| stdout past the retention limit, **and** the unit declares `output:` | `exec_output_limit` | **no** (deterministic) |
| stdout past the retention limit, no `output:` schema | — (unit succeeds; artifact marked truncated) | — |
| `AKM_*` context too large for **this platform** to spawn | `exec_context_too_large` | **no** (an authoring/data problem) |
| `cwd` resolved outside its base | `exec_cwd_escape` | **no** (tampering, never transient) |

A non-zero exit is an ordinary unit failure, so it flows through the ordinary
policy: with the default `on_error: fail` it fails the step and the run — which
is exactly what makes a `test` step a **gate**. With `on_error: continue` the
failure is recorded in the step's evidence and the completion gate decides.

On timeout or cancellation the child's whole **process group** gets a
SIGTERM→SIGKILL ladder, so a command that spawned its own children does not
leave them orphaned.

### Output limits

akm captures the command's stdout and stderr into memory — stdout *is* the
artifact — so it **retains** at most **8 MiB** of each stream.

This is a cap on akm's memory, not on your command. Past the cap akm keeps
reading the pipe and throws the extra bytes away, so the command never blocks on
a full pipe: it runs to completion and **its exit code is what decides the
unit**. A chatty-but-passing test suite is not failed for its log volume.

What overflow does cost is honesty about the artifact, and that depends on what
the unit promised:

| The unit declares… | On overflow |
| --- | --- |
| no `output:` schema | the unit **succeeds** (given exit 0). Its artifact is the retained first 8 MiB with a `__akm_exec_output_truncated__` block appended, naming the bytes written and the bytes retained. |
| an `output:` schema | the unit **fails** `exec_output_limit` and **nothing is promoted**. |

Nothing is ever truncated *silently*. The marker block is the last thing in the
artifact, so a downstream `steps.<id>.output` reference, a completion gate's
judge, and a human reading `akm workflow status` all see plainly that the text is
incomplete. Truncated data can never be mistaken for complete data — that is the
rule, and the marker is how it is kept.

The schema case stays a failure because a truncated prefix is not a JSON value:
with `output:` declared, stdout must parse as exactly one JSON value, so there is
nothing to validate and nothing safe to promote. `exec_output_limit` is therefore
still outside the `retry.on` vocabulary — the command is deterministic, so
re-dispatching it can only spend the budget to produce the same oversized output
again.

stderr overflow never fails anything. stderr is a diagnostic channel; the journal
already clips and marks what it keeps.

The cap is generous (8× the 1 MiB evidence-persistence cap), so an ordinary build
or test log is nowhere near it. If a command legitimately produces more and you
want the whole thing, have it write to a file and print the **path**:

```yaml
        command: ["bash", "-lc", "bun run build > build.log 2>&1; echo build.log"]
```

### Context reaching the command

A frozen argv is never interpolated (this format has no substitution language),
so data reaches an exec unit as **environment**, the argv analogue of the
context blocks a model unit gets in its prompt:

| Variable | Value |
| --- | --- |
| `AKM_RUN_ID`, `AKM_STEP_ID`, `AKM_UNIT_ID` | ids of this dispatch |
| `AKM_PARAMS` | the run params, canonical JSON |
| `AKM_ITEM`, `AKM_ITEM_INDEX` | a `map` unit's item (canonical JSON) and 0-based index |
| `AKM_INPUTS` | the step's declared `inputs:` artifacts, keyed by reference string |

These are applied *after* your `env:` bindings, so a binding can never shadow
them.

#### Context size limits

An environment variable is an operating-system object with a hard ceiling, and a
workflow artifact has no comparable bound — so a perfectly legitimate declared
input can grow past what **process creation itself** accepts. akm therefore
bounds what it puts in the child's environment, **against the ceiling of the
platform the run is actually on**:

| Bound | Linux / macOS / BSD | Windows |
| --- | --- | --- |
| One `AKM_*` context variable | 98 304 bytes (96 KiB) | 32 767 bytes |
| All `AKM_*` context variables combined | 131 072 bytes (128 KiB) | 64 000 bytes |

Where those numbers come from:

- **Linux** caps a single `argv`/`environ` string at `MAX_ARG_STRLEN`, defined as
  `32 * PAGE_SIZE` — 131 072 bytes. The 96 KiB bound leaves 32 KiB of margin for
  the variable's name, the `=`, the `NUL`, and the kernel's own accounting.
- **macOS** has no per-string cap; its binding constraint is `ARG_MAX`
  (262 144 bytes) over `argv` + `environ` *combined*. The 128 KiB total keeps
  akm's own contribution to half of that, leaving the rest for the argv, the
  environment allowlist and your `env:` bindings.
- **Windows** caps a single user-defined environment variable at 32 767
  characters (`SetEnvironmentVariable`), and the environment block has limits of
  the same order.

Crossing either bound fails the unit `exec_context_too_large` **before anything
is spawned**, with an error naming the variable, its actual size, this platform's
limit and where that number comes from. That translation is the check's *only*
job: without it the same workflow dies inside the spawn syscall with a bare
`E2BIG` ("argument list too long") that names neither the variable nor the step
that produced the data.

Because that is its only job, the check uses **this** platform's ceiling rather
than the smallest supported one. A guard that applied Windows' 32 767-byte limit
on Linux would refuse spawns the kernel would happily have accepted — inventing a
failure instead of explaining an inevitable one.

> **Portability guidance (not enforcement).** If a workflow is meant to run on
> Windows as well, keep `AKM_*` context under **32 767 bytes per variable**. akm
> will not fail your Linux or macOS run for exceeding that — but a Windows runner
> will. The fix in both cases is the same: emit a reference instead of bulk data.

If you hit this, have the producing step emit a **reference** — a file path, an
id, a key — instead of inline bulk data:

```yaml
  - id: extract
    unit:
      exec:
        command: ["bash", "-lc", "./extract.sh > /tmp/rows.json; echo /tmp/rows.json"]
  - id: load
    inputs: [steps.extract.output]      # a PATH, not the rows
    unit:
      exec:
        command: ["./load.sh"]
```

akm deliberately does **not** transparently spill an oversized context to a file
and pass a path instead. That would make the `AKM_INPUTS` contract conditional
on the size of the data — sometimes JSON, sometimes a filename — so every
command would have to handle both shapes, and the spill file would have to be
placed, isolated and cleaned up inside a unit's worktree. A stable contract plus
an explicit error is the smaller, more predictable surface.

### The child's environment is an allowlist

An exec unit's command does **not** inherit akm's environment. The child starts
from an **empty** environment and is built in three layers, in this order:

1. the **default allowlist** below, copied through from akm's own environment
   (plus any names the unit adds with `pass_env:`);
2. the unit's resolved **`env:` bindings**;
3. the engine-authored **`AKM_*` context** — last, so a binding can never
   shadow it.

The default allowlist is exactly these names (a name absent from akm's own
environment is simply absent from the child):

| Group | Names | Why |
| --- | --- | --- |
| Command resolution | `PATH` | without it only an absolute `command[0]` can be spawned |
| Home | `HOME` | the config/cache root git, npm, bun, cargo and ssh all read |
| Identity | `USER`, `LOGNAME`, `SHELL` | read by git/ssh and by tools that re-exec a login shell |
| Locale | `LANG`, `LC_ALL`, `LC_CTYPE` | without a locale, non-ASCII stdout — *which is this unit's artifact* — gets mangled |
| Terminal / clock | `TERM`, `TZ` | some CLIs abort with no `TERM`; `TZ` keeps printed timestamps stable |
| Scratch space | `TMPDIR`, `TEMP`, `TMP` | POSIX and Windows temp roots |
| Windows essentials | `SystemRoot`, `SystemDrive`, `WINDIR`, `COMSPEC`, `PATHEXT` | Windows **process creation itself** fails with an empty environment; `PATHEXT` is what makes `bun.exe`/`bun.cmd` resolvable at all |
| Windows home/config | `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `ProgramData`, `ProgramFiles` | the Windows analogues of `HOME` and the machine-wide install roots toolchain shims resolve against |
| akm provenance | `AKM_EVENT_SOURCE` | a command that calls `akm` records machine traffic, not user demand |

`PATH` is additionally supplemented with well-known user binary directories
when akm is running in a scheduler context (cron/launchd/Task Scheduler) that
stripped it — the same treatment an agent-harness child gets.

Deliberately **not** on the list: credentials of any kind, cloud/CI variables,
and the proxy family (`HTTP_PROXY` and friends — proxy URLs routinely embed
credentials). Reach them with `pass_env:`, an `env:` binding, or `inherit_env:`.

#### `pass_env:` — widen the allowlist by name

```yaml
    unit:
      exec:
        command: ["cargo", "build", "--release"]
        pass_env: [CARGO_HOME, SCCACHE_DIR]
```

Names only, 1–32 of them, matching `^[A-Za-z_][A-Za-z0-9_]*$`. Use it for a
**per-machine** variable an `env:` binding cannot express — an env asset stores
a committed *value*, so it cannot carry "whatever this build agent's
`CARGO_HOME` happens to be".

Values passed through this way are **not** redacted from the command's output
the way `env:` binding values are, so never list a credential here.

#### `inherit_env:` — opt back into full inheritance

```yaml
    unit:
      exec:
        command: ["./scripts/deploy.sh"]
        inherit_env: true
```

`inherit_env: true` gives the command akm's **entire** environment, verbatim —
what it would see if you had typed it yourself in the shell that ran
`akm workflow run`. Reach for it when a command genuinely needs the
caller's whole environment (a wrapper script, a toolchain with many ambient
variables) and enumerating names would be a losing game. Prefer `pass_env:` or
`env:` bindings when you can, because those keep what the command can see
visible in the frontmatter diff.

Both keys are **dispatch-significant**: they change what the command can see,
so both are part of the unit's input hash. Changing either re-dispatches the
unit rather than reusing a journaled row produced under the other scope.

### What `akm show` reports for an exec step

`akm show <workflow> --format json` summarizes each step under
`steps[].orchestration`. For an exec step that summary carries an `exec` object
and **no `engine`/`model`** — an exec unit names no engine, so reporting the
workflow's `defaults.engine` there would describe a dispatch that never
happens. Field presence is the discriminator, the same way `fanOut` marks a
`map` step and `route` marks a route step:

```json
{
  "id": "test",
  "title": "test",
  "instructions": "Run the unit tests.",
  "orchestration": {
    "timeoutMs": 600000,
    "exec": {
      "command": ["bun", "run", "test:unit"],
      "cwd": "packages/core",
      "passEnv": ["CARGO_HOME"],
      "inheritEnv": true
    }
  }
}
```

- `command` is the argv **in full, never clipped** — the point of the field is
  that what `show` prints is what runs, and a truncated argv would be the same
  misdescription in miniature. It is safe to print because it is authored
  literally in the asset: this format has no substitution language, so no part
  of it is resolved from your environment, from a secret ref, or from a prior
  step's output. Every byte is already visible in the workflow file (and stored
  verbatim in `plan_json`) — which is also why you never inline a secret there.
- `cwd`, `passEnv` and `inheritEnv` appear only when the unit declares them.
  `passEnv` is a list of variable **names**; no value is ever projected.
- `timeoutMs` is still reported, because an exec unit really does inherit
  `defaults.timeout` — that number is true for it.

Everything else in the summary is unchanged: a `map` of exec units carries both
`fanOut` and `exec`, and `hasSchema`/`env` mean what they mean for any unit.

### Security

Exec units sit inside the existing workflow trust model — see
[Security: workflow sources are executed code](https://github.com/itlackey/akm/blob/main/docs/guides/run-workflows.md#security-workflow-sources-are-executed-code).
They do not widen it, and they do not narrow it:

- **The child's environment is an allowlist, not an inheritance.** Be clear
  about what that does and does not buy. It does *not* stop a determined
  attacker: a command that runs at all can read the same credentials off disk
  that the environment would have handed it, and a workflow source is executed
  code either way. What it does buy is real but narrower — it bounds
  **accidental** exposure (the shell or CI job that invoked `akm` routinely
  exports tokens for unrelated services, and a third-party step that merely
  prints its environment, or a tool that ships one in a crash report, should
  not get them for free), it makes the environment surface **explicit and
  reviewable** (this list plus lines in the frontmatter diff, rather than
  "whatever the invoking shell happened to export"), and it **matches the
  convention akm already applies to spawned children** — agent-harness children
  have always been built from `envPassthrough` this way, and exec units now use
  the same mechanism rather than a second one. Operators who need a harder
  boundary still scope the *akm process* (dedicated account, ephemeral working
  directory, external network/filesystem policy); that is the boundary that
  actually holds.
- **Secrets come from `env:` bindings by name.** The frozen plan carries only
  the ref names, the replay hash carries only the ref names, and the resolved
  values are collected and scrubbed out of stdout, stderr, and the failure
  diagnostic by the same redaction contract every other dispatch uses — before
  anything is journaled. Never inline a secret into `command:`; argv is stored
  verbatim in `plan_json`.
- **Read a workflow before you run it.** `exec:` makes what a workflow will run
  explicit and auditable in one place, which is a real improvement over
  instructing a model to "run the tests" — but a bundle you do not trust is
  still a stranger's script.

## Fan-out and concurrency

A `map` step is a fan-out: it expands `over:` into one unit per item, runs
those units, and folds the results with its `reducer`. The units are
independent by construction — no unit can read another's result — so they run
**in parallel by default**.

### The default

**Since 0.9.1, a `map` step that declares no `concurrency:` freezes a width of
4.** (Before 0.9.1 it froze 1, so every fan-out ran one item at a time unless
the author opted in.) 4 rather than "as wide as the machine allows" is
deliberate: it is a predictable 4× on any fan-out longer than four items, it
stays under the host CPU cap on any machine with 6 or more cores, and it is a
number an author can reason about without knowing which box the run lands on.

Three ways to change it:

| You want | Write |
| --- | --- |
| A specific width for one step | `map.concurrency: <n>` in that step |
| **Serial execution for one step** | `map.concurrency: 1` |
| A different default for every workflow on this machine | `akm config set workflow.defaultMapConcurrency <n>` |

`concurrency: 1` is a real, honored opt-out, not the absence of a value: an
authored `1` is kept distinct from an unset field, and it always beats the
config default. Set `workflow.defaultMapConcurrency` to `1` to restore the
pre-0.9.1 serial-by-default behavior everywhere at once.

A step with no `map:` is one unit, not a fan-out. It is unaffected by any of
this.

### The four limits

The width a step really runs at is the **minimum** of four independent values.
Raising one never raises the others:

| Limit | Set by | Default when unset |
| --- | --- | --- |
| `map.concurrency` | the step | `workflow.defaultMapConcurrency`, else **4** |
| `execution.maxConcurrency` | `workflow.maxConcurrency` config | CPU-derived `min(16, max(1, cores − 2))` |
| the selected LLM engine's concurrency | `engines.<name>.concurrency` | **1** for a loopback endpoint, **4** for a remote one |
| the host CPU safety cap | nothing — reapplied at dispatch | `min(16, max(1, cores − 2))` |

The engine limit is per **endpoint kind** on purpose. A local model server (LM
Studio, Ollama) has one loaded model, and concurrent inference makes it reload
and return HTTP 500 — a hard failure, so loopback endpoints stay at 1 and a
`map` against a local model is still effectively serial unless you raise
`engines.<name>.concurrency` yourself. Remote providers fail softly (a
retryable 429), and four concurrent completions is well inside any hosted
provider's entry tier. Agent engines carry no concurrency limit of their own —
except an `opencode-sdk` engine with an `llmEngine` fallback, which inherits
that fallback engine's limit.

#### What counts as a loopback endpoint

The whole loopback space, not one address:

| Recognized | Examples |
| --- | --- |
| all of `127.0.0.0/8` | `http://127.0.0.1:1234`, `http://127.0.0.2:11434` |
| `localhost` and any `*.localhost` name | `http://localhost:1234`, `http://lmstudio.localhost` |
| IPv6 `::1`, in any spelling | `http://[::1]:1234`, `http://[0:0:0:0:0:0:0:1]:1234` |
| the IPv4-mapped forms of `127.0.0.0/8` | `http://[::ffff:127.0.0.1]:1234` |
| the unspecified addresses (a client connecting there reaches loopback) | `http://0.0.0.0:11434`, `http://[::]:11434` |

`127.0.0.2` matters in practice: running a second LM Studio or Ollama on
another address inside the `127.0.0.0/8` block is ordinary, and that server is
exactly as single-model as one on `127.0.0.1`.

The check is **purely syntactic — it never resolves a name.** A frozen plan has
to come out the same on your laptop, on CI, and on a machine with no network at
all, and a DNS lookup would make the frozen width depend on what a resolver
happened to answer. So a *name* that resolves to loopback (a hosts-file alias,
`host.docker.internal`, an internal DNS record) is treated as **remote**; point
the engine at the address itself, or set `engines.<name>.concurrency: 1`
explicitly. In the other direction the classification is deliberately
conservative: an endpoint akm cannot parse at all is treated as loopback, since
freezing 4 for a config it does not understand is the failure worth avoiding.

The host cap is re-derived from the CURRENT machine at every dispatch, not
frozen. A plan frozen on a 32-core CI box narrows itself when it resumes on a
4-core laptop.

### Frozen widths

Every one of these numbers except the host cap is resolved **once, when the run
starts**, and stored in the run's plan. Editing config, upgrading akm, or
changing the defaults above never alters a run that is already in flight or
being resumed — it keeps the widths it froze. The new defaults apply only to
runs started after the upgrade.

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
  attempt is journaled separately. For an
  [exec unit](#exec-shell-units) a non-zero exit is `non_zero_exit`, a
  wall-clock expiry is `timeout`, and a failure to start is `spawn_failed`.

A unit's `output` schema is validated on every runner; a validation miss
re-dispatches once with corrective feedback before the unit is recorded as
failed. Exec units are the one exception: a fixed argv cannot answer feedback,
so a schema miss fails immediately rather than re-running a side-effecting
command (see [The output rule](#the-output-rule)).

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
