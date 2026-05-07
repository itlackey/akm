---
title: What akm Actually Does: A Command-by-Command Tour
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm-basics
description: A high-level guide to what akm is for, what each command does, and how teams use the CLI in real workflows.
tags:
  - ai
  - agents
  - cli
  - productivity
published: false
date: '2026-05-07T19:11:20Z'
---

If you've looked at `akm` for the first time and thought "this seems useful, but what do all these commands actually *do*?" this post is for you.

At a high level, `akm` is a package manager for AI agent capabilities. It gives your agents a searchable library of scripts, skills, commands, agents, knowledge docs, workflows, vaults, wikis, lessons, and memories. Instead of dumping everything into a giant system prompt, you let the agent discover what it needs with search, then load the right asset at the right time.

That's the big idea. The practical question is how the command surface fits together in day-to-day work.

This post walks through the CLI by job-to-be-done, with real examples of when you'd use each command.

## The Short Version

You can think about `akm` in six layers:

1. **Set up the workspace** — `setup`, `init`, `config`, `info`, `index`
2. **Bring content in** — `add`, `list`, `update`, `remove`, `clone`
3. **Find and inspect assets** — `search`, `curate`, `show`
4. **Write new local knowledge** — `remember`, `import`, `save`
5. **Run structured workflows and secure context** — `workflow`, `vault`, `wiki`
6. **Operate the system** — `feedback`, `history`, `events`, `registry`, `help`, `hints`, `completions`, `upgrade`, plus the proposal commands

If you only remember one mental model, make it this:

- `akm add` tells akm where content lives
- `akm index` makes that content searchable
- `akm search` finds the right thing
- `akm show` loads the full thing

Everything else supports one of those steps.

## What akm Is Really For

Most teams already have agent assets. They're just scattered.

- Claude Code skills in one folder
- OpenCode commands in another
- project notes in random markdown files
- internal runbooks in a docs repo
- half-remembered lessons buried in old chats

`akm` turns that mess into a searchable, reusable library.

For example, imagine a team that ships a web app every week. They might use `akm` to unify:

- local review and release skills
- a shared Git repo of deployment workflows
- internal docs imported as knowledge
- a production vault that exposes secret *keys* without leaking values
- memories like "staging deploys require VPN"

Now an agent can search for "ship release", load the release workflow, check the deployment vault, read the runbook section it needs, and proceed without every asset being loaded into context upfront.

## 1. First-Run and Environment Commands

### `akm setup`

Use this when you want the guided on-ramp.

```sh
akm setup
```

Real-world use: you just installed `akm` on a new laptop and want the wizard to create the working stash, configure providers, and build the first index without editing config by hand.

### `akm init`

Use this when you want to skip the wizard and just create the working stash.

```sh
akm init --dir ~/akm
```

Real-world use: you're scripting environment bootstrap for a devcontainer or CI image and want a known stash location without interactive prompts.

### `akm config`

Use this to inspect or change settings.

```sh
akm config get output.format
akm config set output.detail full
akm config path --all
```

Real-world use: your agent prefers text output in one repo and JSON in another, or you want to set a default write target for memories and imports.

### `akm info`

Use this as the health check.

```sh
akm info
```

Real-world use: after setup, you want to confirm the version, active sources, registries, and whether semantic search is actually ready.

### `akm index`

Use this whenever content changed and you want search to reflect it.

```sh
akm index
akm index --full
```

Real-world use: you added a GitHub stash, imported some docs, and created two memories. `akm index` refreshes the local search database so the agent can discover them.

## 2. Source Management Commands

These commands answer a simple question: where should akm look for assets?

### `akm add`

This is how you register a source.

```sh
akm add ~/.claude/skills
akm add github:your-org/team-agent-toolkit
akm add @scope/platform-stash
akm add https://docs.example.com --name public-docs
```

Real-world use:

- point `akm` at your existing Claude Code skills
- pull in a shared team stash from GitHub
- install an npm-published stash
- crawl a documentation site as searchable knowledge

### `akm list`

Shows what sources are already connected.

```sh
akm list
```

Real-world use: you're debugging why a search result isn't appearing and want to verify whether the expected repo or local directory is even registered.

### `akm update`

Refreshes managed sources.

```sh
akm update --all
```

Real-world use: your platform team shipped an updated deployment stash and everyone pulls the latest version before a release.

### `akm remove`

Disconnect a source you no longer want indexed.

```sh
akm remove public-docs
```

Real-world use: a website source became noisy or outdated and you want it out of search results.

### `akm clone`

Copies a single asset into your working stash or another directory so you can edit it locally.

```sh
akm clone skill:code-review
akm clone "npm:@scope/platform-stash//workflow:ship-release"
```

Real-world use: you find a good community skill, clone it into your local stash, and tailor it for your team's code review conventions.

### `akm save`

Commit local stash changes, and optionally push if the source is writable.

```sh
akm save -m "Tighten release workflow"
```

Real-world use: your team keeps its shared stash in Git. After improving a workflow and a vault comment, `akm save` records the change like normal code.

## 3. Discovery Commands

This is the heart of the product.

### `akm search`

Search the indexed library.

```sh
akm search "review a large pull request"
akm search "kubernetes deploy" --type workflow
```

Real-world use: the agent needs a deploy workflow, a release checklist, or a review skill, but doesn't know the exact filename. It searches by intent instead of path.

### `akm curate`

Return a smaller, follow-up-friendly shortlist.

```sh
akm curate "ship a bun release"
```

Real-world use: instead of getting twenty mixed hits, you want a few strong candidates and the next command to run for each one.

### `akm show`

Load the full content of a specific asset.

```sh
akm show skill:code-review
akm show workflow:ship-release
akm show knowledge:incident-runbook section "Rollback"
```

Real-world use: search finds the right asset; show gives the agent the actual instructions, prompt template, workflow steps, or document section it needs to act.

## 4. Knowledge Capture Commands

These commands let the stash get smarter over time.

### `akm remember`

Write a memory.

```sh
akm remember "Staging deploys require VPN access" --tag ops --tag deploy
```

Real-world use: after an incident or a successful fix, you capture the lesson in a searchable format so the next agent run doesn't rediscover it the hard way.

### `akm import`

Bring a document into the stash as knowledge.

```sh
akm import ./docs/release-checklist.md
akm import https://example.com/internal-guide/auth
```

Real-world use: you have a good architecture note or ops runbook outside the stash and want it indexed alongside everything else.

### `akm feedback`

Record whether an asset helped.

```sh
akm feedback workflow:ship-release --positive
akm feedback skill:legacy-deploy --negative --note "Outdated after platform migration"
```

Real-world use: over time, assets that consistently help rise in ranking and stale ones become easier to spot.

### `akm history`

Inspect the recorded state changes for an asset or the stash.

```sh
akm history --ref workflow:ship-release
```

Real-world use: you want to know whether a workflow was searched, shown, or downvoted recently while cleaning up a team's stash.

### `akm events`

Read the append-only realtime event stream.

```sh
akm events tail --format jsonl
```

Real-world use: another process is watching `akm` activity and reacting when new feedback, imports, or proposals land.

## 5. Commands for Structured Agent Work

This is where `akm` becomes more than a search tool.

### `akm workflow`

Use workflows for repeatable, resumable procedures.

```sh
akm workflow start workflow:ship-release --params '{"version":"2.4.0"}'
akm workflow next workflow:ship-release
akm workflow complete run-123 --step validate --notes "Version and branch confirmed"
```

Real-world use: shipping a release, rotating secrets, onboarding a new service, or any other multi-step process that should survive across sessions instead of living only in chat history.

### `akm vault`

Use vaults when the agent needs to know which secrets exist without seeing the secret values.

```sh
akm vault show vault:production
eval "$(akm vault load vault:production)"
```

Real-world use: a deploy workflow needs `DATABASE_URL` and `DEPLOY_TOKEN`. The agent can verify the keys are present, then load the environment only at execution time.

### `akm wiki`

Use wikis for long-lived, agent-maintained knowledge bases.

```sh
akm wiki create architecture
akm wiki stash architecture ./notes/auth-redesign.md
akm wiki lint architecture
```

Real-world use: your team wants a research or architecture wiki with raw sources, curated pages, and deterministic linting instead of ad hoc markdown sprawl.

## 6. Registry and Ecosystem Commands

### `akm registry`

Use registries to discover new stashes you have not installed yet.

```sh
akm registry search "code review"
akm registry add https://example.com/registry/index.json --name team
```

Real-world use: platform engineering publishes an internal stash registry, and teams browse it the same way they'd browse a package registry.

### `akm help`

Focused help topics, especially migrations.

```sh
akm help migrate latest
```

Real-world use: you upgraded `akm` and want the release-specific migration notes without leaving the terminal.

### `akm hints`

Print instructions you can drop into `AGENTS.md` or `CLAUDE.md`.

```sh
akm hints
```

Real-world use: you want every project to tell its coding agent how to use the local `akm` installation.

### `akm completions`

Generate or install shell completion.

```sh
akm completions --install
```

Real-world use: you use `akm` daily and want tab completion for commands and flags.

### `akm upgrade`

Upgrade the `akm` binary itself.

```sh
akm upgrade --check
```

Real-world use: you installed the standalone binary and want to see whether a newer release is available.

## 7. Reflection and Proposal Commands

These are the commands for improving the stash without mutating it directly.

### `akm reflect`

Ask an external agent to propose improvements to an existing asset.

```sh
akm reflect skill:code-review --task "make this stricter about test coverage"
```

Real-world use: you have a decent review skill, but want an agent to suggest a better version without overwriting the live one.

### `akm propose`

Generate a brand-new asset proposal.

```sh
akm propose workflow incident-rollback --task "Rollback procedure for failed production deploys"
```

Real-world use: seed a new asset from a plain-language description instead of hand-authoring the first draft.

### `akm proposal`

Review, diff, accept, or reject queued proposals.

```sh
akm proposal list
akm proposal diff 42
akm proposal accept 42
```

Real-world use: keep human review in the loop before generated assets become part of the live stash.

### `akm distill`

Summarize feedback into a reusable lesson proposal.

```sh
akm distill skill:code-review
```

Real-world use: repeated feedback on a skill gets turned into a lesson asset that captures what people learned from using it.

## 8. The Commands People Use Most

In practice, most teams live in a much smaller subset of the CLI:

```sh
akm setup
akm add ...
akm index
akm search "..."
akm show <ref>
akm remember "..."
akm feedback <ref> --positive
```

If your use case grows, the rest of the command surface is there:

- `workflow` when procedures need state
- `vault` when secrets enter the picture
- `wiki` when knowledge needs structure
- `registry` when discovery goes beyond your local stash
- `reflect` / `propose` / `proposal` / `distill` when you want an improvement loop

## A Simple End-to-End Example

Let's say your team is onboarding a new service.

1. Run `akm add github:your-org/platform-stash`
2. Run `akm add ./docs/runbooks`
3. Run `akm index`
4. Search with `akm search "onboard a new service"`
5. Open the best match with `akm show workflow:service-onboarding`
6. Check required environment keys with `akm vault show vault:staging`
7. Capture a new lesson with `akm remember "Service onboarding requires DNS approval from ops" --tag ops`
8. Record whether the workflow helped with `akm feedback workflow:service-onboarding --positive`

That's `akm` in a nutshell: connect sources, index them, find what matters, load only what you need, and keep the library getting better.

## Final Takeaway

`akm` is not trying to replace your coding assistant. It's the layer that makes your assistant's skills, docs, procedures, and institutional memory manageable at scale.

If you want the one-sentence version:

> `akm` is the command line system that helps agents discover, load, share, improve, and safely reuse the capabilities they need to do real work.

And if you're wondering where to start, start here:

```sh
akm setup
akm add ~/.claude/skills
akm add github:your-org/team-agent-toolkit
akm index
akm search "code review"
akm show skill:code-review
```

That gets you from "I installed it" to "my agent can actually use it" in a few minutes.
