# Chunk 9 — deletion/behavior ledger

Opened at HEAD `365f5b09` (chunk 6 closed; full check green 4454/0/55 in
the integration stage, exit 0 overall). Work items land per brief order;
this ledger records each item's deletions, behavior changes, gate
evidence, and net LOC as it lands. Status: CLOSED (header corrected 2026-07-21 — the body's close-out record was already present; this line had gone stale).

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

## WI-9.9 — ParsedInvocation: argv parsed once (a550ed12)

New `src/cli/invocation.ts` (306 lines, ZERO imports — a true leaf):
`ParsedInvocation { argv, userArgs, getFlagValue, hasFlag,
getAllFlagValues, passthroughArgs }`. `cli.ts` calls
`setParsedInvocation` exactly once, immediately after
`normalizeShowArgv` rewrites `process.argv` — so every consumer sees
the POST-normalization view, same as before. Semantics preserved
verbatim: `getFlagValue` is first-occurrence with both `--flag value`
and `--flag=value` forms; `getAllFlagValues` folds in the old
`parseAllFlagValues` INCLUDING the BUG-M4 skip-index quirk (a `--flag
--otherflag` sequence consumes the next token unconditionally) —
behavior-preserving, not a bug fix. `passthroughArgs` extracts the
`-- <command>` tail used by env/secret exec.

FALLBACK SEMANTICS (the load-bearing design point): when the singleton
is unset, accessors fall back to reading `process.argv` LAZILY and
UNCACHED on every call. The in-process CLI test harness never runs
`main` (so never sets the singleton) and mutates `process.argv` between
invocations; caching the fallback would freeze the first test's argv
into all later tests. Production always sets the singleton, so the
uncached path is test-only. `_resetParsedInvocationForTests` provided
for explicit isolation.

Folded in verbatim: `parseAllFlagValues` (from cli/shared.ts, now a
re-export), `findCittyTopLevelCommand`/`findCittyTopLevelCommandIndex`
and `resolveHelpMigrateVersionArg` (from cli/parse-args.ts, re-exported
likewise) — zero importer churn.

Converted sites (14 across 9 modules): remember.ts, stash-cli.ts,
sources-cli.ts, search-cli.ts, improve-cli.ts (flag reads);
env-cli.ts + secret-cli.ts (`passthroughArgs()` for the `-- <command>`
tails); workflow-cli.ts (`hasFlag("--dry-run")`); plus cli.ts itself
and parse-args.ts internal uses.

New ABSOLUTE lint `scripts/lint-process-argv.ts` (wired into the
package.json lint chain): `process.argv` may appear only in
`src/cli.ts` and `src/cli/invocation.ts`. One narrow exemption:
`src/runtime.ts` `process.argv[1]` main-path check (runtime bootstrap
runs before any invocation exists; reads the script path, not user
args). Any new raw argv read anywhere else fails lint outright — no
baseline, no ratchet.

Gates (worker + reviewer independently): tsc clean; lint-process-argv
OK; import-cycle ratchet 31/31 (invocation.ts adds no edges — zero
imports); dynamic-import baseline untouched; full `bun run lint` green
(goldens-presence 50/47-frozen, schema up to date); architecture +
cli-goldens + show-argv suites 63/63; worker's full commands sweep
1379/0.

## WI-9.10a — RunContext unification + SCC #8 sever (8e182d44)

Sonnet worker implemented; reviewer verified gates + applied one
correctness fix. New leaf improve-run-types.ts: 7 shared types moved
verbatim (improve.ts re-exports; 3 stage-fn test seams use inline
typeof import() queries, #565 precedent) + ImproveLoopState wrapping
the minted RunContext. ImproveRunContext DELETED; adoption ratchet
baseline emptied → absolute, with a permanent anti-revival guard.
createRunContext at the akmImprove entry from already-resolved setup
values; eventsCtx blocker closed (built post-resolution, D14 shape
untouched); ctx.signal is the identical watchdog-stamped AbortSignal.
Cycle baseline 31→28 (improve/loop-stages/preparation out).

REVIEWER FIX (behavior preservation): worker mapped primaryStashDir? →
ctx.stashDir with a truthy "." fallback — on the rare unresolvable-
primary path (resolveSourceEntries throws/empty) every downstream
`if (primaryStashDir)` guard would have FIRED against "." or a
rejected path instead of skipping. ImproveLoopState keeps an explicit
`primaryStashDir: string | undefined`; ctx.stashDir stays best-effort
and unread on that path. Documented in-code; collapse awaits a
maintainer decision on retiring the unresolvable path.

Gates (worker + reviewer): tsc; full lint; cycles 28/28; fn-size both;
architecture 28/28; improve family + frozen txn oracles 535/0
(reviewer, single un-piped run) and 557/0 + 22/0 (worker).

## WI-9.10c — createRunContext at the 4 remaining verb entries + D6 memo consumers (1247b0ec)

Sonnet worker implemented; reviewed by a 6-agent adversarial Opus
workflow (per-verb reviewers for reflect/distill/extract/consolidate +
an adoption-ratchet reviewer + one serialized gate-runner, then 3-lens
refutation of every finding). Zero findings survived; zero raised.

akmReflect/akmDistill/akmExtract/akmConsolidate each build a run-scoped
RunContext via createRunContext at entry from already-resolved values
(stash, config, resolved runner/profile) — no second config load, no new
db handle, no reordering of engine-resolution error priority (built only
after config/runnerSpec exist). All 5 improve verb entries are now on the
minted seam (manifest gate 4).

D6 read-once memo gains its FIRST real content-read consumers (closes the
chunk-7 deferred decision, ledger ~955): reflect's readRelatedLessons
reads lessons via a per-invocation withFreshAssetMemo() scope — verified
no same-path write follows in the invocation, so memoizing is safe;
distill reads the target asset through its memo and REFRESHES via
ctx.writeAsset on the in-loop salience stamp (run-context.ts:816 case) so
a later readAsset returns post-write bytes; extract routes its content
read through the memo likewise.

extract's recorded chunk-7 type blocker (getLlmConfig returns
LlmProfileConfig, not LlmConnectionConfig|null) bridged locally at the
construction site — adapter wraps the resolved profile getter to
RunContext's signature WITHOUT widening the RunContext type. Empty
eventsCtx:{} / proposalsCtx:{} used only where no consumer dereferences
them this stage (verb-level proposal/event RunContext adoption is future
work). reflect (emitReflectInvokedAndBuildFailureEmitter, buildReflect-
RunContext) + extract (buildExtractRunContext) gain verbatim fn-size
decompositions — improve/** stays absolute-empty.

run-context-adoption.test.ts: new per-verb-entry adoption assertion
(gate 4) — each of the 5 entry files (improve/reflect/distill/extract/
consolidate) must CALL createRunContext(, not merely import it; the seam
existence pin is upgraded to a real load-bearing-usage check. Gate 3
(absolute ImproveRunContext=0 + anti-revival guard) preserved.

Gates (Opus gate-runner, sequential un-piped; reviewer-confirmed
independently for the two ratchets the lint chain omits): tsc clean;
full lint chain OK (process-argv/goldens-presence 50-/47-frozen/schema);
import-cycles 28/28 + dynamic within baseline; improve + src fn-size
exit 0; architecture 28/28 (1162 expect); frozen txn oracles 22/22
byte-green; improve command+integration family 485/0; D6 run-context
memo contract 7/7.

## WI-9.10d — resolveStashDir into the improve builder (improve-scoped) (2bfa0a34)

Sonnet worker; Opus inline review (diff is a definitional no-op —
proportionate to a 4-line semantic swap, no 6-agent workflow) + two
fast gates re-run independently by the reviewer.

New resolveRunStashDir(explicitStashDir?) in run-context.ts (the improve
builder module) ≡ `explicitStashDir ?? resolveStashDir()`. akmDistill
(:798)/akmReflect (:1694)/akmExtract (:1440) call it instead of
resolveStashDir() and drop the core/common resolveStashDir import — so
the ambient read is confined to the builder module on the improve path.

MAINTAINER DECISION (recorded): scope is improve verb entries ONLY. The
CLI-wide resolveStashDir sweep is DEFERRED — see the WI-9.10e/deferral
entry below. Manifest gate 1 ("resolveStashDir residual only in the
RunContext builder") is read at IMPROVE scope this chunk: on the improve
path, resolveStashDir now appears only in run-context.ts. The ~13
non-improve call sites (health, lint, mv-cli, proposal ×3, sources ×2,
tasks/tasks, wiki-cli) and the shared leaves reached by improve as
params-not-ambient (write-source, indexer, search-source, manifest,
filesystem, tasks/runner, tasks/validator, workflows/authoring) still
call resolveStashDir directly and are booked in the deferral.

Gates (worker + reviewer): tsc; import-cycles 28/28 (the new core/common
value import into run-context.ts adds no participant — common imports
only asset-spec/errors/paths) + dynamic within baseline; improve fn-size
clean; full lint (one Biome import-order autofix on the ./run-context
line, no behavior); architecture 28/28; improve command+integration
family 485/0; frozen txn oracles 22/22 byte-green.

## WI-9.10e — ambient-DI seam retirement: DEFERRED (consequence of the WI-9.10d scope decision)

NOT LANDED THIS CHUNK — recorded as a named deferral, not silently
skipped. Grounding finding: of the seam inventory (anchors A.1), the
crash-window seams (#1–3 fs-txn/proposal/mv, #16–17 migration hooks) are
RETAINED per Decision 1. The remaining 13 ambient-DI seams
(_setChatCompletionForTests, _setWarnSinkForTests, _setClackForTests,
_setAkmInitForTests, _setAkmIndexForTests, _setAgentDetectForTests,
_setEmbedderForTests, _setDetectForTests, _setDefaultTasksForTests,
_setLoadSetupStashesForTests, _setTransformersLoaderForTests,
_setBackendsForTests, _setAkmImproveForTests) ALL live in NON-improve
modules — llm/client, llm/embedder(s), core/warn, cli/clack, setup/*,
indexer, integrations/agent, tasks/*, commands/sources/init,
commands/improve/improve-cli (a subprocess-spawn seam, crash-window-
shaped). None sits on the improve RunContext path: the improve verbs
call chatCompletion DIRECTLY (they do not read ctx.chat), so even
_setChatCompletionForTests is not retired by the improve RunContext
without converting every improve chat call to ctx.chat — and that seam
would still not delete (non-improve consumers remain).

"Retire the seams as their call sites convert" (brief WI-9.10e) is
therefore gated on the SAME general CLI-boundary RunContext threading
that the WI-9.10d maintainer decision deferred. Retiring these seams is
folded into that follow-on workstream (plan §2's general RunContext
{config, stashDir, dbs, adapters, clock, logger}; aligns with ch8/ch10
bundle supersession of stashDir). §10.1's −250 item is partially
realized (improve unification + improve-scoped stashDir); the ambient-DI
seam retirement + CLI-wide resolveStashDir remain outstanding under the
general-threading follow-on.

## WI-9.11 — chunk-9 close (2f7ea1bb + this entry)

### Four manifest gates — verified
1. **resolveStashDir residual only in the builder (IMPROVE SCOPE).** `grep
   resolveStashDir src/commands/improve/` → run-context.ts only. The
   CLI-wide sweep (non-improve commands + shared leaves) is the documented
   WI-9.10d/e deferral (maintainer decision). Gate read at improve scope.
2. **Cycle baseline == later-owned knots exactly.** Baseline = 28 entries,
   all C3/C5/C8-owned: the renderers-hub taxonomy residual (output/
   renderers.ts hub + config chain + asset core + workflows/program +
   indexer metadata/file-context + env), the indexer-db trio
   (db/entry-mapper/schema, C5), and the workflows-runtime trio
   (step-work/runs/unit-checkin, C8). No chunk-9-owned participant remains.
   Matches the WI-9.8 ledgered exit state; SCC #8 sever (9.10a) took 31→28.
3. **ImproveRunContext → 0 (adoption ratchet absolute).** The interface is
   deleted; the run-context-adoption ratchet (word-boundary identifier
   match) reads 0 and is absolute + anti-revival-guarded. NOTE: a naive
   substring `grep ImproveRunContext` returns 6 BENIGN hits — all the
   `buildImproveRunContext` builder function (mints the improve RunContext),
   not the deleted context; the authoritative ratchet distinguishes them.
4. **createRunContext at every improve verb entry.** `createRunContext(`
   present once each in improve.ts/reflect.ts/distill.ts/extract.ts/
   consolidate.ts; asserted by the adoption ratchet's per-verb-file check.

### Full `bun run check` — ONCE, green
lint (biome + all lint-* + schema up-to-date) ✓; tsc ✓; unit 9480 pass /
0 fail across 4 process-shards; integration 4450 pass / 0 fail (Ran 4505
across 334 files, 478s); exit 0. Chunk-0a CLI output goldens green within
the suites. Frozen txn oracles byte-green (re-run every transaction-
adjacent item this chunk).

### Net-LOC report — HONEST DIVERGENCE FROM TARGET
Manifest target: **~−2000** (core, fold-ins ledgered separately). Actual:
**+1995 src `.ts`** (added 8205, deleted 6210; 29 files added, 3 deleted) —
a ~+4000 swing in the WRONG direction, reported faithfully, not massaged.

Why chunk 9 is net-POSITIVE against a net-negative target:
- It is fundamentally a RESTRUCTURING chunk. The big deletions the −2000
  assumed (the taxonomy/renderers-hub dismantling) are DEFERRED to Chunk 3
  by the DoD-11 ownership map — the cycle baseline is trimmed to exactly
  those later-owned knots, not deleted here.
- Additive-by-design work dominates: 29 new typed leaf modules (WI-9.8
  type-leaf severs with old-home re-exports; WI-9.2 typed-error classes;
  WI-9.5 H2 view-model + BackendExec; WI-9.9 invocation.ts 306 +
  lint-process-argv 209; WI-9.10 run-context/improve-run-types), each
  carrying header + imports + interface boilerplate.
- WI-9.6 config discriminated schemas were ADDED while the wide monolith
  was RETAINED (session decision — TS type/$defs still source from it);
  the plan's −LOC assumed monolith REPLACEMENT. This alone is a large
  positive-vs-planned-negative swing.
- The fold-in negatives don't land in src `.ts`: echarts −1MB is a
  vendored asset delete; rank-metrics MOVED to scripts/ (not deleted from
  repo); html-template trim is small.

Per-area net (src .ts): integrations +288, cli +240, output +219,
improve +158, health +147, proposal +144, config +127, indexer +45,
cli.ts −34. Every area net-positive.

The LOC PAYDOWN for this chunk's architecture is deferred, not lost:
taxonomy/renderers deletion → C3; config monolith retirement + CLI-wide
RunContext threading + the 13 ambient-DI seam retirements → the
general-threading follow-on (WI-9.10d/e deferral). Chunk 9 delivered its
ARCHITECTURE goals (cycle 107→28, typed errors, RunContext unification +
5-verb adoption, health/tasks/config/output god decomposition,
ParsedInvocation, H1 union, process.argv confinement) with all gates
green; it did NOT hit the −2000 simplification target and is +1995
instead. Flagged for maintainer: whether to pull the taxonomy deletions
forward or revisit the WI-9.6 monolith-retention decision.

### Deferred out of chunk 9 (named, not silently dropped)
- WI-9.10e ambient-DI seam retirements (13 seams) — see the WI-9.10e entry.
- CLI-wide resolveStashDir sweep (~13 non-improve sites + shared leaves).
- Both fold into the general CLI-boundary RunContext workstream (plan §2).
- Crash-window seams (#1–3, #16–17) RETAINED per Decision 1.

Chunk 9 CLOSED at HEAD (36 commits from base 365f5b09).
