# Chunk 9 — grounding census (anchors)

Censused at HEAD `365f5b09` (chunk 6 closed), 2026-07-16, by four parallel
read-only grounding passes. Authority: plan §10 (all subsections), §10.7,
§11 Chunk 9, §13.1, §14.1–14.3, manifest chunk id "9". Every plan anchor
was re-measured at this HEAD; drifted line numbers are re-anchored here.
This file is the census record the brief's work items cite — treat the
figures as ground truth at 365f5b09 and re-verify only what a later HEAD
may have moved.

## A. `_set*ForTests` seams + RunContext unification (§10.1, gates 1/3/4)

Plan authority (doc line refs): plan:400 (§10.1 — "Thread a RunContext
from the CLI boundary; no ambient reads in leaves; retire test seams as
call sites convert. (−250)"), plan:276 (THREAD row), plan:55 (§2 diagram —
"CLI boundary ── builds ──▶ RunContext { config, stashDir, dbs, adapters,
clock, logger }"), plan:446 (§11 Chunk 9 gates), plan:470 (zero-count grep
scope), plan:505 (DoD 7). NOTE: the plan is internally inconsistent on the
seam count — §10.1/:276 say 22, §11 says 18; TRUE COUNT AT HEAD IS 19
definitions (+2 re-exports), of which 3 are chunk-6-minted crash-window
seams and 1 is dead.

### A.1 Seam inventory (19 definitions)

| # | Seam | Definition | src callers | test callers |
|---|------|-----------|-------------|--------------|
| 1 | `_setTxnMutationHookForTests` ⚠️crash | src/core/fs-txn.ts:133 | 2 (the two wrappers) | tests/core/fs-txn-faults.test.ts (7 invocations) |
| 2 | `_setProposalMutationHookForTests` ⚠️crash | src/commands/proposal/repository.ts:1224 | 0 (forwards to #1) | tests/integration/_helpers/proposal-crash-runner.ts:23 |
| 3 | `_setMvMutationHookForTests` ⚠️crash | src/commands/mv-cli.ts:373 | 0 (forwards to #1) | tests/integration/_helpers/mv-crash-runner.ts:51 |
| 4 | `_setChatCompletionForTests` | src/llm/client.ts:274 | 0 | 5 files (consolidate goldens ×2, memory-infer, metadata-enhance, reflect-response-schema) |
| 5 | `_setWarnSinkForTests` | src/core/warn.ts:34 | 0 | 6 files |
| 6 | `_setClackForTests` | src/cli/clack.ts:63 | 0 | 3 files (setup-wizard, setup-scheduled-tasks, setup-run) |
| 7 | `_setAkmInitForTests` | src/commands/sources/init.ts:92 | 0 | 2 files |
| 8 | `_setAkmIndexForTests` | src/indexer/indexer.ts:502 | 0 | 1 file (setup-run) |
| 9 | `_setAgentDetectForTests` | src/integrations/agent/detect.ts:81 (re-export index.ts:25) | 0 | 1 file (setup-run) |
| 10 | `_setEmbedderForTests` | src/llm/embedder.ts:62 | 0 | 1 file (setup-run) |
| 11 | `_setDetectForTests` | src/setup/detect.ts:45 | 0 | 1 file (setup-run) |
| 12 | `_setDefaultTasksForTests` | src/commands/tasks/default-tasks.ts:146 | 0 | 1 file (setup-run) |
| 13 | `_setLoadSetupStashesForTests` | src/setup/registry-stash-loader.ts:76 | 0 | 2 files |
| 14 | `_setTransformersLoaderForTests` | src/llm/embedders/local.ts:79 (re-export embedder.ts:43) | 0 | 2 files (embedder, embedding-model-config) |
| 15 | `_setBackendsForTests` | src/tasks/backends/index.ts:70 | 0 | 2 files (tasks-write-target, tasks-lifecycle) |
| 16 | `_setRestoreRollbackBoundaryHookForTests` | src/core/migration-backup.ts:782 | 0 | 1 file (migration-lifecycle-regression) |
| 17 | `_setAfterPendingOperationCheckHookForTests` | src/core/migration-operation.ts:14 | 0 | 1 file (migration-lifecycle-regression) |
| 18 | `_setAkmImproveForTests` | src/commands/improve/improve-cli.ts:35 | 0 | 1 file (improve-cli-result-storage, in spawned subprocess source) |
| 19 | `_setSaveConfigForTests` | src/core/config/config.ts:269 | 0 | 0 — DEAD SEAM (delete outright) |

Dispositions: #1–3 are crash-window fault-injection seams (chunk-6-minted;
subprocess crash runners + the fault suite depend on them; a RunContext
thread does NOT replace a crash hook — retirement needs an explicit
decision, default RETAIN as engine-owned test seams, ledgered). #19 is
dead — delete. #4–18 (15 seams) are the live ambient-DI conversion
candidates §10.1's "retire as call sites convert" targets. #16/#17
(migration crash hooks) are ALSO crash-window-shaped — flag for the same
decision as #1–3 rather than mechanical conversion.

### A.2 ImproveRunContext vs minted RunContext

- `ImproveRunContext` defined src/commands/improve/improve.ts:1585
  (fields :1585–1617). src refs: improve.ts ×1, loop-stages.ts ×7
  (:49 import, :82/:83/:95/:98 type projections, :119
  prepareImproveLoopEnv, :677 runImproveLoopStage) — matches the ratchet
  baseline exactly. Test refs: improve-loop-ref-pass.test.ts ×4.
- Minted `RunContext` src/commands/improve/run-context.ts:66–117
  (immutable DI carrier: stashDir, config, eventsCtx, proposalsCtx, chat,
  getLlmConfig, sourceRun, dryRun, signal?, now, readAsset/writeAsset/
  noteAssetWrite/withFreshAssetMemo — the D6 read-once memo seam).
- Overlap nearly nil: eventsCtx (optional vs REQUIRED — the chunk-7
  ledgered type blocker), primaryStashDir? vs stashDir (required),
  budgetSignal? vs signal?. ImproveRunContext is a MUTABLE loop-state bag
  (accumulators: actions[], loopRefs[], signalBearingSet,
  rejectedProposalsByRef, utilityMap; verb fn seams reflectFn/distillFn;
  plan/profile snapshots). Unification = move carrier-like fields onto
  RunContext, re-home the mutable accumulators (e.g. a loop-state struct
  that CONTAINS a RunContext), not a rename.
- Chunk-7 ledger constraints: :680–694 (adoption deferred; the two type
  blockers: eventsCtx optionality, extract's getLlmConfig returns
  LlmProfileConfig not LlmConnectionConfig|null), :955–956 (readAsset has
  zero content-read consumers — Chunk 9 must give the memo real
  consumers or that decision re-opens).

### A.3 createRunContext adoption state

Definition src/commands/improve/run-context.ts:198. src constructors:
ZERO. Improve verb entries, all currently NOT constructing it (gate
starts 0/5): akmImprove improve.ts:342, akmReflect reflect.ts:1616,
akmDistill distill.ts:837, akmExtract extract.ts:1411, akmConsolidate
consolidate.ts:924. Passes currently take bespoke carriers
(ImproveLoopEnv, MaintenanceCtx, ImproveRunSetup, ExtractSessionRunCtx —
chunk-7 ledger :689–692).

### A.4 resolveStashDir

Definition src/core/common.ts:189 (AKM_STASH_DIR env → config stashDir →
platform default). ~49 src invocation sites across 27 files (plan said
×56; invocation count at HEAD is ~49): proposal.ts:42, propose.ts:108,
proposal-cli.ts:374, source-add.ts:56,81, installed-stashes.ts:30,114,314,
knowledge.ts:234, config-cli.ts:146, lint/index.ts:101,
tasks/tasks.ts ×8 (:310,:359,:546,:577,:603,:723,:841,:884),
wiki-cli.ts ×10 (:32,:71,:84,:122,:139,:158,:208,:236,:265,:325),
health.ts:241,256, mv-cli.ts:1204, distill.ts:863, reflect.ts:1617,
extract.ts:1421, filesystem.ts:20, git-stash.ts:120, website-ingest.ts:85,
runner.ts:148, validator.ts:42,72, scheduler-invocation.ts:33,
write-source.ts:367,459, indexer.ts:529, manifest.ts:179,
search-source.ts:56, scope-key.ts:28, authoring.ts:88.
"The RunContext builder" = the CLI-boundary construction path
(createRunContext in run-context.ts) — which today does NOT call
resolveStashDir at all (stashDir passed via RunContextInit). The gate
means: add the ONE resolveStashDir call into the builder path, delete all
~49 leaf sites.

### A.5 run-context-adoption ratchet

tests/architecture/run-context-adoption.test.ts: (1) :57 shrink-only
per-file ImproveRunContext identifier ratchet, baseline (:32–35)
`improve.ts:1, loop-stages.ts:7` = 8 total; (2) :77 existence pin on
run-context.ts + createRunContext export; (3) :87 anti-rename guard
(baseline ≤8; while non-empty the interface must still exist).
"Flipping absolute" = drive both files to 0, delete the interface, empty
IMPROVE_RUN_CONTEXT_BASELINE (empty map ⇒ every match is a violation),
replace the existence pin with real adoption assertions.

## B. Config / output / health-tasks / CLI / errors (§10.2–10.7, §4.2/4.6/4.7)

Plan authority: §10.2 plan:403 (per-process discriminated schemas),
§4.2 plan:164–171 (reserved-knob table), §4.7 plan:265–275 (output/health/
tasks decompose+consolidate rows), §10.7 plan:423 (ParsedInvocation),
§4.6 plan:242–250 (dedup families), §10.4 plan:409,411–412, §10.7
plan:425 (typed-error sweep). Plan's own §11:436 caveat honored:
config-schema re-measured below.

### B.1 Config schema

src/core/config/config-schema.ts = 1267 LOC at HEAD (plan measured 1415).
216 `.optional()` / 3 `.default()` (plan: 252/3). ImproveProcessConfigSchema
still one monolithic z.object at :311, reused via .optional() for all 9
process keys at :496–506 (reflect/distill/consolidate/memoryInference/
graphExtraction/extract/validation/triage/proactiveMaintenance). ZERO
z.discriminatedUnion anywhere. Reserved-knob dispositions at HEAD:
- ALREADY GONE (chunk-7 fallout): ImproveCalibrationSchema,
  ImproveExplorationSchema, homeostaticDemotion (tombstone :409), emitAs.
- STILL PRESENT, DELETE HERE: pushOnCommit (:585, deprecation no-op);
  GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED (:767, consumed :845,:948–949 +
  graph-extraction.ts:334, loop-stages.ts:1172,1250) — plan says
  DELETE/OPEN (source from adapter metadata; stale `wiki` entry);
  getImproveProcessConfig vestigial `_config` param (config.ts:250–254).
- KEEP: mergeInformationFloor (:428 — LIVE gate anti-collapse.ts:143;
  fix only the misleading comment); outcomeWeightEnabled (:715 — comment
  rename only). wikiName (:599,:645 + config-types.ts:113 +
  config-sources.ts:93,111) is CHUNK 4/8's gate (plan:460,466) — NOT here.
- autoAccept: config knob already gone (chunk 6); only the CLI
  warn-and-ignore stub parse-args.ts:147 survives (leave it; 0.10 removes).

### B.2 Output registries + god helper

Three parallel registries: src/output/shapes/registry.ts (81 LOC,
OUTPUT_SHAPE_REGISTRY :39) ≈ src/output/text/registry.ts (79 LOC,
TEXT_FORMATTER_REGISTRY :36) — near-byte-identical Map+register/
deregister/get triplets; singular register/deregister are test-only
(tests/output-registry.test.ts via the barrels' re-exports
shapes.ts:70/text.ts:106); production uses batch registerOutputShapes/
registerTextFormatters. Barrels: shapes.ts (146 LOC, BUILT_IN_OUTPUT_SHAPES
:78–97, shapeForCommand :126, bare-Error throw :145) ∥ text.ts (177 LOC).
Consolidation target: one generic CommandRegistry<H> factory (§4.7 −150,
§14.2 L1). Per-command modules: 19 shape files, 35 text files (pure
entry arrays — keep). God helper: src/output/text/helpers.ts = 1418 LOC /
59 fns, formatShowPlain :528 (file-level extraction; no fn >220).
Type-renderer registry (output/renderers.ts 871 LOC, registerRenderer
:849 ← indexer/walk/file-context.ts:30) is CHUNK 3-coupled — not part of
the §4.7 registry merge.

### B.3 Health/tasks decomposition

Fn-size-baselined offenders owned here (scripts/lint-src-fn-size.ts
:52–73 baseline, armed at 43d6f10, cap ≤20 entries; shrink-tolerant;
improve/** has its own ABSOLUTE-EMPTY gate):
- buildHealthHtmlReplacements html-report.ts:405 — 646 lines (file 1050).
  §4.7 −200 + §14.2 H2: extract pure AkmHealthResult→HealthReportViewModel
  + thin VM→fragment renderer (typed seam, unit-testable). NOT started at
  HEAD (last touch was chunk-7's ref work).
- akmHealth health.ts:131 — 272 lines (file 405). §4.7 decompose.
- projectRunMetrics improve-metrics.ts — 270 lines (the surviving half of
  the dropped summarizeImproveCompleted row; do-not-re-churn note).
- stepLlm connection.ts — 250; stepSmallModelConnection — 272 (see B.4
  connection dedup; file 940 LOC, three near-identical steps :185/:455/:733).
- runAgent spawn.ts — 298 (H3 kill-ladder, see C.7).
Health dir sizes: html-report 1050, improve-metrics 860, types.ts 690
(the "685 type dump" → per-domain split, −100), checks 580, health.ts 405.
Tasks: tasks.ts 954 / runner.ts 894 (plan measured 698 — GREW) — no fn
over the 220 bar; decomposition is file-level + backend boilerplate
consolidation: backends/{cron 337, launchd 445, schtasks 734} →
BackendExec<Extra> + runOrThrow (KEEP strategy pattern, §4.7 −80);
exec-utils.ts (145) exists as a seed.

### B.4 CLI argv + dedup families

ParsedInvocation (§10.7 plan:423): normalize argv EXACTLY ONCE at entry
into a typed ParsedInvocation, pass down with RunContext; lint-restrict
process.argv to src/cli.ts. HEAD reality: 46 process.argv sites in src,
32 OUTSIDE src/cli.ts; the startup mutation is cli.ts:644
(`process.argv = normalizeShowArgv(process.argv)`). Leaf readers to
convert: remember.ts:314,323,340; stash-cli.ts:72,103,108;
sources-cli.ts:158,225; search-cli.ts:195–198,222; remember-cli.ts:144;
secret-cli.ts:197–201; env-cli.ts:232–236,477; workflow-cli.ts:90;
improve-cli.ts:170; cli/shared.ts:228–231 (parseAllFlagValues). Argv
re-scanners to fold (§4.7:274): cli.ts:138 resolveHelpMigrateVersionArg,
parse-args.ts:64 findCittyTopLevelCommand, shared.ts parseAllFlagValues.
Duration residue (§4.7:275, drifted): consolidate.ts:2614 parseSinceToIso
shadow (returns-input-unchanged vs canonical THROW — behavior delta to
decide); extract.ts:405 /^(\d+)\s*([mhd])$/i; memory-improve.ts "N days
ago" ALREADY GONE at HEAD. Canonical home core/time.ts (parseSinceToIso:86,
parseDuration:59).
Dedup families (§4.6:242–247): caps() ×10 byte-identical
(harnesses/{opencode:31,copilot:25,claude:40,gemini:24,amazonq:25,
opencode-sdk/harness.ts:28,openhands:24,pi:24,codex:24,aider:24});
homeDir() ×2 (claude/config-import.ts:22, opencode/config-import.ts:22);
mirror-freshness ×2 (website-ingest.ts:105 ensureWebsiteMirror,
git-provider.ts:107 ensureGitMirror → withFreshnessCache({ttlMs,staleMs}));
session-log skeleton ×2 (claude/session-log.ts 321, opencode/session-log.ts
435 → AbstractSessionLogProvider); spawn kill-ladder (see C.7); semver
engine inline in registry/resolve.ts:679 semverGte/:683 satisfiesRange
(span :650–757 → registry/semver.ts); connection steps ×3 (B.3).

### B.5 npm.path() + parseSourceSpec

npm.ts:55 path() STILL THROWS (ConfigError now, but the interface
violation stands) — fix = lazy cache-dir resolution mirroring
git-provider.path(). config-sources.ts:35 parseSourceSpec now has a
default best-effort fallback (:51–53) covering filesystem/git/website/npm
+ default; plan cites "6 variants" — confirm the SourceConfigEntry union
arity at implementation.

### B.6 Typed-error sweep

Taxonomy src/core/errors.ts (232 LOC): AkmError:137 (kind
config|usage|not-found :130), ConfigError:146 (exit 78, 12 codes),
UsageError:164 (exit 2, 17 codes), NotFoundError:182 (exit 1, 5 codes);
exhaustive classifyExitCode cli/shared.ts:58. Adoption already broad:
696 typed throw sites. Remaining bare `throw new Error(`: src/commands
78 (plan: 79 ✓), src/core 26, whole src 211 (plan baseline 204). The 6
out-of-hierarchy Error subclasses (plan "+6" ✓): LlmFeatureTimeoutError
feature-gate.ts:187, LlmCallError client.ts:101, UnitCapExceededError
scheduler.ts:64, UnitTransportError native-executor.ts:934,
UntrustedNpmTarballError resolve.ts:309, ResponseTooLargeError
common.ts:409 → map or keep-with-stable-codes.

## C. §13.1 / §14.1–14.3 fold-ins (ledgered under §12.1's residual row, outside the ~−2000)

### C.1 echarts → CDN default-flip (§14.1 plan:596, §13.1 plan:549)

Vendored asset src/assets/templates/html/vendor/echarts.min.js =
1,034,102 B. Flip point html-report.ts:388 (`opts.echarts ??
(process.env.AKM_ECHARTS === "cdn" ? "cdn" : "inline")` — change fallback
"inline"→"cdn"); delete ECHARTS_VENDOR_PATH :42, echartsLibPath option
:68, the readFileSync inline branch :390–393, and the asset. ECHARTS_CDN
:41 (no drift); buildEchartsTag :387; token injection :1031. Consumers to
update: scripts/copy-assets.ts:48–59 (drop the copy + warn),
tests/integration/health-html-report.test.ts:290–299,
html-output-cli.test.ts:89,114, tests/_preload.ts:80 (env allowlist).
Caveat (plan-accepted): charts need network at view time.

### C.2 Deterministic embedder (§13.1 plan:552, §13.2 plan:571)

The AKM_EMBED_DETERMINISTIC facade switch STAYS: embedder.ts:120 (embed),
:154 (embedBatch), plus :201 (resolveEmbeddingModelId) and :218–220
(checkEmbeddingAvailability) — same facade hook, unnamed by the plan.
scripts/akm-eval/src/curate-bench.ts:159 sets the env on real-binary
subprocesses (the reason it stays). The "−60 scaffolding" is the pure
hash implementation in src/llm/embedders/deterministic.ts (99 lines:
FNV-1a :55–63, tokenize :66–71, deterministicEmbed :78–98) — but the
facade must keep importing it, so the relocation is constrained; the
brief must scope exactly what moves (likely: nothing moves out of src/
without breaking the facade import — candidate resolution: keep the
module, delete only test-only surface, and ledger the plan's −60 as
overstated).

### C.3 rank-metrics → scripts/akm-eval (§13.1 plan:553, §13.4 plan:585)

src/core/eval/rank-metrics.ts (181 lines, pure math: ndcgAtK, recallAtK,
mrr, noBannedAboveRequired, scoreCurateCase, summarizeCurateMetrics).
ZERO src importers. Move → scripts/akm-eval/src/curate-metrics.ts becomes
canonical (today it's a re-export shim :7). Repoint
tests/integration/commands/improve/collapse-detector.test.ts:29 (direct
src-path import); tests/curate-metrics.test.ts:14 +
curate-golden-eval.test.ts:29 already import via the shim. STALE DOC:
rank-metrics.ts:12–14 claims collapse-detector.ts consumes it — false at
HEAD; correct on move.

### C.4 --format html → health-only (§13.1 plan:555)

Framework src/output/html-render.ts (81 lines): DEFAULT_TEMPLATE :23,
resolveTemplatePath :31 (per-command lookup + default.html fallback),
renderHtml :50, escapeHtml :61, deliverRendered :74. Health's real path:
cli.ts:384–401 (deliverRendered(renderHtml(resolveTemplatePath("health")…)
at :401). Generic JSON-in-<pre> fallback: cli/shared.ts:205–216 (exact).
`html` is in OUTPUT_FORMATS (output/context.ts:18,:42) and the global
--format doc cli.ts:521. Work: delete DEFAULT_TEMPLATE + default.html +
the shared.ts:205–216 case + the generic lookup branch; keep health's
render; decide whether `html` leaves OUTPUT_FORMATS for non-health
commands (CLI surface change — ledger it).

### C.5 H1 — AkmHarness capability-discriminated union (§14.2 plan:608)

Load-time throw src/integrations/session-logs/index.ts:41–45 (+ second
reverse-invariant throw :54–61). Interface
src/integrations/harnesses/types.ts: AkmHarness :108–214,
HarnessCapabilities :76–87 (5 booleans: sessionLogs, agentDispatch,
detection, configImport, runtimeIdentity); 10 optional facet fields
(:123–:213); BaseHarness mirrors :221–236. Registry
harnesses/index.ts:60–71 (10 harnesses, frozen) + capability filters
:101/:103/:105/:107. Target: required-when-true union so
sessionLogs:true ⇒ sessionLogProvider required at compile time; retire
both load-time throws + the presence test (tests/harnesses-registry.test.ts).
Plan explicitly REJECTS the runtime/session/format 3-object split.

### C.6 H2 — health view-model split (§14.2 plan:609)

See B.3. buildHealthHtmlReplacements html-report.ts:405, 646 lines,
computes deltas/trends/staleness AND emits HTML through the 17-token
%%TOKEN%% map ending :1031. No HealthReportViewModel type exists.
md-report.ts (5.1 KB) is the sibling that would share the VM. §4.7's
line-count split never landed — H2 supersedes it in this chunk.

### C.7 H3 — scheduleKillLadder (§14.2 plan:610, §4.6 plan:245)

spawn.ts killGroup :107–121 (shared; NOT the dup). Ladder copy #1
(timeout): :524–534 (SIGTERM :527, SIGKILL after 5 s :531, sets
timedOut). Copy #2 (abort): :541–550 (SIGTERM :544, SIGKILL :547, sets
aborted). Byte-identical except the flag — the {reason} param. Cross-file
copy: opencode-sdk/sdk-runner.ts SERVER_KILL_GRACE_MS :430, SIGTERM :489,
SIGKILL :500. One scheduleKillLadder(proc,{reason}) covers all three.
(tasks/runner.ts:272 bare SIGTERM is NOT in scope — unnamed by plan.)
runAgent (298 lines) is fn-size-baselined — trim its entry on decompose.

### C.8 L1 + §14.3 — registry fold; AkmHarness.resume deletion (plan:612,616,619)

L1 rides the B.2 CommandRegistry<H> consolidation. §14.3: resume declared
on 6/10 harnesses (claude:83, opencode:65, copilot:54, gemini:53, pi:54,
amazonq:56), HarnessResumeSupport types.ts:58–69, field :172 + BaseHarness
:231; 2 constants: PI_RESUME_FLAG (pi/agent-builder.ts:70, exported
pi/index.ts:21), AMAZONQ_RESUME_FLAG (amazonq/agent-builder.ts:81,
exported amazonq/index.ts:22). ZERO production readers of `.resume`.
Tests to update on delete: harnesses-registry.test.ts:125,134,143;
agent/harness-registry.test.ts:87–95; harness-pi.test.ts:15,62;
harness-amazonq.test.ts:20,66. ~30–40 LOC.

### C.9 database.ts comment + Node 24 CI (§14.4 plan:623)

Stale claim src/storage/database.ts:14 ("additive, not CI-tested this
pass") — delete/rewrite the parenthetical (node-smoke + node-compat DO
run in CI). CI reality vs plan framing: ci.yml `check` job :31–51 runs a
SINGLE node-version 20.12.0 (:41) — no matrix, no Node 22; release.yml
:33 already pins Node 24 but only for build/publish (no gate suite). Work
= introduce a matrix (20 → [20,24] or [20,22,24]) around the
node-smoke/node-compat steps; there is NO release-gates.yml — decide
whether release.yml gains a gate job or the ledger records the plan's
framing as inaccurate.

## D. Import-cycle knots (§10.7, gate 2, DoD 11 ownership)

Plan authority: plan:422 (§10.7 — ratchet pre-armed at chunk-7 HEAD,
shrink-only 107-file baseline + dynamic-import companion; kill ownership),
plan:446 (gate: "baseline trimmed to the later-chunk-owned knots ONLY"),
plan:509 (DoD 11 ownership map), plan:434 (execution order — Chunk 9 runs
BEFORE Chunks 3/5/8, so the gate is "trimmed to later-owned", never
"empty"), plan:458/:462/:466 (Chunk 3/5/8 exit gates).

### D.1 Ratchet mechanics + live status

scripts/lint-import-cycles.ts (406 lines): static import graph over src/**
INCLUDING type-only imports (dependency direction is an architecture
property); dynamic import() excluded from the graph but counted by the
companion ratchet. Tarjan SCC; participant = file in SCC>1 or
self-import. CYCLE_PARTICIPANT_BASELINE :189–297 = 107 entries (armed at
chunk-7 HEAD 43d6f10); shrink-only, never add. Known limitation: a NEW
edge between two already-baselined files is invisible.
DYNAMIC_IMPORT_BASELINE :330–363 = 32 files / 100 call sites;
new-file-or-grew fails. Live at 365f5b09:
`OK — 107 cycle participant(s) within baseline (107)` — NOTHING trimmed
yet; chunks 6/7 killed no knot (chunk-6 ledger :224–227,:257–261 only
avoided deepening; chunk-7 armed the baseline).

### D.2 The 13 SCCs (sum = 107)

| SCC | size | knot | owner |
|-----|------|------|-------|
| #1 | 61 | fused mega-component: config chain + integrations/agent + harness barrel + 29 harness leaves + taxonomy/renderers hub + workflows/program cluster + indexer metadata | C9 cuts config/harness slices; 30-file residual → C3 |
| #2 | 17 | improve-types inversion (11) + proposal repository↔validators (6) | C9 |
| #3 | 4 | tasks/backends barrel (index,cron,launchd,schtasks) | C9 |
| #4 | 3 | harness config-import trio (claude/config-import, opencode/config-import, setup/harness-config-import) | 🚩 UNOWNED |
| #5 | 3 | write-source↔git (write-source, git, git-stash) | C9 |
| #6 | 3 | indexer db/entry-mapper/schema trio | C5 |
| #7 | 3 | workflows-runtime step-work/runs/unit-checkin trio | C8 |
| #8 | 3 | improve command trio (improve, loop-stages, preparation) | 🚩 UNOWNED |
| #9 | 2 | wiki-fetchers back-edge (registry↔youtube) | C9 |
| #10 | 2 | graph pair (graph-dedup ↔ llm/graph-extract) | C9 |
| #11 | 2 | graph-db pair (graph-db ↔ graph-extraction) | C9 |
| #12 | 2 | ranking pair (ranking-contributors ↔ ranking) | C9 |
| #13 | 2 | events pair (core/events ↔ events-repository) | C9 |

### D.3 Sever inventory (offending imports, file:line)

- improve-types: core/improve-types.ts:5/:6/:7/:16 import type
  {ConsolidateResult, AkmDistillResult, AkmExtractResult, AkmReflectResult}
  UP from commands/improve/* — the §10.7 layering inversion. Sever: move
  the result types down into core (import-type alone does NOT satisfy the
  ratchet — it counts type edges). Sub-cycle that must ALSO clear:
  distill.ts ↔ promote-memory.ts:28 ↔ quality-gate.ts:25 (type
  AkmDistillResult back-edges).
- config↔integrations: config.ts:32 imports engine-resolution (value);
  config-types.ts:30 imports HARNESS_BY_ID/VALID_HARNESS_IDS from the
  harness barrel (value). Sever: invert — engine/harness-id data injected
  or moved to a config-side leaf.
- harness barrel: agent/builders.ts:18 + engine-resolution.ts:11 import
  ../harnesses while every harness's agent-builder imports
  builder-shared → spawn → builders → ../harnesses. Sever: invert the
  registry so harnesses/index.ts's leaf claim becomes true.
- tasks barrel: backends/index.ts:19–21 imports the three backends
  (value); cron.ts:42/launchd.ts:41/schtasks.ts:49 import type
  {InstalledTaskRef, TaskBackend} from "./index". Sever: types →
  backends/types.ts leaf.
- graph pair: graph-dedup.ts:13 (type) ↔ graph-extract.ts:929
  re-export of deduplicateGraph. Sever: drop the :929 re-export + types
  leaf.
- graph-db pair: graph-db.ts:15 (value) ↔ graph-extraction.ts:60
  (value). Sever: dependency-invert (store must not import orchestrator).
- ranking pair: ranking.ts:22 (value) ↔ ranking-contributors.ts:9
  (type RankedEntryInput). Sever: type → leaf.
- proposal repo↔validators: repository.ts:97 (value →
  validators/proposals) ↔ type Proposal back-edges from
  validators/proposals.ts:15, proposal-validators.ts:10,
  proposals-repository.ts:14, legacy-import.ts:27. Sever: Proposal (+
  ProposalValidationFinding/Report, ProposalsContext) → proposal-types.ts
  leaf; clears the validators-internal and legacy-import sub-cycles too.
- wiki-fetchers: registry.ts:9 (value youtube) ↔ youtube.ts:6 (type
  WikiSnapshotFetcher/Result). Sever: types → leaf. (Chunk 4 renames the
  dir; the kill is Chunk 9's.)
- write-source↔git: write-source.ts:29 → git.ts:28 → git-stash.ts:12
  (imports sanitizeCommitMessage back from write-source). Sever: extract
  sanitizeCommitMessage to a util leaf.
- events pair: events.ts:31 (value) ↔ events-repository.ts:14 (type
  EventEnvelope). Sever: EventEnvelope → core events-types leaf.
- 🚩 SCC #4: setup/harness-config-import.ts:22–23 (value importers) ↔
  claude/config-import.ts:20 + opencode/config-import.ts:20 (type
  HarnessConfigImporter). Sever: type → leaf. Small; unowned by DoD 11.
- 🚩 SCC #8: improve.ts:63,:67 (value stage fns) ↔ preparation.ts:38 +
  loop-stages.ts:51 (type AkmImproveOptions/ImprovePreparationResult/
  ImproveScope/ConsolidationPassResult back-edges). Sever: shared improve
  option/result types → leaf. Intertwined with the ImproveRunContext
  unification (same files). Unowned by DoD 11.

### D.4 Headline findings (bind the brief)

1. Baseline untouched at HEAD: all kill work is ahead.
2. Ordering: the Chunk-9 gate is "trimmed to exactly the later-chunk-owned
   knots", never "empty" (C3/C5/C8 run later, plan:434).
3. "Taxonomy set" must be read as the 30-file residual of SCC #1 after
   Chunk 9's config/harness cuts (held cyclic by the output/renderers.ts
   type-registry hub; includes the workflows/program cluster, agent
   runtime, config chain, indexer metadata/file-context, env, asset core)
   — NOT a 3-file set. The gate holds only under this reading; ledger the
   interpretation.
4. SCC #4 and SCC #8 (6 files) map to NO DoD-11 owner and survive every
   named sever. Chunk 9 must either adopt them (both are small type-leaf
   severs — recommended) or the gate's "every other participant dead" is
   unsatisfiable. Decision to record in-ledger before the cycle work item
   lands.
