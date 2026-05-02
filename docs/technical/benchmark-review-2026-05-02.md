# Benchmark Framework Critical Review — 2026-05-02

**Scope:** Critical review of `tests/benchmark-suite.ts`, the scoring pipeline it
exercises, supporting unit tests, and the `docs/technical/benchmark.md`
proposal. Pairs each finding with current research on agent-tooling
evaluation (memory, long-horizon tasks, tool selection, knowledge bases,
self-evaluation) so akm can prove and measure its effectiveness against
established benchmarks.

**Reviewer context:** Read of `tests/benchmark-suite.ts` (1,678 lines),
`src/indexer/db-search.ts` (1,043 lines), `src/indexer/db.ts` (1,093 lines),
`tests/db-scoring.test.ts`, `tests/ranking-regression.test.ts` (643 lines),
`tests/scoring-pipeline.test.ts` (847 lines), `docs/technical/benchmark.md`
(680 lines, status: proposal), and `.github/workflows/ci.yml`.

---

## Executive Summary

The current benchmark framework is a useful **first-generation harness** —
it covers the right axes at a high level (search quality, search
performance, indexing, token efficiency, utility scoring, feature
correctness), but it has **logic bugs in the most important scenario**
(utility re-ranking), no statistical rigor, no CI integration, no
regression baseline, and silently disables the production-default search
mode (hybrid FTS + vector). It also does not exercise several pillar
features (wiki, workflows, memory/vault, graph boost).

The good news: every gap maps cleanly onto a published 2024–2026
benchmark. Adopting their methodologies (LongMemEval, MCP-Bench,
τ³-Bench, METR time-horizons, Agent-as-a-Judge, BEIR statistical
hygiene) would let akm produce defensible, comparable, headline metrics.

**Top 3 fixes to do first:**
1. Fix the utility-scoring scenario assertions — today they would pass
   even if utility re-ranking was disabled entirely.
2. Commit a baseline JSON and gate CI on regressions.
3. Enable the hybrid (FTS + vector) search path in the perf scenario.

---

## Part 1 — Logic Issues in Current Metrics

### 1.1 Utility-scoring scenario does not validate the boost (HIGH severity)

`tests/benchmark-suite.ts:1063-1256` is structured as four sub-tests but
none of them prove utility re-ranking actually changes results.

- **Test 2 (`:1094-1131`)** creates synthetic usage events, recomputes
  utility, and asserts the `utility` column is populated. It never
  re-runs `akmSearch` to confirm ranks shifted.
- **Test 3 (`:1134-1186`)** ("decay works") only diffs `last_used_at`
  timestamps. It does not verify that a recently-used asset out-ranks an
  identically-FTS-scored old asset.
- **Test 4 (`:1189-1236`)** ("cap works") sets utility = 100.0 and
  asserts the score ratio stays under **10×**. The actual cap is
  **1.5×** (`src/indexer/db-search.ts:529`). The threshold is roughly
  6× too loose.

**Consequence:** A PR that disables utility re-ranking entirely, or
removes the cap, would still pass this scenario.

**Fix:** Compare ranks between two `akmSearch` calls — one against a
fresh index, one after seeding usage events. Tighten the cap assertion
to `ratio <= 1.5 + epsilon`.

---

### 1.2 Hardcoded scoring constants with no sensitivity sweep

`src/indexer/db-search.ts` mixes a stack of magic numbers:

| Constant                        | Location | Value      |
|---------------------------------|----------|------------|
| FTS / vector blend weights      | `:323-324` | 0.7 / 0.3 |
| Per-feature additive boosts     | `:325-435` | 0.15–2.0 |
| `MAX_BOOST_SUM`                 | `:325`   | 3.0        |
| Recency decay λ                 | `:530`   | 30 days    |
| Utility weight                  | `:528`   | 0.5        |

None are config-driven. None are A/B tested. There is no ablation
scenario in the suite — removing the graph boost or halving the
type-relevance multiplier (`:428-435`, skill: 0.4 → knowledge: 0) would
not surface as a regression. This violates the spirit of the
"one scoring pipeline" rule in CLAUDE.md because the pipeline is
effectively a frozen combination of unverified weights.

**Fix:** Add an "ablation" scenario that disables each boost in turn and
records the ΔMRR / ΔnDCG. Persist results across runs to detect drift.

---

### 1.3 The boost cap interacts incorrectly with utility

Boosts are clamped at `MAX_BOOST_SUM = 3.0` **before** the multiplicative
utility factor (up to 1.5×) is applied (`:520-529`). The effective
maximum amplification is **4.5×**, not the 3.0× implied by the constant
name. Either the cap should be applied post-utility or the constant
should be renamed and documented. The benchmark never measures
end-to-end amplification, so this discrepancy is invisible.

---

### 1.4 Search-quality scenario is statistically meaningless

`benchmark-suite.ts:614-785` runs **15 fixed queries against 35 synthetic
assets** and reports MRR / Recall@5 / Recall@10 as **point estimates**
with no standard deviation, no bootstrap CI, and no held-out set. Adding
a single query shifts mean MRR by ~6.7%. The pass condition (`MRR >=
0.7`, Recall@5 high enough) is hard-coded with no documented
justification.

Modern IR practice (BEIR's "Brewing BEIR" reference resources, SIGIR'24)
explicitly recommends paired bootstrap with 95% CIs for two-system
comparisons. Without that, "MRR went 0.91 → 0.86 between PRs" is
indistinguishable from sampling noise.

**Fix:**
- Expand to ≥100 queries across difficulty bands.
- Switch the headline metric from MRR to nDCG@10 (handles graded
  relevance — see §1.5).
- Report mean ± 95% bootstrap CI on per-query scores.
- Add held-out queries that nobody tunes against.

---

### 1.5 Underspecified "correct" answers

The query `"deploy"` (`:706`) targets `k8s-deploy` at rank 1, but the
inline comment admits "Both are valid top results." MRR with a single
gold doc penalises legitimate near-matches and rewards arbitrary
tie-breakers. The same problem appears in several other queries that
have multiple plausible matches.

**Fix:** Replace single-doc gold with **graded relevance qrels**
(0=irrelevant, 1=related, 2=relevant, 3=ideal) per the BEIR / TREC
convention. Use nDCG@10 instead of MRR. This also unlocks graded
LLM-as-judge scoring (see §2.6).

---

### 1.6 Silently-skipped assertions

Two scenarios short-circuit when input conditions are unmet, so the
test passes trivially when something is broken upstream:

- **Field weighting fc-02 (`:1290-1323`)** — if either name-match or
  description-only group is empty (e.g. because the index failed to
  populate), the assertion at `:1310` is bypassed.
- **Fuzzy-match fc-01 (`:1274`)** — confirms `"certb"` finds
  `ssl-renew` but never asserts irrelevant assets are excluded. A
  regression that returns the entire corpus on misspellings would pass.

**Fix:** Convert "skip when empty" branches into explicit assertion
failures. Add negative-relevance assertions to fuzzy-match tests.

---

### 1.7 Performance scenario blind spots

`:787-859` measures latency at the **mean** only — no P95 / P99, no
jitter analysis, no warmup discipline. `semanticSearchMode: "off"` is
hard-coded at `:1533`, which means the **production-default hybrid
(FTS + vector) path is never exercised in any scenario**. Indexing perf
(`:861-944`) includes an "incremental" case where nothing changed
(`:895`), which times the no-op fast path; the upsert / re-embed hot
path is untested. There is no measurement of memory residency, peak
RSS, or DB-file growth.

**Fix:**
- Report P50 / P95 / P99 with min N=20 runs per measurement.
- Add a hybrid-mode scenario (`semanticSearchMode: "auto"`).
- Add an "indexing 35 → 70 → 200 assets" scaling scenario.
- Snapshot `process.memoryUsage()` and DB file size before/after each
  workload.

---

### 1.8 Token-efficiency is synthetic

`:946-1061` measures **bytes of JSON output** as a proxy for token cost.
Bytes are not tokens. Tokenizers vary (Claude vs GPT-4 differ ~15% on
typical prose), and code-heavy assets tokenize very differently from
prose. The current scenario also doesn't test real agent behaviour — it
serializes outputs and counts characters, not tokens consumed by an
agent across an actual install/search/show loop.

**Fix:** Use a real tokenizer (e.g. `@anthropic-ai/tokenizer` or
`tiktoken`) and report tokens, not bytes. Bonus: simulate a 5-step agent
loop (`search → show → install → re-search → run`) and report total
token cost with vs without `--for-agent` summary mode.

---

### 1.9 Track B (evolution loop) is design-only

`docs/technical/benchmark.md` (680 lines, dated 2026-04-27) describes a
distill → reflect → propose → accept loop and an `improvement_slope`
metric. None of it is implemented. This is fine as a roadmap, but the
benchmark suite's output should declare which scenarios are
implemented vs proposed so consumers don't believe self-improvement is
being measured.

---

### 1.10 No CI integration, no baseline, no regression gate

`.github/workflows/ci.yml` runs `bun run check` only. The benchmark
suite is **manual** — no scheduled job, no PR gate, no comparison
against a stored baseline. `benchmark-compare.sh` is referenced in
CLAUDE.md but not wired in. There is no committed `baseline.json`, so
every run is a single point in time.

This is the single biggest organisational gap. Without it, none of the
metrics can answer the question "did this PR regress search quality?".

**Fix:**
- Commit `tests/fixtures/benchmark-baseline.json` with current numbers.
- Add a workflow that runs the suite and diffs against the baseline.
- Fail the job on any metric regression beyond a documented threshold
  (e.g. ΔMRR > 0.02 with p < 0.05; Δlatency > 10%; Δtokens > 5%).
- Schedule a nightly run on `main` to track long-term drift.

---

### 1.11 Untested or under-tested features

| Feature                        | Status                            |
|--------------------------------|-----------------------------------|
| Graph boost (`db-search.ts:506-517`, #207) | No benchmark query depends on it |
| Semantic / vector search        | Disabled in every scenario        |
| `wiki` commands                 | No benchmark scenario             |
| `workflow` (long-running)       | No benchmark scenario             |
| `remember` / vault              | No benchmark scenario             |
| Empty-query determinism (`:1462`) | Returns asserted; sort order not |
| sanitizeFtsQuery preservation   | Tested for safety, not for correctness on hyphens/underscores |

These are pillar features in CLAUDE.md and `package.json` — leaving
them unbenchmarked means refactors to those subsystems regress in the
field, not in CI.

---

## Part 2 — Research-Backed Additions

Each subsection pairs a published methodology with a concrete akm
scenario.

### 2.1 IR-quality rigor (BEIR / MTEB / InfoDeepSeek)

**Benchmarks:** [BEIR](https://arxiv.org/abs/2104.08663),
[MTEB](https://github.com/embeddings-benchmark/mteb),
[InfoDeepSeek](https://arxiv.org/html/2505.15872v1),
[Brewing BEIR (SIGIR'24)](https://dl.acm.org/doi/10.1145/3626772.3657862).

**What to adopt:**
- **Graded relevance qrels** per query (not single gold doc).
- **nDCG@10** as the headline retrieval metric, with Recall@100 as a
  recall-oriented secondary.
- **Paired bootstrap with 95% CIs** on per-query scores for any
  two-system comparison. Brewing BEIR publishes reference scripts.
- InfoDeepSeek query-design rubric: every query must satisfy
  *determinacy* (verifiable correct answer), *difficulty* (range from
  easy to hard), *diversity* (heterogeneous asset types).

**akm scenario:** Replace the 15 hand-written queries with ≥100 queries
labelled with graded relevance, split into in-domain and held-out.
Report mean ± CI, not point estimates.

---

### 2.2 Tool / skill selection (MCP-Atlas, MCP-Bench, MCPVerse, SkillsBench)

**Benchmarks:**
- [MCP-Atlas](https://arxiv.org/html/2602.00933) — 36 real MCP servers, 220 tools, claims-based rubric.
- [MCP-Bench](https://arxiv.org/pdf/2508.20453) — stress-tests retrieval precision with **distractor servers** (100+ extra tools per task).
- [MCPVerse](https://www.arxiv.org/pdf/2508.16260) — 65 MCPs, 552 tools.
- [SkillsBench](https://arxiv.org/html/2602.12670v1) — evaluates every task under both vanilla and Skills-augmented conditions.
- [MCPAgentBench](https://arxiv.org/html/2512.24565) — dynamic sandbox with distractors.

**Why this matters for akm:** akm's core job is "given a user intent,
retrieve the right skill / command / script / knowledge asset." That is
exactly the tool-selection problem these benchmarks formalize. The
field's documented dominant failure mode is **incorrect tool selection
in the presence of distractors** (per MCPAgentBench).

**akm scenarios to add:**
1. **Distractor corpus mode.** Inflate the test corpus to 500+ assets
   with semantically near-duplicate names (e.g. 10 different `deploy-*`
   skills) and re-measure nDCG@10. Today's 35-asset corpus has too few
   collisions to expose ranking weaknesses.
2. **Vanilla vs augmented (SkillsBench pattern).** Run a small set of
   agent tasks twice — once without `akm search`, once with — and
   measure task-success delta. This is the only scenario that proves
   akm produces value, not just internally consistent scores.
3. **Claims-based rubrics (MCP-Atlas pattern).** Replace
   "asset X must be at rank 1" with "the top-5 must contain *some asset
   that knows how to do Y*". Decouples grading from a specific gold doc.
4. **Failure-mode taxonomy.** Categorize misses: wrong-type,
   near-duplicate-misranked, no-result-when-result-exists, hallucinated
   asset, abstain-when-should-answer. Track per-category counts over
   time. Already promised in §6.6 of the Track B doc.

---

### 2.3 Long-horizon / long-running tasks (METR)

**Benchmarks:**
- [METR Time Horizons](https://metr.org/time-horizons/),
  [Measuring AI Ability to Complete Long Tasks](https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/),
  [arXiv 2503.14499](https://arxiv.org/html/2503.14499v1).

**Method:** For each model/system, fit a logistic curve of
success-vs-task-length. Report the **50% time horizon** — the human task
duration at which success probability crosses 50%.

**akm scenario:** Define 10–20 multi-step akm workflows with verifiable
success criteria (e.g. "install kit X → run search Y → write to
filesystem source → re-index → verify ref Z is reachable"). Vary task
length from minutes to hours. Run each task 5+ times, fit a logistic
curve, report the 50% horizon. Headline metric: "akm raises the agent
50% horizon by N minutes vs no-akm."

This is the metric that will resonate with the broader agent-tooling
community.

---

### 2.4 Memory / `remember` / vault (LongMemEval, LoCoMo, MEMTRACK)

**Benchmarks:**
- [LongMemEval (arXiv 2410.10813)](https://arxiv.org/pdf/2410.10813) — 500 questions across five capabilities: information extraction, multi-session reasoning, temporal reasoning, **knowledge updates**, abstention.
- [LoCoMo](https://snap-research.github.io/locomo/) — 35-session, 9k-token dialogues; single-hop, multi-hop, open-domain, temporal.
- [MEMTRACK (arXiv 2510.01353)](https://arxiv.org/pdf/2510.01353) — long-term memory and **state tracking** over time.

**akm scenarios to add:**
1. **Information extraction.** Write 50+ memory entries; query for facts
   stored verbatim. Verify recall.
2. **Multi-session synthesis.** Query for facts that require combining
   entries from two or more sessions. Verify the answer combines them.
3. **Knowledge update.** Store a fact, update it, query — assert the
   new value (not the old) is returned. **This dimension is the
   weakest in published memory systems and is currently untested in
   akm.**
4. **Temporal reasoning.** Store dated facts, query "what was true on
   date X" — verify the temporally correct entry is returned.
5. **Abstention.** Query for something never stored — verify no
   fabricated hit, verify graceful "not found" output.
6. **State tracking (MEMTRACK).** Apply to `vault`: write/update/delete
   secrets across simulated sessions; verify the vault's state is
   internally consistent.

---

### 2.5 Wiki management (τ³-Bench / τ-Knowledge)

**Benchmark:**
- [τ³-Bench / τ-Knowledge (Sierra)](https://sierra.ai/blog/bench-advancing-agent-benchmarking-to-knowledge-and-voice) — fintech KB of 698 documents, ~195k tokens, 21 categories. Tasks require search + reasoning + multi-step tool calls.

**akm scenarios to add:**
1. **Multi-hop wiki search.** Build a fixture wiki of ≥500 pages with
   cross-links. Author multi-hop questions ("what does page X say about
   Y, considering its link to Z"). Score with graded relevance.
2. **Lint validity.** Verify `wiki-lint` catches stale links, broken
   anchors, missing frontmatter, orphan pages.
3. **Ingest round-trip.** Verify `wiki-ingest` round-trips content
   without loss (byte-equivalent or AST-equivalent).
4. **Index sync.** Edit a page, verify FTS picks up the change in the
   next search without manual `akm index`.
5. **Knowledge update on the wiki.** Same idea as §2.4(3) — confirm
   updated content shadows old content.

---

### 2.6 Self-evaluation (Agent-as-a-Judge, LLM-as-meta-judge)

**Benchmarks / surveys:**
- [Agent-as-a-Judge (arXiv 2508.02994)](https://arxiv.org/html/2508.02994v1) — agents evaluating agents; up to 85% alignment with human judgement (vs 81% human-human).
- [A Survey on LLM-as-a-Judge (arXiv 2411.15594)](https://arxiv.org/html/2411.15594v6).
- [Rating Roulette: Self-Inconsistency in LLM-As-A-Judge (EMNLP 2025)](https://aclanthology.org/2025.findings-emnlp.1361.pdf) — single judges are unreliable; rotate.

**akm scenario:** Add an LLM-judge harness:
- After search returns top-k, an LLM judge labels each result as
  *relevant / partial / wrong* against the query.
- Use the labels to compute graded nDCG without manual qrel authoring.
- **Rotate judges across runs** (Claude Opus / Sonnet / Haiku;
  optionally a GPT-class model) and report inter-judge Cohen's κ.
- Anchor judge calibration with a small human-labelled gold set (e.g.
  20 queries) to detect judge drift.

This dovetails with Track B's "reflect" stage. Building the harness
now buys regression evaluation today and the foundation for the
evolution loop tomorrow.

---

### 2.7 Resource accounting

**Why it matters:** akm ships FTS5 + vectors over potentially 10k+
assets. RSS, peak heap, and SQLite page-cache footprint are first-order
concerns for users running it in CI or on small machines. None are
measured today.

**akm scenarios to add:**
- Peak RSS during full reindex (sample `process.memoryUsage()` every
  100ms during the run; report max).
- DB file size growth per 100 assets indexed.
- Token cost per `akm search --for-agent` call (real tokenizer count,
  not bytes — see §1.8).
- Re-embed cost when a single asset changes (vector path).

---

### 2.8 Statistical / methodological hygiene (cross-cutting)

Adopt these from established IR practice ([BEIR](https://arxiv.org/abs/2104.08663), [Brewing BEIR](https://dl.acm.org/doi/10.1145/3626772.3657862)):

- **Paired bootstrap** over per-query scores for two-system comparisons
  (B = 1000 resamples, 95% CI).
- **Held-out / cross-validation** splits — never report on the corpus
  the system was tuned on. Reserve 30% of queries as held-out.
- **Multiple seeds** on any LLM-judged scenario; report mean ± stddev
  across ≥3 seeds.
- **Effect-size + significance thresholds.** Don't treat any Δ as a
  regression; require Δ > 0.02 nDCG with paired-bootstrap p < 0.05.
- **Failure-mode dashboard** alongside scalar metrics.

---

## Part 3 — Prioritized Action List

### Critical (week 1)

1. **Fix the utility-scoring assertions** (§1.1). Compare actual ranks
   pre/post seeding usage; tighten the cap threshold to 1.5×.
2. **Commit `tests/fixtures/benchmark-baseline.json`** and wire
   `benchmark-compare` into a CI workflow that fails on regression
   beyond a documented threshold (§1.10).
3. **Enable hybrid (FTS + vector) mode in at least one perf scenario**
   (§1.7).

### High (weeks 2–4)

4. **Bootstrap CIs and graded relevance** in the search-quality
   scenario (§1.4–1.5, §2.1).
5. **Distractor-corpus stress test** (§2.2, MCP-Bench style).
6. **Memory / vault scenarios** modeled on LongMemEval's five
   capabilities (§2.4).
7. **Wiki scenarios** modeled on τ-Knowledge — lint, ingest round-trip,
   multi-hop search (§2.5).
8. **Real tokenizer in token-efficiency scenario** (§1.8).
9. **P95 / P99 latency reporting** with N≥20 runs per measurement
   (§1.7).

### Medium (weeks 4–8)

10. **LLM-as-judge harness** with a rotating panel and inter-judge
    agreement (§2.6).
11. **Memory / RSS / DB-size accounting** (§2.7).
12. **Long-horizon workflow scenario** with METR-style logistic fit
    (§2.3).
13. **Failure-mode taxonomy** with per-category dashboards (§2.2.4).
14. **Ablation scenario** that flips each boost in turn and records
    ΔnDCG (§1.2).
15. **Graph-boost test queries** that exercise issue #207's path (§1.11).

### Strategic (post-v1)

16. Implement Track B's evolution loop on top of #10 — the judge
    becomes the "reflect" stage.

---

## Sources

### akm internals (read for this review)

- `tests/benchmark-suite.ts`
- `src/indexer/db-search.ts`, `src/indexer/db.ts`
- `tests/db-scoring.test.ts`, `tests/ranking-regression.test.ts`,
  `tests/scoring-pipeline.test.ts`
- `docs/technical/benchmark.md` (Track B proposal)
- `.github/workflows/ci.yml`

### Research / benchmark citations

**Long-horizon agent evaluation**
- METR — [Measuring AI Ability to Complete Long Tasks](https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/)
- METR — [Time Horizons benchmark](https://metr.org/time-horizons/)
- arXiv 2503.14499 — [Measuring AI Ability to Complete Long Tasks](https://arxiv.org/html/2503.14499v1)

**Memory benchmarks**
- arXiv 2410.10813 — [LongMemEval](https://arxiv.org/pdf/2410.10813)
- [LoCoMo project page](https://snap-research.github.io/locomo/)
- arXiv 2510.01353 — [MEMTRACK](https://arxiv.org/pdf/2510.01353)
- arXiv 2507.05257 — [Evaluating Memory in LLM Agents via Incremental Multi-Turn Interactions](https://arxiv.org/html/2507.05257v3)

**Knowledge bases / wikis**
- Sierra — [τ³-Bench: Advancing agent evaluation to knowledge and voice](https://sierra.ai/blog/bench-advancing-agent-benchmarking-to-knowledge-and-voice)
- [Agentic AI Knowledge Base — Evaluation Reference Frameworks](https://agentic-ai.readthedocs.io/en/latest/EvaluationFrameworks/Readme/)

**Tool / skill selection**
- arXiv 2602.00933 — [MCP-Atlas](https://arxiv.org/html/2602.00933)
- arXiv 2508.20453 — [MCP-Bench](https://arxiv.org/pdf/2508.20453)
- arXiv 2508.16260 — [MCPVerse](https://www.arxiv.org/pdf/2508.16260)
- arXiv 2602.12670 — [SkillsBench](https://arxiv.org/html/2602.12670v1)
- arXiv 2512.24565 — [MCPAgentBench](https://arxiv.org/html/2512.24565)

**Information-seeking / RAG**
- arXiv 2505.15872 — [InfoDeepSeek](https://arxiv.org/html/2505.15872v1)
- arXiv 2407.11005 — [RAGBench](https://arxiv.org/abs/2407.11005)
- arXiv 2504.14891 — [RAG Evaluation Survey](https://arxiv.org/html/2504.14891v1)
- arXiv 2501.09136 — [Agentic RAG Survey](https://arxiv.org/html/2501.09136v4)

**LLM-as-judge / self-evaluation**
- arXiv 2508.02994 — [Agent-as-a-Judge](https://arxiv.org/html/2508.02994v1)
- arXiv 2411.15594 — [Survey on LLM-as-a-Judge](https://arxiv.org/html/2411.15594v6)
- EMNLP 2025 — [Rating Roulette: Self-Inconsistency in LLM-As-A-Judge](https://aclanthology.org/2025.findings-emnlp.1361.pdf)
- arXiv 2504.17087 — [LLMs as Meta-Judges](https://arxiv.org/html/2504.17087v1)

**Information retrieval baselines**
- arXiv 2104.08663 — [BEIR: A Heterogeneous Benchmark for Zero-shot IR](https://arxiv.org/abs/2104.08663)
- SIGIR 2024 — [Resources for Brewing BEIR: Reproducible Reference Models and Statistical Analyses](https://dl.acm.org/doi/10.1145/3626772.3657862)
- arXiv 2509.07253 — [Benchmarking IR Models on Complex Retrieval Tasks](https://arxiv.org/html/2509.07253v1)

**Compendia**
- [philschmid/ai-agent-benchmark-compendium](https://github.com/philschmid/ai-agent-benchmark-compendium) — 50+ agent benchmarks categorized.
