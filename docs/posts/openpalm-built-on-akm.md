---
title: "OpenPalm Used to Run a Container for Everything. Now It Runs on AKM."
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm-skills
description: A self-hosted AI assistant accumulated a container for memory, one for scheduling, one for secrets. The 0.11.0 release deleted most of them by making the agent's knowledge stash the foundation instead.
tags:
  - ai
  - agents
  - selfhosted
  - akm
published: false
date: '2026-06-07T00:00:00Z'
---

If you've ever stood up a self-hosted AI assistant, you know how the container list grows.

You start with the assistant itself. Then it needs memory, so you add a memory service. It should run scheduled tasks, so you add a scheduler. You need a place to put secrets, so you stand up a vault. The web UI gets its own container. A reverse proxy goes out front. A socket proxy guards the Docker socket. Before long `docker ps` is a wall of services, and every one of them is a thing that can break, drift, or need its own upgrade path.

OpenPalm — a self-hosted, LAN-first AI assistant platform — grew up exactly like this. By the 0.10 line it was running a dedicated memory container (a Python mem0 service), a scheduler container, an admin-UI container, a Caddy reverse proxy, and a docker-socket-proxy, on top of the assistant, the guardian, and the channel adapters. Each one solved a real problem. Together they were a lot of platform to keep alive just to talk to your own assistant.

The 0.11.0 release deleted most of them. Not by cramming the features into fewer images — by noticing they were the same problem wearing different costumes.

## The Real Problem Wasn't the Services. It Was the Substrate.

Look at what those containers were actually *doing*:

- The memory service stored and recalled facts the assistant learned.
- The scheduler ran recurring jobs the assistant defined.
- The vault held the secrets and settings the assistant needed.
- The skills/lessons machinery managed the knowledge the assistant could draw on.

That's not five unrelated systems. That's one system — **the agent's knowledge and state** — split across five runtimes because no single thing owned it.

This is the same trap the akm series keeps coming back to. Skills scattered across `~/.claude/`, `.cursor/rules/`, and `~/.codex/` aren't a storage problem, they're a discovery problem. Containers scattered across a Compose file aren't a packaging problem, they're a *foundation* problem. When there's no shared substrate for the agent's knowledge, every capability invents its own.

So 0.11.0 picked a substrate: the [akm](https://github.com/itlackey/akm) stash. One searchable, versioned, file-based knowledge base — the same one the agent already uses for skills — and moved memory, scheduling, secrets, and knowledge onto it.

## Memory: A Whole Service Became a Stash

The old way was a mem0 container: a Python service, a vector store, an embedding pipeline, a database to back it up, and a network hop between the assistant and its own memories.

The new way is `akm`. The assistant's memory/skills/lessons tools come from the `akm-opencode` plugin, and "remembering" is just writing a memory asset into the stash — the same stash that holds everything else the agent knows. Recall is `akm search` / `akm curate`. There's no separate memory service to run, no second database to back up, no embedding service to keep in sync with the model config.

The win isn't only "one less container." It's that memory stops being a black box. A memory is a markdown file with frontmatter. You can read it, grep it, edit it, version it, and — this is the good part — **share it**. Which leads to the part that surprised us.

## The Operator and the Assistant Share One Brain

Because memory and knowledge now live in a plain akm stash, the host and the assistant can point at the *same* one.

The host's stash can be shared, symmetric and writable, with the assistant. Something you teach the assistant shows up in your own `akm curate` on the host. Something you drop into your stash is available to the assistant on its next task. There's no export step, no sync job, no "push my notes to the bot." It's one knowledge base with two readers.

You don't get that when memory is trapped inside a service whose only interface is an API the assistant calls.

## Scheduling: The Scheduler Container Just… Left

OpenPalm used to run a separate scheduler service to fire recurring automations.

In 0.11.0, scheduled work is an akm **task asset** — a markdown file describing a job and its cron. The assistant container runs `crond` at boot and `akm tasks sync` to register those tasks with the OS scheduler; `akm tasks run` executes them and writes history. The scheduler container is gone. Automations are now the same kind of file as everything else in the stash: discoverable, versioned, editable, and owned by the knowledge layer instead of a bespoke daemon.

## Secrets and Config: Stop Inventing a Vault

The old stack had its own vault concept and a pile of `OP_CAP_*` capability variables and a `stack.yml` to wire it all together.

akm 0.8.0 grew first-class `env` and `secret` asset types, so OpenPalm stopped inventing its own. User settings live as an `env` asset; service secrets as `secret` files with the right permissions; LLM and embedding configuration moved into akm's own `config.json`. The capability variables and the `stack.yml` block they fed are gone. One fewer dialect to learn, one fewer file format to migrate, one substrate that already knew how to store this stuff.

## What's Left (Because Honesty Matters)

This isn't a magic-wand story where everything collapses into a single binary. The pieces that earn their isolation kept it:

- **The guardian** still fronts all channel traffic — HMAC, replay protection, rate limiting, optional content moderation. Security boundaries should be their own process.
- **The assistant** still runs the OpenCode runtime with its tools.
- **Channel adapters** still translate Discord/Slack/API into validated requests.
- The reverse proxy and socket proxy didn't move to akm — they were *removed*. OpenPalm is LAN-first; services bind localhost, and the web UI became a host process instead of a container, so there was nothing left to proxy.

What changed is everything that was really just "the agent's knowledge and state" wearing a container costume. That collapsed onto akm.

## The Pattern, One More Time

The akm thesis started with skills: don't scatter them across tools, index them in one place and let the agent find what it needs. OpenPalm 0.11.0 is the same idea at the platform level. Don't scatter the agent's memory, schedule, secrets, and knowledge across a fleet of services. Put them on one substrate the agent already speaks, and delete the services that only existed to hold them.

Fewer containers is the headline. The real result is a simpler mental model: there's the stack that *runs* the assistant, and there's the stash that *is* its knowledge — and the stash is something you can read, share, and own.

If you're building anything with a long-lived agent, it's worth asking which of your services are solving a genuinely separate problem, and which are just holding the agent's knowledge because nothing else would. The second kind are containers you might not need.
