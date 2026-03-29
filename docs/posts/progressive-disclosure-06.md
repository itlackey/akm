---
title: "Your Agent Loads 47 Skills at Startup. It Needs Three."
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm
description: The napkin math behind progressive disclosure, and how akm makes it work across every platform you use.
tags:
  - ai
  - agents
  - cli
  - skills
published: false
---

Quick recap if you're joining mid-series. In [part one](https://dev.to/itlackey/your-ai-agents-skill-list-is-getting-out-of-hand-32ck), I introduced the problem: your agent's skill list is growing faster than you can manage it, and dumping everything into context makes things worse, not better. [Part two](https://dev.to/itlackey/you-already-have-dozens-of-agent-skills-you-just-cant-find-them-bpo) showed how `akm` unifies your existing Claude Code, Cursor, and Codex assets into one searchable stash. [Part three](https://dev.to/itlackey/your-agents-memory-shouldnt-disappear-when-the-session-ends) added remote context via OpenViking. [Part four](https://dev.to/itlackey/your-agent-doesnt-know-what-the-community-already-figured-out) connected your agent to community knowledge through Context Hub.

This post zooms in on the pattern that makes all of that work: progressive disclosure. I've mentioned it in every post so far, but I haven't really shown the math or walked through what actually happens under the hood. Let's fix that.

## You're Paying for Context You Don't Use

Say you've got 47 skills across three platforms. That's not a crazy number — if you've been building with agents for a few months, you're probably there already. The average skill file runs about 1,000 tokens.

Now do the napkin math.

**Load everything at startup:** 47,000 tokens. Your agent sees all of it, whether the current task needs zero skills or five. Those extra 42,000 tokens aren't free. They degrade response quality, increase latency, and cost real money on metered APIs.

**Search first, load second:** A search query comes back with 20 results at ~100 tokens each. That's 2,000 tokens. Your agent reads the summaries, decides it needs one skill, and loads it: 1,000 tokens. Total: 3,000 tokens.

That's a 94% reduction. Not by being clever with compression or prompt engineering. Just by not loading stuff you don't need.

The math alone justifies the pattern. But the implementation is where it gets interesting.

## How It Actually Works

There are three steps. Search, load, and drill down. Here's what each one looks like.

### Search

```sh
akm search "deploy to staging"
```

This returns a ranked list of matching assets across all your sources. Each result has the asset type and name (`skill:deploy-staging`), where it came from, a description snippet, and a relevance score.

Total cost: ~100 tokens per result. Your agent scans this list and decides what's relevant. Most of the time, it needs one or two assets out of twenty results. The other eighteen never enter the context window.

### Load

```sh
akm show skill:deploy-staging
```

Now the agent loads the full content of a single asset. The complete skill definition, instructions, examples — everything it needs to act. This is the only moment the full content enters the context window, and only for the assets the agent specifically chose.

Cost: ~500-1,500 tokens per asset, depending on complexity.

### Drill Down

```sh
akm show knowledge:api-guide toc
akm show knowledge:api-guide section "Authentication"
```

For knowledge assets — documentation, guides, API references — `akm` supports table-of-contents navigation. The agent can see the structure of a document and request a specific section instead of loading the whole thing.

A 10,000-token API guide becomes a 200-token table of contents, then a 1,500-token section load. The agent never sees the eight sections it doesn't need.

## It Works Across All Your Tools

Here's the part that most implementations miss. Claude Code does progressive disclosure for skills in `~/.claude/skills/`. That's great — for Claude Code. But what about your Cursor rules? Your Codex agents? Your team's shared Git repository of skills?

Every platform implements this pattern within its own silo. `akm` implements it *across* silos.

```sh
# One-time setup: point akm at everything
akm add ~/.claude/skills
akm add ~/.codex/skills
akm add .cursor/rules
akm add github:your-org/team-skills

# Every search hits all sources
akm search "database migration"
```

That single search query returns ranked results from every source. The scoring pipeline treats local filesystem assets and remote Git-hosted assets fairly — no source gets artificially boosted or suppressed. The best match wins, regardless of where it lives.

## What a Real Session Looks Like

Your agent gets a task: "Deploy the staging environment with the new database migration."

1. **Search.** The agent runs `akm search "deploy staging database migration"`. Gets 15 results across three sources.

2. **Evaluate.** The agent reads the result summaries (~1,500 tokens). Identifies two relevant assets: `skill:deploy-staging` and `knowledge:migration-runbook`.

3. **Load.** The agent runs `akm show skill:deploy-staging` and `akm show knowledge:migration-runbook`. Loads ~2,500 tokens of directly relevant content.

4. **Act.** The agent executes the deployment using the loaded skill and references the runbook for the migration steps.

Total context cost: ~4,000 tokens. Without progressive disclosure, the agent would've loaded all 47 skills (47,000 tokens) and still might not have found the migration runbook because it lives in a different source than the deployment skill.

## Setting It Up

The agent integration is a two-line addition to your `AGENTS.md`:

```markdown
## Agent Kit

Search for skills, commands, and knowledge using `akm search <query>`.
View full details with `akm show <ref>`.
```

That's the entire interface. The agent knows how to search, knows how to load, and handles the progressive disclosure pattern on its own. No configuration, no routing rules, no platform-specific adapters.

## This Is What Makes Teams Work

Progressive disclosure becomes even more valuable at team scale. When your team has hundreds of shared skills plus each developer's personal collection, front-loading is physically impossible. Search-then-load isn't just an optimization — it's the only viable approach.

In the [next post](https://dev.to/itlackey), I'll cover how teams can share skills across a group while preserving individual customization. The progressive disclosure pattern is the foundation that makes team-scale skill management work.

If you want to see this in action, the repo is at [github.com/itlackey/akm](https://github.com/itlackey/akm). Point it at your skill directories, run a search, and see how much context you've been wasting.
