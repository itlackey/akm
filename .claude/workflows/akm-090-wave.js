export const meta = {
  name: 'akm-090-wave',
  description: 'Execute several 0.9.0 plan chunks sequentially on one wave branch: per chunk, Opus-grounded brief, Sonnet test-first dev, Opus dual review gates, Opus escalation ladder',
  whenToUse: 'Batch runner for consecutive chunks sharing one branch/worktree (plan §11 "in-branch chunks"). Defaults to Wave-1 remainder (7, 6, 9) on akm-090/wave-1; for other batches, dispatch a launch copy with CHUNK_IDS/WAVE_BRANCH defaults edited (args are not forwarded in this runtime). Runbook: docs/design/akm-0.9.0-execution-workflow.md.',
  phases: [
    { title: 'Load', detail: 'manifest entries + preflight' },
    { title: 'Usage Gate', detail: 'Sonnet 5 measures the 5h/7d Claude Code usage windows; pauses until credits are available', model: 'sonnet' },
    { title: 'Setup', detail: 'wave branch worktree + green baseline' },
  ],
}

// ---------------------------------------------------------------------------
// Inputs & constants
// ---------------------------------------------------------------------------
const CHUNK_IDS = (args && args.chunks) || ['7', '6', '9']
const WAVE_BRANCH = (args && args.branch) || 'akm-090/wave-1'
const baseBranch = (args && args.baseBranch) || 'claude/akm-architecture-refactor-fubvd7'
const worktreeRoot = (args && args.worktreeRoot) || '/home/user/akm-worktrees'
const WAVE_DIR = WAVE_BRANCH.split('/').pop()

const REPO = '/home/user/akm'
const MANIFEST = 'docs/design/akm-0.9.0-chunk-manifest.json'
const PLAN = 'docs/design/akm-0.9.0-bundle-adapter-architecture-plan.md'
const ADAPTER_SPEC = 'docs/design/akm-0.9.0-bundle-adapter-spec.md'
const NORMATIVE_SPEC = 'docs/design/akm-format-neutral-bundle-workspace-spec.md'
const DECISIONS = 'docs/design/akm-architecture-decision-history.md'
const BUDGET_FLOOR = 80000

const USAGE_CEILING_5H_PCT = (args && args.usageCeiling5hPct) || 90
const USAGE_CEILING_7D_PCT = (args && args.usageCeiling7dPct) || 97
const MAX_USAGE_PAUSE_SECONDS = (args && args.maxUsagePauseSeconds) || 21600

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

const tfp = (cid) => `TEST-FIRST PROTOCOL — the work item's testMode selects the variant, and reviewers verify compliance via commit order:
- test-first: write the tests named in testsFirst FIRST; commit them separately (prefix "test(chunk-${cid}):"); run them and record that they FAIL for the expected reason (paste the failure in your report); then implement; then make them green. Never weaken an assertion to pass.
- characterization-preserve: the goldens/tests exist (or you capture them first, same separate-commit rule) and must KEEP passing UNCHANGED through your refactor; byte-for-byte where deterministic. Re-recording a golden outside its designated chunk is forbidden (plan §15.5).
- deletion-gate: the test is the gate — the zero-count grep plus the suite staying green after the deletion; land the replacement contract test in the SAME COMMIT as the deletion (plan §15.4) so the exhaustiveness guard never gaps.
- docs-assets: verification is the lints — shipped-assets lint, schema regen check (bun scripts/gen-config-schema.ts --check), link checks.`

// ---------------------------------------------------------------------------
// Schemas (identical to akm-090-chunk.js, plus multi-chunk load)
// ---------------------------------------------------------------------------
const CHUNK_PROPS = {
  id: { type: 'string' }, order: { type: 'integer' }, wave: { type: 'integer' },
  branch: { type: 'string' }, title: { type: 'string' }, scope: { type: 'string' },
  gates: { type: 'array', items: { type: 'string' } },
  netLoc: { type: 'string' }, testBucket: { type: 'string' },
  planRefs: { type: 'array', items: { type: 'string' } },
  notes: { type: 'string' },
}

const LOAD_SCHEMA = {
  type: 'object',
  required: ['found', 'chunks'],
  properties: {
    found: { type: 'boolean' },
    missing: { type: 'array', items: { type: 'string' } },
    chunks: { type: 'array', items: { type: 'object', required: ['id', 'order', 'wave', 'title', 'scope', 'gates', 'planRefs'], properties: CHUNK_PROPS } },
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

const ANCHOR_SCHEMA = {
  type: 'object', required: ['headSha'],
  properties: { headSha: { type: 'string' }, clean: { type: 'boolean' } },
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
      type: 'array', minItems: 1, maxItems: 4,
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

const USAGE_WINDOW = {
  type: 'object',
  required: ['utilizationPct', 'headroomPct', 'status', 'resetsAtEpoch', 'resetsAtIso'],
  properties: {
    utilizationPct: { type: 'number' }, headroomPct: { type: 'number' }, status: { type: 'string' },
    resetsAtEpoch: { type: 'integer' }, resetsAtIso: { type: 'string' }, resetsInMinutes: { type: 'number' },
  },
}

const USAGE_SCHEMA = {
  type: 'object',
  required: ['ok', 'probeWorked', 'unifiedStatus', 'fiveHour', 'sevenDay', 'waitSeconds', 'resumeAtEpoch', 'verdictReason'],
  properties: {
    ok: { type: 'boolean' },
    probeWorked: { type: 'boolean' },
    unifiedStatus: { type: 'string' },
    fiveHour: USAGE_WINDOW,
    sevenDay: USAGE_WINDOW,
    representativeClaim: { type: 'string' },
    overageStatus: { type: 'string' },
    waitSeconds: { type: 'integer' },
    resumeAtEpoch: { type: 'integer' },
    resumeAtIso: { type: 'string' },
    limitingWindow: { type: 'string' },
    verdictReason: { type: 'string' },
  },
}

// ---------------------------------------------------------------------------
// Helpers (identical semantics to akm-090-chunk.js)
// ---------------------------------------------------------------------------
function trimFindings(review) {
  if (!review || !review.findings) return []
  return review.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major')
}

function ok(review) {
  return !!review && review.pass === true && trimFindings(review).length === 0
}

function findingsDigest(history) {
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

async function runReview(kind, prompt, label, phaseName) {
  let r = await agent(prompt, { model: 'opus', effort: 'high', schema: REVIEW_SCHEMA, label, phase: phaseName })
  if (!r) {
    log(`review agent ${label} died; retrying once`)
    r = await agent(prompt, { model: 'opus', effort: 'high', schema: REVIEW_SCHEMA, label: `${label}-retry`, phase: phaseName })
  }
  return r || { pass: false, findings: [{ severity: 'blocker', description: `${kind} review agent failed to produce a verdict twice; treating as failed review` }], summary: 'review agent unavailable' }
}

async function runDev(promptText, label, phaseName) {
  let r = await agent(promptText, { model: 'sonnet', schema: DEV_SCHEMA, label, phase: phaseName })
  if (!r) {
    log(`dev agent ${label} died; retrying once`)
    r = await agent(promptText, { model: 'sonnet', schema: DEV_SCHEMA, label: `${label}-retry`, phase: phaseName })
  }
  return r
}

// Usage-window gate (spike-proven 2026-07-14; see runbook §6).
function usageProbePrompt(stage) {
  return `You are the USAGE GATE (Sonnet 5) for stage "${stage}" of an agent-team workflow. Measure the account's Claude Code usage windows and decide whether there is headroom to proceed, and if not, when more tokens will be available.

PROCEDURE (follow exactly):
1. Run the probe (a few tokens on the cheapest model):
   d=$(mktemp -d) && ANTHROPIC_LOG=debug timeout 120 claude -p --model claude-haiku-4-5-20251001 "Reply with exactly: OK" > "$d/usage-probe.log" 2>&1
2. Extract ONLY fields matching anthropic-ratelimit-* from the log (LAST occurrence of each). Do NOT print, quote, or return any other part of the log. Then rm -rf "$d".
3. Header semantics: unified-status is the overall verdict (allowed | allowed_warning | rejected); unified-5h-utilization and unified-7d-utilization are FRACTIONS 0.0-1.0 of each rolling window consumed (a value > 1.0 is already a percent — do not double-convert); unified-5h-reset / unified-7d-reset are unix epoch seconds when each window resets; unified-representative-claim names the binding window; unified-overage-status "rejected" means requests hard-fail once a window is exhausted.
4. Compute with date +%s / date -u: utilization and headroom of each window as PERCENTS; ISO-8601 UTC reset times and minutes until each; verdict ok=true iff unified-status is "allowed" AND 5h utilization <= ${USAGE_CEILING_5H_PCT}% AND 7d utilization <= ${USAGE_CEILING_7D_PCT}%; waitSeconds = 0 if ok, else seconds until the earliest reset of a window violating its ceiling; resumeAtEpoch = that reset epoch + 60 (0 if ok); limitingWindow.
5. If the probe command itself fails or no rate-limit headers appear, set probeWorked=false, ok=false, waitSeconds=-1, resumeAtEpoch=-1 and explain in verdictReason — never invent values.
Return the structured result; verdictReason is one honest sentence with the numbers.`
}

function sleeperPrompt(u, stage) {
  return `You are pausing an agent workflow until Claude Code usage-window credits are available (stage "${stage}"; reason: ${u.verdictReason}). Target time: unix epoch ${u.resumeAtEpoch} (${u.resumeAtIso || 'see epoch'}). Loop: read the current time with date +%s; if now >= ${u.resumeAtEpoch}, stop; otherwise sleep for min(600, remaining) seconds and repeat. Hard cap: 45 iterations. Do NOTHING else — no files, no repo access, no network. When done reply with the output of date -u.`
}

async function usageGate(stage) {
  for (;;) {
    let u = await agent(usageProbePrompt(stage), { model: 'sonnet', effort: 'low', schema: USAGE_SCHEMA, label: `usage-gate:${stage}`, phase: 'Usage Gate' })
    if (!u) {
      log(`usage probe (${stage}) died; retrying once`)
      u = await agent(usageProbePrompt(stage), { model: 'sonnet', effort: 'low', schema: USAGE_SCHEMA, label: `usage-gate:${stage}-retry`, phase: 'Usage Gate' })
    }
    if (!u || (!u.ok && u.waitSeconds < 0)) {
      return { proceed: false, usage: u || null, reason: 'usage probe failed — the window may already be exhausted; resume this wave manually once credits are available' }
    }
    if (u.ok) return { proceed: true, usage: u }
    if (u.waitSeconds > MAX_USAGE_PAUSE_SECONDS) {
      return { proceed: false, usage: u, reason: `limiting window (${u.limitingWindow}) resets at ${u.resumeAtIso || u.resumeAtEpoch} — beyond the in-run pause bound of ${Math.round(MAX_USAGE_PAUSE_SECONDS / 3600)}h; resume this wave after that reset` }
    }
    log(`usage gate (${stage}): pausing ~${Math.ceil(u.waitSeconds / 60)} min until ${u.resumeAtIso || u.resumeAtEpoch} — ${u.verdictReason}`)
    await agent(sleeperPrompt(u, stage), { model: 'sonnet', effort: 'low', label: `usage-wait:${stage}`, phase: 'Usage Gate' })
  }
}

// ---------------------------------------------------------------------------
// Phase: Load — all chunk entries for the wave
// ---------------------------------------------------------------------------
phase('Load')
const loaded = await agent(
  `Read ${REPO}/${MANIFEST} and return the chunk entries whose ids are exactly ${JSON.stringify(CHUNK_IDS)}, VERBATIM (no paraphrase), in that order, plus the manifest's globalGates and grepGateScope. Set found=false and list missing ids if any are absent.`,
  { model: 'haiku', effort: 'low', schema: LOAD_SCHEMA, label: 'load-manifest' },
)
if (!loaded || !loaded.found || !loaded.chunks || loaded.chunks.length !== CHUNK_IDS.length) {
  throw new Error(`Manifest load failed for chunks ${CHUNK_IDS.join(', ')}${loaded && loaded.missing ? ` (missing: ${loaded.missing.join(', ')})` : ''}`)
}
const globalGates = loaded.globalGates || []
const grepGateScope = loaded.grepGateScope || ''
log(`Wave ${WAVE_BRANCH}: chunks ${loaded.chunks.map((c) => `${c.id} (${c.title})`).join(' → ')} off ${baseBranch}`)

const startGate = await usageGate('wave-start')
if (!startGate.proceed) {
  return { wave: WAVE_BRANCH, status: 'paused-usage', detail: startGate.reason, usage: startGate.usage, chunks: [], escalation: 'resume this wave once the usage window has reset — nothing was started' }
}

// ---------------------------------------------------------------------------
// Phase: Setup — ONE worktree/branch for the whole wave
// ---------------------------------------------------------------------------
phase('Setup')
const setup = await agent(
  `${CONTEXT}

ROLE: Setup engineer for wave branch ${WAVE_BRANCH} (chunks ${CHUNK_IDS.join(', ')} run sequentially on this one branch — plan §11 "in-branch chunks").
1. In ${REPO}: git fetch origin ${baseBranch} (retry up to 4 times with 2s/4s/8s/16s backoff on network failure).
2. If a worktree already exists at ${worktreeRoot}/${WAVE_DIR}, REUSE it (this is a resume): git -C <path> status must be clean; report resumedExisting=true. Otherwise create it: mkdir -p ${worktreeRoot} && git -C ${REPO} worktree add ${worktreeRoot}/${WAVE_DIR} -B ${WAVE_BRANCH} origin/${baseBranch} (if the branch already exists on the remote, base on origin/${WAVE_BRANCH} instead to preserve prior work — report which you did).
3. In the worktree: bun install --frozen-lockfile.
4. Verify the design docs exist in the worktree at docs/design/ (the plan + specs + manifest). Report docsPresent accordingly.
5. Baseline gate: run ONLY 'bun run lint && bunx tsc --noEmit' in the worktree (compile + lint sanity, ~2 min). Do NOT run check:fast / test:unit / the full suite here — the base is the integration-branch tip that already passed a full 'bun run check' at the prior chunk's Finalize (full-suite green is inherited), and this chunk re-verifies the whole suite at its OWN Finalize gate; re-running 28k unit tests at every baseline is redundant and is the #1 wall-clock waste. baselineGreen=true only if BOTH lint and tsc pass. Include a short failure summary otherwise. Do NOT attempt to fix baseline failures — report them.
6. mkdir -p the per-chunk artifact dirs: ${CHUNK_IDS.map((c) => `<worktree>/docs/design/execution/chunk-${c}`).join(' ')}
Return worktreePath, branch, headSha (git rev-parse HEAD), and the fields in the schema. Never push. Never touch ${REPO}'s checked-out branch.`,
  { model: 'sonnet', schema: SETUP_SCHEMA, label: 'setup-worktree' },
)
if (!setup || !setup.ok) {
  return { wave: WAVE_BRANCH, status: 'blocked-setup', detail: setup ? setup.problems : 'setup agent died', chunks: [], escalation: 'human' }
}
const wt = setup.worktreePath
if (!setup.baselineGreen) {
  const where = setup.resumedExisting
    ? `in the RESUMED worktree on ${setup.branch} — the red may come from prior work-in-progress commits, not the base branch`
    : `in a fresh worktree off origin/${baseBranch} — the base itself is red`
  return { wave: WAVE_BRANCH, status: 'blocked-baseline', detail: `Baseline lint/tsc is RED ${where}. Nothing can be review-gated against a red baseline. ${setup.baselineSummary}`, chunks: [], escalation: 'human' }
}
log(`Worktree ready at ${wt} (${setup.branch} @ ${setup.headSha}); baseline green`)

const pushBranch = (phaseName) => agent(
  `In ${wt}: git push -u origin ${WAVE_BRANCH}. On network failure retry up to 4 times with 2s/4s/8s/16s backoff. Do NOT create a pull request. Do NOT push any other branch. Report the result.`,
  { model: 'sonnet', effort: 'low', schema: PUSH_SCHEMA, label: 'push-branch', phase: phaseName },
)

// ---------------------------------------------------------------------------
// Per-chunk pipeline — identical process to akm-090-chunk.js, sharing the
// wave worktree; each chunk's Finalize gate is the next chunk's baseline.
// ---------------------------------------------------------------------------
async function runChunk(chunk, isFirst) {
  const P = (name) => `${chunk.id}: ${name}` // per-chunk progress groups
  const chunkJson = JSON.stringify(chunk)
  const briefPathRel = `docs/design/execution/chunk-${chunk.id}/brief.md`

  // Anchor: the wave branch HEAD where this chunk starts (per-chunk ledger range).
  const anchor = await agent(
    `In ${wt}: run git rev-parse HEAD and git status --porcelain. Return headSha and clean=true iff status output is empty. Do nothing else.`,
    { model: 'haiku', effort: 'low', schema: ANCHOR_SCHEMA, label: `anchor:${chunk.id}`, phase: P('Ground') },
  )
  const chunkStartSha = anchor ? anchor.headSha : setup.headSha

  // ---- Plan -> brief, ONE pass (Lean grounding, user-approved 2026-07-15) ----
  // The plan document IS the detailed implementation design and the manifest
  // already decomposes each chunk (scope, gates, deletions, test bucket). One
  // Opus agent reads the relevant plan sections + the SPECIFIC files this chunk
  // touches and writes the brief. No separate extractor, no grounder fan-out, no
  // adversarial lens panel + revision rounds: those re-derived what the plan
  // already contains and cost ~60 min / tens of M tokens per chunk (measured on
  // chunk 7). The dual per-item review at implementation time is the real quality
  // gate; a wrong anchor in the brief surfaces there, cheaply.
  const brief = await agent(
    `${CONTEXT}

ROLE: Implementation planner (Opus 4.8) for Chunk ${chunk.id} (${chunk.title}). Turn the plan into an executable brief FAST. The plan is ALREADY the detailed design and the manifest already decomposes this chunk — do NOT re-derive them, do NOT survey the whole codebase.
Manifest entry (scope, gates, deletions, test bucket, plan refs): ${chunkJson}
Read, in the worktree ${wt}: only the plan's §11 paragraph for this chunk and the specific sections its planRefs name (not the whole plan), plus the adapter/normative spec sections it cites. Then read ONLY the specific source/test files this chunk names or obviously touches — grep to locate the symbols, read the relevant spans, spot-check just the few file:line anchors your work items depend on. Reading the entire codebase or re-verifying every anchor is exactly the waste this role exists to avoid.
Produce an ORDERED list of 3-5 work items (dependency order; dependsOn between them; prefer FEW LARGE items — each costs ~20-30 min of dev+review overhead, so item count drives wall-clock). Each work item: testMode (test-first | characterization-preserve | deletion-gate | docs-assets), testsFirst (specific test files/cases to write or preserve first), steps (concrete, file-anchored), files, deletions (exact files/symbols), acceptance (checkable, each traceable to a manifest gate or plan requirement), estLoc. Map every manifest gate into gateChecklist with the item(s) that satisfy it. Cover everything the manifest scope names; add NOTHING beyond plan scope — anything trust-shaped or lifecycle-shaped is out of scope by design (plan §1.3), say so explicitly so the dev does not add it.
Write the brief to ${wt}/${briefPathRel} (markdown: overview, key ground-truth facts with the anchors you actually verified, the work items, gate checklist, risks) and commit it on ${WAVE_BRANCH} ("docs(chunk-${chunk.id}): implementation brief"). Never push. Return the structured brief (briefPath = "${briefPathRel}").`,
    { model: 'opus', effort: 'high', schema: BRIEF_SCHEMA, label: `brief:${chunk.id}`, phase: P('Ground') },
  )
  if (!brief) return { chunk: chunk.id, status: 'blocked-grounding', detail: 'brief author failed' }
  log(`Chunk ${chunk.id} brief: ${brief.workItems.length} work items`)
  // Durability: push the committed brief immediately (a recycle must not lose it).
  await pushBranch(P('Ground'))

  // ---- Implement / Review / Escalate ----
  const itemResults = []
  const blockedIds = []
  let usagePause = null

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
    const itemGate = await usageGate(`${chunk.id}:item:${item.id}`)
    if (!itemGate.proceed) {
      usagePause = itemGate
      for (let j = i; j < brief.workItems.length; j++) itemResults.push({ itemId: brief.workItems[j].id, status: 'deferred-usage' })
      break
    }

    const itemJson = JSON.stringify(item)
    const history = []
    let guidance = null
    let status = 'blocked'
    let devReport = null

    const devPrompt = (attempt) => `${CONTEXT}

ROLE: Developer (Sonnet 5), attempt ${attempt} of 3, work item ${item.id} — ${item.title} (Chunk ${chunk.id}: ${chunk.title}).
Work ONLY in the worktree ${wt} on branch ${WAVE_BRANCH}. Never push. Never switch branches. Never touch ${REPO}'s own checkout.
FIRST read the full implementation brief at ${wt}/${briefPathRel}. Your work item (structured): ${itemJson}
${tfp(chunk.id)}
Scope discipline: implement EXACTLY this work item — its steps, files, deletions, acceptance. Nothing beyond it (other items handle the rest); nothing trust-shaped or lifecycle-shaped ever. If the brief turns out to be wrong about the code, do the minimal faithful interpretation and record it in deviations — reviewers check deviations against the brief.
Do not modify docs/design/** except docs/design/execution/chunk-${chunk.id}/** (Chunk 10 items may override this explicitly in their steps).
${history.length ? findingsDigest(history) : ''}
${guidance ? `ARCHITECT GUIDANCE (Opus 4.8 escalation — this clarifies/overrides ambiguous parts of the brief):\n${JSON.stringify(guidance)}` : ''}
SPEED DISCIPLINE: never run a full test suite (bun run check, check:fast, test, test:unit, test:integration) — one suite run costs 10+ minutes in this container and suite-level verification is the Finalize gate's job, run once per chunk. Verify with the item's own test files (bun test <paths>), bunx tsc --noEmit, and lint scoped to touched files (bunx biome check <files>). Batch related shell commands instead of issuing many small ones.
When done: all work committed with scoped messages (test(chunk-${chunk.id}):/refactor(chunk-${chunk.id}):/feat(chunk-${chunk.id}):/docs(chunk-${chunk.id}):), item tests run (item-scoped, per above). Report honestly — failing tests are reported as failing, never hidden. Include failingFirstEvidence (the recorded pre-implementation failure output) for test-first items.`

    devReport = await runDev(devPrompt(1), `dev:${chunk.id}:${item.id}`, P('Implement'))

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!devReport) {
        history.push({ attempt, adherence: { pass: false, findings: [{ severity: 'blocker', description: 'developer agent died without a report' }], summary: 'no dev report' }, quality: { pass: false, findings: [], summary: 'no dev report' } })
      } else {
        const reviewCommon = `Work item (structured): ${itemJson}
Full brief: ${wt}/${briefPathRel}. Developer report: ${JSON.stringify(devReport)}
Inspect the ACTUAL work in the worktree ${wt} (branch ${WAVE_BRANCH}): git log --oneline ${chunkStartSha}..HEAD for commit order, git diff + git show for content, and run commands to verify claims (bun test <the item's test paths>, bunx tsc --noEmit, bunx biome check on the changed files) — never trust the report over the code. Do NOT run full suites (check, check:fast, test:unit, test:integration); suite-level verification belongs to the Finalize gate and costs 10+ minutes here. READ-ONLY: no commits, no file edits, no branch changes, no push.
Verdict rule: pass=true ONLY with zero blocker and zero major findings. blocker = violates a plan gate or hard rule (incl. anything trust-shaped/lifecycle-shaped in the diff), wrong behavior, missing requirement, unjustified deviation, test weakened to pass. major = real quality defect (see criteria). minor = nit — record it, it does not block. Every finding needs evidence (file:line or command output) and a requiredFix.`

        const [adherence, quality] = await parallel([
          () => runReview('adherence', `${CONTEXT}

ROLE: Adherence reviewer (Opus 4.8), attempt ${attempt}, item ${item.id}, Chunk ${chunk.id}. You review STRICT ADHERENCE to the implementation brief — the brief is the contract.
${reviewCommon}
Check: (1) every step/deletion/acceptance criterion of the item is actually implemented, with diff evidence; (2) commit order proves the test-first protocol for the item's testMode (tests committed before implementation; goldens unchanged for characterization-preserve; same-commit replacement tests for deletion-gate); (3) NOTHING in the diff falls outside this work item's scope — out-of-scope changes are majors, trust/lifecycle-shaped additions are blockers (plan §1.3/§12.4); (4) each reported deviation is faithful-minimal and justified against the brief and plan; (5) reported test results match reality when re-run (item-scoped).`, `review-adherence:${chunk.id}:${item.id}#${attempt}`, P('Review')),
          () => runReview('quality', `${CONTEXT}

ROLE: Code-quality reviewer (Opus 4.8), attempt ${attempt}, item ${item.id}, Chunk ${chunk.id}. You measure the work against established code-quality criteria.
${reviewCommon}
Criteria: cyclomatic complexity + length of touched functions (a new god fn >~200 LOC is a blocker in improve, a major elsewhere); duplication introduced (DRY); cohesion/coupling — SRP per module, dependency direction respected (no new layer-crossing imports, no new import cycles); naming + idiom consistency with the surrounding code (comment discipline: constraints only, no narration); type safety (no new any — repo is moving noExplicitAny to error — no unsafe casts, typed errors where the chunk mandates); dead code left behind after deletions (orphaned exports/helpers); error handling on new paths; TEST QUALITY — behavioral assertions not implementation-mirroring, edge cases covered, failing-first evidence present and plausible, isolation (sandbox helpers, no rogue mkdtemp, mock.module ban respected); commit hygiene (scoped messages, logical units).`, `review-quality:${chunk.id}:${item.id}#${attempt}`, P('Review')),
        ])
        history.push({ attempt, adherence, quality })
        for (const [kind, r] of [['adherence', adherence], ['quality', quality]]) {
          if (r && r.pass === true && trimFindings(r).length > 0) {
            log(`WARNING: ${kind} reviewer self-reported pass=true with ${trimFindings(r).length} blocker/major finding(s) on ${chunk.id}/${item.id} — verdict is derived from findings; treating as FAILED`)
          }
        }
        if (ok(adherence) && ok(quality)) {
          status = 'done'
          const minors = [...(adherence.findings || []), ...(quality.findings || [])].filter((f) => f.severity === 'minor')
          itemResults.push({ itemId: item.id, status, attempts: attempt, commits: devReport.commits, minors })
          log(`Chunk ${chunk.id} item ${item.id} PASSED review on attempt ${attempt}${minors.length ? ` (${minors.length} minor note(s))` : ''}`)
          break
        }
        log(`Chunk ${chunk.id} item ${item.id} review attempt ${attempt} FAILED (${trimFindings(adherence).length} adherence + ${trimFindings(quality).length} quality blocker/major)`)
      }

      if (attempt === 3) break

      if (attempt === 2) {
        guidance = await agent(
          `${CONTEXT}

ROLE: Escalation architect (Opus 4.8). Work item ${item.id} of Chunk ${chunk.id} has FAILED Opus review twice. The Opus reviewers escalate to you for assistance and clarification before the final attempt.
Work item: ${itemJson}
Brief: ${wt}/${briefPathRel}. Review history (both rounds, both reviewers): ${JSON.stringify(history)}
Latest developer report: ${JSON.stringify(devReport)}
Examine the actual code in ${wt} (read-only). Diagnose the ROOT CAUSE: is the developer misreading the brief, is the brief ambiguous or wrong about the code, or are the reviewers applying a criterion incorrectly? Ground your judgment in the plan (${PLAN}) — it is the authority.
Produce: diagnosis; concrete step-by-step guidance the developer can execute; briefAmendments if the brief itself needs correction (also EDIT ${wt}/${briefPathRel} accordingly and commit "docs(chunk-${chunk.id}): brief amendment for ${item.id}" — this is the one write you may make); recommendBlock=true with questionsForHuman if the item is genuinely mis-scoped against the plan and no third attempt can succeed.`,
          { model: 'opus', effort: 'xhigh', schema: ASSIST_SCHEMA, label: `assist:${chunk.id}:${item.id}`, phase: P('Escalate') },
        )
        if (guidance && guidance.recommendBlock) {
          log(`Opus escalation architect recommends blocking ${chunk.id}/${item.id} without a third attempt`)
          break
        }
      }

      devReport = await runDev(devPrompt(attempt + 1), `dev:${chunk.id}:${item.id}#${attempt + 1}`, P('Implement'))
    }

    if (status !== 'done') {
      const ladderPath = guidance && guidance.recommendBlock
        ? `dev + dual review ×${history.length}; the Opus-4.8 escalation architect then recommended blocking WITHOUT a third attempt (item judged mis-scoped against the plan)`
        : `the full ladder (${history.length} dev attempt(s) + dual review each, with Opus-4.8 assistance before the final attempt)`
      const block = await agent(
        `${CONTEXT}

ROLE: Escalation reporter (Opus 4.8). Work item ${item.id} of Chunk ${chunk.id} is BLOCKED after ${ladderPath}. A human maintainer will pick this up — write the report that lets them decide in one sitting; describe only what actually ran, per the history below.
Work item: ${itemJson}. Review history: ${JSON.stringify(history)}. Opus escalation guidance given: ${JSON.stringify(guidance)}. Last dev report: ${JSON.stringify(devReport)}
Write ${wt}/docs/design/execution/chunk-${chunk.id}/escalation-${item.id}.md: what the item requires (with plan anchors), what was attempted (commits), exactly why review keeps failing (the unresolved findings, verbatim), the root-cause diagnosis, and SPECIFIC questions/decisions for the human. Commit it on ${WAVE_BRANCH} ("docs(chunk-${chunk.id}): escalation report for ${item.id}"). Leave the work-in-progress commits in place — do not revert anything. Never push.`,
        { model: 'opus', effort: 'high', schema: BLOCK_SCHEMA, label: `block:${chunk.id}:${item.id}`, phase: P('Escalate') },
      )
      blockedIds.push(item.id)
      itemResults.push({ itemId: item.id, status: 'blocked', attempts: history.length, escalation: block || { summary: 'escalation reporter died; see review history in workflow result' } })
      log(`Chunk ${chunk.id} item ${item.id} BLOCKED — escalation report committed`)
    }

    // Durability push: every concluded item (done or blocked) reaches the
    // remote immediately.
    await pushBranch(P('Implement'))
  }

  // ---- Finalize ----
  const anyBlocked = blockedIds.length > 0

  if (!usagePause) {
    const fg = await usageGate(`${chunk.id}:finalize`)
    if (!fg.proceed) usagePause = fg
  }
  if (usagePause) {
    const pausePush = await pushBranch(P('Finalize'))
    return {
      chunk: chunk.id, title: chunk.title, status: 'paused-usage', detail: usagePause.reason,
      usage: usagePause.usage, briefPath: briefPathRel, items: itemResults,
      pushed: pausePush ? pausePush.pushed : false,
    }
  }

  const gatePrompt = () => `${CONTEXT}

ROLE: Chunk gate runner for Chunk ${chunk.id} in worktree ${wt} (branch ${WAVE_BRANCH}).
Run and report every gate honestly:
1. bun run check (full: lint + tsc + unit + integration). Any failure = that gate red.
2. Each chunk gate: ${JSON.stringify(chunk.gates)} — grep-style gates run as rg counts at the declared scope (${grepGateScope}); artifact gates (ledgers, fixtures) verify the artifact exists in the tree; behavior gates run the named suites.
3. Global gates: ${JSON.stringify(globalGates)}. Safety suites and the deletion-ledger requirement apply at EVERY chunk boundary. Each zero-count grep applies ONLY if its "from Chunk N" annotation names this chunk or an earlier one in manifest order (0a, 7, 6, 9, 0b, 1, 1.5, 2, 3, 4, 5, 6.5, 8, 10 — this is chunk "${chunk.id}", order ${chunk.order}); a grep whose effective chunk has not landed yet is out of scope — report it as skipped, NOT red. The grep scope excludes src/migrate/legacy/ (frozen legacy copy).
4. Net-LOC actuals (REPORTED, never pass/fail) for THIS chunk only: git diff --shortstat ${chunkStartSha}..HEAD -- src/ scripts/ ; test churn separately for tests/.
Do not fix anything; do not commit; never push. allGreen=true only if every pass/fail gate passed.`

  let gate = await agent(gatePrompt(), { model: 'sonnet', schema: GATE_SCHEMA, label: `chunk-gates:${chunk.id}`, phase: P('Finalize') })

  let repairReport = null
  let repairRejected = false
  if (gate && !gate.allGreen && !anyBlocked) {
    log(`Chunk ${chunk.id} gates red — one repair pass`)
    const failedGates = JSON.stringify(gate.results.filter((r) => !r.passed))
    const repairPrompt = `${CONTEXT}

ROLE: Developer (Sonnet 5) — chunk-gate repair for Chunk ${chunk.id} in ${wt} on ${WAVE_BRANCH}. The per-item reviews all passed but the whole-chunk gate run found failures: ${failedGates}
Fix ONLY these failures, minimally, without weakening any test or gate. If a reported failure looks out of scope for this chunk (e.g. a grep for an identifier a LATER chunk deletes), do NOT "fix" it — make no commits for it and report it as disputed in your notes. Verify with the specific failing tests/checks only — do not run full suites; the gate re-run does that. Commit with scoped messages. Never push. Report honestly.`
    repairReport = await runDev(repairPrompt, `gate-repair:${chunk.id}`, P('Implement'))
    if (repairReport && repairReport.commits && repairReport.commits.length) {
      const repairCommon = `The repair instruction was: fix ONLY these gate failures, minimally, no test/gate weakening, nothing outside chunk scope: ${failedGates}
Repair dev report: ${JSON.stringify(repairReport)}
Inspect the actual repair commits in ${wt} (branch ${WAVE_BRANCH}) with git show: ${JSON.stringify(repairReport.commits)}. Full brief for scope rules: ${wt}/${briefPathRel}. READ-ONLY.
Verdict rule: pass=true ONLY with zero blocker and zero major findings. Anything beyond the minimal fix of the listed failures, any weakened test or gate, and anything trust-shaped or lifecycle-shaped is a blocker.`
      const [ra, rq] = await parallel([
        () => runReview('adherence', `${CONTEXT}

ROLE: Adherence reviewer (Opus 4.8) — gate-repair review for Chunk ${chunk.id}.
${repairCommon}`, `review-repair-adherence:${chunk.id}`, P('Review')),
        () => runReview('quality', `${CONTEXT}

ROLE: Code-quality reviewer (Opus 4.8) — gate-repair review for Chunk ${chunk.id}. Apply the standard quality criteria to the repair diff.
${repairCommon}`, `review-repair-quality:${chunk.id}`, P('Review')),
      ])
      if (ok(ra) && ok(rq)) {
        const rerun = await agent(gatePrompt(), { model: 'sonnet', schema: GATE_SCHEMA, label: `chunk-gates-rerun:${chunk.id}`, phase: P('Finalize') })
        if (rerun) gate = rerun
      } else {
        repairRejected = true
        log(`Chunk ${chunk.id} gate-repair commits FAILED review — gates left as-is; the chunk goes to a human with the repair flagged`)
      }
    } else if (repairReport) {
      log(`Chunk ${chunk.id} gate-repair made no commits (failures disputed or unfixable) — gates left as-is for the human`)
    }
  }

  const audit = await agent(
    `${CONTEXT}

ROLE: Chunk auditor (Opus 4.8) for Chunk ${chunk.id} (${chunk.title}) in ${wt}.
Inputs: manifest entry ${chunkJson}; brief ${wt}/${briefPathRel}; item results ${JSON.stringify(itemResults)}; gate results ${JSON.stringify(gate)}; gate-repair: ${JSON.stringify(repairReport)}${repairRejected ? ' — the repair commits FAILED review; flag them prominently in the report' : ''}; git log --oneline ${chunkStartSha}..HEAD.
Audit the WHOLE chunk: every brief work item is done or has a committed escalation report; every manifest gate is green or explicitly accounted for; the diff contains nothing outside the brief (sample it); net-LOC actuals vs the plan estimate (${chunk.netLoc}) — report the delta, it is not a gate; the chunk's §15 test bucket landed.
Write ${wt}/docs/design/execution/chunk-${chunk.id}/report.md — status, per-item outcomes, gate table, net-LOC actuals vs estimate, minors carried forward, blocked-item summaries with their escalation files — and commit it ("docs(chunk-${chunk.id}): chunk report"). Never push. pass=true only if all items done AND all gates green.`,
    { model: 'opus', effort: 'high', schema: AUDIT_SCHEMA, label: `chunk-audit:${chunk.id}`, phase: P('Finalize') },
  )

  const push = await pushBranch(P('Finalize'))

  const doneCount = itemResults.filter((r) => r.status === 'done').length
  const anyDeferred = itemResults.some((r) => r.status === 'deferred-budget' || r.status === 'skipped-upstream-blocked')
  const status = anyBlocked ? 'blocked'
    : anyDeferred ? 'partial'
    : (gate && gate.allGreen && audit && audit.pass && doneCount === brief.workItems.length) ? 'complete'
    : 'needs-human'

  log(`Chunk ${chunk.id} finished: ${status} (${doneCount}/${brief.workItems.length} items done${anyBlocked ? `, blocked: ${blockedIds.join(', ')}` : ''})`)

  return {
    chunk: chunk.id, title: chunk.title, status, briefPath: briefPathRel,
    items: itemResults, gates: gate,
    repair: repairReport ? { rejected: repairRejected, commits: repairReport.commits, notes: repairReport.notes } : null,
    audit, pushed: push ? push.pushed : false,
  }
}

// ---------------------------------------------------------------------------
// The wave loop: stop at the first non-complete chunk (its gates are the next
// chunk's baseline — building on a red or blocked base is never allowed).
// ---------------------------------------------------------------------------
const chunkResults = []
let stoppedAt = null
for (let i = 0; i < loaded.chunks.length; i++) {
  const c = loaded.chunks[i]
  const r = await runChunk(c, i === 0)
  chunkResults.push(r)
  if (r.status !== 'complete') {
    stoppedAt = c.id
    log(`Wave stopped at chunk ${c.id} (${r.status}) — remaining chunks not started`)
    break
  }
}

const waveStatus = stoppedAt ? 'stopped' : 'complete'
return {
  wave: WAVE_BRANCH,
  baseBranch,
  worktree: wt,
  status: waveStatus,
  stoppedAt,
  chunksPlanned: CHUNK_IDS,
  chunks: chunkResults,
  escalation: stoppedAt
    ? `chunk ${stoppedAt} ended ${chunkResults[chunkResults.length - 1].status} — review its report/escalations on the pushed wave branch, resolve, then re-run this wave (completed chunks replay from cache on resume)`
    : `all chunks complete — merge ${WAVE_BRANCH} into ${baseBranch} after review`,
}
