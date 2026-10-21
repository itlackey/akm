# #1199 — curate recall controls

Status: **ready for rollout** — accepted for PR review; production rollout remains outstanding.

Baseline: origin/release/0.10.0 at `79cf3236a` (includes #1196/#1198/#1200 via #1204/#1206/#1205).
Branch/base: `feat/1199-curate-recall-controls` → `release/0.10.0`.
Process: akm-stash `fd61fd1`, current measured-improvement skill, retrieval and answers guidance.

## Job, finding, and hypothesis

Ordinary task recall should recommend current useful evidence; historical investigations must retain an explicit route to older evidence. Baseline curate accepts neither scope nor belief controls, enriches unchecked links, and packs via unrestricted show. Search already applies eligibility before candidate budgets. Derived surfaces also need eligibility checks before their text reaches reranking.

Candidate 1: forward existing `filters`/`belief` controls, start curate at `current`, and enforce the same eligibility through enrichment and packing. Evaluate search's all/current default separately. No ranking or abstention tuning, identity changes, new policy/config/filter grammar, or memory maintenance.

## Ordered acceptance criteria (before implementation)

1. Blockers: no scope/source/type widening or stale supporting authority; CLI/API parity and shared validation; preserve eligibility-before-budget, safe links, evidence preservation, unflagged reference knowledge, derived-twin demotion, explicit all/historical jobs. Required deterministic tests and full checks pass.
2. Primary benefit: improve current-fact selection on a compact authored corpus without losing its useful task answers; historical tasks succeed under explicit historical/all. A deterministic correctness fix is worthwhile even if aggregate ranking is unchanged.
3. Guardrails: inspect all changed public-library/books cases, relevance and recall, missing/empty/error paths, stale links and packed content. Material unexplained regression blocks. Losing stale recommendations is intentional; a small understood secondary ranking loss may be accepted if useful answers remain.
4. Costs: report index and query latency, modes/fallback, packed tokens; no extra model service or duplicate broad search for link eligibility. More than 2× query latency requires investigation, not automatic rejection from a noisy sample.
5. Final validation: reserved new scenarios (separate authored domain), built package installed CLI/API current and historical tasks, full repository checks. Submission does not mean production rollout.

## Budget and stopping

Maximum three product candidates TOTAL. Candidate 1 planned; no tuning yet. Evaluation budget: up to 12 collector invocations (pilot, matched explicit settings, actual defaults, public library/books, merged eligibility corpus, reserved final), two targeted semantic observations per build only if stochastic variation matters, 90 minutes collection time. Reserve 3 invocations for final validation. Deterministic tests are correctness checks, not extra product candidates. Stop when a worthwhile benefit meets blockers and tradeoffs are understood. Preserve best validated candidate. No perfect-score pursuit.

## Preflight

Use existing akm-eval retrieval collector/scorer/compare tooling, selected checkout `27f5240` (per-query searchArgs support from #1198). Its searchArgs currently apply only to search: a narrow local collector adaptation will pass those existing tokens to curate too, recorded with artifacts. Keyword sandbox forces semantic off; semantic sandbox private lab overlay uses remote Qwen embedding, 600000 ms query timeout. Those are matched-setting experiments, NOT shipped defaults. Product default checks must omit recall flags and use product query timeout separately. No answer/judge model is needed for the fully labelled synthetic corpus. Keep credentials/private overlay out of artifacts.

## Recovery and rollout

Code-only change; no persisted format, migration, queued proposal or scheduled-work changes. Recover ordinary broad discovery with explicit `--belief all` (API `belief: "all"`), or revert the change/reinstall the prior build. Release maintainer owns merge/publication and post-release recall/error observation. User authorizes commit/push/PR only, no merge/deploy or issue closure.

## Decision and before/after evidence

Selected **variant 2: current by default in both search and curate**. No ranking,
abstention, embedding, identity, maintenance or configuration treatment was added.
Variant 1 supplied the complete curate policy path with current curate/all search;
variant 2 only made search share the measured current default. Two of three
allowed variants used; stop tuning after final validation. The intended benefit
is established, explicit investigation works, and remaining tradeoffs are bounded.

| Observation | Baseline | Selected policy | Interpretation |
| --- | ---: | ---: | --- |
| Compact ordinary current/reference jobs: useful hit in top 5 | 4/4 | 4/4 | Useful task recall preserved |
| Compact current-fact jobs with stale evidence above useful current evidence | 1/3 | 0/3 | Correctness improvement, both keyword and semantic |
| Explicit historical curate jobs | 4 usage errors | 4/4 succeed | Old CLI had no belief control; do not compare errored rows as ranking failures |
| All 14 compact cases, curate errors | 10/14 | 0/14 | Four scope cases, four history cases, explicit all and empty-filter case now supported |
| Eligible empty scope | unsupported option | empty | No broad fallback |
| Public books keyword nDCG@10 (51 jobs) | 0.8243 | 0.8351 | Rescored on identical pooled labels |
| Public books keyword useful recall@10 | 0.9223 | 0.9369 | No individual job loses useful recall |
| Public books banned-above-useful | 18/51 | 12/51 | Includes unrelated decoys as well as stale notes |
| Public books semantic curate nDCG@10 | 0.8990 | 0.9038 | Small observation, not a statistical ranking claim |
| Public books semantic useful recall@10 | 0.9849 | 0.9877 | No individual job loses useful recall |
| Public ordinary library keyword nDCG / useful recall | 0.7565 / 0.7440 | identical | 136 inputs; 101 scored answerable jobs, 10 no-answer and 25 non-task inputs |
| Public library semantic curate nDCG | 0.8190 | 0.8200 | No belief labels in this library; semantic differences cannot establish a default-policy effect |
| Reproduced #1198 eligibility corpus, candidate | — | 8/8 success, no banned-above hit | All four columns; keyword nDCG 1.0, semantic curate 0.9077; all useful answers retained |
| Real shipped-default rollout example, packed payload | 264 tokens | 196 tokens | Same 4000-token budget, estimator is chars/4; no answer-model cost claim |
| Same default example, CLI query latency (3 observations) | 241–249 ms | 259–270 ms | Approximately +8% median; startup included; no operational ceiling exceeded |

The compact baseline's aggregate curate score covers only four valid jobs, while
the candidate covers 13 answerable jobs plus one empty job. This is a capability
and correctness comparison, not a like-denominator aggregate ranking win. The
matched public `all` runs isolate code with unchanged eligibility: **all keyword
search and curate ref lists are identical** in both public collections. See
[matched library](compare-matched-library.md), [matched books](compare-matched-books.md),
[default library](compare-default-library.md), [default books](compare-default-books.md),
and [compact comparison](compare-compact.md).

### Effective settings and measurement limits

The evaluator was `27f5240`, with the narrow [local invocation adaptation](collector-adaptation.patch)
that passes its existing per-query `searchArgs` to curate as well as search. The
underlying recorded collector/scorer version is 0.3; this local collector
adaptation is explicitly part of these experiments, not an unchanged upstream
collector claim. No new filter/schema/runner was introduced. Public invocation
wrappers are saved beside this record: matched `all` explicitly sets candidate
curate to all; proposed-current explicitly sets search to current before the
final product default change. Variant 2 implements that same tested option
choice; the **installed default** is separately verified without the flag.

Keyword sandboxes forced semantic off. Semantic collections explicitly enabled
the owner's lab Qwen `embed/qwen3-embedding-0.6b`, dimension 1024, query/index
embedding timeouts 600000 ms, with reranking absent/disabled. Every valid semantic
collection verified semantic mode; there was no silent keyword substitution.
All full public arms completed 136 library + 51 books inputs, zero errors or
timeouts. The compact baseline has the 20 documented unsupported curate calls
(10 keyword + 10 semantic), not a fallback. No answer/judge LLM was called.
The separate [actual-default measurement](defaults.json) omitted semantic mode,
query timeout, reranker and recall defaults: the shipped semantic default is
**off**, so it correctly reports keyword, not semantic. This prevents claiming
that changing `--akm` alone tested product defaults.

The three public collections built cold semantic indexes (library 11.9/11.6/16.4 s,
books 3.8/5.6/5.5 s for baseline/matched/current), then ran warm indexed queries in
fresh CLI processes. Total collection times are in the summaries; server load and
independent embedding builds make them unsuitable for a speed-win claim.
[provenance.json](provenance.json) pins the base, skill/evaluator, product diff and
installed tarball hashes despite the unchanged package version string.

### Pooled judgments and negative cases

Reviewed all newly surfaced unjudged task-query pairs from matched/current versus
baseline under the existing 0–3 rubric. Added 63 missing rows: 11 prior verified
judgments with matching evaluator asset digests, nine newly reviewed library
pairs, and 43 books pairs. No existing judgment changed. [Library additions](qrel-additions.jsonl),
[remaining library additions](library-new-labels.jsonl), and [books additions](books-new-labels.jsonl)
are retained. Explicitly rescored **all six saved public arms** with the existing
rescore tool; original raw samples and summaries remain alongside the rescored
copies. Remaining semantic judgment coverage is about 83% library / 89% books;
unchanged unjudged pairs remain a disclosed limitation, not invented relevance.

Every negative case is listed in [failures/](failures/). Current policy's books
nDCG decreases on some individual queries because stale same-topic grade-1 notes
no longer contribute partial gain; their grade-2/3 answers remain. These are
bounded, intentional losses of historical discovery unless the caller requests
all/historical. No books or keyword-library job loses useful recall.

The only observed new-default semantic-library useful-recall decrease is **q008,
0.6 → 0.4** (a useful result at the top-ten boundary). The unchanged shared-index
pilot reproduces **both 0.4 and 0.6 on both builds**, and nDCG 0.7260/0.7811. The
five-case unchanged-build means overlap (roughly 0.7293–0.7420 on both builds).
[Variation evidence](variation-scores.json) records two observations per build,
40 calls, zero errors. The earlier pilot raced a different collector's index
rebuild and had three errors; it was discarded, never used for acceptance.
This bounds attribution of the small semantic differences; it does not establish
that embedding results are globally stable. No score-driven code tuning followed.
Existing poor non-task abstention (1/25 curator abstentions, unchanged) stays in
#1201; it was neither hidden nor optimized here.

#### Review additions (independent recomputation)

- Books keyword: nDCG falls on 9 of 51 queries and rises on 19 (worst
  `medical-adv-pinned-fact-cpr-ratio`, −0.0663); 20 grade-1 and 22 grade-0 hits
  leave the top ten, no grade-2/3 hit is lost and no query loses recall. Under the
  original labels the gain is +0.0081 (0.8275 → 0.8356), so the keyword gain does
  not depend on the added labels.
- Books semantic: nDCG falls on 17 queries and rises on 18 (worst
  `culinary-onion-caramelization-belief-state`, 0.8921 → 0.7232, a grade-0 note
  moving to rank 1). Under the original labels the semantic delta is about 0
  (search 0.9021 → 0.9020); the rescored +0.005 comes mainly from the 43 added
  books labels, 40 of which surface only in the current arm.
- Library semantic: means move by +0.0005 to +0.001, below the noise floor;
  useful recall also falls on q088 search (1.0 → 0.857), which is not covered
  above. Each arm built its own cold semantic index, and the matched-`all`
  control is itself slightly below baseline, so semantic differences are not
  attributed to the policy.
- The compact and eligibility collector runs used variant 1 (search still `all`);
  the final search default is covered by `installed-search.json` and `defaults.json`.
- The lab embeddings endpoint and local checkout paths in these files are redacted.

## Implementation and final verification

- Shared `RecallOptions` reuses `StashEntryScope` and `BeliefFilterMode`. CLI uses
  the existing repeated-filter, belief and named-source parsers; public API calls
  that same command path with `source`, normalized `filters`, and `belief`.
- Existing indexed eligibility, including same-bundle inherited twin demotion,
  gates derived surface text before reranking. Show's internal evidence reads
  recheck the same policy and live scope/belief metadata. Packing retains the
  effective policy; unreadable/ineligible content never falls back to unchecked
  hit descriptions. Indexed paths bind named-source reads/followups correctly.
- Outgoing and incoming support refs obey the requested source/type/scope/belief
  policy. All/historical results, support refs and packed content label historical
  context. Ordinary unflagged reference knowledge is still eligible. Authored body
  prose and links are preserved; this is asset selection, not body fact-checking.
- No persisted format or write-path change: no migration, backfill, reindex,
  queue reassessment or compatibility shim is required. Direct show still reads
  explicit historical refs. Registry catalogs remain separate, opt-in, and do not
  acquire local scope/belief metadata.

Focused plumbing/content assertions, CLI/public API byte parity, invalid controls,
all scopes, compound source/type, inherited twins, stale links, missing sources,
removed/changed scopes, packed labels, reranker enabled/disabled and empty results
are in [curate-recall-controls.test.ts](../../../tests/integration/curate-recall-controls.test.ts).
Unchanged independently authored final eligibility cases and merged extraction
publication/evidence cases were reserved as regression checks, not used for
parameter tuning: [reserved-final.log](reserved-final.log). This finite check is
not a new independent model-quality benchmark.

The full check first exposed fixtures depending on old implicit-all discovery and
one reranker fixture that indexed nonexistent `/fixture` files. Those fixtures
now request explicit historical/all modes or materialize readable sandbox files;
their actual belief/reranking assertions are preserved. No failure was skipped.
The final validation log and exact commands are linked below.

[Installed Bun/Node API and CLI](installed-final.json) agree byte for byte on a
scoped current task (one current rollout asset) and a historical task (two labelled
old assets). [Installed search](installed-search.json) returns 3 hits with omitted
belief, the same 3 with current, 5 with all, and 2 with historical. An initial
same-filename, same-version reinstall reused Bun's old tarball cache; it was
rejected as verification evidence. The selected package was installed in a fresh
directory from a unique tarball filename and its actual compiled defaults checked.

## Closing state and rollout

Implementation acceptance is supported by the final full check recorded in
[check-final.log](check-final.log): lint/typecheck pass, 7,213 unit and 3,887
integration tests pass, zero failures (4/81 existing explicit skips). Exact
commands and inspected failures are in [commands.md](commands.md); there are no
further product experiments.
Target: this focused branch and the package fingerprint in provenance.json.
Submission is for review, with **release/0.10.0** as PR base and a reference to
#1199. No merge, deployment, production observation or issue closure is authorized.

Once accepted, state is **ready for rollout**. The release maintainer owns review,
merge, publication and post-release checks of current task recall, explicit
historical investigation, errors and latency on the published build. Recovery:
use explicit `--belief all` / API `belief: "all"` for a broad job, or revert this
commit/reinstall the prior release. Since there is no data rewrite, rollback
needs no data migration. Existing inaccurate/unlabelled claims can still be
retrieved, and semantic variance/incomplete old labels limit broader quality
claims. These risks do not justify expanding into #1201 or a third variant.
