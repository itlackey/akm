export const meta = {
  name: 'batch',
  description: 'Implement a batch of independent work items in parallel worktrees (Sonnet), review each as it lands (Sonnet), integrate and gate once, then one Opus/Fable final review that loops back with a brief of its findings',
  whenToUse: 'The template for every implement-and-review batch. Invoke with args {batch, baseSha, brief, items: [{key, title, issue?, scope?}], repoRoot?, rules?, gate?, finalReviewModel?, maxIterations?}. See .claude/workflows/README.md.',
  phases: [
    { title: 'Implement', detail: 'one Sonnet agent per item, each in its own worktree, one commit per logical change' },
    { title: 'Review', detail: 'one Sonnet reviewer per item as soon as that item lands; one fix round' },
    { title: 'Integrate', detail: 'merge the item branches into the batch branch and run the gate once' },
    { title: 'Final review', detail: 'Opus/Fable reviews the whole batch diff; findings become the next iteration brief', model: 'opus' },
  ],
}

// ---------------------------------------------------------------------------
// Why this shape
// ---------------------------------------------------------------------------
// The serial shape (implement -> review -> fix -> review, one item at a time in
// one worktree, then a gate that runs every suite twice) costs about 15 minutes
// per item plus 20 for the gate, on a box that can run several agents at once.
// This template instead:
//   - gives every item its own worktree so implementations run in parallel
//     (bounded only by the runtime's per-workflow agent cap);
//   - pipelines each item's review behind its own implementation, with no
//     barrier, so item B's review overlaps item C's implementation;
//   - never runs the full suites inside an item agent — implementers run the
//     focused tests, lint and typecheck; the whole-repo gate runs ONCE, after
//     integration;
//   - puts one strong reviewer (Opus or Fable) at the end, over the integrated
//     diff, instead of a second Sonnet round per item; its findings become the
//     brief for the next iteration, so review effort is spent once, on the
//     real result.

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

// The runtime may hand `args` over as an object or as a JSON string.
function normalizeArgs(raw) {
  if (raw == null) return {}
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { throw new Error(`args must be a JSON object, got: ${raw}`) }
  }
  return raw
}

const input = normalizeArgs(args)
const BATCH = input.batch
const REPO = input.repoRoot ?? '/home/user/akm'
const BASE = input.baseSha
const BRIEF = input.brief
const ITEMS = Array.isArray(input.items) ? input.items : []
// Extra rule files every agent reads (e.g. a release's COMMON.md). AGENTS.md is
// always read; do not list it here.
const RULES = Array.isArray(input.rules) ? input.rules : input.rules ? [input.rules] : []
// The one whole-repo gate, run once per iteration after integration. Pass the
// release check for a release candidate.
const GATE = input.gate ?? 'TMPDIR=/tmp bun run check'
const FINAL_MODEL = input.finalReviewModel ?? 'opus'
// Iteration 1 implements the brief; each later iteration implements the final
// reviewer's findings. Bounded so a review that never comes clean escalates to
// a human instead of grinding.
const MAX_ITERATIONS = input.maxIterations ?? 2

if (!BATCH || !BASE || !BRIEF || ITEMS.length === 0) {
  throw new Error(`batch needs args {batch, baseSha, brief, items[]}; got ${JSON.stringify(input)}`)
}
for (const item of ITEMS) {
  if (!item.key || !item.title) throw new Error(`every item needs key and title: ${JSON.stringify(item)}`)
}

const BATCH_BRANCH = `wt/${BATCH}`
const BATCH_WORKTREE = `${REPO}/.claude/worktrees/${BATCH}`
const BRIEF_DIR = BRIEF.slice(0, BRIEF.lastIndexOf('/'))
const itemBranch = (key) => `wt/${BATCH}/${key}`
const itemWorktree = (key) => `${REPO}/.claude/worktrees/${BATCH}-${key}`

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const FINDING = {
  type: 'object',
  required: ['severity', 'file', 'summary', 'requiredChange'],
  properties: {
    severity: { type: 'string', enum: ['CONFIRMED', 'ADVISORY'] },
    file: { type: 'string' },
    line: { type: 'integer' },
    summary: { type: 'string' },
    requiredChange: { type: 'string' },
  },
}

const WORK_SCHEMA = {
  type: 'object',
  required: ['summary', 'commits', 'testsRun', 'deviations', 'headSha'],
  properties: {
    summary: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    testsRun: { type: 'array', items: { type: 'object', required: ['command', 'pass', 'fail'], properties: { command: { type: 'string' }, pass: { type: 'integer' }, fail: { type: 'integer' } } } },
    // A brief-vs-code disagreement is reported here, never silently resolved.
    deviations: { type: 'array', items: { type: 'string' } },
    headSha: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'nullImplementationWouldPass', 'findings', 'notes'],
  properties: {
    verdict: { type: 'string', enum: ['CLEAN', 'CHANGES_REQUIRED'] },
    // If a do-nothing change would pass the new tests, the tests are theatre.
    nullImplementationWouldPass: { type: 'boolean' },
    findings: { type: 'array', items: FINDING },
    notes: { type: 'string' },
  },
}

const INTEGRATE_SCHEMA = {
  type: 'object',
  required: ['headSha', 'merged', 'conflicts', 'gatePassed', 'gateOutput', 'fixesApplied'],
  properties: {
    headSha: { type: 'string' },
    merged: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'string' } },
    gatePassed: { type: 'boolean' },
    gateOutput: { type: 'string' },
    fixesApplied: { type: 'array', items: { type: 'string' } },
  },
}

const FINAL_SCHEMA = {
  type: 'object',
  required: ['verdict', 'findings', 'nextItems', 'briefPath', 'notes'],
  properties: {
    verdict: { type: 'string', enum: ['CLEAN', 'CHANGES_REQUIRED'] },
    findings: { type: 'array', items: FINDING },
    // The next iteration's work items, one per independent fix, each carrying
    // the finding(s) it addresses and the recommended fix.
    nextItems: { type: 'array', items: { type: 'object', required: ['key', 'title', 'details'], properties: { key: { type: 'string' }, title: { type: 'string' }, details: { type: 'string' } } } },
    // Path of the brief written for the next iteration ('' when CLEAN).
    briefPath: { type: 'string' },
    notes: { type: 'string' },
  },
}

// ---------------------------------------------------------------------------
// Prompts — pointers to files, not pasted rules; each agent keeps a small context
// ---------------------------------------------------------------------------

const confirmedOf = (review) => (review?.findings ?? []).filter((f) => f.severity === 'CONFIRMED')
const renderFindings = (findings) =>
  findings.map((f, i) => `${i + 1}. [${f.file}${f.line ? `:${f.line}` : ''}] ${f.summary}\n   Required change: ${f.requiredChange}`).join('\n')
const issueTag = (item) => (item.issue ? ` (#${item.issue})` : '')
const subjectSuffix = (item) => (item.issue ? `(#${item.issue})` : `(${BATCH})`)

function readingList(brief) {
  const lines = [`- ${REPO}/AGENTS.md — the repository's rules.`, ...RULES.map((r) => `- ${r}`), `- ${brief} — the brief for this iteration. Implement ONLY your item.`]
  return `Read first:\n${lines.join('\n')}`
}

function implPrompt(item, brief, base) {
  const wt = itemWorktree(item.key)
  return `You are a senior TypeScript engineer implementing item ${item.key} — ${item.title}${issueTag(item)} — of batch "${BATCH}".
${item.details ? `\nItem details:\n${item.details}\n` : ''}${item.scope ? `\nFiles in scope: ${item.scope}\n` : ''}
${readingList(brief)}

Set up your own worktree, and work ONLY inside it (never edit ${REPO} itself, never push):
  cd ${REPO} && git worktree add ${wt} -b ${itemBranch(item.key)} ${base} && cd ${wt} && bun install --frozen-lockfile

Then:
- Read the code the item names before changing it. Test first: the new test must FAIL against the unchanged code — run it both ways and record both results in testsRun.
- Surgical: touch only what the item needs; match existing style; no new config keys or magic numbers unless the brief asks; reuse existing helpers instead of duplicating them; real issue numbers only.
- One commit per logical change: a test with the code that makes it pass; docs with their CHANGELOG bullet; a schema change with its regenerated output (\`bun scripts/gen-config-schema.ts\`). Conventional subject ending in "${subjectSuffix(item)}"; trailers per the rules files.
- Before each commit: \`bunx biome check --write src/ tests/\` and \`bunx tsc --noEmit\`. Before finishing: the focused tests for your change and \`bun run lint\`. Do NOT run the full unit or integration suites — the batch gate runs them once after integration.
- Finish with \`git status\` clean. Return ONLY the structured output (commits from \`git log --format=%h\\ %s --reverse ${base}..HEAD\`).`
}

function reviewPrompt(item, brief, base, work) {
  const wt = itemWorktree(item.key)
  return `You are an adversarial senior reviewer for item ${item.key} — ${item.title}${issueTag(item)} — of batch "${BATCH}". You did not write this code.

${readingList(brief)}

The diff is \`git diff ${base}..${work.headSha}\` in ${wt} (commits: ${work.commits.join('; ')}). The implementer reported: ${JSON.stringify(work.summary)}. Deviations: ${JSON.stringify(work.deviations)}.

Review for: the item done exactly as the brief specifies (missing or partial = CONFIRMED); correctness and hidden defects; duplication of an existing helper or a second copy of existing logic (= CONFIRMED); tests that pin the new behaviour (would a do-nothing change pass?), using the repo's sandbox helpers; docs and CHANGELOG accurate against the code; the rules files honoured. Verify by running \`bunx biome check src/ tests/\`, \`bunx tsc --noEmit\`, and the new/changed test files (\`TMPDIR=/tmp bun test <file>\`) in ${wt}. Do NOT modify any file.

CONFIRMED = verified wrong or missing, must change (say exactly what). ADVISORY = judgment call. Return ONLY the structured output.`
}

function fixPrompt(item, brief, findings) {
  const wt = itemWorktree(item.key)
  return `You are the engineer who implemented item ${item.key}${issueTag(item)} of batch "${BATCH}" in ${wt} (branch ${itemBranch(item.key)}). A reviewer confirmed these findings; apply each minimally, or — only if one is factually wrong — say why in deviations:

${renderFindings(findings)}

${readingList(brief)}

Rules: work only in ${wt}; surgical; \`bunx biome check --write src/ tests/\` and \`bunx tsc --noEmit\` before committing; one commit naming the finding(s), subject ending in "${subjectSuffix(item)}", trailers per the rules files; run the affected test files; \`git status\` clean. Do NOT run the full suites. Return ONLY the structured output (headSha = HEAD after your commit).`
}

function integratePrompt(base, landed) {
  return `You are the integrator for batch "${BATCH}" in ${REPO}.

Read ${REPO}/AGENTS.md${RULES.length ? ` and ${RULES.join(', ')}` : ''}. Never skip, disable or quarantine a test. Never push.

1. Batch worktree: ${BATCH_WORKTREE} on branch ${BATCH_BRANCH}. If it does not exist: \`cd ${REPO} && git worktree add ${BATCH_WORKTREE} -b ${BATCH_BRANCH} ${base}\`. If it exists, its HEAD must be ${base} (report and stop if not). Then \`cd ${BATCH_WORKTREE} && bun install --frozen-lockfile\`.
2. Merge each item branch with \`git merge --no-ff <branch> -m "merge: <key> — <title>"\`, in this order:
${landed.map((l) => `   - ${itemBranch(l.item.key)} at ${l.headSha} (${l.item.key}: ${l.item.title})`).join('\n')}
   Items were designed to be independent. If a merge conflicts, resolve it minimally so BOTH items' behaviour survives, and list it in conflicts; if both sides changed the same logic and either resolution loses behaviour, stop and report.
3. Gate, from ${BATCH_WORKTREE}: \`bun scripts/gen-config-schema.ts && git status --porcelain schemas/\` (must print nothing), then \`${GATE}\`. Capture the final summary lines in gateOutput.
4. If the gate fails: read the failure; if it is caused by this batch (the base ${base} was green), fix it minimally, \`bunx biome check --write src/ tests/\`, commit (trailers per the rules files) and re-run only the failed step; list every fix in fixesApplied. If it is unrelated to the batch, say exactly why with evidence and leave gatePassed false.
5. Clean up: \`git worktree remove <item worktree>\` and \`git branch -d <item branch>\` for every merged item (they are now in ${BATCH_BRANCH}).
6. Return ONLY the structured output (headSha = HEAD of ${BATCH_BRANCH}).`
}

function finalReviewPrompt(iteration, headSha, briefs) {
  const nextBrief = `${BRIEF_DIR}/${BATCH}-iter${iteration + 1}.md`
  return `You are the final reviewer for batch "${BATCH}" (iteration ${iteration} of at most ${MAX_ITERATIONS}). The batch is integrated in ${BATCH_WORKTREE} (branch ${BATCH_BRANCH}, head ${headSha}); the full diff is \`git diff ${BASE}..${headSha}\`.

Read ${REPO}/AGENTS.md${RULES.length ? `, ${RULES.join(', ')}` : ''}, and the brief(s): ${briefs.join(', ')}.

Review the WHOLE diff as the engineer accountable for shipping it: every brief item delivered exactly as specified; correctness, hidden defects, races, error paths; duplication or unnecessary complexity (SOLID/DRY — a second helper, a second classifier, a knob nobody asked for); tests that pin behaviour (would a do-nothing change pass?), none skipped or weakened; docs and CHANGELOG accurate against the code; commit hygiene (one logical change per commit, real issue numbers, no model names). Run \`bunx biome check src/ tests/\` and \`bunx tsc --noEmit\`; run any test file you doubt. Do NOT modify src/, tests/ or docs/.

If anything must change (CONFIRMED): group the findings into independent work items and write the next iteration's brief to ${nextBrief} — for each item: the finding(s), exact files and lines, the recommended fix, and how to test it. Return those items in nextItems (keys r${iteration + 1}-1, r${iteration + 1}-2, …) and the path in briefPath, verdict CHANGES_REQUIRED. If nothing must change, verdict CLEAN, nextItems [], briefPath ''. ADVISORY findings go in findings either way. Return ONLY the structured output.`
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const iterations = []
let items = ITEMS
let brief = BRIEF
let iterBase = BASE
const briefs = [BRIEF]

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  log(`[${BATCH}] iteration ${iteration}: ${items.length} item(s) from ${brief}`)

  // Implement -> review (-> fix) per item, pipelined: no barrier between the two
  // stages, so one item's review overlaps another's implementation.
  const perItem = await pipeline(
    items,
    (item) => agent(implPrompt(item, brief, iterBase), { label: `impl:${item.key}`, phase: 'Implement', schema: WORK_SCHEMA, model: 'sonnet', effort: 'high' }),
    async (work, item) => {
      if (!work) { log(`[${BATCH}] ${item.key}: implementer returned nothing — item dropped from this iteration`); return null }
      const review = await agent(reviewPrompt(item, brief, iterBase, work), { label: `review:${item.key}`, phase: 'Review', schema: REVIEW_SCHEMA, model: 'sonnet', effort: 'high' })
      let confirmed = confirmedOf(review)
      if (review && confirmed.length === 0 && review.nullImplementationWouldPass) {
        confirmed = [{ severity: 'CONFIRMED', file: 'tests', summary: 'Reviewer judged that a do-nothing change would pass the new tests.', requiredChange: `Strengthen the tests so they fail against the previous behaviour. ${review.notes}` }]
      }
      log(`[${BATCH}] ${item.key}: review ${review?.verdict ?? 'MISSING'}, ${confirmed.length} confirmed`)
      let headSha = work.headSha
      let fix = null
      if (confirmed.length > 0) {
        fix = await agent(fixPrompt(item, brief, confirmed), { label: `fix:${item.key}`, phase: 'Review', schema: WORK_SCHEMA, model: 'sonnet', effort: 'high' })
        if (fix?.headSha) headSha = fix.headSha
      }
      return { item, headSha, work, review, fix }
    },
  )
  const landed = perItem.filter(Boolean)
  if (landed.length === 0) {
    log(`[${BATCH}] iteration ${iteration}: nothing landed — stopping`)
    iterations.push({ iteration, brief, items, landed: [] })
    break
  }

  // Integrate + gate: needs every item, so this is the one barrier.
  const integrated = await agent(integratePrompt(iterBase, landed), { label: `integrate:iter${iteration}`, phase: 'Integrate', schema: INTEGRATE_SCHEMA, model: 'sonnet', effort: 'medium' })
  if (!integrated?.headSha) {
    log(`[${BATCH}] iteration ${iteration}: integration returned nothing — stopping for a human`)
    iterations.push({ iteration, brief, items, landed, integrated })
    break
  }
  log(`[${BATCH}] iteration ${iteration}: integrated at ${integrated.headSha}, gate ${integrated.gatePassed ? 'green' : 'RED'}, ${integrated.conflicts.length} conflict(s)`)

  // Final review over the integrated diff.
  const final = await agent(finalReviewPrompt(iteration, integrated.headSha, briefs), { label: `final:iter${iteration}`, phase: 'Final review', schema: FINAL_SCHEMA, model: FINAL_MODEL, effort: 'high' })
  iterations.push({ iteration, brief, items, landed, integrated, final })

  const done = integrated.gatePassed && final?.verdict === 'CLEAN'
  if (done) {
    log(`[${BATCH}] final review CLEAN at ${integrated.headSha}`)
    break
  }
  if (!final?.nextItems?.length && integrated.gatePassed) {
    log(`[${BATCH}] final review not clean but produced no next items — stopping for a human`)
    break
  }
  if (iteration === MAX_ITERATIONS) {
    log(`[${BATCH}] iteration cap ${MAX_ITERATIONS} reached with ${final?.findings?.length ?? 0} finding(s) still open — stopping for a human`)
    break
  }
  // Loop: the reviewer's brief becomes the next iteration's work.
  items = (final?.nextItems ?? []).map((n) => ({ key: n.key, title: n.title, details: n.details }))
  if (!integrated.gatePassed) {
    items.push({ key: `r${iteration + 1}-gate`, title: 'make the batch gate green', details: `The gate (${GATE}) failed after integration. Output:\n${integrated.gateOutput}` })
  }
  brief = final?.briefPath || brief
  briefs.push(brief)
  iterBase = integrated.headSha
}

const last = iterations[iterations.length - 1]
return {
  batch: BATCH,
  branch: BATCH_BRANCH,
  worktree: BATCH_WORKTREE,
  baseSha: BASE,
  headSha: last?.integrated?.headSha ?? null,
  status: last?.integrated?.gatePassed && last?.final?.verdict === 'CLEAN' ? 'clean' : 'needs-human',
  iterations,
}
