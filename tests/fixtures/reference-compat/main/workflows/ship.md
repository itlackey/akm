---
type: workflow
description: Build, then hand to the team release workflow
tags: [ship]
updated: 2026-01-20
steps:
  - id: build
    unit:
      exec:
        command: ["sh", "${scripts/hello.sh}"]
  - id: release
    inputs: [steps.build.output]
    unit:
      workflow: team//workflows/release
  - id: local
    unit:
      workflow: workflows/inner
---

# Ship

## build

Build it.

## release

Hand over to the team release workflow.

## local

Run the unqualified inner workflow.
