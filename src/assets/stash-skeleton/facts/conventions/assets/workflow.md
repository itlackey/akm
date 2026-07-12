---
category: convention
description: Soft authoring conventions for workflow assets using explicit operations, logging, and lintable steps.
when_to_use: Surfaced to authoring agents when they write or revise a workflow asset.
---

<!--
  SOFT guidance only — advice, not a contract. Nothing here is enforced by the
  proposal gate; validator-rejecting HARD rules live in src/core/authoring-rules.ts
  and remain the sole enforced source. Editing or deleting this file cannot weaken
  the gate. Tune the guidance below to match how your stash wants this asset type
  maintained.
-->

# Workflow authoring conventions

A workflow describes an ordered process an agent or human can follow. Treat it as the operation layer of a maintained stash: clear steps, clear state, clear completion criteria, and enough bookkeeping to resume safely.

## Purpose

Use a workflow when the task requires multiple steps, branching decisions, repeated checks, or durable progress tracking.

## Authoring strategy

- Open with the outcome the workflow produces.
- State prerequisites, required inputs, and tools before the steps.
- Use ordered step sections when sequence matters.
- For each step, specify:
  - what to do;
  - what evidence or input it depends on;
  - what output it produces;
  - how to know the step is done.
- Make branch points explicit. Do not bury conditional behavior in prose.
- Include validation, lint, or review steps near the end.
- Include rollback or recovery notes when the workflow mutates files, state, repos, or external systems.
- Keep steps atomic and resumable so an interrupted run can continue without guessing.

## Maintenance strategy

- Update the workflow when repeated execution reveals missing checks or unclear handoffs.
- Add logging expectations when the workflow creates durable state.
- Extract reusable sub-procedures into skills or scripts when the workflow grows too broad.
- Record recurring mistakes as lessons, then fold stable corrections back into the workflow.

## Placement & linking

- Workflows are usually **global**: keep them at the type root or under a
  tool/domain slug (`workflow:release-train`). Scoping a workflow to one project
  rarely improves retrieval and adds rename risk.
