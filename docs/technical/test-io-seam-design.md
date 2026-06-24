<!-- Produced by the test-io-seam-design-review workflow (5 specialist designs -> synthesis -> 3 adversarial anti-pattern reviewers -> hardened finalize). 4 blocker + 7 major findings were resolved; see the anti-pattern verification table in S6. Companion to test-io-seam-map.md. -->

# AKM Test I/O Seam Architecture — FINAL Hardened Design (#664)

## 1. Executive summary + core thesis

**Symptom (one):** the AKM unit suite cannot run with `bun test --parallel>1`. It is pinned to `--parallel=1` (verified: `scripts/run-test-shard.sh:79`, `package.json:62-63`) because the unit tier still performs real I/O — HTTP servers (`Bun.serve`), real SQLite opens (`openExistingDatabase`/`openStateDatabase`), real index builds (`akmIndex({full:true})`), real subprocess spawns, real timers — and that fd churn triggers the Bun `--isolate` epoll race (see `akm-bun-parallel-test-hang` memory).

**Thesis:** the fix is not "make the tests faster" or "monkeypatch globals." It is to introduce **production I/O seams at the exact point each real resource is acquired**, so a unit test can supply an in-memory implementation and exercise the *real* code branch with *zero* real I/O. The adversarial reviews proved that several proposed seams sat *below* the acquisition point (embedder facade, search `ensureIndex`/`openExistingDatabase`, events per-tick `openStateDatabase`) and therefore would have left real I/O in place while *claiming* purity. This final plan moves every seam **up to the acquisition point**, and adds a runtime purity guard so the lint can never again certify a test "pure" that still opens a DB or socket.

**Six seams, one style, measurable gate:**

| # | Concern | Acquisition point (verified) | Seam |
|---|---|---|---|
| 1 | HTTP | `globalThis.fetch` inside `fetchWithTimeout` (`common.ts`), reached via `chatCompletionAttempt`, `RemoteEmbedder`, registry `loadIndex` | `HttpClient` (`FetchLike`) injected at **each** of those three points **and** the `embed()` facade |
| 1b | Registry index cache | duplicated `withRegistryCacheDb` in `static-index.ts:182` + `skills-sh.ts:47` | `RegistryCache` port (after consolidating the duplicate helper) |
| 2 | Improve entry read | `openExistingDatabase()` + `getAllEntries(db,…)` (`improve.ts:663-664`) | `GetAllEntries` function value over a **`:memory:` index DB** (real `upsertEntry`/`getAllEntries`; no JS query reimpl) |
| 3 | Search / FTS / vector | `ensureIndex` + `openExistingDatabase` + `getEntryCount` **then** `searchFts`/`searchVec`/`getAllEntries` (`db-search.ts:186-554`) | extract `searchOnDb(db,…)` + `searchLocal({ db })` over a **`:memory:`** index DB (real FTS5+sqlite-vec run pure — verified). `beforeAll` fixture kept as an ergonomic option |
| 4 | stdin | `fs.readFileSync(0)` / `process.stdin` in leaf helpers (`common.ts`, `runtime.ts`) | ambient `StdinPort` slot, harness-scoped, test-guarded |
| 5 | Time | `Date.now()` + `setInterval` in `tailEvents`; bookend `Date.now()` in improve; `readEvents` `openStateDatabase` per tick | `now` scalar (improve) + `EventsContext.{now,db}` reuse + injected interval timer (events) |

---

## 2. Chosen injection style and rejected anti-patterns

**The one style: an optional dependency, defaulting to the real implementation, injected at the subsystem's *existing* dependency boundary and at the *actual acquisition point*.** This is the established repo convention — `chatCompletion`'s `sleep`/`now` (`client.ts:248`), `akmImprove`'s `collectEligibleRefsFn`/`setTimeoutFn` (`improve.ts:297`). Concretely:

- A **function-value param** (e.g. `fetch?: HttpClient`, `getAllEntries?: GetAllEntries`, `now?: () => number`) when the boundary is a function the test already calls. This is the default and dominant form.
- An **options-bag field** when the subsystem already threads one (`ChatCompletionInternalOptions`, `AkmImproveOptions`, `TailOptions`, `RemoteEmbedderDeps`).
- An **ambient harness-scoped slot** *only* for stdin, the lone resource read in a leaf helper with no boundary reachable from the test — and it is **guarded so production can never mutate it**.

**Shared vocabulary, not a shared container.** Each concern gets one small *type* (`HttpClient`, `GetAllEntries`, `RegistryCache`, `StdinPort`) in a leaf module; each subsystem injects its *own instance*. There is **no `IoContext`/`RuntimeContext` god-object.**

### Anti-patterns explicitly rejected (with review citations)

- **God-context / service-locator (`IoContext { fetch, entries, stdin, clock, cache }`)** — rejected. A unified bag couples every subsystem to one type and forces every test to build the whole bag to test one seam. (Reviewer 1 confirmed the per-concern-type approach is correct and warned a bundled `Clock` already drifts toward this.)
- **Module-level mutable `setFetch()`/`currentClock` singleton** — rejected for fetch/entries/time; those are explicit per-call params so parallel tests cannot race them. The lone ambient slot (stdin) is harness-only and **code-guarded** (Reviewer 1 finding 4; Reviewer 2 finding 9).
- **Test-harness global monkeypatch (nock-style `globalThis.fetch` swap, `jest.useFakeTimers`)** — rejected as the *fix*; we use real production seams so the code under test runs the real branch. (We *do* use a throwing monkeypatch purely as a **negative guard** in the unit tier — see §5 — never as the injection mechanism.)
- **Repository-shaped abstraction where a function suffices** — rejected. Reviewer 1 finding 1 was accepted: `EntryReader` interface in a speculative `src/storage/repositories/` namespace is demoted to a bare `GetAllEntries` function type co-located with `dbGetAllEntries`, matching the `collectEligibleRefsFn` neighbor convention.
- **Speculative `Clock` 3-method interface forcing a production rewrite** — rejected. Reviewer 1 finding 3 (major) and Reviewer 3's clock-fidelity finding were accepted: **no `Clock` interface.** Time is virtualized with the minimal scalar each site needs (see §3 Seam 5).
- **Required params / public-API breakage** — rejected; every seam is a trailing optional defaulting to real.
- **Hand-enforced tier boundary** — rejected; enforced by a shrink-only, self-policing lint ratchet **plus** a runtime purity guard (the lint alone cannot see `openDatabase`-via-facade — Reviewer 2 finding 10).

---

## 3. Per-seam canonical interfaces, grounded in real files

### Seam 1 — `HttpClient` (HTTP boundary)

Type in `src/core/common.ts`:

```ts
export type HttpClient = (input: string | URL, init?: RequestInit) => Promise<Response>;

export async function fetchWithTimeout(
  url: string, opts?: RequestInit, timeoutMs = 30_000, signal?: AbortSignal,
  fetchImpl: HttpClient = globalThis.fetch,        // NEW trailing optional, real default
): Promise<Response> { /* calls fetchImpl(url, {...opts, signal}) */ }

export async function fetchWithRetry(
  url: string, init?: RequestInit,
  options?: { timeout?: number; retries?: number; baseDelay?: number;
              fetchImpl?: HttpClient; sleep?: (ms: number) => Promise<void> },
): Promise<Response> { /* threads options.fetchImpl into fetchWithTimeout;
                          replaces inline `new Promise(r=>setTimeout(r,delay))` with options.sleep ?? realSleep */ }
```

**Wiring at the four real acquisition points** (all verified):

1. **`chatCompletionAttempt` — widen the param type (Reviewer 2 finding 5; Reviewer 3 minor).** `fetchWithTimeout` is called at `client.ts:328` inside `chatCompletionAttempt`, whose param is typed `ChatCompletionOptions | undefined` (`client.ts:303`) — the **public** type, which does not carry `fetch`. Adding `fetch?` to `ChatCompletionInternalOptions` alone is **insufficient**. Fix: widen `chatCompletionAttempt(options: ChatCompletionInternalOptions | undefined)` (internal-only; it already receives the internal object at runtime via the pass-through from `chatCompletion`), then `fetchWithTimeout(url, init, timeout, signal, options?.fetch ?? globalThis.fetch)`. No public surface change.

2. **`RemoteEmbedder` ctor** (`remote.ts:27`): `constructor(config, private deps: RemoteEmbedderDeps = {})` with `RemoteEmbedderDeps { fetch?: HttpClient }`, used as `(this.deps.fetch ?? globalThis.fetch)`. Export `l2Normalize` (was file-private).

3. **`embed()`/`embedBatch()` facade — thread the dep (Reviewer 2 finding 1, blocker).** The dominant test path goes through the module facade `embed()` (`embedder.ts:78`), which constructs `new RemoteEmbedder(embeddingConfig)` with **no deps** (`embedder.ts:85,106,162`) — so injecting on the ctor alone leaves the facade un-injectable. Fix: add `deps?: { fetch?: HttpClient }` to `embed`/`embedBatch`/`embeddingHealthCheck` and forward it: `new RemoteEmbedder(embeddingConfig, deps)`.

   **Module-global cache hazard (same finding).** `embedCache` and `_localEmbedder` (`embedder.ts:45`) are module-global singletons; a cache hit in test A leaks a vector into test B under in-process parallelism. Resolution: (a) the existing `clearEmbeddingCache()` + `resetLocalEmbedder()` (already imported in `tests/_helpers/cli.ts`) are added to `resetAllProcessState()` so they run on every harness reset; (b) **the `--parallel>1` flip is inter-process-only** (§4), so each shard has its own module instance and these globals never co-execute. Both `embedCache` and `_localEmbedder` are added to the documented "module globals that mandate process-level isolation" list (Reviewer 2 finding 9).

4. **Registry `loadIndex` — thread past the factory (Reviewer 2 finding 6, major).** The HTTP call is in the free function `loadIndex(entry)` calling module-imported `fetchWithRetry` (`static-index.ts`), which takes no provider instance — so widening `RegistryProviderFactory` to `(config, deps?)` is necessary but **not sufficient**. Fix: `loadIndex` gains a 2nd param `deps?: { fetch?: HttpClient; cache?: RegistryCache }` (or closes over them in the provider closure); same in `skills-sh.ts`. `RegistryProviderFactory` widens to `(config, deps?: RegistryProviderDeps)` (backward-compatible widening; existing factories ignore the extra arg).

**Pure functions tested directly, zero HTTP:** `scoreKits`, `scoreAssets`/`scoreStash`, `parseRegistryIndex`, `parseSkillsResponse`, `l2Normalize` (newly exported), `normalizeEmbeddingEndpoint`, `estimateTokenCount`, `hasRemoteEndpoint`, `resolveEmbeddingModelId`. **AbortSignal branch:** retain one injected-`HttpClient` test that rejects with an `AbortError`-shaped `DOMException` so the `client.ts:351` timeout→`LlmCallError` mapping stays covered.

### Seam 1b — `RegistryCache` (trimmed contract; consolidate first)

**Consolidation is a real pre-step, not a "verbatim wrap" (Reviewer 2 finding 6 + Reviewer 3 finding 2, major; verified).** `withRegistryCacheDb` is **duplicated** as a file-private helper in both `static-index.ts:182` and `skills-sh.ts:47`, each with its own `rethrowIfTestIsolationError` call. Only `getRegistryIndexCache`/`upsertRegistryIndexCache` live in `db.ts:2574,2602`. Step 1 therefore **first** extracts the two `withRegistryCacheDb` bodies into one exported helper (in `src/registry/providers/cache-db.ts`), preserving each `rethrowIfTestIsolationError` call, and proves byte-equivalence — *then* builds the default adapter over the single helper.

Trimmed port (Reviewer 1 finding 2 accepted — etag/lastModified stay in the default adapter, not on the cross-boundary contract):

```ts
// src/registry/providers/types.ts
export interface RegistryCache {
  get(key: string, ttlMs: number): { indexJson: string } | undefined;
  upsert(key: string, json: string): void;
}
export interface RegistryProviderDeps { fetch?: HttpClient; cache?: RegistryCache; }
export type RegistryProviderFactory = (config: RegistryConfigEntry, deps?: RegistryProviderDeps) => RegistryProvider;
```

The **default adapter** wraps the single consolidated `withRegistryCacheDb` + `getRegistryIndexCache`/`upsertRegistryIndexCache`, **owns** etag/lastModified conditional-GET fidelity internally, and **preserves `rethrowIfTestIsolationError`** so leaky tests get the loud `TEST_ISOLATION_MISSING` failure, never a silent cold cache. The **in-memory adapter** (a `Map`) is what provider unit tests inject so they never touch `index.db`.

### Seam 2 — `GetAllEntries` over a REAL `:memory:` index DB (no `filterEntries` reimplementation)

> **REVISED (#664 follow-up — `:memory:` adapter).** The previous version of this seam
> introduced a hand-written JS `filterEntries(rows, entryType, excludeTypes)` that
> re-implemented the `getAllEntries` SQL WHERE/exclude logic in TypeScript, plus a
> decode-parity round-trip test to police drift between the JS reimplementation and the
> real SQL. **That whole construction is removed.** It was unnecessary: a Bun
> `bun:sqlite` `:memory:` database runs the *real* SQL with zero file descriptors and
> zero disk, so the in-memory adapter can seed via the **real `upsertEntry`** and read via
> the **real `getAllEntries`**. There is no second query implementation to keep in sync,
> therefore no parity test and no semantic-drift risk.

**Verified prerequisite — schema applies on a fresh `:memory:` open.**
`openDatabase(dbPath?)` (`src/indexer/db/db.ts:71`) runs `ensureSchema(db, …)` (`db.ts:90`)
**unconditionally**, independent of the path: it creates `index_meta`, `entries` (+ its
indexes and the `derived_from` column via `ensureDerivedFromColumn`), `entries_fts`
(FTS5), `embeddings`, `entries_vec` (when sqlite-vec loads), the graph tables,
`utility_scores`, `index_dir_state`, the registry-cache table, etc. So a fresh
`openDatabase(":memory:")` is a **fully usable** index DB. Empirically confirmed on Bun
1.3.14: `openDatabase(":memory:")` returns a handle on which `entries`,
`upsertEntry`/`getAllEntries`, **FTS5 `MATCH` + `bm25()`**, and **sqlite-vec
(`isVecAvailable === true`, `entries_vec` vec0 table present)** all work; `journal_mode`
auto-degrades from `WAL` to `memory` (no `-wal`/`-shm` files, no fd). The repo already
relies on this pattern for the events DB — `openStateDatabase(":memory:")` runs the full
migration array and is used ~16× in `tests/extract-session-tracking.test.ts`.

**The type and both implementations** live next to `getAllEntries` in `src/indexer/db/`:

```ts
// src/indexer/db/entry-reader.ts
import type { DbIndexedEntry } from "./db";
import { openExistingDatabase, openDatabase, getAllEntries } from "./db";
import type { Database } from "../../storage/database";

export type GetAllEntries = (entryType?: string, excludeTypes?: string[]) => DbIndexedEntry[];

// Default — the EXACT production open path: openExistingDatabase() + getAllEntries() + close.
export function sqliteGetAllEntries(): GetAllEntries {
  return (t, ex) => { const db = openExistingDatabase(); try { return getAllEntries(db, t, ex); } finally { db.close(); } };
}

// In-memory — runs the REAL getAllEntries SQL against a REAL :memory: DB.
// `db` is a long-lived handle (a :memory: DB is destroyed on close, so the
// caller seeds and reads through ONE handle; we do NOT close per call).
export function inMemoryGetAllEntries(db: Database): GetAllEntries {
  return (t, ex) => getAllEntries(db, t, ex);   // same symbol as production — zero query drift
}
```

There is **no `filterEntries`** function anywhere. Both adapters terminate in the identical
`getAllEntries(db, …)` SQL; the only difference is which handle they read.

**Open-path parity (Reviewer 2 finding 7) — still holds, now trivially.** Production uses
`openExistingDatabase()` (verified `improve.ts:663`); `sqliteGetAllEntries` uses the same
symbol. The in-memory adapter calls the same `getAllEntries` over a handle that ran the
same `ensureSchema`. "Byte-for-byte unchanged query semantics" is now a *fact of shared
code*, not a claim defended by a parity test.

**Wiring (unchanged from prior plan):** `AkmImproveOptions.getAllEntries?: GetAllEntries`
(default `sqliteGetAllEntries()`) replaces the inline `db = openExistingDatabase();
getAllEntries(db, …)` at `improve.ts:662-664`, keeping the existing
`.filter(isEntryInScope/isEntryInWritableSource)` chain. The coarse `collectEligibleRefsFn`
(`improve.ts:297`) is **kept** as the outer seam; `GetAllEntries` is the inner seam that
feeds **real planner logic** the rows from a real `:memory:` `entries` table so
scope/writable/profile-prefilter/dedupe/proposed/belief filters all stay under test.
`improve-multi-cycle.test.ts` (the sole `collectEligibleRefsFn` user) is untouched.

**Test seed helper** `tests/_helpers/seed-entries.ts` — now seeds a real `:memory:` DB and
returns the live handle plus the bound reader:

```ts
import { openDatabase, upsertEntry } from "../../src/indexer/db/db";
import { inMemoryGetAllEntries, type GetAllEntries } from "../../src/indexer/db/entry-reader";
import type { Database } from "../../src/storage/database";

export interface SeededIndex { db: Database; getAllEntries: GetAllEntries; }

// Opens an in-memory index DB (full ensureSchema), seeds via the REAL upsertEntry,
// and returns a reader bound to the same handle. Caller closes `db` in afterEach
// (or relies on GC) — a :memory: DB has no file to clean up.
export function seedEntries(specs: Array<Partial<StashEntry> & { stashDir?: string; filePath?: string }>): SeededIndex {
  const db = openDatabase(":memory:");
  for (const spec of specs) {
    const entry = materializeStashEntry(spec);          // fills required StashEntry fields
    upsertEntry(db, entry.entryKey, spec.dirPath ?? "d", spec.filePath ?? `f-${entry.entryKey}`,
                spec.stashDir ?? "s", entry, buildSearchFields(entry).searchText);
  }
  return { db, getAllEntries: inMemoryGetAllEntries(db) };
}
```

**No decode-parity test (Reviewer 2 finding 8 obsoleted).** The prior plan's round-trip
parity test existed solely to catch `filterEntries`-vs-`getAllEntries` and
`seedEntries`-vs-`parseEntryRows` drift. With the in-memory adapter, seeding goes through
the **real `upsertEntry`** and reading through the **real `getAllEntries` →
`parseEntryRows`**, so there is exactly one decode path — the production one. The parity
test is **deleted, not weakened**; the residual risk it guarded (§7 "filterEntries semantic
drift") is eliminated at the root.

### Seam 3 — search/FTS/vector — VERDICT: `:memory:` makes it purifiable; the "out of scope" punt is LIFTED

> **REVISED (#664 follow-up).** The prior plan declared full FTS/vector search purity "out
> of scope" because `searchLocal` does real I/O *above* the data-source seam. The
> `:memory:` adapter changes that verdict. The FTS5 + sqlite-vec scoring pipeline runs
> verbatim against a `:memory:` index DB — empirically confirmed (FTS5 `MATCH`/`bm25()` and
> sqlite-vec `entries_vec` both available on `:memory:` under Bun 1.3.14). So the real
> `searchFts`/`searchVec`/ranking code *can* execute in a zero-I/O unit test. Below is the
> feasibility breakdown and the concrete seam that delivers it.

**Why the prior blocker is real (Reviewer 2 finding 2, verified).** `searchLocal`
(`db-search.ts:98`) does, in order: `ensureIndex(stashDir)` (`:186`) — which keys off
`getDbPath()`/`isIndexStale(stashDir)` and rebuilds the **on-disk** DB, with **no
DB-handle injection point** — then `openExistingDatabase(getDbPath())` (`:198`) +
`getEntryCount` (`:200`), then dispatches to `searchDatabase(db, …)` (`:210`). All the
impurity is in those top-of-function lines.

**Why `:memory:` lifts it — the scoring core is ALREADY handle-injectable.** Everything
below the open takes the `db` handle as a parameter: `searchDatabase(db, …)` (`:244`) calls
`getAllEntries(db,…)` (`:278`, empty-query branch), `searchFts(db,…)` (`:333`), and
`searchVec(db,…)` (`:554`). None of them touch `getDbPath()` or open anything — they run
SQL on the handle they're given. So the *only* thing forcing real I/O is the acquisition
preamble, not the search logic. Point the search at a `:memory:` handle and the **real FTS5
+ vector pipeline runs pure**.

**The seam (concrete, file:line).** Extract the impure preamble from the pure core:

1. Lift `searchDatabase` (currently a file-private `async function` at `db-search.ts:244`)
   to an **exported** `searchOnDb(db, input)` — it already has the full signature and does
   zero acquisition. This is the unit-test entry point: a test calls
   `seedEntries([...]).db` → `rebuildFts(db)` (real, in-memory) → `searchOnDb(db, {query,…})`
   and asserts on real `bm25()` ranking with **zero fd/disk**.
2. Add an optional `db?: Database` to `searchLocal`'s input bag. When provided, `searchLocal`
   **skips `ensureIndex` + `openExistingDatabase`** and calls `searchOnDb(input.db, …)`
   directly (it must also skip the `closeDatabase` in the `finally` at `:238` so it never
   closes a caller-owned `:memory:` handle — gate the close on "we opened it"). When absent,
   behavior is byte-identical to today. This is the same trailing-optional-defaulting-to-real
   style as every other seam.
3. For tests that want the *whole* `searchLocal` wrapper (warnings, semantic-status,
   source-filtering) pure, inject `db: seedEntries([...]).db`; for tests that only care about
   ranking/FTS/vec, call `searchOnDb` directly.

**FTS/vector availability on `:memory:` (the load-bearing fact).** Bun `bun:sqlite` ships
FTS5 compiled in, so the `entries_fts` virtual table, `MATCH`, and `bm25()` work on a
`:memory:` DB. sqlite-vec's `load(db)` (`db.ts:149`, called from `loadVecExtension` inside
`openDatabase`) succeeds on a `:memory:` handle too, so `entries_vec` (vec0) is created and
`isVecAvailable(db) === true` — meaning `searchVec`'s native-KNN path (not just the JS
fallback) executes in the unit test. Both verified empirically. **Caveat to document:** the
embedding *vectors* still have to come from somewhere — semantic ranking needs `embeddings`
rows. A pure vector-search test seeds deterministic vectors directly (insert BLOBs via the
real embedding-write path) rather than calling a real embedder; the embedder itself is
Seam 1 (`HttpClient`), kept separate. Keyword/FTS-only search tests need no embeddings at
all.

**Residual genuinely-integration cases (still thin-integration, not punted by oversight):**
- Tests whose subject **is** `ensureIndex`/staleness/`indexCanServeStash`
  (`improve-ensure-index-first`, `index-clean`, the indexer/e2e cluster) — the on-disk
  rebuild is the SUT; keep the `beforeAll` real index.
- `improve-db-locking` — the file lock is the SUT; a `:memory:` DB has no lock file.
- The `tests/fixtures/stashes/load.ts` `beforeAll` shared-index lever is **retained** as the
  ergonomic path for large multi-asset search-corpus tests where hand-seeding dozens of rows
  is noisier than one indexed fixture — but it is now an *optimization choice*, not a
  *purity ceiling*.

**Verdict:** Seam 3 FTS/vector purification is **feasible and in-scope** via the
`searchOnDb` extraction + `searchLocal({ db })` injection over a `:memory:` index DB. The
prior "full FTS purity out of scope" item in §7 is **struck** (see §7).

### Seam 4 — `StdinPort` (ambient, harness-scoped, code-guarded)

```ts
// src/core/io-port.ts  (leaf module — avoids any common.ts ↔ runtime.ts cycle, Reviewer 1 finding 4c)
export type StdinTextReader = () => string;                                  // sync — tryReadStdinText
export type StdinByteReader = (limit: number, onLimit: () => Error) => Promise<Buffer>; // async — readStdin
export interface StdinPort { isTty(): boolean; readText: StdinTextReader; readBytes: StdinByteReader; }

const realStdinPort: StdinPort = { /* process.stdin.isTTY, fs.readFileSync(0), existing readStdin body */ };
let activeStdinPort: StdinPort = realStdinPort;
export function getStdinPort(): StdinPort { return activeStdinPort; }
export function setStdinPort(port: Partial<StdinPort> | null): StdinPort {
  if (process.env.AKM_TEST_HARNESS !== "1") throw new Error("setStdinPort is test-only"); // Reviewer 1 finding 4b: code-enforced, not convention
  const prev = activeStdinPort;
  activeStdinPort = port ? { ...realStdinPort, ...port } : realStdinPort;              // 4a: override only the member you need
  return prev;
}
export function resetStdinPort(): void { activeStdinPort = realStdinPort; }
```

`readStdin` (`runtime.ts:173`) and `tryReadStdinText` (`common.ts:362`) become thin delegates to `getStdinPort()` — **signatures unchanged**. `runCliCapture` gains `opts?: { stdin?: string }`; `resetStdinPort()` joins `resetAllProcessState()` (`tests/_helpers/cli.ts`). The `Partial<StdinPort>` accept-and-merge means a sync-path test need not satisfy the async member (Reviewer 1 finding 4a). This is the *only* ambient slot, it is **production-immutable by code guard**, reset between harness runs, and safe under the inter-process parallel model.

### Seam 5 — Time (minimal scalars + reuse existing `EventsContext`; NO `Clock` interface)

**Reviewer 1 finding 3 (major), Reviewer 2 findings 3-4 (blocker + major), and Reviewer 3's clock finding are all accepted.** There is **no new `Clock` interface**. Time is virtualized at three sites with the minimal seam each needs, reusing existing seams where they exist:

- **improve bookends:** inject `now?: () => number` on `AkmImproveOptions` (a plain scalar, identical to `client.ts`'s existing `now`). It feeds **only** the duration-telemetry bookends (`improve.ts:1366,1864,1893` + maintenance bookends `:4985,5003,5009,5049`). **Scope is documented:** the other ~20 `Date.now()` sites (verified 25 total; budget-remaining/window math) stay on real wall-clock, and `FakeClock`-style tests **must not assert on budget math** (Reviewer 3 finding). No correlated-time hazard because the bookends are pure telemetry.

- **events wall-clock — reuse the EXISTING `ctx.now`, don't add a second clock (Reviewer 2 finding 4, major; verified).** `EventsContext.now` + `resolveNow(ctx)` already exist (`events.ts:157,199`) but `tailEvents` bypasses them with direct `Date.now()` (`:392,:431`). Fix: route `startedAt` and the `maxDurationMs` cutoff through `resolveNow(ctx)`. No new time concept.

- **events DB — reuse `ctx.db`, seeded as a `:memory:` state.db (Reviewer 2 finding 3, blocker; verified).** `tailEvents.tick()` calls `readEvents()`, which **always** does `openStateDatabase(dbPath)` (`events.ts:299`, where `dbPath = resolveDbPath(ctx)`) and ignores the already-existing `EventsContext.db` pre-opened handle. Fix: thread `ctx.db` into `readEvents` (use the handle when provided; fall back to `openStateDatabase` otherwise) — exactly mirroring how `appendEvent` already honors `ctx.db` (`:221`). A pure events unit test builds **`ctx.db = openStateDatabase(":memory:")`** and injects it plus **`ctx.now`**; that, not a `Clock`, is what makes events zero-I/O.

  **`:memory:` is the right handle here, and it's already proven for state.db.** `openStateDatabase(dbPath?)` (`state-db.ts:111`) runs `runMigrations(db)` on open (`:123`), so a fresh `openStateDatabase(":memory:")` has the full `events` schema (migration `001-initial-schema`, `state-db.ts:144`) and every later migration applied — no hand-built DDL. The repo already does exactly this ~16× in `tests/extract-session-tracking.test.ts` (`openStateDatabase(":memory:")`), so events seed via the **real `appendEvent`** and read via the **real `readStateEvents`/`readEvents`** — same zero-query-drift property as Seam 2. The runtime purity guard's `isInMemorySqlitePath(":memory:") === true` lets these opens through while still throwing on an un-seamed `readEvents()` that defaults to the real `getStateDbPath()`.

- **events poll timer:** inject the timer pair as optional params (mirroring `improve.ts:951`'s `setTimeoutFn` convention): `TailOptions.setIntervalFn?` / `clearIntervalFn?` defaulting to the globals. **`setInterval` is kept** — no self-rescheduling rewrite. Reviewer 3's finding that the rewrite is an un-back-compat production behavior change on a hot path is accepted; injecting the existing `setInterval`/`clearInterval` lets a fake drive cadence without changing the polling model, preserving the immediate-first-tick (`:447`) and the `AbortSignal` finish path (`:400`) untouched.

**`fetchWithRetry` backoff sleep ownership (Reviewer 3 minor):** the `sleep?: (ms)=>Promise<void>` scalar lane owns `common.ts` backoff (matching `client.ts`'s existing `sleep`). A comment in `common.ts` records that backoff sleeps are intentionally **not** part of any unified time abstraction, and Seam 5 will not re-touch `common.ts`. The existing `client.ts` `now`/`sleep` and `improve.ts:951` `setTimeoutFn` scalars are **left in place** — no consolidation.

---

## 4. Incremental migration sequence + the real `--parallel>1` gate

Every production change is a **trailing optional param/field defaulting to real**, so each step ships independently with no public signature change and `bun run check` green.

**Step 0 — parameterize the CI knob (Reviewer 3 finding 1, blocker; verified) + land the ratchet scaffold.** The `--parallel>1` gate as originally written was **inert**: `run-test-shard.sh:79` hardcodes `bun test --parallel=1` and the workflows call the script directly (`ci.yml:75`, `release.yml:61,79`, `release-gates.yml:37`) — the `package.json` `${TEST_PARALLEL:-1}` default never reaches CI. Step 0:
  - Edit `run-test-shard.sh:79` to `bun test --parallel="${SHARD_PARALLEL:-1}" …` so a real knob exists.
  - Add `scripts/lint-tests-unit-purity.ts` pre-seeded with **today's** offenders + the `baseline === live size` meta-test; promote `INTEGRATION_ROOTS` to a shared constant.
  - *Blast radius:* `run-test-shard.sh`, lint scripts, `package.json`; **zero production code**; suite green. This is acceptable to land before Step 1 *only because Step 1 lands in the same PR series* (Reviewer 1 finding 5) so the ratchet is exercised immediately; otherwise the purity lint is deferred to Step 1 and seeded with the *remaining* offenders.

**Step 1 — Seam 1 (+1b): `HttpClient` + `RegistryCache`.** Highest leverage. Add `HttpClient` to `common.ts`; widen `chatCompletionAttempt`'s param to the internal type and thread `options?.fetch`; add `RemoteEmbedderDeps`; **thread `deps` through the `embed()` facade**; export `l2Normalize`; **consolidate the two `withRegistryCacheDb` copies** then build the `RegistryCache` default + in-memory adapters; thread `deps` into `loadIndex`. Rewrite ~17 test files: pure-fn tests call scorers/parsers directly; transport tests inject `HttpClient` + in-memory `RegistryCache`, deleting `Bun.serve`. Add `clearEmbeddingCache`/`resetLocalEmbedder` to `resetAllProcessState`. *Collapses ~26 `Bun.serve`. Biggest unblocker.*

**Step 2 — Seam 2: `GetAllEntries` over `:memory:` on improve.** Add `entry-reader.ts` with `sqliteGetAllEntries()` + `inMemoryGetAllEntries(db)`; add `seedEntries` that opens `openDatabase(":memory:")` and seeds via real `upsertEntry`; replace `improve.ts:662-664` with `getAllEntries(...)` (default `sqliteGetAllEntries()` using the **same `openExistingDatabase` path**). **No `filterEntries`, no parity test.** Migrate ~20 improve tests off `akmIndex({full:true})` onto seeded `:memory:` rows. *Kills ~20 FTS rebuilds.*

**Step 3 — Seam 3: `searchOnDb` extraction + `:memory:` search.** Export `searchDatabase` as `searchOnDb(db, input)` (it is already acquisition-free); add `db?: Database` to `searchLocal`'s input bag (skip `ensureIndex`/open/close when supplied). Migrate the search/scoring/curate cluster to seed a `:memory:` index DB (real `rebuildFts` + real `searchFts`/`searchVec`). Keep the `beforeAll` shared real index only for large-corpus ergonomics and for tests whose subject is `ensureIndex` staleness or the file lock (those stay thin-integration).

**Step 4 — Seam 4: `StdinPort`.** Add `io-port.ts` slot + guarded `setStdinPort` + delegates; `runCliCapture({ stdin })`; `resetStdinPort()` in `resetAllProcessState`. Migrate stdin spawns (`secret`, `remember-frontmatter`, `capture-cli`, `env create`) to `runCliCapture`. Relocate inherent-subprocess tests (`env run`/`secret run`) to `tests/integration/`.

**Step 5 — Seam 5: time.** Add `now?` to `AkmImproveOptions`; route `tailEvents` through `resolveNow(ctx)`; thread `ctx.db` into `readEvents`; add `setIntervalFn?`/`clearIntervalFn?` to `TailOptions`. Replace real sleeps in `events.test.ts`, `improve-budget-watchdog.test.ts`, `improve-reflect-unsupported-type-skip.test.ts` with injected fakes; fix `setTimeout(r,0)` yields → `await Promise.resolve()`.

**Step 6 — drain + flip.** As Steps 1-5 land, `UNIT_PURITY_BASELINE` drains to 0; in parallel drive `lint-tests-isolation.ts` ratchet **64 → ~5** via `withIsolatedAkmStorage`/`makeStashDir`.

### The `--parallel>1` gate (corrected, real, reversible)

1. **Inter-process only (Reviewer 2 finding 9).** The flip is `SHARD_PARALLEL>1` **across separate Bun shard processes**, never in-process concurrency. This is what keeps every module global — stdin slot, `embedCache`, `_localEmbedder`, the registry factory map — safe. In-process concurrency stays at 1 **forever**; this invariant is documented in `run-test-shard.sh` and the purity lint header.
2. **Gate condition:** `UNIT_PURITY_BASELINE === 0` **AND** an opt-in CI job running `SHARD_PARALLEL=4` for **20 runs** shows **0** `RACE_SIGNATURE` retries in `run-test-shard.sh`.
3. **Flip = change the default in `run-test-shard.sh`** (the symbol CI actually executes), not `package.json`. **Reversible instantly** by resetting `SHARD_PARALLEL` env/default. The epoll retry wrapper is **retained as defence-in-depth** after the flip.

---

## 5. Lint guardrails + isolation-ratchet target

Modeled on the proven `lint-runtime-boundary.ts` / `lint-tests-isolation.ts` (comment/string-stripped regex, shrink-only allowlist, self-policing meta-test).

1. **`scripts/lint-tests-unit-purity.ts` (NEW).** Static rules: `real-spawn` (`spawnSync`/`Bun.spawn`/`child_process` import), `real-serve` (`Bun.serve`), `full-index-in-test-body` (`akmIndex({full:true})` inside a `test`/`it` callback, **not** `beforeAll`). Shrink-only `UNIT_PURITY_BASELINE`; meta-test asserts `baseline === live size`.

2. **Runtime purity guard (Reviewer 2 finding 10 accepted — static grep cannot catch facade/open-below-seam I/O).** The static lint is **necessary but not sufficient**: a test calling `embed()` (real fetch via facade), `searchLocal()` (real `ensureIndex`+open), or `tailEvents()` without `ctx.db` opens real DBs/sockets that no regex sees. So the unit tier installs a **`beforeAll` guard** that intercepts `openDatabase`/`openStateDatabase`/`openExistingDatabase`/`globalThis.fetch` and **throws on real-resource opens only**.

   **REVISED — the guard must NOT throw on `:memory:` opens.** The `:memory:` adapter (Seam 2; and Seam 3 / events / graph below) *is* the sanctioned pure path: it runs the real SQL with zero fd/disk. A guard that threw on every `openDatabase` would forbid the very mechanism this design adopts. The guard therefore **discriminates by the resolved path**, throwing only when a real file or socket would be acquired:

   > ⚠️ **SUPERSEDED by §8.3.** The original form below allowed `file:`/`mode=memory`/`file::memory:` URI branches — an adversarial review proved those are a guard HOLE: bun:sqlite's default constructor (`storage/database.ts:119`, no URI flags) opens `file::memory:?cache=shared` as a REAL on-disk file literally named that string, so the guard would certify a real-file open as pure. The corrected guard is `p === ":memory:"` EXACTLY, intercepted at the storage boundary `openDatabase(path)`. See §8.3. The block below is kept only to show what was rejected and why.

   ```ts
   // tests/_helpers/purity-guard.ts — SUPERSEDED, see §8.3 for the corrected form
   function isInMemorySqlitePath(p: string | undefined): boolean {
     if (p === undefined) return false;                 // undefined ⇒ resolves to getDbPath()/getStateDbPath() ⇒ REAL file ⇒ throw
     if (p === ":memory:") return true;                 // canonical anonymous in-memory DB — the ONLY honored form (§8.3)
     // ✗ REJECTED (§8.3): bun:sqlite (no URI flags) opens these as REAL files named the literal string:
     //   if (p.startsWith("file:") && /[?&]mode=memory(\b|&)/.test(p)) return true;
     //   if (p.startsWith("file::memory:")) return true;
     return false;                                      // any real filesystem path ⇒ throw
   }
   ```

   The guard wraps the three openers in `src/indexer/db/db.ts` / `src/core/state-db.ts` (patched at the module boundary, or via a `process.env.AKM_TEST_PURITY=1`-gated branch the openers consult) so that:
   - `openDatabase(":memory:")`, `openStateDatabase(":memory:")` → **pass through to the real opener** (full `ensureSchema` / `runMigrations` run in memory).
   - `openDatabase()` / `openExistingDatabase()` / `openStateDatabase()` with **no arg** → the path resolves to `getDbPath()` / `getStateDbPath()` (a real file under the data dir) → `isInMemorySqlitePath(undefined) === false` → **throw `UNIT_IMPURE_DB_OPEN`**. This is the key case: an un-seamed call that *defaults* to the real DB is exactly what must fail.
   - `openExistingDatabase(realPath)` (e.g. `searchLocal`'s `db-search.ts:198` when un-seamed) → real path → **throw**.
   - `globalThis.fetch` → unconditionally throw (no in-memory analogue; HTTP purity is Seam 1's injected `HttpClient`, never a real socket).

   The discriminator keys off the **resolved** path string the opener already computes (`resolvedPath = dbPath ?? getDbPath()` at `db.ts:72,121`; `dbPath ?? getStateDbPath()` at `state-db.ts:112`), so it sees the post-default value and cannot be fooled by an omitted argument. Any residual real-file/socket I/O fails loudly instead of silently passing the ratchet and getting promoted to the parallel tier; in-memory opens — the whole point of this revision — are explicitly allowed. (This throwing patch is a *guard*, never the injection mechanism — see §2.)

3. **Boundary partition fixed FIRST (Reviewer 3 finding, major; verified).** `tests/commands` and `tests/workflows` are double-run in **both** `test:unit` (`package.json:60`, via `--path-ignore-patterns=tests/integration`) **and** `test:integration` (`:61`). A coarse `INTEGRATION_ROOTS` directory match is therefore ambiguous. Resolution: the unit-purity lint operates on the **unit glob** (`tests` minus `tests/integration`) with an **explicit per-file allowlist** for the genuinely spawn-shaped command tests — not a directory exemption. Step 4 physically relocates `env run`/`secret run` into `tests/integration/`. The exact unit/integration boundary is pinned in Step 0 before any lint references it.

4. **Extend `lint-tests-isolation.ts`:** forbid new `fs.readFileSync(0)`/`process.stdin` reads outside `runtime.ts` + `io-port.ts` + `common.ts`; forbid new real-sleep (`new Promise(r=>setTimeout(r,…))`) in the unit tier. Drive `ALLOWLIST_RATCHET_BASELINE` **64 → ~5**.

The two ratchets stay **separate counters** (unit-purity vs isolation) — different hazards, different timelines.

---

## 6. Anti-pattern verification table (every finding → resolution)

| Review | Finding (severity) | Resolution in final design |
|---|---|---|
| R1-1 | EntryReader interface in speculative `repositories/` (minor) | **Accepted.** Demoted to `GetAllEntries` **function type** in `src/indexer/db/entry-reader.ts` next to `dbGetAllEntries`; no new namespace; matches `collectEligibleRefsFn` convention. |
| R1-2 | `RegistryCacheStore` over-mirrors SQLite row (minor) | **Accepted.** Port trimmed to `get(key,ttlMs)`/`upsert(key,json)`; etag/lastModified live in the default adapter only. |
| R1-3 | `Clock` 3-method interface forces tailEvents rewrite (**major**) | **Accepted.** No `Clock` interface. improve gets scalar `now?`; events reuses `ctx.now` + injects `setIntervalFn`/`clearIntervalFn`; `setInterval` **kept**, no rewrite. |
| R1-4 | StdinPort ambient slot (minor) | **Accepted.** Split into `Partial<StdinPort>` accept-merge (override one member); `setStdinPort` **code-guarded** by `AKM_TEST_HARNESS`; homed in leaf `io-port.ts`. |
| R1-5 | Step-0 ratchet is speculative if it predates seams (minor) | **Accepted.** Ratchet lands in the same PR series as Step 1 (or is deferred to Step 1 and seeded with remaining offenders). Meta-test verified non-flaky during churn. |
| R2-1 | embed() facade un-injectable + module-global cache (**blocker**) | **Accepted.** `deps` threaded through `embed`/`embedBatch`; `clearEmbeddingCache`+`resetLocalEmbedder` in `resetAllProcessState`; caches listed as process-isolation-mandating globals. |
| R2-2 | searchLocal seam below `ensureIndex`/`open` (**blocker**) | **Accepted, then SUPERSEDED by the `:memory:` revision.** The real fix is not "drop the purity claim" but extract the already-handle-injectable `searchDatabase` as `searchOnDb(db,…)` and inject `searchLocal({ db: openDatabase(":memory:") })`, skipping `ensureIndex`+open. Real FTS5+sqlite-vec run pure on `:memory:` (verified). Full FTS purity is now IN scope. |
| R2-3 | tailEvents opens state.db per tick; Clock removes only timer (**blocker**) | **Accepted.** Thread existing `ctx.db` into `readEvents`; pure events test injects `ctx.db`+`ctx.now`. |
| R2-4 | duplicate clock — `ctx.now` exists, ignored (**major**) | **Accepted.** Reuse `resolveNow(ctx)` for `startedAt`/cutoff; add only the timer. No second clock. |
| R2-5 | fetch on internal bag but `chatCompletionAttempt` takes public type (**major**) | **Accepted.** Widen `chatCompletionAttempt(options)` to `ChatCompletionInternalOptions`; thread `options?.fetch`. |
| R2-6 | provider fetch terminates at factory, not `loadIndex`; `withRegistryCacheDb` duplicated (**major**) | **Accepted.** `deps` threaded into `loadIndex` (both providers); two `withRegistryCacheDb` copies consolidated into one exported helper before wrapping. |
| R2-7 | default adapter uses `withIndexDb` ≠ prod `openExistingDatabase` (minor) | **Accepted.** Default `sqliteGetAllEntries` uses the **same** `openExistingDatabase()` path; byte-for-byte claim now holds — and the in-memory adapter calls the **same `getAllEntries`** symbol, so parity is structural, not asserted. |
| R2-8 | parity test misses seedEntries-vs-parseEntryRows decode drift (minor) | **OBSOLETED by the `:memory:` revision.** No `filterEntries` reimplementation exists, so there is no drift to test; seed via real `upsertEntry`, read via real `getAllEntries→parseEntryRows`. Parity test deleted. |
| R2-9 | parallel-safety leans on TEST_PARALLEL=1; other globals unlisted (minor) | **Accepted.** Stated plainly: flip is **inter-process only**; in-process stays 1 forever; `embedCache`/`_localEmbedder`/registry factory map added to the global-isolation list. |
| R2-10 | lint greps can't catch open/fetch-via-facade (minor) | **Accepted.** Added throwing `beforeAll` runtime guard on `openDatabase`/`openStateDatabase`/`openExistingDatabase`/`globalThis.fetch` in the unit tier. |
| R3-1 | `--parallel>1` gate knob never reaches CI (**blocker**) | **Accepted.** Step 0 parameterizes `run-test-shard.sh:79` with `${SHARD_PARALLEL:-1}`; flip = change that default; gate is now real and reversible. |
| R3-2 | `withRegistryCacheDb` not a single shared symbol (**major**) | **Accepted.** Explicit consolidation pre-step in Step 1 (same as R2-6). |
| R3-3 | chatCompletionAttempt param type (minor) | **Accepted** (same as R2-5). |
| R3-4 | improve has 25 `Date.now()`; partial virtualization (**major**) | **Accepted.** `now?` scoped to telemetry bookends; documented that budget/window math stays real and FakeClock tests must not assert on it. |
| R3-5 | INTEGRATION_ROOTS collides with double-run commands/workflows (**major**) | **Accepted.** Lint operates on the unit glob with a per-file allowlist; spawn-shaped command tests relocated to `tests/integration/`; boundary pinned in Step 0. |
| R3-6 | two backoff-sleep lanes without an owner (minor) | **Accepted.** `fetchWithRetry` owns `sleep` scalar; comment records backoff is not unified-time; Seam 5 won't re-touch `common.ts`. |
| R3-7 | tailEvents setInterval→setTimeout is a prod behavior change (minor) | **Accepted.** `setInterval` kept; inject existing `setInterval`/`clearInterval`; no polling-model change. |

---

## 7. Risks + explicit out-of-scope

**`:memory:` adapter coverage — graph DBs (and the full DB inventory).** The same
`:memory:` lever covers **every** SQLite opener in AKM, because all three go through the
storage boundary `openDatabase(path)` (`src/storage/database.ts:119` → `new
BunDatabase(path)`), which passes `:memory:` straight to `bun:sqlite`:
- **index.db** — `openDatabase(":memory:")` / `openExistingDatabase` (Seam 2 + Seam 3). Full
  `ensureSchema`, incl. the graph tables (`graph_files`, `graph_file_entities`,
  `graph_file_relations`, `graph_meta`, `graph_extraction_queue`) which are created by the
  same `ensureSchema` block (`db.ts:412-501`). Graph **reads/writes** in the `graph`
  command (`graph.ts:557,598` `openDatabase(getDbPath())`) and `graph-boost` thus run pure
  against a seeded `:memory:` index DB — the graph extraction *LLM* call is separate (Seam 1
  `HttpClient`), but the graph **persistence + boost-scoring** logic is purifiable here.
  Wiring mirrors Seam 2/3: thread an optional `db?: Database` into the graph command's
  open sites (or call the lower `openDatabase`-free helpers with a seeded handle).
- **state.db** — `openStateDatabase(":memory:")` (Seam 5 events). Full `runMigrations`.
- There is **one** other family worth noting: any ad-hoc opener that hard-codes
  `openDatabase()`/`openStateDatabase()` with no arg defaults to the real data-dir file and
  will trip the runtime purity guard — which is the desired signal to add a `db?` seam there
  too.

**Residual risks (carried, with mitigations):**
- ~~**`filterEntries` semantic drift** vs `db.ts` SQL~~ **ELIMINATED.** The `:memory:`
  adapter removed `filterEntries` entirely; both adapters call the same `getAllEntries` SQL,
  so there is no second query implementation and no drift surface. The decode-parity test is
  deleted with it.
- **`RegistryCache` consolidation must preserve both `rethrowIfTestIsolationError` calls** — prove byte-equivalence of the merged `withRegistryCacheDb` before wrapping, or a leaky test gets a silent cold cache.
- **`ctx.db` threading into `readEvents`** must keep the `rethrowIfTestIsolationError` catch and the existing empty-result fallback when no DB exists.
- **AbortSignal/timeout mapping** (`client.ts:351`) — retain the injected-`HttpClient` `AbortError` test.
- **Runtime purity guard false-positives** — the throwing `beforeAll` patch must be scoped to the unit tier only and reset in `afterAll`, or it breaks integration tests sharing a process.
- **`embedCache`/`_localEmbedder` reset ordering** — confirm `clearEmbeddingCache`/`resetLocalEmbedder` run on every `resetAllProcessState`, not only per `runCliCapture`.

**Explicit out-of-scope (deferred, not silently dropped):**
- ~~**Full FTS/vector search purity**~~ **NOW IN SCOPE (struck).** Superseded by the
  `:memory:` revision: `searchFts`/`searchVec`/ranking run pure against a `:memory:` index
  DB via the `searchOnDb` extraction + `searchLocal({ db })` injection (revised Seam 3). The
  only residually-integration search cases are those whose subject *is* `ensureIndex`
  staleness or the DB file lock — those stay thin-integration by nature, not by punt.
- **Consolidating the existing scalar time seams** (`client.ts` `now`/`sleep`, `improve.ts:951` `setTimeoutFn`) into any unified type — left as-is by design.
- **Virtualizing improve's non-bookend `Date.now()` sites** (budget/window math) — stays on real wall-clock.
- **In-process (`--parallel>1` within one Bun process) concurrency** — permanently out of scope; parallelism is inter-process sharding only.
- **A `src/storage/repositories/` namespace** — not created; revisit only when a genuine second repository exists.
- **Subprocess-inherent tests** (`env run`/`secret run` grandchild boundary, git/tar/docker installers, file-lock, website crawl, build-index pagination) — remain real-process thin-integration; never de-socketed.

**Definition of done:** `bun run check` (lint + custom lints + `tsc --noEmit` + `test:unit` + `test:integration`) shows **0 errors / 0 warnings / 0 failures** at every step before commit, per the repo clean-commit rule.

**Relevant files** — source map `/home/founder3/code/github/itlackey/akm/docs/technical/test-io-seam-map.md`; touched: `src/core/common.ts`, `src/core/io-port.ts` (new), `src/llm/client.ts`, `src/llm/embedder.ts`, `src/llm/embedders/remote.ts`, `src/registry/providers/{types,static-index,skills-sh}.ts`, `src/registry/providers/cache-db.ts` (new), `src/commands/improve/improve.ts`, `src/indexer/db/entry-reader.ts` (new), `src/indexer/search/db-search.ts`, `src/core/events.ts`, `src/runtime.ts`, `tests/_helpers/cli.ts`, `tests/_helpers/seed-entries.ts` (new), `scripts/lint-tests-isolation.ts`, `scripts/lint-tests-unit-purity.ts` (new), `scripts/run-test-shard.sh`, `package.json`.

## 8. Addendum — `:memory:` adapter resolution + prioritized code-quality sweep (#664 follow-up, FINAL hardened merge)

This addendum supersedes any earlier draft of §8. It (a) **locks in** the corrected `:memory:`-SQLite revision for Seam 2/3 and the runtime purity guard — with the empirically-grounded correctness caveats two adversarial reviewers raised (the `file:`-URI guard hole, the config-rewrite-on-open side effect, schema/dim/FTS/temp-store parity) — and (b) folds the wide+deep code-quality sweep into a **deduped, severity-ranked** list of *new* design issues, **re-ranked so the severity column tracks impact on the #664 goal (unblock `--parallel>1`), not the size of the code smell**, and **explicitly partitioned into "do-now (unblocks testability)" vs "deferred, owner-gated"**.

Both reviewers verified the citations against source and I re-verified the two load-bearing correctness findings myself at HEAD (db.ts:72-90, sqlite-pragmas.ts:146-176, config.ts:163-330): they are real and they change the canonical text below. Where a reviewer was right, the text is corrected, not defended.

### 8.1 `:memory:` resolution — corrected canonical facts (the load-bearing truth)

The earlier "zero disk / zero I/O / pure" framing was an **overclaim** and is retracted. The accurate, race-relevant invariant — the one the whole `--parallel>1` thesis actually depends on — is narrower:

> **`openDatabase(":memory:")` opens with no persistent SQLite file descriptor, no `-wal`/`-shm` sidecar files, and `journal_mode` degraded to `memory` (verified: steady-state fd delta = 0).** This — *not* "zero syscalls" — is what avoids the persistent-fd-churn / `epoll_ctl EEXIST` race under sharding.

What is true and load-bearing (verified Bun 1.3.14, db.ts:71-95):

- **`openDatabase(":memory:")` runs `ensureSchema` unconditionally (db.ts:90).** The DDL **structure** is path-independent: full index schema in memory — `entries`+indexes+`derived_from`, `entries_fts` (FTS5 `MATCH`+`bm25()` work), `embeddings`, `entries_vec` (sqlite-vec `dlopen`s, `isVecAvailable===true`, native KNN runs in-memory), all graph tables (db.ts:412-501), `utility_scores`, registry-cache.
- **`openStateDatabase(":memory:")` runs the full `runMigrations` chain (state-db.ts:123)** → full `events`/proposal/workflow schema in memory. Already used ~16× in `tests/extract-session-tracking.test.ts`.
- **`openExistingDatabase(":memory:")` does NOT run schema** → the in-memory adapter must seed through `openDatabase`, never `openExistingDatabase`.
- The storage boundary `openDatabase(path)` (storage/database.ts:119) passes the string straight to `new BunDatabase(path)` with **no URI flags**.

**Correctness caveats that MUST be enforced for `:memory:` to be a faithful prod analogue** (each is a reviewer finding, each is now a harness requirement, not a footnote):

| Caveat | Root cause (verified) | Required enforcement |
|---|---|---|
| **Schema STRUCTURE is path-independent, but embedding DIMENSION is NOT.** | db.ts:89 `resolvedDim = options?.embeddingDim ?? resolveConfiguredEmbeddingDim()` → reads the operator's on-disk `config.json` `embedding.dimension` (clamped 1..4096, db.ts:107-118). A dev with `dimension:768` gets a `:memory:` `entries_vec` sized differently than CI's 384 → a vec test seeding 384-dim BLOBs mismatches the vec0 column width **host-config-dependently**. This is the user's own "verify EFFECTIVE config" footgun. | `seedEntries()` / the `:memory:` test path **always** passes `openDatabase(":memory:", { embeddingDimension: EMBEDDING_DIM })` (default 384). Schema becomes host-config-independent and matches the seeded BLOB width. |
| **Opening a `:memory:` DB reads — and can REWRITE + banner-print — the operator's real config.** | db.ts:89 → `resolveConfiguredEmbeddingDim()` → `loadConfig()` → `loadUserConfig` → `maybeAutoMigrateConfigFile` (config.ts:165,285) **atomically rewrites `~/.config/akm/config.json` and prints a banner to stdout+stderr** unless `AKM_NO_AUTO_MIGRATE=1` (config.ts:300). So "open an in-memory DB" can mutate real user state and pollute captured output. | Two-layer fix: (1) **always pass `embeddingDimension` explicitly** (above) so `loadConfig()` is never reached on the `:memory:` path; (2) the unit harness sets **`AKM_NO_AUTO_MIGRATE=1`** so any stray config read can never rewrite disk or emit a banner. |
| **FTS5/vec scoring can spill to file-backed temp btrees the guard cannot see.** | `applyStandardPragmas` (sqlite-pragmas.ts:146-176) sets `journal_mode`/`busy_timeout`/`foreign_keys`/`synchronous` but **never `temp_store`**. SQLite's default still permits file-backed temp btrees for large sorts/joins (vec0 KNN, FTS bm25 ordering). Small fixtures don't spill; large seeded corpora can. | Add **`PRAGMA temp_store = MEMORY`** in the unit harness (or unconditionally in `applyStandardPragmas` — see §8.5). The runtime guard only intercepts opener *entry points*, never SQLite-internal temp files, so `temp_store=MEMORY` is the *mechanism*, the guard is not. |
| **Residual real I/O exists on every `:memory:` open** (one-shot, non-fd-churning): `statfs('.')` (network-FS probe, because `path.dirname(":memory:")==='.'`, db.ts:73,79), `dlopen` of `vec0.so`. | sqlite-pragmas.ts:152-154 + db.ts:82. | **Accepted, documented, non-blocking.** Both are one-shot and do not churn persistent fds, so neither feeds the epoll race. §8.5 re-words §7 from "zero disk" to the accurate fd/-wal-shm invariant. Optional hardening: pass a benign/`undefined` `dataDir` for `:memory:` to skip the `statfs` probe (meaningless for an in-memory DB). |

**Seam 2 canonical form (unchanged in shape, corrected in seeding):** `inMemoryGetAllEntries(db)` + `sqliteGetAllEntries()` both terminate in the **real `getAllEntries(db,…)` SQL**; seed via **real `upsertEntry`**. No `filterEntries`, no decode-parity test (deleted at the root, R2-8 obsoleted). `seedEntries(...)` opens via `openDatabase(":memory:", { embeddingDimension: EMBEDDING_DIM })` and returns `{ db, getAllEntries }`.

### 8.2 Seam 3 verdict — search purification via `:memory:`: **IN SCOPE, lifted, with one hard prerequisite**

**FEASIBLE — the prior "out of scope" punt is LIFTED.** The scoring core (`searchDatabase(db,…)` db-search.ts:244, `searchFts`/`searchVec`/`getAllEntries`) is **already handle-injectable**; only the `ensureIndex(stashDir)`+`openExistingDatabase(getDbPath())` preamble (db-search.ts:186,198) is impure.

Fix: export `searchDatabase` as `searchOnDb(db, input)`; add `db?: Database` to `searchLocal` (skip the ensureIndex/open and gate the `finally` close at db-search.ts:238 on "we opened it"). Real FTS5+sqlite-vec run on `:memory:` (per §8.1 caveats — explicit dim, `temp_store=MEMORY`). Vector tests seed `embeddings` BLOBs directly (embedder stays Seam 1); FTS-only tests need no embeddings.

**One hard prerequisite, not deferrable:** Seam 3 threads `db` but **NOT** the ambient ranking inputs. `search-cli.ts:100-102` **mutates `process.env.AKM_DISABLE_PROJECT_CONTEXT`** mid-flight (set-once-never-reset) and `db-search.ts:392,417` **reads it + `process.cwd()`** → two identical searches return different ranks by cwd, and the env write leaks into every later in-process search. **This is issue E.** Seam 3 is only sound if E ships *with* it: thread `disableProjectContext`/`disableScopedUtility`/`cwd`/`scopeKey` into the same `searchOnDb`/`searchLocal` options bag that already carries `db?`, resolved **once** at the search-cli edge, and **delete both the `process.env` read and write**. Doing Seam 3's `db?` and E's options-bag together is one edit, not two.

**Verdict: Seam 3 in Step 3, bundled with E (and L — `show`/`curate`, see §8.4).**

### 8.3 Runtime purity guard — corrected canonical form

The guard is the linchpin: every sweep fix below either (i) adds a `db?`/`fetch?`/`now?`/`env?` seam whose **default still resolves to the real resource** — so an un-migrated call site post-fix *defaults to real* and **trips the guard** (the intended ratchet: "add a seam here") — or (ii) adds a reset preventing a leaked global from surviving into the next in-process test.

Two corrections from the reviewers, both adopted:

1. **Restrict `isInMemorySqlitePath` to EXACTLY the bare `:memory:` token. DELETE the `file:`/`mode=memory`/`file::memory:` branches (design doc lines 354-355).** Empirically, `new Database('file:name?mode=memory&cache=shared')` and `new Database('file::memory:?cache=shared')` under bun:sqlite's default constructor (which storage/database.ts:119 uses, **no URI flags**) create **real on-disk files literally named those strings** — they are NOT in-memory. The current regex returns `true` for them, so the guard would **certify a real-file open as pure** and let it race under `--parallel`. That is a guard that *licenses* the exact thing it exists to catch. Only `p === ":memory:"` is honored as in-memory by the driver the boundary actually uses.

   ```ts
   function isInMemorySqlitePath(p: string | undefined): boolean {
     return p === ":memory:"; // the ONLY form new BunDatabase(path) opens in-memory (no URI flags enabled)
   }

2. **Pin the intercept point at the storage boundary `openDatabase(path)` (storage/database.ts:119), not the higher-level optional argument.** This resolves the doc's own inconsistency (it claimed both "keys off the resolved path the opener computes" *and* `isInMemorySqlitePath(undefined)===false`). At the storage boundary the value is always the **final string handed to the driver** — `dbPath ?? getDbPath()` has already resolved, so `:memory:` is seen verbatim and a no-arg default-to-real open is seen as a real path → throw `UNIT_IMPURE_DB_OPEN`. The discriminator then runs on exactly what bun:sqlite receives, which (combined with correction 1) closes the URI hole.

`globalThis.fetch` throws unconditionally (un-seamed network = always impure). `:memory:` opens pass through.

**One guard-integrity dependency (issue C):** a swallowed `TEST_ISOLATION_MISSING` blinds the guard. `loadStoredGraphMeta`/`loadStoredGraphSnapshot` have an **inner `catch { return null }`** (graph-db.ts:504-506,616-618) nested *inside* the outer catch that *does* call `rethrowIfTestIsolationError` (graph-db.ts:508+) — so the inner swallow eats an isolation error before the guard sees it. **C ships in the SAME PR as the guard (Step 2)**, not later: first line of both inner catches becomes `rethrowIfTestIsolationError(err)`, then `null` only for absent / a typed `GraphSnapshotCorruptError` for present-but-corrupt.

### 8.4 NEW design issues — deduped, severity = impact-on-#664-goal, do-now vs deferred

**Re-ranking rationale (Reviewer 2, accepted):** severity now means *"impact on unblocking `--parallel>1`"*, not *"size of the smell"*. The XL god-function extractions were previously mis-ranked HIGH; the addendum's own §8.3/Step-7 text admits they have "no bearing on the parallel flip." They are **demoted to MED, marked DEFERRED**. HIGH is reserved for the flip's critical path (E, F-minimum) plus guard-integrity (C). The cheap, near-zero-risk, flake-killing reset/sort items (A, G, H, I, B) are explicitly tiered **DO-NOW** even at MED, because they kill order-dependent unit flakes that exist *today at `--parallel=1`*.

Dedup applied (~50 raw findings → patterns): "open real DB inline where `:memory:` suffices" → **(D)**; "reads `process.env`/`cwd` deep in logic" → **(E)**; "un-reset module-global latch/cache/singleton" → **(A)**; "unsorted readdir feeds capped selection" → **(G)**; "bare catch → null/[] without isolation rethrow" → **(F-catch)**; god-functions → **(C-extract)**. Removed as already-in-design: `embed()` facade (=R2-1), `searchLocal` preamble (=Seam 3), `tailEvents` per-tick open (=R2-3), improve bookend `now` (=Seam 5), `config?: AkmConfig` convention.

| # | Sev (vs #664) | Track | Issue (pattern) | Representative loc | Pattern fix | Effort |
|---|---|---|---|---|---|---|
| **E** | **HIGH** | **DO-NOW (gate precondition)** | search **mutates `process.env.AKM_DISABLE_PROJECT_CONTEXT`** mid-flight; ranking reads it + `process.cwd()`/workflow-scope ambiently | write `search-cli.ts:100-102`; read `db-search.ts:392,417`→`scope-key.ts:12` | Thread `disableProjectContext`/`disableScopedUtility`/`cwd`/`scopeKey` into the `searchLocal`/`searchOnDb` bag, resolved ONCE at the CLI edge. **Delete the env write+read.** Scorer becomes pure-of-inputs → parallel-safe. | M |
| **F-min** | **HIGH** | **DO-NOW (gate precondition, MINIMAL form only)** | `getDbPath`/`getCacheDir`/`getDefaultStashDir` take **no `env` param** unlike their `getDataDir`/`getConfigDir` siblings → unreachable injection seam; root of the `improve.ts:1131` "snapshot env before first await" race (#553/#554/#499) | `paths.ts:139-190,308-323`; `common.ts:164-186` | **Minimal:** thread `env: NodeJS.ProcessEnv = process.env` through the `getDbPath`/`getCacheDir`/`getDefaultStashDir` family (sibling pattern, already endorsed). Retires the snapshot dance. **The "Paths value object threaded into ~78 call sites" form is DROPPED — see note below.** | M |
| **C** | **HIGH** | **DO-NOW (ships with guard, Step 2)** | graph inner `catch { return null }` omits the isolation rethrow → **blinds the purity guard**; also conflates corrupt-vs-absent | `graph-db.ts:504-506,616-618` | `rethrowIfTestIsolationError(err)` first; `null` for absent, typed `GraphSnapshotCorruptError` for corrupt. | M |
| **B** | **MED** | **DO-NOW** | `extractGraphForSingleFile` hardcodes `fs.readFileSync`, defeating its OWN injectable `db`/`llm`/`config` seams | `graph-extraction.ts:963,1145` | Add `opts.readFile?` (default `fs.readFileSync(p,'utf8')`) or accept pre-read `body?`. One param. | S |
| **A** | **MED** | **DO-NOW (high-ROI, fold into Step 2/3)** | LLM-usage **sink** global set/cleared without save-restore, NOT in `resetAllProcessState`; nested install nulls outer run's sink → next run's telemetry silently suppressed | `usage-telemetry.ts:57,79-86` | Stack-discipline install/dispose; add `clearLlmUsageSink()` to `resetAllProcessState`. | M |
| **G** | **MED** | **DO-NOW (high-ROI, one-time `.sort()` sweep)** | unsorted `readdir` feeds capped/truncated selection → OS-order-dependent, non-reproducible output | `consolidate.ts:3259`; `memory-contradiction-detect.ts:111-118,241-271`; `tasks.ts:371-387` | `fs.readdirSync(...).sort()` at each enumeration boundary (+sort families by `ref` before the capped pair loop). Pattern already applied at `dedup.ts:171`, `memory-improve.ts:770`. | S |
| **H** | **MED** | **DO-NOW (high-ROI reset wiring)** | un-reset warn-once / lazy-singleton globals beyond the embedder caches: sqlite-pragma warns, `pushOnCommitWarned`, `PROJECT_CONFIG_DEPRECATION_WARNED`, OpenCode SDK `_server`, indexer matcher/contributor arrays, `cachedConfig`, `loadGraphBoostContext` cache, local-embedder `HF_HOME` env write | `sqlite-pragmas.ts:41-42`; `write-source.ts:250`; `config.ts:568,125`; `sdk-runner.ts:49`; `indexer/init.ts:34`; `graph-boost.ts:88-114`; `local.ts:214` | One reset per global, all wired into `resetAllProcessState` (mirrors the shipped `clearEmbeddingCache`/`resetLocalEmbedder`). Move `HF_HOME` out of the read path into `LocalEmbedder` ctor config. | M (sum) |
| **I** | **MED** | **DO-NOW (small, unblocks Seam 1b `deps?`)** | eager registry-provider + indexer-matcher registration as IMPORT-TIME side effects into shared maps/arrays, no reset/idempotency | `static-index.ts:170`, `skills-sh.ts:294`; `indexer/init.ts:52-53`, `file-context.ts:202-204` | `registerBuiltinRegistryProviders()` invoked once at the registry entry point + `reset()` on the registry; make `registerBuiltinMatchers` idempotent (replace, not append) + `resetIndexerInit()`. | M |
| **N** | **MED** | **DEFERRED (separately-reviewed amendment to Seam 5)** | selection-window cutoffs read `Date.now()` directly — these gate **which refs are planned**, not budget math, so Seam 5's "stays real" carve-out is wrong for them | `improve.ts:1625,1658,2807,4555`; `consolidate.ts:3167`; `graph-extraction.ts:1040`; `reflect.ts:313` | Thread the existing `now?` down to selection cutoffs only. **Lands as its own PR with the FakeClock-fidelity guard re-reviewed** (threading `now?` into persisted `generatedAt` risks baking virtual time into asserted output — the exact hazard Seam 5's Reviewer 3 warned of). NOT a folded-in Step-5 edit. | M |
| **K** | **MED** | **DEFERRED (owner-gated, post-flip)** | `openDatabase` couples open→`loadConfig()`+migrate; `loadUserConfig` auto-rewrites config on read; no no-migrate state.db twin | `db.ts:71-118`; `config.ts:131-183,285-334` | CQS split: pass `embeddingDimension?` into `openDatabase` (delete inline `require(loadConfig)`); split `loadUserConfig` parse(query) vs `migrateConfigOnDisk()`(command); add `openExistingStateDatabase()`. **Note: the `embeddingDimension?` half of this is pulled FORWARD into §8.1 as a do-now harness requirement.** | L |
| **L** | **MED** | **DEFERRED-light (ride Step 3 if cheap)** | `show`/`curate` rebuild the index AND write events as a side effect of a READ; `ensureIndex` branches on ambient `AKM_CLI_ENTRY`+`argv[1]` | `show.ts:180-201`; `curate.ts:147`; `ensure-index.ts:239-273` | Add `ensureIndexFn?`+`eventSink?` to `akmShow` (mirror improve `improve.ts:343`); pass the spawn decision as `ensureIndex(stashDir,{allowBackgroundSpawn})` resolved at the CLI edge. | M |
| **M** | **MED** | **DEFERRED (owner-gated, post-flip)** | session-log + opencode readers fuse env/dir resolution + fs walk + parse, zero ctor params; opencode opens real `opencode.db` where `:memory:` runs the same SQL | `claude/session-log.ts:121-201`; `opencode/session-log.ts:49-205` | Ctor `{ baseDir?, fs? }` (mirror `CronExec`) + `db?: Database`; export pure `parseClaudeJsonlLines`/`mapOpencodeSessionRow`. | L |
| **D** | **MED** | **DEFERRED (owner-gated, post-flip — cron-critical)** | `runImprovePreparationStage` 1690-LOC god function, ~10 inline DB opens fused to pure decision branches | `improve.ts:2403-4093` | functional-core/imperative-shell: extract `selectSignalDeltaRefs`/`computeSalienceRankChanges`/`planExtractGate`; hoist the ~10 opens into ONE handle. | XL |
| **D2** | **MED** | **DEFERRED (owner-gated, post-flip)** | `indexEntries` fuses the pure `DirScanReason` classifier with the `db.transaction` write | `indexer.ts:570-951` | extract `classifyDir`/`planIndexEntries` (pure, 9-case table test); `indexEntries` = walk→plan→`db.transaction(apply)`. | L |
| **J** | **MED** | **DEFERRED (owner-gated, post-flip — cron-critical)** | `akmConsolidateInner` (1524) / `akmReflect` (742) / `akmDistill` (935) god functions, pure decision logic fused to LLM+fs+DB+stdin | `consolidate.ts:1349-2872`; `reflect.ts:946-1688`; `distill.ts:854-1789` | extract `buildConsolidationPlan`/`decideReflectOutcome`/`decideDistillOutcome` (pure); inject `chatCompletion`+`appendEvent`+`promptConfirm`; replace inline `setTimeout(r,2000)` with Seam 5 `sleep`. | XL (each) |
| **O** | **LOW** | **DEFERRED (opportunistic leaf fixes)** | `getOutputMode()` throws unless `initOutputMode()` ran; `resolveSecret`/`applyRuntimeEnvApiKeys` read env directly; `readLockfile` swallows corrupt→`[]`; `gh auth token` un-injectable | `output/context.ts:141`; `config.ts:467-559`; `lockfile.ts:72-85`; `github.ts:12-22` | default-to-pure (`getOutputMode`→`resolveOutputMode([])`); `env=process.env` param; ENOENT vs corrupt split; `GhExec` seam. | S each |

**Why F is HIGH-but-MINIMAL (the single most important scope correction):** The full F ("resolve a `Paths` value object `{dataDir,cacheDir,dbPath,stateDbPath,stashDir}` threaded into ~78 call sites", effort L) is **DROPPED**. It is (a) the exact bundled-container shape the base design explicitly rejected ("no `IoContext`/`RuntimeContext` god-object"), reimported under a new name; and (b) an L-effort wide-blast refactor that would over-couple the flip gate to a large structural change. The **minimal env-param threading through the three path functions** (sibling pattern, M effort) is what actually retires the snapshot race and what the gate needs. The `Paths` object is not adopted unless/until a concrete call site needs all five paths bundled.

### 8.5 Net change to the migration steps + the `--parallel>1` gate

Steps 0–6 (§4) keep their order. Three classes of change: (1) corrected guard/`:memory:` enforcement, (2) E + F-min promoted to gate preconditions, (3) the deferred-track split.

- **Step 0 (gate scaffold) — AMEND the gate condition.** It becomes:
  > `UNIT_PURITY_BASELINE === 0` **AND** issue **E** resolved (no production `process.env` mutation on the search hot path) **AND** issue **F-min** resolved (the `getDbPath`/`getCacheDir`/`getDefaultStashDir` family takes an injectable `env`, retiring the improve snapshot race) **AND** 0 `RACE_SIGNATURE` retries over 20 runs at `SHARD_PARALLEL=4`.

  **Rationale:** E and F-min are *production* `process.env`/`cwd` reads-and-writes on hot paths. Inter-process sharding does **not** save them — two tests in the **same** shard still race the single `process.env`/cwd, and the epoll retry wrapper would **mis-attribute and silently mask** that race as the signature crash. The measurement is unsound until they land. (Reviewer 2's narrowing accepted: only **E** and **F-min** are promoted — *not* F's `Paths`-object form, whose race is already mitigated today.)

- **Step 2 (Seam 2 `:memory:`) — ADD the corrected guard + C + the do-now resets.**
  - Guard: `isInMemorySqlitePath` = `p === ":memory:"` exactly (delete URI branches); wrap at the storage boundary `openDatabase(path)`.
  - `seedEntries()` opens `openDatabase(":memory:", { embeddingDimension: EMBEDDING_DIM })`; the unit harness exports `AKM_NO_AUTO_MIGRATE=1` and `PRAGMA temp_store=MEMORY` (set `temp_store` in the harness DB-open helper, or unconditionally in `applyStandardPragmas` — the latter is byte-safe since SQLite already defaults temp btrees and `MEMORY` only forbids file-backing).
  - **C** ships here (guard-integrity). The **(A)/(H)/(I)** reset wiring (`clearLlmUsageSink`, sqlite-pragma/config/graph-boost/SDK-server/matcher resets, registry composition fn) folds in alongside the harness-reset work already happening in this step. **B** and **G** (one-param + `.sort()`) ride whichever step touches their files — no separate lint rule for G (too heuristic).
  - *Added effort: M.*

- **Step 3 (Seam 3 search `:memory:`) — ADD E (mandatory, same options bag) + L (if cheap).** E is the same bag Seam 3 opens for `db?`; doing them together is one edit and E is a gate precondition so it cannot slip. L extends the `ensureIndexFn?`/`eventSink?` pattern to the `show`/`curate` cluster Seam 3's map omitted; include it if it falls out cheaply, otherwise it drops to the deferred track. *Added effort: M (+M for L).*

- **Step 5 (Seam 5 time) — NO change. Issue N is REMOVED from Step 5.** Reviewer 2 is right: N reopens a hardened, Reviewer-3-ratified scope boundary and threading `now?` into persisted `generatedAt` risks baking virtual time into asserted output. N lands as its **own later PR** with the FakeClock-fidelity guard re-reviewed — it is **not** a Step-5 carve-out edit. §7's out-of-scope bullet stays as written (budget/window math stays real); N is tracked as a candidate amendment, not a committed change.

- **NEW Step 7 (post-flip, owner-gated, SEPARATE proposal) — the god-function + reader decomposition track: D, D2, J, K, M, L (if not done in Step 3), plus N.** Reviewer 2 accepted: this track **rewrites the cron-critical files MEMORY records as repeatedly regressing live data** (`improve.ts` 5391 LOC, `consolidate.ts` 3447 LOC; #632/#635/#662), dwarfs Steps 0-6, and has **zero bearing on the parallel flip**. It is therefore **split out of the #664 design entirely** and gated on (a) the runtime purity guard already shipped (which forces every new `openDatabase()` to carry a `db?`) and (b) **explicit owner go-ahead per PR**. Order within Step 7: **I + F-min are already done in the do-now track**, so the registry/matcher composition fns and injectable paths exist before the (C-extract) pattern decompositions; each god function lands on its own PR with `bun run check` green. *Added effort: ~XL aggregate, parallelizable, not on the critical path.*

**Net sequence:** Steps 0–6 ship the parallelism unblock exactly as designed. The only schedule-critical additions are **E** and **F-min** (promoted to gate preconditions — without them the parallel-flip measurement is unsound and the retry wrapper would mask their race) and **C** (without it the guard is blind). The corrected guard (`:memory:` exact + storage-boundary intercept + explicit `embeddingDimension` + `AKM_NO_AUTO_MIGRATE=1` + `temp_store=MEMORY`) is what makes the `:memory:` opens *actually* fd-pure and host-config-independent rather than incidentally so. The XL god-function track (D/D2/J/K/M/N) is a separate, owner-gated, post-flip coverage-depth proposal that the now-active guard makes self-enforcing — it never blocks the flip and never touches cron-critical code under deadline pressure.

**Blocker/major resolution summary (every reviewer finding → disposition):**

| Reviewer finding | Sev | Resolution |
|---|---|---|
| R1: `file:`/`mode=memory` guard branches license real-file opens | major | **FIXED** — guard restricted to `p === ":memory:"` exactly; URI branches deleted (§8.3 correction 1, verified at design-doc lines 354-355 + bun:sqlite behavior). |
| R1: "zero disk" overclaim — `:memory:` open reads/rewrites real config.json + banner | major | **FIXED** — retracted overclaim; canonical invariant re-worded to "no persistent fd / no `-wal`-`shm` / journal=memory"; harness sets `AKM_NO_AUTO_MIGRATE=1` + always passes explicit `embeddingDimension` so `loadConfig()` is never reached (§8.1, verified config.ts:165,285,300). |
| R1: guard intercept point stated inconsistently (`undefined` vs resolved path) | minor | **FIXED** — pinned to the storage boundary `openDatabase(path)` where the final driver string is seen (§8.3 correction 2). |
| R1: residual `statfs`/`vec0.so dlopen` I/O on `:memory:` | minor | **ACCEPTED + documented as non-blocking** (one-shot, no fd churn); optional benign-`dataDir` hardening noted (§8.1 caveat table). |
| R1: `temp_store` never set → large FTS/vec fixtures spill file temp btrees | minor | **FIXED** — `PRAGMA temp_store=MEMORY` added to harness/`applyStandardPragmas` (§8.1, §8.5 Step 2). |
| R1: embedding dim fed to `:memory:` schema comes from ambient config | minor | **FIXED** — `seedEntries` always passes `embeddingDimension: EMBEDDING_DIM` (§8.1 caveat 1). |
| R2: severity inflation — D/D2/J ranked HIGH despite no flip impact | major | **FIXED** — re-ranked to MED + DEFERRED; severity column redefined as impact-on-#664 (§8.4 rationale). |
| R2: Step 7 is a rewrite track smuggled into a narrow unblock | major | **FIXED** — Step 7 split out of #664 entirely, owner-gated per-PR, off the critical path (§8.5 Step 7). |
| R2: E+F as hard gate preconditions over-couples the flip to an L refactor | major | **PARTIALLY ACCEPTED** — only **E** and **F-minimum** (env-param threading) promoted; the full F `Paths`-object form **dropped** (§8.4 F-note, §8.5 Step 0). |
| R2: F `Paths` value object = speculative generality / rejected container shape | minor | **FIXED** — dropped; minimal env-threading adopted (§8.4). |
| R2: G/H/I are highest-ROI do-now items buried below XL items | minor | **FIXED** — explicit DO-NOW vs DEFERRED track column; A/G/H/I/B tiered do-now (§8.4). |
| R2: preserve B and C against the deferral sweep | minor | **HONORED** — B = DO-NOW (S), C = DO-NOW ships with guard in Step 2 (§8.4). |
| R2: issue N reopens a ratified Seam-5 boundary | minor | **ACCEPTED** — N removed from Step 5; becomes its own later separately-reviewed PR; §7 out-of-scope bullet unchanged (§8.5 Step 5). |
| R2: `:memory:` feasibility conflated with in-scope-now for K/L/M | minor | **FIXED** — `:memory:` treated as a standing capability; K/L/M deferred/owner-gated (the `embeddingDimension?` half of K pulled forward only as a do-now harness requirement) (§8.4). |

The full hardened addendum text is the markdown fenced block above, intended as §8 of `/home/founder3/code/github/itlackey/akm/docs/technical/test-io-seam-design.md`. No file was written (per instructions). The guard correction additionally requires editing the existing design-doc lines 354-355 (delete the two URI branches) when this addendum is applied.
