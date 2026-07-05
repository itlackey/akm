> **ARCHIVED 2026-07-05 (meta-review 14).** Aspirational Postgres/multi-writer readiness findings, contradicted by the ratified positioning (review 10-Q4: single-owner, taste-made-durable; no pg client exists in src). Archived rather than updated (owner call, 2026-07-05).
> Current truth = `docs/technical/architecture.md`. Git history is the recovery path.

# akm Production-Readiness Findings & Hardening Plan

> Status: DRAFT for adversarial review. Every claim below must be challenged against the real code.
> Generated 2026-06-24 from a grounded, receipt-backed audit (5 dimension auditors + adversarial verification of every blocker/high finding) and integrated with the maintainer's stated production requirements. Author: Claude (the code being audited was largely written by Claude across prior sessions — treat self-assessment with suspicion).

## 1. Target state (what we are hardening FOR)

- **Now → near term:** each developer runs akm **locally against their own stash** — single-writer per store, SQLite.
- **Before v1:** **shared team stash backed by Postgres, multi-writer.** Postgres backs **state/metadata only** (state.db / workflow.db-class data: proposals, salience, outcomes, events). The **search index (FTS5 + sqlite-vec embeddings) stays SQLite-local** per developer.
- **Runtime:** **Node and Bun are co-equal, CI-gated on both** every commit. Neither path may rot. (`better-sqlite3` on Node is therefore first-class, not optional-and-unguarded.)
- **Reduce sprawl:** BOTH the on-disk runtime footprint (DBs/cache dirs/lockfiles/state scattered across the user's home/XDG dirs) AND the source tree.
- **Clean up rough spots** left by old/removed features still living in the code.
- **Timeline:** a quarter+. Root-cause fixes are in scope, not just triage.

## 2. Headline verdict

akm is **~4–6 months from production-ready for local-per-dev teams**, not weeks. Real working core; competent newer layers (structural `Database` type, typed `StorageLocations` facade, additive graph migration). The brittleness is a handful of **interacting root causes**, not scattered bugs:

1. Destructive schema evolution: `handleVersionUpgrade` drops ~24 tables outside a transaction; the pre-drop backup is best-effort and can silently no-op on a full disk.
2. **Three** embedding-purge sites; the two in `db.ts` back up, the one in `indexer.ts` wipes the (paid-API) corpus with **no backup**.
3. Module-level mutable singletons (config cache, embed cache, local embedder, graph-boost cache) → **6 hand-wired reset hooks** in a 381-line test preload (the rest of that preload is env/cwd/fetch sandbox safety, NOT singleton containment) and parallel tests kept off. Real code-health debt — but NOT a v1 blocker (§3/§7 correction).
4. `openDatabase` (the index-DB opener in `src/indexer/db/db.ts`) is **side-effectful** — opening it reads (and can rewrite) the user's config.json.

> **CORRECTION (doc review, 2026-06-24):** an earlier draft claimed `src/storage/database.ts` ships ~150 lines of in-memory-redirect/open-guard test machinery (lines 122-254). **Fabricated** — on `main` that file is 194 lines and clean (grep-confirmed zero test machinery); the claim was carried over from a different branch. Removed from §4.5 and §9. The review also cut/corrected inflated counts and one over-broad finding (see inline notes), and surfaced the §7 Postgres blocker.

The audit confirmed **9 serious findings** and **refuted/downgraded 3** of the auditors' own high-severity claims (§5). That adversarial step is load-bearing — do not re-introduce the refuted items.

## 3. How the new requirements change the audit (READ FIRST)

The audit was run before the §1 requirements were known. Two of its "CUT" calls are now **reversed**, and its storage conclusion changes:

- **Audit said: CUT multi-writer concurrency.** → REVERSED. Multi-writer Postgres (state store) is a v1 requirement. Concurrency is in scope — later, but it must be *designed for now* so it can slot in.
- **Audit said: CUT Node CI parity.** → REVERSED, but **Node CI already exists** — `release-gates.yml:63-91` has a `node-smoke` job (Node 20+22, compiles `better-sqlite3`, runs `test:node-smoke`/`test:node-compat`). The gap: it only runs on manual `workflow_dispatch`; `ci.yml` (per-commit) has **zero** Node jobs. Fix = wire `node-smoke` into `ci.yml` triggers, NOT build Node CI from scratch. Plus the `better-sqlite3` friendly-error guard.
- **Audit said: storage is NOT a rewrite, just ~1 week of bounded SQLite fixes.** → PARTIALLY REVERSED. For SQLite-only that was true. A **Postgres state-store provider + multi-writer** needs a real provider boundary (ports/adapters), scoped to state/metadata, NOT the search index — that *is* a bounded rewrite.

**Net (corrected by doc review):** singleton-reduction is valuable code-health work but is **NOT a hard prerequisite** for the StateStore provider (the config/embeddingDim coupling lives in the *index* DB, which stays SQLite-local). The **real** §7 prerequisites are: (1) decide `logs.db` fate (it cross-db-JOINs `state.db` via SQLite `ATTACH` — no PG equivalent); (2) drop/convert `workflow_entry_id` (integer FK into the rebuildable index); (3) define the `StateStore` interface over clean column types; (4) keep `body_embeddings` (BLOB cache) SQLite-local; (5) replace the **filesystem-based** `heldProcessLocks` exclusion with a DB advisory lock (it breaks across hosts under multi-writer). See §7.

## 4. Findings by dimension (with adversarial verdicts)

Severity shown as adversarially-CORRECTED where a verdict exists. `[sev/effort/SUBTRACT|add]`.

### 4.1 Data integrity / corruption
- **[high→med/M/add] `handleVersionUpgrade` drops ~24 tables outside any transaction** — `src/indexer/db/db.ts:607-649`. Crash mid-drop → half-destroyed schema. Verified real; severity corrected to med because the index is regenerable from markdown and a best-effort backup exists. Fix: wrap **drop+recreate+restore** (spans `ensureSchema` 256→~596, not just the drops) in one `db.transaction`. **Scope note: the audit's "30-min one-function" framing is WRONG — see §6.1.**
- **[high/M/SUBTRACT] Embedding provider/model change wipes ALL embeddings with NO backup** — `src/indexer/indexer.ts:1323-1338`. Inconsistent with the dim-change path (`db.ts:547`) which DOES back up. A one-line config edit silently burns paid-API re-embedding spend. Fix: delete the ad-hoc purge, route both through one backup-then-wipe helper.
- **[med/M/SUBTRACT] Opening the index DB can rewrite config.json** — see §4.5 foundation duplicate; auditors split it across dimensions.
- **[med/L/SUBTRACT] Destructive upgrade proceeds even when the pre-upgrade backup silently no-op'd** (low disk / opt-out / copy error) — `db.ts:214-247`, `db-backup.ts:335-343` (1.1× free-space gate). Fix: preserve only non-regenerable `usage_events` (already captured in-memory), drop the heavyweight full-dir copy.
- **[low/S/add] No WAL checkpoint on close** — `sqlite-pragmas.ts:166-167`, `db.ts:138-140`. Crash-safe but unbounded `-wal`. Fix: `PRAGMA wal_checkpoint(TRUNCATE)` in `closeDatabase`.
- **[low/S/add] `migrateGraphDataFromLegacy` drops legacy tables even when the copy failed** — `db.ts:1000-1042`. Fix: gate the drop on commit success.

### 4.2 Reliability / crashes
- **[high→med/S/add] `akm extract` exits 0 even when every harness fails** — `src/commands/improve/extract-cli.ts:155-170`. `ok:false` returns bypass the throw→exit-code mapping; the */30 cron silently "succeeds". Fix: make `akmExtract` throw on total failure (subtraction-leaning) OR `process.exit(1)` when `!ok`.
- **[high→med/S/SUBTRACT] `improve` finally calls `process.removeAllListeners("exit")`** — `improve.ts:1946`. Clobbers ALL exit listeners process-wide. Fix: `process.removeListener("exit", releaseAllOnExit)` (handler is a named const at 1302).
- **[med/M/SUBTRACT] Module-global `heldProcessLocks` Set shared across in-process improve runs** — `improve.ts:155`, test-only `resetHeldProcessLocks` at 157. Fix: thread an owned Set/LockManager; delete the global + reset hook.
- **[med/S/add] `bestEffort` cannot rethrow the test-isolation guard** — `core/best-effort.ts:21-25` vs `core/errors.ts:194-225`. Attractive nuisance. Fix: rethrow when `isTestIsolationError(err)`.
- **[med/M/add] Stash auto-sync (commit) failures swallowed as non-fatal on every path** — `improve.ts:1481-1490`. A persistently failing COMMIT means LLM-evolved markdown is never banked, invisible to exit codes. Fix: keep PUSH non-fatal; surface a health warning / non-zero on a COMMIT-fail streak (events already record it).
- **[med/M/SUBTRACT] Explicit-dim open does two independent best-effort destructive ops** (drop vec + delete embeddings) → half-wiped state — `db.ts:541-583`. Fix: one transaction, let real failure throw.

### 4.3 Install / upgrade / config
- **[high→low/L/SUBTRACT] Opening any SQLite DB can rewrite config.json (read→write side effect)** — DOWNGRADED by adversarial review (write is atomic+locked+backed-up; coupling smell, not corruption). Still worth decoupling. See §5.
- **[high→INVALID/XL] config dir vs data dir resolve from independent env vars** — REFUTED as XDG-by-design. Do NOT "fix". See §5.
- **[high→med/S/add] Node install hits raw `Cannot find module 'better-sqlite3'`** — `package.json:91-95` (optionalDep), `database.ts:290-298` (bare require). Given Node is now co-equal: add a `ConfigError` with install guidance AND CI-test the Node path.
- **[med/M/add] Auto-migration runs on EVERY load; `CURRENT_CONFIG_VERSION` frozen at "0.8.0"** — `config-migration.ts:24` vs package `0.9.0-beta.45`. Banner+backup churn risk on non-idempotent migration. Fix: stamp to binary version; fast-path trust `configVersion===binaryVersion && validates`.
- **[med/S/SUBTRACT] `AKM_LLM_API_KEY` no-ops for a renamed/implicit default profile** — `config.ts:541-549` keys off literal `defaults.llm`, not `resolveDefaultLlmProfileName`. Silent unauthenticated improve run. Fix: route through `resolveDefaultLlmProfileName(config)`.
- **[med/S/add] Downgrade guard fails open when `configVersion` unparseable** — `config.ts:292` (`=== 1` only). `compareConfigVersion` returns `undefined` for unparseable → migrates a newer config down. Fix: treat `undefined` like newer — leave bytes untouched, warn.
- **[med/M/SUBTRACT] `akm upgrade` auto-runs full `akm index` (piped, no progress) coupling binary swap to a long/destructive reindex** — `self-update.ts:346,374`. Fix: make post-upgrade reindex opt-IN; delete the spawnSync machinery.
- **[low/S/add] preinstall gate validates Node version but not a loadable SQLite driver** — `package.json:53`. Fix: `akm doctor`/postinstall opens an in-memory DB through the boundary.

### 4.4 Performance / scale
- **[high→med/M/SUBTRACT] Every search/show/feedback walks the entire stash filesystem before querying** — `db-search.ts:190` → `ensureIndex` → `isIndexStale` full recursive tree walk + load all indexed paths. Fix: cheap dir-mtime gate before the deep walk.
- **[high→med/M/SUBTRACT] `buildLatestProposalTsMap` reads ENTIRE reflect/distill event history, 4×/run, no `since`** — `improve.ts:901-921` (comment notes a 2-hour runaway on a 13K-asset stash). Fix: push `since` + `MAX(ts) GROUP BY ref` into SQL; reuse one pinned handle.
- **[med/L/SUBTRACT] improve opens state.db/index.db ~20×/run** — ~18 opener call-sites listed. Fix: thread one `eventsCtx.db` + one index.db handle.
- **[med/M/add] N+1 per-ref queries in planning** (`getConsecutiveNoOps`, `getAssetSalience` in loops) — `improve.ts:3207-3217,3875-3877`. Fix: batched `WHERE ref IN (...)`.
- **[med/M/add] Remote embedding batches strictly sequential** — `remote.ts:95-141`. Fix: bounded concurrency (reuse `concurrentMap`), preserve order.
- **[low/S/SUBTRACT] `getAllAssetOutcomes` full-table scan for a max** — `improve.ts:3409-3416`. Fix: `SELECT MAX(...)`.

### 4.5 Foundation / maintainability
- **[high→low/L/add] Storage location resolved from ambient `process.env` at every call site; `StorageLocations` facade exists but is unused** (3 import sites vs **~79 raw getter calls across ~35 files** — corrected from an inflated 375/87) — `paths.ts:206-278`, `locations.ts:55-67`. DOWNGRADED (structural claim true, harm narrative unsupported). Useful cleanup; **NOT a hard PG-provider prerequisite** (§3 corrected).
- **[high→med/L/SUBTRACT] `openDatabase` is side-effectful** (reads/rewrites config on open) — `db.ts:76-101,112-123`. Fix: explicit `embeddingDim` param, delete `resolveConfiguredEmbeddingDim`, auto-migration only at explicit startup/`akm config migrate`.
- ~~Production storage module ships ~150 lines of test-only machinery~~ — **DELETED: FABRICATED.** `src/storage/database.ts` is 194 lines, clean (grep-confirmed zero pool/guard/`AKM_TEST_HARNESS`). No deletion task exists.
- **[high→med/L/SUBTRACT] Test isolation leans on a 381-line preload that resets module singletons** — but only **6 reset targets** (`resetConfigCache`, `clearEmbeddingCache`, `resetLocalEmbedder`, `resetGraphBoostCache`, `setQuiet`/`clearLogFile`, `resetVerbose`), corrected from an inflated "28". The other ~350 lines are env/cwd/fetch sandbox safety — **load-bearing protection, not containment.** Fix: reduce the 6 singletons (config + graph-boost caches → explicit context). Valuable; not a PG prerequisite.
- **[med/L/SUBTRACT] `paths.ts` encodes test-harness + past-incident defenses into production resolution** (transient-stash rerouting, under-bun-test throw) — `paths.ts:48-58,101-104,218-220,347-435`. Fix: once locations resolve once at boot, these become unnecessary.
- **[med/XL/add] `ensureSchema` does destructive drops keyed to one `DB_VERSION` integer; no real migration framework** — `db.ts:607-649`. Fix: additive/targeted migrations (graph path `db.ts:964-1048` shows the pattern); reserve nuclear drop for incompatible breaks.

## 5. Refuted / downgraded — do NOT re-introduce

- **REFUTED (invalid): config-dir vs data-dir independence** — XDG-by-design per `docs/technical/storage-locations.md`; collapsing roots regresses XDG compliance. The incident attribution was backwards.
- **DOWNGRADED to low: "opening a DB silently rewrites config.json"** — the write is atomic + `withConfigLock` + backed-up; it is a *coupling* smell (decouple for cleanliness), not a corruption/data-loss risk. Two auditors double-counted it.
- **DOWNGRADED to low: ambient-env storage location is high-severity harm** — structural claim holds, but no demonstrated corruption; promoted only because it's the PG-provider prerequisite, not because it's actively dangerous today.

## 6. The integrity floor (do first — architecture-agnostic, mostly subtractive)

These are correct regardless of the Postgres/Node decisions. Ordered by safety/payoff. **Each lands only with `bun run check` clean (0/0) AND the relevant test suite green.**

1. ✅ **DONE** — `process.removeListener` swap (`improve.ts:1918`, hoisted `exitBackstop` ref). Verified green.
2. ✅ **DONE** — config downgrade guard (`config.ts:292`): skip migration when newer OR present-but-unparseable; **legacy missing-version still migrates** (the audit's "treat undefined as skip" would have broken that — regression avoided). Verified green.
3. ✅ **DONE** — `AKM_LLM_API_KEY` routed through `resolveDefaultLlmProfileName` (`config.ts:557`). Verified green.
4. ✅ **DONE** — `extract` sets `process.exitCode=GENERAL` on total failure (`extract-cli.ts`). Verified green.
5. ✅ **DONE** — `better-sqlite3` friendly-error guard (`database.ts:160-168`, NOT 290-298 — corrected). Verified green. (Node CI wiring — move `node-smoke` into `ci.yml` — is a separate workstream, §3/§8.)
6. ⏳ **TODO** — Unify the **THREE** embedding-purge sites through one backup-then-wipe helper: `db.ts:541-553` (vec, backs up), `db.ts:571-579` (JS fallback, backs up), `indexer.ts:1316-1330` (**no backup**). Must collapse all three, not just delete the indexer block, or `db.ts`'s internal duplication remains. Needs a test asserting backup-on-fingerprint-mismatch.
7. ⏳ **TODO (now unblocked)** — Transaction-wrap the schema drop+recreate+restore. See §6.1.

### 6.1 Transaction boundary — RESOLVED by doc review
The open question is answered: **no statement in the create-path is transaction-hostile.** The only PRAGMAs inside it are read-only `PRAGMA table_info` (db.ts:711, 922, 961) — safe in a transaction. The schema-altering PRAGMAs (`journal_mode=WAL`, `foreign_keys`) run via `applyStandardPragmas()` **before** `ensureSchema` (db.ts:79), outside the proposed transaction. Virtual-table `CREATE` (vec0, FTS5) is transaction-safe with sqlite-vec loaded, on both Bun and Node (`transaction()` is driver-normalized). **The one real constraint:** `index_meta` `CREATE` (db.ts:~195-200) must run *before* the transaction, because `handleVersionUpgrade()` calls `getMeta()` which reads it. **Boundary: begin AFTER index_meta creation (~line 200), span `handleVersionUpgrade()` → `restoreUsageEventsBackup()` (~line 591).** Effort is adequate test coverage, not a technical incompatibility — the "structural blocker" framing was an overstatement.

## 7. Storage / provider architecture (re-scoped for §1)

Direction (REWRITTEN after doc review found my "two stores" framing wrong and a hard PG blocker):

**FOUR durable databases, not two:**
- **`index.db`** (entries, FTS5, embeddings, graph) — **SQLite-local per dev.** Regenerable. No provider.
- **`state.db`** (events, proposals, asset_salience, asset_outcome, improve history) — **PG candidate** behind a `StateStore` interface (SQLite adapter now, Postgres adapter before v1, multi-writer).
- **`workflow.db`** (run state) — PG candidate, or merge into `state.db`.
- **`logs.db`** (task stdout/stderr) — **was entirely missing from the StorageLocations facade and this doc.** SQLite-local, OR merge into `state.db` — see the blocker.

**HARD BLOCKER — SQLite `ATTACH` cross-db JOIN (must decide before any PG adapter):** `logs-db.ts:303-379` (`queryFailedRunLogLines`, called from `health.ts` + `tasks/runner.ts`) attaches `state.db` and runs a live SQL `JOIN` across `logs.db × state.db`. **`ATTACH` has no Postgres equivalent.** Resolution: either (a) **merge `logs.db` into `state.db`** so the JOIN becomes a normal in-schema join (simpler — recommended), or (b) abandon the cross-db SQL join for application-level correlation. Decide first.

**Real prerequisites (NOT singleton-reduction — that was an overcorrection):**
1. Decide `logs.db` fate (the ATTACH blocker).
2. Drop or convert `workflow_entry_id` (`workflow-runs-repository.ts:21`) — an INTEGER FK into `index.db`'s `entries`, which is reassigned on every index rebuild → stale post-split. Use the stable `workflow_ref` instead.
3. Define the `StateStore` interface; translate DDL (SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` → PG `IDENTITY`/`BIGSERIAL`; `datetime('now')` → `now()`; the `readEvents` cursor relies on the autoincrement rowid — needs sequence semantics in PG).
4. Keep `body_embeddings` (raw `BLOB`, `state-db.ts:597-603, 2334`) **SQLite-local** — pure cache; BLOB→BYTEA decode is a needless hazard.

**Multi-writer PG is real call-site work, not free** (my "no read-modify-write without txn" claim was false):
- `buildLatestProposalTsMap` (`improve.ts:882-901`) reads all events into a JS map and aggregates in app code — two concurrent PG writers can overwrite each other's conclusions. Push to SQL or guard transactionally.
- `heldProcessLocks` (`improve.ts:153`) is **filesystem-based** lock exclusion — it breaks across hosts under multi-writer. Needs a DB advisory lock or a lock service. (This is a cross-host problem, NOT a singleton-cleanup problem.)
- Cross-store reads (`index.db` candidates → `state.db` salience/no-op filters) are app-level joins that survive the split but **lose snapshot consistency** — an accepted eventual-consistency tradeoff that must be stated, not hand-waved.

## 8. Sprawl & dead-code — UNDER-AUDITED, needs a dedicated pass

The audit did not specifically map sprawl or dead code (scoped before these requirements). What the doc review surfaced:
- **On-disk sprawl — LARGEST ITEM: ~149MB of orphaned agent/workflow scratch worktrees under `.claude/worktrees/`** (9 full source-tree copies). Gitignored agent scratch — every grep/glob hits 9 stale copies. **These are user-owned gitignored paths → require per-path owner confirmation before any cleanup (not auto-deletable).**
- **On-disk sprawl:** four DBs + caches + lockfiles + state across XDG roots. The XDG separation itself is by-design (§5); the consolidation target is `logs.db`→`state.db` (§7) and fewer lockfiles, not collapsing XDG roots.
- **Source-tree sprawl:** to be measured (file/dir count). Separate work item.
- **Dead code — CORRECTED:** `config edit` is **already removed** (confirmed). The "in-memory pool" **never existed** in current `src/storage/database.ts` (my fabrication). The graph legacy migration (`migrateGraphFilesSchema`, `migrateGraphDataFromLegacy`, `db.ts:412,506`) is **NOT dead** — it runs on every open as a permanent pre-#624 upgrade shim. **A real dead-code pass is still owed; the candidate list above was largely wrong.**
- **Stale doc:** `docs/technical/storage-locations.md` says DB_VERSION=14 / graph v3 but code is at 17 / v4 — flag for update.
- **`StorageLocations` is missing `logsDb`** (`locations.ts:27-46` lists only index/state/workflow) — add it.

## 9. Sequencing (quarter)

- **Weeks 1–2:** integrity floor (§6 1–6), then §6.7 with full upgrade tests. Plus Node CI matrix + `better-sqlite3` guard.
- **Weeks 3–4:** perf quick wins (isIndexStale gate, event-scan SQL filter), graph-migration drop-on-success.
- **Month 2:** storage prerequisites — `StorageLocations` boot resolution, `openDatabase` side-effect removal, begin singleton reduction. Replace heavyweight pre-upgrade backup with `usage_events`-only.
- **Month 2–3:** singleton reduction completes → DELETE the in-memory redirect (~150 lines) + shrink the preload; re-enable `bun test --parallel=2` as a canary.
- **Month 3:** `StateStore` provider boundary (SQLite adapter) + PG adapter scaffolding; handle consolidation in improve. Sprawl + dead-code pass.
- **End-of-quarter gate:** integrity items done; singletons → 0 reset hooks; redirect deleted; `--parallel=2` green 20 consecutive CI runs; `StateStore` interface in place with SQLite adapter; Node+Bun CI both green.

## 10. Explicit claims for the review team to attack

1. Is the "search SQLite-local + state Postgres-shared multi-writer" split coherent and complete? (§7)
2. Is the transaction-wrap's PRAGMA/virtual-table concern real? (§6.1)
3. Did I correctly reverse the two audit CUTs, or did I over-correct? (§3)
4. Any finding in §4 mis-stated vs the actual code? Any refuted item in §5 wrongly refuted (i.e. a real bug I'm now ignoring)?
5. Is promoting singleton-reduction to "prerequisite" sound, or is it scope creep dressed as foundation?
6. What did the audit (and this doc) MISS — especially on sprawl, dead code, and Node-path parity?
7. Is the 4–6 month estimate honest, or is it optimistic/pessimistic given the PG + Node requirements?
