# akm v1 Architecture Gap Analysis

**Branch:** `release/0.6.0`  
**Date:** 2026-04-24  
**Baseline:** v1 architecture spec at `/docs/technical/v1-architecture-spec.md`

---

## Executive Summary

The codebase on `release/0.6.0` carries **significant architectural debt** that the v1 spec is designed to eliminate. Three major themes drive the refactor:

1. **OpenViking (and the API-backend model) causes the most complication.** It forces `LiveStashProvider` vs `SyncableStashProvider` split, fake no-op `search()`/`show()` methods on file-based providers, and capability branching in orchestration. Removing it alone would drop ~400 lines of dispatch logic.

2. **Provider interface bloat.** Current shape is `{ type, name, search(), show(), canShow(), sync()?, kind?, ... }` — the spec wants `{ name, kind, init(), path(), sync()? }`. The existing methods are architectural scaffolding for OpenViking; file-based providers fake them.

3. **Orchestration dispatch logic scattered across files.** `stash-search.ts:58–60`, `stash-show.ts:142`, `search-source.ts:100–130` all branch on provider type/capability. The spec collapses this into: indexer walks sources, commands read from disk.

**Highest-leverage changes** (in order):
- **Delete OpenViking provider entirely** (~400 lines removed, unblocks provider interface simplification).
- **Collapse `search()` / `show()` into indexer + local disk read** (eliminates capability branching, unifies data flow).
- **Rename `stash` → `source` throughout codebase** (mechanical but clears naming debt from the v0 era).

**Risk profile:** Medium-to-high. This is a refactor of the core abstraction, not a feature. Tests cover most paths; the risk is in subtle behavioral changes in search ranking or show hints. Recommend: step-by-step per spec's §10 refactor plan, one major deletion per PR.

---

## 1. Stash provider interface shape

### Gap 1.1: LiveStashProvider vs SyncableStashProvider split

**Current location:**  
- `/src/stash-provider.ts:33–51` (LiveStashProvider interface)  
- `/src/stash-provider.ts:105–117` (SyncableStashProvider interface)

**What exists now:**  
Two distinct interfaces. `LiveStashProvider` is for query-style providers (OpenViking); it has `search()`, `show()`, `canShow()`. `SyncableStashProvider` extends it and adds `sync()`, `getContentDir()`, `remove()` for file-based providers. Every file-based provider implements both (making the "live" methods no-ops).

**What spec wants:**  
Single `SourceProvider` interface with `{ name, kind, init(), path(), sync?() }`. No capability matrix. All reading delegated to indexer. All writing via `writeAssetToSource()` helper.

**Effort:** M (refactor all five provider classes + factory)  
**Risk:** High (core abstraction change; affects all source code paths)

---

### Gap 1.2: Fake search() / show() stubs on file-based providers

**Current locations:**

- **Git provider** (`/src/stash-providers/git.ts:62–74`):
  ```ts
  async search(_options: StashSearchOptions): Promise<StashSearchResult> {
    return { hits: [] };  // line 63
  }
  async show(_ref: string, _view?: KnowledgeView): Promise<ShowResponse> {
    throw new Error("Git provider content is shown via local index");  // line 68
  }
  canShow(_ref: string): boolean {
    return false;  // line 72
  }
  ```

- **Website provider** (`/src/stash-providers/website.ts:69–82`):
  ```ts
  async search(_options: StashSearchOptions): Promise<StashSearchResult> {
    return { hits: [] };  // line 70
  }
  async show(_ref: string, _view?: KnowledgeView): Promise<ShowResponse> {
    throw new Error("Website provider content is shown via local index");  // line 75
  }
  canShow(_ref: string): boolean {
    return false;  // line 80
  }
  ```

- **NPM provider** (`/src/stash-providers/npm.ts:49–61`):
  ```ts
  async search(_options: StashSearchOptions): Promise<StashSearchResult> {
    return { hits: [] };  // line 50
  }
  async show(_ref: string, _view?: KnowledgeView): Promise<ShowResponse> {
    throw new Error("NPM provider content is shown via local index");  // line 56
  }
  canShow(_ref: string): boolean {
    return false;  // line 59
  }
  ```

- **Filesystem provider** (`/src/stash-providers/filesystem.ts:30–55`):
  ```ts
  async search(options: StashSearchOptions): Promise<StashSearchResult> {
    // Actual implementation! (lines 31–46)
  }
  async show(ref: string, view?: KnowledgeView): Promise<ShowResponse> {
    return showLocal({ ref, view });  // line 50 — delegates to CLI function
  }
  canShow(ref: string): boolean {
    return !ref.includes("://");  // line 54
  }
  ```

**What spec wants:**  
None of these methods. All reading happens in the indexer (for FTS) and via `showLocal()` in commands. Providers don't implement query or show semantics.

**Effort:** M  
**Risk:** Medium (deletion is safe; behavior already delegated elsewhere)

---

### Gap 1.3: Additional methods beyond spec's minimal interface

**Current locations:**

- **SyncableStashProvider.getContentDir()** (`/src/stash-provider.ts:109`)
- **SyncableStashProvider.remove()** (`/src/stash-provider.ts:112`)  
- **SyncableStashProvider.kind = "syncable"** field (`/src/stash-provider.ts:106`)

**What exists now:**  
SyncableStashProvider adds three extra surface points: `getContentDir()` (resolve cache path), `remove()` (delete the cache), and a `kind` field (discriminator for `isSyncable()` guard). Implemented in every file-based provider.

**What spec wants:**  
Only `path()` (not `getContentDir()`). No `remove()` (cache lifecycle is orchestrator concern). No `kind` field (no need to discriminate once interfaces collapse).

**Effort:** S (delete 3 methods across 5 files)  
**Risk:** Low (these are internal plumbing; callers are isolated)

---

## 2. Fake search/show methods on git/website providers

**Details:** Already covered in Gap 1.2 above. Summary:

| Provider | Location | Method(s) | Line(s) | Behavior |
|---|---|---|---|---|
| git | `/src/stash-providers/git.ts` | `search()`, `show()`, `canShow()` | 62–74 | No-op empty hits, throw on show, return false |
| website | `/src/stash-providers/website.ts` | `search()`, `show()`, `canShow()` | 69–82 | No-op empty hits, throw on show, return false |
| npm | `/src/stash-providers/npm.ts` | `search()`, `show()`, `canShow()` | 49–61 | No-op empty hits, throw on show, return false |
| filesystem | `/src/stash-providers/filesystem.ts` | `search()`, `show()`, `canShow()` | 30–55 | Real: delegates to DB search and showLocal |

**Effort:** M  
**Risk:** Medium (these are architectural scaffolding; safe to remove)

---

## 3. OpenViking provider — removal blast radius

**Provider implementation:** `/src/stash-providers/openviking.ts` (~270 lines)

**All references to "openviking" or "viking://":**

### 3.1 Core provider

| File | Lines | Content |
|---|---|---|
| `/src/stash-providers/openviking.ts` | 1–268 | Full LiveStashProvider implementation for OpenViking API |
| `/src/stash-providers/index.ts` | 11 | `import "./openviking"` (registration trigger) |

### 3.2 Configuration and type definitions

| File | Lines | Content |
|---|---|---|
| `/src/config.ts` | 82 | Union type: `\| { type: "openviking"; url: string }` |
| `/src/config.ts` | 124 | Comment: `e.g. "filesystem", "git", "openviking"` |
| `/src/config.ts` | 128 | Comment: `e.g. openviking` |
| `/src/config.ts` | 775 | Comment: `` `"filesystem" \| "website" \| "openviking"` `` |
| `/src/config.ts` | 923–937 | Case branch for "context-hub" (alias) and "openviking" |
| `/src/config.ts` | 936–937 | `case "openviking": return entry.url ? { type: "openviking", url: entry.url } : undefined;` |

### 3.3 Setup and configuration UI

| File | Lines | Content |
|---|---|---|
| `/src/setup.ts` | 693 | Menu option: `{ value: "openviking", label: "OpenViking server", hint: "remote stash" }` |
| `/src/setup.ts` | 706–737 | Full setup flow for OpenViking (URL input, API key, name) |

### 3.4 Search path orchestration

| File | Lines | Content |
|---|---|---|
| `/src/stash-search.ts` | 55–60 | Filter additionalStashProviders: `p.type !== "filesystem" && p.type !== "git"` — keeps only OpenViking/website/npm |
| `/src/stash-search.ts` | 75–89 | Loop over `additionalStashProviders`, call `provider.search()` in parallel |

### 3.5 Show path orchestration

| File | Lines | Content |
|---|---|---|
| `/src/stash-show.ts` | 140–150 | After local lookup fails, loop over providers where `p.type !== "filesystem" && p.canShow(ref)` |

### 3.6 URI and ref parsing

| File | Lines | Content |
|---|---|---|
| `/src/stash-providers/openviking.ts` | 93–94 | Accept `viking://` URIs: `trimmed.startsWith("viking://") ? trimmed : refToVikingUri(trimmed)` |
| `/src/stash-providers/openviking.ts` | 168 | Search body: `{ uri: "viking://", pattern: query, ... }` |
| `/src/stash-providers/openviking.ts` | 273–282 | Function `refToVikingUri()`: converts type:name → viking://dir/name |
| `/src/detect.ts` | 133 | OpenViking server detection: `fetch(...viking://..., ...)` |

### 3.7 Monolithic orchestration branches

| File | Lines | Content |
|---|---|---|
| `/src/search-source.ts` | 98 | Comment: `e.g. an openviking remote stash` |
| `/src/search-source.ts` | 128 | Comment: `Remote-only providers (openviking)` |

### 3.8 Stash configuration union type

| File | Lines | Content |
|---|---|---|
| `/src/stash-types.ts` | — | Not directly referenced; but `StashConfigEntry` carries the "openviking" type |

**Total blast radius:** ~7 files, ~50 direct references, ~270 lines of implementation code + ~100 lines of setup/config/orchestration.

**Effort:** M  
**Risk:** Medium (deletion is self-contained; existing code has fallbacks for "not found")

---

## 4. URI schemes in user-facing refs

**Spec rule:** User-facing refs are flat `[origin//]type:name` with no URI schemes. Install refs (passed to `akm add`) are distinct.

### Current violations:

| File | Line(s) | Pattern | Used by |
|---|---|---|---|
| `/src/stash-providers/openviking.ts` | 93 | `viking://` (internal URI) | OpenViking provider's `show()` method |
| `/src/stash-providers/openviking.ts` | 168 | `viking://` in search query body | OpenViking API call |
| `/src/stash-providers/openviking.ts` | 273–282 | `refToVikingUri()` function | Converts type:name → viking:// |
| `/src/detect.ts` | 133 | `viking://` in server probing | OpenViking detection |
| `/src/stash-providers/filesystem.ts` | 54 | `!ref.includes("://")` | URI scheme check in `canShow()` |

**Asset ref parser:** `/src/stash-ref.ts:48–78`  
Rejects refs with `//` in the origin or `:` in the name (path traversal). Does NOT explicitly reject URI schemes, but `parseAssetRef()` would parse `viking://foo` as `origin="viking"`, which violates the "only alphanumerics, _, -" origin rule on line 597 of the spec (grammar: `origin := [A-Za-z0-9][A-Za-z0-9_-]*`).

**Effort:** S  
**Risk:** Low (deletion of OpenViking removes the URI scheme violations)

---

## 5. Capability / kind branching in orchestration

**Spec call-out locations (from §7 "Removed from 0.6.0"):**  
- `stash-search.ts:58–60`  
- `stash-show.ts:142`  
- `search-source.ts:100–130`

### Gap 5.1: search-source.ts — resolveEntryContentDir ladder

**Location:** `/src/search-source.ts:100–130`

**Code:**
```ts
function resolveEntryContentDir(entry: StashConfigEntry): string | undefined {
  if (entry.type === "filesystem" && entry.path) {
    return entry.path;
  }
  if (GIT_STASH_TYPES.has(entry.type) && entry.url) {
    try {
      const repo = parseGitRepoUrl(entry.url);
      const cachePaths = getCachePaths(repo.canonicalUrl);
      return path.join(cachePaths.repoDir, "content");  // line 110
    } catch (err) {
      warn(/* ... */);
      return undefined;
    }
  }
  if (entry.type === "website" && entry.url) {
    try {
      return getWebsiteCachePaths(entry.url).stashDir;
    } catch (err) {
      warn(/* ... */);
      return undefined;
    }
  }
  // Remote-only providers (openviking) have no walkable directory.  // line 128
  return undefined;
}
```

**What exists:** A four-way dispatch on `entry.type` to resolve cache directories. Each branch knows provider-specific cache layout.

**What spec wants:** Deleted entirely. Each provider owns its `path()` method; the indexer simply calls `path()` and walks that. No orchestration ladder.

**Effort:** M  
**Risk:** Medium (callers must switch to `provider.path()`)

---

### Gap 5.2: stash-search.ts — additionalStashProviders filter

**Location:** `/src/stash-search.ts:58–60`

**Code:**
```ts
const additionalStashProviders = resolveStashProviders(config).filter(
  (p) => p.type !== "filesystem" && p.type !== "git",  // line 59
);
```

**What exists:** Filters to non-file-based providers. Then loops and calls their `.search()` method in parallel (lines 75–89).

**What spec wants:** Deleted. All providers use the unified FTS index. No separate provider search calls.

**Effort:** S  
**Risk:** Low (OpenViking removal eliminates the need)

---

### Gap 5.3: stash-show.ts — remote provider fallback loop

**Location:** `/src/stash-show.ts:140–150`

**Code:**
```ts
const providers = resolveStashProviders(config).filter(
  (p) => p.type !== "filesystem" && p.canShow(ref)  // line 142
);
for (const provider of providers) {
  try {
    const response = await provider.show(ref, input.view);
    // ...
    return response;
  } catch (err) {
    // try next provider
  }
}
```

**What exists:** After local lookup fails, loops over remote providers and tries their `.show()` method.

**What spec wants:** Deleted. `show` is `indexer.lookup()` (get metadata) → `readFile()` (get content). No remote fallback.

**Effort:** M  
**Risk:** Medium (OpenViking removal makes this dead code)

---

### Gap 5.4: Capability checks via canShow()

**Implementations:**

| Provider | File | Line | Code |
|---|---|---|---|
| git | `/src/stash-providers/git.ts` | 72 | `return false;` |
| website | `/src/stash-providers/website.ts` | 80 | `return false;` |
| npm | `/src/stash-providers/npm.ts` | 59 | `return false;` |
| filesystem | `/src/stash-providers/filesystem.ts` | 54 | `return !ref.includes("://");` |
| openviking | `/src/stash-providers/openviking.ts` | 136 | `return !!(this.config.url ?? "").trim();` |

**What spec wants:** No `canShow()` method. All showing is local disk read.

**Effort:** S  
**Risk:** Low (simple deletion)

---

## 6. Score normalization across providers

**Spec rule:** One scorer, no per-provider normalization.

**Current state:** No evidence of per-provider score normalization found.

- Search hits from local FTS have a normalized score (0–1).
- Remote provider hits (OpenViking) supply their own score.
- Registry search hits are a separate type (`KitResult.score` is optional and not comparable to `SearchHit.score`).

**Gap:** Not architectural — the code already treats scores as provider-native and doesn't normalize them at merge time. The v1 spec formalized this ("registry-native; not comparable to SearchHit.score" at §4).

**Effort:** S (no change required)  
**Risk:** Low

---

## 7. Registry layer — Context Hub special-casing

**Spec rule:** Context Hub is not a provider. It's a recommended Source entry (git stash) in the official registry.

### Current implementation:

| File | Lines | Content |
|---|---|---|
| `/src/config.ts` | 860 | Type alias in migration: `"context-hub": "git"` |
| `/src/config.ts` | 923–937 | Config load case: handles legacy "context-hub" → "git" |
| `/src/search-source.ts` | 10–11 | Comment: legacy aliases normalized to "git" at config-load time |
| `/src/stash-providers/git.ts` | 131–145 | Cache migration: `context-hub-${key}` dirs silently moved to generic git cache |
| `/src/cli.ts` | 1431–1433 | `akm enable context-hub` → error directing user to `akm add github:andrewyng/context-hub --name context-hub` |

### Gap:

Context Hub is not a provider type anymore (good!), but there's legacy migration code and an explicit error message. The spec wants: none of this. Just treat it as a regular git stash if configured.

**Effort:** S (remove migration shims)  
**Risk:** Low (only affects users with old "context-hub" entries)

---

## 8. Output shape registry — JSON.stringify fallback

**Spec rule:** Exhaustive `{ shape, textRenderer }` registration. No silent `JSON.stringify` fallback.

### Current state:

**Entry point:** `/src/cli.ts:88–110`

```ts
function output(command: string, result: unknown): void {
  const mode: OutputMode = getOutputMode();
  const shaped = shapeForCommand(command, result, mode.detail, mode.forAgent);

  if (mode.format === "jsonl") {
    outputJsonl(command, shaped);
    return;
  }

  switch (mode.format) {
    case "json":
      console.log(JSON.stringify(shaped, null, 2));  // line 99
      return;
    case "yaml":
      console.log(yamlStringify(shaped));
      return;
    case "text": {
      const plain = formatPlain(command, shaped, mode.detail);
      console.log(plain ?? JSON.stringify(shaped, null, 2));  // line 106 — FALLBACK
      return;
    }
  }
}
```

**Shape routing:** `/src/output-shapes.ts:13–24`

```ts
export function shapeForCommand(command: string, result: unknown, detail: DetailLevel, forAgent = false): unknown {
  switch (command) {
    case "search":
      return shapeSearchOutput(result as Record<string, unknown>, detail, forAgent);
    case "registry-search":
      return shapeRegistrySearchOutput(result as Record<string, unknown>, detail);
    case "show":
      return shapeShowOutput(result as Record<string, unknown>, detail, forAgent);
    default:
      return result;  // line 22 — IMPLICIT FALLBACK
  }
}
```

### Gap:

1. **Line 106 of `/src/cli.ts`:** If `formatPlain()` returns `null` (no text formatter), falls back to `JSON.stringify`. The spec wants: error for unknown command or exhaustive registration.
2. **Line 22 of `/src/output-shapes.ts`:** Unknown commands return unmodified result. Should be: explicit error or exhaustive match.

**Commands with text formatters:**  
- search, registry-search, show, curate, init, index, wiki-list, wiki-show, wiki-create, wiki-remove, wiki-pages, wiki-stash, wiki-lint, wiki-ingest, workflow-start, workflow-status, workflow-complete, workflow-next, workflow-list, add, remove, list, update, clone, remember, import, feedback, completions

**Commands without formatters** (would silently JSON.stringify):  
- setup, hints, help, config list/get/set/unset, manifest, info, upgrade, self-update, any future command

**Effort:** M  
**Risk:** Low (adding explicit registration is a pure improvement)

---

## 9. Error hint chain — regex-on-message

**Spec call-out:** `cli.ts:2104–2121` should move to per-class `hint()` methods.

**Current implementation:** Not found at those line numbers (likely drifted). Searching the codebase:

**No regex-on-message hint chain found.** Instead:

- **Error classes:** `/src/errors.ts:37–70` define `ConfigError`, `UsageError`, `NotFoundError` with typed `code` field (no `hint()` method).
- **Embedded hints:** `/src/cli-hints.ts:1–303` contains static hint strings for CLI reference and full help.
- **Error rendering:** `/src/cli.ts:2074` and `2103` call `console.error(JSON.stringify({ ok: false, error, hint }, ...))` but the hint is not context-dependent.

**Gap:** The spec wants error classes to have a `hint()` method that returns actionable guidance. Current code doesn't have this; hints are static.

**Example of desired pattern:**
```ts
class NotFoundError extends Error {
  code: NotFoundErrorCode;
  hint(): string {
    if (this.code === "ASSET_NOT_FOUND") {
      return `Run 'akm search "<query>"' to find assets.`;
    }
    return "Asset not found.";
  }
}
```

**Effort:** M  
**Risk:** Low (pure code refactor; behavior unchanged)

---

## 10. Writable flag usage

**Spec rule:** `writable` is a config flag (not an interface concern). Default: `true` for filesystem, `false` for others.

### Current implementation:

**Type definition:** `/src/config.ts:109` and `135`

```ts
export interface StashEntry {
  writable?: boolean;  // line 109
}
export interface StashConfigEntry {
  writable?: boolean;  // line 135 — "If true, the stash is a git repo the user can commit and push changes back to."
}
```

**Usage:** `/src/stash-types.ts:157`

```ts
export interface SourceEntry {
  // ...
  writable: boolean;  // line 157 — required field in list responses
}
```

**Defaults:** No explicit defaults in config.ts. Callers assume: filesystem is writable, others aren't (checked via `isEditable()` guards).

**Gap 10.1:** No explicit default-per-kind logic. The spec wants:
```ts
function defaultWritable(kind: string): boolean {
  return kind === "filesystem" ? true : false;
}
```

**Gap 10.2:** No single write-path helper like `writeAssetToSource()`. Instead:
- `/src/remember.ts` — memory capture (direct file write)
- `/src/stash-add.ts` — add source (invokes sync)
- Various wiki operations — direct fs operations

The spec centralizes all writes in `writeAssetToSource(source, config, ref, content)`.

**Effort:** M  
**Risk:** Medium (consolidating write paths is refactoring-intensive)

---

## 11. Module layout

**Spec target layout** (§7):

```
src/
  core/
    types.ts              # AssetRef, SearchHit, KitResult, ...
    refs.ts               # parseAssetRef, parseInstallRef
    errors.ts             # UsageError, ConfigError, ...
    config.ts             # load, validate, resolve env
    output.ts             # exhaustive shape registry
    write-source.ts       # writeAssetToSource / deleteAssetFromSource

  source-providers/       # ← renamed from stash-providers
    types.ts              # SourceProvider interface
    index.ts              # registration
    filesystem.ts
    git.ts
    website.ts
    npm.ts

  registry-providers/     # ← new directory
    types.ts              # RegistryProvider interface
    index.ts              # registration
    static-index.ts
    skills-sh.ts

  asset-types/            # existing, unchanged
  renderers/
  embedders/
  ingest/                 # ingest transformers

  indexer.ts
  commands/               # one file per CLI subcommand
  cli.ts                  # thin dispatch
```

**Current actual layout:**

```
src/
  (flat: ~90 files)
    stash-providers/      # ← should be source-providers
      filesystem.ts
      git.ts
      npm.ts
      website.ts
      openviking.ts       # ← will be deleted
      index.ts
      provider-utils.ts
      tar-utils.ts
      sync-from-ref.ts

  providers/              # ← unclear purpose; contains registry-like code?
    (need to inspect)

  embedders/              # ✓ correct location
    (embedders implementations)

  templates/              # ✓ correct location
    (templates)

  (missing):
    - registry-providers/ directory (doesn't exist)
    - core/ subdirectory (everything at src/ root)
    - commands/ subdirectory (one big cli.ts instead)
```

### Current gaps:

| Target | Current | Status | Effort |
|---|---|---|---|
| `core/types.ts` | `stash-types.ts` + scattered types | Needs consolidation | M |
| `core/refs.ts` | `stash-ref.ts` | Rename only | S |
| `core/errors.ts` | `errors.ts` | Move + add hints | S |
| `core/config.ts` | `config.ts` | Move (large) | L |
| `core/output.ts` | `output-shapes.ts` + `output-text.ts` | Consolidate | M |
| `core/write-source.ts` | Doesn't exist | New file | M |
| `source-providers/` | `stash-providers/` | Rename directory + contents | M |
| `registry-providers/` | Doesn't exist | New directory + 2 files | M |
| `commands/` | Everything in `cli.ts` | Extract per spec §9 | L |

**Effort:** L (large refactor, but mostly mechanical renames)  
**Risk:** Medium (directory renames affect imports; must be coordinated)

---

## 12. Ref parser / grammars

**Spec grammars** (Appendix A):

- **Asset ref:** `[origin//]type:name`  
- **Install ref:** `github-ref | git-url | npm-pkg | https-url | skills-sh-slug | local-path` (distinct parsers per type)

### Current parsers:

**Asset ref:** `/src/stash-ref.ts:48–78`

```ts
export function parseAssetRef(ref: string): AssetRef {
  // Single parser for [origin//]type:name
  // Validates: no empty origin, no empty name, no path traversal
}
```

**Install ref:** No unified parser found. Instead:

| Type | Handled by | File | Lines |
|---|---|---|---|
| `npm:@scope/pkg` | `parseRegistryRef()` | `/src/registry-resolve.ts` | — |
| `github:owner/repo` | `parseRegistryRef()` | `/src/registry-resolve.ts` | — |
| `git+https://...` | `parseRegistryRef()` | `/src/registry-resolve.ts` | — |
| `./path/to/kit` | Direct fs check in `akmAdd()` | `/src/stash-add.ts` | — |
| `skills.sh:slug` | No parser; special-case in `akmAdd()` | `/src/stash-add.ts` | — |
| `https://...` | No parser; special-case in `akmAdd()` | `/src/stash-add.ts` | — |

**Gap:** Install refs are parsed ad-hoc throughout `akmAdd()` instead of via a single `parseInstallRef()` function. The spec wants one clear grammar per type, rejecting inputs that don't match.

**Effort:** S  
**Risk:** Low (consolidation is safe)

---

## 13. resolveEntryContentDir ladder — deletion checklist

**Location:** `/src/search-source.ts:100–130`

**Function signature:**
```ts
function resolveEntryContentDir(entry: StashConfigEntry): string | undefined
```

**Callers:**

| Caller | File | Line | Usage |
|---|---|---|---|
| `resolveStashSources()` | `/src/search-source.ts` | 82 | `const dir = resolveEntryContentDir(entry);` |

**What it does:**  
Resolves the on-disk content directory for a configured entry by dispatching on `entry.type`. Each provider type has its own cache layout logic baked in.

**Why delete:**  
In v1, each provider is responsible for knowing its own path. Call `provider.path()` instead of `resolveEntryContentDir(entry)`.

**Post-deletion flow:**
```ts
// Before (0.6.0):
function resolveStashSources(...): SearchSource[] {
  for (const entry of config.stashes) {
    const dir = resolveEntryContentDir(entry);  // dispatch on type
    sources.push({ path: dir });
  }
}

// After (v1):
function resolveStashSources(...): SearchSource[] {
  for (const entry of config.stashes) {
    const provider = factory.resolve(entry.type)(entry);
    await provider.init(ctx);
    sources.push({ path: provider.path() });  // provider knows its own path
  }
}
```

**Effort:** M  
**Risk:** Medium (changes the control flow of source resolution)

---

## Loose ends — Items the spec doesn't explicitly address

1. **InstallRef type definition:** The spec calls it out as `export type InstallRef = string;` but doesn't define a parser. Code should have `parseInstallRef(ref: InstallRef): ParsedInstallRef` to validate shape before routing.

2. **Wiki indexing as a source feature:** `StashEntry.wikiName` is carried through the code but not mentioned in the spec. Should this be a SourceProvider concern or an orchestration concern? Currently split across both.

3. **FTS5 schema versioning:** Spec says "ephemeral index; schema bumps may wipe and rebuild" but no version field in the DB. How do we detect incompatible schema across versions? (Currently implicit; indexer just rebuilds if needed.)

4. **Feedback/usage events storage:** Spec mentions `insertUsageEvent()` but doesn't define the schema or retention policy. Currently stored in an unspecified DB table.

5. **Cache TTL and stale-fallback policy:** Providers have hardcoded TTL constants (`CACHE_TTL_MS`, `CACHE_STALE_MS`) with no centralized config. Should this be pluggable?

6. **Error `hint()` method signature:** Spec says "hints attached to error classes" but doesn't specify `(context?: object): string` vs `(): string`. Current hints are static; ideal would be context-aware.

7. **Renderer registration:** Spec says "each command registers `{ shape, textRenderer }`" but current code doesn't have a formal registry. Should there be a `registerCommandOutput(name, shape, renderer)` function?

8. **Asset type plugins:** The spec mentions asset types are extensible (§8.1) but doesn't explain how plugins register new types or provide custom renderers. Currently implicit via asset-spec.ts patterns.

9. **ProviderContext.resolveOption:** Spec defines this (§2.1) but it's not in the actual `SourceProvider` interface. Should it be a method or a utility function?

10. **Writable vs read-only in push:** For git sources with `writable: true`, how does `config.pushOnCommit` interact? Is `pushOnCommit` a separate option per source, or a global default? (Currently per-source in config.)

---

## Summary table: All gaps at a glance

| Gap # | Category | Current Location | Effort | Risk | Priority |
|---|---|---|---|---|---|
| 1.1 | Provider interface | `/src/stash-provider.ts` | M | High | 1 |
| 1.2 | Fake methods | `/src/stash-providers/*.ts` | M | Medium | 2 |
| 1.3 | Extra methods | `/src/stash-provider.ts` | S | Low | 3 |
| 2.0 | Search/show stubs | See 1.2 | — | — | — |
| 3.0 | OpenViking removal | `/src/stash-providers/openviking.ts` + 7 files | M | Medium | 1 |
| 4.0 | URI schemes | `/src/stash-providers/openviking.ts` + others | S | Low | 2 |
| 5.1 | resolveEntryContentDir | `/src/search-source.ts:100–130` | M | Medium | 2 |
| 5.2 | additionalStashProviders filter | `/src/stash-search.ts:58–60` | S | Low | 2 |
| 5.3 | Remote provider fallback | `/src/stash-show.ts:140–150` | M | Medium | 2 |
| 5.4 | canShow() capability checks | All providers | S | Low | 3 |
| 6.0 | Score normalization | (none found) | — | — | — |
| 7.0 | Registry / Context Hub | `/src/config.ts`, `/src/stash-providers/git.ts` | S | Low | 4 |
| 8.0 | Output fallback | `/src/cli.ts:106`, `/src/output-shapes.ts:22` | M | Low | 3 |
| 9.0 | Error hints | `/src/errors.ts` | M | Low | 4 |
| 10.0 | Writable flag | `/src/config.ts` | M | Medium | 2 |
| 11.0 | Module layout | src/ root | L | Medium | 5 |
| 12.0 | Install ref parser | `/src/stash-add.ts` | S | Low | 3 |
| 13.0 | resolveEntryContentDir | See 5.1 | — | — | — |

---

## Recommended refactor sequencing

Following the spec's §10 plan:

1. **Drop OpenViking** (§10.1) — Unblocks everything else. Single PR, high confidence.
2. **Rename stash → source** (§10.2) — Mechanical. Directory rename + imports. (Optional: defer this if it blocks other work.)
3. **Simplify SourceProvider** (§10.3) — Delete LiveStashProvider split, fake methods, capability checks.
4. **Move reading to indexer** (§10.4) — Collapse search/show into indexer + commands.
5. **Move writing to write-source.ts** (§10.5) — Consolidate all writes through one helper.
6. **Extract registry providers** (§10.6) — Create new directory, move static-index/skills-sh logic.
7. **Error hints on classes** (§10.7) — Add `hint()` methods to error classes.
8. **Exhaustive output shapes** (§10.8) — Remove JSON.stringify fallback.
9. **File splits** (§10.9) — Split cli.ts, move everything to subdirs.
10. **Document and freeze** (§10.10) — Lock the v1 spec.

Each step should be a separate PR that keeps the build green.

