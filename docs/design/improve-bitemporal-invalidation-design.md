# R7 — Bi-Temporal Contradiction Invalidation for `akm improve`

> **Status:** Design, ready to implement (2026-07-02). Implements R7 / closes G8 from
> [improve-self-learning-analysis.md](improve-self-learning-analysis.md) §4-G8/§5-R7.
> **Deliberately deferred off `feat/improve-self-learning-wiring`** — this is a real design
> change to consolidate/extract/memory-cleanup contradiction handling, out of scope for the
> current wiring pass; this document is the implementation spec for a follow-up branch.
> Format and rigor follow the R5 spec
> ([improve-collapse-churn-detector-design.md](improve-collapse-churn-detector-design.md)).
>
> **The pattern being adopted** is Zep/Graphiti's *invalidate-and-keep-history*
> (Rasmussen 2025, arXiv:2501.13956): a contradicted fact gets its `t_invalid` timestamp
> set rather than being deleted or merged away, so (a) "what did we believe as of time X"
> stays answerable, and (b) a retracted fact cannot silently reappear when an old session
> transcript is re-extracted.
>
> **Hard constraints honored throughout:** invalidation (retire *disagreeing* facts,
> retained + timestamped) and dedup/merge (combine *agreeing* facts) are **distinct
> operations under distinct thresholds** — never conflated; resolution is deterministic
> wherever a deterministic rule suffices (LLM only for *detection*, which already exists);
> contradiction detection is never weakened and distillation stays additive/non-lossy
> (analysis §7); every new mechanism is fail-open (an invalidation error warns and skips,
> never breaks an improve run); storage footprint is bounded by construction.

---

## 1. Current lifecycle, verified against code (and the bug this fixes)

### 1.1 The three contradiction writers

1. **Automated LLM detect pass** — `detectAndWriteContradictions`
   (`src/commands/improve/memory/memory-contradiction-detect.ts:194`). Scope: *derived
   memories only*, grouped by `parentRef` family (:209-237); pairwise LLM judge capped at
   `MAX_FAMILY_SIZE = 8` (:54) and `MAX_PAIRS_PER_RUN = 20` (:60); confidence gate
   `CONTRADICT_CONFIDENCE_THRESHOLD = 0.92` (:68, :306-311). On a confirmed pair it writes
   **mutual** edges — `contradictedBy` + `beliefState: contradicted` on **both** members
   (:314-318 via `writeContradictedByEdge` :164-180). Runs inside `akmImprove` at
   `src/commands/improve/improve.ts:559-572`, deliberately *before* `analyzeMemoryCleanup`
   (:574-576).
2. **Consolidate LLM plan `contradict` op** — `src/commands/improve/consolidate.ts:2310-2356`
   (`ConsolidateOpKind` includes `"contradict"`, :253; op schema :410-415). Same 0.92
   confidence gate (:2319). Writes a **single directed** edge: only `op.ref` gets
   `contradictedBy: [op.contradictedByRef]` (:2349, via the shared `writeContradictEdge`,
   `src/commands/improve/memory/memory-belief.ts:61-76`).
3. **Manual frontmatter annotation** — any `contradictedBy:` list a human writes.

### 1.2 The resolver — and the mutual-2-cycle cancellation bug (verified)

`resolveFamilyContradictions` (`src/commands/improve/memory/memory-improve.ts:392-545`)
builds a directed graph from `contradictedBy` edges, runs Tarjan SCC (:547-598), and
declares **sink components** (no outgoing edges) the "current belief" (:452-455, :483).
Non-sink members transition to `contradicted` pointing at the reachable sink refs
(:486-511). Sink members get a `belief-refresh` transition back to `active`/`asserted`
(:513-538). `persistBeliefStateTransition` (:647-668) then **deletes the `contradictedBy`
frontmatter entirely whenever `toState !== "contradicted"`** (:656-663).

Consequence for a mutual pair A↔B — which is what the automated detect pass *always*
writes (:316-317): A and B form **one** SCC with no outgoing edges → it is a sink → both
members are "current" → both are refreshed to `active` and **both contradiction edges are
erased**, in the *same improve run* that detected them (detect at `improve.ts:565`, plan at
`:575`, apply at `src/commands/improve/preparation.ts:880-906`). Worse, it oscillates: the
detect pass skips a pair only when edges exist in both directions
(`memory-contradiction-detect.ts:271`) — since the resolver erased them, the same pair is
re-judged and re-written **every subsequent run**, burning `MAX_PAIRS_PER_RUN` LLM budget
forever while resolving nothing. The elegant SCC machinery only ever "resolves" the
single-direction edges from consolidate's `contradict` op — and even then, "resolution"
means a rank penalty with no timestamps, no winner record, and no re-assertion protection.

### 1.3 What else exists today (build on, don't duplicate)

- **Belief states** (`memory-improve.ts:13`):
  `active | asserted | deprecated | superseded | contradicted | archived`. `deprecated` is
  the only frozen (never-refreshed) state (:798-800). `resolveBeliefState` (:802-814)
  parses frontmatter, defaulting unknown/absent to `active`.
- **Ranking** (`src/indexer/search/ranking-contributors.ts:107-120`): `contradicted` −0.45,
  `superseded` −0.25, `archived` −0.6, `deprecated` −0.15, `asserted` +0.08, `active`
  +0.06 — memories only, composed at :160.
- **Retrieval filter** (`src/indexer/search/db-search.ts:531-546`): `current` = absent |
  `active` | `asserted`; `historical` = `contradicted | superseded | deprecated | archived`.
  Indexer carries `beliefState` on entries (`src/indexer/passes/metadata.ts:116`, parsed
  :468-469).
- **Dedup/merge machinery** (the *agreeing-facts* path): fingerprint-identical duplicates
  pruned (`memory-improve.ts:209-219`, `buildFingerprint` :860-874 over normalized
  title/description/tags/hints/body); consolidate's LLM `merge` op
  (`consolidate.ts:1787-2010`) with hot-frontmatter and anti-collapse generation guards
  (:1930-2000) — but **no guard against merging a pair that carries contradiction edges**
  (verified: the merge branch never reads `contradictedBy`). This is the exact
  dedup/invalidation conflation risk the analysis names.
- **Contradiction candidates are already excluded from duplicate detection and
  consolidation candidates** in the cleanup engine (`memory-improve.ts:204-227`) — the
  right instinct, present only in one of the two merge engines.
- **mem0-style D-1 conflict resolution in distill's knowledge path**
  (`src/commands/improve/distill.ts:1081-1180`): when a knowledge destination already
  exists, an LLM chooses ADD/UPDATE/NOOP over `existingKnowledgeContent` (:1085,
  :1124-1160). Good shape for *destination-content* conflicts; **not reused** for
  invalidation because invalidation must be deterministic, retained, and timestamped —
  an LLM rewrite is precisely what invalidate-and-keep-history exists to avoid.
- **Extract's re-processing guard** (`src/commands/improve/extract.ts:422-432`
  `hashSessionContent`; :498-499 `shouldSkipAlreadyExtractedSession`; :1161
  `upsertExtractedSession`): keyed on *session content*, so it prevents re-processing an
  unchanged transcript — it does **nothing** to stop a `--force` re-extract (or a
  transcript whose bytes changed) from re-asserting a retracted fact.
- **Proposal guard chokepoint** (`checkDedupAndCooldown`,
  `src/commands/proposal/validators/proposals.ts:753-823`, invoked from `createProposal`
  :707-710, skipped when `input.force` :707): checks pending duplicates, content-hash
  matches, and post-rejection cooldowns — it consults *proposals*, never *invalidated
  assets*. Every automated lane (extract :701, distill, consolidate :2290, recombine)
  flows through `createProposal`, making this the single hook that can block
  re-assertion for all of them.
- **Timestamps already on assets**: `createdAt` frontmatter (read at
  `memory-improve.ts:317`), `observed_at` written by remember's heuristics
  (`src/commands/remember.ts:161`, `detectObservedAt` :173-198). These are the `t_valid`
  raw material — no new "when was this true" field is invented.
- **Audit precedents**: belief-transition JSONL log (`appendBeliefStateTransitionLog`,
  `memory-improve.ts:671-693` → `.akm/memory-cleanup/belief-transitions.jsonl`);
  state.db-canonical + frontmatter-mirror convention for salience
  (`src/core/asset/frontmatter.ts:195-204`: "state.db :: asset_salience is the canonical
  store").

---

## 2. Operational definitions

- **Contradiction** — two assets whose factual claims are logically exclusive, as
  determined by the *existing* detection machinery (LLM judge ≥ 0.92, or a human edge).
  Detection is unchanged by this design.
- **Dedup/merge** — combining assets that *agree* (fingerprint-identical, or
  LLM-judged same-content). Routing rule (§4): a pair with any contradiction edge between
  them is **never** merge-eligible.
- **Invalidation** — the terminal resolution of a contradiction: the losing assertion is
  retained in place, its `beliefState` set to `invalidated`, its `t_invalid` recorded in
  the registry (§6), and its content fingerprint armed against re-assertion.
- **`t_valid`** — when the assertion became true/observed in the world:
  `observed_at ?? createdAt ?? file mtime` of the asset (existing fields; never a new one).
- **`t_invalid`** — when AKM stopped believing it (the moment of resolution). Stored in
  the registry and mirrored to frontmatter as `invalidatedAt`.
- **Re-assertion** — a new proposal whose ref matches, or whose normalized-content
  fingerprint matches, an un-reinstated invalidation registry row.
- **Reinstatement** — the deliberate escape hatch: a human declares the belief changed
  back; the registry row is stamped `reasserted_at` and stops blocking.

---

## 3. Bi-temporal data model

### 3.1 Where it lives — state.db canonical, frontmatter mirror

Follows the salience precedent exactly (`frontmatter.ts:195-204`): the **registry table
`asset_invalidations` in `state.db` is canonical** (queryable for as-of and re-assertion
blocking; survives file rewrites), and the loser's **frontmatter carries a human/git
auditable mirror** that also feeds the indexer/ranking. Rejected alternative: frontmatter
only — the re-assertion block must survive the asset file being edited, moved, or even
deleted, and must be joinable by content fingerprint; a file walk per `createProposal` is
the wrong cost shape. Rejected alternative: state.db only — belief state must be visible
to the indexer, `git log`, and humans reading the file, exactly like every other belief
state today.

### 3.2 Frontmatter fields (mirror, on the losing asset)

```yaml
beliefState: invalidated        # new terminal state, see §3.3
invalidatedAt: 2026-07-02T18:04:11Z   # = t_invalid
invalidatedBy: memory:auth/token-rotation.derived   # winner ref
invalidationReason: auto-recency       # 'auto-recency' | 'human' | 'consolidate-op'
contradictedBy: [...]           # RETAINED as history (no longer erased)
```

`t_valid` is *not* duplicated into a new field — it is derived from the existing
`observed_at`/`createdAt` and denormalized into the registry row at resolution time.

### 3.3 `invalidated` is a NEW belief state, not a refinement of an existing one

| State | Meaning today | Why it can't absorb invalidation |
|---|---|---|
| `contradicted` | *Detected, unresolved* conflict flag | It is mutable by design — the resolver refreshes/rewrites it every cleanup pass; invalidation must be frozen and timestamped |
| `superseded` | Replaced by a better version of the *same agreeing* content (dedup family; prune path `memory-improve.ts:180-184`) | Conflating it would re-merge the two operations the analysis says to keep distinct |
| `deprecated` | Frozen historical, human-initiated | No winner pointer, no timestamps, no re-assertion semantics |
| `archived` | File physically moved to the cleanup archive (`memory-improve.ts:600-645`) | Invalidated assets stay **in place**, retrievable under `--belief historical` |

Type changes: add `"invalidated"` to `MemoryBeliefState` (`memory-improve.ts:13`), to
`resolveBeliefState`'s accepted set (:802-814), to `isFrozenHistoricalBeliefState`
(:798-800 — invalidated is frozen: the belief-refresh pass must never resurrect it), to
the indexer union (`metadata.ts:116`), and to the `historical` branch of
`matchBeliefFilter` (`db-search.ts:540-545`).

---

## 4. Invalidation vs. dedup — the routing decision procedure

Deterministic, ordered; the LLM appears only where it already exists (detection).

1. **Edge check first (deterministic, both merge engines).** If any pair among a merge's
   participants has a `contradictedBy` edge in either direction → the merge is refused.
   - Cleanup engine: already excludes contradiction candidates
     (`memory-improve.ts:204-227`) — unchanged.
   - Consolidate LLM-plan merge branch: **new guard** before the anti-collapse block
     (~`consolidate.ts:1940`): read participants' `contradictedBy` frontmatter; on a hit,
     `warnings.push(...)` + `pushSkipReason("merge", op.primary,
     "merge_contradicted_participants")` + `continue` — mirroring the
     `merge_generation_guard` refusal shape (:1966). This closes the conflation hole in
     §1.3 regardless of what the LLM plan proposes.
2. **Agreeing content → dedup path (unchanged).** Fingerprint-identical → prune with
   survivor (`duplicate-derived`); LLM-judged same-content → `merge` op. Thresholds
   untouched.
3. **Disagreeing content → resolution procedure (new, §5).** Input: every contradiction
   pair/SCC the resolver sees. The old behavior (mutual sink → refresh both to active +
   erase edges) is **deleted**, not tuned.

Distinct thresholds, made explicit: detection keeps its 0.92 confidence gate;
**resolution adds its own deterministic gate** — `minRecencyMarginDays` (§5.1) — and merge
keeps its existing judged-similarity thresholds. No shared knob.

---

## 5. Resolution procedure and API

### 5.1 Deterministic winner selection (`selectContradictionWinner`, pure function)

For a contradicting pair (or each non-winner member of a mutual SCC), compare:

1. **Authority:** `asserted` (user-explicit, via `akm remember`) beats non-`asserted`.
   An `asserted` record is **never auto-invalidated** by a non-asserted winner; if the
   *loser by recency* would be `asserted`, the pair is deferred to human resolution.
2. **Temporal precedence (the Zep rule):** newer `t_valid` wins — the later observation
   invalidates the earlier overlapping one — **iff** the margin is at least
   `minRecencyMarginDays` (default **1 day**; below that, transcript-ordering noise
   dominates and the pair defers to human).
3. **Tie / both `asserted` / sub-margin:** no auto-resolution. Both members stay
   `contradicted` (frontmatter edges now *retained*, §5.3), one
   `contradiction_unresolved` event is appended (deduped per pair per run), and the pair
   surfaces in the `akm health` improve advisory until a human resolves it (§5.2).

Rejected alternative: an LLM resolution judge — timestamps decide the overwhelming
majority of real cases (Zep's own load-bearing rule is temporal), a wrong deterministic
answer is inspectable and reversible (reinstate), and the repo's bias is
no-LLM-where-deterministic-works. Rejected alternative: salience/rank-score as the
tiebreak — popularity is not truth, and it would let the outcome loop silently editorialize
belief.

### 5.2 CLI surface (human path)

Three small subcommands on the existing improve CLI (`src/commands/improve/improve-cli.ts`),
following the R5 `akm improve canary` placement precedent:

```
akm improve invalidations [--json]        # list registry rows (+ unresolved pairs)
akm improve resolve <loserRef> --by <winnerRef> [--reason <text>]
akm improve reinstate <ref> [--reason <text>]      # the escape hatch, §7.3
```

`resolve` runs the same `applyInvalidation` primitive the automated path uses (§5.3) —
one code path, two triggers. Rejected alternative: a new top-level `akm memory` command
group — larger surface for the same three verbs; can be revisited if a memory group
materializes for other reasons (open question 1). Rejected alternative: routing
resolution through the proposal queue — proposals carry content payloads and a
promote-to-file lifecycle; resolution is a metadata state transition, and wedging it into
proposals would add a fake payload and misuse `promoteProposal`.

### 5.3 `applyInvalidation` mechanics (shared primitive, `memory-belief.ts`)

For loser L, winner W, at time `t_invalid = now`:

1. **L's frontmatter:** `beliefState: invalidated`, `invalidatedAt`, `invalidatedBy: W`,
   `invalidationReason`; `contradictedBy` **retained**. File stays in place (never moved
   to the archive — it must remain retrievable under `--belief historical`).
2. **W's frontmatter:** remove L from `contradictedBy` (if present); belief-refresh to
   `active`/`asserted` as today. W is the only party the refresh path may still clean.
3. **Registry:** insert one `asset_invalidations` row (§6) with L's ref, W's ref,
   `content_fingerprint` = FNV-1a-64 of L's `normalizeBody` output (reusing
   `memory-improve.ts:876-883` — the same normalization the dedup fingerprint uses, so
   the two systems agree on what "same content" means), `t_valid`, `t_invalid`, resolver
   provenance, and the improve `run_id` when automated.
4. **Audit:** one belief-transition JSONL record with new reason `"invalidated"`
   (extend the `MemoryBeliefStateTransition["reason"]` union, `memory-improve.ts:43`) via
   the existing `appendBeliefStateTransitionLog` (:671-693).

### 5.4 `contradictedBy` edge lifecycle + the 2-cycle fix

`persistBeliefStateTransition` (`memory-improve.ts:647-668`) currently deletes
`contradictedBy` on any transition to a non-`contradicted` state — **change: edges are
deleted only on the winner side of a resolution and on reinstatement**; a plain
belief-refresh no longer erases history it didn't create.

In `resolveFamilyContradictions`: a **sink SCC with ≥ 2 members is an unresolved mutual
contradiction, not a current belief**. Replace the refresh-to-active branch
(:513-538, for multi-member sinks only) with a call into §5.1: auto-resolvable → loser(s)
invalidated, winner refreshed; not auto-resolvable → all members *stay* `contradicted` and
the unresolved event fires. Single-member sinks keep today's refresh behavior byte-for-byte.
Because edges are no longer erased, the detect pass's both-directions skip
(`memory-contradiction-detect.ts:271`) becomes effective again — the oscillating re-judge
loop (§1.2) ends as a side effect, *reducing* steady-state LLM spend. The detect pass also
gains one filter: pairs where either member is `invalidated` are skipped (frozen state,
nothing to detect).

Detection itself (mutual-edge writes, 0.92 gate, family scoping) is deliberately
unchanged — writing a *directed* edge at detect time was rejected because it would smuggle
resolution into detection, exactly the conflation this design separates.

---

## 6. Storage schema + migration

Migration id `017-asset-invalidations` appended to `MIGRATIONS` in
`src/core/state/migrations.ts` (current tail is `015-asset-salience-encoding-source`
:716; **016 is reserved by the R5 collapse-detector spec** — whichever branch lands second
renumbers, both specs note this).

```sql
-- ── Migration 017 — bi-temporal contradiction invalidation (R7) ──────────────
CREATE TABLE IF NOT EXISTS asset_invalidations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ref                 TEXT    NOT NULL,   -- losing asset, e.g. 'memory:auth/foo.derived'
  winner_ref          TEXT,               -- NULL for human resolutions without a winner
  content_fingerprint TEXT    NOT NULL,   -- FNV-1a-64 hex of normalizeBody(loser body)
  t_valid             TEXT,               -- observed_at ?? createdAt ?? mtime (ISO-8601)
  t_invalid           TEXT    NOT NULL,   -- resolution time (ISO-8601)
  reason              TEXT    NOT NULL,   -- 'auto-recency' | 'human' | 'consolidate-op'
  resolved_by         TEXT    NOT NULL,   -- 'auto' | 'human'
  run_id              TEXT,               -- improve_runs.id when automated
  reasserted_at       TEXT,               -- NULL while blocking; set by reinstate
  reassert_reason     TEXT,
  created_at          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_invalidations_ref
  ON asset_invalidations(ref);
CREATE INDEX IF NOT EXISTS idx_asset_invalidations_fp
  ON asset_invalidations(content_fingerprint);
```

CRUD in `src/core/state-db.ts` (same style as the recombine-hypotheses helpers
:1415-1675): `insertAssetInvalidation`, `findBlockingInvalidation(db, ref, fingerprint)`
(one indexed query, `reasserted_at IS NULL`), `markInvalidationReasserted`,
`listAssetInvalidations`.

**Footprint & retention.** Rows are scalars + two refs — < 400 bytes each. Volume is
bounded by detection itself: ≤ `MAX_PAIRS_PER_RUN = 20` pairs judged per run, 0.92
confidence gate, and live data shows real (non-gated) rejections at ~2/run — realistic
accumulation is tens of rows per month. **Invalidated content is retained by design**;
what IS purgeable: nothing in v1; a later retention pass may prune rows with
`reasserted_at` older than 365 d (they no longer block anything and their history lives
in the JSONL transition log). The loser's *file* is likewise retained; if an operator
later archives it through normal cleanup, the registry row keeps the block alive — that
is the point.

---

## 7. Re-assertion blocking

### 7.1 The hook: `checkDedupAndCooldown` (one chokepoint, all lanes)

Add a fourth guard, evaluated **first**, in `checkDedupAndCooldown`
(`proposals.ts:753-823`): compute `fp = fnv64(normalizeBody(input.payload.content))`, then
`findBlockingInvalidation(db, normalizedRef, fp)`. On a hit, return a skip with new
`ProposalSkipReason` `"invalidated_predecessor"` (union at :427; documented in the
`createProposal` doc block :620-632), message naming the registry row, winner ref, and
`t_invalid`, plus the reinstate command.

Why this hook and not a per-lane filter: `createProposal` is the single funnel every
automated lane already passes through (extract `extract.ts:701`, consolidate promote
`consolidate.ts:2290`, distill, recombine, reflect) — one guard covers all of them, and
the fingerprint check catches the re-extraction case where the *ref* differs (extract
derives candidate names freshly per session, so a resurrected fact usually arrives under
a new ref with the same normalized content). Rejected alternative: filtering candidates
inside extract before `createProposal` — it would protect one lane of five and duplicate
the guard's plumbing.

**Interaction with the extract session ledger:** unchanged. The content-hash ledger
(`extract.ts:498-499`) keeps *unchanged* sessions from re-processing at all — cheap first
line. The proposal guard is the backstop for `--force` re-extraction and byte-changed
transcripts, which the ledger deliberately lets through.

### 7.2 Observe-first: `blockReassertion` defaults OFF in v1

While `improve.invalidation.blockReassertion` is `false` (v1 default, §9), the guard runs
in shadow mode: on a would-block hit it appends a `reassertion_would_block` event
(ref, proposal source, matched registry row) and lets the proposal through. This measures
the fingerprint's false-positive rate on live data before any proposal is ever suppressed
(same annotate-before-enforce discipline as R5's merge floor).

### 7.3 The deliberate re-assertion escape hatch

Belief genuinely changed back? Two sanctioned paths:

1. **`akm improve reinstate <ref>`** — stamps `reasserted_at` (+ optional reason) on the
   registry row(s), flips the asset's `beliefState` back to `active` (or `asserted` when
   invoked with `--asserted`), and logs a `"reinstated"` belief transition. Blocking for
   that ref/fingerprint ends.
2. **`createProposal` with `force: true`** — already bypasses all guards (:707); human-
   initiated flows keep working unmodified. Automated lanes never pass `force`, so the
   hatch cannot be exercised by the cron. A forced proposal does **not** clear the
   registry row — accepting it is expected to be followed by `reinstate` (the CLI accept
   path prints a hint when the ref matches a blocking row).

---

## 8. "As-of" queryability

**Decision: a documented SQL runbook query plus the existing JSONL transition log — no new
query engine, no `--as-of` search flag.** Rejected alternative: `akm search --as-of <ts>`
— it implies reconstructing historical *rank* and historical *content*, which AKM does not
version (git does); a half-true flag is worse than an honest query. Rejected alternative:
snapshotting believed-sets per run — unbounded storage for a question asked rarely.

Runbook addition (analysis §6, read-only against `state.db` + the stash):

```sql
-- Facts believed at :asOf but invalidated since (the delta history):
SELECT ref, winner_ref, t_valid, t_invalid, reason
FROM asset_invalidations
WHERE t_invalid > :asOf AND (t_valid IS NULL OR t_valid <= :asOf)
  AND (reasserted_at IS NULL OR reasserted_at > :asOf);
```

"What we believed as of X" = currently-`current` assets with `t_valid ≤ X` **plus** the
rows above. Per-ref lineage: `grep <ref> .akm/memory-cleanup/belief-transitions.jsonl`
(every transition, including `invalidated`/`reinstated`, is already appended there —
§5.3). `akm improve invalidations --json` (§5.2) is the scripting surface.

---

## 9. Ranking, retrieval, and improve-lane integration

- **Ranking:** add `invalidated` → **−0.55** to `beliefStateBoost`
  (`ranking-contributors.ts:107-120`) — between `contradicted` (−0.45, still-live dispute)
  and `archived` (−0.6, physically removed): a resolved-false fact should rank below a
  disputed one but remain findable. Reuses the existing contributor; no new mechanism.
- **Retrieval filter:** `invalidated` joins the `historical` branch
  (`db-search.ts:540-545`); the `current` branch (:534-538) is untouched, so invalidated
  assets vanish from default results and stay reachable via `--belief historical`/`all`.
- **Improve eligibility:** invalidated assets are frozen — excluded from the consolidate
  memory pool (the same eligibility filter that excludes session-capture memories,
  `src/commands/improve/consolidate/eligibility.ts`), from recombine cluster membership
  (filter at pool assembly before `buildRelatednessClusters`,
  `src/commands/improve/recombine.ts:302-439`), from distill inputs, and from the
  high-salience lane (`preparation.ts:1315-1383`). One shared predicate
  (`isFrozenBeliefState`, exported from `memory-improve.ts`) so the five call sites can't
  drift. They remain visible to the salience sweep (scores keep decaying — harmless and
  keeps the table complete).
- **Extract vocabulary:** no change — extract prompts are built from session content, not
  the stash; the re-assertion guard (§7) is the protection on the output side.

---

## 10. Wiring points (file:line anchors)

| File | Change |
|---|---|
| `src/commands/improve/memory/memory-improve.ts` | `invalidated` in `MemoryBeliefState` (:13), `resolveBeliefState` (:802-814), `isFrozenHistoricalBeliefState` (:798-800); transition reasons + `"invalidated"`/`"reinstated"` (:43); multi-member-sink branch of `resolveFamilyContradictions` (:513-538) routes to winner selection instead of refresh-to-active; `persistBeliefStateTransition` (:647-668) stops erasing `contradictedBy` on refresh (§5.4); export `isFrozenBeliefState` |
| `src/commands/improve/memory/memory-belief.ts` | `selectContradictionWinner` (pure) + `applyInvalidation` (§5.3) beside `writeContradictEdge` (:61-76) |
| `src/commands/improve/memory/memory-contradiction-detect.ts` | skip pairs with an `invalidated` member (near :271) |
| `src/commands/improve/preparation.ts` | thread resolution results (invalidated/unresolved counts) into the cleanup apply block (:880-906) and run metrics |
| `src/commands/improve/consolidate.ts` | merge-branch guard `merge_contradicted_participants` (~:1940, before the anti-collapse block; refusal shape mirrors :1966); `contradict` op (:2310-2356) additionally invokes winner selection → `applyInvalidation` when auto-resolvable |
| `src/commands/proposal/validators/proposals.ts` | `"invalidated_predecessor"` in `ProposalSkipReason` (:427); registry check first in `checkDedupAndCooldown` (:753-823); doc block (:620-632) |
| `src/core/state/migrations.ts` | migration `017-asset-invalidations` (§6; renumber if R5's 016 hasn't landed) |
| `src/core/state-db.ts` | registry CRUD (§6), same style as :1415-1675 |
| `src/core/events.ts` | `"contradiction_unresolved"`, `"reassertion_would_block"`, `"asset_invalidated"` in `EventType` (:45-140) |
| `src/indexer/passes/metadata.ts` | `invalidated` in the `beliefState` union (:116) |
| `src/indexer/search/ranking-contributors.ts` | `invalidated` → −0.55 (:107-120) |
| `src/indexer/search/db-search.ts` | `invalidated` in `historical` (:540-545) |
| `src/commands/improve/consolidate/eligibility.ts`, `recombine.ts` (~:302), `preparation.ts` (~:1315) | frozen-state pool exclusions (§9) |
| `src/commands/improve/improve-cli.ts` | `invalidations` / `resolve` / `reinstate` subcommands (§5.2) |
| `src/commands/health.ts` | improve advisory: unresolved-contradiction count + would-block volume (beside the existing improve advisories, ~:2222 region) |
| `src/core/config/config-schema.ts` + `config-types.ts` | `improve.invalidation` keys (§ below) — both sides in one commit (the config audit's two-source-of-truth rule) |

**Config keys** (`improve.invalidation`, top-level `ImproveConfigSchema` ~
`config-schema.ts:681-689`):

| Key | Default | Justification (branch precedent: deterministic fail-open → ON; behavior-suppressing → opt-in) |
|---|---|---|
| `enabled` | **true** | Deterministic, fail-open, and the current behavior it replaces is a verified self-cancellation bug (§1.2) plus a permanent LLM re-judge loop; default-ON is a net cost *reduction* |
| `blockReassertion` | **false** (v1) | Suppresses proposals on a fingerprint match — needs live precision data first; shadow events (§7.2) gather it; promoted in phase 2 |
| `minRecencyMarginDays` | **1** | Below one day, transcript ordering is noise; ties defer to human rather than guessing |

---

## 11. Test plan

All tests use `tests/_helpers/sandbox` `withIsolatedAkmStorage` (`sandbox.ts:209,248`);
no raw `process.env` mutation; CI-fast unit tests under `tests/` (no
`Bun.spawn`/`Bun.serve`/60 s timeouts — the unit-vs-integration boundary rule).

1. **Mutual-2-cycle regression (the headline).** Two derived memories, same parent,
   mutual `contradictedBy`, distinct `createdAt` (> margin). Run
   `analyzeMemoryCleanup` + `applyMemoryCleanup`. Assert: neither is refreshed to
   `active` (pins the §1.2 bug dead); the older is `invalidated` with
   `invalidatedAt`/`invalidatedBy`; the winner is `active` with the edge removed; a
   registry row and a JSONL `invalidated` transition exist. Then re-run
   `detectAndWriteContradictions` with a stub chat and assert the pair is **skipped**
   (edges retained → no re-judge oscillation).
2. **Tie / sub-margin / both-asserted:** no invalidation; both stay `contradicted` with
   edges retained; exactly one `contradiction_unresolved` event; idempotent across runs.
3. **Authority:** `asserted` loser by recency → deferred, never auto-invalidated;
   `asserted` winner beats newer `active`.
4. **Merge-vs-invalidate routing:** consolidate plan proposing `merge` over a pair with a
   contradiction edge → refused with `merge_contradicted_participants`; identical-
   fingerprint *agreeing* duplicates still merge/prune (thresholds untouched).
5. **Re-assertion blocking:** with `blockReassertion: true`, `createProposal` for (a) the
   invalidated ref and (b) a *different* ref with fingerprint-equal content → skipped
   `invalidated_predecessor`; `force: true` passes; with the flag off → proposal created
   + `reassertion_would_block` event.
6. **Re-extraction resurrection attempt (integration-shaped unit):** seed a session
   fixture, extract (stub LLM returning a fixed candidate), accept, invalidate the
   memory, then force re-extract the same session — the new candidate proposal is
   blocked; the session ledger alone demonstrably does NOT block it (assert the ledger
   would have skipped only without `--force`).
7. **Reinstate:** stamps `reasserted_at`, restores `beliefState`, unblocks subsequent
   proposals, logs `reinstated`.
8. **As-of query:** hand-built registry rows; the §8 SQL returns exactly the
   believed-at-X delta across t_valid/t_invalid/reasserted boundaries.
9. **Ranking/retrieval/pools:** `invalidated` entry excluded from `current`, included in
   `historical`, boost −0.55; excluded from consolidate/recombine/high-salience pools via
   the shared predicate.
10. **Fail-open:** registry write throwing (read-only DB) → resolution skipped with a
    warning, improve run completes green; `persistBeliefStateTransition` failures keep
    today's warning path (`preparation.ts:880-906` shape).
11. **Pure-function tables:** `selectContradictionWinner` over the §5.1 matrix
    (authority × margin × tie), fingerprint normalization parity with
    `buildFingerprint`'s `normalizeBody`.

---

## 12. Rollout plan

- **Phase 0 — land resolve-and-annotate (one PR).** Migration, belief state, resolver
  fix (no more mutual cancellation), deterministic auto-resolution, registry writes,
  CLI, merge guard, ranking/filter/pool integration, shadow re-assertion events.
  `blockReassertion` stays false. Gate: full `bun run check` green (custom lints
  included), zero new warnings.
- **Phase 1 — observe (2–4 weeks of live cron).** Read-only: registry growth rate,
  `contradiction_unresolved` backlog (should trend to zero as humans resolve),
  `reassertion_would_block` events (each one is either a caught resurrection — good — or
  a fingerprint false positive — tune). Success criteria: zero false invalidations on
  review of every auto-resolved pair (they're rare enough to review exhaustively), and
  would-block precision ≥ ~0.9.
- **Phase 2 — enforce (separate PR, owner sign-off).** Flip `blockReassertion` default to
  true. Independently, consider extending automated detection beyond derived-memory
  families (open question 4).

**Non-goals (explicit):** no weakening or re-tuning of contradiction *detection* (0.92
gate, family scoping, pair caps unchanged — analysis §7); no lossy distillation and no
deletion of losing content (retention IS the feature); no LLM resolution judge; no
`--as-of` search mode or per-run believed-set snapshots; no graph-db bi-temporal edge
model (Zep's full property-graph variant — frontmatter + registry is the minimal faithful
subset); no retroactive backfill of historical contradictions (lingering `contradicted`
records resolve organically the next time their family is cleaned); no change to the
distill D-1 ADD/UPDATE/NOOP destination-merge (different problem, correctly LLM-shaped).

---

## 13. Estimated diff size & file-by-file change list

| File | Change | Est. LOC |
|---|---|---|
| `src/commands/improve/memory/memory-belief.ts` | `selectContradictionWinner` + `applyInvalidation` | +140 |
| `src/commands/improve/memory/memory-improve.ts` | state/type additions; multi-sink resolution; edge-retention fix | +90 / −30 |
| `src/commands/improve/memory/memory-contradiction-detect.ts` | invalidated-member skip | +10 |
| `src/commands/improve/consolidate.ts` | merge guard; contradict-op resolution call | +45 |
| `src/commands/proposal/validators/proposals.ts` | reassertion guard + skip reason | +45 |
| `src/core/state/migrations.ts` | migration 017 | +40 |
| `src/core/state-db.ts` | registry CRUD | +80 |
| `src/core/events.ts` | 3 event types | +12 |
| `src/indexer/*` (3 files) | belief-state plumbing | +12 |
| `src/commands/improve/{consolidate/eligibility,recombine,preparation}.ts` | pool exclusions | +25 |
| `src/commands/improve/improve-cli.ts` | 3 subcommands | +90 |
| `src/commands/health.ts` | advisory | +30 |
| `src/core/config/config-{schema,types}.ts` | `improve.invalidation` | +30 |
| `tests/commands/improve/memory-invalidation.test.ts` | §11.1-3, 7-8, 10-11 | +320 |
| `tests/commands/consolidate/consolidate-contradiction-guard.test.ts` | §11.4 | +80 |
| `tests/proposals-reassertion.test.ts` | §11.5-6 | +140 |
| docs (runbook §8 query, cli.md) | | +40 |

**Total: ~+1,230 / −30 (production ~+650, tests ~+540).** The only hot-path additions are
one indexed SELECT per `createProposal` and one frontmatter read per merge op.

---

## 14. Owner decisions (resolved 2026-07-02)

All four open questions were put to the owner and decided:

1. **CLI placement: `akm improve resolve|reinstate|invalidations` (as specced).** No new
   `akm memory` command group for three verbs — speculative surface; if a memory group
   materializes later for other reasons, these verbs move behind an alias under the
   established break-then-alias pattern.
2. **`asserted`-vs-`asserted` conflicts: DEFER in v1** (the machine never auto-invalidates
   a user-authored record, even for a newer one). Revisit after the observe-first phase:
   if asserted-vs-asserted pairs show up frequently in the health advisory and human
   resolutions are consistently "newer wins", promote newer-asserted-wins then.
3. **Ranking penalty −0.55 confirmed** (worse than unresolved `contradicted` −0.45,
   slightly above `archived` −0.6). Belt-and-suspenders behind the `historical` filter;
   a single constant, tunable later.
4. **Cross-family detection: desired follow-up, NOT committed here.** Preferred shape
   when Phase 2 proves out: run contradiction detection over consolidate's *existing*
   similarity clusters (already computed for dedup) rather than whole-pool pairwise
   comparison — piggyback, don't add a new scan.
