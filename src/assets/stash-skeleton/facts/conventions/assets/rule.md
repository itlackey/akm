---
type: fact
category: convention
description: Soft authoring conventions for rule assets (short project rules agents follow).
when_to_use: Surfaced to authoring agents when they write or revise a rule asset.
updated: 2026-11-08
---

<!--
  SOFT guidance only — advice, not a contract. Tune it to match how your stash
  maintains rules.
-->

# Rule authoring conventions

A rule is a short bullet list of things an agent must do for a project. The AKM agent plugins load the applicable rules at session start and after compaction, so every line costs context on every task.

- One rule per bullet, imperative, checkable ("Run the focused tests for changed behavior"). No background or rationale; put that in knowledge.
- Keep a file to a handful of bullets and one topic. Split by topic (`rules/acme/testing.md`), not by length.
- Name the project in frontmatter: `project: acme`, matching the project name in the `projects` config. No `project` key means the rule is shared and applies everywhere.
- Place project rules under `rules/<project>/`. The folder is for people; `project:` decides where the rule applies.
- Always set `description`.
