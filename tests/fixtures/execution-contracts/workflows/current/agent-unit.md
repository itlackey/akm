---
type: workflow
description: Current workflow-freeze seam for normalized request comparison
updated: 2026-08-19
steps:
  - id: review
    unit:
      harness: fixture-agent
      model: fixture-exact-model
      timeout: 45s
---
# Agent unit

## review

Review the execution contract.
