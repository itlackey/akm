---
argument-hint: <environment>
allowed-tools: Bash(git status), Bash(bun run deploy)
description: Deploy the project to the named environment.
---

# Deploy

Deploy the current branch to the `$ARGUMENTS` environment.

1. Confirm the working tree is clean.
2. Run the deploy script for `$1`.
3. Report the released version.
