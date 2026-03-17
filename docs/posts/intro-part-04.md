---
title: Your Agent Doesn't Know What the Community Already Figured Out
cover_image: 'https://raw.githubusercontent.com/itlackey/agentikit/main/docs/posts/akm-logo-sized.webp'
series: akm
description: How to connect your agent to curated community knowledge with the Context Hub integration
tags:
  - ai
  - agents
  - cli
  - skills
published: false
id: 3363736
---

This is part four in a series about managing the growing pile of skills, scripts, and context that AI coding agents depend on. In [part one](https://dev.to/itlackey/your-ai-agents-skill-list-is-getting-out-of-hand-32ck), I covered why progressive disclosure beats dumping everything into context. [Part two](https://dev.to/itlackey/you-already-have-dozens-of-agent-skills-you-just-cant-find-them) showed how `akm` unifies your local assets across platforms into one searchable stash. [Part three](https://dev.to/itlackey/your-agents-memory-shouldnt-disappear-when-the-session-ends) added remote context via OpenViking for teams that need persistent, shared knowledge.

All of that assumed you were building your own library from scratch. Your skills. Your knowledge docs. Your team's accumulated context. That's fine — and it's necessary — but it ignores a much larger resource: everything everyone else has already built.

Right now, there are high-quality skills and knowledge documents sitting in public repositories that solve problems you're going to hit next week. Prompt-chaining patterns. API integration guides. Framework-specific coding conventions. Stuff that experienced practitioners have refined and published, ready to use. Your agent has no idea any of it exists.

That's what the [Context Hub](https://github.com/andrewyng/context-hub) integration fixes.

## What Is Context Hub?

Context Hub is a public GitHub repository — originally curated by Andrew Ng's team — structured specifically for agent consumption. It organizes community-contributed knowledge and skills into a browsable, searchable hierarchy under a `content/` directory. Each entry is either a `DOC.md` (knowledge) or a `SKILL.md` (skill), with frontmatter metadata for descriptions, tags, languages, and versions.

Think of it like a curated package registry, except instead of code libraries, it's agent context. Each document is a self-contained piece of knowledge or a skill definition that any agent can pick up and use immediately. No installation, no dependencies, no build step.

The structure is intentionally simple:

```
content/
  openai/
    docs/
      chat-api/
        python/
          DOC.md
    skills/
      prompt-chaining/
        SKILL.md
  anthropic/
    docs/
      tool-use/
        typescript/
          DOC.md
```

Every entry gets a unique `context-hub://` ref, which means `akm` can search and display it the same way it handles anything else in your stash.

## One Command to Connect

If you already have `akm` installed:

```bash
akm add context-hub
```

That's the full setup. Under the hood, this registers the default Context Hub repository as a stash provider. It downloads the repo as an archive, extracts it into a local cache, and builds a searchable index of every `DOC.md` and `SKILL.md` inside.

The cache refreshes automatically every 12 hours. If the network is down, it falls back to stale cache for up to 7 days. Your local stash still works regardless — the Context Hub provider degrades gracefully without taking anything else down with it.

Verify it's registered:

```bash
akm stash list
```

You should see `context-hub` in the list alongside your local stash directories and any other providers you've configured.

## Search Works the Same Way

Here's what changes in practice: nothing about your workflow. You still run `akm search`. The difference is that results now include entries from Context Hub alongside your local assets.

```bash
akm search "prompt chaining patterns"
```

This might return a local skill you wrote last month *and* a community-contributed skill from Context Hub. The results are unified — same ranking, same format, same `ref` handles. You can tell them apart because Context Hub entries use `context-hub://` refs and show `origin: "context-hub"` in the metadata.

Want to narrow it down to just skills?

```bash
akm search "api integration" --type skill
```

Or just knowledge documents?

```bash
akm search "coding standards" --type knowledge
```

The type filter applies across all sources — local, remote, and Context Hub alike.

## Show Works Too

When you find something useful, load it the same way you'd load any other asset:

```bash
akm show context-hub://content/openai/skills/prompt-chaining/SKILL.md
```

Your agent gets the full content — frontmatter, description, the complete skill definition — in the same format as every other `akm show` result. It doesn't need to know the asset lives on GitHub. It doesn't need a GitHub token. It just works.

Context Hub assets support the same view modes as local knowledge docs:

```bash
# Table of contents
akm show context-hub://content/openai/docs/chat-api/python/DOC.md --view toc

# Just the frontmatter metadata
akm show context-hub://content/openai/docs/chat-api/python/DOC.md --view frontmatter

# A specific section
akm show context-hub://content/openai/docs/chat-api/python/DOC.md --view section "Authentication"

# A line range
akm show context-hub://content/openai/docs/chat-api/python/DOC.md --view lines 10 25
```

For large documents, the `toc` and `section` views keep context lean. Your agent can scan the table of contents first, then pull only the section it needs. Progressive disclosure all the way down.

## Custom Context Hub Repositories

The default `akm add context-hub` points at Andrew Ng's repository, but you're not limited to that. Any GitHub repository that follows the `content/` directory convention works as a Context Hub source.

Say your organization maintains an internal knowledge base for agent context — API references, architecture decisions, coding standards. Structure it like this:

```
content/
  your-team/
    docs/
      api-reference/
        DOC.md
      architecture-decisions/
        DOC.md
    skills/
      deploy-pipeline/
        SKILL.md
```

Then add it:

```bash
akm stash add https://github.com/your-org/team-context-hub \
  --provider context-hub \
  --name "team-knowledge"
```

Now `akm search` queries your team's knowledge base alongside the public Context Hub and your local stash. All in one search. You can add as many Context Hub sources as you want — each gets its own cache and index.

Need a specific branch instead of `main`?

```bash
akm stash add https://github.com/your-org/team-context-hub/tree/staging \
  --provider context-hub \
  --name "team-staging"
```

The provider parses the GitHub URL and pulls the right branch automatically.

## What Your Agent Actually Sees

This is where the pieces from the whole series come together. After four posts, here's what a fully-wired `akm search` looks like from your agent's perspective:

```bash
akm search "deploy containers to production"
```

Results might include:

1. A local script from your primary stash — the deploy script you wrote last month
2. A team skill from an installed GitHub kit — the Docker Compose workflow your teammate packaged
3. A knowledge doc from OpenViking — the architecture decision about container orchestration from last sprint
4. A community skill from Context Hub — a battle-tested container deployment pattern that 50 other people have already vetted

Four different sources. One result set. One `akm show` command to load whichever one the agent needs. Everything else stays out of context.

The agent doesn't need to care about where an asset lives. Local file, installed kit, OpenViking server, Context Hub repo — the ref format handles routing. The agent searches, picks, loads, and gets to work.

## The Full Stack

Here's what the complete setup looks like after four posts:

```bash
# Install
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash
akm init

# Local platform assets
akm stash add ~/.claude/skills
akm stash add .opencode/skills
akm stash add .cursor/rules

# Community and team kits
akm add github:your-org/team-agent-toolkit
akm add @scope/deploy-skills

# Community knowledge
akm add context-hub

# Team knowledge (custom Context Hub repo)
akm stash add https://github.com/your-org/team-context-hub \
  --provider context-hub \
  --name team-knowledge

# Remote context server
akm stash add https://your-viking.internal:1933 \
  --provider openviking \
  --name team-context \
  --options '{"apiKey":"..."}'

# Build the local index
akm index
```

Drop the `AGENTS.md` snippet into every project:

```markdown
## Resources & Capabilities

You have access to a searchable library of scripts, skills, commands, agents,
knowledge, and memories via the `akm` CLI. Use `akm -h` for details.
```

And your agent has access to everything: local skills, platform assets, team kits, community registries, remote knowledge, persistent memories, and curated community context. One search, one interface.

## Why This Matters

The value of agent skills and knowledge compounds when it's shared. A prompt-chaining pattern that one person refines over a weekend becomes infrastructure when a thousand agents can find it. A coding standard document that one team writes becomes a community resource when it's discoverable from any stash.

Context Hub isn't the only way this will happen — community registries, marketplace-style discovery, and decentralized skill sharing are all coming. But it's working today, it's open source, and it plugs directly into the same `akm search` / `akm show` workflow you're already using.

If you've written skills or knowledge docs worth sharing, consider contributing them to [Context Hub](https://github.com/andrewyng/context-hub). Structure them with frontmatter, put them in a `content/` directory, and they become searchable for every agent running `akm`.

The repo is at [github.com/itlackey/agentikit](https://github.com/itlackey/agentikit). Context Hub is at [github.com/andrewyng/context-hub](https://github.com/andrewyng/context-hub). If you've got a team knowledge base that could work as a custom Context Hub, give the provider a try and let me know how it holds up.
