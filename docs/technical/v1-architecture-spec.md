# akm v1 — Architecture Specification

**Status:** Draft for implementation
**Target:** v1.0 freeze
**Audience:** akm core contributors

---

## 1. The model

akm manages **files in directories**, indexed and searched with shared conventions. Everything else is in service of that.

There are two kinds of plugins:

- **`SourceProvider`** — gets files into a directory. Different kinds of providers get files from different places (local disk, git, websites, npm).
- **`RegistryProvider`** — lists installable kits for discovery. Read-only catalog.

That's the whole architecture.

### What's intentionally out of scope for v1

API-backed sources (OpenViking, mem0, Notion, etc.) are **not in v1**. They're a different shape — queryable services, not file trees — and forcing them into the same interface as file-based sources is what caused the architectural complications visible in 0.6.0. They'll get their own interface and orchestration path post-v1 as a `QuerySource` tier, parallel to but separate from `SourceProvider`.

Vault providers (keychain, 1Password, etc.) are also out of scope. Env vars cover v1.

### Design rules

1. **Sources are directories.** A source is a path plus a way to refresh it from upstream.
2. **The indexer does the reading.** Providers don't implement `search` or `show`. The indexer walks the source's path and builds an FTS+vec index. Commands query the index and read files from disk.
3. **Writable is a config flag, not an interface concern.** Agents ask "where can I edit?" akm reads the flag. No subtyping, no method-presence dispatch.
4. **Commit/push is a git-specific convenience,** handled in one place for sources of `kind: "git"`. Not abstracted into the provider interface.
5. **Registries have a fixed contract** — no capability matrix.
6. **User-facing refs are flat:** `[origin//]type:name`. Install refs are a distinct grammar.
7. **The index DB is ephemeral.** Schema bumps may wipe and rebuild. Usage events survive.

---

## 2. SourceProvider

### 2.1 Interface

```ts
// src/source-providers/types.ts

export interface ProviderContext {
  readonly name: string;
  readonly options: Record<string, unknown>;
  readonly cacheDir: string;                // akm-managed cache root for this source
  /** Resolves an option value that may be a literal or { env: "NAME" }. */
  readonly resolveOption: (value: unknown) => string | undefined;
}

export interface SourceProvider {
  readonly name: string;
  readonly kind: string;                     // "filesystem" | "git" | "website" | "npm"

  /** Called once at load. */
  init(ctx: ProviderContext): Promise<void>;

  /** The directory the indexer walks. Must return the same path for the
   *  lifetime of the provider instance. */
  path(): string;

  /** Refresh the directory from upstream. No-op for filesystem. */
  sync?(): Promise<void>;
}
```

That's the entire interface. Three required methods, one optional.

### 2.2 Why this is enough

Reading a source is the indexer's job. The indexer walks `path()`, hashes files, updates FTS5 and embeddings. Commands that need asset content (`akm show`, `akm clone`) query the index and read the file directly from disk. No provider method needed.

Writing to a source is a filesystem operation plus (for git) a commit. The writing code lives in `src/core/write-source.ts` — it doesn't go through a polymorphic provider method, because there are only two behaviors (plain filesystem write, or write-then-commit), and both are trivial.

### 2.3 Built-in providers at v1

| Kind | `sync` does | Cache location | Default writable |
|---|---|---|---|
| `filesystem` | nothing | user's own path | yes |
| `git` | `git pull` (or clone on first sync) | `cacheDir/<repo-hash>` | no (opt in per-source) |
| `website` | recrawl + convert to markdown | `cacheDir/<url-hash>` | no |
| `npm` | `npm install` | `cacheDir/<pkg-hash>` | no |

### 2.4 Example skeleton — filesystem

```ts
export class FilesystemSource implements SourceProvider {
  readonly kind = "filesystem";
  readonly name: string;
  #path!: string;

  constructor(name: string) { this.name = name; }

  async init(ctx: ProviderContext): Promise<void> {
    const p = ctx.resolveOption(ctx.options.path);
    if (!p) throw new ConfigError("filesystem source requires 'path' option");
    this.#path = resolveTilde(p);
  }

  path(): string {
    return this.#path;
  }
}
```

No `sync`. No read methods. Just a path.

### 2.5 Example skeleton — git

```ts
export class GitSource implements SourceProvider {
  readonly kind = "git";
  readonly name: string;
  #url!: string;
  #cacheDir!: string;
  #ref?: string;

  constructor(name: string) { this.name = name; }

  async init(ctx: ProviderContext): Promise<void> {
    this.#url = ctx.resolveOption(ctx.options.url) ?? throwConfig("url required");
    this.#ref = ctx.resolveOption(ctx.options.ref);
    this.#cacheDir = path.join(ctx.cacheDir, hashUrl(this.#url));
  }

  path(): string {
    return this.#cacheDir;
  }

  async sync(): Promise<void> {
    if (!existsSync(this.#cacheDir)) {
      await git("clone", this.#url, this.#cacheDir);
    } else {
      await git("-C", this.#cacheDir, "pull", "--ff-only");
    }
    if (this.#ref) await git("-C", this.#cacheDir, "checkout", this.#ref);
  }
}
```

### 2.6 Writing to sources

Writing isn't on the provider interface. It's a command-layer concern handled by a small helper:

```ts
// src/core/write-source.ts

export async function writeAssetToSource(
  source: SourceProvider,
  config: SourceConfigEntry,
  ref: AssetRef,
  content: string,
): Promise<void> {
  if (!config.writable) {
    throw new UsageError(`source ${source.name} is not writable`);
  }

  const filePath = resolveAssetPath(source.path(), ref);
  await writeFile(filePath, content);

  // git-specific convenience: commit and optionally push
  if (source.kind === "git") {
    await git("-C", source.path(), "add", filePath);
    await git("-C", source.path(), "commit", "-m", `Update ${formatRef(ref)}`);
    if (config.options.pushOnCommit) {
      await git("-C", source.path(), "push");
    }
  }
}
```

This is the **only** place in the codebase that branches on `source.kind`, and it's intentional — "git has a commit step" is domain knowledge, not polymorphism. If a third kind ever needs special write handling, it gets added here. If it becomes more than two or three cases, revisit and introduce a hook. For v1 it's two cases.

### 2.7 Delete is symmetric

```ts
export async function deleteAssetFromSource(
  source: SourceProvider,
  config: SourceConfigEntry,
  ref: AssetRef,
): Promise<void> {
  if (!config.writable) throw new UsageError(/* ... */);
  const filePath = resolveAssetPath(source.path(), ref);
  await unlink(filePath);
  if (source.kind === "git") {
    await git("-C", source.path(), "add", filePath);
    await git("-C", source.path(), "commit", "-m", `Remove ${formatRef(ref)}`);
    if (config.options.pushOnCommit) {
      await git("-C", source.path(), "push");
    }
  }
}
```

Same pattern.

---

## 3. RegistryProvider

### 3.1 Interface

```ts
// src/registry-providers/types.ts

export interface RegistryProvider {
  readonly name: string;
  readonly kind: string;                    // "static-index" | "skills-sh"

  init?(ctx: ProviderContext): Promise<void>;

  /** Find installable kits. */
  searchKits(q: RegistryQuery): Promise<KitResult[]>;

  /** Optional: preview assets inside kits without installing. */
  searchAssets?(q: RegistryQuery): Promise<AssetPreview[]>;

  /** Fetch the manifest needed to turn a kit into a SourceProvider config. */
  getKit(id: KitId): Promise<KitManifest>;
}
```

Fixed contract. Every registry does roughly the same thing — discover kits, optionally preview assets, return a manifest.

### 3.2 Built-in providers at v1

| Kind | Role |
|---|---|
| `static-index` | Reads the v2 JSON index schema. Default. Covers the official akm-registry and any static-hosted team/private registry. |
| `skills-sh` | Wraps the skills.sh API. 15-min cache with 24-hour stale fallback. |

**Context Hub is not a provider.** It's a recommended Source entry in the official registry, installed via `akm add` like any other kit.

### 3.3 The v2 JSON index schema belongs to `static-index`

The v2 index schema is the input contract of the `static-index` provider, not a core akm concept. Other registry providers implement `RegistryProvider` natively and aren't required to emit v2 JSON. This decouples schema evolution from core akm.

---

## 4. Core types

```ts
// src/core/types.ts

/** [origin//]type:name — user-facing asset reference. */
export interface AssetRef {
  readonly origin?: string;                 // configured Source name, optional
  readonly type: string;                    // "skill" | "script" | "knowledge" | ...
  readonly name: string;
}

/** Distinct grammar from AssetRef. Used by `akm add` and one-shot `akm clone`. */
export type InstallRef = string;

export interface AssetContent {
  readonly ref: AssetRef;
  readonly body: string;
  readonly meta: Record<string, unknown>;
  readonly origin: string;
  readonly kind: string;
  readonly updatedAt?: string;
}

export interface Query {
  readonly text: string;
  readonly limit?: number;
  readonly typeFilter?: readonly string[];
}

export interface SearchHit {
  readonly ref: AssetRef;
  readonly origin: string;
  readonly kind: string;
  readonly score: number;                   // [0, 1], higher = better
  readonly snippet?: string;
  readonly updatedAt?: string;
}

// Registry types — distinct type tree from source results.

export type KitId = string;

export interface RegistryQuery {
  readonly text: string;
  readonly limit?: number;
}

export interface KitResult {
  readonly id: KitId;
  readonly title: string;
  readonly summary?: string;
  readonly installRef: InstallRef;
  readonly score?: number;                  // registry-native; not comparable to SearchHit.score
  readonly assetPreview?: readonly AssetPreview[];
}

export interface AssetPreview {
  readonly kitId: KitId;
  readonly type: string;
  readonly name: string;
  readonly summary?: string;
  readonly cloneRef: InstallRef;
}

export interface KitManifest {
  readonly id: KitId;
  readonly sourceConfig: SourceConfigEntry;
  readonly assets?: readonly AssetPreview[];
}

export interface SourceConfigEntry {
  readonly name: string;
  readonly kind: string;
  readonly options: Record<string, unknown>;
  readonly writable?: boolean;              // default per kind (see §5.4)
}
```

---

## 5. Configuration

### 5.1 Schema

```jsonc
{
  "sources": [
    { "name": "mine", "kind": "filesystem",
      "options": { "path": "~/.claude" },
      "writable": true },

    { "name": "team", "kind": "git",
      "options": { "url": "git+https://github.com/team/kit", "pushOnCommit": true },
      "writable": true },

    { "name": "upstream", "kind": "git",
      "options": { "url": "git+https://github.com/someone/kit" },
      "writable": false },

    { "name": "docs", "kind": "website",
      "options": { "url": "https://docs.example.com", "maxPages": 100 } }
  ],

  "registries": [
    { "name": "official",  "kind": "static-index",
      "options": { "url": "https://registry.akm.dev/index.json" } },
    { "name": "skills-sh", "kind": "skills-sh", "options": {} }
  ],

  "embedder": { "kind": "...", "options": { /* ... */ } },
  "scorer":   { "weights": { "relevance": 0.7, "utility": 0.3 } },

  "defaultWriteTarget": "mine"              // optional; first writable if omitted
}
```

### 5.2 Value forms

Any string-typed option may be:

- A literal: `"some-value"`
- An env reference: `{ "env": "VAR_NAME" }`

`.env` in the akm config directory is auto-loaded. Missing required env vars produce `ConfigError` naming the variable.

### 5.3 Per-provider option schemas

Each provider ships a JSON Schema for its `options` block. The config loader validates before calling `init()`. Missing required fields fail at load, not at first call.

### 5.4 The `writable` flag

`writable` is a hint. It lets agents ask "where can I edit?" and lets akm refuse to write to sources the user wants treated as read-only. It's not a capability the interface exposes — it's a policy the user sets.

Defaults: `true` for `filesystem` (users usually own directories they point akm at), `false` for everything else. Users can set `writable: false` on a `filesystem` source to make it read-only.

`writable: true` is **rejected at config load** for `website` and `npm` kinds — `sync()` clobbers local edits on the next refresh, so allowing writes there is a footgun, not a feature. The loader throws `ConfigError` with hint: *"writable: true is only supported on filesystem and git sources. To author into a checked-out package, add the same path as a filesystem source."*

---

## 6. Orchestration

### 6.1 Search (`akm search <query>`)

All sources are directories. All directories are in the local index. Search queries the index.

```ts
async function search(q: Query): Promise<SearchHit[]> {
  return indexer.search(q);
}
```

No cross-source merging, no normalization, no capability checks. There is one query path because there is one data store.

If `--include-registry`: in parallel, call `searchKits` across registries and render as a **separate section**. Registry results never merge into source hits.

### 6.2 Show (`akm show <asset-ref>`)

```ts
async function show(ref: AssetRef): Promise<AssetContent | null> {
  const entry = await indexer.lookup(ref);   // one row from the FTS table
  if (!entry) return null;
  const body = await readFile(entry.filePath);
  return { ...entry, body };
}
```

The index knows which file corresponds to each ref. Read it.

### 6.3 Add (`akm add <install-ref>`)

1. `parseInstallRef(ref)` — distinct parser from asset refs.
2. First registry whose `canHandle` (URL prefix / scheme / slug shape) matches owns the ref. Missing match is `UsageError` with hint.
3. `getKit(id)` → `KitManifest.sourceConfig` → append to config → run the new source's `sync()` if present.
4. Indexer runs against the new source's path.

### 6.4 Clone (`akm clone <ref>`)

- **Asset-ref form:** look up in index, copy file(s) to destination.
- **Install-ref form:** ephemeral source instantiation — resolve the install ref, `sync()` into a temp directory, copy the requested asset out, discard.

### 6.5 Remember / Import (`akm remember`, `akm import`)

1. Input → ingest transformer → asset content.
2. Pick target: `--target <name>`, else `config.defaultWriteTarget`, else the user's working stash (`config.stashDir` — the source created by `akm init`). `ConfigError` if none configured (hint: run `akm init`).
3. Call `writeAssetToSource(source, config, ref, content)`.
4. Indexer refreshes against that source's path.

### 6.6 Feedback (`akm feedback <ref> ±`)

Writes a utility signal keyed to the asset ref into akm's local DB. Feeds the scorer's `utility` weight. Independent of source.

---

## 7. Module layout

```
src/
  core/
    types.ts              # AssetRef, SearchHit, KitResult, KitManifest, ...
    refs.ts               # parseAssetRef, parseInstallRef
    errors.ts             # UsageError, ConfigError, NotFoundError, exit codes
    config.ts             # load, validate, resolve env references
    output.ts             # exhaustive shape registry
    write-source.ts       # writeAssetToSource / deleteAssetFromSource

  source-providers/
    types.ts              # SourceProvider interface
    index.ts              # registration
    filesystem.ts
    git.ts
    website.ts
    npm.ts

  registry-providers/
    types.ts              # RegistryProvider interface
    index.ts              # registration
    static-index.ts       # owns the v2 JSON index schema
    skills-sh.ts          # owns skills.sh API wrapping

  asset-types/            # existing asset-spec.ts pattern, unchanged
  renderers/              # one file per type, three verbosity levels
  embedders/
  ingest/                 # ingest transformers

  indexer.ts              # walks every source's path(), runs FTS+vec index
  commands/               # one file per CLI subcommand
  cli.ts                  # thin dispatch
```

### Removed from 0.6.0

- `LiveStashProvider` / `SyncableStashProvider` split.
- Fake `search` / `show` methods on `git` and `website` (critique's item 1).
- Score-normalization logic across providers (only one scorer now).
- URI dialect in refs (OpenViking leaves v1; no other provider uses URIs).
- `src/stash-search.ts`, `src/stash-show.ts` — collapse into `indexer.search` / `indexer.lookup`.
- `src/search-source.ts:100–130` — the `resolveEntryContentDir` ladder. Each source owns its path.

---

## 8. Extension points

What plugin authors can add at v1:

1. **SourceProvider** — new ways to materialize files into a directory.
2. **RegistryProvider** — new discovery catalogs.
3. **Asset type** — existing `asset-spec.ts` registration, unchanged.
4. **Embedder** — swap embedding model or backend.
5. **Renderer** — per asset type, three verbosity levels.
6. **Ingest transformer** — new input formats for the write path.

### Not extensible at v1 (may become so post-v1)

- **API-backed sources** (OpenViking, mem0, Notion, etc.). Will be a parallel `QuerySource` tier post-v1 with its own interface and orchestration. Deliberately deferred.
- **Vault / secret backend.** Env vars only at v1.
- **Scorer algorithm.** Weights are config; algorithm isn't pluggable.
- **Output format.** `text` and `json` only. `ndjson`, `tsv`, `mcp` namespace reserved.

---

## 9. Locked contracts for v1

Any change to the following requires a major version bump after v1.0.

- `SourceProvider` and `RegistryProvider` interfaces.
- Core types: `AssetRef`, `AssetContent`, `SearchHit`, `KitResult`, `AssetPreview`, `KitManifest`, `SourceConfigEntry`.
- Asset ref grammar (`[origin//]type:name`) and install ref grammar (distinct).
- Score range for `SearchHit.score`: `[0, 1]`, higher = better.
- Configuration JSON Schema, including literal-or-env value form and the `writable` flag.
- Error classes, `.code` values, exit codes (`USAGE=2`, `CONFIG=78`, `GENERAL=1`), hints attached to error classes.
- CLI command surface: `add | remove | list | update | search | show | clone | index | setup | remember | import | feedback | registry *`. Renaming or removing is major.
- Output shape registry is exhaustive. Each command registers `{ shape, textRenderer }` at module load. No silent `JSON.stringify` fallback.
- v2 JSON index schema, owned by `static-index`.
- Index DB is ephemeral; schema version bumps may wipe and rebuild.

---

## 10. Refactor plan from 0.6.0

Ordered. Each step leaves the build green.

### Step 1 — Drop OpenViking

Remove `src/stash-providers/openviking.ts`, its tests, its registration, its config migration path. Document as "deferred to post-v1 when API-backed sources get their own tier."

Users with `openviking` in their config get a `ConfigError` at load with a hint pointing at the deferral note.

This single change removes most of the architectural complication the 0.6.0 code is carrying.

### Step 2 — Rename `stash` → `source` throughout

Mechanical. Directory, modules, types, variable names, docs. Single commit.

### Step 3 — Simplify SourceProvider to `{ name, kind, init, path, sync? }`

- Delete `LiveStashProvider` / `SyncableStashProvider` split.
- Delete fake `search` / `show` stubs on `git` and `website`.
- Delete capability branches in orchestration: `stash-search.ts:58–60`, `stash-show.ts:142`, `search-source.ts:100–130`.
- Each provider exposes `path()` and optionally `sync()`.

### Step 4 — Move reading into the indexer

- `search` → `indexer.search(q)` against the unified FTS index.
- `show` → `indexer.lookup(ref)` → read file from disk.
- Delete the separate stash-search / stash-show modules. Logic collapses into `commands/search.ts` and `commands/show.ts`.

### Step 5 — Move writing into `write-source.ts`

Single helper handles filesystem write and the git commit/push convenience. Called by `commands/remember.ts`, `commands/import.ts`, `commands/remove.ts`.

Add the `writable` flag to `SourceConfigEntry`. Default per kind per §5.4.

### Step 6 — Extract registry providers

- `src/registry-providers/static-index.ts` — owns the v2 JSON index schema.
- `src/registry-providers/skills-sh.ts` — extracts current skills.sh special-casing.
- `commands/registry-search.ts` loops over registered registry providers.
- Remove any Context Hub code. If Context Hub is supported, it's a recommended kit in the official registry.

### Step 7 — Error hints on classes

Delete the regex-on-message hint chain at `cli.ts:2104–2121`. Each error class owns `hint()`.

### Step 8 — Exhaustive output shapes

Every command registers `{ shape, textRenderer }` at module load. `shapeForCommand` is exhaustive. No silent `JSON.stringify` fallback.

### Step 9 — File splits

- `cli.ts` → `commands/*.ts`.
- `wiki.ts` → `wiki-crud.ts`, `wiki-index.ts`, `wiki-lint.ts`, `wiki-ingest.ts`.
- `setup.ts` → steps per file.
- `config.ts` → types vs. loading/merging.
- `renderers.ts` → `renderers/<type>.ts`.

### Step 10 — Document and freeze

Publish this spec as the locked v1 contract. Document the ephemeral-index semantic explicitly. Plugin authors code against the spec.

---

## 11. Decisions (resolved)

The four open questions originally listed here are resolved as of 2026-04-24. They are now part of the locked v1 contract (see §9).

1. **`writable` default on `filesystem`: `true`.** Users usually own the directories they point akm at. Read-only filesystem sources require explicit `writable: false`.
2. **Registry results in default `akm search`: behind `--include-registry`.** Default output stays scannable. Registry results never merge into source hits (§6.1).
3. **Write-target resolution: explicit `--target` → `config.defaultWriteTarget` → working stash (`config.stashDir`).** The working stash created by `akm init` is the implicit fallback. There is no "first-writable-in-source-array-order" fallback — it produced ambiguity without payoff.
4. **`writable: true` on `website` / `npm` is rejected at config load.** `sync()` would clobber writes on the next refresh; the loader throws `ConfigError` with a remediation hint. See §5.4.

---

## Appendix A — Ref grammars

### Asset ref

```
asset-ref := [ origin "//" ] type ":" name

origin    := [A-Za-z0-9][A-Za-z0-9_-]*
type      := [a-z][a-z0-9-]*
name      := [^\x00/\\:]+
```

Examples: `skill:deploy`, `local//knowledge:my-notes`, `team//script:deploy.sh`.
Rejected: `viking://skills/deploy` (URI scheme), `skill:../../../etc/passwd` (traversal), `github:owner/repo` (wrong parser).

### Install ref

```
install-ref := github-ref | git-url | npm-pkg | https-url | skills-sh-slug | local-path
```

Examples: `github:owner/repo#v1.2.3`, `git+https://gitlab.com/org/kit`, `@scope/kit`, `https://docs.example.com`, `skills.sh:code-review`, `./path/to/kit`.

Parsers reject each other's inputs.

---

## Appendix B — Provider registration

```ts
// src/source-providers/index.ts
import { createProviderRegistry } from "../create-provider-registry";

export const sourceRegistry = createProviderRegistry<SourceProvider>();
sourceRegistry.register("filesystem", (name) => new FilesystemSource(name));
sourceRegistry.register("git",        (name) => new GitSource(name));
sourceRegistry.register("website",    (name) => new WebsiteSource(name));
sourceRegistry.register("npm",        (name) => new NpmSource(name));
```

```ts
// src/registry-providers/index.ts
export const registryRegistry = createProviderRegistry<RegistryProvider>();
registryRegistry.register("static-index", (name) => new StaticIndexRegistry(name));
registryRegistry.register("skills-sh",    (name) => new SkillsShRegistry(name));
```

External plugin packages register into the same registries after load.

---

*End of specification.*
