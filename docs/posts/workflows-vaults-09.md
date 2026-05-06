---
title: Agents That Remember Where They Were
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm-workflows
description: 'akm 0.5.0 adds workflow assets, vault assets, and a writable synced stash.'
tags:
  - ai
  - agents
  - cli
  - workflows
published: true
id: 3538935
date: '2026-05-05T02:19:50Z'
---

This is part nine in a series about managing the growing pile of skills, scripts, and context that AI coding agents depend on. [Part one](https://dev.to/itlackey/your-ai-agents-skill-list-is-getting-out-of-hand-32ck) introduced progressive disclosure. [Part two](https://dev.to/itlackey/you-already-have-dozens-of-agent-skills-you-just-cant-find-them-bpo) unified your local assets across platforms. [Part seven](https://dev.to/itlackey) covered shared team skills via Git repos.

Ask an agent to ship a release and it will start confidently. It runs the build, opens the changelog, checks the branch. Then something interrupts the session — you close the terminal, the context window fills up, you need to switch tasks. When you come back, the agent has no idea where it left off. You either restart from scratch or spend time reconstructing what happened.

This is the central problem with agents and multi-step work. They're good at individual tasks. They're not naturally good at procedures — sequences of steps that span time, accumulate state, and need to be resumable when interrupted.

`akm` ships three features that address this directly: workflow assets for stored, resumable procedures; vault assets for secret-aware environment config; and a writable git stash that keeps your skill collection in sync across machines. This post explains what each one does and how they fit together.

## The Problem: Tasks Versus Procedures

A task is "write this function." A procedure is "ship this release." Tasks have a beginning and end that fit inside a single context window. Procedures have steps, dependencies between steps, and state that persists across sessions.

When agents handle procedures today, the state lives only in the conversation. That's fine for a five-minute task. It breaks down for anything that takes an hour, involves multiple sessions, or needs to be audited later. If something fails at step four of seven, there's no standard way to resume at step five without replaying the whole context.

The workaround most developers reach for is a checklist in a markdown file. The agent checks off items as it goes. This works, but it's manual, fragile, and the state isn't queryable. You can't ask "which deployments are currently in-progress" if the state is scattered across markdown checkboxes in different files.

Workflow assets are the structured version of that checklist.

## Workflow Assets: Stored Procedures Your Agent Can Step Through

Workflows live in `workflows/` in your stash. Each workflow is a markdown file with frontmatter declaring the procedure's parameters and a standard step format. You write the workflow once; the agent follows it on every run.

Here's what a release workflow looks like:

```markdown
---
description: Ship a production release
params:
  version: "The version to release (e.g. 1.2.3)"
---
# Workflow: Ship Release

## Step: Validate inputs
Step ID: validate
### Instructions
Check that version follows semver and that the release branch exists.
### Completion Criteria
- Version matches x.y.z
- Branch release/{{ version }} exists

## Step: Build
Step ID: build
### Instructions
Run `bun run build` and verify dist/ was generated.

## Step: Deploy to staging
Step ID: staging
### Instructions
Run `./scripts/deploy.sh staging` and verify the health check passes.

## Step: Deploy to production
Step ID: production
### Instructions
Run `./scripts/deploy.sh production` after staging health check is green.
```

The workflow defines the procedure. To run it, the agent creates a *run* — an instance of that procedure with a specific set of params:

```sh
akm workflow start workflow:ship-release --params '{"version":"1.2.3"}'
# Returns a run ID: run-abc123
```

Now the procedure has state. The agent calls `akm workflow next` to get the current actionable step:

```sh
akm workflow next workflow:ship-release
# Returns: Step "validate" — Check that version follows semver...
```

When the agent completes a step, it marks it done with notes:

```sh
akm workflow complete run-abc123 --step validate --state completed --notes "Version 1.2.3, branch release/1.2.3 confirmed"
```

`--state` defaults to `completed` when omitted, so the `--state completed` above is redundant but explicit.

And the next call to `akm workflow next` returns the following step. The run persists independently of the conversation. If the session ends, a new agent picks up exactly where the previous one left off:

```sh
akm workflow next workflow:ship-release
# Returns: Step "build" — still in progress from the interrupted session
```

Want to see the full state of a run?

```sh
akm workflow status run-abc123
```

`workflow status` also accepts a workflow ref directly, resolving to the most-recently-updated run:

```sh
akm workflow status workflow:ship-release
```

That shows each step with its status and any notes the agent recorded. You can list all active runs:

```sh
akm workflow list --active
```

The procedure is now auditable. You know which step failed, when, and what the agent noted. You can hand the run off to a different agent or a different developer. The state is outside the context window where it's durable.

If you need a starting point, `akm workflow template` prints a starter workflow doc you can adapt.

### Resuming blocked or failed runs

Sometimes a run gets blocked — a step requires human input, an external dependency is unavailable, or a tool call fails. When that happens, the run transitions to `blocked` or `failed`. Use `workflow resume` to flip it back to `active` without discarding progress:

```sh
akm workflow resume run-abc123
```

Completed runs cannot be resumed. Use `workflow list` to find runs by status.

## Vault Assets: The Agent Knows What It Needs, Not What the Values Are

Procedures that touch production environments need secrets — database URLs, API keys, deploy tokens. Putting those secrets in a skill file or a prompt is an obvious problem. But the agent still needs to know *which* secrets a given procedure requires.

Vault assets solve this. A vault is a `.env` file stored in `vaults/` in your stash. The design has one rule: values are never surfaced in structured output. The agent can inspect a vault and learn what keys exist. It never sees what those keys are set to.

```sh
akm vault show vault:production
# Returns: { keys: ["DATABASE_URL", "API_KEY", "DEPLOY_TARGET"], comments: {...} }
```

This is enough for the agent to confirm "yes, the right secrets are configured for this environment" without the secrets appearing anywhere in the conversation or the context window.

When a script actually needs the values — at runtime, not at planning time — the agent emits a shell source snippet:

```sh
source <(akm vault load vault:production)
./deploy.sh
```

The values are loaded into the shell environment for the subprocess. They never pass through the agent's text output. The agent's conversation log is clean.

Combined with a workflow, this fits naturally into an environment verification step. The agent calls `akm vault show vault:production` to confirm all required keys are present, marks the step complete, then later calls `akm vault load vault:production` in the shell command that actually needs the secrets. The workflow knows what's required. The agent confirms it. The shell gets what it needs.

## Writable Git Stash: Your Skills Sync Like Code

So far in this series, stashes have been read-only: you pull in a team repo or a remote source, and `akm` indexes it. In 0.5.0, a stash can be writable.

When you create a stash with `--writable`, `akm save` will stage, commit, and push your changes back to the remote:

```sh
akm add git@github.com:your-org/skills.git --provider git --name team-skills --writable
```

```sh
# After editing or adding an asset
akm save team-skills -m "Add deploy workflow"
```

The behavior depends on the stash configuration:

| State | What happens |
| --- | --- |
| Not a git repo | Skipped |
| Git repo, no remote | Stage and commit only |
| Git repo, has remote, writable: false | Stage and commit only |
| Git repo, has remote, writable: true | Stage, commit, and push |

Your default stash — the one `akm init` creates — is auto-initialized as a local git repo. So by default, `akm save` gives you a commit history of every change you've made to your skill collection, without requiring a remote. Add a remote and flip `writable: true` when you're ready to sync across machines.

This changes how you think about managing your personal stash. It's not a pile of files in `~/.akm`. It's a versioned repository. You can see when you wrote a skill, what it looked like before you changed it, and whether your teammates have made updates since you last pulled.

## How These Three Features Work Together

Consider a deployment procedure that a team runs regularly. Before 0.5.0, you'd write a deploy skill and hope the agent followed the steps in the right order. With 0.5.0:

**Step 1: Write the workflow once.**

```sh
akm workflow create ship-release
# Edit workflows/ship-release.md with your team's exact steps
```

**Step 2: Add a vault with the production secrets.**

The vault file lives at `vaults/production.env` in your stash. The keys are there; the values are managed separately through whatever secret management you use.

**Step 3: Save both to the team stash.**

```sh
akm save team-skills -m "Add ship-release workflow and production vault"
```

Every developer on the team pulls the update with `akm update --all`. Now everyone has the same workflow and the same vault definition.

**Step 4: When it's time to deploy, the agent runs the procedure.**

```sh
# Agent starts a run
akm workflow start workflow:ship-release --params '{"version":"2.0.0"}'

# Gets the first step
akm workflow next workflow:ship-release
# → "Validate inputs: confirm version and vault keys"

# Checks the vault without reading secrets
akm vault show vault:production
# → { keys: ["DATABASE_URL", "API_KEY", "DEPLOY_TARGET"] }

# Marks the step complete
akm workflow complete run-xyz --step validate --notes "All keys present"

# Gets the next step
akm workflow next workflow:ship-release
# → "Build: run bun run build..."
```

If the session ends at the staging step, a fresh agent picks up with:

```sh
akm workflow next workflow:ship-release
# → "Deploy to staging" — still pending from the previous session
```

No context reconstruction. No "where did we leave off?" The procedure state is in the workflow run, not the conversation.

When the deploy is done, commit any skill or workflow improvements back to the team repo:

```sh
akm save team-skills -m "Improve staging health check step"
```

The team gets the improvement on next `akm update`.

## Getting Started

If you're on `akm` already, upgrade to the latest version:

```sh
npm install -g akm-cli@latest
# or
akm upgrade
```

To try workflows:

```sh
akm workflow template
# Copy the output to workflows/your-first-workflow.md and edit it
akm workflow create your-first-workflow
akm workflow start workflow:your-first-workflow
```

To add a vault, drop a `.env` file in `vaults/` in your stash. The format is standard `.env` — one `KEY=value` per line, comments with `#`.

To make your default stash writable, add a remote to the git repo in `~/.akm/stash` and update your stash config with `--writable`. Run `akm save -m "Initial commit"` to verify it pushes.

The repo is at [github.com/itlackey/akm](https://github.com/itlackey/akm). The [Getting Started guide](https://github.com/itlackey/akm/blob/main/docs/getting-started.md) covers initial setup if you're coming in new.

Agents are most useful when they can handle real work end-to-end. Real work usually involves multiple steps, sensitive configuration, and sessions that get interrupted. Workflows, vaults, and a writable stash close those gaps. Give them a try on the next multi-step task you'd normally hand off with a checklist.
