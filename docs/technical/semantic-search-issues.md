# Semantic Search Issues Checklist

Comprehensive audit of semantic search implementation, testing, setup, and deployment.
Generated from deep analysis on 2026-03-29 after user reports of semantic search not working.

---

## CRITICAL

- [x] **Vector search path is completely untested**
  Added `tests/vector-search.test.ts` with 26 tests covering tryVecScores, hybrid scoring,
  NaN guard, BM25 normalization, JS fallback, dimension mismatch, and L2-to-cosine conversion.

- [x] **`semantic-status.ts` has zero test coverage**
  Added `tests/semantic-status.test.ts` with 115 tests covering read/write/clear,
  getEffectiveSemanticStatus, isSemanticRuntimeReady, classifySemanticFailure (incl. new ONNX/native/permission patterns),
  and deriveSemanticProviderFingerprint.

- [x] **Fresh install defaults to "auto" but status is always "pending"**
  Improved warning messages in `src/local-search.ts` to distinguish between "never set up" and "config changed".
  Added auto-recovery for blocked status (24h TTL via `BLOCKED_TTL_MS` in `src/semantic-status.ts`).

- [x] **JSON schema says `semanticSearchMode` is boolean; runtime uses string union**
  Fixed `schemas/akm-config.json` to use `"type": "string", "enum": ["off", "auto"]`.
  Updated `docs/configuration.md`. Added backward-compatible boolean coercion in `src/config.ts`
  (`true` → `"auto"`, `false` → `"off"`). Updated all tests. Added 5 coercion tests.

---

## HIGH

- [x] **`@huggingface/transformers` is a hard dependency, not optional**
  Moved to `optionalDependencies` in `package.json`.

- [x] **DB_VERSION bump on upgrade silently wipes the entire index**
  Usage events are now backed up before schema drop and restored after recreation in `src/db.ts`.
  Added `console.warn` notifying users to re-run `akm index`.

- [x] **Embedding dimension mismatch on JS fallback path**
  Added BLOB embeddings purge when dimension changes, even without sqlite-vec, in `src/db.ts` `ensureSchema()`.

- [x] **ONNX runtime failures produce undiagnosable "unknown" errors**
  Added `onnx-runtime-failed`, `native-lib-missing`, `permission-denied` failure reasons to
  `src/semantic-status.ts`. Improved error messages in `src/embedder.ts` to distinguish
  module-not-found from native binding failures.

- [x] **Provider fingerprint invalidation silently disables semantic search**
  Added specific "Embedding config changed. Run 'akm index --full' to rebuild" warning in
  `src/local-search.ts` when fingerprint mismatch is detected.

- [x] **`searchLocal` stashDir check is too aggressive**
  Relaxed guard in `src/local-search.ts` to check all stored `stashDirs`, not just primary.

---

## MEDIUM

- [x] **Auto-install runs `bun add` in wrong working directory**
  Added `cwd: pkgRoot` (resolved via `import.meta.dir`) to `Bun.spawn` in `src/setup.ts`.

- [x] **Model cache lives inside `node_modules`**
  Set `process.env.HF_HOME` to `getCacheDir() + "/models"` before importing transformers in `src/embedder.ts`.

- [x] **Full rebuild destroys usage_events**
  Changed `src/indexer.ts` to preserve usage_events with NULL entry_id during full rebuild.
  `recomputeUtilityScores()` can now rebuild from preserved event history.

- [x] **After index failure, semantic status says "pending" not "blocked"**
  Added `writeSemanticStatus({ status: "blocked", reason: "index-failed" })` to the
  index failure catch block in `src/setup.ts`.

- [ ] **Alpine/musl Docker images: double silent failure**
  sqlite-vec and onnxruntime-node both lack musl-linked binaries.
  Partially mitigated by improved error classification (onnx-runtime-failed, native-lib-missing).
  Full fix requires musl builds from upstream.

- [x] **No offline mode detection**
  Added `isOnline()` connectivity check in `src/setup.ts`. When offline, skips Ollama detection
  and remote embedding checks with a clear warning.

- [ ] **JS fallback loads ALL embeddings into memory**
  `SELECT id, embedding FROM embeddings` loads everything at once.
  At 100K entries: ~150MB+. The warning threshold (10K) only fires during db open, not during search.
  - `src/db.ts:438-464` — `searchBlobVec` full table scan
  - `src/db.ts:90` — `VEC_FALLBACK_THRESHOLD` only checked at open time

- [x] **`blocked` status is permanent with no auto-recovery**
  Added `BLOCKED_TTL_MS` (24h) in `src/semantic-status.ts`. Blocked status older than 24h
  returns "pending" so the next index will retry.

- [ ] **Race condition in local embedder singleton under concurrent queries**
  The singleton cache uses module-level variables. Concurrent calls with different model names
  can discard the in-flight promise, producing inconsistent cache state.
  - `src/embedder.ts:48-82` — `getLocalEmbedder()` singleton pattern

- [ ] **Semantic status race between config save and status write in setup**
  Config is saved with `semanticSearchMode: "auto"` at line 750. If the process is killed before
  the status file is written, the system has "auto" mode with no status file (defaults to "pending").
  - `src/setup.ts:750` — config save
  - `src/setup.ts:759-791` — semantic prep runs after save

- [ ] **macOS sqlite-vec documentation is misleading**
  Docs suggest `brew install sqlite` fixes extension loading, but Bun uses its own embedded SQLite.
  The brew install does not affect Bun's SQLite.
  - `docs/configuration.md:134-141` — misleading macOS guidance

- [ ] **BM25 normalization assumes sorted FTS5 input**
  The code assumes `ftsResults[0]` is the best score. If anyone adds `DESC` to the ORDER BY,
  normalization silently produces inverted scores. Also, uniform BM25 scores all map to 1.0.
  - `src/local-search.ts:202-214` — normalization logic

- [ ] **Embedding cache not invalidated on config change**
  The LRU cache key for local embeddings is `local::${text}` with no model name.
  Changing `localModel` between searches serves stale vectors from the old model.
  `clearEmbeddingCache()` exists but is never called automatically.
  - `src/embedder.ts:181-205` — cache key construction
  - `src/embedder.ts:203` — `clearEmbeddingCache()` never auto-called

- [ ] **Incremental index skips embedding regeneration for unchanged entries**
  `getAllEntriesForEmbedding()` only selects entries without embeddings.
  Model changes leave old embeddings in place since entry IDs still match.
  Only `akm index --full` forces full regeneration.
  - `src/indexer.ts:460-462` — incremental skip logic
  - `src/indexer.ts:506-512` — `getAllEntriesForEmbedding` WHERE clause

- [ ] **Config-runtime disconnect for `semanticSearchMode`**
  Config says "auto" but actual capability depends on three independent checks.
  `akm info` and `akm search` compute status independently and can report different states.
  - `src/info.ts:24-25` — computes status
  - `src/local-search.ts:73-84` — computes status independently

---

## LOW

- [ ] **sqlite-vec pinned to alpha version**
- [ ] **No ARM Windows support for sqlite-vec**
- [ ] **ONNX runtime version drift with caret ranges**
- [ ] **Missing temp file cleanup in `writeSemanticStatus`**
- [ ] **`fetchWithTimeout` timer not cleared on non-abort errors**
- [ ] **L2-to-cosine conversion only correct for normalized vectors**
- [ ] **No `HOME` env var in minimal Docker containers**
- [ ] **WAL mode may fail on network filesystems**

---

## Testing Gaps Summary

- [x] **No test for `tryVecScores()` being called and producing results** — tests/vector-search.test.ts
- [x] **No test for search with "pending" or "blocked" semantic status** — tests/semantic-status.test.ts
- [x] **No test for hybrid score merging (FTS + vector weighted combination)** — tests/vector-search.test.ts
- [x] **No test for `classifySemanticFailure()` error categorization** — tests/semantic-status.test.ts
- [x] **No test for `deriveSemanticProviderFingerprint()` mismatch** — tests/semantic-status.test.ts
- [ ] **No test for corrupt/missing/version-mismatched `.db` file during search**
- [x] **No test for dimension mismatch on BLOB fallback path** — tests/vector-search.test.ts
- [ ] **No test for local model download failure (network error, not dtype)**
- [ ] **No test for ONNX runtime initialization failure**
- [ ] **No test for `embed()` with zero-vector, malformed JSON, or timeout**
- [ ] **No test for re-indexing after embedding model change**
- [ ] **No test for concurrent search access (`Promise.all` against same DB)**
- [ ] **No test for partial embedding failure (50 of 100 entries fail)**
- [ ] **No test for `akm setup` via CLI subprocess**
- [ ] **No test for `akm info` semantic status reporting in ready/blocked states**
- [ ] **No platform-specific CI (Alpine, ARM, Windows)**
- [x] **Misleading test names: "hybrid" and "semantic" tests that only test FTS** — renamed in parallel-search.test.ts and e2e.test.ts
