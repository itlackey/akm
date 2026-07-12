---
category: convention
description: Soft authoring conventions for fact assets using pinned-core and just-in-time context principles.
when_to_use: Surfaced to authoring agents when they write or revise a fact asset.
---

<!--
  SOFT guidance only — advice, not a contract. Nothing here is enforced by the
  proposal gate; validator-rejecting HARD rules live in src/core/authoring-rules.ts
  and remain the sole enforced source. Editing or deleting this file cannot weaken
  the gate. Tune the guidance below to match how your stash wants this asset type
  maintained.
-->

# Fact authoring conventions

A fact is durable stash-level context: personal, team, project, convention, or meta knowledge. Treat facts as the stash’s semantic layer — selectively loaded context that should guide future work without bloating every prompt.

## Purpose

Use a fact for stable information that future agents should treat as true or normative: user preferences, project identity, team stack, architecture principles, naming conventions, tag vocabulary, or stash organization.

## Authoring strategy

- Write each fact as a standing declaration that can survive across sessions.
- Keep it short, high-signal, and self-contained.
- Choose the narrowest useful category: personal, team, project, convention, or meta.
- Use `pinned: true` only for the small core that should be available constantly.
- Leave most facts unpinned so they can be retrieved just-in-time.
- Include scope and provenance when a fact is project-specific, inferred, or subject to change.
- Separate facts from memories: memories preserve observations; facts state durable truth or durable policy.
- Separate facts from knowledge: knowledge explains a topic; facts declare compact context.

## Maintenance strategy

- Revise or supersede facts when the durable truth changes.
- Do not allow contradictory facts to remain equally active: mark the loser
  `beliefState: superseded` / `supersededBy: [<new ref>]` so ranking demotes it.
- Promote repeated memories or lessons into facts only when they become stable context.
- Keep convention and meta facts especially clear, because they steer future asset creation.

## Placement & linking

- Facts are **reuse-born**: give a policy/standard fact a domain-like prefix
  (`fact:policies/pii-handling`) or the type root for personal/meta facts.
- Facts are also the **delivery layer** for stash-wide conventions:
  `category: convention` or `category: meta` facts are surfaced to every non-wiki
  author, so this is where naming, placement, and linking house-rules live. Keep
  each one short — they inject into authoring prompts. Reserve `pinned: true` for
  the small always-injected core.
