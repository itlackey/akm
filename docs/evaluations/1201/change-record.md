# #1201 — bounded conversational abstention

Status: **ready for rollout** — accepted for PR review; not deployed.

Baseline is merged #1207, `d2369845ad9e3bd9e968129eec60b7291b8d95f2`,
confirmed in `origin/release/0.10.0`. Branch `codex/1201-retrieval-quality`
targets `release/0.10.0`. Its current default, eligible candidate selection,
scope/belief propagation, support filtering and packing are baseline behavior,
not gains attributable to this issue. Explicit all/historical remain required.
Skill: akm-stash `ff35ed5`, measured-improvement and linked guidance.
Evaluator: latest origin/main `33c8f78`, retrieval collector/scorer 0.3.

## Observed boundary and hypothesis

Search uses OR BM25 and vector candidates, eligibility before channel budgets,
equal-weight RRF, then feedback. Curate selects top candidates (optional reranker),
enriches eligible source-live content/support refs, then packs in rank order.
The existing precheck recognizes tool envelopes and one stash README line.
Fresh keyword pilot: unsupported Terraform state locking returns print/tracker
context. No safe general no-answer threshold is established. Fresh per-case
non-task inspection shows standalone social messages selecting irrelevant material:
`ok sounds good, go ahead` selects print QA; `hey, are you still there?` selects an
agent-routing example and report analyst. These carry no task to retrieve for.

Proposed treatment: extend the EXISTING non-task precheck to whole-message greetings
and acknowledgments. Match the entire normalized message; any added task text
continues through normal retrieval. No search/ranking/packing/index/model/config
change, new classifier stage, model judge or additional retrieval pass.
No promise to solve logs/status messages, unsupported tasks, document truth,
section retrieval or the separate #1208–#1212 issues.

## Ordered acceptance (before tuning)

1. Hard constraints: scope/source/type/current correctness through support and
   packing, explicit all/historical recall, CLI/API parity, complete evidence and
   required repository checks. Any introduced integrity failure blocks.
2. Primary benefit: remove at least three demonstrated social-message false
   selections in the 25 public non-task inputs, plus fresh final conversational
   cases. Preserve all answerable task ref lists on the same index/settings;
   greeting/thanks followed by a real task must not falsely abstain.
3. Tradeoffs: report false abstention, task nDCG/recall and judged coverage, no-answer
   abstention, banned ordering, all-required-evidence cases, completion/errors,
   cold indexing and warm query/pack latency, estimated packed tokens and model
   calls. No aggregate gain may conceal a lost useful answer. Existing public
   unjudged pairs remain limitations, not automatically irrelevant judgments.
4. Resource bound: no new model calls; social precheck avoids embedding/show/pack.
   Investigate >2x task median query latency; do not tune ordinary timing noise.
5. Final: untouched author-created conversational/task pairs in a separate domain,
   existing merged scope/evidence tests, final public collections, installed CLI
   positive/empty/historical/API behavior. Solo critical review, no independent
   reviewer claimed. Ready for rollout is distinct from deployed.

## Budget and stopping

At most three exploratory approaches, counting the earlier rejected name-weight-4
experiment conservatively as approach 1. It did not fix its motivating exact-name
failures and had unresolved semantic losses; do not repeat it. This proposed
precheck extension is approach 2. Correctness repairs stay separately recorded.
At most 16 collector invocations, 90 minutes collection time, lab embedding only,
no answer/judge-model spending. Reserve four invocations for final/installed checks.
Stop once primary benefit and blockers pass with understood tradeoffs; no need
for a third approach or perfect abstention. If required validation remains blocked,
report needs iteration.

## Preflight

Latest evaluator uses boolean `--semantic`, NOT the older on/off/auto interface.
`--akm` accepts a CLI command. Without `--semantic` it creates keyword settings;
that alone does not test shipped defaults. `searchArgs` apply only to search;
policy assertions for curate will use existing AKM integration tests/direct CLI.
Private uncommitted lab overlay changes only semanticConfig/model identity, using
owner's existing embedding JSON and symbolic credential. Actual hybrid mode must
be semantic; fallback is an error. Long 600000ms embedding timeout is a measurement
setting, not shipped latency. Real defaults are observed separately without it.
User explicitly approved external lab embedding of public/synthetic data.
Local retrieval stub smoke passes. Initial setup failures (missing locked marked
dependency, sandbox denied local socket) are excluded from quality denominators;
fixed by bun install and authorized socket access. Private content is not sent.

## Recovery and rollout

Code only: no migration, reindex, persisted rewrite or queued decision changes.
Search remains available for deliberate keyword investigation of a social phrase.
Revert/reinstall the prior version for recovery. Release maintainer owns review,
merge/publication and observation of false abstention, fallback and latency.

## Decision and final results

Accept approach 2 and stop. The production change extends the existing precheck
with one whole-message expression, normalizing case, common punctuation and
whitespace. It does not strip social prefixes from real tasks. RRF, feedback,
search defaults/controls, candidate budgets, enrichment, packing and all indexing
semantics are unchanged. No new configuration, dependency, model stage or service.
#1208–#1212 remain outside the diff. The final release refresh still points to
`d2369845a`; no intervening relevant change needed integration.

| Outcome | Baseline | Candidate |
|---|---:|---:|
| Public library non-task curate abstention, keyword and hybrid | 1/25 | 5/25 |
| Public library no-answer curate abstention, both modes | 0/10 | 0/10 |
| Public keyword task ref lists, library + books | reference | all identical |
| Library keyword useful-task nDCG / recall (rescored) | 0.7566 / 0.7429 | identical |
| Books keyword nDCG / recall (rescored) | 0.8352 / 0.9369 | identical |
| Library semantic-curate nDCG / recall (rescored observation) | 0.8161 / 0.8087 | 0.8192 / 0.8081 |
| Books semantic-curate nDCG / recall | 0.9027 / 0.9877 | identical |
| Books banned above useful: keyword / semantic curate | 12/51 / 8/51 | identical |
| Fresh final non-task abstention, both modes | 0/4 | 4/4 |
| Fresh final answerable jobs: success / useful recall | 6/6 / 1.0 | identical |
| Fresh explicit two-document questions: all evidence present | 2/2 | 2/2 |

Only n12 (`ok sounds good, go ahead`), n13 (`hey, are you still there?`),
n17 (`thanks, that worked!`) and n22 (`good morning! ready when you are`) change
in the complete public keyword comparison: curate returns zero instead of ten
irrelevant recommendations. Search results remain identical for every input.
No answerable public or final task falsely abstains in either mode. Final greeting
and acknowledgment prefixes followed by task text retain useful answers. Final
current/historical/empty-scope and packed-content assertions also pass on the
installed package. These finite cases do not establish universal false-abstention
rates or complete evidence coverage on arbitrary questions.

[Results](results.json) contains summary metrics and every changed task outcome,
including the observed semantic recall losses. [The evidence archive](evidence.tar.gz)
contains raw and rescored final public samples/summaries, final synthetic corpus
and outputs, label additions, same-index diagnostics, fixed-vector replay,
installed observations, default packing/cost observations and reproducing scripts.
Only final evidence and decisive diagnostics are retained here, not every
exploratory log. [Provenance](provenance.json) pins exact source, compiled and
installed-package fingerprints; the package version alone cannot distinguish builds.

### Negative signals, judging and uncertainty

No semantic ranking gain is attributed to this patch. Observed library useful
recall losses: q008 search 0.6→0.4; q020 search/curate 0.8571→0.7143; q059
search/curate 0.6667→0.3333; q088 search 1.0→0.8571. Task success@5 is unchanged
(98/101 keyword, 99/101 semantic; books 51/51 and 50/51).

The compatible same-index control alternated baseline/candidate twice each on
q008/q020/q059/q061/q088, 20 calls, zero errors, identical physical index hash
before/after. q020, q061 and q088 match across both builds on that index. q059
reverses the original apparent regression: baseline 0.3333, candidate 0.6667.
q008 initially remains split between builds, so it received a narrower diagnostic:
four exact identical embedding requests return different vectors; replay each
captured response through both builds against the same index and **all four
paired result lists match**. This explains a query-service contribution rather
than dismissing the first difference as noise. The source trees differ in only
the precheck file; actual task text/request bodies are unchanged. Independent
index embeddings can also vary. This supports no introduced retrieval regression
in the inspected cases; it does not prove service determinism or global stability.

Reviewed the newly surfaced symmetric result pools from BOTH public arms under
the existing 0–3 rubric: 22 library + 3 books additions, no old grade changed.
Explicitly rescored all eight saved public results folders (keyword-only and
keyword+hybrid for each build/collection). Corrected label provenance to the
existing `assetSha256` helper and rescored again; final folders end `-rescored-2`.
The original outputs remain in the archive. Added relevant evidence changes the
scoring denominators, so do not subtract the fresh raw baseline numbers above
from the final rescored candidate. Unchanged unjudged semantic pairs remain unknown:
judged@10 is 82.87% library curate and 85.10% books curate. The scorer's ordinary
nDCG gives no gain for unknowns; that is a scoring limitation, not an assessment
that they are irrelevant. Acceptance rests on demonstrated social abstention,
unchanged keyword useful outputs, final controls and explained semantic variation.

### Cost, settings and completion

The actual shipped-default check omitted semantic mode, embedding timeout,
reranker and belief overrides. It reports keyword for task retrieval. In a
4000-token pack budget, three social inputs fall from 2625 / 4000 / 3845 estimated
payload tokens to zero. Three observations per input: baseline social median CLI
latencies 274–283ms, candidate 216–220ms. The positive table-layout query retains
its identical 4000-token packed output (315ms versus 275ms median); unsupported
Terraform still packs the same misleading 3116 tokens (278ms versus 274ms).
These small sequential timings include CLI startup and host load; no general
speedup claim. Token estimates are chars/4, not billed input tokens or dollars.

Matched keyword sandboxes explicitly disable semantics. Hybrid uses the owner's
approved remote Qwen `embed/qwen3-embedding-0.6b`, 1024 dimensions, 600000ms
query/index timeout, no reranker. Every actual semantic call reports semantic,
zero fallbacks/errors/timeouts. Cold preflight semantic indexing: 14.5s library,
5.7s books; candidate cold indexing 9.9s/5.6s. Baseline full hybrid reuses its
preflight indexes (0.2s/0.3s cache validation). Warm CLI semantic-curate medians
library 0.32→0.29s, books 0.32→0.28s; sequential load differences prevent causal
speed claims. No indexing or embedding-cost change for tasks. A matched social
turn avoids its query embedding, evidence reads and packing. No answer/judge LLM
runs; lab embedding billing is unmetered here, so no dollar-savings claim.

All four full public collections complete 187/187 cases, zero errors/timeouts;
two fresh-final collections complete 11/11 cases, zero errors/timeouts. Three
preflights completed (keyword-only, hybrid, local stub). Nine retrieval collector
invocations (eight completed and one early missing-dependency setup failure),
including both final runs, plus local diagnostics/default/install
checks; collection fits the 90-minute/16-invocation bound. Two approaches counted,
including the earlier rejected name-weight experiment; no third treatment needed.
No-answer/log abstention, factual truth and general ranking remain imperfect.

### Verification and truthful rollout state

- `bunx biome check --write src/ tests/`: pass; production source then frozen.
- `bun run check`: lint/typecheck pass; **7217 unit + 3888 integration pass**,
  zero failures; 4/81 existing explicit skips.
- `bun run build`: pass; compiled and installed precheck hashes match.
- Focused curate/rerank/scope/support/packing controls: 38 pass, zero failures.
- Uniquely named tarball installed in a fresh directory; eight installed cases,
  Bun/Node public API byte parity, and actual installed bin launcher social,
  useful-task and explicit historical checks pass.
- Existing baseline scope/evidence contracts remain exercised by full checks;
  fresh final corpus retains both required documents, stale filtering and symptom
  retrieval. No broader agent/answer benchmark answers an unresolved claim here.

Measured source → submitted source: no production changes after the selected
formatted source; only this evidence/documentation finalization. Earlier full
checks and final retrieval/install observations therefore validate the submitted
behavior. The evaluator itself needs no public harness change or separate PR;
its semantic profile and case/label additions are private run inputs retained
in the artifact. The first same-index diagnostic used the wrong DB pathname and
made zero queries; it was repaired before valid observations. Initial environment
failures and auto-review denial were not quality samples; the user explicitly
approved public/synthetic lab egress before hybrid collection.

Ready for rollout after review. Release maintainer owns merge/publication and
post-release observation of real false abstention, useful recall, fallback,
packing and latency. No merge, deployment, automatic issue closure or recurring
monitor was performed. Standalone names such as `hello` may also be deliberate
lookup requests; use `akm search` for that investigation. This narrow English
precheck intentionally does not try to infer tasks from conversation history.
