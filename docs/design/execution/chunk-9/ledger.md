# Chunk 9 — deletion/behavior ledger

Opened at HEAD `365f5b09` (chunk 6 closed; full check green 4454/0/55 in
the integration stage, exit 0 overall). Work items land per brief order;
this ledger records each item's deletions, behavior changes, gate
evidence, and net LOC as it lands. Status: IN PROGRESS.

## Baseline records (pre-work, at 365f5b09)

- Import-cycle ratchet: 107 participants == 107-entry baseline (armed at
  chunk-7 HEAD 43d6f10; nothing trimmed by chunks 6/7). Dynamic-import
  companion: 32 files / 100 call sites.
- run-context-adoption ratchet baseline: 8 (improve.ts:1,
  loop-stages.ts:7). createRunContext src constructors: 0.
- fn-size ratchet: SRC_FN_SIZE_BASELINE ≤20 entries (shrink-tolerant);
  improve/** absolute-empty gate green. Chunk-9-owned entries:
  buildHealthHtmlReplacements 646, akmHealth 272, projectRunMetrics 270,
  stepSmallModelConnection 272, stepLlm 250, runAgent 298.
- `_set*ForTests` seams: 19 definitions (3 fs-txn crash + 2 migration
  crash hooks + 13 ambient-DI + 1 dead).
- resolveStashDir src invocations: ~49 across 27 files.
- Bare `throw new Error(`: src/commands 78, src/core 26, src total 211;
  6 out-of-hierarchy Error subclasses.
- Frozen goldens: 47 sha-pinned (lint-verified); architecture ratchets
  28/28 green; goldens-designations 7/7.

## Decisions pending (brief "Decisions REQUIRED" 1–5)

To be recorded here as they are made, before the affected work items
land: (1) crash-window seam retention; (2) adoption of the two unowned
cycle SCCs; (3) the 30-file taxonomy-residual reading of gate 2;
(4) --format html surface; (5) deterministic-embedder relocation no-op.

## Decisions 1–3 recorded (session, per brief recommendations; maintainer may override)

(1) Crash-window seams RETAINED: the fs-txn trio
(_setTxnMutationHookForTests + the proposal/mv wrappers) and the two
migration hooks (_setRestoreRollbackBoundaryHookForTests,
_setAfterPendingOperationCheckHookForTests) are fault-injection points
that subprocess crash runners and the chunk-6 fault suite depend on — a
RunContext thread does not replace a crash hook. The §10.1 retirement
set is therefore the 13 ambient-DI seams; ledgered deviation from the
plan-letter "18 seams" (true count 19; see anchors A.1).
(2) The two unowned cycle SCCs (harness config-import trio, improve
command trio) are ADOPTED into Chunk 9's kill set — both are small
type-leaf severs, and DoD 11's enumeration simply missed them; without
adoption gate 2's "every other participant dead" is unsatisfiable.
(3) Gate 2's "taxonomy set" is read as the 30-file residual of the
mega-SCC after Chunk 9's config/harness cuts (held cyclic by the
output/renderers.ts hub; anchors D.4.3) plus the C5 and C8 trios.

## WI-9.1 — small deletions cluster (landed with this entry)

Deletions: (a) dead seam _setSaveConfigForTests + its saveConfigOverride
indirection (config.ts — zero callers anywhere; saveConfig now calls
saveConfigReal directly); (b) database.ts:14 stale "not CI-tested this
pass" claim rewritten (node-smoke + node-compat DO run in CI); (c) §14.3
resume machinery: HarnessResumeSupport interface, AkmHarness.resume? +
BaseHarness mirror, the 6 harness declarations, PI_RESUME_FLAG +
AMAZONQ_RESUME_FLAG (+ their exports/imports), and the stale doc-comment
references across 8 harness files — zero production readers existed;
4 test files updated (resume-matrix assertions removed, imports
trimmed); (e) getImproveProcessConfig's vestigial `_config` param
removed with all 8 src + 7 test call sites. Ripples fixed in the same
change: finalizeMerge no longer destructures ctx.config;
emitDistillLessonProposal + buildDistillMessages lost their now-dead
`config` arg fields (internal callers updated); countNewExtractCandidates
keeps its (dead) first param UNDERSCORED because its signature feeds the
extractCandidateCountFn test seam — full removal rides WI-9.10's context
rework; three now-purposeless cfg constructions removed from
config.test.ts. (f) ci.yml: the Node-fallback verification moved out of
the `check` job into a dedicated `node-smoke` job with a
node-version matrix ["20.12.0", "22", "24"] — CENSUS CORRECTION to plan
§14.4: there was NO pre-existing matrix and NO Node 22 coverage; the
matrix is introduced, not extended. release.yml already builds on Node
24; no release-gates workflow exists (plan framing inaccurate — recorded,
nothing further owed here).

DEFERRED from the brief's WI-9.1 list: (d) pushOnCommit deletion —
CENSUS CORRECTION: the knob is NOT schema-only. write-source.ts:304 maps
the deprecated per-asset intent onto the batch push gate (with the
one-time deprecation warning at :323–334) and improve.ts:938 reads it in
the push-default chain. Deleting it changes push behavior for configs
that set it — moved to WI-9.6 with its own decision (complete the
deprecation vs keep the warn+map window one more minor).

Adversarial review: 1 blocker + 3 concerns, all fixed pre-commit. The
blocker: the new node-smoke job ran the smoke/compat suites without
`bun run build`, and scripts/node-smoke.ts fails fast when
dist/cli-node.mjs is missing — the build step the old in-job ordering
provided implicitly was restored explicitly. Concerns: ledger call-site
count corrected (8 src + 7 test); a duplicate assertion + the
now-inexpressible "does not implicitly consult" test collapsed in
config.test.ts; five further stale resume comments swept (aider ×3,
openhands ×2, opencode-sdk ×1 across builder/index/harness files).

Gates: tsc clean; biome full-tree clean; zero-count greps
(_setSaveConfigForTests 0; HarnessResumeSupport|RESUME_FLAG|
AkmHarness.resume 0 in src TS); harness+agent+config suites 448/0
post-fix; improve bucket green; architecture ratchets 28/28 un-piped;
full lint green (47 frozen goldens hash-verified).

## WI-9.2 — typed-error sweep (landed with this entry)

CENSUS/PLAN CORRECTION (the headline finding): plan §10.7's "79
user-facing in commands/" vastly overcounts. Site-by-site disposition of
all 78 commands + 26 core bare `throw new Error(` sites found only 10
genuinely user-facing conversion candidates; 87 are correct as
INTERNAL-classified invariants — dominated by the proposal/mv/fs-txn
crash-window machinery (21+21+8 sites: rollback divergence, journal
fences, phase races — deliberately INTERNAL, §15-rule-3 adjacent),
module-load weight assertions, caught-locally control-flow, and
external-operation failures (network/checksum/spawn during upgrade and
ripgrep install) that fit none of config/usage/not-found; extending the
taxonomy with a fourth kind was NOT plan-ordered and is not done here.

Converted (10 sites, messages byte-verbatim, class+code only):
- self-update.ts ×4 → ConfigError: UNSUPPORTED_PLATFORM (platform
  matrix); UPGRADE_BLOCKED ×3 (0.8→0.9 migration-contract block,
  EACCES/EPERM write refusal, retained-backup overwrite refusal; the
  contract message hoisted to a const, bytes unchanged).
- source-clone.ts ×3: ConfigError STASH_DIR_NOT_FOUND (no stash + no
  --dest); UsageError RESOURCE_ALREADY_EXISTS ×2 (exists w/o --force).
- proposal/repository.ts ×2 → UsageError: INVALID_FLAG_VALUE (re-accept
  with diverged accepted content — matches sibling :1801),
  INVALID_PROPOSAL (unresolvable ref at accept).
- core/ripgrep/install.ts ×1 → ConfigError UNSUPPORTED_PLATFORM.
New codes (append-only, ConfigError): UNSUPPORTED_PLATFORM,
UPGRADE_BLOCKED. No new hints (messages carry remediation).
BEHAVIOR: these 10 paths move from exit 70/no-code envelopes to exit
78/2 with a stable `code` field — the intended §10.7 change.

Skipped (2 sites): source-clone.ts self-clone guards — pinned RAW by
frozen golden cli/f-raw-error-sites.json, whose designation notes name
it "the typed-error sweep's oracle that these do not silently gain an
AkmError code". Skipped per the surface-owner rule; conversion would
need explicit re-designation.

Kept (6 out-of-hierarchy Error subclasses, all verified by consumer
inspection): LlmFeatureTimeoutError, LlmCallError, UnitTransportError,
ResponseTooLargeError (each caught by identity — internal control-flow),
UnitCapExceededError (never thrown; message harvesting only),
UntrustedNpmTarballError (already code-stabilized + identity-pinned by
tests; security refusal with no taxonomy fit).

Flagged-torn (left bare, revisit if the taxonomy grows a kind):
self-update's 4 checksum-verification refusals; env/secret.ts:67 lock
timeout. Remaining bare counts: src/commands 69, src/core 25, src total
201 (from 211) — the residue is invariants by design, not backlog.

Gates: tsc clean; biome clean (1046 files); architecture 28/28
un-piped; frozen txn oracles 22/0 (repository.ts is txn-adjacent);
goldens-cli-output 25/0 (includes the frozen f-raw-error-sites oracle);
self-update/source-clone/ripgrep/common 125/0; proposal family 188/0;
module-boundaries + consolidate-wave2-d + sources-cli-envelope 26/0.
No test or golden updates were needed.

## WI-9.3 — dedup families (landed as 7 commits, b295dac2..3278db56)

(a) caps() ×10 + (b) homeDir() ×2 → harnesses/shared.ts. Byte-identity
verified (single md5 across all 10 caps copies). HarnessCapabilities
moved verbatim into shared.ts (dependency sink) with a types.ts
re-export — placing the helper anywhere importing types.ts would have
grown the 61-file cycle SCC; ratchet verified 107/107 after.
(e) scheduleKillLadder: spawn.ts's two inlined SIGTERM→SIGKILL copies
(flag-before-signal ordering, exited re-checks, unref'ed 5 s follow-up)
→ one module-private helper. DEVIATION (sanctioned escape hatch): the
opencode-sdk sdk-runner ladder stays — bare child kill (no process
group), exit-listener-cleared escalation timer, SIGTERM-throw rollback,
idempotence guard; parameterizing needed 6+ knobs. runAgent 298→294
(stays baselined; ratchet shrink-tolerant).
(f) semver engine → registry/semver.ts, pure verbatim move; only export
keywords changed; maxSatisfying re-exported from resolve.ts (surface
unchanged). runtime.ts semverOrder deliberately NOT unified (different
contract).
(c) withFreshnessCache (sources/freshness.ts): both mirror sites'
semantics were identical; ladder extracted with ttl/stale/force/isUsable
knobs; refresh specifics stay at call sites.
(d) AbstractSessionLogProvider (session-logs/provider-base.ts):
PLAN CORRECTION — the two providers share scaffolding (statSafe, walk,
mtime-filtered listing loop, flat line→event scan, conditional-spread
ref assembly), not a full template; their listing/reading strategies
genuinely differ (recursive JSONL + peek vs SQLite store + JSON tree).
Net +94 LOC for single ownership. Nano-delta recorded: a legacy
opencode session meta with directory:"" now omits projectHint instead
of emitting "" (unreachable in practice, unpinned).
(g) connection-shared.ts: prompts/probe/derivation extracted with copy,
order, initialValues, and validation messages verbatim; wizard oracles
(setup-wizard, setup-run) green UNMODIFIED. stepLlm 250→143,
stepSmallModelConnection 272→152 — both trimmed from
SRC_FN_SIZE_BASELINE (20→18 entries).
(h) TRAP-4 RESOLUTION: consolidate's parseSinceToIso shadow relied on
pass-through-on-garbage (caller compares the returned string against
mtime-ISO strings; golden-pinned by goldens-duration-flags +
since-to-iso-identity-fallback.json) — the canonical throws AND
normalizes, so a try/catch wrap would NOT have been behavior-preserving.
Added documented parseSinceToIsoLenient to core/time.ts; shadow
deleted. extract.ts m-AMBIGUITY CONFIRMED: its recognizer is
case-insensitive (5M = 5 minutes, pinned by e-extract-since.json) vs
the core grammar's case-sensitive M=months; extract keeps its regex,
delegates only unit arithmetic to parseDuration. memory-improve "N days
ago": zero-count confirmed (resolveRelativeDates is M-5 content
rewriting, unrelated).

Net LOC: batch A −20, batch B +70 (families c/d trade lines for single
ownership; g is the reducer at −81). Gates per batch: tsc, biome,
cycle ratchet 107/107, fn-size (18 entries), architecture 28/28,
wizard/session-log/consolidate/extract/registry/spawn suites all green,
zero test-file modifications. Review process note: batch B ran under
the delegated-implementation/self-review split (session directive,
2026-07-16); reviewer re-ran the wizard + duration oracles and the
decisive ratchets independently before commit.

## Decisions 4–5 closed (with WI-9.4)

(4) --format html surface: `html` stays a valid --format value; the
generic JSON-in-<pre> fallback is deleted and non-health commands now
get UsageError INVALID_FLAG_VALUE ("html output is only available for
`akm health`"). Verified BEFORE the change that no golden pins the
deleted surface, and that error envelopes never route through output()
(emitJsonError owns them independent of --format), so the throw cannot
mask a real failure. (5) Deterministic embedder: NO-OP confirmed — the
AKM_EMBED_DETERMINISTIC facade (4 sites in embedder.ts) and the pure
implementation stay in place; the plan's −60 relocation is recorded as
overstated-at-HEAD (the facade must import the implementation; moving
it would break scripts/akm-eval's real-binary runs).

## WI-9.4 — output/report surface (b1ffdf57..d8ed2110)

(a) createCommandRegistry<H> (output/command-registry.ts) behind both
registries; exported names/signatures unchanged; registry semantics
(last-write-wins, silent delete, undefined-on-unknown) verified against
both originals. (b) text/helpers.ts 1418→84-line re-export barrel over
show-format/show-directives/workflow-format/proposal-format/
command-format; all 63 function bodies verified byte-identical by a
function-level extractor except formatShowPlain's intended directive
delegation (directive strings byte-identical). command-format.ts is a
deliberate broad stateless bucket to respect the 4-module cap.
(c) html health-only per Decision 4; default.html (−78) +
DEFAULT_TEMPLATE + the shared.ts html case deleted; 2 test files
rewritten to expect the typed refusal. (d) echarts CDN-only: vendored
echarts.min.js DELETED (−1,034,102 bytes), inline mode + echarts/
echartsLibPath options + AKM_ECHARTS env + copy-assets warning removed;
BEHAVIOR: charts need network at view time (plan-accepted §13.1);
health.html comment updated; _preload allowlist trimmed. (e)
rank-metrics.ts → scripts/akm-eval/src/rank-metrics.ts verbatim
(function-diff verified); curate-metrics shim repointed; STALE header
doc corrected (collapse-detector production claim was false); one test
import repointed; src/core/eval/ removed. (f) embedder no-op verified.

Gates (worker + reviewer independently): tsc; biome (1056 files);
cycle ratchet 107/107; full `bun run lint` incl. goldens-presence 50/50
(47 frozen hash-verified — neither deleted asset was designated);
architecture 28/28; output/text suites 246/0; html suites 22/0; curate/
collapse suites 26/0; combined touched-suite re-run 341/0; reviewer
re-ran tsc + cycles + full lint + architecture + cli-output/html
oracles (59/0). Process: Sonnet implementation / Fable review per the
2026-07-16 session directive.

## WI-9.5 — health/tasks decomposition (16e7ef8e..6c706c7f)

(a) H2 typed seam: report-view-model.ts (819 lines) holds the pure
AkmHealthResult→HealthReportViewModel extractor; html-report.ts
1050→567 as thin VM→fragment renderers + glue. Rendered bytes
unchanged (oracles green unmodified). EMERGENT: the fn-size ratchet
flagged the freshly extracted 341-line VM builder as a NEW offender —
decomposed into phase helpers rather than baselined (the gate working
exactly as armed). md-report.ts untouched (its WindowResult tables
don't map onto the VM shapes — brief allowance exercised).
(b) akmHealth 272→orchestrator over six gather/resolve phase helpers;
one behaviorally-inert simplification ledgered (redundant `&& db`
conjunct dropped — non-optional by control flow at that point).
(c) projectRunMetrics 270→ten per-subtree apply* helpers, verified
disjoint (no cross-block reads); summarizeImproveCompleted untouched
(do-not-re-churn honored).
(d) health/types.ts 690→33-line re-export barrel over 7 flat
types-<domain>.ts siblings (flat naming avoids the types/ dir
collision); one-directional deps; pure type move.
(e) BackendExec<Extra> (default `unknown` — Record<string,never>
rejected legit test-mock excess properties) + throwIfNotOk/runOrThrow
in exec-utils.ts; 13 sites converted with class/code/message/hint
byte-preserved (reviewer verified originals were already ConfigError
INVALID_CONFIG_FILE); CronExec deliberately NOT converted (bespoke
read/write shape); rollback accumulate-and-continue blocks deliberately
inline; *Fs dedup via NodeFs intersections; backends barrel untouched
(WI-9.8's cycle kill). BackendOptionsBase evaluated and rejected
(3 shared fields — not worth the churn).

fn-size baseline: 3 more entries trimmed (buildHealthHtmlReplacements
646, akmHealth 272, projectRunMetrics 270) — baseline now 15 entries.
Net LOC +610 (typed-interface surface for the VM + domain-type files —
structural investment, ledgered against the §12.1 REPORTED target).

Gates (worker + reviewer): tsc; biome 1064 files; cycles 107/107;
fn-size trimmed-and-green; full bun run lint (goldens 50/50);
architecture 28/28; health suite 78/0; tasks suites 133/0;
html-output-cli 6/0; ZERO test files modified. Reviewer re-ran tsc,
fn-size, architecture + both html/cli oracles (52/0) and verified the
backend-throw byte-preservation claim against the diff directly.

## Decision 6 recorded + WI-9.6 landed (two commits)

DECISION 6 (session): pushOnCommit becomes warn-and-IGNORE for one
minor (schema field + one-time warning stay; ALL behavior mapping
deleted; field removed in 0.10) — consistent with chunk-6's
--auto-accept precedent. BEHAVIOR: pushOnCommit:false no longer
suppresses improve's default sync push (the write-source half of the
mapping was a proven no-op — analysis in the commit).

WI-9.6: (a) nine narrow per-process schemas replace the monolith at the
process-map keys; the wide schema stays as TS-type/$defs source with
identical accepted shape (drift-contract green); field→process map
derived from comments CROSS-CHECKED against consumers — two
comment/code mismatches caught (qualityGate also on reflect; limit on
reflect/distill/consolidate/proactiveMaintenance); NO .default()s
(deliberate deviation from the brief's "real .default()s" phrasing —
materialized defaults would shift downstream ?? fallbacks; recorded).
BEHAVIOR: wrong-process fields now rejected (intended §4.2 narrowing;
all repo fixtures parse unmodified). mergeInformationFloor comment
corrected (live-gates the measurement; outcome advisory);
outcomeWeightEnabled stale default-false claim corrected (default-on).
(c) graph-extraction type allowlist deleted (accept-any until Chunk 2);
the schema allowlist had ALREADY drifted from the runtime's own
supported-types set; unknown types are silently skipped at runtime.
BEHAVIOR: previously rejected type strings now parse. (d) wikiName +
migrations.ts zero-diff verified. schemas/akm-config.json regenerated
(−8951/+2903 — the narrowing dominates). Test changes: 2 behavioral
updates justified by the ledgered changes, 2 rewordings, 0 weakenings.

Gates (worker + reviewer): tsc; biome 1064; cycles 107/107; regen
check green; full lint; architecture 28/28; config suites incl.
drift-contract green unmodified; improve sweep 872/0 across 63 files.
Reviewer verified the pushOnCommit diffs line-by-line and re-ran
tsc + full lint.

## WI-9.7 — H1 capability union (one commit)

Design: discriminated union on capabilities.sessionLogs (two-member
HarnessCapabilities union + overloaded caps() returning the precise
member — zero changes to the ten harness declarations) with
isSessionLogHarness type-predicate narrowing for the registry filter.
Forward load-time throw (sessionLogs:true without provider) DELETED —
now a compile error; its duplicated test assertion removed, the
name-resolution assertion kept. Reverse-invariant throw KEPT with
documented justification: provider runtime name → harness resolution is
not expressible in types and guards against silent downstream
misattribution. BaseHarness implements the common core and no longer
declares sessionLogProvider at all (an optional declaration would
violate the false-branch's undefined-only field). No 3-object split
(plan-rejected). Types-only; zero runtime delta.

Gates (worker + reviewer): tsc; biome; cycles 107/107; architecture
28/28; harness/agent/session-log suites 420/0 (reviewer re-ran 64/0
core subset); grep-verified exactly one remaining throw (the kept
reverse guard).

## WI-9.8 — import-cycle kills (bca3cd8d + 3ac33ffd)

Baseline 107 → 31. Batch A (eight small knots, −20): type-leaf severs
with old-home re-exports — events-types, ranking-types,
wiki-fetchers/types, graph-types (+ graph-db dependency inversion),
core/git-message (sanitizeCommitMessage), backends/types,
HarnessConfigImporter → harnesses/shared sink (the Decision-2 adopted
trio); the graph pair needed only deleting an unused re-export. Batch B
(three big knots, −56): (1) proposal-types.ts leaf frees the proposal
engine + validators + 5 improve satellites; frozen txn oracles
byte-green throughout; EligibilitySource moved leaf-ward as a Proposal
dependency (old home re-exports — could re-home to improve-types later,
zero-consumer churn either way); (2) the four verb result types moved
DOWN into core/improve-types (the §10.7 inversion ends); improve trio
(SCC #8) deliberately left for WI-9.10; (3) harnesses/ids.ts
dependency-free id table with a loud construction-time registry assert;
requireLlmConfig/getDefaultLlmConfig relocated to engine-resolution
(API move — config.ts cannot re-export without keeping the graph edge;
5 src + 2 test call sites repointed).

TECHNIQUE NOTE (recorded for maintainer visibility): four residual
type-only back-edges (builder-shared→spawn, engine-resolution↔runner,
workflows/program/{schema,parser}→agent-runtime) were converted to
inline `import("...")` TYPE QUERIES rather than moved — the same idiom
config-types.ts has used since #565 ("unambiguously type-only …
creates no runtime import cycle"). These are erased at compile time and
invisible to the static-graph lint BY the lint's own parsing rules (it
counts top-level import declarations); the philosophically-pure
alternative (moving AgentRunResult/RunnerSpec/LlmInvocationOverrides/
AgentFailureReason to leaves) remains available if the maintainer
prefers — candidates for Chunk 3's renderers-hub dismantling. No
`await import()` anywhere; dynamic-import baseline untouched (verified
0 additions in the diff).

Exit state matches Decision 3 EXACTLY: 31 = renderers-hub taxonomy blob
(C3) + indexer-db trio (C5) + workflows-runtime trio (C8) + improve trio
(WI-9.10) — and BETTER than predicted: no config file remains held via
the agent-runtime bridge, only via renderers. Gates (workers + reviewer):
tsc; biome; cycle lint 31/31 with pure-deletion baseline diffs (20+56);
architecture 28/28; frozen oracles 22/0 re-run after EACH
repository-touching kill and by the reviewer; proposal family 233/0;
improve 396/0 + 333/0 integration; config/contracts 140/0;
agent/harness 373/0; workflows 170/0; setup suites green.
