---
category: convention
description: Soft authoring conventions for agent assets using scoped role, tool, and maintenance rules.
when_to_use: Surfaced to authoring agents when they write or revise an agent asset.
---

<!--
  SOFT guidance only — advice, not a contract. Nothing here is enforced by the
  proposal gate; validator-rejecting HARD rules live in src/core/authoring-rules.ts
  and remain the sole enforced source. Editing or deleting this file cannot weaken
  the gate. Tune the guidance below to match how your stash wants this asset type
  maintained.
-->

# Agent authoring conventions

An agent asset defines a reusable role. Treat it like a disciplined maintainer, not a generic personality. Its job is to know its scope, read the right rulebooks, use the right tools, and leave the stash in better shape.

## Purpose

Use an agent when a recurring task benefits from a specialized role, bounded responsibilities, and explicit tool behavior.

## Authoring strategy

- Write the description so a dispatcher knows exactly when to delegate to this agent.
- Define the agent’s domain, authority, boundaries, and expected output.
- Specify what the agent must read first: relevant stash standards, type conventions, reference docs, source files, or prior lessons.
- State tool expectations plainly: what tools it may use, what it should avoid, and when it must ask for human review.
- Give the agent maintenance duties when appropriate: update cross-references, append logs, preserve provenance, and surface contradictions.
- Prefer a narrow role that does one thing reliably over a broad do-everything persona.
- Include handoff behavior: what the agent should return when it cannot complete the task safely.

## Maintenance strategy

- Refine the agent when repeated sessions show the same delegation failure.
- Add explicit negative guidance when the agent overreaches.
- Keep role instructions stable and concise; move large background material into knowledge assets.
- Use lessons to capture operational improvements, then promote stable ones into the agent when they become part of the role.

## Placement & linking

- Agent definitions are usually **global**: keep them at the type root or under a
  role/domain slug (`agent:reviewer`). Point the agent at the standards and type
  conventions it must read first via xrefs.
- See `fact:conventions/organization` and `fact:conventions/backlinks` for the
  full placement and cross-linking rules.
