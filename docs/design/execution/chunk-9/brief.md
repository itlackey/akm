# Chunk 9 — implementation brief

Opened at HEAD `365f5b09` (chunk 6 closed). Authority: plan §11 Chunk 9 +
§10 (all subsections) + §10.7 + §13.1 + §14.1–14.3, manifest chunk id
"9". Ground truth for every figure and line anchor: `anchors.md` in this
directory (censused at this HEAD by four parallel grounding passes) —
work items cite it as A.x/B.x/C.x/D.x and do not repeat its tables.
Net-LOC target ~−2000 (§12.1 REPORTED, never a gate) plus the §13.1/§14.x
fold-ins ledgered under the residual row, outside the −2000.

Method (unchanged, binding): behavior-preserving refactoring with
adversarial verification before each commit; deletions = inventory +
zero-count greps + tsc; `bun test <paths> --timeout=30000`, never two bun
test invocations concurrently; architecture tests UN-PIPED before
commits; one full `bun run check` at chunk end; every work item lands as
its own commit(s) pushed to `claude/akm-architecture-refactor-fubvd7`;
behavior changes ledgered as they land.

## Decisions REQUIRED before the affected items land (record in-ledger)

1. **Crash-window seams are not DI seams (A.1).** Of the 19 `_set*ForTests`
   definitions, 5 are crash/fault-injection hooks (fs-txn trio #1–3,
   migration hooks #16–17) that subprocess crash runners and the chunk-6
   fault suite depend on; a RunContext thread does not replace them.
   RECOMMENDATION: retain all 5 as engine-owned test seams; retire the 13
   ambient-DI seams (#4–15, #18) as their call sites convert; delete the
   dead #19 outright. Ledger as a deviation from the plan-letter "retire
   the 18 seams" (the plan's own count is wrong at 19/22 anyway — A.1).
2. **Two unowned cycle SCCs (D.4.4).** SCC #4 (harness config-import trio)
   and SCC #8 (improve command trio) map to no DoD-11 owner and survive
   every named sever. RECOMMENDATION: Chunk 9 ADOPTS both (small
   type-leaf severs; SCC #8's files are the ImproveRunContext baseline
   files WI-9.10 restructures anyway). Without adoption the gate's
   "every other participant dead" is unsatisfiable.
3. **"Taxonomy set" reading (D.4.3).** The Chunk-9 exit baseline is the
   30-file residual of SCC #1 (held by the output/renderers.ts hub, incl.
   the workflows/program cluster + agent runtime + config chain) + the
   C5 trio + the C8 trio. Ledger this interpretation explicitly.
4. **`--format html` surface (C.4).** Removing the generic JSON-in-<pre>
   fallback is a CLI surface change for every non-health command.
   RECOMMENDATION: keep `html` accepted but emit the health-only render
   for health and a UsageError (stable code) elsewhere — OR drop it from
   OUTPUT_FORMATS for non-health. Check the Chunk-0a CLI goldens FIRST
   (trap 6); ledger whichever surface lands.
5. **Deterministic-embedder relocation (C.2).** The census shows the −60
   "scaffolding" relocation is constrained by the production facade
   import. RECOMMENDATION: keep src/llm/embedders/deterministic.ts in
   place (it IS the facade's implementation), delete nothing, and ledger
   the plan's −60 as overstated-at-HEAD (the AKM_EMBED_DETERMINISTIC hook
   is on the §13.2 preserve list; ripping the impl to a test fixture
   would break scripts/akm-eval).

## Work items (land in this order)

### WI-9.1 — small deletions cluster (de-risked opener)

(a) Delete dead seam `_setSaveConfigForTests` (A.1 #19). (b) Rewrite the
stale src/storage/database.ts:14 parenthetical (C.9). (c) §14.3 delete:
HarnessResumeSupport, `resume?` field + BaseHarness mirror, 6 harness
declarations, PI_RESUME_FLAG + AMAZONQ_RESUME_FLAG (+ exports/imports,
agent-builder doc-comment refs); update the 4 asserting test files
(C.8). (d) Delete `pushOnCommit` knob (B.1) + schema regen. (e) Delete
getImproveProcessConfig's vestigial `_config` param (B.1) + caller sweep.
(f) Node 24 CI: introduce a node-version matrix around ci.yml's
node-smoke/node-compat steps (C.9; ledger the plan's "existing matrix /
Node 22" framing as inaccurate). Gates per item: zero-count greps, tsc,
affected suites; CI yaml is lint-only (no runner here).

### WI-9.2 — typed-error sweep (mechanical, per-directory)

B.6: convert the 78 bare `throw new Error(` in src/commands and the 26 in
src/core to UsageError/ConfigError/NotFoundError with stable codes
(existing enums extended append-only); map or code-stabilize the 6
out-of-hierarchy Error subclasses (keep LlmCallError-style internals if
they never surface to the CLI — decide per class, ledger the mapping
table). Do NOT touch src/migrate/legacy (frozen copy). The remaining
~107 bare throws outside commands/core are follow-the-directory
opportunistic — sweep only where a directory is already being edited.
Error-message text changes are behavior-visible: keep messages verbatim,
change only the class/code, unless a golden pins otherwise (trap 6).

### WI-9.3 — dedup families (§4.6; each family = one commit)

B.4: (a) caps() ×10 → one shared helper (BaseHarness or
harnesses/shared); (b) homeDir() ×2; (c) mirror-freshness ×2 →
withFreshnessCache({ttlMs,staleMs}); (d) session-log skeleton ×2 →
AbstractSessionLogProvider (behavior-preserving: both providers' quirks
stay in subclasses); (e) H3 scheduleKillLadder(proc,{reason}) covering
spawn.ts:527/:544 + sdk-runner.ts:489/:500 (C.7) — trim runAgent's
fn-size baseline entry if it shrinks below the bar; (f) semver engine →
registry/semver.ts (resolve.ts:650–757); (g) connection steps ×3 →
shared collectInput/probe/deriveConfig (stepLlm + stepSmallModelConnection
leave the fn-size baseline); (h) duration residue → core/time.ts:
consolidate.ts:2614 parseSinceToIso shadow (DECIDE: shadow returns input
unchanged vs canonical throws — preserve call-site behavior with an
explicit lenient wrapper if any caller depends on pass-through; ledger),
extract.ts:405 regex → parseDuration.

### WI-9.4 — output/report surface (§4.7 + §13.1 + L1)

B.2/C.1/C.3/C.4: (a) CommandRegistry<H> factory replacing
shapes/registry.ts + text/registry.ts (+ barrel re-export cleanup; L1);
(b) text/helpers.ts (1418/59 fns) file-level decomposition —
formatShowPlain's APPLY/workflow agent-directives to a structured
module; (c) --format html → health-only per Decision 4; (d) echarts CDN
default-flip (C.1 — flip :388, delete vendor asset + inline branch +
echartsLibPath, update copy-assets + 3 test files + _preload allowlist;
BEHAVIOR: charts need network at view time — plan-accepted, ledger);
(e) rank-metrics.ts → scripts/akm-eval canonical home (C.3 — invert the
shim, repoint collapse-detector.test.ts:29, fix the stale doc header);
(f) embedder: per Decision 5 (likely no-op + ledger note).

### WI-9.5 — health/tasks decomposition (§4.7 + H2)

B.3/C.6: (a) H2 typed seam — extract pure
AkmHealthResult→HealthReportViewModel + thin VM→fragment renderer;
buildHealthHtmlReplacements (646) dissolves; md-report shares the VM
where natural; trim its fn-size baseline entry; (b) akmHealth (272)
decompose; (c) projectRunMetrics (270) decompose (do NOT re-churn
summarizeImproveCompleted — plan:270 dropped row); (d) health/types.ts
(690) per-domain split; (e) tasks: runner.ts + backends
BackendExec<Extra> + runOrThrow consolidation (KEEP the strategy
pattern). HTML report OUTPUT is behavior-pinned by
tests/integration/health-html-report.test.ts — byte-stable unless a
test says otherwise.

### WI-9.6 — config discriminated schemas (§10.2/§4.2)

B.1: per-process discriminated schemas replacing the monolithic
ImproveProcessConfigSchema (:311) across the 9 process keys, real
.default()s where the plan orders them; delete
GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED (open the token, source from
adapter metadata or accept-any until Chunk 2 — decide + ledger; consumers
graph-extraction.ts:334, loop-stages.ts:1172,1250); fix the
mergeInformationFloor comment (field STAYS — live gate) and the
outcomeWeightEnabled comment. wikiName STAYS (Chunk 4/8's gate). Schema
regen (gen-config-schema --check green); DDL untouched; config parse
behavior preserved for every existing config fixture (the config suites
+ characterization tests are the oracle).

### WI-9.7 — H1 harness capability union (§14.2)

C.5: capability-discriminated AkmHarness union (required-when-true
sessionLogProvider); retire both load-time throws in
session-logs/index.ts (:41–45, :54–61) + the presence test; 10 harness
literals re-typed; registry filters unchanged. NO 3-object split
(plan-rejected). Compile-time-only change; zero runtime behavior delta
expected — verify via harness registry suites.

### WI-9.8 — import-cycle kills (§10.7; one knot = one commit, baseline trimmed in the same commit)

D.3 sever inventory, in dependency-light order: events pair → ranking
pair → wiki-fetchers → graph pair → graph-db pair → write-source↔git →
tasks barrel → harness config-import trio (Decision 2) → proposal
repo↔validators (Proposal type → proposal-types.ts leaf) →
improve-types knot (result types move DOWN into core; distill sub-cycle
clears too) → config↔integrations + harness barrel (registry inversion —
the big one; 31 files leave SCC #1). SCC #8 (improve trio) lands with
WI-9.10, whose restructuring owns those files. Each commit: cycle lint
green with the trimmed baseline, dynamic-import ratchet untouched (no
import() laundering — the lint catches it), tsc + affected suites.
Exit state: baseline = 30-file taxonomy residual + C5 trio + C8 trio
(Decision 3).

### WI-9.9 — ParsedInvocation argv normalization (§10.7)

B.4: one typed ParsedInvocation minted in src/cli.ts (fold
resolveHelpMigrateVersionArg + findCittyTopLevelCommand +
parseAllFlagValues re-scans), threaded to the 32 out-of-cli.ts
process.argv readers; new lint restricting process.argv to src/cli.ts
(arm as absolute — no baseline needed if the sweep is complete; else
shrink-only with the residue baselined and ledgered). The cli.ts:644
argv mutation dissolves into the parse. CLI behavior is golden-pinned
(Chunk-0a cli goldens + suites) — flag parsing must be byte-compatible.

### WI-9.10 — RunContext unification + seam retirement (§10.1; the headline)

A.2–A.5: (a) resolve the two chunk-7 type blockers (eventsCtx
optionality; extract's getLlmConfig return type); (b) unify: carrier
fields of ImproveRunContext move onto RunContext; mutable loop state
re-homed as a loop-state struct CONTAINING the RunContext; loop-stages +
improve.ts converted; ImproveRunContext deleted; adoption ratchet
baseline emptied (flips absolute per A.5); SCC #8 severed here; (c)
createRunContext constructed at all 5 improve verb entries (gate 4);
readAsset memo gains its first real consumers at the verb sites (closes
the chunk-7 deferred decision); (d) resolveStashDir: the ~49 leaf sites
convert to ctx.stashDir; the single call moves into the builder path
(gate 1); (e) the 13 ambient-DI seams retire as their call sites convert
(Decision 1) — each seam's retirement updates its consuming tests in the
same commit (§15.1 pairing). This item is LARGE: land as a series of
commits (blockers → unification → verb adoption → stashDir sweep → seam
retirements), each gate-green.

### WI-9.11 — chunk gates + ledger close

All four manifest gates verified: (1) resolveStashDir residual only in
the builder; (2) cycle baseline == later-owned knots exactly (Decision 3
reading); (3) ImproveRunContext grep → 0, adoption ratchet absolute;
(4) createRunContext at every improve verb entry. Full `bun run check`
ONCE. Ledger finalized with net-LOC report (~−2000 target + fold-ins
row) and the behavior-change register. Chunk-0a CLI goldens green.

## Keep-green / oracle inventory

Frozen goldens (47, sha-pinned — lint-verified every run): the txn
oracles + skip-shapes + recovery + consolidate journals are chunk-6
territory — Chunk 9 must not touch their surfaces. CLI output goldens
(cli/*.json family) pin command output shapes — the §11 testBucket says
they STAY GREEN through this chunk; --format html and typed-error work
must check them before changing any surfaced string (trap 6). Standing
ratchets at this HEAD: import cycles 107/107 (+dynamic 32 files/100
sites), fn-size ≤20-entry baseline (improve/** absolute-empty),
run-context-adoption 8, goldens-designations, RunContext ratchet. §15
rule 3 safety suites (workflow-crash-windows, migration-apply-crash,
sqlite-journal-mode, config-recovery-concurrency) — DO NOT TOUCH.

## Trap list (chunk-specific)

1. The cycle ratchet counts TYPE-ONLY imports — `import type` does not
   sever anything; only moving the type does (D.3).
2. The dynamic-import companion catches cycle-laundering via
   `await import()` — never convert a static import to dynamic to
   silence the participant lint.
3. Crash-window seams (fs-txn trio + migration hooks) are load-bearing
   for subprocess fault injection — Decision 1 before touching.
4. consolidate.ts's parseSinceToIso shadow differs behaviorally from the
   canonical (returns-input vs throws) — don't silently flip call-site
   behavior in the WI-9.3 consolidation.
5. mergeInformationFloor is NOT advisory (live gate anti-collapse.ts:143)
   — schema field stays; comment-only fix. Same for wikiName (Chunk 4/8's
   gate — leave it).
6. CLI goldens + health-html tests pin output surfaces — check the
   consumers BEFORE changing --format html, error strings, or report
   bytes; surface-owner re-designation applies if a pinned surface must
   legitimately change.
7. `| tail` swallows red exits — run gates un-piped before commits.
8. Never two bun test invocations concurrently; full check ONCE at close.
9. The fn-size ratchet is shrink-tolerant with a ≤20-entry cap — trim
   entries as gods dissolve (housekeeping), never add.
10. plan line anchors have drifted — trust anchors.md's re-anchored
    values, re-verify only files this chunk itself has since edited.
