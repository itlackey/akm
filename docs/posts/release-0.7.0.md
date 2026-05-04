---
title: 'akm 0.7.0: Proposal Queue, Reflection Commands, Lessons, and akm-bench'
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm
description: 'akm 0.7.0 is the last pre-1.0 ship: a proposal queue, agent reflection commands, the lesson asset type, opt-in LLM feature gates, and a paired-run benchmarking framework.'
tags:
  - ai
  - agents
  - cli
  - release
published: true
date: '2026-05-04T00:00:00Z'
---

akm 0.7.0 is out. This is the last pre-1.0 ship in the v1 cycle. The headline features are a durable proposal queue that routes all agent-suggested changes through a single reviewable path, three new CLI surfaces (`reflect`, `propose`, `distill`) that write into that queue, a `lesson` asset type for synthesized knowledge, per-call-site LLM feature gates that are all off by default, and a paired-run benchmarking framework (`akm-bench`) for measuring whether your stash actually improves agent outcomes. A batch of security, UX, and hygiene hardening rounds out the release.

If you are on 0.6.x, the [v1 migration guide](../migration/v1.md) covers the per-surface delta. The upgrade is opt-in — everything new requires explicit configuration or a new command invocation.

## TL;DR

- **Proposal queue** (`akm proposal list/show/diff/accept/reject`) — all agent-generated changes flow through a durable queue before touching your stash.
- **`akm reflect`, `akm propose`, `akm distill`** — three new commands that produce proposals without mutating live stash content.
- **`lesson` asset type** — first-class synthesized knowledge, produced by `akm distill` and promoted via `akm proposal accept`.
- **`llm.features.*` map** — seven opt-in gates (all `false` by default) for bounded in-tree LLM call sites.
- **`quality: "proposed"`** — proposed assets are excluded from default search; surface them via `--include-proposed` or `akm proposal *`.
- **`akm-bench` v1** — paired noakm/akm runs, per-ref attribution, delta reporting.
- **Security hardening** — git message sanitization, bench env isolation, LLM body redaction, npm tarball host validation.

---

## Proposal queue (`akm proposal *`)

The fundamental problem with agent-generated suggestions is trust: you want to capture what the agent learned without blindly writing unreviewed content into your stash. The proposal queue solves this by separating generation from promotion.

All proposal-producing commands write to a durable queue that lives outside the asset tree. Unaccepted drafts never appear in search results or get committed. When you're ready to accept a proposal, `akm proposal accept` runs full validation and then routes the write through the same `writeAssetToSource()` path used by `akm remember` and `akm import` — no special handling, no bypass.

```sh
akm proposal list                       # list pending proposals
akm proposal show <id>                  # render one proposal
akm proposal diff <id>                  # diff vs. the live ref
akm proposal accept <id>                # validate, then promote to stash
akm proposal reject <id> --reason "…"  # archive with reason
```

Multiple proposals for the same ref coexist without filesystem collisions. Auto-accept can be enabled per-source via `autoAcceptProposals: true` in your stash config (requires a writable source, defaults off).

## Three new commands: `reflect`, `propose`, `distill`

These three commands are the primary way to generate proposals.

```sh
akm reflect [ref] [--task ...]        # reflect on an asset and propose improvements
akm propose <type> <name> --task "…"  # generate a new asset as a proposal
akm distill <ref>                     # synthesize a lesson from an asset
```

`reflect` and `propose` shell out to your configured agent CLI and write only to the proposal queue — they never mutate live stash content. `distill` is a bounded in-tree LLM call, gated behind `llm.features.feedback_distillation`, that produces a `lesson`-type proposal from an existing asset.

All three emit usage events so you can track which workflows you're actually using.

## `lesson` asset type

`lesson` is a new first-class asset type designed for synthesized knowledge — the kind your agent derives from experience rather than imports from a source. Lessons are stored under `lessons/<name>.md` in your working stash, parallel to `memories/`. Required frontmatter: `description` and `when_to_use`.

The canonical workflow: `akm distill <ref>` produces a lesson proposal → `akm proposal list` shows it → `akm proposal accept <id>` promotes it to your stash. Direct authoring via `akm import` or `akm remember`-style flows is also supported if you want to write lessons manually.

## `llm.features.*` — opt-in LLM gates

Every bounded in-tree LLM call site is now gated behind exactly one feature flag. All defaults are `false`, so enabling the schema has no effect until you opt in. Seven flags ship in 0.7.0:

| Key | What it enables |
| --- | --- |
| `curate_rerank` | LLM rerank in `akm curate` |
| `tag_dedup` | LLM tag dedup during indexer enrichment |
| `memory_consolidation` | `akm remember --enrich` consolidation |
| `feedback_distillation` | `akm distill <ref>` |
| `embedding_fallback_score` | Scorer fallback when embeddings unavailable |
| `memory_inference` | Indexer split of pending memories into atomic facts |
| `graph_extraction` | Indexer entity/relation extraction → `graph.json` |

Turn on what you want:

```sh
akm config set llm.features.feedback_distillation true
akm config set llm.features.memory_consolidation true
```

Every gated call site uses the `tryLlmFeature()` wrapper from `src/llm/feature-gate.ts`, which guarantees: disabled → fallback returned without ever calling the LLM; throw → error swallowed, fallback returned; timeout → 30-second hard limit, fallback returned.

## `quality: "proposed"` and `--include-proposed`

`SearchHit.quality` now has three well-known values: `"generated"`, `"curated"`, and `"proposed"`. The first two appear in default search. Proposed assets are **excluded by default** — they only surface via `akm search ... --include-proposed` or via the `akm proposal *` commands. Unknown quality values parse-warn-include so plugin authors can extend the set without breaking the indexer.

## `akm-bench` v1

Bench grows from a smoke test into a paired-utility framework:

- **Track A — paired noakm/akm runs.** For each task, bench runs your agent CLI twice (without and with akm available), captures per-tool-call utility, and emits a comparable score pair.
- **Track B — registry attribution.** Utility deltas are mapped back to specific `[origin//]type:name` refs so you can see which assets in your stash actually contributed to the improvement.
- **`akm-bench compare`** — aggregates paired runs into a delta report.
- **`akm-bench attribute`** — surfaces the per-ref attribution report.

```sh
akm-bench compare results/noakm results/akm
akm-bench attribute results/akm
```

The technical reference is at [`docs/technical/benchmark.md`](../technical/benchmark.md).

## Security hardening (PR #275)

Five security, UX, and hygiene issues landed together in the pre-prod hardening batch:

**Security:**
- **#270 — git message sanitization.** Commit messages and remote URLs written by akm are sanitized to prevent shell-substitution and control-character injection through user-supplied content.
- **#271 — bench env isolation.** Each agent invocation in `akm-bench` runs in a scrubbed environment so host secrets don't leak into bench transcripts.
- **#272 — LLM body redact + npm tarball host validation.** Outbound LLM request/response bodies are redacted in error reporting before surfacing to stderr. `akm add npm:…` now validates the tarball download host against your configured npm registry instead of blindly following arbitrary `dist.tarball` URLs.

**UX:**
- **#273 — workflow noise gate, stashes deprecation warn, setup `--help`.** `akm workflow next/complete/status` no longer print spurious progress noise on quiet runs. Configs using the legacy `stashes[]` key now emit a single deprecation warning per process (was: per call site). `akm setup --help` renders the full help block.

**Hygiene:**
- **#274 — tsconfig + HF pin + shapes throw.** `tsconfig.json` now covers `tests/` so `bunx tsc --noEmit` catches test-file errors. The HF embeddings model is pinned to a specific revision. The output-shape registry now throws on a missing shape rather than silently falling back to `JSON.stringify`.
- **#276 — bench tmp redirect.** `akm-bench` no longer writes scratch state under `/tmp`; everything lands under `~/.cache/akm/bench/`.

## Upgrade

```sh
npm install -g akm-cli@0.7.0
# or
bun install -g akm-cli@0.7.0
# or from an existing install
akm upgrade
```

**Verify:**

```sh
akm info --format text     # version 0.7.x
akm proposal list          # queue starts empty — that's expected
```

**Try the new surfaces:**

```sh
akm setup                                            # detects installed agent CLIs
akm config set llm.features.feedback_distillation true
akm distill memory:my-debugging-notes               # produces a lesson proposal
akm proposal list
akm proposal accept <id>
```

No manual migration is required for users on 0.6.x with no `agent` or `llm.features` blocks configured. Everything new is opt-in.

Full details in the [v1 migration guide](../migration/v1.md) and the [0.7.0 release notes](../migration/release-notes/0.7.0.md).

Full changelog at [CHANGELOG.md](https://github.com/itlackey/akm/blob/main/CHANGELOG.md).
