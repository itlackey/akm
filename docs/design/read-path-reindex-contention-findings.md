# Read-path reindex contention — findings & fix state

> **Status:** Direction changed 2026-07-02 (owner decision): the read-triggered
> background reindex is the footgun; the real fix is **write-path indexing**
> (§7). §3-F1 (cooldown) is SUPERSEDED and will be deleted, not shipped.
> §3-F2 (telemetry busy timeout) stands.
> Branch: `fix/read-path-reindex-contention` (off main @ `78bada9a`, post-#682;
> does NOT include the R5 branch — separate concern).
> **Uncommitted changes exist on the working tree** — see §4 for exactly what
> is done and §5 for what remains before this can be committed/PR'd.

## 1. The reported issue (verified)

`akm search` / `akm curate` are slow (fresh queries >20s, timeouts at 35/60/90s)
because reads repeatedly trigger background reindex work, and those reindex jobs
contend on the same SQLite `index.db` that search/curate also touch.

## 2. Verification of each claim against the code

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1a | `searchLocal()` always calls `ensureIndex()` before searching | **Confirmed** | `src/indexer/search/db-search.ts` read path |
| 1b | `ensureIndex()` spawns a background reindex whenever stale-but-servable | **Confirmed** | `src/indexer/ensure-index.ts:239-265` (pre-fix). There IS a single-flight writer lease (`acquireIndexWriterLease`, try-mode) so only one background reindex runs at a time — but nothing stops the *next* read from spawning a new one the moment the previous finishes. |
| 1c | `seen-urls.txt` keeps the index stale | **Refuted** | The wiki asset spec uses `markdownSpec` → `isRelevantFile` accepts only `.md` (`src/core/asset/asset-spec.ts:36,139-144`), and `getIndexableFiles` applies that filter before the staleness check. A `.txt` state file can never trigger staleness. |
| 1d | Session memory files keep the index stale | **Confirmed — this is the real trigger** | `memories/opencode-session-*.md` is indexable and written continuously during active sessions. Every completed background reindex is followed by renewed staleness, so near-every read spawns another reindex. |
| 2 | Background reindexes collide with reads; 30s busy_timeout amplifies | **Confirmed** | `PRAGMA busy_timeout = 30000` (`src/storage/sqlite-pragmas.ts`). Under WAL, *readers* don't block — the stalls are on the read path's **synchronous telemetry writes** (below), which queue behind the reindex writer for up to 30s each. `database is locked` in `index-background.log` = writer-vs-writer contention (background indexer vs. read-path usage-event inserts, both directions). |
| 3 | Search telemetry is synchronous and blocks the command | **Confirmed** | `logSearchEvent` (`src/commands/read/search.ts:305-369`) does up to 52 `insertUsageEvent` writes + utility bumps through the synchronous `withIndexDb` (`src/storage/repositories/index-db.ts` — "intentionally synchronous"). Even `--source registry` writes a summary usage event to the local index.db. The reporter's `skipLogging: true` returning in ~2.7s is consistent. |
| 4 | curate amplifies: multiple searches + per-item show + its own event log | **Confirmed** | `searchForCuration` fallback tokens, `akmShowUnified` per item, `logCurateEvent` opens index.db directly (raw `openExistingDatabase`, 30s timeout). Each hop can independently stall behind the reindex writer. |
| 5 | Semantic/embedding is a secondary cost | **Agreed, deprioritized** | Background log shows "Embedding generation failed... Unable to connect" — the configured `localhost:1234` endpoint is down, adding noise/latency to *reindex* runs but failing fast. Not addressed in this fix. |

**Root cause in one sentence:** staleness-on-read + continuously-written session
memories = a background reindex per read; the reindex holds index.db write
locks; the reads' own synchronous usage-logging writes then wait up to 30s per
DB open on those locks; curate multiplies this by N searches + M shows + its
own log.

## 3. Fix design (three small changes, no new machinery)

**F1 — Cooldown on read-triggered background reindex** (`ensure-index.ts`).
A marker file (`<dataDir>/logs/index-background.last`) is touched on every
background spawn; while it is younger than `BACKGROUND_REINDEX_COOLDOWN_MS`
(5 min) AND the index can serve the stash, `ensureIndex()` in background mode
returns immediately — skipping even the staleness walk. Reads serve the
slightly-stale index; the improve cron / explicit `akm index` still refresh on
their own schedule. Blocking-mode callers (improve) are unaffected. Rejected
alternative: debouncing on mtime deltas — the session files change continuously,
so any mtime-based rule re-arms instantly.

**F2 — Telemetry writes get a 250ms busy timeout instead of 30s**
(`withIndexDb(fn, { busyTimeoutMs })` + `TELEMETRY_BUSY_TIMEOUT_MS = 250`).
Usage-event inserts are fire-and-forget hints (the indexer overwrites utility
scores on the next reindex anyway); under contention they should be *dropped*,
not waited on. Applied at: `logSearchEvent` (search.ts), the `show` usage-event
insert and graph-enqueue (show.ts), `logCurateEvent` and graph-enqueue
(curate.ts — also converted from a raw `openExistingDatabase` to the shared
`withIndexDb` helper). All sites already had fire-and-forget catch blocks, so a
busy-timeout expiry is silently skipped.

**F3 — (implicitly fixed by F1+F2)** curate's amplification: each of its N
searches now hits the cooldown fast-path instead of the staleness walk + spawn,
and each telemetry hop caps at 250ms instead of 30s.

Explicitly NOT done (with reasons):
- No async/queued telemetry — new machinery; the 250ms cap achieves the goal.
- No change to `busy_timeout` for real writers (indexer, feedback) — they should wait.
- No embedding-path changes — secondary issue; the endpoint being down is an
  environment problem (`semanticSearchMode: "auto"` fails open).
- No change to the #607 inline-rebuild-when-can't-serve behavior.

## 4. Implementation state — DONE (this branch)

Shipped on `fix/read-path-reindex-contention` (full gate green: biome+custom
lints 0/0, tsc clean, unit 4964/0, integration 1935/0):

- **F2** (telemetry 250ms busy timeout) as described in §3.
- **§7 write-path indexing**: `src/indexer/index-written-assets.ts`
  (`indexWrittenAssets`), wired into `writeMarkdownAsset`
  (`src/commands/read/knowledge.ts`) and extract's session-asset write
  (`src/commands/improve/extract.ts`).
- **§7 read-path subtraction**: `ensureIndex()` rewritten — background mode is
  serve-if-servable / inline-rebuild-if-not; blocking mode unchanged. Deleted:
  the per-read staleness walk, `spawnBackgroundReindex`, the writer-lease
  handoff (`handoffIndexWriterLeaseToPid`), the `AKM_CLI_ENTRY` marker
  (cli.ts), and the never-shipped F1 cooldown.
- Tests: `tests/indexer/index-written-assets.test.ts`,
  `tests/indexer/ensure-index-serve.test.ts`, busy-timeout pragma test in
  `tests/storage/index-db-loan.characterization.test.ts`.
- End-to-end verified in a sandbox: `akm remember` → hit on the very next
  `akm search`; a hand-edited file is served stale by reads (no reindex
  spawned) and appears after an explicit `akm index`.

## 5. Remaining work

None on this branch. Follow-ups (separate issues if wanted): a "index last
built N days ago" hint on search for cron-less installs; the `akm health`
embedding-endpoint advisory (§6.2).

## 6. Open questions for the owner

1. **Cooldown length**: 5 min chosen (improve cron reindexes every 20-30 min
   anyway). Happy to make it a config key (`index.autoRefresh.cooldownMs`) if
   you want it tunable — kept a constant to avoid new config surface.
2. The reporter's environment has `embedding.endpoint: localhost:1234` DOWN
   ("Unable to connect" in the background log). Worth a separate advisory in
   `akm health` (embedding endpoint unreachable while semanticSearchMode=auto)?
   Not part of this fix.

## 7. Write-path indexing design (the actual fix — owner-approved direction)

### 7.1 Root cause, restated structurally

The index is maintained **eagerly** by every first-class mutation command
(`source add`, `stash install`, `wiki`, `workflow`, `setup` all call
`akmIndex()` after writing) — but **lazily at read time** for the two memory
write paths:

| Writer | Where | Indexes its write? | Frequency |
|---|---|---|---|
| `writeMarkdownAsset` (memory/knowledge) | `src/commands/read/knowledge.ts:141` | **No** | Continuous — the plugin session-checkpoint hook funnels through `akm remember` (live files carry `captureMode: hot`); 3,810 files in `memories/` today |
| `writeSessionAsset` (session assets) | `src/commands/improve/session-asset.ts` ← `extract.ts:588` | **No** | Per session-end hook |
| improve internals (distill/dedup/consolidate) | various | **Yes** — post-loop `reindexFn` under the writer lease (`loop-stages.ts:926`) | n/a |

Read-triggered auto-reindex exists solely to compensate for the first two
rows. Fixing the writers deletes the reason the footgun exists.

### 7.2 New primitive: `indexWrittenAssets(stashDir, filePaths)`

A targeted single-file incremental index. All building blocks already exist —
no new machinery, just a thin composition:

```
indexWrittenAssets(stashDir: string, filePaths: string[]): Promise<void>
  // FAIL-OPEN at every step: any error → warnVerbose + return.
  // A skipped upsert degrades to today's behavior (visible after the
  // next full reindex); it must never break remember/extract.
  1. If index.db absent or has no populated `entries` table → return.
     (Bootstrap belongs to the first read/`akm index`, not here.)
  2. Open index.db with a SHORT busy timeout (5s, not 30s): a real write,
     but `akm remember` must not hang behind a running full reindex.
  3. Per file: generateMetadataFlat(stashDir, [file])   // passes/metadata.ts:1139
       → entryKey `${stashDir}:${type}:${name}`, buildSearchText(entry),
         attachFileSize(entry, path)
       → upsertEntry(...)                                // db.ts:676, marks FTS-dirty
  4. rebuildFts(db, { incremental: true })               // dirty-rows only, db.ts:1114
  5. Close. NO builtAt bump, NO dir-state update, NO embedding/LLM/graph.
```

Step 5 is deliberate and ADR-blessed (`docs/technical/index-consistency-adr.md`,
opportunistic recovery): embeddings/graph for the new entry are healed by the
next full run (improve cron / explicit `akm index`). The per-dir mtime cache is
untouched — writing the file changed the dir mtime, so the next full walk
rescans that dir anyway; no drift.

Known minor divergence (accepted, self-healing): the single-file path skips the
cross-source shadowing dedup (`indexedAssetIdentities`), so a write that a
higher-priority stash root shadows could appear until the next full run.

### 7.3 Call sites (two lines of integration)

1. `writeMarkdownAsset` — after `writeAssetToSource` succeeds:
   `await indexWrittenAssets(source.path, [result.path])`.
   Covers `akm remember` (including the plugin's continuous session
   checkpoints — the dominant staleness source) and `stash-cli` writes.
2. `extract.ts:588` — after `writeSessionAsset` returns `written: true`:
   index `result.filePath`. Covers standalone `akm extract --session-id`
   (session-end hook). Extract inside improve is additionally covered by the
   post-loop reindex.

No change to improve internals (already covered) or to the mutation commands
(already call `akmIndex`).

### 7.4 Read-path subtraction (deletions)

`ensureIndex()` background mode stops compensating:

- **Delete** the read-path staleness walk (the O(N-files) stat sweep per
  read), `spawnBackgroundReindex`, the writer-lease handoff to the detached
  child, the `AKM_CLI_ENTRY` guard, and this branch's §3-F1 cooldown
  (constant, marker helpers, fast-path — never ships).
- New background-mode behavior: `indexCanServeStash()` → serve as-is;
  otherwise inline rebuild (bootstrap, unchanged from #607 semantics).
- Blocking mode (`improve`) unchanged: `isIndexStale()` → inline rebuild.
  (`isIndexStale`/`hasNewerIndexableFiles`/`getIndexableFiles` stay for this.)
- If `akm index --background` and `handoffIndexWriterLeaseToPid` have no other
  callers after this, delete them too (verify at implementation time).
- §3-F2 (250ms telemetry busy timeout) stays — telemetry writes remain
  fire-and-forget hints regardless of who maintains the index.

### 7.5 Behavior changes (the honest tradeoff)

| Scenario | Before | After |
|---|---|---|
| `akm remember` → search for it | Invisible until next background reindex completes | **Visible immediately** (FTS keyword; semantic after next full run) |
| Session checkpoint writes during active session | Perpetual reindex loop, 20–90s read stalls | No read-side reindex at all |
| Hand-edit / `git pull` a stash file → search | Eventually auto-reindexed (with the contention cost) | **Stale until** improve cron / explicit `akm index` / any mutation command |
| First-ever search (no index) | Inline build | Inline build (unchanged) |

The third row is the price. Mitigations considered: a "index last built N
days ago — run `akm index`" hint on search (cheap, honest; can be added later
if real users hit it), or a time-based re-arm of background reindex (rejected:
re-adds the machinery being deleted).

### 7.6 Tests

- New: `remember` (via `writeMarkdownAsset`) → entry immediately present in
  `entries` + FTS-searchable; fail-open when index.db absent; short-timeout
  skip under a held write lock leaves the command successful.
- New: `ensureIndex` background = serve-when-servable / inline-when-not;
  blocking still rebuilds on stale.
- Replace this branch's cooldown tests (behavior deleted).
- Existing search/curate/show/extract suites stay green; full gate before commit.
