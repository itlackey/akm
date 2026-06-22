---
category: convention
description: Starter SOFT authoring conventions for command assets — edit to taste.
when_to_use: Surfaced to authoring agents when they write or revise a command asset.
---

<!--
  SOFT guidance only — advice, not a contract. Nothing here is enforced by the
  proposal gate; the validator-rejecting HARD rules live in
  src/core/authoring-rules.ts (#645) and remain the sole enforced source. Editing
  or deleting this file cannot weaken the gate.
-->

# Command authoring conventions

A command is a markdown prompt template the user invokes by name.

- Optional frontmatter carries `name` and `description`; the body *is* the prompt.
- Write the body as the instruction you want the model to follow when invoked.
- State the task, the expected inputs, and the shape of the desired output up front.
- Keep it tight and unambiguous — a command is run repeatedly, so vagueness compounds.
- Use clear placeholders for any arguments the caller will supply.
