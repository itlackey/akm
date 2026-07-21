# Chunk 6 — deletion/behavior ledger

Opened at HEAD `b393317f` (W1-a residuals closed, full check green
4481/0/55). Work items land per brief order; this ledger records each
item's deletions, behavior changes, gate evidence, and net LOC as it
lands. Status: CLOSED (header corrected 2026-07-21 — the body's close-out record was already present; this line had gone stale).

## Baseline records (pre-work)

- improve-auto-accept suites: 42 pass / 0 fail ×3 consecutive runs at
  `b393317f` (tests/integration/commands/improve/improve-auto-accept.test.ts
  + tests/cli/auto-accept.test.ts) — the ledgered order-dependent flake did
  not reproduce at this HEAD; any future red is attributable to the diff
  under test.
- Frozen outcome oracles green at `b393317f` (full-check integration
  bucket): journal/proposal-txn.json, journal/move-txn.json.
- Architecture ratchets 28/28 at `b393317f`.

## WI-6.6a — diff formatters decomposed (landed 4bd4502a)

formatUnifiedDiff + formatNewAssetDiff moved verbatim from repository.ts
into src/commands/proposal/diff-format.ts; pure-suite import repointed.
Behavior: none. Frozen outcome oracles byte-green; gates 28/28. Net:
repository.ts −41, new module +53 (doc header).

## Escalations recorded before WI-6.1/6.4 (from the gate/dedup grounding)

Two plan tensions requiring explicit decisions (recorded in the brief's
amendment section; neither blocks the other work items):

1. drain.ts (KEPT) is a live consumer of recordGateDecision +
   Proposal.gateDecision, which the plan's §4.5 DELETE row names
   wholesale. Options (a) retain-as-drain-owned vs (b) replace with
   WI-6.4 fingerprint/backoff records. Decision deferred to the session
   that lands WI-6.1; the deletion MUST NOT land before this is resolved.
2. consolidate.ts:1772 uses autoAccept === undefined as the interactive
   confirm-prompt trigger (dual-purpose knob). The knob's deletion needs a
   decided replacement trigger; the re-baseline-@6 consolidate goldens'
   autoAccept:100 bypass re-captures with it.

Also recorded: proposal-txn.json's skipShapes section requires
surface-owner re-designation BEFORE WI-6.4's fingerprint change (split
preferred); the DDL characterization suite must be RESTORED from
3927ff94^ and re-recorded alongside migration 019 (its snapshot is
orphaned at HEAD); health autoAccept window keys stay zero-valued
(frozen-golden-compatible); shipped default tasks' --auto-accept flag
semantics decided with WI-6.1.

## WI-6.6b — bulkAdjudicateProposals (landed with this entry)

The two near-identical bulk --generator loops in proposal-cli.ts (accept
:110–155, reject :214–259) + their verbatim-duplicated flag validation
collapse onto one bulkAdjudicateProposals(action, generator, filters) in
proposal.ts and a shared parseBulkFilterFlags CLI helper. Behavior
verbatim: same filter order (source → maxDiffLines on payload content
lines → olderThan on createdAt), same per-item accept/reject envelopes,
same dry-run record shape, same batch output shapes; the destructive
confirm prompt stays CLI-side. Suites: proposal-cli (bulk safety guard +
WS3 bulk paths) 44 green incl. frozen outcome oracles; gates 28/28.
Net: proposal-cli.ts −67, proposal.ts +63.

## Pre-WI-6.4 surface-owner re-designation — skipShapes split (landed with this entry)

Per the registry's surface-owner rule ($policy amendment 2026-07-16), the
createProposal dedup/cooldown/force skip-record shapes moved OUT of the
frozen journal/proposal-txn.json into a new
journal/proposal-skip-shapes.json designated re-baseline @6, BEFORE
WI-6.4's fingerprint scheme changes them. Mechanics: byte-faithful
stableStringify extraction (suite passes with NO update mode — proving
the split bytes match what the suite computes); proposal-txn.json sha256
re-pinned over the trimmed bytes (9c06e439…) in the same reviewed change;
suite gained a second expectGolden call; registry notes amended both
sides. Goldens lint: 50 assets, 41 frozen hash-verified. The
accept/revert/reject outcome scenarios stay frozen through the engine
swap, exactly as designed.

## DDL characterization suite restored (landed efe0a762)

tests/storage/sqlite-migrations.characterization.test.ts restored
verbatim from 3927ff94^ (the 07-15 purge deleted it, orphaning its
snapshot): 8 pass / 2 snapshots verified against the existing snap at
HEAD (001–018). Migration 019 (WI-6.4) has its characterization oracle
back before it lands.

## Decisions closed (maintainer, 2026-07-16)

The two escalations + the flag-semantics question were decided by the
maintainer (see brief DECISIONS section): (1) drain's gate-decision
machinery is RETAINED as drain-owned — a ledgered deviation from plan
§4.5's DELETE-row letter, rationale recorded; (2) consolidate's confirm
prompt re-gates on a new explicit assumeYes option; (3) --auto-accept
becomes warn-and-ignore for one minor with shipped templates updated,
hard removal in 0.10. WI-6.1 is unblocked and no longer
order-coupled to WI-6.4.

## WI-6.1 — confidence-gate deletion (landed with this entry)

BEHAVIOR CHANGE (live, plan §4.5): the `akm improve` confidence gate is
deleted. Configs/profiles that set `autoAccept` and invocations passing
`--auto-accept` LOSE auto-accept behavior entirely — reflect/distill/
extract/consolidate proposals now always queue as pending for adjudication
(`akm proposal`, drain engine), regardless of confidence. No replacement
automated accept path exists in improve.

Deletions: improve-auto-accept.ts (whole module, 372 lines — gate, config
builder, extract-confidence resolver); five gate call sites + two gateCfg
constructions + the extract backlog-drain gate (loop-stages.ts,
preparation.ts); `AkmImproveOptions.autoAccept` + the improve.ts profile
merge; `ImproveProfileConfigSchema.autoAccept` + schema regen (−12 lines in
schemas/akm-config.json); getPhaseThreshold/persistPhaseThreshold
(migration 012's readers — the CREATE TABLE and its migration block are
byte-untouched, append-only); listProposalGateDecisions (#612 orphan).
Retired suite: improve-auto-accept.test.ts (the ledgered order-dependent
flake retires with it).

Decision 1 (drain-owned retention — ledgered deviation from §4.5's
DELETE-row letter): recordGateDecision, ProposalGateDecision(Outcome),
Proposal.gateDecision, and every output renderer/shape key SURVIVE,
re-documented as the drain engine's deterministic audit machinery; the
improve-gate reason tokens are doc'd as historical-rows-only. drain.ts
logic byte-identical (comment re-scoping only; verified by adversarial
diff review). proposal-gate-decision.test.ts rewritten drain-scoped (only
the deleted gate's describe block removed; drain + rendering test bodies
byte-identical). proposal-stuck-repair.test.ts untouched.

Decision 2 (confirm gate): consolidate options lose `autoAccept`, gain
`assumeYes?: boolean`. The HTTP-path confirm prompt fires on interactive
TTY when `assumeYes` is not true; the non-interactive default-no branch is
byte-identical. SECOND BEHAVIOR NOTE: improve's consolidation pass threads
`assumeYes: consolidateOptions?.assumeYes ?? true` — the pipeline is an
automated batch flow and must keep APPLYING consolidation plans (shipped
tasks previously got the prompt-bypass via `--auto-accept safe`; without
this thread, every scheduled run would burn the full LLM planning pass and
abort pre-apply, and consolidate's merge/delete ops are direct FS writes
with no drain path). Corollary: a bare interactive `akm improve` on the
HTTP path now applies the consolidate plan instead of prompting — the
prompt is owned by standalone/programmatic consolidate invocations.
goldens-consolidate-journal.test.ts repointed its three bypass sites
autoAccept:100 → assumeYes:true; all three re-baseline-@6 consolidate
goldens stayed BYTE-green (the knob never reached pinned output).

Decision 3 (--auto-accept warn-and-ignore for one minor):
parseAutoAcceptFlag warns-and-ignores (never throws — installed crontabs
embed the flag; a hard error would fail scheduled runs invisibly). The
five DEFAULT_IMPROVE_TASKS commands + assets/tasks/core/improve.yml drop
the flag; tasks.ts STALE_GENERATED_COMMANDS keeps its old-spelling match
keys, replacements drop the flag; help-improve.md + the tasks-cli example
updated. cli/auto-accept.test.ts rewritten to pin the deprecation contract
(absent → silent; any present value → exactly one warning, never a throw).
Hard removal in 0.10 (roadmap note lands with Chunk 10's docs sweep).
Known residue: tasks already generated with the `--strategy X
--auto-accept safe` spelling match no upgrade-map key and will warn on
every run until repaired by hand or 0.10 — accepted.

Kept per grounding finding 8: gateAutoAcceptedCount/
gateAutoAcceptFailedCount envelope fields (live output allow-list) now
structurally 0; health `improve.autoAccept.*` window keys + improve-metrics
reads stay (frozen cli/b-health-window-compare-md.json compatible);
LoopRefTally counter fields stay. Replacement contract test (§15 rule 1
pairing): improve-memory-misc's "high-confidence reflect proposal stays
pending" (0.95 confidence → pending, no gateDecision stamp, no autoAccept
promoted event, envelope counts 0).

Live LLM-facing strings fixed (adversarial-review finding): the reflect
JSON-schema `confidence` description (reflect.ts) and the two response
contracts (integrations/agent/prompts.ts) no longer teach the model that
its score drives an automated accept path — rewritten to
reviewer/triage-judge framing; prompts-confidence.test.ts now pins the
ABSENCE of auto-accept language. Comment-only gate references in
consolidate/types.ts, distill.ts, extract.ts, outcome-loop.ts, and
tasks/parser.ts remain for Chunk 10's shipped-assets sweep.

Pre-existing red fixed in passing: journal/proposal-skip-shapes.json
(landed e5ce6b45) failed biome's JSON formatter; golden bytes are
machine-captured (stableStringify) and sha-pinned when frozen, so
tests/fixtures/goldens/**/*.json is now excluded in biome.json rather than
reformatting a suite-compared fixture.

Gates: full lint green (goldens presence 50 assets / 41 frozen
hash-verified; schema --check green); architecture ratchets 28/28
UN-PIPED; frozen outcome oracles byte-green (proposal-txn, mv-txn); scoped
suites green — improve unit+integration 464/0 (41 files), consolidate+cli+
tasks+health 323/0, drain/health-accounting/CLI-goldens 70/0, llm/agent/
integrations 409/0, affected fast suites 66/0, consolidate-journal goldens
11/0, improve-memory-misc 21/0. bunx tsc --noEmit clean. Adversarial diff
review: 0 blockers; both concerns (assumeYes threading, LLM-facing gate
strings) resolved in this commit. Net: 31 files, +245 / −1537.

## WI-6.2 — FileChange[] + beforeHash through the envelope (landed with this entry)

Minted src/core/file-change.ts (dependency-free): `FileChange { path;
before?; after?; op: create|update|delete }` per plan §2.2, plus the
structural `proposalContent()` accessor (changes[0].after ?? payload.content).
`Proposal` gains REQUIRED `changes: FileChange[]` + optional `beforeHash`.
`createProposal` derives them for every mint through the emitProposal seam
(all 8 producers, zero producer changes): target resolved against the
proposal's OWN stash (stash-relative, informational — accept re-resolves
from config), op = update iff the file exists, beforeHash = sha256 of the
mint-time on-disk content. The change's `before` body is a
transaction-time capture and is never set or persisted at mint time;
resolution failure degrades to a create.

Persistence is schema-compatible (metadata_json; NO migration — 019 stays
reserved for WI-6.4's fingerprints): stored `changes` drop entry-0's
`after` (implied by the content column; non-primary entries carry their
own) and never store `before`; `beforeHash` stored alongside. Legacy rows
synthesize `[{path:"", after: content, op:"update"}]` on read; the write
mapper tolerates legacy/malformed runtime objects (legacy-import parses
pre-envelope proposal.json files — a corrupt entry must not abort the
import batch).

Invariant `changes[0].after === payload.content` enforced at every
in-memory content mutation via new `withProposalContent()` (accepted-
publish + both schema-repair sites — the adversarial review confirmed by
exhaustive spread-hunt these are the ONLY payload-replacing sites; a
delete-op primary change is left `after`-less). Consumers converted to
`proposalContent()`: dedup-guard hash reads, diffProposal, revert's
legacy-accepted read, drain (isEmptyDiff / classify frontmatter / judgment
context / sibling sections), bulkAdjudicateProposals maxDiffLines,
consolidate cacheHash reads ×2, distill/reflect contentPreviews,
validators' content reads. Deliberately NOT converted: input-side payload
construction, output/text renderers (render the persisted shape;
CLI-golden-pinned), and the defensive payload-envelope guards inside
validators — all die with payload's eventual removal. Validators take the
accessor from core/file-change, NOT ../repository — the
repository↔validators knot (Chunk 9's) is not deepened; file-change.ts
imports nothing and joins no cycle.

Behavior: none observable — the accessor falls back to payload; frozen
outcome oracles (proposal-txn, mv-txn) and the consolidate goldens stayed
byte-green; skip shapes unchanged. metadata_json rows grow two keys
(changes, beforeHash) — no reader enumerates keys strictly (verified).
Adversarial review: 0 blockers; its one concern (malformed legacy
`changes` aborting an import batch) + two hardening notes (delete-op
`after`, a `proposalContent` local shadow in consolidate) fixed in this
commit. Tests: factories gained payloadChanges(); 13 suites' Proposal
literals extended mechanically; 4 new envelope contract tests in
tests/integration/proposals.test.ts (derivation create/update, round-trip
incl. no-duplication assertion, legacy synthesis).

Gates: full lint green; ratchets 28/28; scoped suites green (proposal
domain 166/0, oracles+consolidate+envelope 169/0 then 220/0 after review
fixes, improve buckets 443/0). tsc clean.

## WI-6.3a — unified fs-transaction engine core minted (landed with this entry)

New src/core/fs-txn.ts (pure addition, no behavior displaced): the ONE
journal home (getDataDir()/txn/<rootNs24>/<txnId>/journal.json), kind-tagged
journal envelope carrying a uniform JournaledFileChange[] view, the shared
tmp+fsync+rename+dir-fsync discipline (writeTxnFileDurably), durable phase
progression (advanceTxn), per-kind handler registry
(phases/commitPhase/validate/rollback/finalize), engine-level safety fences
(root binding, in-root change paths, known kind+phase, loud refusal of
unregistered kinds), rollback-before-commit-point vs
roll-forward-from-commit-point recovery dispatch (recoverTxnsForRoot),
cross-namespace listing (listTxnJournals), cleanup sweeping, and the single
crash-window seam _setTxnMutationHookForTests. Imports only core (fs, path,
crypto, core/paths, core/warn, core/file-change) — joins no cycle. Every
function under the 220 bar. Registration stays domain-side so recovery
entry points keep today's import topology (no new cycle participants, no
dynamic imports). tests/core/fs-txn.test.ts pins the engine contract with
synthetic kinds (9 tests): journal home/format, durable phases + unknown-
phase refusal, rollback/forward dispatch, fences (escape paths, foreign
root, unregistered kind), junk-dir sweeping, filtered recovery, and
crash-between-finalize-steps re-entry. Ports follow: 6.3b accept/revert,
6.3c reject, 6.3d mv, 6.3e consolidate.

## WI-6.3b/c — proposal accept/revert + reject engines ported onto fs-txn (landed with this entry)

Both bespoke proposal journal engines now ride the unified engine. Journal
homes getDataDir()/proposal-transactions/<hash(stash\0target)> and
getDataDir()/proposal-rejections/<hash(stash)> are GONE, replaced by the
one home getDataDir()/txn/<hash(root)> (proposal txns keyed by TARGET
root; reject txns keyed by stash). Phase vocabularies, commit points,
before-hash semantics (and reject's deliberate LACK of one), exactly-once
event idempotency keys, idempotent re-accept short-circuit, refuse-clobber
rollback, the irreversible-conflict guard, per-journal target re-binding,
and every safety fence are preserved verbatim (adversarial diff review
compared function-by-function against HEAD: 0 blockers). The crash-window
seam _setProposalMutationHookForTests forwards to the engine hook with
identical point names/positions; the subprocess crash runners and the
re-baseline-@6 goldens-proposal-recovery suite pass UNCHANGED (they
intercept journal.json.tmp renames + phase names, both invariant).
goldens-proposal-txn's journal-home cleanliness helper repointed
proposal-transactions → txn (the mechanical repoint the registry note
sanctions); fixture bytes untouched, frozen oracles byte-green.

Kinds "proposal" and "proposal-reject" are registered with the engine
(recovery adapters resolving config/target with root-binding checks) so
recoverTxnsForRoot can finish any root's interrupted mutations — no
in-src caller yet (the mv port adopts it next). Review concerns fixed in
this commit: listTxnJournals now fails LOUDLY on unreadable journals
(preserving HEAD's fail-closed scan); journal-less txn dirs are swept
only past a 5-minute grace window (kinds share a per-root namespace, so a
scanner could otherwise race a sibling beginTxn's mkdir→journal window);
beginTxn validates pre-minted transaction ids as plain path segments.
Notes accepted: acceptedTarget.root now persists the RESOLVED root
(inert — all consumers path.resolve); cleanup-failure warn prefix
[proposals]→[txn] (stderr-only rare path); legacy homes are not migrated
— the bespoke engines shipped only in 0.9.0 RCs (fa0f1210 first reachable
from v0.9.0-rc.3), never a stable release, so pre-upgrade interrupted
journals from rc builds are abandoned inert files.

Gates: tsc clean; full lint green; engine+oracles+recovery+durable+
proposals+ratchets 144/0 across 12 files.

## WI-6.3d — mv engine ported onto fs-txn; four entry points unified (landed with this entry)

The mv move-transaction engine rides the unified engine: the in-stash
journal home <stash>/.akm/mv-transactions is GONE (envelope root = the
stash; home = getDataDir()/txn/<ns(stash)>). Phase vocabulary
(prepared/applying/filesystem-committed/index-finalized/state-finalized/
event-finalized/committed, commit point filesystem-committed), the
two-sidecar citer protocol (backup-N/staged-N/owned-N), stage/replace
divergence aborts with byte-identical wrapped error messages, roll-forward
finalize (index re-key → write-path refresh → state re-key → exactly-once
mv event), and the crash-hook points are preserved verbatim (adversarial
review function-by-function vs HEAD: 0 blockers). The mv changes[] view
journals the rename as create+delete pairs + citer updates — all provably
inside the stash (read-only-source citers were never journaled).
_setMvMutationHookForTests forwards to the engine seam; the mv crash
runner and the re-baseline-@6 goldens-mv-recovery suite (10/10) pass
UNCHANGED; the FROZEN move-txn oracle is byte-green after the sanctioned
journal-home repoints in its suite (fixture bytes untouched;
goldens-mv-recovery's serialized dual-home `notes` strings re-capture at
WI-6.5).

The four recovery entry points now reach recovery through core/fs-txn
ONLY: repository.ts's three sites (the commands→commands
repository→mv-cli edge the brief ordered dissolved is GONE), and
indexer.ts + index-written-assets.ts replaced their DYNAMIC mv-cli
imports with static core imports — DYNAMIC_IMPORT_BASELINE trimmed
(index-written-assets removed, indexer 11→10; sites 102→100).
recoverInterruptedMoveTransactions survives as mv-cli's own thin wrapper.
Registration: cli.ts statically imports mv-cli, so every CLI process has
the kind registered; a programmatic consumer importing only
repository/indexer that encounters an mv journal fails LOUDLY
("No transaction handler registered") rather than skipping — ledgered as
the fail-closed trade of the dissolved edge.

Review-driven hardening in this commit: transaction roots are
canonicalized via realpath (symlinked stash spellings — e.g. macOS /tmp —
hash to the same namespace and bind-compare equal; HEAD's in-stash mv
home was spelling-independent, and the proposal engine's data-dir
namespace had the same sensitivity even at HEAD); journal JSON parse
failures are wrapped with the journal path; goldens-mv-recovery's
cleanliness helper repointed (its assertions had gone vacuously true
against the old home — evidence un-hollowed). Legacy-home note: the
bespoke engines shipped only in 0.9.0 RCs; pre-upgrade interrupted
journals in old homes (incl. worst-case applying-crash citer files parked
under .akm/mv-transactions/<id>/owned-N) are NOT migrated — Chunk 8's
cutover should consider a one-shot legacy-journal sweep (recorded for its
brief). Minor accepted drifts: version-mismatch/corrupt-journal error
text now engine-worded; journal-less dirs younger than the 5-minute grace
are retained; mv cleanup warning moved warnVerbose→warn with the engine
prefix. Nothing pins the old strings.

Gates: tsc clean; full lint green; evidence 95/0 across 12 suites
(mv+proposal oracles, both durable-recovery crash suites, engine unit,
ratchets 28/28).

## WI-6.3e — consolidate checklist journal subsumed; ALL FOUR legacy homes gone (landed with this entry)

The consolidate journal (the 4th, simpler engine) rides the unified
engine: kind `consolidate`, root = the stash, backups under the
transaction directory. The in-stash `.akm/consolidate-journal.json` +
`.akm/consolidate-backup/<ts>/` homes are GONE — with the proposal,
reject, and mv homes already collapsed, the WI-6.3 gate "journal dirs
removed, replaced by the one transaction's home" is fully met. Semantics
preserved: the checklist journal is written durably before any mutation;
per-op completion marks stay best-effort (now durable same-phase payload
rewrites); recovery stays a RUN-ENTRY decision (--consolidate-recovery
abort|clean) with the same ConfigError guidance; the op handlers take the
txn through ConsolidateOpContext. The registered kind can never be
auto-rolled-back (commitPhase = first phase; generic recovery aborts
loudly with the clean guidance).

Ledgered behavior deltas (documented in the re-captured fixture notes):
(1) completed>=operations leftovers are swept whole at the run-entry
check — the legacy characterization surprise (a completed journal's
orphaned backup dir leaking forever) is FIXED by the per-transaction-dir
scheme; (2) the two backup-timestamp derivations died with the
timestamped backup dirs; (3) journal write count 2→3 (begin/mark/commit).

The three re-baseline-@6 consolidate goldens were re-captured with this
port (reviewed diff in this commit; registry designation finalization
rides WI-6.5 with the remaining assets): journal-lifecycle.json (engine
envelope phases + namespace-clean end state), journal-recovery.json
(cases collapsed/renamed; leak-fix documented), journal-guard-verdicts
(capturedAtHead only — the predicted near-no-op). Suite harness re-keyed
to the engine home; stale header/anchors rewritten.

Adversarial review found 2 blockers, both fixed here: (1) an UNREADABLE
journal in the shared stash namespace cannot be attributed to a kind —
consolidate's unreadable-branch no longer sweeps ("clean") or
misattributes ("abort") what may be a sibling mv/proposal journal fencing
an irreversible mutation; it warns-and-skips on clean and aborts with
kind-agnostic guidance otherwise; (2) two un-ported integration tests in
improve-memory.test.ts that plant stale journals were re-keyed to the
engine home. Also fixed: the handler-test txn stubs are truly inert
(unregistered kind — no stray .tmp in CWD); clean-mode removal failures
are reported as failures again. Accepted (RC-only exposure, consistent
with 6.3b/d): legacy in-stash consolidate journals from rc builds are
not bridged — not shipped in any stable release (verified v0.8.9);
docs/technical references to the legacy homes fall to Chunk 10's sweep;
a corrupt consolidate journal now fails mv-filtered recovery loudly
(kind-agnostic fail-closed; disjoint at HEAD).

Gates: tsc clean; full lint green; consolidate+improve-memory 283/0;
ratchets+engine+frozen oracles+mv recovery 68/0.

## WI-6.4 — dedup/cooldown → §23.6 input fingerprints (+model-id term), backoff retained, migration 019

The F-2 dedup/cooldown guard (duplicate_pending, content_hash_match,
cooldown) is replaced by the §23.6 input fingerprint: sha256 over
NUL-joined [v1, source, ref, target-before-hash, evidence (reserved),
guidance (reserved), evaluator (reserved), model-id] — the plan §4.5
engine/model-id term included from day one; evidence/guidance/evaluator
slots reserved empty until Wave-2 recipes exist. Deliberately an INPUT
fingerprint (generated content is NOT a term): already-processed inputs
skip re-processing regardless of what the model produced. New skip
reasons: fingerprint_match, rejection_backoff. Rejection backoff is
RETAINED byte-equivalent-modulo-renames (review-verified mechanical
diff): same rejected lookup/sort/window math, 14 d reflect / 30 d
distill / 7 d default. Fingerprints are recorded via INSERT OR REPLACE
after upsertProposal inside the same BEGIN IMMEDIATE transaction —
including on force (a forced enqueue still processed those inputs) —
and pruned best-effort alongside proposal expiry (created_at + retention
cutoff). Migration 019-proposal-fingerprints appended (001–018 byte
untouched); DDL characterization snapshot re-recorded additively.
Model-id operands threaded at every automated mint: schema-repair,
extract (guarded once per run), reflect (engine name), consolidate +
promote-memory (resolved connection), distill (RESOLVED distillLlm —
review fix; the raw option under-reported for standalone runs). Human
sources pass none.

Ledgered behavior deltas: (1) duplicate_pending retired — different-
inputs proposals for the same ref+source now QUEUE ALONGSIDE a pending
one (the fingerprint dedups identical inputs only); (2) post-rejection
same-inputs suppression is permanent until target/model/scheme changes
or the 90 d prune fires (HEAD's content_hash_match rejected-row window
was 30 d); (3) post-REVERT same-inputs re-mints are likewise suppressed
(HEAD allowed immediate re-mint after revert) — the fingerprint row
survives the proposal lifecycle by design; (4) accept-to-foreign-root
staleness: the fingerprint's before-hash is minted from the LOCAL stash
snapshot, so accepting to a --target/defaultWriteTarget root never
rotates it — bounded by the retention prune under default config,
UNBOUNDED when archiveRetentionDays<=0 disables expiry (escapes: force,
model change, scheme bump). PLAN CALLOUT for Wave-2 recipes: fingerprint
rotation on accept, or prune independent of the retention switch;
(5) cold-start amnesty: migration 019 ships an empty table and legacy
import records no fingerprints (before-hash/model-id are unrecoverable
retroactively, and sha256 is unavailable to SQL migrations), so
pre-upgrade pending proposals lose dedup protection for exactly one
mint cycle — one duplicate per ref+source+model, one-time; rejected
rows stay covered by the backoff.

Adversarial review: 0 blockers, 3 concerns, 5 notes. Concerns ledgered
above as deltas (4), (5) and fixed as the distill operand. Note fixes
landed here: reflect's structured skip-signal allow-list gained the new
vocabulary (legacy tokens kept for old agent payloads); the fingerprint
row now stores the NORMALIZED ref (the value the fingerprint is computed
over) so future ref-keyed readers never mismatch; createProposal JSDoc
and a dangling F-2 comment rewritten to the new guard. Deferred to
WI-6.5 per the registry note: proposal-skip-shapes.json designation flip
back to frozen + fresh sha256 (asset re-captured here with 6 scenarios:
fingerprintMatchSameInputs, fingerprintMatchVsRejected,
newInputsAfterTargetChange, modelIdTerm, rejectionBackoff, forceBypass).
Health metrics: classifyDistillSkipReason extracted (fn-size ratchet);
fingerprint/backoff patterns classified before the legacy
cooldown/content-hash ones.

Gates: tsc clean; full lint green (frozen proposal-txn.json byte-green,
serialize pinned to its capture sha); frozen oracles 22/0; improve +
proposal domain + storage 268/0; ratchets 28/28; DDL characterization
52/0.

## WI-6.5 — re-baseline-@6 goldens re-captured; all six designations finalized frozen

The two crash-recovery goldens were re-captured on the unified engine:
journal/proposal-recovery.json and journal/move-recovery.json. Phase
vocabulary and EVERY recovery outcome came through the engine swap
unchanged — the re-capture diffs touch only capturedAtHead (now
90640d41), the serialized notes strings, and serializer whitespace on
single-element arrays; every boolean/status/count is byte-identical to
the pre-swap capture. The suites' notes were rewritten to the engine
reality: stale mv-cli/repository line references repointed
(applying-hold mv-cli.ts:598, finalizeMoveTransaction :991,
recoverProposalTransactions repository.ts:1430, reject-ordering
proposal.ts:175), and the mv fixture's dual journal-home story
(in-stash .akm/mv-transactions vs getDataDir() proposal journals)
replaced: every kind's journal now lives in the engine's per-root
namespace, and the four recovery entry points (mv pre-flight
mv-cli.ts:486, proposal promotion repository.ts:1791, full indexer
indexer.ts:560, targeted write-path indexer
index-written-assets.ts:74) are pinned as still firing mv recovery via
recoverTxnsForRoot(kind === 'mv') after the collapse.

All SIX re-baseline-@6 registry entries flipped back to
frozen-migration-input with fresh sha256 pins and reBaselineChunk
dropped, honoring each entry's same-chunk promise:
journal/proposal-skip-shapes.json (re-captured at WI-6.4 — the §23.6
guard's contract), journal/proposal-recovery.json and
journal/move-recovery.json (re-captured here), and the three
consolidate journal goldens re-captured at WI-6.3e
(journal-lifecycle.json, journal-recovery.json — whose note now pins
the orphaned-backup leak FIX rather than the legacy characterization
warning — and journal-guard-verdicts.json, the predicted near-no-op).
Registry notes rewritten to describe the captured NEW surfaces; the
Chunk-5 §15.2 fixture-local-ref caveats retained where the fixture
still embeds ref-shaped strings. Frozen inventory 41 → 47 assets,
hash-verified on every lint run. No re-baseline-@6 entries remain
(the three @5 CLI-output entries are Chunk 5's, untouched).

Gates: tsc clean; full lint green (47 frozen hash-verified);
goldens-designations 7/7; the four consumer suites of the flipped
assets plus goldens-mv-txn 57/0 re-run WITHOUT the update flag
(byte-match proof); frozen oracles proposal-txn + move-txn stay green
within that run.

## WI-6.7 — §15.7 fault-injection suite; chunk gates; CHUNK 6 CLOSED

New suite tests/core/fs-txn-faults.test.ts (6 tests): a synthetic kind
implements the SAME multi-file batch discipline the domain kinds use
(journal first → stage after-content inside the transaction dir →
per-file before-hash verification → displace-to-backup → durable write
→ commit phase → finalize) and proves the plan's Chunk-6 gate
"one-transaction fault tests green": (1) a fault injected at EVERY
index of a 3-file FileChange[] batch (2 updates + 1 create), before
the commit phase, leaves NO partial write once recovery runs — the
mid-flight partial state is asserted first (the fault genuinely fired),
then recovery restores every update byte-identical and removes the
create; (2) a fault after the commit phase rolls the WHOLE batch
forward — one applied target is destroyed before recovery runs, so
finalize's re-materialization from the staged content is OBSERVED, not
inferred; (3) a before-hash divergence mid-batch (concurrent editor
between journal mint and the displace window) aborts the whole batch —
files applied earlier are rolled back, the diverged file keeps the
editor's bytes, the create never lands; (4) a fresh batch on the same
root succeeds after a rolled-back fault; every path ends with the
engine namespace clean. Injection rides _setTxnMutationHookForTests;
known aborts roll back in-process like the domain kinds' abort windows
while injected faults leave the journal on disk exactly as a SIGKILL
would. Domain-kind crash semantics stay pinned separately by the
subprocess SIGKILL suites (proposal-durable-recovery,
mv-durable-recovery — re-keyed to the engine at WI-6.3; 27/0 at close)
and the frozen outcome oracles.

Chunk gates (manifest chunk 6):
(1) "Journal dirs removed" — met at WI-6.3e (all four legacy homes
gone, one engine home). (2) "One-transaction fault tests green —
mid-apply fault leaves no partial write, before-hash abort (§12.3)" —
met here, 6/0. (3) Frozen outcome oracles journal/proposal-txn.json +
journal/move-txn.json stayed byte-green through the entire collapse
(re-verified at every transaction work item); the journal-engine-shape
goldens designated re-baseline @6 were re-captured with reviewed diffs
+ ledger entries (WI-6.3e, WI-6.4, WI-6.5) and every designation
finalized back to frozen-migration-input with fresh sha256 pins
(WI-6.5; frozen inventory 41 → 47).

Chunk-end full `bun run check` ONCE: exit 0 — biome + all seven lint
scripts (47 frozen goldens hash-verified) + tsc + the unit stage + the
integration stage all green; the integration stage alone reported
4454 pass / 55 skip / 0 fail across its 334 files.

Net-LOC REPORT (§12.1 — reported, never a gate): src net +210
(+1810/−1600 across 38 files) vs the plan's ~−800 projection. Drivers:
(a) the unified engine is NEW shared code (fs-txn.ts +411,
file-change.ts +59) and the four legacy engines it replaced were
substantially rewritten in place rather than net-deleted — the kind
handlers keep full rollback/roll-forward/recovery semantics
(repository.ts +562/−470, mv-cli.ts +181/−190, consolidate.ts
+144/−132); (b) WI-6.4 fingerprints are new machinery (+ migration 019
+28) while the dedup/cooldown they replaced was similar-sized and
rejection backoff was RETAINED by plan §4.5; (c) the confidence-gate
deletion was scoped down by the 2026-07-16 maintainer decision
(drain-owned audit machinery retained — preparation.ts −81,
loop-stages.ts −38 instead of the projected wholesale delete);
(d) WI-6.6a moved 51 formatter lines out of repository.ts (net ~0).
Tests net ≈ +509 (incl. this fault suite and the restored DDL
characterization suite); docs ≈ +880 (brief, amendments, this ledger
including this closing entry).

CHUNK 6 CLOSED. Next in manifest order: Chunk 9 (Wave-1 cross-cutting
sweep), then Wave 2 (0b → 1 → 1.5 → 2 → 3 → 4 → 5 → 6.5 → 8 → 10).
Standing note for Chunk 8's brief (recorded at WI-6.3d): consider a
one-shot legacy-journal-home sweep at cutover for RC-only journals.
