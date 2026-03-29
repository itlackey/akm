---
title: "Progressive Disclosure Isn't Just Theory — Here's How akm Implements It"
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm
description: Everyone explains progressive disclosure for agent skills. Nobody shows a working cross-platform implementation. Until now.
tags:
  - ai
  - agents
  - cli
  - skills
published: false
---

Progressive disclosure is the hottest architectural concept in agent skills right now. [Google's developer blog](https://developers.googleblog.com/) explains it for Gemini. [Microsoft Learn](https://learn.microsoft.com/) documents it for Copilot. Anthropic's best practices recommend it for Claude Code. LangChain, Substack writers, Medium authors — everyone agrees that agents perform better when they load context on demand instead of upfront.

But every article stops at the theory. They explain *why* progressive disclosure matters, then show how a single platform implements it internally. Nobody has published a working implementation that spans platforms and that you can install and use today.

That's what [akm](https://github.com/itlackey/akm) does. And the architecture maps directly to the three-tier pattern these articles describe.

## The Context Problem, Quantified

Before we get to the implementation, let's be concrete about why this matters.

Say you have 47 skills across three platforms — Claude Code, Cursor, and Codex. A reasonable collection for someone who's been building with agents for a few months. The average skill file is about 1,000 tokens.

**Front-loading everything:** 47,000 tokens loaded at startup. Your agent sees all of it, whether the current task needs zero skills or five. Those extra 42,000 tokens aren't free — they degrade response quality, increase latency, and cost real money on metered APIs.

**With progressive disclosure:** A search query returns 20 results at ~100 tokens each: 2,000 tokens. Your agent reads the summaries, decides it needs one skill, and loads it: 1,000 tokens. Total: 3,000 tokens. That's a 94% reduction.

The math alone justifies the pattern. But the implementation is where it gets interesting.

## Three Tiers in Practice

### Tier 1: Discovery

```sh
akm search "deploy to staging"
```

This returns a ranked list of matching assets across all your sources. Each result contains:

- Asset type and name (`skill:deploy-staging`)
- Source location
- Description snippet
- Relevance score

Total cost: ~100 tokens per result. Your agent scans this list and decides what's relevant to the current task. Most of the time, it needs one or two assets out of twenty results. The other eighteen never enter the context window.

### Tier 2: Activation

```sh
akm show skill:deploy-staging
```

Now the agent loads the full content of a single asset. The complete skill definition, instructions, examples — everything the agent needs to act on it. This is the only moment the full content enters the context window, and only for the assets the agent specifically chose.

Cost: ~500-1,500 tokens per asset, depending on the skill's complexity.

### Tier 3: Targeted Reference

```sh
akm show knowledge:api-guide
```

For knowledge assets — documentation, guides, API references — akm supports table-of-contents navigation. The agent can see the structure of a document and request a specific section instead of loading the entire thing.

A 10,000-token API guide becomes a 200-token table of contents, then a 1,500-token section load. The agent never sees the eight sections it doesn't need.

## The Cross-Platform Dimension

This is where akm diverges from every platform's built-in approach.

Claude Code does progressive disclosure for skills in `~/.claude/skills/`. That's great — for Claude Code. But what about your Cursor rules? Your Codex agents? Your team's shared Git repository of skills?

Each platform implements progressive disclosure within its own silo. akm implements it *across* silos.

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

## What the Agent Actually Does

Here's the workflow in a real session. Your agent gets a task: "Deploy the staging environment with the new database migration."

1. **Search:** The agent runs `akm search "deploy staging database migration"`. Gets 15 results across three sources.

2. **Evaluate:** The agent reads the result summaries (~1,500 tokens). Identifies two relevant assets: `skill:deploy-staging` and `knowledge:migration-runbook`.

3. **Load:** The agent runs `akm show skill:deploy-staging` and `akm show knowledge:migration-runbook`. Loads ~2,500 tokens of directly relevant content.

4. **Act:** The agent executes the deployment using the loaded skill and references the runbook for the migration steps.

Total context cost: ~4,000 tokens. Without progressive disclosure, the agent would have loaded all 47 skills (47,000 tokens) and still might not have found the migration runbook because it lives in a different source than the deployment skill.

## Setting It Up

The agent integration is a two-line addition to your `AGENTS.md`:

```markdown
## Agent Kit

Search for skills, commands, and knowledge using `akm search <query>`.
View full details with `akm show <ref>`.
```

That's the entire interface. The agent knows how to search, knows how to load, and handles the progressive disclosure pattern automatically. No configuration, no routing rules, no platform-specific adapters.

## Beyond Individual Use

Progressive disclosure becomes even more valuable at team scale. When your team has hundreds of shared skills plus each developer's personal collection, front-loading is physically impossible. Search-then-load isn't just an optimization — it's the only viable approach.

In the [next post](https://dev.to/itlackey), I'll cover how teams can share skills across a group while preserving individual customization. The progressive disclosure pattern is the foundation that makes team-scale skill management work.

## Resources

- [akm on GitHub](https://github.com/itlackey/akm)
- [Concepts: How akm organizes assets](https://github.com/itlackey/akm/blob/main/docs/concepts.md)
- [Part 1: Your AI Agent's Skill List Is Getting Out of Hand](https://dev.to/itlackey/your-ai-agents-skill-list-is-getting-out-of-hand-32ck)
- [Part 2: You Already Have Dozens of Agent Skills](https://dev.to/itlackey/you-already-have-dozens-of-agent-skills-you-just-cant-find-them-bpo)
