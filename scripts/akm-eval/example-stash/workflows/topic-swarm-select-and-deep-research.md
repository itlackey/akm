---
description: Swarm across many candidate topics, recursively map and score their branches, select the strongest topic for the user's goal, then transition into deep research and wiki publication using the same artifact model as the deep-research workflow.
tags:
  - example
  - research
  - topic-swarm
  - deep-research
  - wiki
  - agents
params:
  goal: "The higher-level objective to optimize for, such as finding the best article topic, market angle, research direction, or product opportunity."
  audience: "Who the final recommendation and deep-research report are for."
  scope: "Constraints, exclusions, domain boundaries, geography, time horizon, and quality bar."
  candidate_pool: "Optional JSON array of starting topics, hypotheses, niches, or search seeds."
  workspace_dir: "Directory for run artifacts. Defaults to .akm-run/{{ runId }}."
  deliverable_path: "Output report path for the final deep-research report. Defaults to .akm-run/{{ runId }}/report.md."
  wiki_name: "Optional AKM wiki name to publish the selected topic research into. Defaults to research."
  max_swarm_topics: "Maximum number of top-level topics to explore in the swarm. Defaults to 12."
  max_topic_depth: "Maximum recursive depth for swarm branch expansion or deep-research frontier expansion. Defaults to 3."
  max_topic_branches: "Maximum child topics to spawn from one node before forcing prioritization. Defaults to 5."
  max_iterations: "Maximum iterative rounds for the deep-research phase. Defaults to 8."
  min_primary_sources: "Minimum count of primary or official sources required in the deep-research phase. Defaults to 5."
  trusted_domains: "Optional JSON array of domains to prioritize or restrict to."
  seed_urls: "Optional JSON array of URLs to ingest before broad web search."
---

# Workflow: Topic Swarm Select And Deep Research

This workflow combines two modes of research that should reinforce each other:

- **Topic swarm** explores a broad space of possibilities, recursively mapping
  branches and scoring them against the user's goal.
- **Deep research** takes the highest-value topic from that swarm and executes a
  rigorous evidence loop with citations, contradiction checks, and wiki
  publication.

The key design rule is continuity of artifacts. The swarm does not throw work
away. It leaves behind a scored topic graph and evidence trail that become the
starting context for the deep-research phase.

## Step: Frame the objective and selection criteria
Step ID: frame-objective

### Instructions
Turn the user's request into a selection problem before exploring topics.

Create `{{ workspace_dir }}/brief.md` with:

1. `Goal` - the real objective behind the request.
2. `Audience` - who the answer is for and what decision they need to make.
3. `Scope` - boundaries, exclusions, geography, time horizon, and quality bar.
4. `Selection criteria` - 4 to 8 criteria that define what makes one topic
   better than another.
5. `Disqualifiers` - what should immediately eliminate a topic.
6. `Deliverable` - what the final recommendation and deep-research report must
   contain.

Resolve defaults:

- `workspace_dir` -> `.akm-run/{{ runId }}` when omitted.
- `deliverable_path` -> `{{ workspace_dir }}/report.md` when omitted.
- `wiki_name` -> `research` when omitted.
- `max_swarm_topics` -> `12` when omitted.
- `max_topic_depth` -> `3` when omitted.
- `max_topic_branches` -> `5` when omitted.
- `max_iterations` -> `8` when omitted.
- `min_primary_sources` -> `5` when omitted.

If the prompt is too vague to score topics, stop and ask clarifying questions
before the swarm begins.

### Completion Criteria
- `brief.md` exists with goal, audience, scope, selection criteria,
  disqualifiers, and deliverable.
- Defaults are resolved and recorded.
- The selection problem is concrete enough to rank topics against it.

## Step: Seed the swarm universe
Step ID: seed-swarm

### Instructions
Create the initial topic universe to explore.

Create `{{ workspace_dir }}/swarm-seeds.md` containing:

- the provided `candidate_pool`, if any
- topics derived from the goal and scope
- adjacent approaches, competing framings, and contrarian angles
- underserved or less obvious niches that still satisfy the objective

Then create `{{ workspace_dir }}/topic-graph.md` with one entry per seed topic:

- `topic`
- `parent_topic` (`root` at this stage)
- `depth`
- `hypothesis`
- `why_it_might_win`
- `status` (`open`, `exploring`, `scored`, `selected`, `deferred`, `rejected`)
- `priority`
- `entry_queries`
- `spawn_budget_remaining`

Cap the initial top-level candidate set at `max_swarm_topics` by ranking and
pruning weak seeds before broad exploration begins.

### Completion Criteria
- `swarm-seeds.md` exists with the candidate universe.
- `topic-graph.md` exists with the first ranked set of topics.
- The number of top-level topics is bounded by `max_swarm_topics`.

## Step: Run the recursive swarm exploration
Step ID: recursive-swarm-exploration

### Instructions
Explore the topic space recursively, but only as far as it improves topic
selection quality.

Create or append to `{{ workspace_dir }}/swarm-iterations.md` for each round.
For every explored topic, record:

1. `Topic explored`
2. `Why chosen now`
3. `Searches and sources consulted`
4. `Signals found` - evidence of audience demand, novelty, source richness,
   competitive landscape, strategic fit, difficulty, or monetizable relevance
5. `Child branches spawned`
6. `Topics rejected or deprioritized`
7. `Score updates`

Recursive swarm rules:

- Select the highest-priority `open` topic from `topic-graph.md`.
- Mark it `exploring` while active.
- Recursively branch into child topics only when the child would materially
  sharpen selection among candidates.
- Do not exceed `max_topic_depth`.
- Do not exceed `max_topic_branches` child topics per parent without first
  ranking and pruning.
- Reject branches that are interesting but fail the goal or selection criteria.

This is a discovery swarm, not the final deep-research loop. It should answer:

- Which topics are best aligned to the user's goal?
- Which have enough source depth to justify deep research?
- Which are differentiated enough to warrant a final report or article?

### Completion Criteria
- `swarm-iterations.md` records at least one full exploration round.
- `topic-graph.md` shows recursive branching, pruning, and status changes.
- Weak or non-material branches are explicitly rejected or deferred.
- The swarm has enough evidence to compare the surviving topics.

## Step: Score and select the winning topic
Step ID: score-and-select

### Instructions
Convert exploration into a decision.

Create `{{ workspace_dir }}/topic-scorecard.md` with one row per surviving
topic. Score each topic against the criteria from `brief.md`, for example:

- relevance to the goal
- audience fit
- evidence availability
- novelty or differentiation
- practical usefulness
- strategic upside
- risk of weak or stale sources

Then choose exactly one `selected_topic` unless the evidence is too weak to make
any recommendation. Record:

- why it won
- why the nearest alternatives lost
- what specific questions still need deep research
- the initial subquestions that the deep-research phase should inherit

Mark the winning topic as `selected` in `topic-graph.md`.

### Completion Criteria
- `topic-scorecard.md` exists and compares the surviving topics.
- Exactly one topic is selected, or the workflow blocks with a justified reason.
- The selected topic has inherited deep-research questions and rationale.

## Step: Build the deep-research handoff
Step ID: build-deep-research-handoff

### Instructions
Translate the winning topic into the artifact model used by the deep-research
workflow so the next phase can start without rethinking the problem.

Create these files from the selection output:

- `{{ workspace_dir }}/plan.md`
- `{{ workspace_dir }}/frontier.md`
- `{{ workspace_dir }}/sources.md`

`plan.md` must include:

- the selected topic as the main question
- the inherited subquestions from `score-and-select`
- evidence needs
- trusted-domain or seed-URL policy if provided
- stop conditions for deep research

`frontier.md` must include:

- the selected topic at depth `0`
- first-wave deep-research subtopics at depth `1`
- status, priority, entry queries, and exit conditions

`sources.md` must include:

- the best sources already discovered during the swarm
- trust notes and freshness notes
- why each source matters to the selected topic

This step is the synergy bridge: the swarm's outputs become the deep-research
inputs directly.

### Completion Criteria
- `plan.md`, `frontier.md`, and `sources.md` exist.
- The selected topic and inherited subquestions are encoded for deep research.
- The deep-research phase can start from swarm findings instead of from zero.

## Step: Run deep research on the selected topic
Step ID: run-deep-research

### Instructions
Now execute the same rigorous loop used in the standalone deep-research
workflow, but scoped to the selected topic and seeded from the swarm outputs.

Create or append to `{{ workspace_dir }}/iterations.md` and maintain
`{{ workspace_dir }}/findings.md`.

For each round:

- select the highest-priority `open` topic from `frontier.md`
- gather evidence, inspect primary sources, and update the source map
- recursively spawn child topics only when they materially reduce uncertainty or
  improve the answer
- promote only validated claims into `findings.md`
- reject weak, stale, or contradictory claims explicitly
- mark topics `saturated`, `deferred`, or `rejected` with reasons

Promote a claim only when all of the following hold:

- it materially matters to the selected topic
- it has at least one citation to a primary or otherwise authoritative source
- it is specific enough to verify later
- it is recent enough for the domain, or clearly marked historical

This is the ratchet rule: only validated progress accumulates.

Stop when the plan's stop conditions are met, all material topics are
`saturated`, or `max_iterations` is reached.

### Completion Criteria
- `iterations.md` records the deep-research rounds.
- `frontier.md` reflects recursive deep-research topic handling.
- `findings.md` contains only promoted, traceable claims.
- The selected topic now has evidence depth beyond the swarm phase.

## Step: Challenge the selected-topic narrative
Step ID: challenge-selected-topic

### Instructions
Run a deliberate disconfirmation pass on the winning topic before writing the
final report.

Create `{{ workspace_dir }}/contradictions.md` with:

1. `Direct contradictions`
2. `Hidden assumptions`
3. `Missing evidence`

For each important finding, attempt to locate corroboration, disconfirmation, or
an explicit reason no independent source exists. Downgrade or qualify findings
that do not survive this pass.

### Completion Criteria
- `contradictions.md` exists for the selected topic.
- Major findings have corroboration, disconfirmation, or an explicit gap note.
- Any downgraded claims are reflected back into `findings.md`.

## Step: Write the final report
Step ID: write-final-report

### Instructions
Write the final report to `{{ deliverable_path }}`.

Required sections:

1. `Recommendation` - the chosen topic and why it won.
2. `Why not the alternatives` - the strongest rejected candidates and why they
   lost.
3. `Method` - how the swarm and deep-research phases were run.
4. `Deep findings` - the validated findings for the selected topic.
5. `Disconfirming evidence and caveats`
6. `Decision implications`
7. `Sources`

Every non-trivial factual claim must be traceable to the evidence artifacts.

### Completion Criteria
- The report exists at `deliverable_path`.
- It explains both topic selection and deep-research findings.
- Major claims are traceable to sources and artifacts.

## Step: Publish into the wiki
Step ID: publish-into-wiki

### Instructions
Write the selected topic and its supporting concepts into the target wiki so the
swarm and deep-research outputs become reusable knowledge.

Resolve the target wiki:

- If `wiki_name` is provided, use it.
- Otherwise default to `research`.
- If the wiki does not exist, create it with `akm wiki create {{ wiki_name }}`.

Before editing pages, run `akm wiki ingest {{ wiki_name }}` and follow the
printed ingest recipe.

Write at least:

1. one main article for the selected topic
2. one page summarizing the swarm comparison and why this topic won
3. additional pages for major related concepts, entities, or frameworks that
   emerged during the run

Stash durable artifacts under `wikis/{{ wiki_name }}/raw/`, such as:

- the final report
- the topic scorecard
- the source map
- high-value extracted notes

Then:

- update `log.md`
- run `akm index`
- run `akm wiki lint {{ wiki_name }}` and fix findings
- run `akm wiki search {{ wiki_name }} "<selected topic>"` to confirm retrieval

### Completion Criteria
- The wiki contains the new or updated pages.
- Relevant raw artifacts are stashed under `raw/`.
- `akm index` and `akm wiki lint {{ wiki_name }}` complete without unresolved
  findings.
- The selected topic research is now reusable through wiki search.

## Step: Audit the combined run
Step ID: audit-combined-run

### Instructions
Create `{{ workspace_dir }}/audit.md` that verifies:

- the swarm explored enough breadth before selection
- recursive branching stayed bounded and decision-relevant
- the selected topic was chosen by explicit criteria rather than convenience
- deep research added evidence depth beyond the swarm phase
- citation coverage, freshness coverage, and source balance are acceptable
- wiki publication succeeded and is searchable
- remaining gaps are recorded with recommended next actions

### Completion Criteria
- `audit.md` exists and checks breadth, selection quality, recursive coverage,
  deep-research quality, citations, freshness, source balance, wiki publication,
  and remaining gaps.
- The workspace contains `brief.md`, `swarm-seeds.md`, `topic-graph.md`,
  `swarm-iterations.md`, `topic-scorecard.md`, `plan.md`, `frontier.md`,
  `sources.md`, `iterations.md`, `findings.md`, `contradictions.md`, the final
  report, and `audit.md`.
- Another agent can resume or review either the swarm phase or the deep-research
  phase without replaying the conversation.
