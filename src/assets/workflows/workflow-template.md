---
type: workflow
description: One-sentence summary of what this workflow accomplishes.
updated: 2026-01-01
tags: [example]
params:
  example_param: { type: string, description: Explain this parameter }
steps:
  - id: first-step
  - id: second-step
    inputs: [steps.first-step.output]
---

# {{TITLE}}

Free preamble prose describing what this workflow does. It is indexed for
search and shown in `akm show`, but it is never dispatched to a step.

Level-2 (`##`) headings below are step ids and must exactly match one
declared in `steps:` above — for cross-cutting notes that aren't a step
(shared context, prerequisites), use a level-3 (`###`) heading instead.

## first-step

Describe what to do in this step. Refer to run parameters in plain
language — for example, "read the value given by the `example_param`
parameter" — never as a template expression like `{{ example_param }}`.

## second-step

Describe what happens next, using the first step's artifact — attached to
this unit as context because this step declares
`inputs: [steps.first-step.output]` above — referred to in prose as "the
first step's attached artifact."

### gate

A `### gate` sub-heading is the step's completion rubric: the judge
receives this whole section byte-exact. Omit the heading or leave its text
empty to skip validation. A non-empty rubric needs a connection or a harness
to judge it; verifier failures and malformed verdicts reject the
gate rather than silently skipping it.

- Confirm the step accomplished what it set out to do.
- Confirm nothing required was silently skipped.
