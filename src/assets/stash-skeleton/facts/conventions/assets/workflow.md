---
category: convention
description: Starter SOFT authoring conventions for workflow assets — edit to taste.
when_to_use: Surfaced to authoring agents when they write or revise a workflow asset.
---

<!--
  SOFT guidance only — advice, not a contract. Nothing here is enforced by the
  proposal gate; the validator-rejecting HARD rules live in
  src/core/authoring-rules.ts (#645) and remain the sole enforced source. Editing
  or deleting this file cannot weaken the gate.
-->

# Workflow authoring conventions

A workflow describes a multi-step process an agent or human follows in order.

- Open with a top-level `# <Title>` naming the workflow's outcome.
- Lay out the steps as ordered `## Step N` sections, each with a clear action.
- For each step, state what to do, what it depends on, and how to know it is done.
- Keep steps atomic and resumable — a reader should be able to stop and pick up midway.
- Note any branch points or preconditions explicitly rather than burying them in prose.
