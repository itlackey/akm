---
description: Resumable workflow for running a deep-research / auto-research agent that plans the investigation, recursively explores spawned subtopics, writes validated outputs into a wiki, and only promotes cited findings into final reports and pages.
tags:
  - example
  - research
  - deep-research
  - auto-research
  - agents
params:
  question: "Primary research question or decision to support."
  audience: "Intended reader and decision context (for example: founder deciding build vs buy, engineer evaluating frameworks, analyst writing a market brief)."
  scope: "Boundaries, exclusions, geography, time horizon, and quality bar."
  deliverable_path: "Output report path. Defaults to .akm-run/{{ runId }}/report.md."
  workspace_dir: "Directory for run artifacts. Defaults to .akm-run/{{ runId }}."
  trusted_domains: "Optional JSON array of domains to prioritize or restrict to."
  seed_urls: "Optional JSON array of URLs to ingest before broad web search."
  min_primary_sources: "Minimum count of primary or official sources to cite. Defaults to 5."
  max_iterations: "Maximum evidence-gathering rounds before synthesis. Defaults to 8."
  wiki_name: "Optional AKM wiki name to write articles into. Defaults to research when wiki publishing is enabled."
  max_topic_depth: "Maximum recursive subtopic depth. Defaults to 3."
  max_topic_branches: "Maximum child topics to spawn from one topic before forcing prioritization. Defaults to 5."
---

# Workflow: Deep Research Auto Research

This workflow encodes the common pattern shared across modern deep-research
systems and Karpathy-style auto-research loops:

- Start with a concrete objective and an explicit plan.
- Run a repeated search or tool-use loop that updates the plan from observed
  evidence.
- Expand into deeper subtopics only when they materially improve the answer,
  then fold those results back into the parent question.
- Keep an auditable source map and preserve citations for every non-trivial
  claim.
- Seek disconfirming evidence, not only supporting evidence.
- Only promote findings that survive validation into the final report and wiki.

The workflow is intentionally resumable. Every step writes artifacts under
`workspace_dir` so a later session can continue without reconstructing context.

## Step: Frame the research brief
Step ID: frame-brief

### Instructions
Translate the user request into an operational brief before gathering sources.

Create `{{ workspace_dir }}/brief.md` with these sections:

1. `Question` - the exact research question in one sentence.
2. `Audience` - who will read the report and what decision they need to make.
3. `Scope` - what is in scope, out of scope, time horizon, geography, and any
   hard constraints.
4. `Deliverable` - what the final output must contain.
5. `Known unknowns` - missing definitions, ambiguous terms, or assumptions that
   could invalidate the run if left unresolved.
6. `Success rubric` - 4 to 8 bullets defining what a good answer must prove.

If the prompt is too vague, stop and ask focused clarification questions before
 proceeding. Do not start broad browsing on an underspecified topic.

Resolve defaults:

- `workspace_dir` -> `.akm-run/{{ runId }}` when omitted.
- `deliverable_path` -> `{{ workspace_dir }}/report.md` when omitted.
- `min_primary_sources` -> `5` when omitted.
- `max_iterations` -> `8` when omitted.
- `wiki_name` -> `research` when omitted and wiki publication is desired.
- `max_topic_depth` -> `3` when omitted.
- `max_topic_branches` -> `5` when omitted.

### Completion Criteria
- `brief.md` exists and captures question, audience, scope, deliverable, known
  unknowns, and success rubric.
- Any blocking ambiguities are either resolved or explicitly recorded.
- Output paths, wiki target, and iteration/source/depth defaults are recorded.

## Step: Build the research plan
Step ID: build-plan

### Instructions
Produce a plan before deep collection begins. This mirrors the plan-first
behavior described by commercial deep-research systems and keeps the run from
devolving into open-ended browsing.

Create `{{ workspace_dir }}/plan.md` with:

1. `Subquestions` - 4 to 10 subquestions whose answers jointly resolve the
   main question.
2. `Evidence needs` - for each subquestion, define what evidence would count as
   primary, secondary, anecdotal, or insufficient.
3. `Search strategy` - initial queries, candidate official sources, candidate
   contrarian sources, and likely file types to inspect (HTML, PDF, repos,
   benchmarks, filings, docs).
4. `Failure modes` - where rumor, vendor bias, outdated docs, SEO spam, or
   benchmark cherry-picking are likely.
5. `Stop conditions` - when the run has enough evidence to synthesize.
6. `Topic frontier policy` - the rules for when to spawn child topics, how deep
   recursion may go, and when a topic is considered saturated.

If `trusted_domains` is provided, record how it will be used:

- `prioritize` when it is guidance only.
- `restrict` when the user explicitly asked for trusted or authenticated
  sources only.

If `seed_urls` is provided, list them under `Starting corpus` and inspect them
before running broad search.

### Completion Criteria
- `plan.md` exists with subquestions, evidence needs, search strategy, failure
  modes, and stop conditions.
- Trusted-domain and seed-URL policy is recorded when provided.
- The plan is concrete enough that another agent could execute it without
  guessing intent.

## Step: Initialize the recursive topic frontier
Step ID: init-topic-frontier

### Instructions
Set up the recursive search structure explicitly instead of letting topic
expansion happen implicitly in the model's scratch space.

Create `{{ workspace_dir }}/frontier.md` with one row or bullet per topic using
these fields:

- `topic`
- `parent_topic` (`root` for the original question)
- `depth`
- `why_it_matters`
- `status` (`open`, `exploring`, `saturated`, `deferred`, `rejected`)
- `priority`
- `entry_queries`
- `exit_condition`

Seed the frontier with:

- the root question at depth `0`
- each major subquestion from `plan.md` at depth `1`

Topic-spawn rules:

- Spawn a child topic only when it is necessary to resolve a gap, contradiction,
  or high-value branch of the parent topic.
- Do not exceed `max_topic_depth`.
- Do not create more than `max_topic_branches` children from one parent without
  first ranking and pruning them.
- Reject branches that are interesting but non-material to the user's question.

The frontier is the authoritative queue for recursive search. Update it every
time a topic is opened, saturated, deferred, or rejected.

### Completion Criteria
- `frontier.md` exists with the root topic and first-wave subtopics.
- Every topic has depth, priority, status, entry queries, and exit condition.
- Recursive expansion rules are explicit and bounded.

## Step: Create the source map
Step ID: create-source-map

### Instructions
Set up a durable evidence ledger before synthesis. The final report should be a
projection of this ledger, not a fresh free-form generation.

Create `{{ workspace_dir }}/sources.md` as a running source map. Each source
entry must capture:

- URL or canonical identifier
- title
- source type: official docs, repo, paper, benchmark, filing, blog, news,
  forum, dataset, code
- publisher or owner
- publication or last-updated date when available
- stance: primary, secondary, or tertiary
- relevance to subquestions
- trust notes: incentives, likely bias, and freshness risks
- claim snippets or observations already extracted from the source

Prefer primary material first: official documentation, source repositories,
papers, filings, benchmark docs, and first-party announcements. Use secondary
coverage mainly to discover leads or external reactions.

If a website or documentation corpus will be referenced repeatedly and the
environment supports it, add it as an AKM website source so subsequent lookups
are reproducible:

`akm add <url> --name <short-name> --provider website`

Then use `akm search` or `akm show` against the cached source instead of
re-fetching pages ad hoc.

### Completion Criteria
- `sources.md` exists and already includes the starting corpus and first-wave
  source candidates.
- Every source has type, stance, freshness, and trust notes.
- The run has a durable place to accumulate evidence without losing provenance.

## Step: Run the iterative evidence loop
Step ID: iterative-evidence-loop

### Instructions
Execute the core deep-research loop. This step is intentionally re-enterable and
should stay active across multiple rounds until the stop conditions in
`plan.md` are met, all material topics in `frontier.md` are saturated, or
`max_iterations` is reached.

For each round `k`, create or append to `{{ workspace_dir }}/iterations.md`
using this structure:

1. `Goal for round k` - which frontier topic, subquestion, or gap is being
   attacked.
2. `Actions taken` - searches run, URLs opened, repos inspected, files parsed,
   or tools invoked.
3. `Observations` - concrete claims, numbers, definitions, dates, and direct
   contradictions discovered.
4. `Plan updates` - new queries, dropped leads, refined hypotheses, and topic
   status changes.
5. `Promotions` - claims strong enough to move into `findings.md`.
6. `Rejections` - claims rejected for weak sourcing, stale evidence, or
    contradiction.

For each round:

- Select the highest-priority `open` topic from `frontier.md`.
- Mark it `exploring` while it is active.
- Search both directly for the topic and recursively for its enabling context,
  dependencies, benchmarks, definitions, competing approaches, and recent
  developments.
- When evidence reveals material child topics, add them to `frontier.md` with a
  parent pointer and incremented depth, subject to the depth and branching
  limits.
- When the topic's exit condition is met, mark it `saturated`.
- When the topic proves non-material, low-trust, or redundant, mark it
  `deferred` or `rejected` with a reason.

Recursive-search rule:

- Keep descending while each deeper topic improves the answer quality or reduces
  uncertainty.
- Stop descending when the next branch would be merely interesting rather than
  decision-relevant, when the sources become too weak, or when
  `max_topic_depth` is reached.

Maintain `{{ workspace_dir }}/findings.md` as the promoted-claims ledger.
Promote a claim only when all of the following hold:

- The claim materially matters to the user question.
- The claim has at least one citation to a primary or otherwise authoritative
  source.
- The claim text is specific enough to verify later.
- The source is recent enough for the domain, or the claim is explicitly marked
  historical.

This is the ratchet rule adapted from auto-research: only validated progress is
allowed to accumulate. Do not let speculative notes silently become findings.

Terminate the loop early when the stop conditions are satisfied. If
`max_iterations` is reached first, move forward but record the residual gaps.

### Completion Criteria
- `iterations.md` shows at least one complete observe-and-update round.
- `frontier.md` shows topic states changing as recursive research progresses.
- `findings.md` contains only promoted claims with traceable sources.
- Rejected or stale claims are explicitly separated from promoted findings.
- Either the stop conditions are met or residual gaps are recorded after the
  final allowed iteration.

## Step: Challenge the current story
Step ID: challenge-story

### Instructions
Run a deliberate disconfirmation pass before drafting the report. Commercial
deep-research products emphasize synthesis across many sources; this workflow
adds an explicit adversarial pass so the report does not merely mirror the first
coherent narrative found online.

Create `{{ workspace_dir }}/contradictions.md` with three sections:

1. `Direct contradictions` - claims that disagree on facts, metrics, dates,
   rankings, or definitions.
2. `Hidden assumptions` - where two sources appear to agree but use different
   populations, time ranges, benchmarks, or definitions.
3. `Missing evidence` - questions still answered only by inference.

For every important claim in `findings.md`, try to locate at least one of:

- a corroborating independent source
- a disconfirming source
- a reason no independent source is available

Downgrade, qualify, or remove findings that fail this pass. If a point remains
ambiguous, keep it in the report only with explicit uncertainty language.

### Completion Criteria
- `contradictions.md` exists with direct contradictions, hidden assumptions, and
  missing evidence.
- Major findings have corroboration, disconfirmation, or an explicit note that
  none was available.
- Any downgraded or removed claims are reflected back into `findings.md`.

## Step: Synthesize the report
Step ID: synthesize-report

### Instructions
Write the final report to `{{ deliverable_path }}` from the validated artifacts,
not from memory. The report should be structured so a reader can separate
conclusions, evidence, and uncertainty.

Required report sections:

1. `Executive summary` - 5 to 10 bullets answering the user's question.
2. `Method` - what was searched, how sources were chosen, and major limits.
3. `Findings by subquestion` - one section per subquestion from `plan.md`.
4. `Disconfirming evidence and caveats` - the strongest counterpoints or
   unresolved ambiguity.
5. `Decision implications` - what the findings mean for the audience's
   decision.
6. `Open questions` - what would require more time, paid data, or direct
   experiments.
7. `Sources` - source list or footnotes sufficient to trace every major claim.

Every non-trivial factual claim must carry a citation marker or direct source
reference. If the environment can render inline hyperlinks, use them. If not,
use numbered references tied to the source map.

Write with calibrated confidence. Use explicit uncertainty language when the
evidence base is mixed, stale, or sparse.

### Completion Criteria
- The report exists at `deliverable_path`.
- The report answers the original question for the stated audience.
- Every major claim is traceable to sources captured during the run.
- Counterevidence and uncertainty are surfaced, not buried.

## Step: Write and ingest wiki articles
Step ID: write-and-ingest-wiki

### Instructions
Turn the validated research into reusable wiki pages so future runs can start
from accumulated knowledge instead of the open web alone.

Resolve the target wiki:

- If `wiki_name` is provided, use it.
- Otherwise default to `research`.
- If the wiki does not exist, create it with `akm wiki create {{ wiki_name }}`.

Before editing pages, run `akm wiki ingest {{ wiki_name }}` and follow the
printed ingest recipe for that wiki.

Write at least these wiki pages:

1. A main article for the overall question or decision.
2. One page for each major topic that survived the recursive frontier and is
   substantial enough to stand alone.
3. Optional pages for recurring entities, frameworks, benchmarks, or concepts
   discovered during the run.

Each wiki page should:

- live under `wikis/{{ wiki_name }}/`
- include frontmatter with at least `description`, `pageKind`, `xrefs`, and
  `sources`
- summarize the validated findings rather than dumping raw notes
- link to related pages in both directions where appropriate
- cite the relevant raw sources or research artifacts

Stash the durable research artifacts under the wiki's `raw/` directory using
`akm wiki stash {{ wiki_name }} <source>` for materials worth preserving, such
as:

- the final report
- the source map
- high-value external notes or extracted markdown
- topic-specific briefs when they contain unique evidence

Then:

- update `log.md` with the ingest summary, source slugs, and touched pages
- run `akm index` so `index.md` is regenerated
- run `akm wiki lint {{ wiki_name }}` and fix any findings
- run `akm wiki search {{ wiki_name }} "<core terms>"` to confirm the pages are
  searchable

### Completion Criteria
- The target wiki exists and has the new or updated pages.
- Relevant raw artifacts have been stashed under `wikis/{{ wiki_name }}/raw/`.
- New pages include required frontmatter, xrefs, and sources.
- `akm index` and `akm wiki lint {{ wiki_name }}` complete without unresolved
  findings.
- The research is now discoverable through wiki search, not only the run
  workspace.

## Step: Audit and package the run
Step ID: audit-and-package

### Instructions
Perform a final audit so the run can be resumed, reviewed, or reused as a
knowledge asset.

Create `{{ workspace_dir }}/audit.md` that checks:

- Citation coverage: no major claim without a source.
- Freshness coverage: stale sources are either justified or flagged.
- Source balance: the run did not rely entirely on one vendor or one article.
- Reproducibility: key URLs, cached refs, and artifact paths are recorded.
- Recursive coverage: the frontier was expanded only where decision-relevant and
  the stopped branches have explicit reasons.
- Wiki publication: created or updated pages, raw slugs, and lint status are
  recorded when wiki output was produced.
- Remaining gaps: unresolved questions and what tool or source would close them.

If the result is worth keeping as reusable AKM knowledge, save the final report
or the source map into a stash knowledge asset and index it. If the result is a
repeatable operating procedure for a domain, evolve this workflow rather than
relying on ad hoc prompts.

### Completion Criteria
- `audit.md` exists and explicitly checks citations, freshness, source balance,
  reproducibility, recursive coverage, wiki publication, and remaining gaps.
- The workspace contains `brief.md`, `plan.md`, `frontier.md`, `sources.md`,
  `iterations.md`, `findings.md`, `contradictions.md`, the final report, and
  `audit.md`.
- Another agent could resume, review, or reuse the run without replaying the
  original conversation.
