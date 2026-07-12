---
category: convention
description: Soft authoring conventions for lesson assets that capture compounding, hard-won judgment.
when_to_use: Surfaced to authoring agents when they write or revise a lesson asset.
---

<!--
  SOFT guidance only — advice, not a contract. Nothing here is enforced by the
  proposal gate; validator-rejecting HARD rules live in src/core/authoring-rules.ts
  and remain the sole enforced source. Editing or deleting this file cannot weaken
  the gate. Tune the guidance below to match how your stash wants this asset type
  maintained.
-->

# Lesson authoring conventions

A lesson captures durable, hard-won judgment that should compound across future agent sessions. Treat it as distilled judgment about how to act: it should preserve the extracted meaning of what real use revealed, not merely recount an incident or summarize another asset.

## Purpose

Use a lesson to record:

- when to reach for a pattern, asset, or decision;
- what tends to go wrong without it;
- what evidence, feedback, or repeated experience made the lesson worth keeping;
- how a future agent should act differently because this lesson exists.

## Authoring strategy

- Lead with the trigger: the concrete situation where this lesson should be loaded.
- Follow with the failure mode: what mistake, omission, or confusion this prevents.
- End with the reusable judgment: the practical rule a future agent can apply.
- Keep the scope narrow. A lesson should teach one durable behavior.
- Prefer observed evidence over generic advice. Mention the kind of signal that produced the lesson, such as rejected proposals, repeated lint findings, user feedback, or session outcomes.
- Do not restate the source asset. Lessons are compiled judgment, not copied documentation.
- Write for a future agent mid-task: direct, practical, and easy to apply.

## Maintenance strategy

- Update an existing lesson when new feedback sharpens the same judgment.
- Create a new lesson only when the trigger or failure mode is meaningfully different.
- Deprecate or revise stale lessons instead of allowing contradictory guidance to accumulate.
- When a lesson becomes broadly normative, consider promoting the stable rule into a `fact:conventions/...` asset.

## Placement & linking

- Lessons are **scope-born**: file them under the **project/client** they were
  learned in (`lesson:projectA/token-refresh-gotcha`) and xref the asset the
  lesson corrects or refines.
