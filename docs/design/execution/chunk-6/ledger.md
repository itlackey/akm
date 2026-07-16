# Chunk 6 — deletion/behavior ledger

Opened at HEAD `b393317f` (W1-a residuals closed, full check green
4481/0/55). Work items land per brief order; this ledger records each
item's deletions, behavior changes, gate evidence, and net LOC as it
lands. Status: IN PROGRESS.

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
