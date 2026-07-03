export const meta = {
  name: 'akm-meta-review',
  description: 'Run one akm meta-review prompt under a fixed model-tier policy: cheap+read-only Explore/sonnet gathers evidence, fable does all analysis/design/synthesis.',
  whenToUse: 'Executing a prompt from docs/reviews/akm-meta-review/ (01..15). Pass args:{review:"NN"}. Enforces sonnet+Explore for mechanical large-context gathering and fable for judgment.',
  phases: [
    { title: 'Gather', detail: 'read-only Explore agents (sonnet) inventory the evidence buckets' },
    { title: 'Analyze', detail: 'fable applies the review verdicts/rankings/designs' },
    { title: 'Verify', detail: 'fable adversarial pass (only for reviews flagged adversarial)' },
    { title: 'Synthesize', detail: 'fable writes findings/NN-slug.md in the prompt\'s required shape' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE PLACE MODELS ARE CHOSEN.  Every review flows through these three
// primitives, so the tier policy is written once and cannot be bypassed per
// review:  GATHER = Explore + sonnet (read-only, cheap, high-context);
// ANALYZE / VERIFY / SYNTHESIZE = fable (judgment/design/writing).
// The script has no filesystem access, so agents Read the prompt file
// themselves — the NN-slug.md file stays the single source of truth.
// ─────────────────────────────────────────────────────────────────────────────
const SMALL_MODEL = 'sonnet' // cheap, read-only, high-context
const LARGE_MODEL = 'fable' // judgment, design, writing
const MEDIUM_MODEL = 'opus' // challenge judgments and designs
const DIR = 'docs/reviews/akm-meta-review'
const promptPath = (slug) => `${DIR}/${slug}.md`
const findingsPath = (slug) => `${DIR}/findings/${slug}.md`

const CONTEXT_PATH = `${DIR}/CONTEXT.md`

// Hard, static safety — embedded in every agent prompt so it holds even if a file
// read is ever skipped.
const SAFETY =
  'HARD RULES (non-negotiable): READ-ONLY on live data — never run akm improve/recombine/extract/consolidate; ' +
  'open sqlite mode=ro only; never accept/reject proposals or edit/delete stash assets. ' +
  'Findings are local-only / gitignored — never commit or push them. Never print secret VALUES.'

// The EVOLVING cross-review context (full ground rules + binding decisions from completed
// reviews) lives in CONTEXT.md; every agent Reads it. That is the "token injection" —
// Workflow scripts have no filesystem access, so the AGENTS do the read, not the script,
// and CONTEXT.md stays the one running document the owner maintains.
const readFirst = (slug) =>
  `First, Read ${CONTEXT_PATH} (shared ground rules + binding cross-review decisions) and the review prompt at ${promptPath(slug)} (authoritative instructions + full ref list).`

const EVIDENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bucket: { type: 'string' },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          statement: { type: 'string', description: 'one verified fact — no analysis, no verdict' },
          location: { type: 'string', description: 'file:line, ref, table, or command that proves it' },
          value: { type: 'string', description: 'the concrete number/quote/path, if any' },
          verified: { type: 'boolean', description: 'true only if actually read/queried, not inferred' },
        },
        required: ['statement', 'verified'],
      },
    },
    gaps: { type: 'array', items: { type: 'string' }, description: 'things that could not be verified read-only' },
  },
  required: ['bucket', 'facts'],
}

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string', description: 'the single most important conclusion of this review' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          item: { type: 'string', description: 'the subsystem/heuristic/asset/bet under judgment' },
          verdict: { type: 'string', description: 'the review-specific verdict (DIES/LIVES/SEAM, PULLS-TOWARD/AGAINST, STALE, etc.)' },
          evidence: { type: 'string', description: 'the gathered fact(s) that back this — cite location' },
          cost: { type: 'string', description: 'what it costs / how much it matters' },
          fix: { type: 'string', description: 'the disposition or move; prefer one that subtracts' },
          subtracts: { type: 'boolean', description: 'true if the fix deletes/narrows rather than adds machinery' },
        },
        required: ['item', 'verdict', 'fix'],
      },
    },
  },
  required: ['headline', 'findings'],
}

// ── GATHER: cheap, read-only, high-context.  Explore (no write tools) + sonnet.
function gather(slug, bucket) {
  const refs = (bucket.refs || []).map((r) => `  - ${r}`).join('\n')
  return agent(
    `You are the GATHER phase of akm meta-review "${slug}". Your job is pure evidence collection — NO analysis, NO verdicts, NO recommendations.\n\n` +
      `${SAFETY}\n\n` +
      `${readFirst(slug)}\n\n` +
      `Your assigned bucket: "${bucket.label}".\n${bucket.focus}\n\n` +
      (refs ? `Start from these refs/paths (Read them, follow leads, run read-only inspection):\n${refs}\n\n` : '') +
      `Return a dense factual bundle: concrete file:line pointers, exact numbers from read-only DB/CLI queries, verbatim paths/quotes. Mark verified=false for anything you could not actually confirm. This feeds the analysis phase, which cannot see the files you saw — so be complete and specific.`,
    { agentType: 'Explore', model: SMALL_MODEL, phase: 'Gather', label: `gather:${slug}:${bucket.label}`, schema: EVIDENCE_SCHEMA },
  )
}

// ── ANALYZE: the judgment.  fable.
function analyze(slug, spec, evidence) {
  return agent(
    `You are the ANALYSIS phase of akm meta-review "${slug}".\n\n` +
      `${SAFETY}\n\n` +
      `${readFirst(slug)} The prompt defines the exact judgment steps.\n\n` +
      `Read-only evidence gathered for you (you may Read the cited files to go deeper, but do not re-do the whole gather):\n` +
      `${JSON.stringify(evidence)}\n\n` +
      `Apply the prompt's judgment. Verdict vocabulary for this review: ${spec.dims.join(' / ')}.\n${spec.analyzeFocus}\n\n` +
      `Argue each KEEP verdict as hard as each KILL. Rank findings by how much they cost, most-important first. Every finding must cite the gathered evidence (a location/number), not vibes. Prefer fixes that subtract.`,
    { model: LARGE_MODEL, phase: 'Analyze', label: `analyze:${slug}`, schema: ANALYSIS_SCHEMA },
  )
}

// ── VERIFY: optional adversarial pass for the high-stakes reviews.  fable.
function verify(slug, spec, analysis) {
  return agent(
    `You are the ADVERSARIAL VERIFY phase of akm meta-review "${slug}".\n\n` +
      `${SAFETY}\n\n` +
      `${readFirst(slug)}\n\n` +
      `Here is the analysis produced so far:\n${JSON.stringify(analysis)}\n\n` +
      `${spec.adversarialFocus}\n\n` +
      `Be a hostile reviewer. For each finding: is the verdict actually supported by the cited evidence, or is it a strawman / over-claim? What did the analysis MISS entirely? Return a short critique: (a) findings to downgrade or cut and why, (b) missing findings the analysis should have made, (c) the single strongest counter-argument. Default to skepticism.`,
    { model: MEDIUM_MODEL, phase: 'Verify', label: `verify:${slug}` },
  )
}

// ── SYNTHESIZE: write the deliverable.  fable (it is the argued artifact).
function synthesize(slug, spec, analysis, critique) {
  return agent(
    `You are the SYNTHESIS phase of akm meta-review "${slug}".\n\n` +
      `${SAFETY}\n\n` +
      `${readFirst(slug)} Follow the review prompt's final "Output: findings/${slug}.md ..." step for the EXACT required structure.\n\n` +
      `Analysis to write up:\n${JSON.stringify(analysis)}\n\n` +
      (critique ? `Adversarial critique to incorporate (fold in the valid points; drop findings it refutes):\n${critique}\n\n` : '') +
      `Write the findings document to ${findingsPath(slug)} using the Write tool, matching the output structure the prompt specifies exactly (tables, rankings, dispositions). Keep it evidence-dense and subtraction-biased.\n\n` +
      `IMPORTANT: ${findingsPath(slug)} is LOCAL-ONLY and may contain security-sensitive facts — it must never be committed (a .gitignore rule covers it). Do not stage or commit anything.\n\n` +
      `Return only a short summary for the owner: the headline finding, the top 3 dispositions, and any owner-decision needed. Do NOT return the whole document.`,
    { model: LARGE_MODEL, phase: 'Synthesize', label: `synth:${slug}` },
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-PROMPT STRATEGY.  Each review keeps the same three-tier pipeline but
// customizes: how gather work splits into parallel read-only buckets, the
// verdict vocabulary, the analysis framing, and whether it earns an adversarial
// verify pass.  This is the only per-review surface; the tier policy above is
// shared.
// ─────────────────────────────────────────────────────────────────────────────

const REVIEWS = {
  '01': {
    slug: '01-goal-orientation',
    gather: [
      { label: 'docs-claim', focus: 'What the docs claim akm is FOR.', refs: ['docs/README.md', 'docs/concepts.md', 'docs/roadmap.md', 'docs/technical/akm-core-principles.md', 'akm show meta'] },
      { label: 'code-investment', focus: 'Where LOC, complexity, and recent commits actually go (git log --stat, dir sizes per subsystem).', refs: ['docs/technical/architecture.md'] },
      { label: 'owner-usage', focus: 'What actually runs and gets read back: crontab -l, hooks, session logs, akm stats/health, which asset types are recalled.', refs: ['crontab -l', 'akm stats', 'akm health'] },
    ],
    dims: ['PULLS-TOWARD', 'NEUTRAL', 'PULLS-AGAINST'],
    analyzeFocus: 'Reconcile the three goal sources and note disagreements. Give a per-subsystem alignment table (extract, search/curate, improve lanes, salience, proposals, hooks, wikis, registry, env/secret). Draft a one-paragraph goal statement if none exists. Output the top 5 misalignments ranked by cost, each with a concrete fix that deletes or narrows over adding coordination machinery.',
  },
  '02': {
    slug: '02-bitter-lesson',
    gather: [
      { label: 'heuristic-inventory', focus: 'Every hand-engineered judgment heuristic with file:line: salience encode/decay/outcome formulas+weights, rank_score blending, judge+schema gates, entity/tag clustering, lane orchestration+cooldowns, dedup/classification, curate reranker scaffolding, extract watermark/ledger. For each: what model-weakness/cost it compensates for, what breaks if deleted today.', refs: ['docs/design/improve-salience-working-reference.md', 'docs/design/improve-pipeline-deep-tuning-analysis.md', 'docs/design/improve-optimal-default-config.md'] },
      { label: 'read-path-ranking', focus: 'The ranking/indexing heuristics on the search read path.', refs: ['docs/technical/search.md', 'docs/technical/indexing.md'] },
      { label: 'intended-1.0', focus: 'The 1.0 shape these heuristics must fit or be cut from.', refs: ['docs/technical/v1-architecture-spec.md'] },
    ],
    dims: ['DIES', 'LIVES', 'SEAM'],
    analyzeFocus: 'Classify each heuristic DIES (only exists for weak/expensive models) / LIVES (determinism, auditability, cost, safety, provenance/intent the model cannot conjure) / SEAM (interface survives, internals become model-judged). Produce the deletion list with a net-LOC estimate, the seam designs (e.g. salience→model-scored relevance without a schema migration), the migration order, and the eval that proves each swap safe (reuse the curate golden-benchmark pattern). Recommendations should be net-negative LOC wherever honest.',
  },
  '03': {
    slug: '03-memory-compounding',
    gather: [
      { label: 'captured-never-resurfaced', focus: 'READ-ONLY query index.db/state.db for assets never returned by search/curate, never recalled, never reinforced since creation. Quantify the write-only fraction, broken down by asset type and origin (hand-written / improve-generated / extracted).', refs: ['~/.local/share/akm/index.db', 'docs/technical/storage-locations.md'] },
      { label: 'never-captured', focus: 'Capture gaps: sessions skipped by extract (watermark/ledger/llm-unavailable), asset types with no capture path, the checkpointing→explicit-extraction transition and what fell through it.', refs: ['docs/design/self-improvement-learning-memory-reference-index.md'] },
      { label: 'resurfaced-but-ignored', focus: 'Recall that does not land: curate results with negative/no feedback, memories contradicting current reality, stale .derived duplicates crowding results.', refs: ['docs/design/improve-salience-working-reference.md'] },
      { label: 'smarter-or-accumulating', focus: 'Evidence retrieval quality improves as the stash grows (rank_score effect, feedback trends, accepted-change-rate) vs pure accumulation. Separate telemetry blob growth (improve_runs.result_json ~3.95GB) from knowledge growth.', refs: ['docs/design/improve-vs-brain-analysis.md', 'docs/data-and-telemetry.md'] },
    ],
    dims: ['write-only leak', 'capture gap', 'ignored-recall', 'compounding-vs-accumulating'],
    analyzeFocus: 'Deliver the four leak inventories WITH NUMBERS, the verdict on compounding vs merely accumulating, and the missing retention/decay/promotion rules (what decays, what invalidates on contradiction per the bi-temporal design, what promotes memory→lesson→knowledge, what should stop being written) with specific code/config touch points. Prefer rules that reduce writes over compaction machinery.',
  },
  '04': {
    slug: '04-stash-self-model',
    gather: [
      { label: 'self-model-inventory', focus: 'Every memory/lesson/knowledge asset encoding owner preferences, project state, workflows, or decisions — plus the .derived twins. Use akm search --type memory/--type lesson and direct reads.', refs: ['akm search --type memory', 'akm search --type lesson'] },
      { label: 'current-reality', focus: 'Independent ground truth: recent git history across the owner active repos, recent session logs, live cron/config, what the owner actually worked on in the last 30 days.', refs: ['crontab -l', '~/.local/share/akm/index.db'] },
    ],
    dims: ['STALE', 'ASPIRATIONAL', 'DUPLICATED', 'TELEMETRY-NOISE', 'CONTRADICTED'],
    analyzeFocus: 'Flag every divergence between the self-model and current reality, classed by the vocabulary. For each, a disposition (update/invalidate/merge/archive/delete) ROUTED THROUGH THE PROPOSAL QUEUE (see docs/technical/proposal-storage.md) — never direct edits. Estimate the recall-quality effect of the batch. Answer whether akm has any mechanism that would have PREVENTED the drift — this review is the acceptance test for docs/design/improve-bitemporal-invalidation-design.md (contradiction detection, decay, freshness-at-recall); recommend the single mechanism to add or the write path to remove.',
  },
  '05': {
    slug: '05-metrics-and-evals',
    gather: [
      { label: 'proxy-metrics-inventory', focus: 'Every proxy metric the system optimizes or reports, and the drift points where a number improves while the real goal degrades. Known prior art (do not re-litigate): promotion volume rewarded churn; pre-beta.50 "rejected" were gated skips (skippedCount IS NOT NULL). Find the NEXT trap (e.g. rank_score feeding search into self-reinforcing recall loops).', refs: ['docs/design/improve-beta50-monitoring.md', 'docs/design/improve-pipeline-deep-tuning-analysis.md'] },
      { label: 'eval-infra-audit', focus: 'What the eval infra covers and misses: curate golden benchmark (deterministic embedder, frozen corpus, nDCG/MRR/leapfrog, CI guard), akm-eval. Gaps: improve quality has no golden benchmark, memory recall none, SessionStart payload none.', refs: ['docs/akm-eval.md', 'docs/technical/curate-performance-evals.md', 'tests/curate-golden-eval.test.ts'] },
    ],
    dims: ['north-star rank', 'proxy-drift', 'eval-gap'],
    analyzeFocus: 'Propose and RANK the north-star metric(s) grounded in what akm is for; say which is primary. List the proxy-drift traps. Build the eval gap table. Design the missing evals + regression gates — each deterministic, CI-runnable, catching degradation before the owner feels it, reusing the golden-benchmark pattern (no new harness machinery, no flaky I/O in the unit suite). Order the implementation by leverage.',
  },
  '06': {
    slug: '06-autonomy-ladder',
    gather: [
      { label: 'autonomous-actions', focus: 'Every action akm takes UNSUPERVISED with file:line and the gate in front (judge/schema/wo-opt-out/cooldown): cron lanes (distill, recombine, consolidate, proactive-maintenance), salience/rank_score writes, auto-accept of recombine-confirmed lessons, watermark advancement, index writes, memory-candidate capture. Verify against EFFECTIVE live config + cron profiles — a gate config disables is not a gate.', refs: ['docs/design/improve-proactive-maintenance.md', 'docs/design/improve-optimal-default-config.md', '~/.config/akm/config.json', 'crontab -l'] },
      { label: 'owner-gated-and-backlog', focus: 'Every owner-gated action (proposal accept/reject, config changes, deletion) and the proposal queue health: drain rate vs arrival rate, age of the oldest pending item.', refs: ['docs/technical/proposal-storage.md', 'akm proposal list'] },
    ],
    dims: ['OVER-GRANTED', 'UNDER-GRANTED', 'rung: autonomous/audited/batched/per-item'],
    analyzeFocus: 'Score each action on blast-radius × reversibility × leverage. Flag OVER-GRANTED (silent writes that degrade recall/stash with no owner-visible trace — test auto-accept hardest) and UNDER-GRANTED (gates costing more than they protect — a queue nobody drains is a dead-letter box). Redesign the ladder: the rung each action should be on and the change to move it. Prefer removing an action over adding a gate.',
  },
  '07': {
    slug: '07-prompt-injection',
    gather: [
      { label: 'input-avenues', focus: 'Every input avenue with trust level, which model processes it, at what privilege, with what tools available: wiki stash of arbitrary web pages (untrusted), extract over transcripts (semi-trusted), registry kits/stash-makers from third-party repos (untrusted), improve consuming its own output (feedback-loop risk), config/env (integrity not injection).', refs: ['docs/technical/architecture.md', 'docs/wikis.md', 'docs/registry.md', 'docs/stash-makers.md', 'docs/data-and-telemetry.md'] },
      { label: 'reinjection-avenues', focus: 'Every point where stored content re-enters a live agent context: SessionStart hook payload (grep the hook that emits the "AKM is available" context), curate/search result bodies, memory recall blocks, the improve judge reading candidate text, workflow/agent/command asset bodies dispatched via akm skills.', refs: ['the Claude Code + opencode hook/plugin code'] },
    ],
    dims: ['severity chain (untrusted-input → high-privilege re-injection)'],
    analyzeFocus: 'Identify the highest-severity chains — untrusted input reaching a high-privilege re-injection point. Write the actual attack narrative for the worst chain (can a crafted wiki page or poisoned transcript string produce a memory/lesson the SessionStart hook later injects as instructions into every future session? can a registry kit ship an attacker-controlled agent/command body?). Define the defense (input isolation, provenance/trust tagging surviving into recall, sanitization at stash time, privilege reduction at re-injection); research spotlighting/data-marking/least-privilege and recommend what fits. Prefer removing a dangerous re-injection path over wrapping it in a sanitizer.',
    adversarial: true,
    adversarialFocus: 'Attack the attack-analysis: for the top chain, find a WORSE or shorter path it missed. Is each claimed chain actually reachable given the real privilege/tools at each hop, or is it theoretical? Which defense would the attacker simply route around?',
  },
  '08': {
    slug: '08-attack-surface',
    gather: [
      { label: 'stores-and-secrets', focus: 'Data stores (index.db, state.db, wikis/, stash dirs) — paths, sizes, contents, on-disk protections, which are gitignored user data. Secrets/env assets — how stored, encrypted-at-rest or not, how injected, whether values leak via logs/stats/errors/SessionStart. NEVER print secret values; names/paths only.', refs: ['docs/technical/storage-locations.md', 'docs/technical/filesystem.md', 'docs/data-and-telemetry.md', 'docs/technical/logs-audit.md', 'akm env list', 'akm secret list'] },
      { label: 'install-integration-shared', focus: 'Install/integration surface: CLI, Claude Code plugin, opencode plugin, cron jobs, SessionStart/other hooks, network egress (registry fetches, LLM API, web fetches). Multi-install/shared-config surface: multiple akm versions sharing one config.json (prior incident), dev/prod isolation, the stashDir-repoint hazard.', refs: ['docs/technical/akm-production-readiness-findings.md', '~/.config/akm/config.json', 'crontab -l'] },
    ],
    dims: ['criticality × exposure'],
    analyzeFocus: 'Build the inventory as a re-runnable/diffable table: per surface, the tech/dependency, self-hosted vs third-party, how it authenticates, common misconfigurations, exposure audience. Rank by criticality × exposure and set a continuous-assessment cadence per surface. Propose (design only, do not scaffold) an "AttackSurface" skill + "AssessAttackSurface" flow — prefer folding into the existing health command over new machinery.',
  },
  '09': {
    slug: '09-steelman-the-bets',
    gather: [
      { label: 'load-bearing-bets', focus: 'Surface akm load-bearing bets and the evidence for/against each: autonomous improve = net-positive knowledge (prior: churn, polluted metrics, undrained backlog); local SQLite + hybrid search is the right substrate vs a thin layer over a long-context model; neuroscience salience/decay earns its complexity vs flat recency+feedback; extract-from-transcripts = durable knowledge vs telemetry; CLI+plugin is the distribution model.', refs: ['docs/design/improve-neuroscience-alignment-survey.md', 'docs/design/improve-vs-brain-analysis.md', 'docs/design/improve-pipeline-deep-tuning-analysis.md', 'docs/roadmap.md', 'docs/technical/v1-architecture-spec.md', 'docs/concepts.md'] },
      { label: 'noticeability', focus: 'For each bet: would the CURRENT telemetry even let the owner notice if it were failing, or is failure structurally invisible? What would the owner see (or not see)?', refs: ['docs/design/improve-beta50-monitoring.md'] },
    ],
    dims: ['steelman-against', 'never-checked-sub-belief', 'noticeability', 'prob-wrong × cost-if-wrong'],
    analyzeFocus: 'For each bet: argue the AGAINST-case as strongly as it can be argued (do not hedge), list the load-bearing sub-beliefs never actually checked, the evidence that would settle it, and the notice-ability verdict. Rank bets by probability-wrong × cost-if-wrong. For the top one, propose the cheapest DECISIVE experiment (a 4-minute yes/no test, not a multi-week rebuild).',
    adversarial: true,
    adversarialFocus: 'Steelman the FOR side of each bet the analysis attacked — is the against-case actually valid, or did the analysis build a strawman? Which bet did it fail to attack at all? Which "cheapest experiment" would not actually settle the question?',
  },
  '10': {
    slug: '10-what-10xs-what-dies',
    gather: [
      { label: 'subsystem-horizon-scan', focus: 'Score each subsystem on a 2-year horizon vs frontier trajectory (million-token context, native/model retrieval, near-free inference, agentic tool use, long-horizon memory). DIES candidates: hybrid ranking heuristics, hand-tuned salience, transcript summarization, chunking. WEDGE candidates: durable cross-session provenance, owner-specific intent/preferences, auditable learned-why trail, curation/trust of third-party knowledge, write-side capture the model cannot self-do.', refs: ['knowledge:projects/akm/consolidation-future-vision', 'docs/technical/v1-architecture-spec.md', 'docs/roadmap.md', 'docs/technical/akm-core-principles.md', 'docs/technical/search.md', 'docs/technical/indexing.md', 'docs/concepts.md'] },
    ],
    dims: ['DIES', '10x-WEDGE', 'MOAT-QUESTION'],
    analyzeFocus: 'Deliver the subsystem scorecard; separate stop-investing-now from pour-into-now with FILE-LEVEL specificity (which files to freeze/delete, which to double down, what NOT to build because the model renders it moot first). Define the 1.0 shape, reconcile against the v1 spec/roadmap and call out where they build things that DIE. State the single-sentence positioning: what akm is FOR that a long-context frontier model still cannot do for the owner. Prefer a smaller, sharper 1.0.',
    adversarial: true,
    adversarialFocus: 'Attack the DIES/WEDGE calls: which "WEDGE" will the model actually absorb within 2 years? Which "DIES" is the analysis prematurely killing something with durable value? Is the 1.0 positioning sentence honestly defensible, or does it describe something the model already does?',
  },
  '11': {
    slug: '11-decisions-into-policy',
    gather: [
      { label: 'dev-decisions', focus: 'Recurring DEVELOPMENT decisions in session logs, PR reviews, MEMORY.md (no live-run to check, verify effective config, unit-vs-integration placement, subtract-dont-accrete, sandbox HOME/XDG). Many are already written as memories/CLAUDE.md rules — for each, check whether the encoding PREVENTS the mistake or merely documents it after the fact.', refs: ['docs/technical/akm-core-principles.md', 'docs/technical/functional-contract-patterns.md', 'docs/technical/testing-workflow.md', 'docs/technical/test-coverage-guide.md', '~/.claude/CLAUDE.md', 'the custom-lint / biome setup'] },
      { label: 'runtime-decisions', focus: 'Decisions akm itself remakes per-run that could be standing config policy: which lane to run, whether to accept a proposal, salience thresholds, cooldowns.', refs: ['docs/design/improve-optimal-default-config.md'] },
    ],
    dims: ['reversibility × stakes', 'encoding: CLAUDE.md/lint/config-default/schema/CI/memory'],
    analyzeFocus: 'For each recurring decision, state the latent rule in one sentence and classify by reversibility × stakes (cheap+reversible+slow → automate/default away; expensive+irreversible+reckless → add a real gate). Pick the RIGHT encoding and say why. Flag rules currently encoded where they do NOT enforce (a memory describing a mistake the code still allows) and move them to an enforcing location. Prefer one enforcing lint over three documenting memories.',
  },
  '12': {
    slug: '12-one-real-constraint',
    gather: [
      { label: 'value-chain-trace', focus: 'Trace capture → store → rank → resurface → the moment a session is measurably better because akm existed. Find the stage where value actually leaks, using live read-only evidence: recall stats, feedback, backlog age, session logs. Candidates: capture coverage, retrieval precision, trust (owner acts on output?), throughput (backlog), adoption.', refs: ['docs/design/improve-salience-working-reference.md', 'akm stats', '~/.local/share/akm/index.db'] },
      { label: 'effort-vs-constraint', focus: 'Where recent effort actually went (commits, docs, tuning/salience investment) and whether it was spent ON the constraint or on a non-constraint that felt urgent. Name any instance of stacking machinery on a small non-root problem.', refs: ['docs/design/improve-pipeline-deep-tuning-analysis.md', 'docs/technical/akm-production-readiness-findings.md', 'docs/roadmap.md'] },
    ],
    dims: ['the single binding constraint (not the loudest problem)'],
    analyzeFocus: 'Locate the ONE leak and PROVE it is the binding constraint, not just the loudest. Name the single move that relieves it and what becomes possible once gone (second-order effects). Predict the NEW constraint that surfaces next. Prefer a move that removes a stage over one that adds a stage. Commit to one constraint — resist listing five.',
  },
  '13': {
    slug: '13-bus-factor',
    gather: [
      { label: 'single-host-deps', focus: 'Load-bearing, undocumented environmental/single-host dependencies: cron running the real dist vs the npm package (prior incident: stale local dist), local config pinning values that differ from code defaults, the deterministic-embedder env var, AKM_*_DIR/HOME/XDG assumptions, opencode config. For each: reproducible from a doc/script, or tribal knowledge?', refs: ['docs/getting-started.md', 'docs/local-development.md', 'docs/technical/storage-locations.md', 'crontab -l'] },
      { label: 'operational-in-head', focus: 'Operational knowledge only the owner holds: how to tell improve is healthy, which profiles have sync disabled, real-regression vs host-state flake, when to use --force, how to verify a feature is live against the RIGHT database. Inventory captured vs still-in-head.', refs: ['docs/technical/manual-testing-checklist.md', 'docs/technical/incidents/'] },
      { label: 'fragile-if-untended', focus: 'Processes that degrade without attention and have no alarm/auto-recovery: proposal backlog growth, state.db blob growth (~3.95GB result_json), telemetry accumulation, cron failures surfacing only in Discord.', refs: ['docs/data-and-telemetry.md'] },
    ],
    dims: ['captured', 'partially-captured', 'in-head-only'],
    analyzeFocus: 'Three dependency inventories, each item marked captured/partial/in-head. For each finding, the durable artifact that removes the you-shaped hole (runbook, script, health check, doc, or — better — a code change that makes the dependency self-evident or unnecessary; prefer making it DISAPPEAR, e.g. cron builds its own dist, over documenting the manual step). Order by breakage-likelihood × recovery-difficulty. Flag any single-host assumption that would also bite a fresh install (overlaps with real product bugs).',
  },
  '14': {
    slug: '14-docs-consolidation',
    gather: [
      { label: 'doc-inventory', focus: 'Inventory every internal doc: docs/design/*, docs/technical/*, docs/archive/*, docs/migration/*, any .plans/*, plus design/architecture knowledge assets in the stash. For each: coverage, last-meaningful-update, status.', refs: ['docs/design/', 'docs/technical/', 'docs/archive/', 'docs/README.md'] },
      { label: 'contradiction-scan', focus: 'Detect contradictions/drift: multiple docs describing the same subsystem (improve, salience, search ranking, storage) with divergent details; design docs whose "proposed" mechanism the code implements differently; the schema↔type two-source-of-truth drift already flagged in config. For each conflict determine the authoritative source (code > current design doc > older design doc).', refs: ['docs/design/self-improvement-learning-memory-reference-index.md', 'docs/design/improve-salience-working-reference.md', 'docs/technical/architecture.md', 'docs/technical/v1-architecture-spec.md'] },
    ],
    dims: ['CURRENT', 'SUPERSEDED', 'SHIPPED', 'ASPIRATIONAL', 'CONTRADICTED'],
    analyzeFocus: 'Doc inventory with statuses; contradiction list with authoritative-source rulings and the correction; a consolidated canonical map that EXTENDS the existing self-improvement-learning-memory-reference-index (not a competing index), routing to the authoritative doc per subsystem with superseded/shipped docs clearly marked; the rule for where NEW design docs go so it does not re-scatter; archive dispositions (list only — owner approves any move/delete by name). Prefer archiving/merging over writing new; the deliverable should REDUCE the doc count.',
  },
  '15': {
    slug: '15-maintenance-loop',
    gather: [
      { label: 'triage-inputs-and-gates', focus: 'Enumerate the triage inputs a standing loop would read (open issues/PRs, proposal backlog age+count, failing/flaky CI signals, state.db growth, docs marked stale by review 14, other reviews\' findings, MEMORY.md follow-ups) and the EXACT hard gates it must enforce: full `bun run check` green (0/0/0), tests via the process-parallelism script (never TEST_PARALLEL>1 — epoll race), net-negative/neutral LOC bias, never run improve/recombine/extract/consolidate on live data, never delete user data without per-path approval, effective-config verified.', refs: ['docs/technical/testing-workflow.md', 'scripts/test-unit.sh', 'docs/technical/manual-testing-checklist.md', 'docs/roadmap.md', '~/.claude/CLAUDE.md'] },
    ],
    dims: ['loop spec: triage / selection / gates / escalation / stop / cadence'],
    analyzeFocus: 'DESIGN (do not run) the loop: triage inputs; one highest-value BOUNDED task per cycle within a strict permission envelope; the hard gates as absolute constraints; the escalation list (irreversible deletes, config changes, releases, security-sensitive changes, anything touching the live stash → queued for owner, never executed); stop conditions (stop when every item is landed/decision-ready/blocked/no-work — do not spin); wake cadence argued against cost (cache-window reasoning: short polls only for external state, long fallback otherwise); and the exact /loop or scheduled-agent invocation to start it. Design only — the owner arms it.',
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPATCH
// ─────────────────────────────────────────────────────────────────────────────

function resolveReviewId(a) {
  const raw = a && typeof a === 'object' ? a.review : a
  if (raw === undefined || raw === null) return null
  const s = String(raw).trim()
  const two = s.slice(0, 2)
  if (REVIEWS[two]) return two
  // allow passing a full slug or a bare number like "3"
  const padded = s.length === 1 ? `0${s}` : s
  if (REVIEWS[padded]) return padded
  const bySlug = Object.keys(REVIEWS).find((k) => REVIEWS[k].slug === s)
  return bySlug || null
}

const id = resolveReviewId(args)
if (!id) {
  const list = Object.keys(REVIEWS)
    .sort()
    .map((k) => `  ${k}  ${REVIEWS[k].slug}${REVIEWS[k].adversarial ? '  (+adversarial verify)' : ''}`)
    .join('\n')
  log(`No valid review selected. Pass args:{review:"NN"}. Available:\n${list}`)
  return { error: 'no-review-selected', available: Object.keys(REVIEWS).sort() }
}

const spec = REVIEWS[id]
log(`Running meta-review ${spec.slug} — ${spec.gather.length} gather bucket(s) on Explore/sonnet, analysis+synthesis on fable${spec.adversarial ? ', with an adversarial verify pass' : ''}.`)

// GATHER — barrier: analysis genuinely needs every bucket's evidence together.
phase('Gather')
const evidence = (await parallel(spec.gather.map((b) => () => gather(spec.slug, b)))).filter(Boolean)
if (evidence.length === 0) {
  log('Gather produced no evidence — aborting before spending fable on nothing.')
  return { error: 'gather-empty', review: spec.slug }
}

// ANALYZE — the judgment, on fable.
phase('Analyze')
const analysis = await analyze(spec.slug, spec, evidence)

// VERIFY — optional adversarial fable pass for the high-stakes reviews.
let critique = null
if (spec.adversarial) {
  phase('Verify')
  critique = await verify(spec.slug, spec, analysis)
}

// SYNTHESIZE — write the findings doc, on fable.
phase('Synthesize')
const summary = await synthesize(spec.slug, spec, analysis, critique)

return {
  review: spec.slug,
  findings: findingsPath(spec.slug),
  headline: analysis && analysis.headline,
  buckets: spec.gather.length,
  adversarial: Boolean(spec.adversarial),
  summary,
}
