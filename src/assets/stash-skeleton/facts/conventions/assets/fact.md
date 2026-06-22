---
category: convention
description: Starter SOFT authoring conventions for fact assets — edit to taste.
when_to_use: Surfaced to authoring agents when they write or revise a fact asset.
---

<!--
  SOFT guidance only — advice, not a contract. Nothing here is enforced by the
  proposal gate; the validator-rejecting HARD rules live in
  src/core/authoring-rules.ts (#645) and remain the sole enforced source. Editing
  or deleting this file cannot weaken the gate.
-->

# Fact authoring conventions

A fact is durable stash-level context — personal, team, or project details,
coding conventions, or stash-meta.

- Frontmatter should include a `description` and a `category`
  (personal | team | project | convention | meta).
- Set `pinned: true` only for the small always-injected core; most facts stay unpinned.
- Keep each fact short, high-signal, and self-contained — it is durable context,
  not an episodic note.
- Write it as a standing declaration that stays true across sessions.
