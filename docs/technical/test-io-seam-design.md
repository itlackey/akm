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
| 2 | Improve entry read | `openExistingDatabase()` + `getAllEntries(db,…)` (`improve.ts:663-664`) | `GetAllEntries` function value |
| 3 | Search | `ensureIndex` + `openExistingDatabase` + `getEntryCount` **then** `getAllEntries` (`db-search.ts:186-278`) | `beforeAll` shared fixture (primary) + `GetAllEntries` (empty-query branch only) |
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

### Seam 2 — `GetAllEntries` (improve entry read; function value, not a repository)

**Demoted from interface-in-a-repository to a function value (Reviewer 1 finding 1 accepted).** No `src/storage/repositories/` directory. The type and both implementations live next to `dbGetAllEntries` in `src/indexer/db/`:

```ts
// src/indexer/db/entry-reader.ts
import type { DbIndexedEntry } from "./db";
export type GetAllEntries = (entryType?: string, excludeTypes?: string[]) => DbIndexedEntry[];

// Default — preserves the EXACT production open path (see parity note below).
export function sqliteGetAllEntries(): GetAllEntries {
  return (t, ex) => { const db = openExistingDatabase(); try { return getAllEntries(db, t, ex); } finally { db.close(); } };
}
// In-memory — shares the SAME filter as the SQL path.
export function inMemoryGetAllEntries(rows: DbIndexedEntry[]): GetAllEntries {
  return (t, ex) => filterEntries(rows, t, ex);
}
// Shared pure filter, used by both adapters.
export function filterEntries(rows: DbIndexedEntry[], entryType?: string, excludeTypes?: string[]): DbIndexedEntry[];
```

**Open-path parity (Reviewer 2 finding 7).** Production uses `openExistingDatabase()` (verified `improve.ts:663`), **not** `withIndexDb`. The default adapter therefore uses **`openExistingDatabase()` + `getAllEntries()` + close**, identical to today — preserving open mode, migration-on-open, lock acquisition, and the surrounding `rethrowIfTestIsolationError` catch. The "byte-for-byte unchanged" claim holds because the open path is the same symbol.

**Wiring:** `AkmImproveOptions.getAllEntries?: GetAllEntries` (default `sqliteGetAllEntries()`) replaces the inline `db = openExistingDatabase(); getAllEntries(db, …)` at `improve.ts:662-664`, keeping the existing `.filter(isEntryInScope/isEntryInWritableSource)` chain. The coarse `collectEligibleRefsFn` (`improve.ts:297`) is **kept** — it is the outer seam returning final refs (tests nothing of the planner); `GetAllEntries` is the inner seam that feeds **real planner logic fake rows** so scope/writable/profile-prefilter/dedupe/proposed/belief filters all stay under test. `improve-multi-cycle.test.ts` (the sole `collectEligibleRefsFn` user) is untouched.

**Test seed helper** `tests/_helpers/seed-entries.ts`:

```ts
export function seedEntries(specs: Array<Partial<StashEntry> & { stashDir?: string; filePath?: string }>): DbIndexedEntry[];
export function seedEntriesInto(db: Database, specs: ...): void; // wraps real upsertEntry
```

**Decode-parity test (Reviewer 2 finding 8 accepted).** The parity test must catch `seedEntries`-vs-`parseEntryRows` drift, not just WHERE-clause drift. It round-trips `seedEntries(spec)` through the **real** `upsertEntry → getAllEntries → parseEntryRows` path (`seedEntriesInto` a real in-memory DB) and asserts the materialized `DbIndexedEntry` **deep-equals** the `inMemoryGetAllEntries` row for the same spec — covering the derived/scope/quality/beliefState fields the downstream filters read.

### Seam 3 — search (fixture-first; `GetAllEntries` only narrows the empty-query branch)

**The purity claim is corrected (Reviewer 2 finding 2, blocker; verified).** `searchLocal` runs `await ensureIndex(stashDir)` (`db-search.ts:186`, can rebuild FTS), then `getDbPath()` + `openExistingDatabase` (`:198`) + `getEntryCount` (`:200`) — **all real I/O** — *before* control reaches the `!hasSearchableTokens` branch where `getAllEntries(db,…)` lives (`:278`). Injecting `getAllEntries` there does **not** make a search test pure.

Resolution: **Seam 3's primary lever is a `beforeAll` shared real index** (`tests/fixtures/stashes/load.ts`) — one index build per file instead of per test — for the FTS/vector-dependent search/scoring/curate cluster. These tests stay in the **thin integration tier** (search *is* an index-shaped subject). Injecting `getAllEntries?: GetAllEntries` into `searchLocal` is retained **only** to purify the empty-query enumeration branch, and the design **documents** that it reduces no I/O on the `ensureIndex`/`open` path. Full FTS purity (seaming `ensureIndex` + the DB open at `:198`) is **out of scope** (§7).

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

- **events DB — reuse `ctx.db`, the real purity lever (Reviewer 2 finding 3, blocker; verified).** `tailEvents.tick()` calls `readEvents()`, which **always** does `openStateDatabase(dbPath)` (`events.ts:299`) and ignores the already-existing `EventsContext.db` pre-opened handle. Fix: thread `ctx.db` into `readEvents` (use the handle when provided; fall back to `openStateDatabase` otherwise) — exactly mirroring how `appendEvent` already honors `ctx.db` (`:221`). A pure events unit test injects **`ctx.db` (an in-memory state.db) + `ctx.now`**; that, not a `Clock`, is what makes events zero-I/O.

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

**Step 2 — Seam 2: `GetAllEntries` on improve.** Add `entry-reader.ts` + `inMemoryGetAllEntries` + `seedEntries`; replace `improve.ts:662-664` with `getAllEntries(...)` (default `sqliteGetAllEntries()` using the **same `openExistingDatabase` path**); add the decode-parity test. Migrate ~20 improve tests off `akmIndex({full:true})`. *Kills ~20 FTS rebuilds.*

**Step 3 — Seam 3: search fixtures (+ empty-query `GetAllEntries`).** Convert the search/scoring/curate cluster to a single `beforeAll` real index; add `searchLocal({ getAllEntries })` for the empty-query branch only (documented as no I/O reduction). These remain thin-integration.

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

2. **Runtime purity guard (Reviewer 2 finding 10 accepted — static grep cannot catch facade/open-below-seam I/O).** The static lint is **necessary but not sufficient**: a test calling `embed()` (real fetch via facade), `searchLocal()` (real `ensureIndex`+open), or `tailEvents()` without `ctx.db` opens real DBs/sockets that no regex sees. So the unit tier installs a **`beforeAll` guard** that monkeypatches `openDatabase`/`openStateDatabase`/`openExistingDatabase`/`globalThis.fetch` to **throw**. Any residual real I/O fails loudly instead of silently passing the ratchet and getting promoted to the parallel tier. (This throwing patch is a *guard*, never the injection mechanism — see §2.)

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
| R2-2 | searchLocal seam below `ensureIndex`/`open` (**blocker**) | **Accepted.** Purity claim dropped; Seam 3 is `beforeAll` fixture-first; `GetAllEntries` retained only for empty-query branch, documented as no I/O reduction. |
| R2-3 | tailEvents opens state.db per tick; Clock removes only timer (**blocker**) | **Accepted.** Thread existing `ctx.db` into `readEvents`; pure events test injects `ctx.db`+`ctx.now`. |
| R2-4 | duplicate clock — `ctx.now` exists, ignored (**major**) | **Accepted.** Reuse `resolveNow(ctx)` for `startedAt`/cutoff; add only the timer. No second clock. |
| R2-5 | fetch on internal bag but `chatCompletionAttempt` takes public type (**major**) | **Accepted.** Widen `chatCompletionAttempt(options)` to `ChatCompletionInternalOptions`; thread `options?.fetch`. |
| R2-6 | provider fetch terminates at factory, not `loadIndex`; `withRegistryCacheDb` duplicated (**major**) | **Accepted.** `deps` threaded into `loadIndex` (both providers); two `withRegistryCacheDb` copies consolidated into one exported helper before wrapping. |
| R2-7 | default adapter uses `withIndexDb` ≠ prod `openExistingDatabase` (minor) | **Accepted.** Default `sqliteGetAllEntries` uses the **same** `openExistingDatabase()` path; byte-for-byte claim now holds. |
| R2-8 | parity test misses seedEntries-vs-parseEntryRows decode drift (minor) | **Accepted.** Parity test round-trips through real `upsertEntry→getAllEntries→parseEntryRows` and deep-equals the in-memory row. |
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

**Residual risks (carried, with mitigations):**
- **`filterEntries` semantic drift** vs `db.ts` SQL (`entryType!=='any'` exact match; `excludeTypes` only on untyped path). *Mitigation:* single shared `filterEntries` used by both adapters + the decode-parity round-trip test.
- **`RegistryCache` consolidation must preserve both `rethrowIfTestIsolationError` calls** — prove byte-equivalence of the merged `withRegistryCacheDb` before wrapping, or a leaky test gets a silent cold cache.
- **`ctx.db` threading into `readEvents`** must keep the `rethrowIfTestIsolationError` catch and the existing empty-result fallback when no DB exists.
- **AbortSignal/timeout mapping** (`client.ts:351`) — retain the injected-`HttpClient` `AbortError` test.
- **Runtime purity guard false-positives** — the throwing `beforeAll` patch must be scoped to the unit tier only and reset in `afterAll`, or it breaks integration tests sharing a process.
- **`embedCache`/`_localEmbedder` reset ordering** — confirm `clearEmbeddingCache`/`resetLocalEmbedder` run on every `resetAllProcessState`, not only per `runCliCapture`.

**Explicit out-of-scope (deferred, not silently dropped):**
- **Full FTS/vector search purity** — seaming `ensureIndex` + the DB open at `db-search.ts:198` so `searchFts`/`searchVec` run in-memory. Seam 3 only narrows the empty-query branch; FTS-dependent search tests stay thin-integration.
- **Consolidating the existing scalar time seams** (`client.ts` `now`/`sleep`, `improve.ts:951` `setTimeoutFn`) into any unified type — left as-is by design.
- **Virtualizing improve's non-bookend `Date.now()` sites** (budget/window math) — stays on real wall-clock.
- **In-process (`--parallel>1` within one Bun process) concurrency** — permanently out of scope; parallelism is inter-process sharding only.
- **A `src/storage/repositories/` namespace** — not created; revisit only when a genuine second repository exists.
- **Subprocess-inherent tests** (`env run`/`secret run` grandchild boundary, git/tar/docker installers, file-lock, website crawl, build-index pagination) — remain real-process thin-integration; never de-socketed.

**Definition of done:** `bun run check` (lint + custom lints + `tsc --noEmit` + `test:unit` + `test:integration`) shows **0 errors / 0 warnings / 0 failures** at every step before commit, per the repo clean-commit rule.

**Relevant files** — source map `/home/founder3/code/github/itlackey/akm/docs/technical/test-io-seam-map.md`; touched: `src/core/common.ts`, `src/core/io-port.ts` (new), `src/llm/client.ts`, `src/llm/embedder.ts`, `src/llm/embedders/remote.ts`, `src/registry/providers/{types,static-index,skills-sh}.ts`, `src/registry/providers/cache-db.ts` (new), `src/commands/improve/improve.ts`, `src/indexer/db/entry-reader.ts` (new), `src/indexer/search/db-search.ts`, `src/core/events.ts`, `src/runtime.ts`, `tests/_helpers/cli.ts`, `tests/_helpers/seed-entries.ts` (new), `scripts/lint-tests-isolation.ts`, `scripts/lint-tests-unit-purity.ts` (new), `scripts/run-test-shard.sh`, `package.json`.
