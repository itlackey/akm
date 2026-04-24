---
title: Your AI Agent's Skill List Is Getting Out of Hand
id: 3327252
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm
description: A quick introduction to the Agent-i-Stash CLI for managing AI agent extensions
tags:
  - ai
  - agents
  - cli
  - skills
published: true
date: '2026-03-08T15:58:28Z'
---

If you've been building with Claude Code or OpenCode for any length of time, you've probably hit the same wall. You start with a handful of skills and commands. They work great. So you add more. Then a few more for that new project. Then a teammate shares theirs and you copy those in too.

Before long you've got dozens of files scattered across directories, no good way to find the one you need, and an agent that's either missing context it should have or drowning in context it doesn't need.

That's the problem [Agent-i-Stash](https://github.com/itlackey/akm) is built to solve.

## The Real Issue Isn't Storage, It's Discovery

Claude Code and OpenCode are great at *using* skills and tools. They're not great at helping you *manage* them. There's no built-in search. No way to share a curated set of skills with your team without copying files around. No versioning. No registry.

So most people end up with one of two bad situations:

**Option A:** You stuff everything into context at startup. Your agent sees every skill, every tool, every command — whether it needs them or not. This sounds fine until you realize that loading irrelevant context doesn't just waste tokens, it actively degrades the quality of your agent's decisions. More isn't better. It's just noise.

**Option B:** You keep your stash small and tightly curated. The agent stays sharp, but you're constantly maintaining it by hand, rediscovering skills you forgot you had, and starting from scratch every time you spin up a new project.

Neither of these scales.

## Progressive Disclosure: Only Load What You Actually Need

The idea behind Agent-i-Stash is straightforward: your agent shouldn't have to know about every skill upfront. It should be able to *search* for what it needs, then load only that.

This is called progressive disclosure — a pattern from UX design that's finding a second life in agent architecture. Instead of front-loading everything, you expose a lightweight index. The agent scans it, decides what's relevant to the current task, and fetches only those resources. Everything else stays out of context.

The difference in practice is significant. An agent working from a bloated context window will drop steps, misfire on tool selection, and hallucinate connections between things that have nothing to do with each other. An agent that fetches only what it needs stays focused.

Agent-i-Stash gives you this through two commands your agent can call: `akm search` to find relevant skills by intent, and `akm show` to load the full content of only the ones it actually needs. Semantic search means you're not matching on exact keywords — the agent can describe what it's trying to do in plain language and get back relevant results.

## Skills Should Be Shareable

The other problem Agent-i-Stash tackles is distribution. Right now, if you build a great skill for managing Docker containers or generating print-ready PDFs, sharing it with someone else means sending files. There's no package lifecycle, no versioning, no clean way to pull updates.

Agent-i-Stash adds a registry layer on top of your stash. You can install a stash from GitHub or npm in one command. Your team can maintain an internal repository of shared skills that everyone pulls from. Community-maintained stashes can be versioned and updated the same way you'd update any other dependency.

This matters because the value of a good skill compounds when it's shared. A skill that took you an afternoon to get right shouldn't have to be reinvented by every person on your team — or by strangers on the internet who ran into the same problem you did.

## It's Not Replacing Anything

Agent-i-Stash isn't trying to replace MCP, or the skill systems built into Claude Code and OpenCode. It sits alongside them as a management and discovery layer. You still define your skills the same way. You still use them the same way. You just also have a way to find them, share them, and keep them organized as the collection grows.

Think of it like the difference between having a folder full of scripts and having a package manager. The scripts are still scripts. You just don't have to remember where you put them.

## Beta Testers and Agents Wanted

The project is young — v0.0.9 as of this writing — but the problem it's solving is real and it's only going to get worse as agent workflows get more capable and more complex. A community-maintained registry of high-quality, searchable, versioned skills is genuinely useful infrastructure.

Give it a look at [github.com/itlackey/akm](https://github.com/itlackey/akm). And if you've built skills worth sharing, this is a good time to think about how to package them so others can benefit.

Feel free to drop links in the comments to skills or stashes you've built that you think others should know about.

---

*__Update (March 2026):__ This post is part of a series that has been updated to reflect akm's current CLI. Later posts in the series now use `akm setup` (formerly `akm init`), `akm add` (formerly `akm stash add`), and `akm list` (formerly `akm stash list`). If you're following along with an older version, `akm upgrade` will get you current.*


---

> **Note (2026-04-23):** This post has been updated to align with akm 0.6.0 terminology. Earlier wording referred to a *kit* and the *Kit Maker's Guide*; those terms have been renamed to *stash* and *Stash Maker's Guide* throughout. The pre-rename text is preserved in this repository's git history.
