---
category: convention
description: Starter SOFT authoring conventions for skill assets — edit to taste.
when_to_use: Surfaced to authoring agents when they write or revise a skill asset.
---

<!--
  SOFT guidance only — advice, not a contract. Nothing here is enforced by the
  proposal gate; the validator-rejecting HARD rules live in
  src/core/authoring-rules.ts (#645) and remain the sole enforced source. Editing
  or deleting this file cannot weaken the gate.
-->

# Skill authoring conventions

A skill is a reusable, self-contained capability stored as `skills/<name>/SKILL.md`.

- Frontmatter usually carries `name`, `description`, and `when_to_use`. Write the
  `description` so a dispatcher can decide *from it alone* whether to load the skill.
- Open the body with the goal in an imperative voice ("Generate…", "Review…").
- Structure as: purpose, when to use, then the procedure or guidance as ordered
  steps or short sections. Favour scannable headings over long prose.
- Keep it focused on one capability; split unrelated concerns into separate skills.
