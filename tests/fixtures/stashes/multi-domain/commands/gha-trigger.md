---
description: Trigger a GitHub Actions workflow_dispatch run via gh CLI
---
# gha-trigger

Use `gh workflow run <workflow.yml> --ref <branch> -f <input>=<value>`. Then `gh run watch` to follow the latest run, or `gh run list --workflow <workflow.yml> --limit 5` to see history.
