---
description: Scoping GITHUB_TOKEN with the workflow permissions key
---
# GitHub Actions Permissions

Set `permissions:` at the workflow or job level to scope `GITHUB_TOKEN`. Default to `permissions: read-all` and grant write scopes per job (`contents: write`, `pull-requests: write`). This shrinks the blast radius of a compromised action.
