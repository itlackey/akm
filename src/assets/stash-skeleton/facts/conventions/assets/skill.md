---
category: convention
description: Soft authoring conventions for skill assets as reusable, just-in-time procedural rulebooks.
when_to_use: Surfaced to authoring agents when they write or revise a skill asset.
---

<!--
  SOFT guidance only — advice, not a contract. Nothing here is enforced by the
  proposal gate; validator-rejecting HARD rules live in src/core/authoring-rules.ts
  and remain the sole enforced source. Editing or deleting this file cannot weaken
  the gate. Tune the guidance below to match how your stash wants this asset type
  maintained.
-->

# Skill authoring conventions

A skill is a reusable, self-contained capability stored as `skills/<name>/SKILL.md`. Treat it like a compact operating manual that an agent can load just-in-time, follow without rediscovering the process, and improve when repeated use exposes gaps.

## Purpose

Use a skill when the stash needs reusable procedural guidance for a recurring class of work. A good skill reduces repeated reasoning cost: future agents should not have to reconstruct the same method from raw context.

## Authoring strategy

- Make the dispatch signal clear. The description should let a dispatcher decide whether to load the skill without reading the whole body.
- Open with the outcome the skill helps produce.
- State when to use it, when not to use it, and what inputs the agent should gather before acting.
- Structure the body as a rulebook: principles first, then procedure, then checks.
- Use short sections and ordered steps where sequence matters.
- Match the level of detail to how fragile the task is: open-ended work gets high-level heuristics and room to reason, while fragile or consistency-critical steps get exact, unambiguous instructions.
- Keep the body lean and move bulky background into companion knowledge docs referenced one level deep, so the skill loads cheaply and stays scannable.
- Include failure modes and verification steps. A skill should tell the agent how to know the work is complete.
- Keep one skill focused on one capability. Split unrelated concerns into separate skills and cross-reference them.

## Maintenance strategy

- Update the skill when session logs, feedback, or rejected proposals reveal repeatable confusion.
- Add companion knowledge docs when the skill needs background material that would bloat the main procedure.
- Promote durable recurring corrections into the skill; leave one-off observations in memories or lessons.
- Prefer small edits that preserve the skill’s operational shape over broad rewrites that erase tested guidance.

## Placement & linking

- Skills are **reuse-born**: place `skills/<domain>/<name>/SKILL.md` under a
  stable **domain** prefix from `fact:conventions/domains`
  (`skill:testing/flaky-test-triage`) so any project finds and reuses it instead
  of duplicating the procedure.
