---
title: Your Agent's Memory Shouldn't Disappear When the Session Ends
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
id: 3359720
series: akm
description: A quick introduction to using OpenViking with akm
tags:
  - ai
  - agents
  - cli
  - skills
published: true
date: '2026-03-17T16:07:09Z'
---

This is part three in a series about managing the growing pile of skills, scripts, and context that AI coding agents depend on. In [part one](https://dev.to/itlackey/your-ai-agents-skill-list-is-getting-out-of-hand-32ck), I talked about why progressive disclosure beats loading everything into context. In [part two](https://dev.to/itlackey/you-already-have-dozens-of-agent-skills-you-just-cant-find-them), I showed how `akm` unifies your existing Claude Code, OpenCode, and Cursor assets into one searchable stash.

Both of those were about files on disk. Local skills, local scripts, local knowledge documents. That covers most people's immediate pain, but it leaves a bigger problem on the table: what happens when the context your agent needs isn't local?

Think about project architecture docs that live in a shared knowledge base. Team decisions captured during previous sessions. Coding standards that evolve over time and shouldn't be copy-pasted into every developer's stash. Agent memories that accumulate across conversations and need to persist somewhere more durable than a markdown file in a git repo.

That's where [OpenViking](https://github.com/volcengine/OpenViking) comes in, and why `akm` now supports it as a first-class stash provider.

## What Is OpenViking?

OpenViking is an open-source context database built by ByteDance's Volcano Engine team. Instead of treating agent context as flat vectors in a RAG pipeline, it organizes everything — memories, resources, skills — into a hierarchical virtual filesystem with semantic search.

The part that matters: it stores and retrieves agent context (project docs, team decisions, coding standards) via a REST API. When you connect it to `akm`, its content shows up in search results alongside your local assets — same `type:name` refs, same ranking, same `akm show` workflow.

The part that matters for `akm` is the API. OpenViking exposes REST endpoints for search (semantic and text), content read, and file stat. That's exactly what a stash provider needs: the ability to find things and retrieve them. So we built one.

## Adding OpenViking as a Stash Source

If you already have `akm` installed and an OpenViking server running, the setup is one command:

```bash
akm stash add http://localhost:1933 --provider openviking
```

That registers the server as a stash source. From that point on, `akm search` queries your local stash and the OpenViking server in parallel. Results from both show up in the same `hits[]` array, ranked together.

If your server requires authentication:

```bash
akm stash add http://localhost:1933 \
  --provider openviking \
  --options '{"apiKey":"your-api-key"}'
```

Give it a name to keep things tidy:

```bash
akm stash add http://localhost:1933 \
  --provider openviking \
  --name "team-context" \
  --options '{"apiKey":"your-api-key"}'
```

Verify it's registered:

```bash
akm stash list
```

That's the full setup. No config files to hand-edit, no environment variables to set. The provider handles caching, retries, and graceful degradation — if the server goes down, your local stash still works fine and the provider falls back to cached results for up to an hour.

## Searching Remote and Local Together

Here's what changes in practice. Before OpenViking, an `akm search` hit your local stash — your primary directory, search paths, and installed kits. Now it also hits any OpenViking servers you've registered.

```bash
akm search "project architecture"
```

This might return a local skill from your Claude Code directory *and* a knowledge doc from OpenViking. The results are unified: same format, same scoring, same `type:name` refs. Your agent can't tell the difference between a local asset and one from OpenViking — and it shouldn't need to.

```bash
akm show knowledge:project-context
```

That fetches the content — from the local index if available, or from the OpenViking server as a fallback. The response comes back in the same format as any other `akm show` — with a `content` field, an `action` field, and type metadata.

By default, OpenViking search uses semantic matching (via `POST /api/v1/search/find`). If you prefer text search for exact matching, configure the provider with:

```bash
akm stash add http://localhost:1933 \
  --provider openviking \
  --options '{"apiKey":"your-key","searchType":"text"}'
```

Text search uses OpenViking's grep endpoint, which deduplicates results by URI and ranks them by match frequency.

## Standing Up a Test Server

If you want to try this locally before pointing at a shared server, the akm repo includes a ready-made Docker Compose setup:

```bash
git clone https://github.com/itlackey/akm.git
cd akm/tests/fixtures/openviking

# Start the server
docker compose up -d

# Wait a few seconds, then seed sample content
./seed.sh
```

The seed script loads a handful of test documents — project architecture notes, coding standards, an API reference, and a project memory — into the OpenViking server.

Now register it:

```bash
akm stash add http://localhost:1933 \
  --provider openviking \
  --name openviking \
  --options '{"apiKey":"akm-test-key"}'
```

And test:

```bash
akm search "project architecture"
akm show knowledge:project-context
```

You should get back the full markdown content of the project architecture document. Search works across all sources:

```bash
akm search "coding standards"
```

And if you have Ollama running locally, you can enable semantic search by updating the `ov.conf` to point the embedding endpoint at your Ollama instance (`http://host.docker.internal:11434/v1`). Without embeddings, text search and direct content access still work fine.

Tear it down when you're done:

```bash
docker compose down
```

## Why This Matters for Teams

The OpenViking integration solves a class of problems that local-only stash management can't.

**Shared context without shared files.** Your team can maintain a single OpenViking instance with project documentation, architectural decisions, and coding standards. Every developer's agent can search and retrieve that context without syncing files, mounting network drives, or maintaining parallel copies. Update a document in OpenViking and every agent sees the change immediately.

**Persistent memory across sessions.** OpenViking's memory system stores recalled context fragments that survive across conversations. When your agent starts a new session, it can search for memories from previous work — `akm search "sprint planning decisions" --type memory` — and get back what it learned last week. That's a fundamentally different capability than loading the same static skills every time.

**Unified search across everything.** This is the compounding effect of the whole series. Part one gave you progressive disclosure for local skills. Part two unified your multi-platform assets into one searchable stash. Now part three adds remote context to the same search surface. One `akm search` query, one result set, one `akm show` command — regardless of whether the asset is a Claude Code skill in `~/.claude/skills/`, a script from an npm kit, or a knowledge document on an OpenViking server across the network.

## The Full Picture

After three posts, here's what a fully-wired setup looks like:

```bash
# Install
curl -fsSL https://raw.githubusercontent.com/itlackey/akm/main/install.sh | bash
akm init

# Local platform assets
akm stash add ~/.claude/skills
akm stash add .opencode/skills
akm stash add .cursor/rules

# Community and team kits
akm add github:your-org/team-agent-toolkit
akm add @scope/deploy-skills

# Remote context server
akm stash add https://your-viking.internal:1933 \
  --provider openviking \
  --name team-context \
  --options '{"apiKey":"..."}'

# Build the index
akm index
```

Now drop the `AGENTS.md` snippet into every project and your agent has access to all of it:

```markdown
## Resources & Capabilities

You have access to a searchable library of scripts, skills, commands, agents,
knowledge, and memories via the `akm` CLI. Use `akm -h` for details.
```

Local skills, remote knowledge, team kits, community registries, persistent memories. One search, one interface, every agent.

The repo is at [github.com/itlackey/akm](https://github.com/itlackey/akm). OpenViking is at [github.com/volcengine/OpenViking](https://github.com/volcengine/OpenViking). Both are open source, both are moving fast, and the combination is genuinely useful infrastructure for anyone running agents in production.
