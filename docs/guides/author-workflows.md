# Author's Guide: Writing Workflows

This guide walks through writing and testing a workflow definition: the
Markdown structure, a minimal complete example, common authoring mistakes,
and how to verify gates and outputs before you publish. It assumes you
already know what a workflow is; for the exhaustive, exact-syntax reference
— every frontmatter key, the reference grammar, gates, and outputs — see
[Workflow Schema](../reference/workflow-schema.md). For operating a run once
it's written, see [Running Workflows](../guides/run-workflows.md).

## Start from the template

A workflow is a Markdown file: OKF-conformant frontmatter carries the
orchestration graph and the body carries instructions and gate rubrics.

Use `akm workflow create --print` to print a valid starter, then edit it and
register it with `akm workflow create`. Validate with `akm lint`:

```sh
akm workflow create my-release --print   # Print the template, without writing
akm workflow create my-release --from ./my-release.md
akm lint --type workflows                # Check for structural errors before using it
```

Markdown is the only workflow format. The GitHub-shaped `.yml` format was
removed in 0.10: a `.yml` file under `workflows/` is skipped at index time with
a warning that it must use `.md`.

## A minimal complete example

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

Walking through it: `validate` and `build` are both bare unit steps — neither
declares `unit:` or `map:`, so each is "still a unit step," the
minimal declaration. `build` names `steps.validate.output` in `inputs:`, so
the engine attaches `validate`'s result to `build`'s dispatched context, and
`build`'s own re-dispatch on a resumed run is keyed to that exact slice — not
the whole run. `validate` has a `### gate`; `build` does not, so `build`
completes as soon as its unit succeeds, with no verification pass.

For a richer example — fan-out with `map`, retries,
and a run `budget` — see
[Workflow Schema: Richer example](../reference/workflow-schema.md#richer-example).

## Deterministic steps: run a command, gate on it

Not every step needs a model. Running the test suite, building, linting, or
invoking a script is *deterministic work*: there is exactly one right answer and
the command already knows it. A step whose `unit:` declares `exec:` runs that
command directly — no LLM, no agent, no tokens, no nondeterminism.

The canonical shape is a **test step that gates the rest of the run**:

```markdown
---
type: workflow
description: Fix a failing test, then verify the suite is green
params:
  failure: { type: string, description: The failing test name or error }
steps:
  - id: fix
  - id: test
    inputs: [steps.fix.output]
    unit:
      exec:
        command: ["bun", "run", "test:unit"]
      timeout: "10m"
      retry: { max: 1, on: [timeout] }
  - id: report
    inputs: [steps.test.output]
---

# Fix and Verify

## fix

Find the cause of the failure described in the run parameters and fix it.
Explain what you changed and why.

## test

Run the unit test suite. This step is deterministic: the command's exit code
decides whether the run continues.

## report

Summarize the fix and the test results attached to this unit.
```

What this buys you:

- **The suite is the gate.** `test` uses the default `on_error: fail`, so a
  non-zero exit fails the unit with `non_zero_exit`, fails the step, and stops
  the run before `report` ever dispatches. No judge, no rubric, no prompt — the
  exit code is the verdict.
- **The output is real.** `steps.test.output` is the command's stdout (trailing
  newlines stripped), so `report` receives the actual test output rather than a
  model's recollection of it.
- **It costs nothing.** No tokens, no latency beyond the command itself, and the
  same input always produces the same dispatch.
- **It resumes correctly.** A completed exec unit is journaled like any other; a
  resumed run reuses the row instead of re-running the suite.

### Getting a typed result instead of raw text

If the command can print JSON, declare an `output` schema on the unit and the
step artifact becomes a validated structure:

```yaml
  - id: test
    unit:
      exec:
        command: ["bun", "run", "test:unit", "--reporter=json"]
      output:
        type: object
        required: [passed, failed]
        properties:
          passed: { type: number }
          failed: { type: number }
```

stdout must then be **exactly one JSON value** — no log noise around it — and
downstream steps can address `steps.test.output.failed`.

### Agent in, exec out

A common pair is an agent step that writes something and an exec step that
acts on it. Give each unit its own `output` schema:

```yaml
steps:
  - id: draft
    unit:
      output:
        type: object
        required: [status, markdown]
        additionalProperties: false
        properties:
          status: { type: string, enum: [done, blocked] }
          markdown: { type: string, minLength: 1 }
  - id: publish
    inputs: [steps.draft.output]
    unit:
      exec:
        command: ["node", "publish.mjs"]
      output:
        type: object
        required: [posted]
        properties:
          posted: { type: boolean }
```

The command is an argv array, so nothing is spliced into it. `publish.mjs`
reads the draft from `AKM_INPUTS`, a JSON object keyed by each `inputs:`
reference string exactly as written, and prints one JSON value that matches
its own `unit.output`:

```js
const inputs = JSON.parse(process.env.AKM_INPUTS ?? "{}");
const draft = inputs["steps.draft.output"];
// ...post draft.markdown; log to stderr, never stdout...
process.stdout.write(JSON.stringify({ posted: draft.status === "done" }));
```

The rule: a **unit schema** (`unit.output`) types that unit's result. A
**step schema** (step-level `output:`) validates the promoted step artifact,
which for a `map` step is the reducer's result. On a solo step with no
`unit.output`, a step-level `output:` is also used as the unit's schema;
writing it under `unit:` says so explicitly.

An agent that cannot do the work still "succeeds": it returns something that
fits the schema, such as `status: blocked`, and the step completes. If the run
must stop when the work was not done, make the unit schema require evidence
of the work, such as a required non-null string with `minLength: 1` (a URL, a
path, a commit id) that the agent can only fill by doing it.

### What the command can see

The command inherits your environment, as it would typed in your shell: `PATH`,
`HOME`, the toolchain variables and any credential of the process that ran `akm
workflow run` reach it. Then come your `env:` bindings, then the `AKM_*` context
variables. Ordinary commands (`bun`, `git`, `make`, `cargo`) work unchanged.

```yaml
  - id: build
    unit:
      env: [env/build]
      exec:
        command: ["cargo", "build", "--release"]
```

Fixed values belong in exact named `env:` bindings, and they reach the journal as
they are. A credential belongs in `secrets/`, bound by a `${secrets/name}` token
inside the env asset; only values substituted from such a ref are redacted out of
everything journaled (see [Binding a secret to a
unit](../reference/workflow-schema.md#binding-a-secret-to-a-unit)). A value the
command inherited is not redacted.

`exec.pass_env:`, the list of names an earlier release copied into an otherwise
empty environment, still parses and selects nothing. Workflow starts freeze the
durable plan v4 family's current executable format (`irVersion: 8`), which
rejects `inherit_env`; the command inherits the environment without it.
Pre-`irVersion`-5 stored plans do not execute; start a new run after updating the
source.

Named bindings are part of the unit's input hash, so changing them re-runs the
command instead of reusing a row recorded under another scope. What the command
sees is described under [Workflow Schema: The child's
environment](../reference/workflow-schema.md#the-childs-environment).

### Using scripts, env and secrets from other bundles

A workflow in one bundle can run a script from a second bundle, with an env
asset from a third that names a secret in a fourth. Each is addressed by its akm
ref, `[bundle//]conceptId`, inside a `${...}` token:

```yaml
  - id: status
    unit:
      env: [ci//env/status]                       # env/status.env in bundle ci
      exec:
        command: ["bun", "${tools//scripts/lab-status/fetch.ts}"]
```

```sh
# env/status.env in bundle ci
REGION=east
TOKEN=${vault//secrets/status_token}
```

`${tools//scripts/...}` becomes the script's absolute path when the unit
dispatches, `${vault//secrets/status_token}` becomes the secret's value, and
`REGION` reaches the child as it is. Nothing in the plan records where any of
them lives, so updating a bundle in the middle of a run is harmless. The unit
runs in the root of the bundle that holds the workflow (`cwd:` is relative to
it, or absolute). See [Workflow Schema: The exec
contract](../reference/workflow-schema.md#the-exec-contract).

### Things to get right

- **`command:` is an argv array, not a shell string.** `["bun", "run", "test"]`,
  never `"bun run test"`. Nothing is shell-parsed, which is what makes it safe;
  if you truly need a pipeline, write `["bash", "-lc", "a | b"]` and own that
  choice explicitly.
- **No interpolation of run data.** The argv is frozen as authored; the only
  substitution is a `${ref}` token naming an asset. A `map` step's item reaches
  the command as `AKM_ITEM` (canonical JSON) and the run params as `AKM_PARAMS` —
  read them from the environment, do not try to splice them into `command:`.
- **Secrets go in `secrets/`, bound through `env:`, never as literals in
  `command:`.** `command:` is stored as authored in the frozen plan; `env:` bindings are carried
  by name, and values substituted from a `${secrets/name}` ref are redacted out
  of everything journaled.
- **Long commands need a `timeout:`.** An exec unit defaults to 10 minutes. Use
  `timeout: "30m"` for a slow suite, or `timeout: "none"` only when you really
  mean unbounded.
- **The command has your shell's environment, so a credential in it reaches
  it.** Use a named `env:` binding for a fixed or secret value you want redacted
  from the journal; a value the command inherited is not redacted.
- **A very chatty command still passes; its artifact just says so.** akm retains
  8 MiB of stdout and 8 MiB of stderr. Past that it keeps draining and discards,
  so the command runs to completion and its exit code decides the step. The
  artifact is then the retained head with a `__akm_exec_output_truncated__` block
  appended, so nothing downstream can mistake it for the whole output. The one
  case that still *fails* is a unit with a declared `output:` schema — a
  truncated prefix is not one JSON value, so there is nothing to validate.
- **Bulk data reaches a command as a path, not as an environment variable.**
  `AKM_INPUTS` / `AKM_PARAMS` / `AKM_ITEM` are bounded by what *process creation*
  accepts on the current platform (96 KiB per variable on Linux/macOS, 32 767
  bytes on Windows). Over that, the unit fails `exec_context_too_large` before
  anything is spawned. If a workflow must also run on Windows, keep context under
  the Windows number — akm will not enforce it on your Linux box, but a Windows
  runner will.

Full reference: [Workflow Schema: Exec (shell) units](../reference/workflow-schema.md#exec-shell-units).

## Common authoring mistakes

- **Templating prose.** There is no `${{ … }}`/`{{ … }}` interpolation
  anywhere in a workflow body. Write instructions in plain language that
  refer to attached context — "using the intake step's artifact attached to
  this unit" — never by splicing a value into the string. See
  [Workflow Schema: The reference grammar](../reference/workflow-schema.md#the-reference-grammar).
- **Mismatched or missing step headings.** Every `## <step-id>` must match a
  step declared in frontmatter exactly — no titles, no `Step:`/`Step ID:`
  lines, no `# Workflow:` prefix on the H1.
- **A `unit`/`map` step with no body section.** Its instructions (or, for a
  map step, its per-item template) are required.
- **Misplaced or misspelled `### gate`.** It is the format's single reserved
  marker, and it must be a `###` sub-heading inside the step's own section.
  An empty `### gate` section is the same as omitting it — no verification
  runs.
- **Referencing an item outside a map unit.** `item`/`item_index` are not
  part of the reference language anywhere — they only arrive as attached
  context inside that map step's own unit template.
- **Referencing an unknown step or param.** `akm lint --type workflows`
  checks every bare reference statically (unknown step, unknown param, bad
  path) — run it before you rely on a workflow working.
- **Writing `exec.command` as a shell string.** `command: "bun run test"` is
  rejected; it must be an argv array (`["bun", "run", "test"]`). Nothing is
  ever shell-parsed, so metacharacters inside an argument stay literal.
- **Listing names in `exec.pass_env:`.** It parses and selects nothing: the
  command already inherits your environment. `pass_env` lives inside `exec:`;
  the unit-level `env:` key is a list of exact env asset binding refs. A new v4
  start rejects `inherit_env`.
- **Asking a model to do deterministic work.** "Run the test suite and tell me
  if it passed" is an [exec step](#deterministic-steps-run-a-command-gate-on-it),
  not a prompt.

## Typing what a step returns

An `output:` schema (and each `params:` entry) is a JSON Schema, and the engine
validates the result against it before the step can complete. The
runtime enforces a **bounded subset** of JSON Schema — anything outside it is
an authoring error at `akm lint`, never a silent no-op, because a gate
depending on a schema that constrains nothing is worse than a loud failure.

Enforced: `type`, `enum`, `properties`, `required`, `items`,
`additionalProperties: false`, `minItems`, `maxItems`, `minLength`,
`maxLength`, `minimum`, `maximum`, and the combinators `allOf`, `anyOf`,
`oneOf`, `not`.

```yaml
  - id: release
    unit:
      output:
        type: object
        required: [version, verdict]
        additionalProperties: false
        properties:
          version: { type: string, minLength: 1 }
          verdict: { type: string, enum: [pass, fail] }
          detail:
            oneOf:
              - { type: string, minLength: 1 }
              - { type: "null" }
```

`release` is a solo step, so its schema sits under `unit:` (see
[Agent in, exec out](#agent-in-exec-out)).

Outside the subset (each fails lint with the keyword named, its line, and a
suggested replacement where one exists): `$ref`/`$defs` — inline the schema
instead, since nothing resolves references; `const` — use a single-value
`enum`; `pattern` and `format` — no regex or string-format constraint is
evaluated at run time, so list the allowed values with `enum` when you can,
bound the size with `minLength`/`maxLength`, and otherwise check the shape in
the step's `### gate` rubric, which can also say *why* a value is wrong;
`patternProperties`, `if`/`then`/`else`, `uniqueItems`, `multipleOf`,
tuple-form `items`, and schema-form `additionalProperties` (only
`additionalProperties: false` is enforced). Annotation keywords —
`description`, `title`, `default`, `examples` — always pass through untouched,
and documenting each property is worth the keystrokes.

If lint reports a very broken workflow, note that its errors are sorted by
line, so fix from the top and re-run — the later ones are usually fallout from
the first.

## Choosing where a step runs and which model

A step that dispatches a model runs on your default harness, or on akm's own
runtime over your default connection when you have no harness. Leave that to
the machine the workflow runs on. Name one only when a step needs it:
`harness:` or `connection:` in `defaults` (or per-unit `unit.harness` /
`unit.connection`), where a name the machine has not configured is an error that
names it and lists what the machine has, so a workflow shared across machines
should name a program only when it needs that one. Set `defaults.model`/`unit.model` to an alias rather
than hardcoding an exact model id, so the workflow stays portable. The aliases
are `fast`, `balanced`, `reasoning` and any a connection or harness maps in its
`models`; see
[Workflow Schema: Model references](../reference/workflow-schema.md#model-references)
for the exact resolution order.

Point `reasoning` work at a capable model and keep high-volume fan-out units
on `fast`/`balanced`. The richer example's `review` map step is a good template: `reasoning` on the
per-item reviewer, `balanced` as the run default for everything else.

## Fan-out width

**A `map` step runs its items in parallel by default — 4 at a time as of
0.9.1.** (Earlier versions defaulted to 1, so a fan-out over 500 items crawled
through them one by one unless you said otherwise.) Map units are independent
by construction, so parallel is the honest default; the number is a modest 4
rather than "whatever the machine can take" so it stays predictable across the
machines a workflow gets shared with.

Say so explicitly when the default is wrong for a step:

```yaml
  - id: review
    map:
      over: steps.discover.output.files
      concurrency: 1     # serial — this step's units are NOT independent
```

`concurrency: 1` is a genuine opt-out and always wins. Reach for it when the
units touch a shared resource, when their side effects must happen in list
order, or when they hit an external service you must not burst. To change the
default for every workflow on a machine instead — including restoring the old
serial behavior wholesale — set
`akm config set workflow.defaultMapConcurrency 1`.

The declared width is a **ceiling, not a promise**. Three other limits clamp it
and the smallest wins: `workflow.maxConcurrency`, the selected connection's
`concurrency`, and the host's CPU cap. The connection limit is the one that
surprises people: a connection pointed at **localhost defaults to 1**, because
local model servers hold a single loaded model and fall over under concurrent
requests — so a `map` against a local model stays serial no matter what the step
declares, until you raise that connection's own `concurrency`. Remote endpoints
default to 4, and a step on a harness has no limit of this kind. See
[Workflow Schema: Fan-out and concurrency](../reference/workflow-schema.md#fan-out-and-concurrency)
for the full table.

All of it is frozen into the run when it starts, so an in-flight or resumed run
keeps the widths it began with even if you edit config or upgrade akm.

A workflow that fans out is authorizing **N parallel agents**, not one — the
same trust model described in
[Running Workflows: workflow sources are executed code](run-workflows.md#security-workflow-sources-are-executed-code)
applies with multiplied blast radius. Give the workflow explicit safety and
parameter metadata (document every `params` entry, keep destructive steps
described plainly in the body) so a reader — human or agent — can judge that
blast radius before running it.

## Verify before you publish

1. **Lint the structure.**

   ```sh
   akm lint --type workflows
   ```

   This catches the body-rule violations above, plus every static reference
   check (unknown step, unknown param, bad path).

2. **Run it for real.** A dry inspection of the markdown doesn't tell you
   whether a gate actually rejects bad output or an `output` schema actually
   matches what units return. Run the workflow against representative
   params:

   ```sh
   akm workflow run workflows/my-release --version 1.2.3
   ```

3. **Inspect the evidence.** Check that each step's promoted artifact is
   what you expect, and that a gate's rubric is judging that artifact, not
   engine prose:

   ```sh
   akm workflow status <run-id> --units
   ```

   `--units` shows per-unit diagnostics (status, `failure_reason`, raw
   result/error text) without polluting the deterministic artifact a gate
   judges — see
   [Running Workflows: Check status](run-workflows.md#check-status).

4. **Deliberately break a gate once.** Run the workflow with params you
   expect to fail validation, and confirm the gate actually rejects rather
   than silently passing — a missing judge (no connection or harness to run
   it) or a malformed verdict rejects the gate rather than bypassing it (see
   [Workflow Schema: Gates and verification](../reference/workflow-schema.md#gates-and-verification)),
   so this is worth confirming once per workflow rather than assuming.

## Running a child workflow (Experimental)

A step can run another workflow and use its result. The step names the child
in its `unit:` bag and binds the child's `params:` with `with:`:

```markdown
---
type: workflow
params:
  topic: { type: string }
steps:
  - id: investigate
    unit:
      workflow: workflows/research
      with:
        topic: { from: params.topic }
  - id: report
    inputs: [steps.investigate.output]
---

## investigate

Runs the research workflow as a child run.

## report

Summarise the research finding.
```

A `with:` value is a literal (checked against the child's param type when the
workflow is frozen) or `{ from: <reference> }`, where the reference is
`params.<name>` or `steps.<id>.output(.<segment>)*`, resolved just before the
step runs. The child's **last step output** is the composing step's output, so
`report` reads it through `inputs:`. Inspect what a step would pass, without
running anything, with `akm workflow plan workflows/<name> --format json`; the
per-step `inputBindings` show each literal and each unresolved reference.

Child workflows are Experimental. See
[Workflow Schema: Child workflows](../reference/workflow-schema.md#child-workflows)
for blocked-child recovery and the limits.

## Troubleshooting

**A step that dispatches a model needs a harness or a connection.** Freezing
resolves where each unit runs: its `unit.harness` or `unit.connection`, else the
document's `defaults`, else your default harness, else akm's own runtime over
your default connection. With none of those, freezing fails and the error points
at `akm setup`. A workflow made only of exec steps needs neither.

A workflow with a non-empty `### gate` also needs one for the gate judge, which
runs where model work runs: your default connection, else your default harness.
An exec-only workflow with a gate still needs it.

`akm setup` normally configures both. On a bare container or CI image, run it
with the answers as flags, or add one by hand:

```sh
akm setup --yes --endpoint http://localhost:11434/v1   # a model endpoint
akm setup --yes --harness claude                       # or an agent program you have
```

## See also

- [Workflow Schema](../reference/workflow-schema.md) — exact frontmatter,
  refs, gates, and outputs syntax
- [Running Workflows](run-workflows.md) — start, inspect, resume, and abandon
  a run
- [Architecture: The Workflow Engine](../architecture/workflow-engine.md) —
  persistence, dispatch, and resume internals
- [CLI Reference](../reference/cli.md) — full flag documentation for
  `workflow create`, `run`, and `lint`
