# Test Coverage Implementation Guide

Addresses remediation item #28 from the critical review. Organized by priority
(most impactful gaps first), with concrete test cases and example code.

## Testing Conventions

All tests in this project follow these patterns:

- **Framework:** `bun:test` (`test`, `expect`, `describe`, `beforeEach`, `afterEach`, `afterAll`)
- **Temp dirs:** Create with `fs.mkdtempSync`, track in an array, clean up in `afterAll`
- **Env vars:** Save originals before mutation, restore in `afterEach`
- **Isolation:** Each test file sets `XDG_CACHE_HOME` and `XDG_CONFIG_HOME` to temp dirs
- **File naming:** `tests/<module-name>.test.ts`
- **No mocks:** Tests use real filesystem and in-memory SQLite databases

```ts
// Standard test file scaffold
import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const createdTmpDirs: string[] = []
function tmpDir(prefix = "agentikit-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  createdTmpDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
```

---

## Priority 1: Database Module (`tests/db.test.ts`)

The database module underpins search and indexing. Every other component depends
on it working correctly.

### 1.1 Schema creation and version management

```ts
import {
  openDatabase, closeDatabase, getMeta, setMeta,
  upsertEntry, getEntryCount, getAllEntries, getEntryById,
  getEntriesByDir, deleteEntriesByDir, rebuildFts, searchFts,
  DB_VERSION, EMBEDDING_DIM,
} from "../src/db"
```

**Test cases:**

- `openDatabase creates schema with correct version` -- Open a fresh DB, verify
  `getMeta(db, "version")` equals `String(DB_VERSION)`.
- `openDatabase with mismatched version drops and recreates tables` -- Open a
  DB, manually `setMeta(db, "version", "0")`, close it. Reopen it. Verify
  version is now `DB_VERSION` and entry count is 0.
- `openDatabase creates FTS5 table` -- Open a DB, verify
  `SELECT name FROM sqlite_master WHERE name='entries_fts'` returns a row.
- `openDatabase creates vec table when extension available` -- If sqlite-vec
  loads, verify `entries_vec` table exists.
- `openDatabase skips vec table when extension unavailable` -- Verify no crash
  and `isVecAvailable()` returns the correct boolean.
- `embeddingDim is stored and triggers vec table recreation` -- Open with
  `{ embeddingDim: 512 }`, verify `getMeta(db, "embeddingDim")` is `"512"`.
  Reopen with `{ embeddingDim: 768 }`, verify the meta updates.

### 1.2 Entry CRUD operations

- `upsertEntry inserts a new entry and returns its id` -- Insert one entry,
  verify returned ID > 0 and `getEntryCount` returns 1.
- `upsertEntry updates on conflict (same entry_key)` -- Insert, then upsert
  with same key but different description. Verify count is still 1 and the
  entry reflects the update.
- `getEntryById returns the entry or undefined` -- Insert an entry, fetch by
  ID, verify fields. Fetch a non-existent ID, verify undefined.
- `getEntriesByDir returns entries for a directory` -- Insert entries in two
  directories. Query one dir, verify only its entries are returned.
- `getAllEntries returns all entries` -- Insert 3 entries across types. Call
  `getAllEntries()`, verify length is 3.
- `getAllEntries with type filter` -- Insert tool and skill entries. Call
  `getAllEntries(db, "tool")`, verify only tools returned.
- `deleteEntriesByDir removes entries and vec rows` -- Insert entries, delete
  by dir, verify count drops to 0.

### 1.3 FTS search

- `searchFts returns results ranked by BM25` -- Insert two entries with
  different search text. Search for a term present in one. Verify it ranks
  first.
- `searchFts with type filter` -- Insert tool and skill entries. Search with
  `entryType: "tool"`, verify only tools returned.
- `searchFts sanitizes query tokens` -- Search with special characters
  (`"hello! world@123"`), verify no SQL error and reasonable results.
- `searchFts returns empty for garbage query` -- Search with `"!@#$%"`,
  verify empty array (no crash).
- `rebuildFts synchronizes FTS with entries table` -- Insert entries, call
  `rebuildFts`, search, verify results match.

### 1.4 Meta helpers

- `getMeta returns undefined for missing key`
- `setMeta and getMeta round-trip`
- `setMeta overwrites existing key`

---

## Priority 2: Search Module (`tests/stash-search.test.ts`)

The search module has multiple code paths that are mostly untested.

### 2.1 Database search path (FTS scoring)

These tests need a pre-built index. Create a helper:

```ts
async function buildTestIndex(stashDir: string, files: Record<string, string>) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(stashDir, relPath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content)
  }
  process.env.AKM_STASH_DIR = stashDir
  saveConfig({ semanticSearch: false, mountedStashDirs: [] })
  await agentikitIndex({ stashDir, full: true })
}
```

**Test cases:**

- `FTS search returns scored results for matching query` -- Index tools with
  distinctive names. Search by name, verify score > 0.
- `FTS search filters by asset type` -- Index tools and skills. Search with
  `type: "tool"`, verify only tools returned.
- `empty query returns all entries` -- Index 3 items, search with `query: ""`,
  verify all 3 returned.
- `limit parameter caps results` -- Index 10 items, search with `limit: 3`,
  verify exactly 3 returned.
- `scores are clamped to 1.0` -- Index items with tags that match query tokens
  (triggering multiple boosts). Verify no score exceeds 1.0.

### 2.2 Score boosts

- `tag match boosts score` -- Create an entry with `tags: ["deploy"]`. Search
  for "deploy". Verify `whyMatched` includes "matched tags".
- `name match boosts score` -- Search for a term that appears in the entry
  name. Verify `whyMatched` includes "matched name tokens".
- `curated metadata gets quality boost` -- Create one entry with
  `generated: false`, another with `generated: true`. Index, search, verify
  the curated entry scores slightly higher.

### 2.3 Substring fallback

- `falls back to substring search when no index exists` -- Do NOT call
  `agentikitIndex`. Search, verify results come from filesystem walk.
- `substring search is case-insensitive` -- Create `Deploy.sh`, search for
  "deploy", verify match.

### 2.4 Registry search integration

- `source: "registry" skips local search` -- Search with
  `source: "registry"`. Verify no local hits (will need network or mock).
- `source: "local" skips registry search` -- Search with `source: "local"`.
  Verify no registry hits and no warnings.
- `merged results alternate local and registry` -- This is harder to test
  without mocking. Consider a unit test for `mergeSearchHits` if you extract
  it.

### 2.5 Edge cases

- `search with special characters does not crash` -- Search for `"<script>"`,
  verify no error.
- `search with very long query` -- Search with a 10,000 char string, verify
  graceful handling.

---

## Priority 3: Handler Tests (`tests/handlers.test.ts`)

Each handler's `buildShowResponse` and `enrichSearchHit` methods should be
directly tested.

### 3.1 Tool handler

```ts
import { toolHandler } from "../src/handlers/tool-handler"
```

- `buildShowResponse returns runCmd for .sh file` -- Create a real .sh file in
  a stash dir, call `buildShowResponse({ name, path, content, stashDirs })`.
  Verify `runCmd` contains `bash` and `kind` is `"bash"`.
- `buildShowResponse returns runCmd for .ts file` -- Same but .ts. Verify
  `kind` is `"bun"`.
- `buildShowResponse without stashDirs returns content` -- Call without
  `stashDirs`. Verify `content` is present and `runCmd` is absent.
- `enrichSearchHit sets runCmd and kind on hit` -- Create a hit object, call
  `enrichSearchHit`. Verify `hit.runCmd` and `hit.kind` are populated.
- `enrichSearchHit ignores ENOENT` -- Pass a hit with a non-existent path.
  Verify no error thrown.
- `isRelevantFile accepts .sh .ts .js .ps1 .cmd .bat` -- Test each extension.
- `isRelevantFile rejects .md .py .txt` -- Test each.

### 3.2 Script handler

- `buildShowResponse returns runCmd for runnable extensions` -- .sh, .ts, .js.
- `buildShowResponse returns content for non-runnable extensions` -- .py, .rb.
- `isRelevantFile accepts broad script extensions` -- .py, .rb, .go, .lua, etc.

### 3.3 Skill handler

- `buildShowResponse returns type skill with content`
- `toCanonicalName returns directory name` -- e.g., `skills/ops/SKILL.md` -> `"ops"`.
- `toCanonicalName returns undefined for root SKILL.md`
- `toAssetPath appends SKILL.md` -- e.g., `("root", "ops")` -> `"root/ops/SKILL.md"`.

### 3.4 Knowledge handler

- `buildShowResponse with mode full returns entire content`
- `buildShowResponse with mode toc returns formatted TOC`
- `buildShowResponse with mode section extracts heading` -- Create content
  with headings, extract one section.
- `buildShowResponse with mode section returns error for missing heading`
- `buildShowResponse with mode lines returns line range`
- `buildShowResponse with mode frontmatter returns YAML`
- `buildShowResponse with mode frontmatter returns no-frontmatter message`

### 3.5 Command handler

- `buildShowResponse extracts description from frontmatter`
- `buildShowResponse extracts template from content`
- `buildShowResponse handles missing frontmatter`

### 3.6 Agent handler

- `buildShowResponse extracts prompt with prefix`
- `buildShowResponse extracts modelHint from frontmatter`
- `buildShowResponse extracts toolPolicy from frontmatter`
- `buildShowResponse handles missing frontmatter fields`

### 3.7 Markdown helpers

- `isMarkdownFile returns true for .md`
- `isMarkdownFile returns false for .txt`
- `markdownCanonicalName returns POSIX relative path`
- `markdownAssetPath joins typeRoot and name`

---

## Priority 4: Asset Resolve (`tests/stash-resolve.test.ts`)

### Test cases

- `resolveAssetPath returns real path for valid tool` -- Create a .sh file,
  resolve it.
- `resolveAssetPath throws for missing type root` -- Resolve against a stash
  with no `tools/` directory.
- `resolveAssetPath throws for missing file` -- Resolve a name that doesn't
  exist.
- `resolveAssetPath throws for path traversal` -- Try `../outside.sh`.
- `resolveAssetPath throws for symlink escape` -- Create a symlink to a file
  outside the stash root. Verify the escape is caught.
- `resolveAssetPath validates tool extension` -- Create a .txt file in
  tools/. Verify it throws about supported extensions.
- `resolveAssetPath validates script extension` -- Same for scripts.
- `resolveAssetPath resolves skill by directory` -- Create
  `skills/ops/SKILL.md`, resolve `skill:ops`.

---

## Priority 5: Asset Type Handler Registry (`tests/asset-type-handler.test.ts`)

### Test cases

- `getHandler returns registered handler` -- Call `getHandler("tool")`, verify
  it returns the tool handler.
- `getHandler throws for unknown type` -- Call `getHandler("nonexistent")`,
  verify error.
- `tryGetHandler returns undefined for unknown type`
- `getAllHandlers returns all 6 handlers`
- `getRegisteredTypeNames returns all type names`
- `lazy initialization loads handlers on first access` -- This is implicitly
  tested by calling `getHandler` without any prior import of handlers/index.

---

## Priority 6: Registry Operations (`tests/stash-registry.test.ts`)

These tests require careful isolation since they mutate config.

### 6.1 agentikitList

- `returns empty list when no registry installed` -- Load default config,
  call `agentikitList`. Verify `totalInstalled` is 0.
- `returns installed entries with status` -- Save a config with one installed
  entry pointing to real dirs. Call `agentikitList`. Verify the entry and its
  `cacheDirExists`/`stashRootExists` flags.
- `reports missing directories in status` -- Save config with entries pointing
  to non-existent dirs. Verify `cacheDirExists: false`.

### 6.2 agentikitRemove

- `removes entry by id` -- Save config with an installed entry. Call
  `agentikitRemove({ target: entry.id })`. Verify config no longer contains it.
- `removes entry by ref` -- Same but pass the ref string.
- `throws for unknown target` -- Pass a target that doesn't match any entry.
- `cleans up cache directory` -- Verify the cache dir is deleted.

### 6.3 selectTargets (via update)

- `--all returns all entries`
- `target + all throws error`
- `no target and no all throws error`

---

## Priority 7: Registry Search (`tests/registry-search.test.ts`)

These tests hit external APIs, so they should be either:
- Skipped in CI (using `test.skipIf`)
- Tested with response parsing only (mock the fetch response)

### Test approach: unit test response parsing

```ts
// Extract and test the parsing logic directly
// Or test with a local HTTP server using Bun.serve

const server = Bun.serve({
  port: 0, // random port
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.includes("search")) {
      return Response.json({
        objects: [
          { package: { name: "akm-tools", keywords: ["akm"], description: "Tools" } }
        ]
      })
    }
    return new Response("Not found", { status: 404 })
  }
})
```

### Test cases

- `searchRegistry returns empty for blank query`
- `searchRegistry handles npm failures gracefully` -- Verify warning is
  generated, not an exception.
- `clampLimit enforces 1-100 range`

---

## Priority 8: Stash Show (`tests/stash-show.test.ts`)

Most show behavior is tested indirectly via `stash.test.ts`. Focus on gaps:

### Test cases

- `throws with installCmd when origin is not installed` --
  Parse a ref like `npm:@other/missing-pkg//tool:missing.sh`. Verify error
  message contains `akm add`.
- `resolves from mounted stash directories` -- Set up a mounted stash with an
  asset, call show, verify it resolves.
- `resolves from installed stash directories` -- Similar with installed source.
- `response includes editable flag` -- Show an asset from working stash,
  verify `editable: true`. Show from installed, verify `editable: false`.

---

## Priority 9: CLI Error Paths (`tests/cli-errors.test.ts`)

Test the CLI as a subprocess to verify JSON error output.

```ts
import { spawnSync } from "node:child_process"

function runCli(...args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", ["./src/cli.ts", ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, AKM_STASH_DIR: undefined },
  })
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  }
}
```

### Test cases

- `search without AKM_STASH_DIR prints JSON error with hint`
- `show with invalid ref prints JSON error`
- `config set with invalid JSON prints hint about quoting`
- `search --source=invalid prints hint`
- `search --usage=invalid prints hint`

---

## Priority 10: Ripgrep Integration (`tests/ripgrep-resolve.test.ts`)

### Test cases (extend existing `ripgrep.test.ts`)

- `resolveRg prefers stash bin directory` -- Place a dummy rg in stash/bin,
  verify it's found first.
- `resolveRg falls back to system PATH` -- No stash bin, but `rg` on PATH.
- `resolveRg returns null when not found` -- Empty stash, empty PATH.
- `isRgAvailable returns boolean wrapper` -- Verify it matches `resolveRg`
  truthiness.

---

## Estimated Effort

| Priority | Module | New Tests | Effort |
|----------|--------|-----------|--------|
| 1 | db.ts | ~20 | Medium |
| 2 | stash-search.ts | ~15 | Medium-High |
| 3 | handlers/*.ts | ~25 | Medium |
| 4 | stash-resolve.ts | ~8 | Low |
| 5 | asset-type-handler.ts | ~6 | Low |
| 6 | stash-registry.ts | ~10 | Medium |
| 7 | registry-search.ts | ~5 | Low (parsing only) |
| 8 | stash-show.ts | ~5 | Low |
| 9 | cli.ts error paths | ~5 | Low |
| 10 | ripgrep-resolve.ts | ~4 | Low |
| **Total** | | **~103** | |

Priorities 1-3 cover the most critical gaps. Priorities 4-6 round out
correctness. Priorities 7-10 are polish.
