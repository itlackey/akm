# AKM End-to-End Consensus Review

Date: 2026-05-02

## Executive summary

AKM has a strong overall direction: a unified stash model, useful CLI surface area, durable event streams, a proposal queue, and an explicit benchmark plan aimed at agent-level utility rather than isolated search quality. The board reached consensus, however, that several live integration gaps materially reduce AKM's current effectiveness.

The most serious issues are on the critical path for discovery and knowledge access. The default official registry configuration is incompatible with the current live registry index format, cold-start remote source hydration still follows the removed `stashes[]` config path, and wiki behavior is internally inconsistent across pages, raw content, and index regeneration semantics. Together, these issues make it harder for agents and operators to discover assets reliably and to trust wiki workflows.

The board also reached consensus that the repo's evaluation posture is not yet strong enough to support broad claims about AKM effectiveness. The benchmark framework is promising, but parts remain manual, exploratory, or disconnected from CI, and the current telemetry has gaps that weaken lifecycle and learning analysis.

## Consensus findings

### F1. Default official registry is incompatible with the live official index

Severity: High

Why it matters for AKM effectiveness:
The default registry path is part of the first-run discovery path. If the shipped default points at a live index format the runtime rejects, registry-backed discovery fails out of the box and weakens the overall install, search, and guidance experience.

Repo evidence:
- `src/core/config.ts:302-307` sets the default official registry URL to `https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json`.
- `src/registry/providers/static-index.ts:250-264` rejects any registry index whose `version` is not exactly `3`.
- Live external check on `https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json` returns `"version": 2` as of this review date.

Recommendation:
Make the default path and parser compatible immediately: either accept version 2 during a transition window, or move the default official registry to a version 3 endpoint that is already live and tested.

### F2. Cold-start remote source hydration still uses the removed `stashes[]` config path

Severity: High

Why it matters for AKM effectiveness:
Remote and website sources need cache hydration before they become useful on a fresh machine. Using a removed config path means the cold-start path can silently skip intended sources, reducing the value of AKM precisely when the user most needs it.

Repo evidence:
- `src/indexer/search-source.ts:256-279` iterates `cfg.stashes ?? []` in `ensureSourceCaches()`.
- `src/core/config.ts:540-545` rejects `stashes[]` and requires `sources[]` instead.

Recommendation:
Switch `ensureSourceCaches()` to the supported `sources[]` runtime shape and add an end-to-end cold-start test that covers git and website sources with an empty cache.

### F6. Wiki semantics are internally inconsistent across raw content, pages, search, and index regeneration

Severity: High

Why it matters for AKM effectiveness:
Wikis are positioned as a first-class knowledge surface. When CLI hints, page listing, scoped search, and regeneration behavior disagree, operators cannot reliably predict what will be indexed, listed, searchable, or rewritten.

Repo evidence:
- `src/output/cli-hints.ts:139-149` says `akm wiki pages` excludes `schema/index/log/raw` and says AKM owns lifecycle and index regeneration for stash-owned wikis.
- `src/wiki/wiki.ts:592-610` implements `listPages()` by including both authored pages and `raw/` sources.
- `src/wiki/wiki.ts:631-661` implements `searchInWiki()` by filtering out only root `schema.md`, `index.md`, and `log.md`; raw content under the wiki remains searchable.
- `src/indexer/indexer.ts:286-293` regenerates wiki indexes only for the primary stash because additional sources are treated as read-only caches.

Recommendation:
Define one canonical wiki contract and enforce it consistently across help text, `wiki pages`, scoped search, and regeneration. If raw sources are intentionally addressable, document that explicitly; if not, exclude them consistently from listing and search.

### F10. Evaluation rigor is not yet sufficient for broad effectiveness claims

Severity: Medium-High

Why it matters for AKM effectiveness:
AKM makes system-level claims about helping agents find, use, and improve knowledge over time. Those claims require an evaluation loop that is automated, reproducible, and representative of live usage. The current framework is directionally good but not yet strong enough to carry broad external claims.

Repo evidence:
- `.github/workflows/ci.yml:1-86` contains no benchmark job.
- `docs/technical/benchmark.md:1-19` states the framework is a proposal and is run manually, not wired into CI.
- `tests/bench/BENCH.md:39-50` marks `evolve` as a stub and says its numbers should be treated as exploratory until further validation.

Recommendation:
Reduce claim scope until the framework matures, and promote a minimal reproducible benchmark lane into CI for non-exploratory tracks. Publish clear release criteria for when utility and evolution results are considered decision-grade.

### F3. Registry discovery has cross-provider ranking and configuration-resolution flaws

Severity: Medium

Why it matters for AKM effectiveness:
Registry search is only useful if results remain interpretable and comparable across providers. Losing provider metadata on override and globally sorting raw scores across heterogeneous providers makes the merged result set less trustworthy.

Repo evidence:
- `src/commands/registry-search.ts:111-126` rebuilds `AKM_REGISTRY_URL` override entries as `{ url }`, dropping configured metadata such as provider or name.
- `src/commands/registry-search.ts:86-91` sorts merged hits directly by raw `score` across providers.

Recommendation:
Preserve provider metadata when applying env overrides, and avoid direct cross-provider raw-score ranking unless scores are normalized or partitioned by provider.

### F7. Asset history and proposal lifecycle audit trails are split across different systems

Severity: Medium

Why it matters for AKM effectiveness:
AKM's learning loop depends on being able to explain how an asset was used, criticized, proposed, promoted, or rejected. When lifecycle evidence is split across incompatible stores, operators and future automation get an incomplete picture.

Repo evidence:
- `src/commands/history.ts:1-8` says `akm history` is backed by `usage_events` and that richer lifecycle entries require the separate events stream.
- `src/commands/proposal.ts:115-128` appends `promoted` events to `events.jsonl`.
- `src/commands/proposal.ts:169-178` appends `rejected` events to `events.jsonl`.

Recommendation:
Unify user-visible audit history across `usage_events` and the append-only events stream, or clearly expose both planes in the history command so lifecycle analysis is complete by default.

### F8. Feedback-learning signals are incomplete and easy to undercount

Severity: Medium

Why it matters for AKM effectiveness:
AKM's learning loop is only as good as the telemetry it learns from. Reindex-dependent updates, weakly expressed negative signals, and registry-only result counting gaps all reduce the quality of feedback available for ranking and evaluation.

Repo evidence:
- `src/commands/search.ts:197-215` logs `resultCount` from `response.hits.length`, which excludes registry hits when `source === "registry"`.
- `tests/bench/BENCH.md:72-80` shows the benchmark currently emits only two AKM trajectory booleans in v1, leaving other useful behavior signals deferred.

Consensus caveat:
The board agreed this is a real limitation, but not evidence that the learning loop is non-functional. The issue is underpowered and undercounted signals, not total absence of feedback handling.

Recommendation:
Count registry-only results correctly, document when reindexing is required for ranking changes to take effect, and make negative-signal handling more explicit in both telemetry and evaluation outputs.

### F4. Search and show workflow contracts have a small set of hard inconsistencies

Severity: Medium

Why it matters for AKM effectiveness:
Search is the gateway to the rest of AKM. Hard mismatches between CLI contract, docs, and runtime behavior increase operator error and make agent prompting less reliable.

Repo evidence:
- `src/cli.ts:214-244` documents the positional query as optional and says it may be omitted to list all assets, but the runtime rejects an empty query.
- `docs/cli.md:189-206` explains that local hits have a `ref` and documents detail-level field sets.
- `src/output/shapes.ts:449-467` omits `ref` from the default `brief` shape and only includes it for `agent` and `full` detail levels.

Consensus caveat:
Consensus held only on the hard inconsistencies above. Broader wording about hidden details or general search opacity did not survive board consensus and is intentionally excluded here.

Recommendation:
Either support empty-query listing in runtime or remove that promise from the CLI contract, and keep the search-result field documentation tightly aligned with the actual detail-level shapes.

## Architecture/design assessment

AKM's architecture is strongest where it has explicit contracts: typed config, a proposal queue, append-only events, and distinct output shapes for different consumers. The repo shows good intent around separating search, registry, wiki, and benchmarking concerns.

The main architectural weakness is contract drift across layers. Several high-severity findings are not deep algorithmic failures; they are mismatches between defaults, parsers, config migration, and user-facing semantics. That pattern suggests the architecture is viable, but cross-cutting compatibility checks are not yet strict enough.

Design-wise, the wiki subsystem also needs a firmer source-of-truth contract. Today, lifecycle ownership, page visibility, raw-source treatment, and regeneration policy are described differently in help text and implementation.

## Functionality/workflow assessment

Core user workflows are conceptually coherent: search, show, feedback, propose, and wiki operations all map to plausible agent and operator use cases.

In practice, the most important end-to-end workflows still have avoidable breakpoints:
- Registry discovery can fail on the shipped default.
- Remote source hydration can miss configured sources on a fresh setup.
- Search CLI and docs do not fully match runtime behavior.
- Wiki commands do not present a single predictable model of what counts as a page versus raw content.
- History does not yet give a complete lifecycle view without consulting multiple event planes.

These are effectiveness issues more than surface polish issues, because they sit on the critical path between intent, discovery, use, and learning.

## Benchmarks/evaluation assessment

The benchmark strategy is well aimed. The repo correctly distinguishes isolated search-quality testing from end-to-end agent utility, and it explicitly favors deterministic verifiers over judge-model scoring.

The current implementation state is still below the bar for broad product claims:
- Bench execution is manual rather than CI-backed.
- The `evolve` track is explicitly exploratory/stubbed.
- Current v1 trajectory outputs capture only a subset of the benchmark plan's richer intended signals.

The board therefore supports narrower claims such as "benchmark framework in progress" or "early utility harness available," but not strong general claims about AKM's end-to-end effectiveness or self-improvement impact.

## External research touchpoints

- Official AKM registry index URL: the live `index.json` currently serves `version: 2`, which confirms the repo's default-path incompatibility is a real external integration issue, not just a theoretical one.
- Vertex AI trajectory-evaluation documentation: current agent-evaluation practice distinguishes task outcome from action trajectory, which supports AKM's benchmark direction but also highlights that partial trajectory capture is not enough for strong causal claims.
- SWE-Skills-Bench (arXiv:2603.15401) and SkillsBench (2026): both use paired, deterministic evaluation and both report high variance and negative transfer risk. That implies AKM should avoid broad utility claims until its own paired evaluation is automated, representative, and stable.

## Deferred or disputed items

- F5. Missing `akm agent` command: not included as a primary finding. Board consensus was to treat this as roadmap/spec context, not a current top-level defect.
- F9. Legacy benchmark prominence/method weakness: not retained as a standalone finding. Its substance is merged into F10's broader evaluation-rigor conclusion.
- F4 broader wording: claims about generally hidden or opaque search details were disputed and are intentionally excluded. Only the specific contract mismatches documented above survived consensus.

## Recommended next steps

1. Fix the official registry compatibility break and add a regression test against the live format AKM currently ships by default.
2. Repair `ensureSourceCaches()` to use `sources[]` and add a fresh-cache end-to-end test for git and website sources.
3. Write one canonical wiki behavior contract, then align help text, `wiki pages`, scoped search, and index regeneration to that contract.
4. Narrow outward-facing effectiveness claims until a non-exploratory benchmark lane runs reproducibly and automatically.
5. Preserve registry provider metadata under `AKM_REGISTRY_URL` overrides and stop globally ranking heterogeneous provider scores without normalization.
6. Unify lifecycle audit history so proposal and usage evidence can be queried together.
7. Tighten telemetry around feedback and search result counting, especially for registry-only flows and negative signals.
8. Remove or implement the empty-query search behavior promised by the CLI contract, and keep docs generated from the same shape definitions where possible.

## Appendix: board voting summary table

| Finding | Board disposition | Consensus outcome | Severity used here |
| --- | --- | --- | --- |
| F1 official registry path broken | 3x Include | Included | High |
| F2 cold-start remote source hydration uses dead `stashes[]` path | 3x Include | Included | High |
| F3 registry discovery flaws | 3x Include / Include with caveat | Included | Medium |
| F4 search/show workflow inconsistencies | 2x Include with caveat, 1x Discard | Included, narrowed to hard inconsistencies only | Medium |
| F5 missing `akm agent` command | 2x Discard, 1x Question | Deferred / not a primary finding | — |
| F6 wiki semantics contradictions | 3x Include | Included | High |
| F7 history vs proposal lifecycle audit gap | 3x Include | Included | Medium |
| F8 feedback-learning limitations | 3x Include with caveat | Included with caveat | Medium |
| F9 legacy benchmark prominence/method weakness | Mixed | Merged into F10 | — |
| F10 evaluation rigor insufficient for broad claims | 3x Include | Included | Medium-High |
