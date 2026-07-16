# Chunk 6 — Proposal → FileChange[] + one transaction: implementation brief

Grounded at HEAD `b393317f` (post-W1-a residuals; W1-a full check green
4481/0/55). Authority: plan §4.5 + §11 Chunk 6 + §12.3; manifest chunk id
"6" (amended 2026-07-16). All anchors below re-measured at this HEAD by two
read-only grounding passes; the plan's anchors are drifted ~4–130 lines.
NOT in this chunk (manifest notes): `#fragment` refs, `parseAssetRef → 0`,
legacy-import → migrator (Wave 2 / Chunk 5).

## Work items, in landing order

Each lands as its own commit(s) + push; scoped suites per item; the frozen
outcome oracles (`bun test ./tests/commands/proposal/goldens-proposal-txn.test.ts
./tests/commands/goldens-mv-txn.test.ts --timeout=30000`) run after EVERY
transaction work item; `bun test tests/architecture/ --timeout=30000` runs
UN-PIPED before every commit (W1-a lesson: a `| tail` once swallowed a red
gate exit).

### WI-6.1 — confidence-gate deletion (small, first; de-risked)

Delete: `runAutoAcceptGate` (improve-auto-accept.ts:142) + `makeGateConfig`
(:332) + the `getPhaseThreshold` read (improve-runs-repository),
`recordGateDecision` (repository.ts:870–888), `ProposalGateDecision`/
`ProposalGateDecisionOutcome` (:216–281), `Proposal.gateDecision` (:336),
the `autoAccept` config field, and Migration 012's `improve_gate_thresholds`
READ path ONLY — **the CREATE TABLE in migrations.ts is NEVER edited**
(append-only). KEEP `proposal/drain.ts` (deterministic, explicitly
non-confidence-gated — drain.ts:17). Loop-stages' gate call sites
(reflect + distill results → `runAutoAcceptGate(...)`, `gateCfg`
construction via `makeGateConfig`) unwire in the same commit.
BEHAVIOR-CHANGE LEDGER ENTRY REQUIRED: configs that set `autoAccept` lose
auto-accept behavior — ledger it plainly, don't soften it.
Flake note: improve-auto-accept.test.ts baseline at `b393317f` = 42/42
green ×3 consecutive runs (both suites: tests/integration/commands/improve/
improve-auto-accept.test.ts + tests/cli/auto-accept.test.ts). The suites
retire WITH the gate (§15 rule 1 pairing — deletion + replacement contract
tests in the same commit).

### WI-6.2 — mint FileChange[] + beforeHash through the envelope (the +40)

`FileChange` does NOT exist yet anywhere in src (verified). Mint per plan
§2.2: `FileChange { path; before?; after?; op }`; `Proposal` gains
`changes: FileChange[]` + `beforeHash` alongside (then in place of) the
single-content `ProposalPayload { content; frontmatter? }`
(repository.ts:194–199). The ONE producer seam is `emitProposal`
(proposal-envelope.ts:52–54 — built for exactly this). Producers (8):
5 facade sites (reflect.ts:1200, distill.ts:1116, promote-memory.ts:290,
extract.ts:901, consolidate.ts:2459) + 3 direct (propose.ts:304,
proposal.ts:238, schema-repair.ts:222). Consumers to convert: promote/
revert lease paths, diffProposal, dedup guard content-hash reads
(:662,:673,:700), drain.ts (:204,:222,:232,:316,:340), auto-accept
(deleted by WI-6.1 first), validators, output/text/helpers, bulk filters
(proposal-cli.ts:135,:239). SQLite row mapping: proposals-repository.ts
:58–118 — `content` + `frontmatter_json` are dedicated columns; the
changes/beforeHash envelope needs a schema-compatible mapping (metadata_json
or migration 019 — coordinate with WI-6.4's migration slot; append-only).

### WI-6.3 — collapse the journal engines into ONE FileChange transaction

The three (+1) engines at HEAD:
- proposal accept/revert txn: repository.ts:1032–1399 + :1528–1615 +
  entries :1639–1980; journals under `getDataDir()/proposal-transactions/
  <ns24>/<uuid>/journal.json`; phases prepared→asset-published→
  proposal-persisted→index-finalized→event-finalized→committed; fsync
  discipline via tmp+fsync+rename+dir-fsync (writeProposalJournal
  :1097–1122); before-hash verify on displace (:1597–1615) + hash-verified
  rollback (:1152–1179); recovery lazy at next mutation
  (recoverProposalTransactionsForStash :1353–1399, also called from
  proposal.ts:174).
- reject txn: repository.ts:1401–1526; DB-only; `getDataDir()/
  proposal-rejections/...`; NO before-hash (golden-pinned).
- move txn: mv-cli.ts:309–673 + :1020–1080; journal IN-STASH
  (`<stash>/.akm/mv-transactions/<txn>/`) — dual-home semantics golden-
  pinned; stage/replace divergence aborts (:576,:632); FOUR recovery
  entry points (mv-cli.ts:1237, repository.ts:1698/:1955/:1393,
  indexer.ts:556, index-written-assets.ts:71).
- consolidate journal (4th, simpler): consolidate.ts:618–751 —
  `<stash>/.akm/consolidate-journal.json` + consolidate-backup/; no fsync,
  no hashes; recovery abort/clean at akmConsolidate entry (:952). The
  archived d3-design.md deliberately left it for Chunk 6; once consolidate
  ops ride Proposal{changes: FileChange[]}, its write path is subsumed.
Preserve EXACTLY: fsync + tmp-rename discipline, before-hash abort
semantics (and reject's deliberate LACK of before-hash), exactly-once
events via insertEventOnce idempotency keys, idempotent re-accept
short-circuit, refuse-clobber on revert, lazy multi-entry recovery, git
exact-path commit boundary, index/state re-key ordering for moves.
Test seams `_setProposalMutationHookForTests` / `_setMvMutationHookForTests`
and the crash runners key on `journal.json.tmp → journal.json` renames —
keep equivalent interception points or mechanically re-key the runners as
part of the WI-6.5 re-baseline. Gate: the three (+1) journal dirs GONE:
`proposal-transactions/`, `proposal-rejections/`, `.akm/mv-transactions/`
(+ consolidate-journal.json/backup if collapsed), replaced by the one
transaction's home. repository.ts:76 imports
recoverInterruptedMoveTransactions from ../mv-cli — the unified engine
should dissolve this commands→commands edge (do NOT deepen the knots
Chunk 9 owns). fn-size: repository.ts has NO baseline entries — everything
new stays under 220 from day one.

### WI-6.4 — dedup/cooldown → fingerprints (+model-id) with retained backoff

SAME COMMIT as the machinery it replaces (live guard for 8 of 11
createProposal sites; the unguarded 3 are the human/force paths:
propose.ts:304, proposal.ts:238 force:true, schema-repair.ts:222).
Current machinery: ProposalSkipReason/CreateProposalSkipped (:435–447),
COOLDOWN_MS 14d/30d/7d (:472–480), contentHash (:483–485), guard call
(:609–612), checkDedupAndCooldown (:655–725). Replacement: the §23.6
input fingerprint (format-neutral spec :1243–1257): hash(recipe version +
target before hashes + evidence IDs/hashes + guidance hashes + evaluator
version) + an engine/model-id term; per-ref REJECTION BACKOFF RETAINED.
Fingerprint schema = migration 019 (018 is last; append-only) + DDL
characterization snapshot re-recorded in the same commit. If a fingerprint
change legitimately shifts a golden-pinned skip shape (proposal-txn.json
pins dedup/cooldown/force skip records!) that is a surface-owner
re-designation BEFORE the change lands + ledger entry — never a silent
re-record. NOTE: the frozen proposal-txn.json pins skip RECORDS — check
whether the new fingerprint skip reasons alter that fixture's shape; if
yes, the re-designation path applies to it too (registry + reviewed diff).

### WI-6.5 — re-capture the five re-baseline-@6 goldens (NAMED work item)

`journal/proposal-recovery.json`, `journal/move-recovery.json`,
`consolidate/journal-{lifecycle,recovery,guard-verdicts}.json` — all
registry-designated `re-baseline @6` (no sha256 while open). Re-capture via
`AKM_UPDATE_GOLDENS=1 bun test <suite>` per suite; land re-captured bytes +
reviewed diff + ledger entry + registry update (designation back to
frozen-migration-input + fresh sha256 + drop reBaselineChunk) in the SAME
chunk. journal-guard-verdicts pins consolidateGuardStatus verdicts
(eligibility.ts:60), not journal shape — expect a near-no-op diff. The two
recovery suite HEADERS still say frozen in comments — registry wins;
mechanical comment fix allowed. The frozen outcome oracles
(proposal-txn/move-txn) must stay BYTE-green; their suites may get
mechanical interception repoints only (e.g. the journal-dir cleanliness
helper at goldens-proposal-txn :117–130 repoints to the new home).

### WI-6.6 — bulkAdjudicateProposals + diff-formatter decompose (small)

Bulk: proposal-cli.ts:110–155 (accept) + :214–259 (reject) near-identical
loops + duplicated flag validation (:122–131/:226–235) → one
`bulkAdjudicateProposals` in proposal.ts (309 LOC home, already hosts
akmProposalAccept/:169 akmProposalReject). Diff: formatUnifiedDiff
(repository.ts:2065–2087, exported, pinned by
tests/proposal-repository-pure.test.ts:33–42) + formatNewAssetDiff
(:2089–2096) → own module; caller diffProposal (:2031,:2040) →
akmProposalDiff (proposal.ts:206–219).

### WI-6.7 — §15.7 fault-injection suite for the NEW engine + chunk gates

New suite proving: mid-apply fault leaves NO partial write across a whole
FileChange[] batch; before-hash mismatch aborts. Existing crash-window
suites (proposal-durable-recovery, mv-durable-recovery + runners) re-keyed
mechanically to the new engine's interception points. Chunk-end: full
`bun run check` ONCE; ledger finalized; net-LOC reported (~−800 target).

## Keep-green / oracle inventory

Frozen (byte-pinned): journal/proposal-txn.json (sha 1f33cd…),
journal/move-txn.json (sha 6990cd…). Re-baseline @6: the five above.
Safety suites (§15 rule 3, port-first): workflow-crash-windows,
migration-apply-crash, sqlite-journal-mode, config-recovery-concurrency —
adjacent, DO NOT TOUCH. Auto-accept baseline: 42/42 ×3 at b393317f.

## Trap list (chunk-specific)

1. Migration 012 CREATE TABLE never edited; only its read path dies.
2. repository.ts dedup/cooldown is LIVE for 8/11 sites — fingerprints in
   the same commit, backoff retained.
3. proposal-txn.json pins skip records — fingerprint-driven shape changes
   go through surface-owner re-designation FIRST.
4. reject has NO before-hash — golden-pinned; don't "fix" it.
5. mv journal is IN-STASH; proposal journals are in getDataDir() — the
   dual-home is golden-pinned until WI-6.5 re-captures.
6. Crash runners intercept journal.json.tmp renames — coordinate engine
   interception points with the runner re-key.
7. `| tail` swallows red exits — run gates un-piped before commits.
8. Never two bun test invocations concurrently; goldens under
   tests/commands/ run in the INTEGRATION bucket at chunk-end.

## Amendments from the gate/dedup grounding pass (2026-07-16, at f205c246)

Eight implementation-critical findings; four have clean compliant paths,
two are DESIGN DECISIONS to make explicitly in-ledger before WI-6.1/6.4
land, two are bookkeeping:

1. **Drain lives on the deleted symbols (DECISION REQUIRED).** drain.ts
   (KEPT) calls `recordGateDecision` at 5 stamp sites (:584 deterministic
   classify, :696 judgment-accept, :699 judgment-reject, :714 no-judge)
   and reads `gateDecision?.outcome === "auto-rejected"` (:575) as its
   re-adjudication guard ("audited-autonomous; no manual-review rung,
   06-M3"). The plan's DELETE row names recordGateDecision +
   Proposal.gateDecision wholesale. Compliant options: (a) retain
   recordGateDecision/ProposalGateDecision as DRAIN-owned audit machinery
   (relocate to drain.ts or a drain-owned module; the confidence-gate
   VOCABULARY tokens die, drain's deterministic tokens stay) — deviation
   from the plan's letter, ledgered; or (b) delete wholesale and replace
   drain's stamps + rejection memory with the WI-6.4 fingerprint/backoff
   records (the natural successor per the grounding) — bigger blast
   radius, same-chunk. Leaning (b) only if WI-6.4 lands first; otherwise
   (a) with a ledger deviation note. DO NOT delete the symbols before
   resolving this.
2. **consolidate's autoAccept is dual-purpose (DECISION REQUIRED).**
   consolidate.ts:1772 uses `opts.autoAccept === undefined` to gate the
   interactive confirm prompt (non-interactive default-no at :1779). The
   re-baseline-@6 consolidate journal goldens bypass via autoAccept:100.
   Deleting the knob needs a decided replacement trigger (e.g. an explicit
   `assumeYes`/non-interactive option threaded from improve), decided +
   ledgered in WI-6.1, and the goldens re-captured with the new bypass in
   WI-6.5 (they are already re-baseline @6 — no extra designation dance).
3. **Shipped default tasks pass `--auto-accept safe`** (default-tasks.ts
   :55–87, five tasks) + parseAutoAcceptFlag (cli/parse-args.ts:155–176) +
   tests/cli/auto-accept.test.ts. Flag-removal semantics (hard error vs
   warn-ignore) must be decided + ledgered; the shipped YAML templates
   update in the same commit.
4. **proposal-txn.json (FROZEN) pins the dedup/cooldown skip shapes**
   (fixture `skipShapes`: duplicate_pending / content_hash_match ×2 /
   cooldown / forceBypass; suite :429–533, :834–961). WI-6.4's fingerprint
   scheme legitimately changes these observable shapes → Chunk 6 becomes
   surface owner of that SECTION: re-designate BEFORE the change lands —
   preferred shape: split skipShapes out of the frozen asset into a new
   re-baseline-@6 asset (registry edit + reviewed diff), leaving the
   accept/revert/reject outcome scenarios frozen. Never a silent
   re-record.
5. **The DDL characterization suite is GONE** (deleted by the 07-15 purge
   commit 3927ff94, never restored); its snapshot
   tests/storage/__snapshots__/sqlite-migrations.characterization.test.ts.snap
   is orphaned at HEAD (covers 001–018). Migration 019 (WI-6.4) must
   RESTORE the test from git (3927ff94^) and re-record — do not write 019
   with no characterization oracle. Also: migration-lifecycle-regression
   self-adapts via STATE_MIGRATIONS.length; its STATE_PRE_CUTOVER_IDS
   frozen list is historical — do not touch.
6. **Free orphans to delete in WI-6.1**: persistPhaseThreshold
   (improve-runs-repository.ts:40–45, zero callers since 7.3) and
   listProposalGateDecisions (proposals-repository.ts:190–217, #612
   reader, zero callers since 7.3).
7. **Site-count drift**: createProposal sites at HEAD = 8 total / 6
   guarded (5 emitProposal + schema-repair) / 2 human force-bypass
   (propose.ts:304, proposal.ts:238). The plan's 11/8 counted the deleted
   recombine sites. No automated force-bypass remains.
8. **Health window keys `improve.autoAccept.{promoted,validationFailed}`
   are pinned by FROZEN cli/b-health-window-compare-md.json (Chunk 9's
   oracle).** Resolution: KEEP the keys (zero-valued for new runs;
   historical improve_runs rows still carry counters; the legacy
   `r.autoAccepted === true` metric path at improve-runs-repository
   :135–137 stays) — frozen-compatible, no re-designation. The
   gateAutoAcceptedCount/gateAutoAcceptFailedCount plumbing through
   loop-stages/preparation/improve result envelopes: keep the RESULT
   fields (envelope allow-list improve-result.ts:49–50 is a live output
   surface) reporting 0; delete only the gate calls that fed them.

### WI-6.1 refined deletion inventory (from the census)

Dies: improve-auto-accept.ts (whole file, 372 lines) + its two imports
(loop-stages.ts:52, preparation.ts:40); the 5 gate call sites + 2 gateCfg
constructions (loop-stages.ts:166–184, preparation.ts:300–312, :490–498)
+ the backlog-drain guard condition (preparation.ts:625–639);
getPhaseThreshold + persistPhaseThreshold; autoAccept schema field
(config-schema.ts:548 + regen), improve.ts:630 merge, improve-cli.ts flag
(:112–116,:179–180,:282,:293), parseAutoAcceptFlag; migration-012 read
path (never the CREATE TABLE; drop-table follows the 018 precedent IF the
plan wants the table gone — it doesn't say so; leave the table, delete
readers). recordGateDecision/gateDecision/formatGateDecisionSummary/
output-shape keys: per finding 1's decision. Suites retiring with the
gate: improve-auto-accept.test.ts (flake retires with it),
cli/auto-accept.test.ts, proposal-gate-decision.test.ts (if (b)) or
rewritten (if (a)); proposal-stuck-repair.test.ts is DRAIN-side —
rewrite to the replacement, never delete.
