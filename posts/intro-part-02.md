---
title: You Already Have Dozens of Agent Skills. You Just Can't Find Them.
cover_image: 'https://raw.githubusercontent.com/itlackey/agentikit/main/posts/akm-logo.webp'
id: 3359719
series: akm
description: A quick introduction to managing stashes
tags:
  - ai
  - agents
  - cli
  - skills
published: true
date: '2026-03-16T17:26:29Z'
---

In the [last post](https://dev.to/itlackey/your-ai-agents-skill-list-is-getting-out-of-hand-32ck), I talked about the problem: your agent's skill collection is growing faster than your ability to manage it. Skills scattered across directories, no search, no sharing, no sanity. I introduced [Agentikit](https://github.com/itlackey/agentikit) as the fix — a CLI called `akm` that gives your agent a searchable, indexed stash of assets.

But here's what I glossed over: most of you aren't starting from zero. You've already got skills, commands, agents, and rules spread across multiple platforms. Claude Code has `~/.claude/skills/`. OpenCode has `.opencode/`. Cursor has `.cursor/rules/`. Codex has its `agents.md`. You might be using two or three of these tools in the same week, building up assets in each one, and none of them can see each other.

That's the real unlock with `akm`. It doesn't care where your assets came from. Point it at a directory, and it indexes everything inside. Point it at five directories, and now you've got semantic search across all of them. One command, every platform, every model.

Let me show you how fast this actually works.

## Install

Pick your poison:

```bash
# Standalone binary (no runtime needed)
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash

# Or via Bun
bun install -g akm-cli
```

That's it. You now have the `akm` binary on your PATH. And when a new version drops, `akm upgrade` handles it in place.

## Initialize Your Stash

```bash
akm init
```

This creates `~/akm` with subdirectories for each asset type: `scripts/`, `skills/`, `commands/`, `agents/`, `knowledge/`, and `memories/`. If you want to put it somewhere else, set `AKM_STASH_DIR` before you init.

But the real power move isn't putting everything in one folder. It's telling `akm` where your stuff already lives.

## Add Your Existing Platform Directories

Here's what most people's machines actually look like. You've got Claude Code skills in one place, OpenCode assets in another, maybe some Cursor rules in a third. Instead of copying files around or choosing a winner, just add them as stash sources.

```bash
akm stash add ~/.claude/skills
akm stash add ./my-project/.opencode/skills
akm stash add ./.cursor/rules
```

One command per directory. Each `akm stash add` registers the path, and the search index picks it up on the next build. No JSON editing, no manual config files. Your files stay exactly where they are — `akm` just knows about them now.

You can name sources to keep track of what's what:

```bash
akm stash add ~/.claude/skills --name "claude-skills"
akm stash add ./team-shared --name "team"
```

And see everything at a glance:

```bash
akm stash list
```

That shows your primary stash, all the directories you've added, and any installed kits — in priority order. Need to remove one? `akm stash remove` takes a path or a name.

For assets that live in a git repo or an npm package, `akm add` handles installation and makes them searchable immediately:

```bash
# A team repo full of shared skills
akm add github:your-org/team-agent-toolkit

# An npm kit
akm add @scope/deploy-skills

# A local git directory
akm add ./path/to/my-opencode-skills
```

Every `akm add` registers the kit, caches the assets, and triggers an incremental index build.

## Build the Index

```bash
akm index
```

First run builds the full index. After that, it runs incrementally — only rescanning directories that changed. If you've configured an embedding endpoint (local Ollama, OpenAI, whatever), you get vector-based semantic search. If not, you still get solid keyword matching out of the box with the built-in local model.

Want the enhanced experience? If you're running Ollama:

```bash
ollama pull nomic-embed-text
akm config set embedding '{"endpoint":"http://localhost:11434/v1/embeddings","model":"nomic-embed-text","dimension":384}'
akm index --full
```

## Search Across Everything

Now here's where it pays off. Say you're working in Claude Code and you vaguely remember writing a skill for Docker container management a few months ago. Was it in your OpenCode stash? Your Claude Code skills? That shared repo your teammate set up?

Doesn't matter.

```bash
akm search "docker container management"
```

That searches across every source you've registered — your primary stash, every directory you added with `akm stash add`, and all installed kits. Semantic search means you don't need to remember the exact filename. Describe what you're looking for and `akm` finds it.

Results come back with a `ref` you can pass straight to `akm show`:

```bash
akm show skill:docker-homelab
```

Your agent gets the full SKILL.md content, ready to use. For scripts, it gets a `run` command it can execute directly. For commands, the full markdown template with placeholders. For knowledge, navigable content with TOC and section views. No manual file hunting.

Want to search the community registries too? `akm` ships with [skills.sh](https://skills.sh) built in:

```bash
akm search "code review" --source both
```

Now you're searching your local stash and community registries in one shot. Found something useful? Install it:

```bash
akm add github:someone/great-kit
```

Or if you just want one asset from a kit without installing the whole thing:

```bash
akm clone "github:someone/great-kit//skill:code-review" --dest ./.claude
```

That clones just the skill directly into your project's Claude Code skills directory. The type subdirectory (`skills/`, `scripts/`, etc.) gets appended automatically.

## Tell Your Agent About It

Here's the part that ties it all together. Drop this into your `AGENTS.md`, `CLAUDE.md`, or system prompt:

~~~markdown
## Resources & Capabilities

You have access to a searchable library of scripts, skills, commands, agents,
knowledge, and memories via the `akm` CLI. Use `akm -h` for details.
~~~

That's the entire integration. No plugins, no SDKs, no integration code. Any model that can run shell commands can use `akm`. Claude Code, OpenCode, Codex, Cursor — if it has a terminal, it works.

The agent runs `akm search` to find what it needs, `akm show` to load the content, and gets to work. Everything else stays out of context.

## What This Looks Like in Practice

Let's say your setup looks something like this:

- **Claude Code**: `~/.claude/skills/` has skills for PDF generation, CMYK conversion, and print layout QA
- **OpenCode**: `.opencode/skills/` in a project has custom Azure deployment scripts and a LiteLLM manager
- **Shared team repo**: A git repo with Docker, CI/CD, and code review assets
- **Cursor**: `.cursor/rules/` has coding conventions and architecture patterns

After setup:

```bash
akm init
akm stash add ~/.claude/skills
akm stash add .opencode/skills
akm stash add .cursor/rules
akm add github:your-org/team-agent-toolkit
akm index
```

Now when your agent runs `akm search "deploy container to azure"`, it finds your Azure deployment script from the OpenCode directory, the Docker skill from your team repo, and maybe a relevant knowledge doc from Cursor's rules. All in one search. All ranked by relevance.

The agent picks what it needs, loads only that, and gets to work. Progressive disclosure means your agent's context stays clean — no drowning in irrelevant skills, no missing the one it actually needs.

## Why This Matters More Than It Sounds

The fragmentation problem in agent tooling is only getting worse. Every platform is building its own skill format, its own directory conventions, its own discovery mechanism. None of them talk to each other. If you're serious about building agent workflows, you're going to end up with assets in three or four of these systems within the year.

You can either manage that by hand — maintaining parallel copies, forgetting where things are, rebuilding from scratch when you switch tools — or you can index once and search everywhere.

`akm` isn't trying to replace any of these platforms. Your Claude Code skills stay Claude Code skills. Your OpenCode scripts stay OpenCode scripts. `akm` just makes them all findable from one place, regardless of which agent is asking.

## Get Started

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash
akm init
akm stash add ~/.claude/skills
akm index
akm search "whatever you need"
```

Five commands. Every skill you've ever written, searchable in seconds.

The repo is at [github.com/itlackey/agentikit](https://github.com/itlackey/agentikit). If you've got agent assets scattered across platforms, give it a shot and let me know what breaks.
