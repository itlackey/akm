---
title: 'The Improvement Loop: How akm Keeps Your Agent Sharp'
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm-knowledge
description: 'akm improve runs a multi-phase pipeline — reflect, distill, consolidate, memory inference, graph extraction — that continuously refines your agent knowledge base. Here is what each phase does and how to wire it into your workflow.'
tags:
  - ai
  - agents
  - cli
  - automation
published: false
id: 3814541
---

This is part ten in a series about managing the growing pile of skills, scripts, and context that AI coding agents depend on. [Part nine](https://dev.to/itlackey/agents-that-remember-where-they-were-1koe) covered workflow assets, vault assets, and the writable git stash. [Part eight](https://dev.to/itlackey/building-agent-knowledge-bases-that-actually-scale-23pb) tackled multi-wiki support for structured research. Earlier parts addressed teams, distributed stashes, feedback scoring, and community knowledge.

This one is about entropy.

You ship a feature. Your agent writes several memories during the session — partial findings, a workaround, a note about the build step that kept failing. Those memories are accurate when written. Three sprints later, the workaround is no longer needed, two of the memories say slightly different things about the same subsystem, and the note about the build step refers to a CI config that was replaced. None of this is catastrophic. But it accumulates. After six months, a significant fraction of your stash is stale, redundant, or quietly wrong.

You could audit it manually. In practice, you won't — the stash is too large, the relevance of any given memory is hard to assess without the context where it was created, and the judgment calls (merge these two? promote this? delete that?) are exactly the kind of work that's tedious for a human and tractable for an LLM.

`akm improve` is the answer to that problem. It is a multi-phase pipeline that reads your stash, evaluates asset quality, consolidates scattered memories, extracts structured facts, and maps entity relationships — on a schedule, without manual intervention, producing proposals you can review before anything changes.

## The Five Phases

`akm improve` is not a single LLM call. It is a sequenced pipeline where each phase produces inputs for the next.

**Reflect** evaluates asset quality. For each asset in scope, the reflect pass reviews the content against usage signals — search hits, retrieval counts, feedback — and produces a quality assessment. Low-quality assets are flagged as candidates for improvement. Since 0.8.0, reflect can run as a direct LLM HTTP call instead of spawning an agent subprocess, which cuts per-call latency from ~30 seconds to ~6–10 seconds:

| Reflect mode | Time per call | 69-ref run |
|---|---|---|
| agent (CLI subprocess) | ~30s | ~35 min |
| sdk (in-process) | ~10–15s | ~12–17 min |
| llm (direct HTTP) | ~6–10s | ~8–10 min |

**Distill** turns observations from reflect into lesson proposals. Where reflect says "this skill is incomplete and frequently retrieved with poor satisfaction," distill produces a draft improvement — a new version of the skill, a supplementary lesson, or a deprecation proposal. These proposals go into the queue; nothing is written to your stash until you accept them.

**Consolidate** handles the memory pool specifically. Your memory pool accumulates entries from agent sessions — `akm remember` calls, auto-captured observations, and task agent outputs. Consolidation groups related memories into chunks, sends each chunk to the LLM for a curation plan (merge near-duplicates, promote high-signal items, delete redundant entries, surface contradictions), and executes those plans. The result is a smaller, cleaner memory pool and new stash promotions.

**Memory inference** runs after consolidation. It takes the post-consolidation state and runs a lightweight factual extraction pass — pulling out atomic facts that did not make it into explicit memory entries. These become additional promotion candidates. In steady-state operation, memory inference yields around 60–70% (69.3% in a recent 24-hour window) usable atomic facts on each pass.

**Graph extraction** runs last, against the final post-improve state. It builds the entity-relation index that powers `akm graph` commands — which stash entries mention a given entity, which entities co-occur, and which assets produced zero entities (quality-triage candidates via `akm graph orphans`). As of 0.8.0, extraction is incremental: only assets that changed during the improve run are re-extracted, and batches of four run in parallel by default.

Each phase is independently enabled or disabled per profile. A `quick` profile runs reflect only. A `memory-focus` profile runs reflect and memory inference on memory and lesson types. A `thorough` profile runs all five phases and auto-syncs the result to your git-backed stash.

## Running the Loop

The basic invocation:

```sh
akm improve
```

That runs all enabled phases on the full stash, scoped by your default improve profile. Before running for the first time, use `--dry-run` to see what would be processed without writing anything:

```sh
akm improve --dry-run
```

The dry-run output shows which assets are selected, in what order, and which phases would run. Nothing is written to `state.db` from the dry-run path — the improve result is flagged `.dryRun: true` and excluded from health metrics.

To scope the pass to a specific asset type:

```sh
akm improve memory          # memory pool only
akm improve skill           # skills only
akm improve skill:deploy    # one specific asset
```

To add extra guidance for the pass — useful when you know a particular focus area is relevant:

```sh
akm improve --task "focus on deduplication in the build tooling notes"
```

To cap the number of assets processed (highest-utility first by default):

```sh
akm improve --limit 20
```

The asset selection order is: assets with recent feedback signals first, then high-retrieval-count assets with no feedback, then everything else. Use `--require-feedback-signal` to restrict the pass to assets that have received explicit feedback and skip the retrieval fallback entirely.

## Profiles

A profile controls which phases run, which LLM connections are used, whether auto-sync fires at the end of the run, and the confidence threshold for auto-accepting proposals. Built-in profiles:

| Profile | Phases | Auto-sync | Auto-push |
|---|---|---|---|
| `default` | All five | Yes | Yes |
| `thorough` | All five, larger batches | Yes | Yes |
| `quick` | Reflect only | No | No |
| `memory-focus` | Reflect + memory inference, memory and lesson types only | No | No |

Pass `--profile` to override for a single run:

```sh
akm improve --profile quick
akm improve --profile memory-focus
```

Define custom profiles in your config under `profiles.improve.<name>`. Each process entry in the profile uses a unified `{mode, profile, timeoutMs, options}` shape, so you can point reflect at a fast local model and consolidation at a more capable one:

```jsonc
{
  "configVersion": "0.8.0",
  "profiles": {
    "llm": {
      "fast": { "endpoint": "http://localhost:1234/v1/chat/completions", "model": "qwen3.5-9b" },
      "careful": { "endpoint": "http://192.168.0.99:1234/v1/chat/completions", "model": "qwen3-32b" }
    },
    "improve": {
      "default": {
        "processes": {
          "reflect": { "mode": "llm", "profile": "fast" },
          "consolidate": { "mode": "llm", "profile": "careful" }
        }
      }
    }
  }
}
```

## The Proposal Queue

Every improvement that `akm improve` generates flows through the proposal queue before touching your stash. Nothing is written directly. The queue is the safety layer.

After a run, review what was generated:

```sh
akm proposal list
akm proposal list --status pending
```

Inspect a specific proposal:

```sh
akm proposal show <id>
akm proposal diff <id>       # side-by-side diff vs. the live asset
```

Accept or reject:

```sh
akm proposal accept <id>
akm proposal reject <id> --reason "duplicates the deployment-gotchas lesson"
```

`akm proposal accept` runs full schema validation before writing anything to the stash. Accepted proposals are promoted as normal stash assets and become immediately searchable.

The `--auto-accept` flag enables confidence-threshold-based auto-promotion. The default safe threshold is 90 — proposals where the LLM scored its own confidence at 90 or above are promoted automatically; everything below goes to the queue for manual review:

```sh
akm improve --auto-accept=90     # explicit threshold (same as the default)
akm improve --auto-accept=false  # disable auto-accept, send everything to queue
```

For the first few runs on a new stash, disable auto-accept and review the queue manually. Once you have a sense of what the pipeline generates, you can raise the threshold progressively.

## Scheduling

Running `akm improve` once is useful. Running it continuously is where the compounding starts.

The pipeline is designed to run on a cron schedule. In production, every 30 minutes is a common cadence — enough time for the consolidation LLM calls to complete, short enough that memories from any given session get curated within the hour.

Define a task asset to schedule it:

```yaml
# ~/akm/tasks/improve-loop.yml
name: improve-loop
trigger:
  cron: '*/30 * * * *'
agent:
  command: akm
  args: ["improve", "--profile", "default", "--limit", "30"]
enabled: true
```

Register the task:

```sh
akm tasks sync
```

After that, `akm improve` runs every 30 minutes without manual intervention. The `--limit 30` cap keeps each run predictably bounded. If there is nothing worth improving — no new feedback, no high-retrieval zero-feedback assets — the run completes quickly after selection with zero proposals generated.

For git-backed stashes, the `default` and `thorough` profiles auto-commit at the end of each run. The commit message template is configurable:

```jsonc
"sync": { "message": "akm improve {scope} — {refs} refs ({date})" }
```

Use `--no-sync` to suppress the commit for a specific run, or `--no-push` to commit locally without pushing.

## Knowing the Loop Is Working

`akm health` gives you a structured view of recent improve activity without querying SQLite directly:

```sh
akm health --since 24h
akm health --since 4h --format text
```

The output covers run counts, skip reason breakdowns, consolidation outcomes, memory inference yield, and phase latencies. If a run was a dry-run, it is excluded from the health metrics automatically.

After any significant stash change, running `akm health` is the fastest way to confirm the pipeline is in a healthy state rather than silently stuck on a locked journal or a stale database entry.

## What Changes Over Time

The value of the improve loop is not in any single run. It is in what accumulates.

After a week of 30-minute cycles on an active stash, the memory pool is smaller and more coherent. Duplicate memories from related sessions have been merged. High-signal observations have been promoted to named stash entries your agent can reference directly. The graph extraction index has been built up incrementally so `akm graph entity <name>` returns useful results instead of nothing.

After a month, the stash reflects your actual working patterns rather than the raw notes from when you first captured something. Assets that were retrieved frequently and rated poorly have been flagged and improved. Assets that were never retrieved have surfaced as candidates for deletion or consolidation. The memory you have is accurate to what you know now, not what you wrote six months ago.

That is the loop. It runs while you work. It runs while you sleep. Each pass leaves the stash slightly more accurate, slightly more consolidated, slightly more useful. The proposals it generates are the visible surface — the queue where you can see what the pipeline decided and override it. The underlying stash quality improvement is what compounds.

---

`akm improve` is part of akm 0.8.x. The full pipeline configuration reference is at [docs/configuration.md](https://github.com/itlackey/akm/blob/main/docs/configuration.md). Profile options, LLM connection setup, and scheduling details are in the [improvement loop feature doc](https://github.com/itlackey/akm/blob/main/docs/features/improvement-loop.md). For a concrete look at 24 hours of autonomous operation — hardware benchmarks, the two reliability fixes that make continuous runs viable, and the Discord health report setup — see [Your Agent Has a Memory That Runs While You Sleep](https://dev.to/itlackey/your-agent-has-a-memory-that-runs-while-you-sleep-20oh). The repo is at [github.com/itlackey/akm](https://github.com/itlackey/akm).
