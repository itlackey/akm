---
title: Stop Copying Skills Between Claude Code, Cursor, and Codex
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm
description: Your agent skills are scattered across three tools. Here's why indexing in place beats copying or syncing.
tags:
  - ai
  - agents
  - cli
  - skills
published: false
---

You use Claude Code at work. Codex for side projects. Cursor for quick edits. Each one has its own skills directory. `~/.claude/skills/`, `~/.codex/skills/`, `.cursor/rules/`. None of them can see each other.

So you rebuild the same deploy skill twice. You forget where the good version of your testing scaffold lives. You copy files between directories and they drift within a week. You grep across three different paths trying to find the one that handled database migrations correctly.

This isn't a tooling problem. It's a discovery problem. And it's getting worse as more coding assistants ship their own skills systems.

In the past week alone, three separate products launched to solve this exact pain point. A macOS GUI for browsing skill files. A web-based editor for organizing them. A designer's viral Medium post about building a layered architecture to keep skills manageable. The demand signal is unmistakable: developers have skills everywhere and no unified way to find them.

But every solution so far assumes you want to move your files somewhere. Copy them into a central location. Sync them between directories. Maintain a single source of truth that you manually keep updated.

There's a better approach: don't move anything. Just make everything searchable.

## The Three Approaches

### Copy and Sync

The most obvious solution: pick a canonical directory, copy everything into it, keep it updated. Tools like ClaudeMDEditor make this easier with a GUI, and symlinks can automate some of it.

It works — until it doesn't. You update the original and forget to sync. The copy drifts. You end up with two versions of the same skill, slightly different, and no way to know which is current. The maintenance overhead scales linearly with the number of skills and platforms.

### GUI Discovery

Tools like Chops give you a nice interface for browsing your skill files. You can see what's where, organize them visually, maybe tag them.

But your agent can't use a GUI. When Claude Code is mid-task and needs a deployment skill, it can't open an Electron app and browse. It needs a programmatic interface — something it can call, get results from, and act on without human intervention.

### Index in Place

This is the approach [akm](https://github.com/itlackey/akm) takes. Don't move your files. Don't copy them. Don't sync them. Just point at them and build an index.

Your skills stay exactly where each tool expects them. Claude Code still finds its skills in `~/.claude/skills/`. Cursor still reads `.cursor/rules/`. Nothing breaks. But now there's a single search layer across all of them.

When your agent needs something, it searches once and gets results from every source. When you update a skill in its original location, the index picks up the change. No sync step. No drift.

## Five Commands to Unified Search

Here's the full setup. This takes about 30 seconds.

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

That last command returns results from every source, ranked by relevance. Each result shows the asset type, name, source, and a snippet. Your agent — or you — can then load the full content:

```sh
akm show skill:deploy-to-production
```

Only the skill you need gets loaded into context. Everything else stays out.

## Agent Integration

The real power isn't in the CLI — it's in what your agent does with it. Add this to your project's `AGENTS.md`:

```markdown
## Agent Kit

Search for skills, commands, and knowledge using `akm search <query>`.
View full details with `akm show <ref>`.
```

Now your agent has access to every skill across every platform, loaded on demand. It searches when it needs something, loads only what's relevant, and keeps its context window clean. No manual curation. No startup bloat.

This is progressive disclosure in practice: the agent discovers what exists, then activates only what it needs. If you want to understand the architecture behind this pattern, I covered it in [Part 1 of this series](https://dev.to/itlackey/your-ai-agents-skill-list-is-getting-out-of-hand-32ck).

## What's Next

This post covered the individual developer workflow. But what happens when a team of five developers each has their own skills across three platforms? That's where things get really interesting — and where akm's source model, Git integration, and private registry support come into play.

For now: install akm, point it at your directories, and run `akm search`. You'll be surprised how many skills you already have.

- [akm on GitHub](https://github.com/itlackey/akm)
- [Getting Started guide](https://github.com/itlackey/akm/blob/main/docs/getting-started.md)
- [Part 3: OpenViking and Public Registries](https://dev.to/itlackey/you-dont-have-to-build-every-agent-skill-yourself-25ah)
