---
description: Composing GitHub Actions workflows with reusable workflow_call jobs
---
# Reusable Workflows

Define `on: workflow_call:` workflows under `.github/workflows/` and invoke them from caller workflows with `uses: org/repo/.github/workflows/build.yml@<sha>`. Pass parameters via `inputs:` and secrets via `secrets:` blocks.
