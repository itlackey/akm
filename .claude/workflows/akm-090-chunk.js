export const meta = {
  name: 'akm-090-chunk',
  description: 'Execute one akm 0.9.0 plan chunk: Fable-grounded implementation brief, Sonnet test-first development, Opus dual review gates, Fable escalation ladder',
  whenToUse: 'One chunk per invocation, in manifest order (docs/design/akm-0.9.0-chunk-manifest.json). args: {chunk: "0a", baseBranch?: "akm-0.9.0", worktreeRoot?: "/home/user/akm-worktrees"}. Runbook: docs/design/akm-0.9.0-execution-workflow.md.',
  phases: [
    { title: 'Load', detail: 'manifest entry + preflight' },
    { title: 'Setup', detail: 'chunk branch worktree + green baseline' },
    { title: 'Ground', detail: 'Fable 5: plan extraction + codebase grounding fan-out → implementation brief', model: 'fable' },
    { title: 'Verify Brief', detail: 'adversarial 3-lens verification of every brief claim', model: 'fable' },
    { title: 'Implement', detail: 'Sonnet 5 test-first development, one work item at a time', model: 'sonnet' },
    { title: 'Review', detail: 'Opus 4.8 dual review: brief adherence + code quality', model: 'opus' },
    { title: 'Escalate', detail: 'Fable 5 assist after 2 review failures; blocked + human report after 3', model: 'fable' },
    { title: 'Finalize', detail: 'chunk gates, audit, push, report' },
  ],
}

// ---------------------------------------------------------------------------
// Inputs & constants
// ---------------------------------------------------------------------------
const chunkId = args && args.chunk
if (!chunkId) throw new Error('args.chunk is required, e.g. {chunk: "0a"}')
const baseBranch = (args && args.baseBranch) || 'akm-0.9.0'
const worktreeRoot = (args && args.worktreeRoot) || '/home/user/akm-worktrees'

const REPO = '/home/user/akm'
const MANIFEST = 'docs/design/akm-0.9.0-chunk-manifest.json'
const PLAN = 'docs/design/akm-0.9.0-bundle-adapter-architecture-plan.md'
const ADAPTER_SPEC = 'docs/design/akm-0.9.0-bundle-adapter-spec.md'
const NORMATIVE_SPEC = 'docs/design/akm-format-neutral-bundle-workspace-spec.md'
const DECISIONS = 'docs/design/akm-architecture-decision-history.md'
const BUDGET_FLOOR = 80000 // stop starting new work items below this many remaining tokens

// Docs live in the worktree once the chunk branch descends from a base that
// contains them; until then fall back to the main checkout.
const DOCS_HINT = `Design docs: read them from the worktree if present there, otherwise from ${REPO}/docs/design/. The plan is ${PLAN}; companions: ${ADAPTER_SPEC}, ${NORMATIVE_SPEC}, ${DECISIONS}, ${MANIFEST}.`

const CONTEXT = `CONTEXT — akm 0.9.0 refactor execution.
akm is a TypeScript/Bun CLI (repo ${REPO}, ~135K src LOC, ~175K test LOC, version 0.9.0-rc.x).
AUTHORITY: ${PLAN} is THE plan. Nothing in the current code supersedes it — the rc train is part of what this refactor fixes. Where the plan says "preserve behavior", current behavior is the oracle; everywhere else the plan is.
${DOCS_HINT}
HARD RULES (plan §1.3 — violations are review BLOCKERS):
- NO new trust/approval/security machinery: no labeling, no action clamps, no confirm prompts, no digests, no trust records.
- Memory lifecycle is DEFERRED entirely (plan §6): no states, water-marks, pressure, CAS archive, sandbox gate, purge/quarantine.
- Deletion is gated by inventory + zero-count greps, never by a LOC number; net-LOC is reported, not gated.
- Safety suites (plan §15.3) stay green at every chunk boundary. Fixed points you must not touch unless the work item says so: tests/_helpers/sandbox.ts, tests/_preload.ts, the mock.module-ban lint, the hand-rolled test sharding.
COMMANDS (run from the worktree): bun install --frozen-lockfile; bun run check:fast (lint+tsc+unit); bun run check (adds integration); bun run lint; bunx tsc --noEmit; bun test <path>.`

const TEST_FIRST_PROTOCOL = `TEST-FIRST PROTOCOL — the work item's testMode selects the variant, and reviewers verify compliance via commit order:
- test-first: write the tests named in testsFirst FIRST; commit them separately (prefix "test(chunk-${chunkId}):"); run them and record that they FAIL for the expected reason (paste the failure in your report); then implement; then make them green. Never weaken an assertion to pass.
- characterization-preserve: the goldens/tests exist (or you capture them first, same separate-commit rule) and must KEEP passing UNCHANGED through your refactor; byte-for-byte where deterministic. Re-recording a golden outside its designated chunk is forbidden (plan §15.5).
- deletion-gate: the test is the gate — the zero-count grep plus the suite staying green after the deletion; land the replacement contract test in the SAME COMMIT as the deletion (plan §15.4) so the exhaustiveness guard never gaps.
- docs-assets: verification is the lints — shipped-assets lint, schema regen check (bun scripts/gen-config-schema.ts --check), link checks.`

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const CHUNK_SCHEMA = {
  type: 'object',
  required: ['found', 'chunk'],
  properties: {
    found: { type: 'boolean' },
    chunk: {
      type: 'object',
      required: ['id', 'order', 'wave', 'branch', 'title', 'scope', 'gates', 'planRefs'],
      properties: {
        id: { type: 'string' }, order: { type: 'integer' }, wave: { type: 'integer' },
        branch: { type: 'string' }, title: { type: 'string' }, scope: { type: 'string' },
        gates: { type: 'array', items: { type: 'string' } },
        netLoc: { type: 'string' }, testBucket: { type: 'string' },
        planRefs: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
    },
    globalGates: { type: 'array', items: { type: 'string' } },
    grepGateScope: { type: 'string' },
  },
}

const SETUP_SCHEMA = {
  type: 'object',
  required: ['ok', 'worktreePath', 'branch', 'headSha', 'baselineGreen', 'docsPresent'],
  properties: {
    ok: { type: 'boolean' },
    worktreePath: { type: 'string' }, branch: { type: 'string' }, headSha: { type: 'string' },
    createdBranch: { type: 'boolean' }, resumedExisting: { type: 'boolean' },
    baselineGreen: { type: 'boolean' }, baselineSummary: { type: 'string' },
    docsPresent: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } },
  },
}

const EXTRACT_SCHEMA = {
  type: 'object',
  required: ['requirements', 'groundingTasks'],
  properties: {
    requirements: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', required: ['id', 'text', 'planAnchor', 'kind'],
        properties: {
          id: { type: 'string' }, text: { type: 'string' }, planAnchor: { type: 'string' },
          kind: { enum: ['behavior', 'deletion', 'structure', 'gate', 'test', 'docs'] },
        },
      },
    },
    groundingTasks: {
      type: 'array', minItems: 1, maxItems: 8,
      items: {
        type: 'object', required: ['area', 'requirementIds', 'instructions'],
        properties: {
          area: { type: 'string' },
          requirementIds: { type: 'array', items: { type: 'string' } },
          instructions: { type: 'string' },
        },
      },
    },
    dependenciesOnPriorChunks: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

const GROUNDING_SCHEMA = {
  type: 'object',
  required: ['area', 'facts'],
  properties: {
    area: { type: 'string' },
    facts: {
      type: 'array',
      items: {
        type: 'object', required: ['requirementId', 'finding', 'anchors'],
        properties: {
          requirementId: { type: 'string' }, finding: { type: 'string' },
          anchors: { type: 'array', items: { type: 'string' } },
          driftFromPlan: { type: 'string' },
          existingTests: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

const BRIEF_SCHEMA = {
  type: 'object',
  required: ['chunkId', 'summary', 'briefPath', 'workItems', 'gateChecklist'],
  properties: {
    chunkId: { type: 'string' }, summary: { type: 'string' }, briefPath: { type: 'string' },
    workItems: {
      type: 'array', minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'title', 'testMode', 'testsFirst', 'steps', 'files', 'acceptance'],
        properties: {
          id: { type: 'string' }, title: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          testMode: { enum: ['test-first', 'characterization-preserve', 'deletion-gate', 'docs-assets'] },
          testsFirst: { type: 'array', items: { type: 'string' } },
          steps: { type: 'array', items: { type: 'string' } },
          files: { type: 'array', items: { type: 'string' } },
          deletions: { type: 'array', items: { type: 'string' } },
          acceptance: { type: 'array', items: { type: 'string' } },
          estLoc: { type: 'string' },
        },
      },
    },
    gateChecklist: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

const REFUTE_SCHEMA = {
  type: 'object',
  required: ['lens', 'verdict', 'blockers'],
  properties: {
    lens: { type: 'string' },
    verdict: { enum: ['approve', 'revise'] },
    blockers: {
      type: 'array',
      items: {
        type: 'object', required: ['claim', 'why', 'fix'],
        properties: { claim: { type: 'string' }, why: { type: 'string' }, fix: { type: 'string' } },
      },
    },
    minors: { type: 'array', items: { type: 'string' } },
  },
}

const DEV_SCHEMA = {
  type: 'object',
  required: ['itemId', 'status', 'commits', 'testRun'],
  properties: {
    itemId: { type: 'string' },
    status: { enum: ['done', 'failed'] },
    commits: { type: 'array', items: { type: 'object', required: ['sha', 'subject'], properties: { sha: { type: 'string' }, subject: { type: 'string' } } } },
    testsAdded: { type: 'array', items: { type: 'string' } },
    failingFirstEvidence: { type: 'string' },
    testRun: { type: 'object', required: ['passed', 'summary'], properties: { passed: { type: 'boolean' }, summary: { type: 'string' } } },
    checkFast: { type: 'object', properties: { passed: { type: 'boolean' }, summary: { type: 'string' } } },
    filesChanged: { type: 'array', items: { type: 'string' } },
    deviations: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['pass', 'findings', 'summary'],
  properties: {
    pass: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object', required: ['severity', 'description'],
        properties: {
          severity: { enum: ['blocker', 'major', 'minor'] },
          area: { type: 'string' }, description: { type: 'string' },
          evidence: { type: 'string' }, requiredFix: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

const ASSIST_SCHEMA = {
  type: 'object',
  required: ['diagnosis', 'guidance'],
  properties: {
    diagnosis: { type: 'string' },
    guidance: { type: 'array', items: { type: 'string' } },
    briefAmendments: { type: 'array', items: { type: 'string' } },
    recommendBlock: { type: 'boolean' },
    questionsForHuman: { type: 'array', items: { type: 'string' } },
  },
}

const BLOCK_SCHEMA = {
  type: 'object',
  required: ['reportPath', 'summary', 'questionsForHuman'],
  properties: {
    reportPath: { type: 'string' }, summary: { type: 'string' },
    questionsForHuman: { type: 'array', items: { type: 'string' } },
  },
}

const GATE_SCHEMA = {
  type: 'object',
  required: ['allGreen', 'results'],
  properties: {
    allGreen: { type: 'boolean' },
    results: { type: 'array', items: { type: 'object', required: ['gate', 'passed', 'detail'], properties: { gate: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } } } },
    netLoc: { type: 'object', properties: { insertions: { type: 'integer' }, deletions: { type: 'integer' }, net: { type: 'integer' } } },
    testLedger: { type: 'string' },
  },
}

const AUDIT_SCHEMA = {
  type: 'object',
  required: ['pass', 'reportPath', 'summary'],
  properties: {
    pass: { type: 'boolean' }, reportPath: { type: 'string' }, summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
  },
}

const PUSH_SCHEMA = {
  type: 'object',
  required: ['pushed'],
  properties: { pushed: { type: 'boolean' }, remoteRef: { type: 'string' }, error: { type: 'string' } },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function trimFindings(review) {
  if (!review || !review.findings) return []
  return review.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major')
}

// Verdict is DERIVED, never trusted: pass requires both the reviewer's own
// pass=true AND zero blocker/major findings, so a reviewer that returns
// pass=true alongside a blocker cannot gate the item through.
function ok(review) {
  return !!review && review.pass === true && trimFindings(review).length === 0
}

function findingsDigest(history) {
  // Only the most recent round in full; earlier rounds as counts, to keep dev prompts bounded.
  if (!history.length) return ''
  const last = history[history.length - 1]
  const earlier = history.slice(0, -1).map((h) => `round ${h.attempt}: ${trimFindings(h.adherence).length + trimFindings(h.quality).length} blocker/major finding(s)`).join('; ')
  return [
    earlier ? `Earlier rounds (already partially addressed): ${earlier}` : '',
    `LATEST REVIEW ROUND (attempt ${last.attempt}) — you MUST resolve every blocker/major below:`,
    `Adherence review: ${JSON.stringify(last.adherence)}`,
    `Quality review: ${JSON.stringify(last.quality)}`,
  ].filter(Boolean).join('\n')
}

// A single review with one retry on agent death (null), so a transient
// failure doesn't consume a rung of the escalation ladder.
async function runReview(kind, prompt, label) {
  let r = await agent(prompt, { model: 'opus', effort: 'high', schema: REVIEW_SCHEMA, label, phase: 'Review' })
  if (!r) {
    log(`review agent ${label} died; retrying once`)
    r = await agent(prompt, { model: 'opus', effort: 'high', schema: REVIEW_SCHEMA, label: `${label}-retry`, phase: 'Review' })
  }
  return r || { pass: false, findings: [{ severity: 'blocker', description: `${kind} review agent failed to produce a verdict twice; treating as failed review` }], summary: 'review agent unavailable' }
}

// Dev calls get the same one-retry-on-death treatment, so a transient agent
// death consumes neither a ladder rung nor triggers escalation on infra noise.
async function runDev(promptText, label) {
  let r = await agent(promptText, { model: 'sonnet', schema: DEV_SCHEMA, label, phase: 'Implement' })
  if (!r) {
    log(`dev agent ${label} died; retrying once`)
    r = await agent(promptText, { model: 'sonnet', schema: DEV_SCHEMA, label: `${label}-retry`, phase: 'Implement' })
  }
  return r
}

// ---------------------------------------------------------------------------
// Phase: Load
// ---------------------------------------------------------------------------
phase('Load')
const loaded = await agent(
  `Read ${REPO}/${MANIFEST} and return the chunk entry whose id is exactly "${chunkId}" VERBATIM (no paraphrase), plus the manifest's globalGates and grepGateScope. Set found=false if no such id exists.`,
  { model: 'haiku', effort: 'low', schema: CHUNK_SCHEMA, label: 'load-manifest' },
)
if (!loaded || !loaded.found) throw new Error(`Chunk "${chunkId}" not found in ${MANIFEST}`)
const chunk = loaded.chunk
const globalGates = loaded.globalGates || []
const grepGateScope = loaded.grepGateScope || ''
log(`Chunk ${chunk.id} — ${chunk.title} (wave ${chunk.wave}, order ${chunk.order}) → branch ${chunk.branch} off ${baseBranch}`)

// ---------------------------------------------------------------------------
// Phase: Setup — persistent worktree for the whole chunk team
// ---------------------------------------------------------------------------
phase('Setup')
const setup = await agent(
  `${CONTEXT}

ROLE: Setup engineer for Chunk ${chunk.id} (${chunk.title}).
1. In ${REPO}: git fetch origin ${baseBranch} (retry up to 4 times with 2s/4s/8s/16s backoff on network failure).
2. If a worktree already exists at ${worktreeRoot}/chunk-${chunk.id}, REUSE it (this is a resume): git -C <path> status must be clean; report resumedExisting=true. Otherwise create it: mkdir -p ${worktreeRoot} && git -C ${REPO} worktree add ${worktreeRoot}/chunk-${chunk.id} -B ${chunk.branch} origin/${baseBranch} (if the branch already exists on the remote, base on origin/${chunk.branch} instead to preserve prior work — report which you did).
3. In the worktree: bun install --frozen-lockfile.
4. Verify the design docs exist in the worktree at docs/design/ (the plan + specs + manifest). Report docsPresent accordingly.
5. Baseline gate: run bun run check:fast in the worktree. baselineGreen=true only if it fully passes. Include a short failure summary otherwise. Do NOT attempt to fix baseline failures — report them.
6. mkdir -p <worktree>/docs/design/execution/chunk-${chunk.id}
Return worktreePath, branch, headSha (git rev-parse HEAD), and the fields in the schema. Never push. Never touch ${REPO}'s checked-out branch.`,
  { model: 'sonnet', schema: SETUP_SCHEMA, label: 'setup-worktree' },
)
if (!setup || !setup.ok) {
  return { chunk: chunk.id, status: 'blocked-setup', detail: setup ? setup.problems : 'setup agent died', escalation: 'human' }
}
const wt = setup.worktreePath
if (!setup.baselineGreen) {
  const where = setup.resumedExisting
    ? `in the RESUMED worktree on ${setup.branch} — the red may come from prior work-in-progress commits (blocked items deliberately leave WIP in place), not from the base branch`
    : `in a fresh worktree off origin/${baseBranch} — the base itself is red`
  return { chunk: chunk.id, status: 'blocked-baseline', detail: `Baseline check:fast is RED ${where}. The chunk cannot be review-gated against a red baseline. ${setup.baselineSummary}`, escalation: 'human' }
}
log(`Worktree ready at ${wt} (${setup.branch} @ ${setup.headSha}); baseline green`)

// ---------------------------------------------------------------------------
// Phase: Ground — Fable 5 builds the implementation brief (the critical step)
// ---------------------------------------------------------------------------
phase('Ground')
const chunkJson = JSON.stringify(chunk)

const extraction = await agent(
  `${CONTEXT}

ROLE: Plan extractor (Fable 5) for Chunk ${chunk.id} (${chunk.title}).
Manifest entry (derived from plan §11 — verify against the plan itself, the plan wins): ${chunkJson}
Read the plan's §11 paragraph for this chunk AND every section its planRefs cite, in the worktree at ${wt} (fallback ${REPO}). Also read the adapter/normative spec sections the plan cites for this chunk.
Produce the complete requirements inventory for this chunk: every distinct thing the plan requires (behavior changes, deletions, structural moves, gates, test buckets, docs). Each requirement gets a stable id (R1, R2, ...), the exact plan anchor (section + phrase), and a kind. Do NOT invent requirements the plan doesn't state; do NOT drop any it does — completeness will be adversarially verified.
Then group the requirements into 3–8 groundingTasks by code area, each with precise instructions for a codebase-grounding agent (which files/symbols to verify, which anchors to re-measure at HEAD, which existing tests to inventory).
List dependenciesOnPriorChunks (what this chunk assumes already landed) and any openQuestions the plan leaves genuinely underspecified.`,
  { model: 'fable', effort: 'high', schema: EXTRACT_SCHEMA, label: 'extract-requirements', phase: 'Ground' },
)
if (!extraction) throw new Error('Plan extraction failed')
log(`${extraction.requirements.length} requirements → ${extraction.groundingTasks.length} grounding tasks`)

// Barrier justified: the brief author needs ALL grounding results together.
const groundPrompt = (t) => `${CONTEXT}

ROLE: Codebase grounder (Fable 5) for Chunk ${chunk.id}, area "${t.area}".
Work read-only in the worktree ${wt} (branch ${chunk.branch} @ ${setup.headSha}) — this is the exact code state the implementation will start from.
Requirements to ground (from the plan): ${JSON.stringify(extraction.requirements.filter((r) => t.requirementIds.includes(r.id)))}
Instructions: ${t.instructions}
For EACH requirement: verify the plan's claims against the actual code (read the files; run greps; re-measure any file:line anchors at this HEAD and report the true ones), state precisely what exists today (current behavior, current structure), list existing tests covering it, and flag any drift between what the plan assumed and what the code says (driftFromPlan). Anchors must be real file:line values you verified, not copied from the plan. Do not modify anything.`

const groundings = (await parallel(
  extraction.groundingTasks.map((t) => () => (async () => {
    let g = await agent(groundPrompt(t), { model: 'fable', effort: 'high', schema: GROUNDING_SCHEMA, label: `ground:${t.area}`, phase: 'Ground' })
    if (!g) {
      log(`grounding agent for area "${t.area}" died; retrying once`)
      g = await agent(groundPrompt(t), { model: 'fable', effort: 'high', schema: GROUNDING_SCHEMA, label: `ground:${t.area}-retry`, phase: 'Ground' })
    }
    // Fail loud, never silent: an ungrounded area reaches the brief author and
    // the verification panel explicitly flagged, not dropped.
    return g || { area: t.area, facts: [], risks: [`GROUNDING FAILED for area "${t.area}" — requirements ${t.requirementIds.join(', ')} are UNGROUNDED; the brief must not assert code facts about them without verifying in-line`] }
  })()),
)).filter(Boolean)
if (!groundings.some((g) => g.facts && g.facts.length)) throw new Error('All grounding agents failed')

const groundingJson = JSON.stringify(groundings)
const briefPathRel = `docs/design/execution/chunk-${chunk.id}/brief.md`

function briefAuthorPrompt(revisionNote) {
  return `${CONTEXT}

ROLE: Implementation-brief author (Fable 5) for Chunk ${chunk.id} (${chunk.title}). This brief is what the implementation team builds from — it is the single most important artifact of the chunk. It must be grounded in the plan AND the code, complete, and unambiguous.
Manifest entry: ${chunkJson}
Requirements inventory: ${JSON.stringify(extraction.requirements)}
Verified codebase grounding (anchors here are re-measured truth; where they contradict the plan's line numbers, these win): ${groundingJson}
${revisionNote || ''}

Write the implementation brief:
1. Decompose the chunk into ORDERED work items sized for one focused developer session each (roughly ≤600 changed LOC or one coherent deletion sweep per item; a chunk typically yields 3–8 items). Order = dependency order; use dependsOn between items.
2. Every work item: testMode (test-first | characterization-preserve | deletion-gate | docs-assets), testsFirst (the specific test files/cases to write or preserve BEFORE implementation — named paths, named behaviors), steps (concrete, file-anchored implementation steps), files, deletions (exact files/symbols to delete, from the inventory), acceptance (checkable criteria, each traceable to a requirement id or gate), estLoc.
3. Every requirement id from the inventory must be covered by exactly the work items that implement it — no orphans, no inventions. The chunk gates (${JSON.stringify(chunk.gates)}) map into gateChecklist with the item(s) that satisfy each.
4. Respect the hard rules verbatim; anything lifecycle-shaped or trust-shaped is out of scope BY DESIGN — say so in the brief so the dev doesn't "helpfully" add it.
5. Write the full human-readable brief to ${wt}/${briefPathRel} (markdown: overview, ground-truth facts with verified anchors, the work items, gate checklist, risks) and commit it on ${chunk.branch} with message "docs(chunk-${chunk.id}): implementation brief". Never push.
Return the structured brief (briefPath = "${briefPathRel}").`
}

let brief = await agent(briefAuthorPrompt(''), { model: 'fable', effort: 'xhigh', schema: BRIEF_SCHEMA, label: 'author-brief', phase: 'Ground' })
if (!brief) throw new Error('Brief author failed')

// ---------------------------------------------------------------------------
// Phase: Verify Brief — adversarial, 3 distinct lenses; revise up to 2x
// ---------------------------------------------------------------------------
const LENSES = [
  { key: 'plan-fidelity', prompt: 'PLAN FIDELITY: does the brief cover EVERY requirement in the inventory and add NOTHING beyond plan scope? Check each requirement id → work item mapping. Scope creep (especially anything trust-shaped or lifecycle-shaped, plan §1.3/§12.4) and silent omissions are blockers. Verify the gateChecklist covers every manifest gate.' },
  { key: 'code-grounding', prompt: 'CODE GROUNDING: is every factual claim in the brief (file:line anchors, current-behavior statements, symbol names, "X is used by Y" claims) TRUE at the worktree HEAD? Spot-verify by reading the actual files — every anchor you check must resolve. A wrong anchor or false behavior claim is a blocker.' },
  { key: 'test-adequacy', prompt: 'TEST-FIRST ADEQUACY: for each work item, are testsFirst sufficient to gate the implementation (would they actually fail without it / catch a wrong implementation)? Is each testMode correct for the item? Do deletion items land replacement contract tests in the same commit (plan §15.4)? Are acceptance criteria mechanically checkable? Vague or missing test specs are blockers.' },
]

let briefApproved = false
for (let round = 0; round <= 2; round++) {
  const lensPrompt = (l) => `${CONTEXT}

ROLE: Adversarial brief verifier (Fable 5), lens = ${l.key}, for Chunk ${chunk.id}. Your default stance is REFUSE — approve only if you actively fail to find a defect through your lens.
${l.prompt}
Brief (structured): ${JSON.stringify(brief)}
Full brief text: read ${wt}/${briefPathRel}. Requirements inventory: ${JSON.stringify(extraction.requirements)}. Manifest entry: ${chunkJson}. Worktree for verification: ${wt}.
Return verdict "approve" or "revise" with concrete blockers (claim / why / fix). Minor style notes go in minors and do not force revision.`

  // Fail CLOSED: a dead lens can never approve the brief — this is the step
  // the whole process leans on, so it gets the strictest availability rule.
  const verdicts = (await parallel(
    LENSES.map((l) => () => (async () => {
      let v = await agent(lensPrompt(l), { model: 'fable', effort: 'high', schema: REFUTE_SCHEMA, label: `verify-brief:${l.key}`, phase: 'Verify Brief' })
      if (!v) {
        log(`brief verifier lens ${l.key} died; retrying once`)
        v = await agent(lensPrompt(l), { model: 'fable', effort: 'high', schema: REFUTE_SCHEMA, label: `verify-brief:${l.key}-retry`, phase: 'Verify Brief' })
      }
      return v || { lens: l.key, verdict: 'revise', blockers: [{ claim: `verification lens ${l.key} unavailable`, why: 'the lens agent died twice — this round cannot count as verified', fix: 'the brief must pass a complete 3-lens round' }] }
    })()),
  )).filter(Boolean)

  const allBlockers = verdicts.flatMap((v) => (v.verdict === 'revise'
    ? (v.blockers.length ? v.blockers : [{ claim: `lens ${v.lens} demanded revision without itemized blockers`, why: 'revise verdict with an empty blocker list', fix: `address the lens's notes: ${JSON.stringify(v.minors || [])}` }])
    : []))
  if (verdicts.length < LENSES.length) {
    allBlockers.push({ claim: 'incomplete verification round', why: `${LENSES.length - verdicts.length} lens(es) did not run`, fix: 'the brief must pass a complete 3-lens round' })
  }
  if (!allBlockers.length) { briefApproved = true; break }
  if (round === 2) break
  log(`Brief revision round ${round + 1}: ${allBlockers.length} blocker(s) from ${verdicts.filter((v) => v.verdict === 'revise').length} lens(es)`)
  brief = await agent(
    briefAuthorPrompt(`REVISION REQUIRED — an adversarial verification panel found these blockers in your previous brief (read the committed version at ${wt}/${briefPathRel}, fix every one, rewrite the file, and commit the revision):\n${JSON.stringify(allBlockers)}`),
    { model: 'fable', effort: 'xhigh', schema: BRIEF_SCHEMA, label: `author-brief-rev${round + 1}`, phase: 'Ground' },
  )
  if (!brief) throw new Error('Brief revision failed')
}
if (!briefApproved) {
  return { chunk: chunk.id, status: 'blocked-grounding', detail: 'Implementation brief failed adversarial verification after 2 revisions — grounding is the critical step, refusing to hand a defective brief to the implementation team.', briefPath: briefPathRel, escalation: 'human' }
}
log(`Brief approved: ${brief.workItems.length} work items`)

// ---------------------------------------------------------------------------
// Phases: Implement / Review / Escalate — sequential per work item
// Ladder per the process spec: review fail 1 → dev revises; review fail 2 →
// Fable 5 assist, dev revises with guidance; review fail 3 → BLOCKED + human.
// ---------------------------------------------------------------------------
const itemResults = []
const blockedIds = []

for (let i = 0; i < brief.workItems.length; i++) {
  const item = brief.workItems[i]

  if ((item.dependsOn || []).some((d) => blockedIds.includes(d))) {
    itemResults.push({ itemId: item.id, status: 'skipped-upstream-blocked' })
    continue
  }
  if (budget.total && budget.remaining() < BUDGET_FLOOR) {
    log(`Token budget floor reached; deferring remaining items from ${item.id} onward`)
    for (let j = i; j < brief.workItems.length; j++) itemResults.push({ itemId: brief.workItems[j].id, status: 'deferred-budget' })
    break
  }

  const itemJson = JSON.stringify(item)
  const history = []
  let guidance = null
  let status = 'blocked'
  let devReport = null

  const devPrompt = (attempt) => `${CONTEXT}

ROLE: Developer (Sonnet 5), attempt ${attempt} of 3, work item ${item.id} — ${item.title} (Chunk ${chunk.id}: ${chunk.title}).
Work ONLY in the worktree ${wt} on branch ${chunk.branch}. Never push. Never switch branches. Never touch ${REPO}'s own checkout.
FIRST read the full implementation brief at ${wt}/${briefPathRel}. Your work item (structured): ${itemJson}
${TEST_FIRST_PROTOCOL}
Scope discipline: implement EXACTLY this work item — its steps, files, deletions, acceptance. Nothing beyond it (other items handle the rest); nothing trust-shaped or lifecycle-shaped ever. If the brief turns out to be wrong about the code, do the minimal faithful interpretation and record it in deviations — reviewers check deviations against the brief.
Do not modify docs/design/** except docs/design/execution/chunk-${chunk.id}/** (Chunk 10 items may override this explicitly in their steps).
${history.length ? findingsDigest(history) : ''}
${guidance ? `ARCHITECT GUIDANCE (Fable 5 escalation — this clarifies/overrides ambiguous parts of the brief):\n${JSON.stringify(guidance)}` : ''}
When done: all work committed with scoped messages (test(chunk-${chunk.id}):/refactor(chunk-${chunk.id}):/feat(chunk-${chunk.id}):/docs(chunk-${chunk.id}):), item tests run, bun run check:fast run. Report honestly — failing tests are reported as failing, never hidden. Include failingFirstEvidence (the recorded pre-implementation failure output) for test-first items.`

  devReport = await runDev(devPrompt(1), `dev:${item.id}`)

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!devReport) {
      history.push({ attempt, adherence: { pass: false, findings: [{ severity: 'blocker', description: 'developer agent died without a report' }], summary: 'no dev report' }, quality: { pass: false, findings: [], summary: 'no dev report' } })
    } else {
      const reviewCommon = `Work item (structured): ${itemJson}
Full brief: ${wt}/${briefPathRel}. Developer report: ${JSON.stringify(devReport)}
Inspect the ACTUAL work in the worktree ${wt} (branch ${chunk.branch}): git log --oneline origin/${baseBranch}..HEAD for commit order, git diff + git show for content, and run commands to verify claims (bun test <paths>, bun run lint, bunx tsc --noEmit) — never trust the report over the code. READ-ONLY: no commits, no file edits, no branch changes, no push.
Verdict rule: pass=true ONLY with zero blocker and zero major findings. blocker = violates a plan gate or hard rule (incl. anything trust-shaped/lifecycle-shaped in the diff), wrong behavior, missing requirement, unjustified deviation, test weakened to pass. major = real quality defect (see criteria). minor = nit — record it, it does not block. Every finding needs evidence (file:line or command output) and a requiredFix.`

      const [adherence, quality] = await parallel([
        () => runReview('adherence', `${CONTEXT}

ROLE: Adherence reviewer (Opus 4.8), attempt ${attempt}, item ${item.id}, Chunk ${chunk.id}. You review STRICT ADHERENCE to the implementation brief — the brief is the contract.
${reviewCommon}
Check: (1) every step/deletion/acceptance criterion of the item is actually implemented, with diff evidence; (2) commit order proves the test-first protocol for the item's testMode (tests committed before implementation; goldens unchanged for characterization-preserve; same-commit replacement tests for deletion-gate); (3) NOTHING in the diff falls outside this work item's scope — out-of-scope changes are majors, trust/lifecycle-shaped additions are blockers (plan §1.3/§12.4); (4) each reported deviation is faithful-minimal and justified against the brief and plan; (5) reported test results match reality when re-run.`, `review-adherence:${item.id}#${attempt}`),
        () => runReview('quality', `${CONTEXT}

ROLE: Code-quality reviewer (Opus 4.8), attempt ${attempt}, item ${item.id}, Chunk ${chunk.id}. You measure the work against established code-quality criteria.
${reviewCommon}
Criteria: cyclomatic complexity + length of touched functions (a new god fn >~200 LOC is a blocker in improve, a major elsewhere); duplication introduced (DRY); cohesion/coupling — SRP per module, dependency direction respected (no new layer-crossing imports, no new import cycles); naming + idiom consistency with the surrounding code (comment discipline: constraints only, no narration); type safety (no new any — repo is moving noExplicitAny to error — no unsafe casts, typed errors where the chunk mandates); dead code left behind after deletions (orphaned exports/helpers); error handling on new paths; TEST QUALITY — behavioral assertions not implementation-mirroring, edge cases covered, failing-first evidence present and plausible, isolation (sandbox helpers, no rogue mkdtemp, mock.module ban respected); commit hygiene (scoped messages, logical units).`, `review-quality:${item.id}#${attempt}`),
      ])
      history.push({ attempt, adherence, quality })
      for (const [kind, r] of [['adherence', adherence], ['quality', quality]]) {
        if (r && r.pass === true && trimFindings(r).length > 0) {
          log(`WARNING: ${kind} reviewer self-reported pass=true with ${trimFindings(r).length} blocker/major finding(s) on ${item.id} — verdict is derived from findings; treating as FAILED`)
        }
      }
      if (ok(adherence) && ok(quality)) {
        status = 'done'
        const minors = [...(adherence.findings || []), ...(quality.findings || [])].filter((f) => f.severity === 'minor')
        itemResults.push({ itemId: item.id, status, attempts: attempt, commits: devReport.commits, minors })
        log(`Item ${item.id} PASSED review on attempt ${attempt}${minors.length ? ` (${minors.length} minor note(s) recorded)` : ''}`)
        break
      }
      log(`Item ${item.id} review attempt ${attempt} FAILED (${trimFindings(adherence).length} adherence + ${trimFindings(quality).length} quality blocker/major)`)
    }

    if (attempt === 3) break

    if (attempt === 2) {
      // Review has failed twice — Opus escalates to Fable 5 for assistance and clarification.
      guidance = await agent(
        `${CONTEXT}

ROLE: Escalation architect (Fable 5). Work item ${item.id} of Chunk ${chunk.id} has FAILED Opus review twice. The Opus reviewers escalate to you for assistance and clarification before the final attempt.
Work item: ${itemJson}
Brief: ${wt}/${briefPathRel}. Review history (both rounds, both reviewers): ${JSON.stringify(history)}
Latest developer report: ${JSON.stringify(devReport)}
Examine the actual code in ${wt} (read-only). Diagnose the ROOT CAUSE: is the developer misreading the brief, is the brief ambiguous or wrong about the code, or are the reviewers applying a criterion incorrectly? Ground your judgment in the plan (${PLAN}) — it is the authority.
Produce: diagnosis; concrete step-by-step guidance the developer can execute; briefAmendments if the brief itself needs correction (also EDIT ${wt}/${briefPathRel} accordingly and commit "docs(chunk-${chunk.id}): brief amendment for ${item.id}" — this is the one write you may make); recommendBlock=true with questionsForHuman if the item is genuinely mis-scoped against the plan and no third attempt can succeed.`,
        { model: 'fable', effort: 'xhigh', schema: ASSIST_SCHEMA, label: `assist:${item.id}`, phase: 'Escalate' },
      )
      if (guidance && guidance.recommendBlock) {
        log(`Fable escalation recommends blocking item ${item.id} without a third attempt`)
        break
      }
    }

    devReport = await runDev(devPrompt(attempt + 1), `dev:${item.id}#${attempt + 1}`)
  }

  if (status !== 'done') {
    // Blocked: three failed reviews (or a recommendBlock) — escalate to a human.
    const ladderPath = guidance && guidance.recommendBlock
      ? `dev + dual review ×${history.length}; the Fable-5 escalation architect then recommended blocking WITHOUT a third attempt (item judged mis-scoped against the plan)`
      : `the full ladder (${history.length} dev attempt(s) + dual review each, with Fable-5 assistance before the final attempt)`
    const block = await agent(
      `${CONTEXT}

ROLE: Escalation reporter (Fable 5). Work item ${item.id} of Chunk ${chunk.id} is BLOCKED after ${ladderPath}. A human maintainer will pick this up — write the report that lets them decide in one sitting; describe only what actually ran, per the history below.
Work item: ${itemJson}. Review history: ${JSON.stringify(history)}. Fable guidance given: ${JSON.stringify(guidance)}. Last dev report: ${JSON.stringify(devReport)}
Write ${wt}/docs/design/execution/chunk-${chunk.id}/escalation-${item.id}.md: what the item requires (with plan anchors), what was attempted (commits), exactly why review keeps failing (the unresolved findings, verbatim), the root-cause diagnosis, and SPECIFIC questions/decisions for the human. Commit it on ${chunk.branch} ("docs(chunk-${chunk.id}): escalation report for ${item.id}"). Leave the work-in-progress commits in place — do not revert anything. Never push.`,
      { model: 'fable', effort: 'high', schema: BLOCK_SCHEMA, label: `block:${item.id}`, phase: 'Escalate' },
    )
    blockedIds.push(item.id)
    itemResults.push({ itemId: item.id, status: 'blocked', attempts: history.length, escalation: block || { summary: 'escalation reporter died; see review history in workflow result' } })
    log(`Item ${item.id} BLOCKED — escalation report committed`)
  }
}

// ---------------------------------------------------------------------------
// Phase: Finalize — chunk gates, audit, push, report
// ---------------------------------------------------------------------------
phase('Finalize')
const doneCount = itemResults.filter((r) => r.status === 'done').length
const anyBlocked = blockedIds.length > 0
const anyDeferred = itemResults.some((r) => r.status === 'deferred-budget' || r.status === 'skipped-upstream-blocked')

const gatePrompt = () => `${CONTEXT}

ROLE: Chunk gate runner for Chunk ${chunk.id} in worktree ${wt} (branch ${chunk.branch}).
Run and report every gate honestly:
1. bun run check (full: lint + tsc + unit + integration). Any failure = that gate red.
2. Each chunk gate: ${JSON.stringify(chunk.gates)} — grep-style gates run as rg counts at the declared scope (${grepGateScope}); artifact gates (ledgers, fixtures) verify the artifact exists in the tree; behavior gates run the named suites.
3. Global gates: ${JSON.stringify(globalGates)}. Safety suites and the deletion-ledger requirement apply at EVERY chunk boundary. Each zero-count grep applies ONLY if its "from Chunk N" annotation names this chunk or an earlier one in manifest order (0a, 7, 6, 9, 0b, 1, 1.5, 2, 3, 4, 5, 6.5, 8, 10 — this run is chunk "${chunk.id}", order ${chunk.order}); a grep whose effective chunk has not landed yet is out of scope — report it as skipped, NOT red. The grep scope excludes src/migrate/legacy/ (frozen legacy copy).
4. Net-LOC actuals (REPORTED, never pass/fail): git diff --shortstat $(git merge-base HEAD origin/${baseBranch})..HEAD -- src/ scripts/ ; test churn separately for tests/.
Do not fix anything; do not commit; never push. allGreen=true only if every pass/fail gate passed.`

let gate = await agent(gatePrompt(), { model: 'sonnet', schema: GATE_SCHEMA, label: 'chunk-gates', phase: 'Finalize' })

let repairReport = null
let repairRejected = false
if (gate && !gate.allGreen && !anyBlocked) {
  // One repair pass for mechanical gate failures — review-gated like all other
  // development — then re-run the gates.
  log('Chunk gates red — one repair pass')
  const failedGates = JSON.stringify(gate.results.filter((r) => !r.passed))
  const repairPrompt = `${CONTEXT}

ROLE: Developer (Sonnet 5) — chunk-gate repair for Chunk ${chunk.id} in ${wt} on ${chunk.branch}. The per-item reviews all passed but the whole-chunk gate run found failures: ${failedGates}
Fix ONLY these failures, minimally, without weakening any test or gate. If a reported failure looks out of scope for this chunk (e.g. a grep for an identifier a LATER chunk deletes), do NOT "fix" it — make no commits for it and report it as disputed in your notes. Commit with scoped messages. Never push. Report honestly.`
  repairReport = await runDev(repairPrompt, 'gate-repair')
  if (repairReport && repairReport.commits && repairReport.commits.length) {
    // The repair diff gets the same dual Opus review as every other change
    // before it can reach the pushed branch as accepted work.
    const repairCommon = `The repair instruction was: fix ONLY these gate failures, minimally, no test/gate weakening, nothing outside chunk scope: ${failedGates}
Repair dev report: ${JSON.stringify(repairReport)}
Inspect the actual repair commits in ${wt} (branch ${chunk.branch}) with git show: ${JSON.stringify(repairReport.commits)}. Full brief for scope rules: ${wt}/${briefPathRel}. READ-ONLY.
Verdict rule: pass=true ONLY with zero blocker and zero major findings. Anything beyond the minimal fix of the listed failures, any weakened test or gate, and anything trust-shaped or lifecycle-shaped is a blocker.`
    const [ra, rq] = await parallel([
      () => runReview('adherence', `${CONTEXT}

ROLE: Adherence reviewer (Opus 4.8) — gate-repair review for Chunk ${chunk.id}.
${repairCommon}`, 'review-repair-adherence'),
      () => runReview('quality', `${CONTEXT}

ROLE: Code-quality reviewer (Opus 4.8) — gate-repair review for Chunk ${chunk.id}. Apply the standard quality criteria to the repair diff.
${repairCommon}`, 'review-repair-quality'),
    ])
    if (ok(ra) && ok(rq)) {
      const rerun = await agent(gatePrompt(), { model: 'sonnet', schema: GATE_SCHEMA, label: 'chunk-gates-rerun', phase: 'Finalize' })
      if (rerun) gate = rerun // a dead rerun agent must not destroy the red-gate diagnostics
    } else {
      repairRejected = true
      log('gate-repair commits FAILED review — gates left as-is; the chunk goes to a human with the repair flagged')
    }
  } else if (repairReport) {
    log('gate-repair made no commits (failures disputed or unfixable) — gates left as-is for the human')
  }
}

const audit = await agent(
  `${CONTEXT}

ROLE: Chunk auditor (Opus 4.8) for Chunk ${chunk.id} (${chunk.title}) in ${wt}.
Inputs: manifest entry ${chunkJson}; brief ${wt}/${briefPathRel}; item results ${JSON.stringify(itemResults)}; gate results ${JSON.stringify(gate)}; gate-repair: ${JSON.stringify(repairReport)}${repairRejected ? ' — the repair commits FAILED review; flag them prominently in the report' : ''}; git log --oneline origin/${baseBranch}..HEAD.
Audit the WHOLE chunk: every brief work item is done or has a committed escalation report; every manifest gate is green or explicitly accounted for; the diff contains nothing outside the brief (sample it); net-LOC actuals vs the plan estimate (${chunk.netLoc}) — report the delta, it is not a gate; the chunk's §15 test bucket landed.
Write ${wt}/docs/design/execution/chunk-${chunk.id}/report.md — status, per-item outcomes, gate table, net-LOC actuals vs estimate, minors carried forward, blocked-item summaries with their escalation files — and commit it ("docs(chunk-${chunk.id}): chunk report"). Never push. pass=true only if all items done AND all gates green.`,
  { model: 'opus', effort: 'high', schema: AUDIT_SCHEMA, label: 'chunk-audit', phase: 'Finalize' },
)

// Push regardless of status: the branch (with brief, work, escalation reports)
// IS the human-review artifact. Never open a PR from the workflow.
const push = await agent(
  `In ${wt}: git push -u origin ${chunk.branch}. On network failure retry up to 4 times with 2s/4s/8s/16s backoff. Do NOT create a pull request. Do NOT push any other branch. Report the result.`,
  { model: 'sonnet', effort: 'low', schema: PUSH_SCHEMA, label: 'push-branch', phase: 'Finalize' },
)

const status = anyBlocked ? 'blocked'
  : anyDeferred ? 'partial'
  : (gate && gate.allGreen && audit && audit.pass && doneCount === brief.workItems.length) ? 'complete'
  : 'needs-human'

log(`Chunk ${chunk.id} finished: ${status} (${doneCount}/${brief.workItems.length} items done${anyBlocked ? `, blocked: ${blockedIds.join(', ')}` : ''})`)

return {
  chunk: chunk.id,
  title: chunk.title,
  status,
  branch: chunk.branch,
  baseBranch,
  worktree: wt,
  briefPath: briefPathRel,
  items: itemResults,
  gates: gate,
  repair: repairReport ? { rejected: repairRejected, commits: repairReport.commits, notes: repairReport.notes } : null,
  audit,
  pushed: push ? push.pushed : false,
  escalation: anyBlocked || status === 'needs-human' ? 'human — review the committed escalation report(s) and chunk report on the pushed branch' : null,
}
