---
category: convention
description: Starter SOFT authoring conventions for script assets — edit to taste.
when_to_use: Surfaced to authoring agents when they write or revise a script asset.
---

<!--
  SOFT guidance only — advice, not a contract. Nothing here is enforced by the
  proposal gate; the validator-rejecting HARD rules live in
  src/core/authoring-rules.ts (#645) and remain the sole enforced source. Editing
  or deleting this file cannot weaken the gate.
-->

# Script authoring conventions

A script is an executable text file stored as-is and run on demand.

- Start with a shebang appropriate to the interpreter (e.g. `#!/usr/bin/env bash`).
- Follow it with a short usage comment: what the script does and how to invoke it.
- Keep the script focused on one job; fail loudly and early on bad input.
- Prefer readable, well-commented logic over cleverness — these get re-run by others.
