# Workflow Format Unification

Status: PROPOSAL v2 — owner decisions from review round 1 applied
Date: 2026-07-30
Supersedes: the dual markdown/YAML-program authoring surface (both unreleased)

Owner decisions incorporated in v2: no interpolation syntax in prose (§2.3),
gate rubrics live in the body (§2.4), steps have no titles — bare ids only
(§2.2).

## 0. Why now

The workflow feature has never shipped (`experimental.workflowEngine` opt-in,
0.9.0-rc). There are currently **two authoring formats** for one asset type,
and the seams between them have started leaking into unrelated systems — the
OKF provenance work (#730) tripped over workflow's closed frontmatter
allowlist, which exists only because the markdown format grew its own bespoke
validation instead of sharing the asset envelope every other type uses. This
is the moment to unify: nothing on disk to migrate, no users to break.

## 1. Review of the two current formats

### 1.1 Format A — markdown workflow (`src/workflows/parser.ts`, ~500 lines)

A bespoke prose grammar: one magic `# Workflow:` H1, magic `## Step:` H2s, a
magic `Step ID:` body line, magic `### Instructions` / `### Completion
Criteria` subsection names. Capabilities: **linear steps only** — no routing,
fan-out, retry, timeout, engine/model selection, output schemas, or budgets.
The compile path (`ir/compile.ts` `compileWorkflowPlan`) lowers every step to
one fail-fast unit node with verbatim instructions.

### 1.2 Format B — YAML program (`src/workflows/program/*`, ~1,300 lines)

The full orchestration surface: `unit | map | route` steps, `${{ … }}`
template expressions, retries keyed on the failure taxonomy, timeouts,
per-unit engine/model/llm overrides, JSON-Schema-typed params and step
outputs, gates with `max_loops`, budgets, worktree isolation.
Instructions are embedded YAML block scalars.

### 1.3 The divergences (each one is a standing cost)

| Concern | Markdown | YAML program |
|---|---|---|
| Step id grammar | `[A-Za-z0-9][A-Za-z0-9._-]*` — dots allowed | `[A-Za-z_][A-Za-z0-9_-]*` — dots forbidden |
| Params | name → description string, untyped | name → JSON Schema |
| Templating | **none** — instructions verbatim | `${{ … }}` expressions, real substitution |
| Gate | `### Completion Criteria` bullets; no `max_loops` | `gate:` with criteria/max_loops |
| Capabilities | linear only | full orchestration |
| Frontmatter validation | closed hand-maintained allowlist | closed key lists, JSON Schema published |
| Title | required `# Workflow:` H1 prefix | `name:` field duplicating the filename |
| Version | internal `schemaVersion 1` | `version: 2` (IR is v3) |

Beyond the table, four structural costs:

1. **The fake templating trap.** Every shipped example workflow
   (`scripts/akm-eval/example-stash/workflows/*.md`) uses `{{ repo }}`-style
   moustaches that **the engine never substitutes** — markdown instructions
   compile `templating: "verbatim"`. The YAML format substitutes `${{ … }}`
   for real. Two syntaxes; one is decorative and exists only as a convention
   the executing agent is hoped to honor.
2. **Content sniffing everywhere.** Two structural probes
   (`looksLikeWorkflow`, `looksLikeWorkflowProgram`) consulted by the indexer
   matchers, the workflow adapter (`recognize()` returns `"markdown" |
   "yaml-program"`), the asset loader (extension dispatch + probe), and the
   proposal validator (which sniffs *content* when no path is available).
   `canonicalizeWorkflowName` collapses `foo.md` / `foo.yaml` / `foo.yml` to
   one identity, so the two formats can silently collide on one ref.
3. **The closed-allowlist special case.** Workflow markdown is the only AKM
   type validating frontmatter against a closed hand-maintained key set. It
   is why #730's provenance stamping needed a re-validation fallback in the
   promotion path, why the allowlist had to learn `generated`/`verified`/
   `provenance` by name, and why its error message is now stale
   (`validator.ts:94` still enumerates the pre-#730 keys). Every future
   machine-stamped key repeats this.
4. **Double everything.** Two parsers, two templates, two doc sections, two
   test suites, two JSON representations feeding one `WorkflowPlanDraft`.
   ~1,800 lines of format code for one asset type.

### 1.4 What is genuinely good and must survive

- **The IR and engine.** Both frontends compile to one `WorkflowPlanDraft` →
  frozen IR v3. Deterministic replay, journaled units, leases, brief/report —
  none of that is format-coupled. This proposal changes **frontends only**.
- **The closed reference grammar** (`program/expressions.ts`) — though in v2
  of this proposal it *shrinks* from a template language to a bare reference
  string format (§2.3).
- **The program vocabulary** (unit/map/route, gate control, retry taxonomy,
  budgets, defaults): well-designed, schema-validated, kept nearly verbatim.
- **Markdown prose as the instruction medium.** The example workflows prove
  the point: real instructions are long structured prose with code fences,
  sub-headings, and lists. Markdown is their native medium.

## 2. Design

### 2.1 Principle

> **One file. Machine surface in frontmatter, prose surface in the body,
> joined by step id. Prose is never templated — data reaches units as
> attached context, not string splices.**

A workflow is an ordinary AKM markdown asset — same envelope as every other
type, OKF-conformant frontmatter + body — whose frontmatter carries the
entire orchestration graph and whose body carries per-step instructions and
gate rubrics under plain headings.

### 2.2 The format

````markdown
---
type: workflow
description: Drive a batch of GitHub issues to merged PRs.
params:
  repo:   { type: string, description: Target repository owner/name }
  issues: { type: array,  description: Issue numbers to implement }
defaults: { timeout: 10m, on_error: fail }
budget: { max_units: 60 }
steps:
  - id: intake
    output: { type: object }
  - id: implement
    map:
      over: steps.intake.output.issues
      concurrency: 3
      unit: { retry: { max: 2, on: [timeout] } }
    # `output` describes the REDUCER RESULT: the default `collect` reducer
    # folds per-item unit results into an array.
    output: { type: array }
    # Retry lives here, not in a backward route: a failed gate re-runs this
    # step with the judge's feedback, bounded by max_loops.
    gate: { max_loops: 2 }
  - id: verdict
    inputs: [steps.implement.output]
    output: { type: object }
  - id: escalate
    inputs: [steps.verdict.output]
  - id: announce
    inputs: [steps.implement.output]
---

# GitHub Issues Parallel Implementer

Free preamble prose. Indexed for search, shown in `akm show`, never
dispatched. Any headings except level-2 are fine here.

## intake

Everything under this heading, byte-exact, is the step's instructions —
sub-headings, fences, lists, all of it. The run's params arrive as attached
context; refer to them by name in prose ("clone the `repo` parameter's
repository").

## implement

This section is the **map unit template**. The engine attaches each unit's
item (and its index) as context; the prose says "the issue you were given."

### gate

The gate rubric — as long as it needs to be. Full prose, bullets, examples
of passing and failing artifacts. The judge receives this whole section.

- Every issue in the working set has a mergeable PR or a recorded blocker.
- No PR was opened against a branch other than the declared base.

## verdict

Inspect the implementation results and report whether the batch is clean or
needs escalation.

## escalate

Escalate blockers from the verdict, with the verdict artifact attached as
context (declared via `inputs:` above).

## announce

Post the summary. The `implement` step's artifact is attached as context
(declared via `inputs:` above).
````

**Frontmatter** (validated by one published JSON Schema):

- The standard AKM asset envelope — `type`, `description`, `tags`,
  `when_to_use`, `xrefs`, `updated`/`timestamp`, and the OKF v0.2 families
  (`generated`, `verified`, `provenance`, `status`, `stale_after`) — via a
  shared `$ref`'d envelope definition (§2.5).
- The orchestration keys, adopted from program v2 with these changes:
  - `version:` and `name:` **dropped**. Identity is the ref; the frozen plan
    already versions execution semantics (IR v3); the authoring schema
    evolves additively like every other asset type.
  - `instructions:` keys **removed** — prose lives only in the body.
  - `gate.criteria` **removed** — rubrics live in the body (§2.4). `gate:`
    retains only the optional `max_loops` configuration.
  - **No titles anywhere.** No step `title:` key, no display-title heading
    suffix. A step is its id; the asset's human name is its `description`
    and H1 like any other asset.
  - New `inputs:` key on unit/map steps: the prior-step artifacts this step
    consumes, as bare reference strings (§2.3). Replaces prose splicing as
    the way a step sees upstream data, and gives replay hashing its exact
    input set. Sub-paths are legal (`steps.x.output.issues`, not just
    `steps.x.output`) so a step re-dispatches only when the slice it
    consumes changes.
  - A step with no `map:` and no `route:` **is** a unit step; bare
    `- id: validate` is the complete minimal declaration. `unit:` remains as
    the optional dispatch-override bag (engine/model/llm/timeout/retry/
    on_error/env/isolation).
  - One id grammar everywhere: `[A-Za-z_][A-Za-z0-9_-]*`.
  - Keys stay snake_case (`on_error`, `max_loops`) — the existing AKM/OKF
    frontmatter convention.

**Body** (three rules):

1. Every level-2 heading must be `## <step-id>` for a declared step, exactly.
   (Fenced code blocks are skipped when scanning for headings.)
2. A unit or map step **must** have a section (its instructions / per-item
   template, byte-exact to the next H2 or EOF). A route step **may** have one
   (documentation, plus a gate rubric if gated). Everything before the first
   H2 is free preamble.
3. Inside a step section, an optional `### gate` sub-heading starts the
   step's gate rubric (running to the section end). It is the format's
   **single reserved marker**. Omitted or empty rubric text skips validation;
   a non-empty rubric enables optional validation. Frontmatter `gate:` without
   a rubric is valid but inert.

No `Step ID:` lines, no `# Workflow:` prefix, no reserved H3s beyond `gate`.

### 2.3 No interpolation syntax — references and attached context

v1 of this proposal kept `${{ … }}` templating in prose and added a `$${{`
escape. The owner asked the right question — *why have the syntax at all?* —
and the answer is that only the **engine** ever needed deterministic value
resolution, and the engine only reads **whole-value frontmatter positions**:

- `map.over` — the list to fan out over.
- `route.input` — the value routing matches on.
- `inputs:` — the artifacts a step consumes (new, replacing prose splicing).

Whole-value positions need no delimiters. These become **bare reference
strings** with the same closed grammar, shrunk from four roots to two:

    params.<name>
    steps.<id>.output( .<ident> | [<int>] )*

`item` and `item_index` are **deleted from the language**: with no splicing
there is nothing to substitute — the engine attaches each map unit's item and
index as context alongside the prompt.

**Prose is never templated.** Each dispatched unit receives, as structured
attached context: the run params (params are run-scoped and documented
non-secret), its item + index (map units), and the artifacts named by its
step's `inputs:`. Instructions refer to these in plain language — which is
exactly how the classic driver and all nine example workflows already
functioned, since their moustaches were never substituted.

What this buys:

- The escape-syntax question evaporates — there are no delimiters in prose.
- The P1 injection class dies at the root: data never enters the instruction
  string at all, spliced or otherwise.
- `program/expressions.ts` shrinks from a template parser (segments,
  literals, offsets) to a small reference-string parser.
- Bodies are pure markdown — cohesive with every other asset, no syntax an
  OKF reader or a human editor has to know about.

Determinism and replay identity are preserved: unit identity hashes the
frozen template bytes + canonical item JSON + declared-input artifact hashes
+ the params snapshot — the same inputs the journal's replay machinery keys
on today, minus the string splice. `inputs:` gives the hash its exact
upstream set, so a step re-dispatches only when data it actually consumes
changes (the precision splicing used to provide implicitly).

The honest trade-off: prose can no longer compose a value mid-string with
engine-guaranteed fidelity ("run `git checkout <item>`") — the executing
agent performs that mapping from attached context. Every current executor is
an agent/LLM engine, so this is the same trust the instructions already
extend everywhere else. If a non-agent unit kind (raw shell/exec) is ever
added, *that unit kind* reintroduces substitution as its own need — scoped
there, not in prose.

### 2.3a Routes are forward-only; gates are the retry mechanism

Two invariants inherited unchanged from the program format, doubly enforced
today (`program/parser.ts:459` and `ir/schema.ts:227`), and preserved here:

- **A route target must be a LATER step**, and a step never routes to itself.
  The plan stays a DAG, so termination is structural rather than a runtime
  budget's job.
- **Retry is a gate, not a backward edge.** A failed gate re-runs its own
  step with the judge's feedback, bounded by `gate.max_loops`; a declared
  `output:` schema that the artifact fails is the one error the gate loop may
  retry through (`artifactSchemaFailure`). Anything wanting "go back and fix
  it" expresses it as a gate on the step being fixed.

A backward `default:` therefore does not mean "loop" — it is a lint error.

### 2.3b `output:` describes the reducer result

For a map step, `output:` validates the **promoted artifact**, i.e. what the
reducer produced — not one unit's result. The default `collect` reducer folds
per-item results into an **array**, so a collected map step's schema is
`{ type: array }`. (`vote` folds to the winning value.) A unit step's
`output:` describes that single unit's structured result.

### 2.4 Gates: control in frontmatter, rubric in the body

Owner decision: rubrics are often long — real rubric documents, not
one-liners — and belong in the body. The split:

- **Frontmatter `gate:`** optionally carries `max_loops`. It does not enable
  validation by itself; without a non-empty body rubric it is inert.
- **Body `### gate`** (inside the step's section) carries the rubric: full
  prose, bullets, worked examples. The judge receives the whole section
  byte-exact. Omitted or empty text skips validation. This replaces both the
  markdown format's `### Completion Criteria` bullets and the program's
  `gate.criteria` string list.

### 2.5 Validation model — and the end of the allowlist special case

One published JSON Schema (`schemas/akm-workflow.json`, repurposed) validates
the entire frontmatter. Its top level `$ref`s a new **shared asset-envelope
schema** — the common keys every AKM markdown type carries, including the
machine-stamped OKF families. Consequences:

- Workflow stops being the only type with a bespoke closed key set; "closed"
  becomes `additionalProperties: false` over `envelope ∪ workflow-keys`,
  defined in one place.
- A future machine-stamped key is added to the envelope definition **once**,
  and every schema-validated type inherits it — the #730 fallback dance and
  the stale hand-written key-list message become structurally impossible.
  The promotion-path re-validation backstop is deleted.
- Editors get frontmatter completion/validation via the published schema
  (yaml-language-server association) — tooling no bespoke markdown grammar
  can offer.

Semantic passes keep their existing implementations from the program parser,
retargeted at frontmatter: duplicate ids, route targets exist / are
forward-only / are unique, reference strings resolve to earlier steps,
timeout format, retry-reason taxonomy, resource limits. Body checks are the
three rules of §2.2.

Recognition simplifies to: frontmatter `type: workflow`, or residence under
`workflows/` — no content sniffing. `WORKFLOW_EXTENSIONS` shrinks to `.md`.

### 2.6 OKF cohesion

The unified asset **is** an OKF-shaped document: frontmatter + markdown
body, no inline syntax. Provenance stamping applies with zero
special-casing. A third-party OKF reader sees a normal document — prose
overview, sections per step — degrading gracefully to readable procedure
documentation. `status: draft` / `stale_after` become meaningful on
workflows for free (e.g. a future rule that draft workflows refuse `run` —
noted, not proposed here).

## 3. What gets deleted

- `src/workflows/parser.ts`'s grammar: `# Workflow:` / `## Step:` /
  `Step ID:` / reserved-H3 subsections (frontmatter/toc plumbing is reused
  by the new body binder).
- `looksLikeWorkflow` / `looksLikeWorkflowProgram` sniffing and the
  `"markdown" | "yaml-program"` mode split in the adapter, matchers, loader,
  and proposal validator.
- The YAML program as a distinct on-disk format; its field validation
  survives as the frontmatter semantic passes.
- **The template expression language**: `${{ … }}` delimiters, segment
  parsing, `item`/`item_index` roots, and the escape question — replaced by
  bare reference strings in three frontmatter positions plus context
  attachment.
- The workflow-only closed frontmatter allowlist and its hand-maintained
  error string, replaced by the schema.
- The #730 promotion-path re-validation fallback.
- Step titles in all forms; the `name:` and `version:` keys.
- One of the two authoring templates, one of the two doc sections, the
  extension-collapse logic beyond `.md`, `isWorkflowProgramPath`.

Net: two formats' worth of parsing/dispatch (~1,800 lines) replaced by one
frontmatter schema + semantic passes + a three-rule body binder, with the
IR, engine, and journal reused unchanged — and the template language itself
reduced to a reference-string parser.

## 4. Blast radius (all unreleased surfaces)

- **Engine seam (the one non-frontend change):** unit dispatch gains context
  attachment (params / item / declared inputs) and unit-identity hashing
  keys on (template, item, input hashes, params) instead of instantiated
  strings. Journal shape is already compatible; freeze pins the plan either
  way.
- **Templates**: both authoring templates → one.
- **Examples**: 9 example-bundle workflows rewritten; their fake moustaches
  become plain prose references to attached context — which is how they
  already behaved in practice.
- **Fixtures/goldens**: `format-family-goldens/`, `all-types` fixtures,
  parser/program suites (program-parser tests largely port).
- **Docs**: `docs/reference/workflows.md` collapses its two format sections;
  the expression-language section shrinks to the reference grammar.
- **Index cache**: `workflow_documents` re-derives on reindex (unreleased).
- **CLI**: `akm workflow create` emits the unified template; `create
  <name>.yaml` dies.

## 5. Decision log and remaining questions

Resolved by owner (review round 1):

1. ~~Escape syntax~~ — **moot**: no interpolation in prose at all (§2.3).
2. ~~Gate criteria location~~ — **body**, under the single reserved
   `### gate` marker; control fields stay in frontmatter (§2.4).
3. ~~Step titles~~ — **none**; a step is its id.
4. ~~Heading form~~ — **bare `## <id>`**.

Resolved by owner (review round 2):

5. **`inputs:` accepts sub-paths.** `steps.x.output` and
   `steps.x.output.issues` are both legal — the reference grammar already
   parses the path form, and a narrower declared input means a narrower
   replay hash, so a step re-dispatches only when the slice it actually
   consumes changes.
6. **All run params attach to every unit.** No per-step params declaration.
   Params are run-scoped and documented non-secret (`docs/reference/
   workflows.md`, "Params are not secret"); secrets travel as `env:` refs,
   which remain per-unit. This keeps the attachment model uniform: every
   unit receives params, its item + index if it is a map unit, and the
   artifacts its step's `inputs:` names.

No open questions remain. This proposal is ready to implement.

## 6. Non-goals

- No engine, IR, freeze, journal, lease, or brief/report changes beyond the
  dispatch-context seam noted in §4.
- No new orchestration capabilities (no new step kinds, reducers, or
  reference roots).
- No change to task/env/script/secret formats; task remains a YAML type —
  tasks are machine schedules, not prose procedures.
