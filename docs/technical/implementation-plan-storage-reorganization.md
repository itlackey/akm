# Implementation Plan: Storage Reorganization

**Status:** Draft — ready for implementation agent  
**Source teams:** A (SQLite migration), B (XDG directory reorganization), C (event/metric gaps)  
**Supersedes:** `docs/technical/storage-locations.md` (will be updated in Phase 5)

---

## 1. Final Directory Structure

After this reorganization, akm uses four base directories instead of two:

| Variable  | Default (Linux/macOS)         | Windows                  | Env override        |
|-----------|-------------------------------|--------------------------|---------------------|
| `$CONFIG` | `~/.config/akm`               | `%APPDATA%\akm`          | `AKM_CONFIG_DIR`    |
| `$CACHE`  | `~/.cache/akm`                | `%LOCALAPPDATA%\akm`     | `AKM_CACHE_DIR`     |
| `$DATA`   | `~/.local/share/akm`          | `%LOCALAPPDATA%\akm\data`| `AKM_DATA_DIR`      |
| `$STATE`  | `~/.local/state/akm`          | `%LOCALAPPDATA%\akm\state`| `AKM_STATE_DIR`    |
| `$STASH`  | `~/akm`                       | `%USERPROFILE%\Documents\akm` | `AKM_STASH_DIR` |

### Rationale for $DATA vs $CACHE vs $STATE

- `$CACHE` — **truly regenerable data only**: registry index files, website mirrors, LLM enrichment cache, ripgrep binary. Losing this costs time, not data.
- `$DATA` — **durable non-regenerable application data**: SQLite databases (index.db, workflow.db, state.db), config-backups, akm.lock. Losing this loses history and work.
- `$STATE` — **runtime state and log-like files**: akm.lock.lck, task history JSONL. Persists across reboots but is less precious than $DATA.

### Windows fallback

On Windows, `$DATA` maps to `%LOCALAPPDATA%\akm\data` and `$STATE` maps to `%LOCALAPPDATA%\akm\state`, keeping all akm data under one parent for easy uninstall.

---

## 2. Reconciled Storage Map

### SQLite Databases (all move to $DATA)

| File | Old location | New location | Notes |
|------|-------------|--------------|-------|
| `index.db` | `$CACHE/index.db` | `$DATA/index.db` | Gains `registry_index_cache` table (Team A) |
| `workflow.db` | `$CACHE/workflow.db` | `$DATA/workflow.db` | No schema change |
| `state.db` | (new) | `$DATA/state.db` | New: holds `events`, `proposals`, `task_history` tables |

### JSONL / Log files (move to $STATE)

| File | Old location | New location | Notes |
|------|-------------|--------------|-------|
| `tasks/history/<id>.jsonl` | `$CACHE/tasks/history/` | `$STATE/tasks/history/` | No format change |

### Files remaining in $CACHE (regenerable only)

| Path | Reason still in $CACHE |
|------|------------------------|
| `registry-index/<slug>.json` | TTL-cached, regenerable |
| `registry/<src>/<id>/` | Downloaded packages, regenerable |
| `registry-index/website-<hash>/` | Scraped content cache |
| `registry-build/` | Temp workspace |
| `semantic-status.json` | Auto-regenerated on index |
| `tasks/logs/<id>/` | Stdout/stderr logs only |
| `bin/rg` | Auto-downloaded binary |

### Files remaining in $CONFIG (unchanged)

| Path | Notes |
|------|-------|
| `config.json` | User config |
| `akm.lock` | Installed stash lockfile — moves to $DATA per Team B; see migration section |

> **Note on akm.lock:** Team B proposed moving `akm.lock` to `$DATA`. This is correct per XDG semantics (it is application-managed state, not a cache). However it requires updating all lockfile consumers. This is tracked as part of Phase 3.

### Files remaining in $STASH (unchanged)

Proposals, consolidate-journal, graph.json, improve.lock, archive files, memory files — all stay under `$STASH/.akm/` and `$STASH/` subdirectories as documented in storage-locations.md. Team A proposed moving proposals to `state.db`; see deferred items section.

---

## 3. state.db Schema (new database in $DATA)

```sql
-- events table: replaces events.jsonl for durable indexed queries
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  ts         TEXT NOT NULL,              -- ISO-8601
  event_type TEXT NOT NULL,
  ref        TEXT,                       -- asset ref or NULL
  metadata   TEXT,                       -- JSON blob or NULL
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_ref     ON events(ref);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);

-- task_history table: replaces tasks/history/<id>.jsonl
CREATE TABLE IF NOT EXISTS task_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL,
  status      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  log         TEXT,
  target      TEXT,
  detail      TEXT                       -- JSON blob for extra fields
);
CREATE INDEX IF NOT EXISTS idx_task_history_task ON task_history(task_id);
```

> **Deferred from state.db:** The `proposals` table (Team A HIGH item) is deferred to a later phase because proposals currently live in `$STASH/.akm/proposals/` and are tied to git-committable stash state. Moving them to a user-level DB would break multi-machine stash workflows. See Section 8 (Deferred Items).

---

## 4. registry_index_cache Table (added to index.db in $DATA)

```sql
CREATE TABLE IF NOT EXISTS registry_index_cache (
  slug       TEXT PRIMARY KEY,           -- same slug as current filename
  body_json  TEXT NOT NULL,              -- raw registry index JSON
  fetched_at TEXT NOT NULL,              -- ISO-8601
  fresh_until TEXT NOT NULL,             -- ISO-8601; used for TTL check
  stale_until TEXT NOT NULL              -- ISO-8601; used for stale-fallback
);
```

This replaces `$CACHE/registry-index/<slug>.json` files.

---

## 5. Team C Event Routing

All new events from Team C go to the `events` table in `state.db` (via `appendEventToDb()` helper). Additionally, `select` and `improve_skipped` events go to `usage_events` in `index.db` via `insertUsageEvent()`.

| New event type | events table (state.db) | usage_events (index.db) |
|---------------|------------------------|------------------------|
| `select` | YES | YES (event_type='select') |
| `improve_skipped` | YES | NO |
| `reflect_completed` | YES | NO |
| extended `search` metadata (mode field) | existing row extended | existing row extended |

### Event specifications

**`select` event** (Gap 1 — HIGH):
- Trigger: `akm show <ref>` executes within 60 seconds after `akm search` returned that ref in its hits.
- Detection: in `logShowEvent()` (show.ts), read the most recent `search` event from state.db; if `ref` appears in `metadata.resultRefs` and `Date.now() - searchTs < 60_000`, emit `select`.
- `metadata`: `{ query: string, searchTs: string }`
- `usage_events` write: `insertUsageEvent(db, { event_type: 'select', entry_ref: ref, entry_id: ..., metadata: JSON.stringify({ query }) })`

**`improve_skipped` event** (Gap 3 — HIGH):
- Trigger: any cooldown guard in `akmImprove()` (improve.ts) that currently calls `console.error(...)` and `continue`.
- Emitted by `appendEvent()` instead of (or in addition to) `console.error`.
- `metadata`: `{ ref: string, reason: string, cooldownDays: number, lastEventTs: string }`
- Affected sites: reflect cooldown (line ~648), distill cooldown (line ~703), consolidation cooldown (line ~821), budget exhaustion (line ~604).

**`reflect_completed` event** (Gap 4 — HIGH):
- Trigger: immediately after `createProposal()` succeeds in `reflect.ts` (line 284).
- `ref`: the asset ref being reflected.
- `metadata`: `{ proposalId: string, source: 'reflect', agentProfile: string }`

**Extended `search` metadata — mode field** (Gap 5 — MEDIUM):
- In `logSearchEvent()` (search.ts), add `mode: 'semantic' | 'keyword'` to the metadata JSON based on whether embedding-based ranking was used.
- Requires `searchLocal()` in `db-search.ts` to return a `mode` field in its result.

**`getZeroResultSearches()` fix** (Gap 2 — HIGH):
- Already implemented correctly in `src/indexer/db.ts` at line 1413. The function queries `usage_events` with `json_extract(metadata, '$.resultCount') = 0`. No further code change needed.
- The `search_events` legacy table referenced in docs is never created by the current schema — it was a documentation artifact. No action needed there.

---

## 6. Implementation Phases (dependency order)

### Phase 1 — Path Resolution Foundation

**Goal:** Add `getDataDir()` and `getStateDir()` to `src/core/paths.ts`. No existing callers change yet.

**Files to change:**

`src/core/paths.ts`:
- Add `getDataDir(env?, platform?)` following the same pattern as `getCacheDir()`.
  - Override: `env.AKM_DATA_DIR?.trim()`
  - Linux/macOS: `path.join(env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share'), 'akm')`
  - Windows: `path.join(localAppData, 'akm', 'data')`
- Add `getStateDir(env?, platform?)`:
  - Override: `env.AKM_STATE_DIR?.trim()`
  - Linux/macOS: `path.join(env.XDG_STATE_HOME?.trim() || path.join(home, '.local', 'state'), 'akm')`
  - Windows: `path.join(localAppData, 'akm', 'state')`
- Add `getStateDbPath()`: returns `path.join(getDataDir(), 'state.db')`
- Add `getTaskHistoryDir_v2()`: returns `path.join(getStateDir(), 'tasks', 'history')`
- Update `getDbPath()`: returns `path.join(getDataDir(), 'index.db')`
- Update `getWorkflowDbPath()`: returns `path.join(getDataDir(), 'workflow.db')`
- Keep all old functions returning $CACHE paths as deprecated aliases (for one release cycle).

**No other files change in Phase 1.**

---

### Phase 2 — akm.lock Move to $DATA

**Goal:** Move `akm.lock` (and its write-lock sentinel `akm.lock.lck`) from `$CONFIG` to `$DATA`.

**Current situation:** `akm.lock` is written/read by `src/core/lock.ts` (or similar) using `getConfigDir()`. The write-lock sentinel `akm.lock.lck` lives in `$CONFIG`.

**Files to change:**
- `src/core/paths.ts`: Add `getLockfilePath()` returning `path.join(getDataDir(), 'akm.lock')` and `getLockfileLockPath()` returning `path.join(getDataDir(), 'akm.lock.lck')`.
- All files that currently call `getConfigDir()` and append `akm.lock` — update to call the new helpers.

**Search for callers:**
```
grep -r "akm.lock" src/ --include="*.ts" -l
```

---

### Phase 3 — state.db Creation and Event Writes

**Goal:** Create `state.db` in `$DATA`. Write all events exclusively to the `events` table in `state.db`.

**Files to change:**

`src/core/state-db.ts` (new file):
- `openStateDb()`: opens/creates `$DATA/state.db` in WAL mode with busy_timeout=5000. Creates `events` and `task_history` tables if they don't exist.
- `appendEventToStateDb(db, input)`: inserts a row into `events` table.
- `closeStateDb(db)`: closes the connection.

`src/core/events.ts`:
- `appendEvent()`: write exclusively to the `events` table in state.db via `appendEventToStateDb()`. Remove any JSONL write path.

`src/indexer/db.ts`:
- `getZeroResultSearches()`: already correctly queries `usage_events`. Verify `metadata` JSON from `logSearchEvent()` in search.ts always includes `resultCount`. **No change needed** — confirmed at line 1413.

---

### Phase 4 — Team C Event Gaps

**Goal:** Emit the four new event types. All use `appendEvent()` (which writes exclusively to state.db after Phase 3).

#### Gap 1: `select` event

**File:** `src/commands/show.ts`

In `logShowEvent()` (line 226), after the existing `appendEvent({ eventType: 'show', ... })` call, add:

```typescript
// Emit 'select' if this show follows a recent search that returned this ref.
try {
  const { events: recentSearches } = readStateEvents(db, { type: 'search' });
  const cutoff = Date.now() - 60_000; // 60-second window
  const matchingSearch = recentSearches
    .slice()
    .reverse()
    .find(e => {
      if (!e.ts || new Date(e.ts).getTime() < cutoff) return false;
      const refs = (e.metadata?.resultRefs as string[] | undefined) ?? [];
      return refs.includes(ref);
    });
  if (matchingSearch) {
    appendEvent({
      eventType: 'select',
      ref,
      metadata: { query: matchingSearch.metadata?.query as string, searchTs: matchingSearch.ts },
    });
    // Also write to usage_events for utility score pipeline.
    const db2 = existingDb ?? openExistingDatabase();
    try {
      insertUsageEvent(db2, {
        event_type: 'select',
        entry_ref: ref,
        entry_id: findEntryIdByRef(db2, ref),
        metadata: JSON.stringify({ query: matchingSearch.metadata?.query }),
      });
    } finally {
      if (!existingDb) closeDatabase(db2);
    }
  }
} catch { /* fire-and-forget */ }
```

#### Gap 3: `improve_skipped` event

**File:** `src/commands/improve.ts`

At each of the four cooldown `continue` sites (lines ~648, ~703, ~821, budget exhaustion ~604), replace or augment the `console.error(...)` call with:

```typescript
appendEvent({
  eventType: 'improve_skipped',
  ref: planned.ref,
  metadata: {
    reason: '<reason string>',
    cooldownDays: effectiveCooldownDays,
    lastEventTs: lastReflect?.ts ?? null,
  },
});
console.error(`[improve] ... (reflect cooldown)`); // keep for operator visibility
```

For the budget exhaustion site, `ref` is undefined; omit the `ref` field and put the count in metadata.

#### Gap 4: `reflect_completed` event

**File:** `src/commands/reflect.ts`

After `createProposal()` succeeds (line 284), before the `return` statement:

```typescript
appendEvent({
  eventType: 'reflect_completed',
  ref: payload.ref,
  metadata: {
    proposalId: proposal.id,
    source: 'reflect',
    agentProfile: profile.name,
  },
});
```

Add `appendEvent` import if not already present — it is already imported at line 26.

#### Gap 5: search mode metadata

**File:** `src/indexer/db-search.ts`

Add `mode: 'semantic' | 'keyword'` to the return type of `searchLocal()`. Set `mode = 'semantic'` when embeddings were used for ranking (i.e., `embedMs` is defined and > 0), otherwise `mode = 'keyword'`.

**File:** `src/commands/search.ts`

In `logSearchEvent()`, change:
```typescript
metadata: { query, hitCount: stashHits.length, resultRefs: stashHits.map((h) => h.ref) }
```
to:
```typescript
metadata: {
  query,
  hitCount: stashHits.length,
  resultRefs: stashHits.map((h) => h.ref),
  mode: localResult?.mode ?? 'keyword',
}
```

Also add `mode` to the `insertUsageEvent` metadata JSON for the aggregate search event (the second `insertUsageEvent` call that includes `resultCount`).

---

### Phase 5 — registry_index_cache in index.db

**Goal:** Stop writing `$CACHE/registry-index/<slug>.json` files; serve from index.db instead.

**File:** `src/core/paths.ts`
- `getRegistryIndexCacheDir()` — keep for one release (read fallback), mark deprecated.

**File:** `src/indexer/db.ts`
- Add `registry_index_cache` table to `openDatabase()` schema (see Section 4 above).
- Add `getRegistryIndexEntry(db, slug)` and `upsertRegistryIndexEntry(db, slug, bodyJson, freshUntil, staleUntil)`.

**File:** wherever registry index files are currently written/read (search for `getRegistryIndexCacheDir()`)
- Write path: call `upsertRegistryIndexEntry()` instead of `fs.writeFileSync()`.
- Read path: try `getRegistryIndexEntry()` first; fall back to file-based cache for pre-migration installs.

---

### Phase 6 — task_history in state.db

**Goal:** Write new task history records to `task_history` table in `state.db`. Keep writing JSONL files for one release.

**File:** wherever task history JSONL files are written (search for `getTaskHistoryDir()` callers in `src/tasks/`):
- After writing the JSONL line, also insert into `task_history` table via `openStateDb()`.

**Read path** (e.g., `akm tasks history`):
- Read from `task_history` table when state.db exists; fall back to JSONL files.

---

### Phase 7 — e2e Test Harness Fix

**Goal:** Tests must set `XDG_DATA_HOME` and `XDG_STATE_HOME` in addition to the existing `XDG_CACHE_HOME` and `XDG_CONFIG_HOME` so all test-isolated storage lands in tmpdir.

**File:** `tests/e2e.test.ts`

Current `beforeAll` / `beforeEach` pattern (lines 143–164):

```typescript
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
let testCacheDir = "";
let testConfigDir = "";

beforeAll(async () => {
  testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-cache-"));
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-config-"));
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
});
```

Must become:

```typescript
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
let testCacheDir = "";
let testConfigDir = "";
let testDataDir = "";
let testStateDir = "";

beforeAll(async () => {
  testCacheDir  = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-cache-"));
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-config-"));
  testDataDir   = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-data-"));
  testStateDir  = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-state-"));
  process.env.XDG_CACHE_HOME  = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.XDG_DATA_HOME   = testDataDir;
  process.env.XDG_STATE_HOME  = testStateDir;
});
```

Apply the same expansion to:
- Every inline `scenarioCacheDir` / `perTestCache` block that sets `process.env.XDG_CACHE_HOME` — add matching `XDG_DATA_HOME` and `XDG_STATE_HOME` set to a fresh tmpdir.
- The `afterAll` teardown — restore `XDG_DATA_HOME` and `XDG_STATE_HOME` the same way `XDG_CACHE_HOME` is restored.
- The `runCli()` helper — its `env: { ...process.env }` already inherits from the process environment, so the `process.env` mutations above are sufficient. No change to `runCli` needed.

Apply the same fix to any other test files that set `XDG_CACHE_HOME` directly:

```
grep -rn "XDG_CACHE_HOME" tests/ --include="*.ts"
```

---

### Phase 8 — Documentation Update

**File:** `docs/technical/storage-locations.md`

- Add `$DATA` and `$STATE` to the Path Variables table.
- Move `index.db`, `workflow.db` entries to use `$DATA`.
- Move `tasks/history/` entries to use `$STATE`.
- Add `state.db` entry.
- Add new event types (`select`, `improve_skipped`, `reflect_completed`) to the events catalog table.
- Add `mode` field to the `search` event metadata notes.
- Update the Summary Index table.
- Mark `search_events` legacy table as "never created; use usage_events" with the correct query.

---

## 7. Migration Strategy for Existing Installations

A one-off migration script (`scripts/migrate-storage.ts`) handles migrating existing data for users who want it. New installs start clean. The script is available for download from the repository or as an AKM asset.

---

## 8. Deferred Items

The following Team A HIGH items are deferred with rationale:

| Item | Team A priority | Deferred reason |
|------|----------------|-----------------|
| `proposals/<uuid>/proposal.json` → `state.db` proposals table | HIGH | Proposals live in `$STASH/.akm/proposals/`, which is git-tracked alongside stash assets. Moving to a user-level DB breaks multi-machine stash workflows (clone to new machine, proposals disappear). Revisit when the proposal system has explicit sync support. |
| `belief-transitions.jsonl` → state.db | LOW | Observability only; no programmatic consumer reads this file. Cost of migration exceeds benefit. |
| `consolidate-journal.json` → state.db | LOW | Write-ahead journal that is deleted on success; lives in `$STASH`. Moving to a DB in `$DATA` would complicate crash recovery (WAJ needs to be co-located with the stash it guards). |
| `semantic-status.json` → state.db | LOW | Small JSON file, read once at startup, regenerated on demand. Not worth a DB table. |

---

## 9. File Change Summary

| File | Phase | Change type |
|------|-------|-------------|
| `src/core/paths.ts` | 1 | Add `getDataDir`, `getStateDir`, `getStateDbPath`; update `getDbPath`, `getWorkflowDbPath` |
| `src/core/paths.ts` | 2 | Add `getLockfilePath`, `getLockfileLockPath` |
| All lockfile consumers | 2 | Update to use new path helpers |
| `src/core/state-db.ts` | 3 | New file — state.db open/write helpers |
| `src/core/events.ts` | 3 | `appendEvent()` writes exclusively to state.db |
| `src/commands/show.ts` | 4 | Emit `select` event in `logShowEvent()` |
| `src/commands/improve.ts` | 4 | Emit `improve_skipped` at each cooldown site |
| `src/commands/reflect.ts` | 4 | Emit `reflect_completed` after `createProposal()` |
| `src/indexer/db-search.ts` | 4 | Return `mode` field from `searchLocal()` |
| `src/commands/search.ts` | 4 | Add `mode` to search event metadata |
| `src/core/events.ts` | 4 | Add `select`, `improve_skipped`, `reflect_completed` to `EventType` union |
| `src/indexer/db.ts` | 5 | Add `registry_index_cache` table; add read/write helpers |
| Registry index read/write callers | 5 | Switch to DB helpers; retain file fallback |
| Task history write sites | 6 | Write to `task_history` table |
| Task history read sites | 6 | Prefer `task_history` table; fall back to JSONL |
| `tests/e2e.test.ts` | 7 | Add `XDG_DATA_HOME` + `XDG_STATE_HOME` to all env isolation blocks |
| All other test files with `XDG_CACHE_HOME` | 7 | Same expansion |
| `docs/technical/storage-locations.md` | 8 | Full update to reflect new structure |

---

## 10. Acceptance Criteria

Phase 1:
- [ ] `getDataDir()` and `getStateDir()` exported from `src/core/paths.ts`
- [ ] `AKM_DATA_DIR` and `AKM_STATE_DIR` env overrides respected
- [ ] `getDbPath()` returns `$DATA/index.db`

Phase 2:
- [ ] `akm.lock` reads and writes from `$DATA/akm.lock`

Phase 3:
- [ ] `state.db` created in `$DATA` on first event write
- [ ] Every `appendEvent()` call inserts a row into `events` table in `state.db`
- [ ] Fresh install: `index.db` created in `$DATA` not `$CACHE`

Phase 4:
- [ ] `akm show <ref>` following `akm search` within 60s emits `select` event
- [ ] `select` event appears in `usage_events` table
- [ ] Cooldown skips in `akm improve` emit `improve_skipped` events
- [ ] `akm reflect` emits `reflect_completed` with `proposalId` after proposal creation
- [ ] `search` events include `mode: 'semantic' | 'keyword'` in metadata

Phase 5:
- [ ] Registry index data served from `registry_index_cache` table in `index.db`
- [ ] File-based cache still written for one release as fallback

Phase 6:
- [ ] Task history writes insert into `task_history` table in `state.db`
- [ ] `akm tasks history` reads from DB with JSONL fallback

Phase 7:
- [ ] All e2e tests set `XDG_DATA_HOME` and `XDG_STATE_HOME` to tmpdirs
- [ ] No test leaks data to `~/.local/share/akm` or `~/.local/state/akm`

Phase 8:
- [ ] `docs/technical/storage-locations.md` matches the actual storage layout
