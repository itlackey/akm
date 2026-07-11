---
category: convention
description: Soft authoring conventions for memory assets using durable-context and provenance discipline.
when_to_use: Surfaced to authoring agents when they write or revise a memory asset.
---

<!--
  SOFT guidance only — advice, not a contract. Nothing here is enforced by the
  proposal gate; validator-rejecting HARD rules live in src/core/authoring-rules.ts
  and remain the sole enforced source. Editing or deleting this file cannot weaken
  the gate. Tune the guidance below to match how your stash wants this asset type
  maintained.
-->

# Memory authoring conventions

A memory is a short, durable note that should survive beyond the current session. Treat it as a small compiled fact or decision, not a transcript fragment.

## Purpose

Use a memory when a future agent would make a better decision by knowing a specific user preference, project decision, environmental fact, constraint, or observed outcome.

## Authoring strategy

- Record one durable fact, decision, or constraint per memory.
- Write it so it stands alone without the original conversation.
- Include enough context to prevent misapplication: subject, scope, and when it matters.
- Prefer stable, reusable information over step-by-step session play-by-play.
- Mark uncertainty or subjectivity clearly when the memory is not a settled fact.
- Preserve source/provenance in frontmatter or body when the memory came from a session, log, user statement, or derived inference.
- Avoid storing secrets, private tokens, or volatile temporary state as memory.

## Maintenance strategy

- Update or supersede memories when newer evidence changes the truth.
- Consolidate repeated memories into a clearer fact or knowledge asset.
- Convert broad, stable conventions into `fact` assets.
- Archive memories that are no longer current rather than letting stale context keep influencing agents.

## Placement & linking

- Memories are **scope-born**: file them under the **current project/client**
  slug (`memory:projectA/auth-token-refresh`) — the working context is the
  answer, so no per-asset judgment is needed. Add the subject as a tag
  (`tags: [auth, projectA]`) for cross-cutting recall.
- When a memory turns out to be domain-general, **append** a new
  `knowledge:<domain>/…` asset that xrefs it — never rename the memory up a rung.
- See `fact:conventions/organization` and `fact:conventions/backlinks` for the
  full placement and cross-linking rules.
