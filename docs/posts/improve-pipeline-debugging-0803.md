---
title: 'Your Agent Has a Memory That Runs While You Sleep'
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm-knowledge
description: 'akm improve runs continuously on consumer GPUs with local models, curating your agent knowledge base in the background. Here is what 24 hours of autonomous operation looks like, what hardware it takes, and what we fixed to make it reliable.'
tags:
  - ai
  - agents
  - cli
  - local-ai
published: false
id: 3814547
---

This post is part of the akm-knowledge series. [Part ten](https://dev.to/itlackey/the-improvement-loop-how-akm-keeps-your-agent-sharp-2d4d) introduced the improve pipeline — what each phase does and how to schedule it. This post goes deeper on what continuous operation looks like in practice: the hardware numbers, the reliability bugs we hit at 48 runs per day, and the observability layer we built to keep watch.

Most people think of AI agent memory as something that happens during a session. You talk to your agent, it learns things, maybe you save a few notes, the session ends. The next session starts cold.

`akm improve` is built around a different model: a continuous background process that runs on your own hardware, against local models, and quietly curates your agent's knowledge base while you work on other things. No cloud API required. No per-token billing for the maintenance pass. A GPU you already own, a model you already have downloaded, running on a schedule.

This post covers what 24 hours of autonomous operation actually looks like, how consumer-grade GPUs handle the load, the reliability work that makes continuous operation viable, and the observability layer that lets you know it's working without watching logs.

## What akm improve Does in 24 Hours

`akm improve` is a multi-phase pipeline. The core pass — consolidation — loads your memory pool, groups related memories into chunks, sends each chunk to a local LLM for a consolidation plan (merge similar memories, promote high-signal ones to your stash, delete redundant ones, surface contradictions), and then executes those plans. After consolidation, memory inference runs a lightweight factual extraction pass, and graph extraction updates the entity-relation index.

The pipeline is scheduled to run automatically. Here is what one 24-hour window produced:

| Metric | Value |
|--------|-------|
| Runs completed | **48 / 48** — zero failures |
| Memories processed | **14,189** |
| Promoted to stash | **1,361** |
| Merged (deduplication) | **49** (64 secondaries absorbed) |
| Contradictions surfaced | **211** |
| Deleted (redundant) | **31** |
| Memory inference yield | **69.3%** — 115 new atomic facts written |
| Graph entities extracted | **181** across 9 files |
| Task fail rate | **0%** |
| Index entries | **7,398** — all embedded, status `ready-vec` |

Every run that completes leaves your stash in better shape than before it started. Memories that accumulated across dozens of agent sessions get compressed, merged, and organized without manual intervention. The 1,361 promotions in this window represent memories that were considered significant enough by the local LLM to persist as named stash entries. The 49 merges collapsed near-duplicate content. The 211 contradictions were flagged for review rather than silently overwritten.

This is the loop. It runs every 30 minutes. You don't have to think about it.

## Running It on Consumer Hardware

The consolidation LLM in this setup is `qwen3.5-9b` (or similar) running locally via LM Studio on an OpenAI-compatible endpoint. The model fits comfortably on most modern gaming GPUs. No API key. No per-call cost. The inference happens on hardware sitting on your desk.

We run two LM Studio servers — both serving the same model via OpenAI-compatible endpoints — and benchmarked them head to head.

**Shredder** is a desktop with an RTX 5090. **Splinter** runs an RTX 4060 Ti, a card that launched at $299 and is common in mid-range gaming builds. Same model weights. Same chunk sizes. Different VRAM bandwidth and tensor core counts.

| | RTX 5090 (Shredder) | RTX 4060 Ti (Splinter) |
|--|---------------------|------------------------|
| **Per-chunk latency** | ~6.8s | ~22.6s |
| **13-chunk consolidation** | ~87s (~1.5 min) | ~290s (~4.8 min) |
| **Speed ratio** | 1× (baseline) | 3.3× slower |
| **Runs per hour (fits schedule)** | ✅ yes | ✅ yes |
| **Approximate street price** | ~$2,000 | ~$300 |

The 5090 is faster, but the 4060 Ti finishes a full consolidation pass in under 5 minutes — well inside the 30-minute run window. Both cards sustain 48 runs per day without missing a cycle.

Where the gap shows up is in the tail. Because the 24h window included runs on both backends, the aggregate latency numbers reflect both:

| Phase | Median | P95 | What drives the P95 |
|-------|--------|-----|---------------------|
| Total (end-to-end) | **7.2 min** | 23.4 min | Splinter-routed consolidation runs |
| Consolidation | **1.4 min** | 5.8 min | Chunk count variance + Splinter |
| Memory inference | **5.9s** | 25.3s | Fresh (non-cached) inference attempts |
| Graph extraction | **< 1s** | 53s | Cache misses on modified files |

The median of 7.2 minutes reflects the majority of runs going to Shredder. The P95 of 23.4 minutes is almost entirely Splinter runs with larger chunk windows. A setup running exclusively on a 4060 Ti would see a flatter distribution — median around 10–12 minutes, P95 around 18–20 minutes — with no 5090 runs pulling the median down.

For most setups, a single mid-range GPU is the right starting point. The consolidation pass is CPU-light and network-light — the bottleneck is token generation throughput on the GPU. If you have a second machine with a GPU and spare VRAM, you can point a second LM Studio server at it and split load exactly as we did here.

The embeddings server is separate — `nomic-embed-text-v1.5` running on localhost — and handles the semantic search index. It stays warm between runs, so re-embedding after promotions adds negligible latency. Any GPU with 4GB+ of VRAM can host it alongside the consolidation model if you have the headroom, or it runs on CPU at acceptable speed for indexing workloads.

## What "Local Models" Actually Means for Quality

The concern with local models is usually quality: will a 9B parameter model running on a gaming GPU produce consolidation plans good enough to trust with your knowledge base?

The answer, based on 48 runs and 14,189 memories, is yes — with the right constraints.

The consolidation prompt is designed to be conservative. The LLM is asked to identify candidates for merge, promote, or delete within a bounded chunk of related memories. It is not given unbounded latitude. Plans are validated against the loaded memory pool before execution — if the model invents a ref that doesn't exist, the op is dropped with a warning. If a promoted memory fails schema validation, it is rejected.

The 69.3% yield rate on memory inference tells the same story. Out of 166 fresh attempts at factual extraction, 115 produced usable atomic facts. The model is making useful inferences at a rate that justifies running it continuously.

The practical limit of local 9B models shows up in graph extraction: 2 truncations in the 24h window indicate chunks that exceeded the model's context window. These produce partial rather than failed extractions — the model handles what it can see. Larger models extend this ceiling; a 5090 can hold larger quantizations in VRAM.

## Making Continuous Operation Reliable

Running 48 times a day means reliability issues that would be minor in a manual workflow become systemic. Two bugs were affecting the consolidation pass and wasting inference on every affected run.

**The stale database problem.** After a run that deleted files, the database retained entries pointing to files that no longer existed on disk. The next run loaded those ghost entries, the LLM generated merge plans against them, and Phase B failed silently when the file wasn't found. Every affected secondary in those plans was charged a wasted inference call.

The fix is a pre-flight filter that runs before the LLM sees anything:

```typescript
memories = memories.filter((m) => fs.existsSync(m.filePath));
```

Stale entries never reach the model. A warning is logged so the count is visible in health output if the filter ever catches something:

```
Pre-flight: filtered 3 stale DB entries (file absent on disk) from memory pool before chunking.
```

**The hallucination problem.** On certain chunk compositions — particularly when session checkpoint memories and named sessions appear in the same window — the local model would blend naming conventions and produce a merge plan with a primary ref that didn't exist in the pool.

A typical example: `memory:opencode-session-20260529-a1b2` and `memory:checkpoint-20260529T214550` in the same chunk produce a hallucinated primary of `memory:opencode-session-20260529T214550-ses_18a4`. The plan looks reasonable at the chunk level. The ref doesn't exist at the pool level.

Before the fix, that hallucinated primary would reach Phase B and charge every real secondary (typically 4–8 refs) with a failed merge skip. After the fix, `mergePlans()` validates every primary ref against the loaded pool before execution:

```typescript
const knownRefs = new Set(memories.map((m) => `memory:${m.name}`));
const { ops: allOps, warnings: mergeWarnings } = mergePlans(chunkOpsArrays, knownRefs);
```

Real merge plans proceed. Hallucinated roots are dropped. The warning is distinguishable from the stale-DB warning, so health metrics can tell the two apart:

```
mergePlans: primary memory:... not in loaded memory pool (LLM hallucination) — dropping op before execution.
```

Both fixes eliminate wasted inference. On the 4060 Ti at 22.6s per chunk, a single hallucinated primary that would have charged 6 secondaries saves over 2 minutes of inference time per occurrence — time that can go toward real consolidation work instead.

## Knowing It's Working

Running autonomously in the background only helps if you know when something goes wrong. `akm health` provides a structured view of recent improve activity:

```sh
akm health --since 4h
akm health --since 24h --format text
```

It surfaces run counts, skip reason breakdowns, consolidation outcomes, memory inference yield, and phase latencies in a single command. The same JSON output feeds automation.

For continuous monitoring, we built a cron task that posts a rolling 4-hour health report to Discord every hour:

```yaml
# ~/akm/tasks/akm-health-report.yml
schedule: 0 * * * *
command: akm env run fwdslsh -- bash ~/akm/scripts/akm-health-discord.sh
enabled: true
```

The script calls `akm health --since 4h` and `--since 8h`, computes deltas for trend context, and posts a Discord embed:

```sh
akm tasks sync   # register the cron
```

The embed has three inline fields — Output (promoted, merged, MI yield), Failures (chunk failures, skip reason anomalies), and Latency (median, P95, previous-window comparison) — plus a Needs Attention section that only appears when something is actually off. The footer includes the hostname and timestamp so reports from multiple machines are distinguishable at a glance.

The result: a health check fires every 30 minutes from the pipeline, and a visibility report fires every hour to Discord. You see degradation before it accumulates.

## The Full Picture

Here is what autonomous local-model memory curation looks like across a full day:

- **48 runs** completed without intervention
- **14,189 memories** reviewed, organized, and curated
- **1,361** promoted to the permanent stash
- **1.4 minute median** per consolidation pass on the faster GPU; under 5 minutes on the 4060 Ti
- **Zero API calls** — all inference runs locally on hardware you own
- **Hourly Discord reports** — no manual health checks needed

The hardware requirement to run this continuously is a mid-range gaming GPU. The model requirement is a 7–9B parameter instruction-tuned model quantized to 4–8 bits. Both are things a lot of developers already have.

The value is in what compounds. Each run makes the stash slightly more accurate, slightly more consolidated, slightly more consistent. After 48 runs, 14,000 memories have been through a curation pass that would have taken hours to do manually. After a week, the stash is a different kind of asset — not a pile of notes, but a continuously maintained knowledge base that your agent can rely on across sessions.

---

`akm improve` is part of akm 0.8.x. The full pipeline configuration and local model setup docs are in the [configuration reference](https://github.com/itlackey/akm/blob/main/docs/configuration.md). Hardware requirements and LM Studio setup are covered in the [getting started guide](https://github.com/itlackey/akm/blob/main/docs/getting-started.md).
