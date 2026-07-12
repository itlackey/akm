---
category: convention
description: Soft authoring conventions for command assets using repeatable LLM operation patterns.
when_to_use: Surfaced to authoring agents when they write or revise a command asset.
---

<!--
  SOFT guidance only — advice, not a contract. Nothing here is enforced by the
  proposal gate; validator-rejecting HARD rules live in src/core/authoring-rules.ts
  and remain the sole enforced source. Editing or deleting this file cannot weaken
  the gate. Tune the guidance below to match how your stash wants this asset type
  maintained.
-->

# Command authoring conventions

A command is a reusable markdown prompt template invoked by name. Treat it like an operation in the stash: every vague instruction will compound into repeated vague output.

## Purpose

Use a command when the user or agent needs to perform the same prompt-shaped task repeatedly with different arguments or context.

## Authoring strategy

- Put the task, inputs, constraints, and expected output shape near the top.
- Make argument placeholders obvious and describe what each one should contain.
- Tell the model what to inspect before acting, especially relevant stash assets, facts, standards, or reference docs.
- State the decision boundary: what the command should do directly, what it should only propose, and what it should refuse or defer.
- Include output requirements that are stable across runs.
- Keep the prompt tight. A command should be easy to invoke and hard to misinterpret.
- Avoid embedding one-time project details unless the command is intentionally project-specific.

## Maintenance strategy

- If users repeatedly clarify the same missing detail, add that detail to the command.
- If command output regularly becomes useful durable knowledge, instruct the agent to file the result into the right asset type.
- If the command starts handling multiple unrelated tasks, split it into smaller commands.
- Preserve a clear invocation contract so future agents can call the command safely.

## Placement & linking

- Commands are usually **global**: keep them at the type root or under a
  tool/domain slug. Scope to a project only when the command is genuinely
  project-specific.
