---
title: The Proposal Queue Safety Net
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm-knowledge
description: 'akm''s proposal queue separates agent-generated suggestions from your live stash. Here is the full review workflow, the 0.8.0 guardrails that prevent bulk mistakes, and a daily habit that keeps the queue clean.'
tags:
  - ai
  - agents
  - memory
  - cli
published: true
id: 3814548
date: '2026-06-04T00:32:02Z'
---

This is part fifteen in a series about managing the growing pile of skills, scripts, and context that AI coding agents depend on. [Part ten](https://dev.to/itlackey/the-improvement-loop-how-akm-keeps-your-agent-sharp-2d4d) introduced the improve pipeline and how it generates proposals. [Part twelve](https://dev.to/itlackey/belief-aware-memory-teaching-your-agent-when-not-to-write-4egi) covered belief-aware memory, which feeds directly into the confidence scores covered here.

The fundamental problem with agent-generated stash updates is trust. You want to capture what the agent learned — the debugging insight from last Tuesday's session, the architectural pattern it derived from reviewing twenty PRs — without blindly writing unreviewed content into the knowledge base your other agents depend on. One bad promotion and you've contaminated search results with a hallucinated fact that will keep showing up until someone notices.

akm's proposal queue is the answer to that problem. Introduced in 0.7.0 and extended in 0.8.0, it separates generation from promotion. Every agent-driven change writes to a durable queue first. Nothing reaches your live stash until you explicitly accept it. The queue is the safety net.

## How the Queue Works

When `akm improve` or `akm propose` runs, the output goes to the proposal queue — not to your stash. Proposals live outside the asset tree. They never appear in `akm search` results and never get indexed alongside your real assets. The `quality: "proposed"` marker ensures this at the database level: proposed assets are excluded from default search and only surface through the `akm proposal *` commands or an explicit `--include-proposed` flag.

This means an agent can generate dozens of proposals in a single `akm improve` run and none of them affect your live stash until you decide they should. Multiple proposals for the same ref coexist without filesystem collisions. You can review them at your own pace, reject the bad ones, and accept the rest in whatever order makes sense.

The complete review workflow:

```sh
akm proposal list                        # see what's pending
akm proposal show <id>                   # render the full proposal content
akm proposal diff <id>                   # diff vs. the live version of that ref
akm proposal accept <id>                 # validate, then promote to stash
akm proposal reject <id> --reason "…"   # archive with a reason
```

`akm proposal accept` does not just write the file. It runs full validation and routes the write through the same `writeAssetToSource()` path used by `akm remember` and `akm import`. There is no bypass path. A proposal that fails validation does not get promoted.

## The 0.8.0 Additions

0.8.0 reorganized the proposal commands under the `akm proposal` subcommand (the old flat verbs — `akm proposals`, `akm accept`, `akm reject`, etc. — still work as deprecated aliases until 0.9.0) and added three features that change how you interact with the queue at scale: confidence scores, expiration, and per-proposal revert.

**Confidence scores.** Each proposal now carries an optional `confidence` field (a value from 0 to 1) set by the pipeline that generated it. `akm proposal show <id>` includes this field in its JSON output. A high-confidence proposal is one the pipeline assessed as a strong, well-supported improvement. A low-confidence one is speculative or weakly supported. The score is not a gate — you still decide — but it gives you signal for triage. When you have thirty proposals and limited review time, work high-confidence proposals first. (The belief model that drives these scores is covered in [Belief-Aware Memory](https://dev.to/itlackey/belief-aware-memory-teaching-your-agent-when-not-to-write-4egi).)

**Expiration.** Proposals expire after a configurable number of days. Set `improve.archiveRetentionDays` in your akm config to control the window (default: 30 days). Stale proposals that you never got around to reviewing are automatically archived rather than accumulating indefinitely. Anything that mattered enough to act on should have been reviewed before it aged out; the archive preserves the full audit trail if you need to look back.

**Per-proposal revert.** After you accept a proposal, `akm proposal revert <id>` restores the backup of the previous version. This is not a bulk operation and it is not reversible in batch. You revert one proposal at a time, by ID:

```sh
akm proposal revert <id>    # restore the backup for a specific accepted proposal
```

The no-batch-revert constraint is intentional. Bulk accept without bulk revert is the guardrail that forces deliberate review. If you accept fifty proposals in a single command and three of them are bad, you revert those three individually. The discipline is the point — if you were going to bulk-revert, it means you bulk-accepted without reviewing, and the queue exists precisely to prevent that pattern.

## Bulk Accept Guardrails

For cases where you want to process more than one proposal at a time without bypassing judgment entirely, 0.8.0 extended `akm proposal accept` with generator-scoped batch flags.

**`akm proposal accept`** supports generator-scoped bulk operations. When you want to accept all pending proposals from a specific generator, pass `--generator` without a positional id. Bulk accept requires `-y`/`--yes`:

```sh
akm proposal accept --generator reflect --yes        # accept all reflect proposals
akm proposal accept --generator distill --yes        # accept all distill proposals
```

The `--yes` flag removes the interactive confirmation prompt required in non-interactive shells. Use it only after you have already reviewed the queue via `akm proposal list` and `akm proposal diff`. Bulk accept without prior review is exactly the pattern the queue exists to prevent.

## Auto-Accept for Trusted Sources

If you have a source you fully trust — a well-constrained task asset running against a curated input set, or a distill job that only ever touches a specific category — you can set a high `autoAccept` threshold in that improve profile. Proposals whose confidence meets or exceeds the threshold are promoted directly to the stash without manual review.

This is off by default and should stay off for most sources. The value of the queue is exactly that it sits between agent output and your live stash. Auto-accept makes sense only when the source is trusted, the scope is narrow, and you are comfortable with the output quality from experience rather than assumption.

## A Daily Review Habit

The proposal queue only helps if you actually review it. Left unattended, it either accumulates into a backlog that's too large to meaningfully triage, or proposals expire before you get to them. A brief daily review pass keeps it manageable.

The workflow that works:

```sh
# Start with the full pending list
akm proposal list

# For each proposal worth reading, diff it against the live ref
akm proposal diff <id>

# Accept the ones that look right
akm proposal accept <id>

# Reject the ones that don't, with a reason you'll understand later
akm proposal reject <id> --reason "hallucinated — no source for this claim"
```

The diff is the most useful step. `akm proposal diff <id>` shows you the delta between the proposal and whatever currently exists for that ref in your live stash. A proposal that adds accurate new context to a ref you already maintain is easy to accept. A proposal that rewrites a ref you know well with confident-sounding but unverifiable claims is easy to reject. The diff makes the difference visible.

If the queue is empty, the daily review takes thirty seconds. If `akm improve` ran overnight and produced twenty proposals, budget ten minutes. The point is not to process every proposal — it is to stay close enough to the queue that nothing accumulates into a block of work large enough to skip.

For teams running `akm improve` on a schedule, the confidence scores make triage faster. High-confidence proposals need a quick diff and a decision. Low-confidence proposals need closer reading or an outright reject. Over time, the pattern of what the pipeline marks as high-confidence and what actually turns out to be good teaches you where to focus attention.

## The Shape of Safe Agent Memory

The proposal queue is not a bureaucratic checkpoint. It is the mechanism that makes it safe to run `akm improve` continuously, trust agent-driven reflection passes, and still maintain a knowledge base where you know what is in it and why.

Without the queue, you are choosing between running the improve pipeline (accepting everything it produces) or not running it (getting nothing it produces). The queue is the third option: run it continuously, review the output deliberately, promote what earned it. The 0.8.0 guardrails — confidence scores, expiration, per-proposal revert, and generator-scoped bulk accept — are the tools that make that third option practical at the scale continuous operation produces.

---

The proposal queue is available as of akm 0.7.0. The 0.8.0 additions — confidence scores, expiration, `akm proposal revert`, and generator-scoped bulk accept — require 0.8.0 or later. Full reference at [docs/cli.md](https://github.com/itlackey/akm/blob/main/docs/cli.md#proposal) and the [configuration reference](https://github.com/itlackey/akm/blob/main/docs/configuration.md).
