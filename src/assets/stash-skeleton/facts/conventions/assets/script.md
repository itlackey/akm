---
category: convention
description: Soft authoring conventions for script assets using agent-safe CLI helper principles.
when_to_use: Surfaced to authoring agents when they write or revise a script asset.
---

<!--
  SOFT guidance only — advice, not a contract. Nothing here is enforced by the
  proposal gate; validator-rejecting HARD rules live in src/core/authoring-rules.ts
  and remain the sole enforced source. Editing or deleting this file cannot weaken
  the gate. Tune the guidance below to match how your stash wants this asset type
  maintained.
-->

# Script authoring conventions

A script is an executable helper that an agent or human can run on demand. Treat it like a small, deterministic tool that reduces manual bookkeeping and makes repeatable operations safer.

## Purpose

Use a script when a task is mechanical, repeatable, and better handled by a deterministic program than by free-form agent edits.

## Authoring strategy

- Start with the appropriate interpreter line and a short usage comment.
- State what the script does, expected inputs, outputs, side effects, and failure behavior.
- Keep one script focused on one job.
- Validate inputs before mutation.
- Fail loudly and early on unsafe or ambiguous input.
- Declare required dependencies and assumptions explicitly rather than assuming a tool is installed.
- Justify any non-obvious constant (timeout, retry count, limit) in a comment so a future reader can adjust it safely.
- Prefer idempotent behavior where practical.
- Avoid hidden network calls, destructive defaults, or silent writes.
- Never print secrets or sensitive values.
- Write output that is easy for both humans and agents to parse.
- Favor clear names, straightforward control flow, and comments at decision points.

## Maintenance strategy

- Add examples when agents or users repeatedly invoke the script incorrectly.
- Keep dangerous actions behind explicit flags.
- When a script becomes a core operation, add or update a workflow that explains when to run it.
- If the script encodes a convention, also document that convention in a fact or knowledge asset.

## Placement & linking

- Scripts are **reuse-born**: file a general helper under a tool/domain slug
  from `fact:conventions/domains` (`script:build/release`). Use the project slug
  only when the script hard-codes project-specific paths, endpoints, or
  credentials.
