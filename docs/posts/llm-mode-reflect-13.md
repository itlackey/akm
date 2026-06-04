---
title: 'From 30 Minutes to 8: How LLM-Mode Reflect Works'
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm-knowledge
description: 'The reflect pass inside akm improve dropped from ~35 minutes to ~8 minutes per 69-ref run. Here is what changed: direct HTTP calls, multi-turn self-refine, and structured JSON output — with no agent subprocess in sight.'
tags:
  - ai
  - agents
  - performance
  - localai
published: true
id: 3814543
date: '2026-06-04T00:32:02Z'
---

This is part thirteen in a series about managing the growing pile of skills, scripts, and context that AI coding agents depend on. [Part ten](https://dev.to/itlackey/the-improvement-loop-how-akm-keeps-your-agent-sharp-2d4d) covered the full improve pipeline — all five phases and how they connect. [Part fourteen](https://dev.to/itlackey/your-agent-has-a-memory-that-runs-while-you-sleep-20oh) covers what 48 runs per day looks like in practice, including hardware benchmarks and the reliability bugs that surface at that frequency.

The reflect pass inside `akm improve` has three execution modes. Most installs are still running the slowest one.

Agent mode — the original — spawns an opencode or claude subprocess for each reflect call. The subprocess starts cold, acquires a session, assembles context, makes its LLM call, and exits. That cold-start overhead is real: each call takes approximately 30 seconds on a quiet machine. Run `akm improve` against a 69-ref stash and the reflect phase alone costs about 35 minutes.

SDK mode eliminated the subprocess. The reflect call runs in-process, cutting per-call latency to 10–15 seconds. A 69-ref run drops to 12–17 minutes — better, but still bounded by round-trip overhead that the reflect task does not actually need.

LLM mode removes the round trip entirely. The context for reflect is statically pre-assembled — no live tool calls, no file reads, no external context needed. A direct HTTP call to the LLM endpoint is sufficient, and it costs 6–10 seconds per call. A 69-ref run completes in 8–10 minutes.

| Mode | Per-call latency | 69-ref run |
|------|-----------------|------------|
| agent (CLI subprocess) | ~30s | ~35 min |
| sdk (in-process) | ~10–15s | ~12–17 min |
| llm (direct HTTP) | ~6–10s | ~8–10 min |

The 3–4× end-to-end improvement is from eliminating overhead that was never necessary for what reflect does.

## Why Reflect Does Not Need an Agent

The reflect pass takes a stash asset, examines its current content, and proposes a refined version. The inputs are fixed before the pass starts: the asset text, its metadata, and the improvement prompt. Nothing changes mid-call. No files need to be opened. No search queries need to fire. No external context needs to be pulled in.

Agent mode was useful when akm's improve pipeline was first built — the agent subprocess was already the primary execution model, and reflect rode along. But the properties that make agents valuable (tool use, live context access, multi-step reasoning over changing state) are not exercised by reflect. Spawning a full agent process for a stateless inference call trades 20+ seconds of overhead for no quality benefit.

LLM mode makes the execution match the task: assemble the context once, make one HTTP call, get the result.

## Multi-Turn Self-Refine

LLM mode adds a capability that agent mode does not have: multi-turn self-refine.

When reflect runs in LLM mode, it sends the initial draft back as an assistant turn. The model sees its own prior output and the refine prompt together in the same context window. This is a standard multi-turn pattern for iterative generation — the model can catch inconsistencies, tighten reasoning, and improve the draft without requiring a second top-level call.

Agent mode, by contrast, passes context forward through prompt text. Each subprocess run starts fresh. There is no conversation history to reason against.

The practical difference shows on longer or more complex assets, where a single forward pass produces a draft with inconsistencies the model catches immediately when it sees its own output. Multi-turn self-refine handles this inside the single reflect call.

## Structured Output

For providers that advertise `supportsJsonSchema: true` in their profile config, LLM mode requests structured JSON output. The response is validated against the reflect output schema before being accepted as a proposal.

This eliminates a class of parse failures that occurs when a model returns well-formed prose but with section markers or formatting that does not align with the expected output shape. The model knows the schema before it generates the response, so the output conforms rather than being post-hoc parsed.

Agent mode produces unstructured text that the pipeline parses with heuristics. LLM mode with `supportsJsonSchema: true` eliminates the heuristics.

## Config to Enable LLM Mode

LLM mode requires Config v2 (`configVersion: "0.8.0"`). If you have not migrated yet:

```sh
# Preview the transformation
akm config migrate --dry-run

# Apply (writes a timestamped backup first)
akm config migrate
```

With v2 in place, add a named LLM profile and point the reflect process at it:

```jsonc
{
  "configVersion": "0.8.0",
  "profiles": {
    "llm": {
      "openai-mini": {
        "endpoint": "https://api.openai.com/v1/chat/completions",
        "model": "gpt-4o-mini",
        "apiKey": "${OPENAI_API_KEY}",
        "supportsJsonSchema": true
      }
    },
    "improve": {
      "default": {
        "processes": {
          "reflect": { "mode": "llm", "profile": "openai-mini" }
        }
      }
    }
  },
  "defaults": { "llm": "openai-mini" }
}
```

That is the complete change. On the next `akm improve` run, reflect dispatches HTTP calls to the `openai-mini` profile instead of spawning subprocesses. The proposal queue, review workflow, and everything downstream are unchanged.

## Local Models and LM Studio

The profile config is an endpoint and a model name. Nothing in the LLM mode path is OpenAI-specific — it issues standard chat completions requests. Any OpenAI-compatible server works, including LM Studio running locally.

To point reflect at a local LM Studio instance:

```jsonc
{
  "configVersion": "0.8.0",
  "profiles": {
    "llm": {
      "local-reflect": {
        "endpoint": "http://192.168.1.100:1234/v1/chat/completions",
        "model": "your-local-model-name",
        "supportsJsonSchema": false
      }
    },
    "improve": {
      "default": {
        "processes": {
          "reflect": { "mode": "llm", "profile": "local-reflect" }
        }
      }
    }
  }
}
```

Set `supportsJsonSchema: false` unless you have confirmed that the local model and LM Studio version support structured output. Most local models handle the reflect task correctly through standard chat completions without schema enforcement — the output is smaller and more predictable than consolidation plans, so parse failures are rare.

For a machine running a 9B model on an RTX 4060 Ti, LLM mode reflect benchmarks in the 8–12 second range per call — comparable to the cloud figures in the table above, with no API costs and no data leaving your network.

## When to Stay on Agent Mode

LLM mode is appropriate for reflect because reflect has static inputs. Other improve processes do not share that property.

Stay on agent mode when the process needs live tool calls. If you have a custom improve workflow that reads files, calls `akm search`, or pulls external context mid-run, that process requires an agent that can execute tools. LLM mode does not have tool dispatch — it is a direct HTTP call to a completions endpoint, nothing more.

Stay on agent mode when the reflect task for a specific asset type requires context that is assembled dynamically — search results, graph lookups, or file reads that depend on the asset's content. Those lookups require a running agent.

The standard reflect pass — refining an existing asset based on its content and metadata — does not require either of these. LLM mode is the right default for it.

## What Changes in Practice

A 69-ref `akm improve` run that used to block for 35 minutes now completes in under 10. The reflect proposals are the same quality — in some cases better, because multi-turn self-refine catches first-draft inconsistencies. Structured output for cloud providers eliminates parse failures that previously required manual retries.

The change is a config update:

```sh
# Migrate config if still on v1
akm config migrate

# Then add the llm profile + reflect process entry (see snippet above)
# Preview what the next run would process without writing anything
akm improve --dry-run
```

The next improve run after that shows reflect calls completing in the 6–10 second range instead of 30.

---

LLM mode reflect is available in akm 0.8.0. The full configuration reference is in [docs/configuration.md](https://github.com/itlackey/akm/blob/main/docs/configuration.md). The Config v2 key mapping is in the [v0.7 to v0.8 migration guide](https://github.com/itlackey/akm/blob/main/docs/migration/v0.7-to-v0.8.md#config-v2-migration-reflect-multi-mode).

For a broader view of the improve pipeline — all five phases, scheduling, and how reflect feeds the downstream consolidation and distill passes — see [The Improvement Loop: How akm Keeps Your Agent Sharp](https://dev.to/itlackey/the-improvement-loop-how-akm-keeps-your-agent-sharp-2d4d). For debugging improve runs when something goes wrong (stale DB entries, hallucinated merge plans, pre-flight filters), see [Your Agent Has a Memory That Runs While You Sleep](https://dev.to/itlackey/your-agent-has-a-memory-that-runs-while-you-sleep-20oh).
