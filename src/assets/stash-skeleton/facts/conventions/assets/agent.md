---
category: convention
description: Starter SOFT authoring conventions for agent assets — edit to taste.
when_to_use: Surfaced to authoring agents when they write or revise an agent asset.
---

<!--
  SOFT guidance only — advice, not a contract. Nothing here is enforced by the
  proposal gate; the validator-rejecting HARD rules live in
  src/core/authoring-rules.ts (#645) and remain the sole enforced source. Editing
  or deleting this file cannot weaken the gate.
-->

# Agent authoring conventions

An agent is markdown whose frontmatter describes a reusable role.

- Frontmatter typically carries `name`, `description`, and optionally `tools` and
  `model`. Write the `description` so a dispatcher knows exactly when to delegate.
- The body is the system prompt: establish the role, its scope, and its boundaries.
- Be explicit about what the agent should and should not do, and what it returns.
- Prefer a focused single-responsibility persona over a broad do-everything agent.
