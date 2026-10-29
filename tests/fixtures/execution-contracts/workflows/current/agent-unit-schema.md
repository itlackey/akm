---
type: workflow
description: Current workflow schema projection seam
updated: 2026-08-19
steps:
  - id: review
    unit:
      harness: fixture-agent
      model: fixture-exact-model
      timeout: 45s
      output:
        type: object
        properties:
          verdict:
            type: string
        required: [verdict]
---
# Agent unit schema

## review

Review the execution contract and return a verdict.
