---
title: 'Stop Copying Skills Between Claude Code, Cursor, and Codex'
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm
description: Your agent skills are scattered across three tools. Here's why indexing in place beats copying or syncing.
tags:
  - ai
  - agents
  - cli
  - skills
published: false
id: 3426225
---

This is part five in a series about wrangling the growing pile of skills, scripts, and context that AI coding agents depend on. In [part one](https://dev.to/itlackey/your-ai-agents-skill-list-is-getting-out-of-hand-32ck), I covered why progressive disclosure beats dumping everything into context. [Part two](https://dev.to/itlackey/you-already-have-dozens-of-agent-skills-you-just-cant-find-them-bpo) showed how `akm` unifies your local assets across platforms into one searchable stash. [Part three](https://dev.to/itlackey/your-agents-memory-shouldnt-disappear-when-the-session-ends) added remote context via OpenViking for teams. And [part four](https://dev.to/itlackey/your-agent-doesnt-know-what-the-community-already-figured-out) plugged in community knowledge through Context Hub.

All of that assumed you were picking one tool. But you're probably not. You've got Claude Code at work, Codex for side projects, Cursor for quick edits. Each one has its own skills directory — `~/.claude/skills/`, `~/.codex/skills/`, `.cursor/rules/` — and none of them can see each other.

So you rebuild the same deploy skill twice. You forget where the good version of your testing scaffold lives. You copy files between directories and they drift within a week. You end up grepping across three different paths trying to find the one that handled database migrations correctly.

This isn't a tooling problem. It's a discovery problem. And in the past week alone, three separate products launched to fix it — a macOS GUI for browsing skill files, a web-based editor for organizing them, a designer's viral Medium post about layered architecture for skills. People are clearly hurting here.

But every one of those solutions wants you to *move* your files somewhere. Copy them into a central location. Sync them between directories. Maintain one source of truth that you manually keep updated.

There's a better approach: don't move anything. Just make everything searchable.

## Copy and Sync (The Obvious Way)

Pick a canonical directory, copy everything into it, keep it updated. Tools like ClaudeMDEditor make this easier with a GUI, and symlinks can automate some of it.

Works great — until it doesn't. You update the original and forget to sync. The copy drifts. You end up with two versions of the same skill, slightly different, and no way to tell which is current. The maintenance overhead scales linearly with every new skill and every new platform.

## GUI Discovery (The Pretty Way)

Tools like Chops give you a nice interface for browsing your skill files. You can see what's where, organize them visually, tag them.

But your agent can't use a GUI. When Claude Code is mid-task and needs a deployment skill, it can't open an Electron app and browse around. It needs something it can *call* — a programmatic interface that returns results without human intervention.

## Index in Place (The akm Way)

This is the approach [akm](https://github.com/itlackey/akm) takes. Don't move your files. Don't copy them. Don't sync them. Just point at them and build an index.

Your skills stay exactly where each tool expects them. Claude Code still finds its skills in `~/.claude/skills/`. Cursor still reads `.cursor/rules/`. Nothing breaks. But now there's a single search layer across all of them.

When your agent needs something, it searches once and gets results from every source. When you update a skill in its original location, the index picks up the change. No sync step. No drift.

## Five Commands and You're Done

Here's the full setup. Takes about 30 seconds.

```sh
# Install
curl -fsSL https://raw.githubusercontent.com/itlackey/akm/main/install.sh | bash

# Initialize
akm setup

# Point at your existing skill directories
akm add ~/.claude/skills
akm add ~/.codex/skills
akm add .cursor/rules

# Search across all of them
akm search "deploy"
```

That last command returns results from every source, ranked by relevance. Each result shows the asset type, name, source, and a snippet. Your agent — or you — can load the full content:

```sh
akm show skill:deploy-to-production
```

Only the skill you need gets loaded into context. Everything else stays out.

## Tell Your Agent About It

Here's the part that ties it all together. Drop this into your `AGENTS.md`, `CLAUDE.md`, or system prompt:

```markdown
## Resources & Capabilities

Search for skills, commands, and knowledge using `akm search <query>`.
View full details with `akm show <ref>`.
```

That's the entire integration. No plugins, no SDKs, no integration code. Any model that can run shell commands can use `akm`. Claude Code, Codex, Cursor — if it has a terminal, it works.

The agent runs `akm search` to find what it needs, `akm show` to load the content, and gets to work. Everything else stays out of context. Progressive disclosure — the agent discovers what exists, then activates only what it needs. If that pattern sounds familiar, I covered the architecture behind it in [part one](https://dev.to/itlackey/your-ai-agents-skill-list-is-getting-out-of-hand-32ck).

## What's Next

This post covered the individual developer workflow — one person, multiple tools, skills everywhere. But what happens when a team of five developers each has their own skills across three platforms? That's where things get interesting, and where akm's source model, Git integration, and private registry support come into play.

For now: install akm, point it at your directories, and run `akm search`. You'll be surprised how many skills you already have.

Give it a look at [github.com/itlackey/akm](https://github.com/itlackey/akm). If you've got agent assets scattered across platforms, give it a shot and let me know what breaks.
