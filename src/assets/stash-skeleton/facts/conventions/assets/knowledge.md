---
category: convention
description: Soft authoring conventions for knowledge assets as compiled, on-demand reference documents.
when_to_use: Surfaced to authoring agents when they write or revise a knowledge asset.
---

<!--
  SOFT guidance only — advice, not a contract. Nothing here is enforced by the
  proposal gate; validator-rejecting HARD rules live in src/core/authoring-rules.ts
  and remain the sole enforced source. Editing or deleting this file cannot weaken
  the gate. Tune the guidance below to match how your stash wants this asset type
  maintained.
-->

# Knowledge authoring conventions

A knowledge asset is a compiled reference document meant to be read on demand. Treat it as the synthesized layer above raw material: not source files, not chat residue, but integrated, navigable understanding that saves future agents from rediscovering the same material.

## Purpose

Use a knowledge asset for durable reference material, synthesized explanations, design notes, comparisons, and project context that is broader than a single memory but less procedural than a skill.

## Authoring strategy

- Open with a plain top-level title that names the subject.
- Add a concise orientation paragraph: what this document covers and when it should be read.
- For a long reference, add a table of contents near the top so the full scope is visible even on a partial read.
- Organize by stable concepts, decisions, entities, or questions — roughly one page per concept.
- Cross-reference related assets instead of duplicating them, so a navigable graph forms over time.
- Preserve provenance where it matters: cite source files, raw notes, session logs, or issues by path/ref.
- Call out contradictions, uncertainty, stale claims, and open questions explicitly.
- Prefer accurate synthesis over exhaustive dumping. Raw material belongs elsewhere; this file is the compiled layer.
- Use tables or checklists when they make retrieval and comparison easier.

## Maintenance strategy

- Update the existing page when new information changes the same topic; append a dated note rather than silently rewriting when provenance matters.
- Create a new page when the concept deserves its own durable entry.
- Add a return link when you are already editing the related page in the same pass.
- Periodically scan for orphaned, stale, or overlapping knowledge docs and consolidate them.

## Placement & linking

- Knowledge is **reuse-born**: file it under a stable **domain** prefix from
  `fact:conventions/domains` (`knowledge:auth/oauth-refresh-races`), not under a
  project — that domain slug is what any project searches to reuse it.
- Knowledge pages are the rewritable synthesized layer — update them in place.
  Ingested source material stays immutable; corrections to it are new assets
  that xref the source. Carry a provenance xref when derived, and a
  self-situating header.
