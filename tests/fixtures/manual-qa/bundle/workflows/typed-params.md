---
type: workflow
description: Deterministic exec-first workflow for typed parameter checks
updated: 2026-08-05
params:
  include_processes: { type: boolean }
  count: { type: integer, minimum: 1 }
  labels: { type: array, items: { type: string } }
steps:
  - id: choose
    unit:
      exec:
        command: ["true"]
  - id: finish
---

# Typed Params

## choose

Do nothing; the first step only exists so a bounded run needs no agent dispatch.

## finish

Return the literal marker `qa-workflow-finish`.
