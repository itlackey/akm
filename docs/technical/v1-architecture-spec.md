# akm v1 — Architecture Specification

**Status:** Draft for implementation (rev. 2026-04-27 — proposal/agent/lesson surfaces declared)
**Target:** v1.0 freeze
**Audience:** akm core contributors

> **Reading guide.** This spec defines the v1.0 contract. It mixes shipped pre-release surfaces (sources, indexer, search, show, write-source, registry providers, vault, wiki, workflow) with **planned v1 surfaces** (proposal queue, agent CLI integration, `quality: "proposed"`, `lesson` asset type, `llm.features.*`). Planned surfaces are explicitly marked **`Planned for v1`** in their section heading and in §9. Implementation tracks against these declarations via `docs/reviews/v1-implementation-plan.md` and `docs/reviews/v1-agent-reflection-issues.md`. Anything in §9 — shipped or planned — is part of the locked contract once v1.0 ships.

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
// src/sources/providers/types.ts

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
// src/registry/providers/types.ts

export interface RegistryProvider {
  readonly name: string;
  readonly type: string;                    // "static-index" | "skills-sh"

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
  readonly installRef: InstallRef;
  readonly assets?: readonly AssetPreview[];
}

export interface SourceConfigEntry {
  readonly name: string;
  readonly kind: string;
  readonly options: Record<string, unknown>;
  readonly writable?: boolean;              // default per kind (see §5.4)
}
```

### 4.1 Asset type rules (open set)

The asset *type* in an `AssetRef` is intentionally an open string, not a closed
union. The v1 contract is:

- **Well-known types**, each with a renderer, a directory under the working
  stash, and frontmatter expectations:
  `skill`, `command`, `agent`, `knowledge`, `script`, `memory`, `workflow`,
  `vault`, `wiki`, and (Planned for v1) `lesson`. See §13.
- **Plugin-registered types** are allowed via `registerAssetType()` (see
  `src/core/asset-spec.ts`) and behave like well-known types as long as they
  register a renderer. Unknown types parse, index, and search; they render as
  raw markdown.
- The CLI never rejects an `AssetRef` because the type is unknown. The
  asset-ref grammar in Appendix A is the only enforced rule.

### 4.2 Asset quality rules (open set, default-filtered)

Search hits, registry hits, and indexed assets carry an optional `quality`
field. The contract is:

- The field is a string. Three values are well-known:
  - `"generated"` — produced by an automated pipeline. Included in default
    search.
  - `"curated"` — promoted by a human or via the proposal queue (§11).
    Included in default search.
  - `"proposed"` — sitting in the proposal queue, not yet promoted.
    **Excluded from default search**; surfaced only with
    `--include-proposed` or via `akm proposal *` commands.
- Unknown quality values **parse, warn once, and remain searchable** (treated
  as included-by-default). They must not crash the indexer or the search
  pipeline.
- The legacy registry boolean `curated` is removed in v1. Legacy registry
  JSON containing `curated` parses and ignores the key (see §3.3 and
  `docs/migration/v1.md`).

```ts
// src/core/types.ts
export type AssetQuality = "generated" | "curated" | "proposed" | (string & {});

export interface SearchHit {
  // ...existing fields...
  readonly quality?: AssetQuality;
  readonly warnings?: readonly string[];     // optional surfaced warnings
}
```

`SearchHit.quality` and `SearchHit.warnings` are the only new fields v1
introduces on the locked hit type. Both are optional. Renderers in
`src/output/` surface them when present and omit them when absent.

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

  // Planned for v1 — agent CLI integration (§12).
  "agent": {
    "default": "opencode",
    "profiles": {
      "opencode": { /* built-in profile fields, overridable */ }
    },
    "timeoutMs": 60000
  },

  // Planned for v1 — bounded in-tree LLM feature gates (§14).
  "llm": {
    "endpoint": "...",
    "model": "...",
    "features": {
      "curate_rerank":          false,
      "tag_dedup":              false,
      "memory_consolidation":   false,
      "feedback_distillation":  false,
      "embedding_fallback_score": false
    }
  },

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
3. `getKit(id)` → `KitManifest.installRef` → infer the source kind from the install-ref prefix (`github:`, `npm:`, `git+`, `file:`, …), build the corresponding `SourceConfigEntry`, append to config → run the new source's `sync()` if present.
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

### 6.7 Index DB schema versioning

`index.db` is ephemeral — fully rebuildable from sources by `akm index`.
The schema is gated by a single `DB_VERSION` constant (currently 9). When
the stored version differs, `ensureSchema()` drops + recreates every table
in `index.db` (preserving `usage_events` via a typed backup); the next
`akm index` repopulates. `workflow.db` (durable run state) is never
touched by this path.

The `workflow_documents` table caches the validated `WorkflowDocument`
JSON for each indexed workflow asset (keyed by `entries.id`, FK-cascaded).
Defined in `src/indexer/db.ts`; produced by `parseWorkflow()` in
`src/workflows/parser.ts`.

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

  providers/
    types.ts              # SourceProvider interface
    index.ts              # registration
    filesystem.ts
    git.ts
    website.ts
    npm.ts

  providers/
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

Any change to the following requires a major version bump after v1.0. Items
marked **`Planned for v1`** are not yet implemented but are part of the
v1.0 freeze surface and must ship before v1.0 GA.

### 9.1 Interfaces and core types (shipped)

- `SourceProvider` and `RegistryProvider` interfaces.
- Core types: `AssetRef`, `AssetContent`, `SearchHit`, `KitResult`, `AssetPreview`, `KitManifest`, `SourceConfigEntry`.
- Asset ref grammar (`[origin//]type:name`) and install ref grammar (distinct).
- Score range for `SearchHit.score`: `[0, 1]`, higher = better. One scoring
  pipeline (FTS5 + boosts) for all indexed content.
- Asset *type* is an open string set (§4.1); the renderer registry is the
  authority for "is this type well-known?".
- Asset *quality* is an open string set (§4.2); `"proposed"` is excluded from
  default search; `"generated"` and `"curated"` are included by default;
  unknown values parse-warn-include.
- `SearchHit.quality` and `SearchHit.warnings` are optional fields on the
  locked hit type.

### 9.2 Configuration (shipped + planned)

- Configuration JSON Schema, including literal-or-env value form and the
  `writable` flag.
- **`Planned for v1`** — `agent.*` block: `agent.default`,
  `agent.profiles[<name>]`, `agent.timeoutMs`. Unknown keys are
  warn-and-ignore. Missing `agent` block disables agent commands with a
  clear `ConfigError` (§12).
- **`Planned for v1`** — `llm.features.*` map with the keys named in §14.
  All defaults are `false`. Unknown feature keys warn and are ignored.

### 9.3 Errors and exit codes (shipped)

- Error classes own `.code`. No regex-on-message hint chain.
- Errors render to stderr as JSON envelope `{ok:false, error, code}`; `hint`
  is included when actionable.
- Exit codes: `USAGE = 2`, `CONFIG = 78`, `GENERAL = 1`.

### 9.4 CLI command surface

The v1 surface is **exhaustive**. Adding a new top-level command in v1.x
requires only that it register an output shape; renaming or removing is
major. The current and planned set is:

**Shipped pre-release (live today):**
`add | remove | list | update | search | show | clone | index | setup |
remember | import | feedback | registry * | info | curate | workflow * |
vault * | wiki * | enable | disable | completions | upgrade | save | help |
hints | config *`.

**`Planned for v1`** (declared by this spec, implemented across milestones
0.7 – 1.0):
- `agent <name> [args...]` — dispatch a configured agent profile (§12).
- `reflect [ref] [--task ...]` — produce reflection proposals into the
  proposal queue (§11, §12).
- `propose <type> <name> [--task ...]` — produce generation proposals into
  the proposal queue (§11, §12).
- `proposal list | show | accept | reject | diff` — operate the proposal
  queue (§11).
- `distill <ref>` — gated bounded LLM call producing a `lesson` proposal
  (§13, §14).

Renaming or removing any command above after v1.0 is a major version bump.

### 9.5 Output shapes (shipped)

- Output shape registry is exhaustive. Each command registers
  `{ shape, textRenderer }` at module load. No silent `JSON.stringify`
  fallback.
- New planned commands (§9.4) each register their own shape; the
  `proposal-list`, `proposal-show`, `proposal-diff`, `agent-result`,
  `reflect-result`, `propose-result`, and `distill-result` shapes are
  reserved.

### 9.6 Indexer and storage (shipped)

- v2 JSON index schema, owned by `static-index`.
- Index DB (`index.db`) is ephemeral; schema-version bumps may wipe and
  rebuild. `usage_events` is preserved across schema bumps.
- `workflow.db` (durable workflow run state) is never touched by index
  schema migrations.
- **`Planned for v1`** — the proposal queue (§11) is durable filesystem
  state under `<stashRoot>/.akm/proposals/`, managed by the proposal
  subsystem and untouched by index rebuilds.

### 9.7 LLM/agent boundary (planned)

**`Planned for v1`** — the boundary documented in §12 and §14 is a locked
invariant:

- **In-tree LLM helpers** (the `llm.*` config) make **bounded, single-shot,
  stateless** calls. They never spawn shells, manage processes, or persist
  state outside the call site. Each call site is gated behind exactly one
  `llm.features.*` flag and degrades cleanly when disabled or on failure.
- **External agents** (the `agent.*` config) are invoked via **CLI shell-out
  only**, through the spawn wrapper documented in §12. akm never imports
  vendor SDKs and never hosts a long-running agent process.

Crossing this boundary in either direction (calling out to a CLI from the
in-tree LLM path; calling vendor SDKs from the agent path) is a contract
violation.

#### Tested at

The boundary is locked by three seam-level tests under
`tests/architecture/`. They assert the integration **seams**, not the
implementation:

- `llm-stateless-seam.test.ts` — every export of `src/llm/*` is either a
  pure function or a factory returning a one-shot client. No module-level
  state holds session/conversation data across calls. The single
  module-level singleton (`localEmbedder` in `src/llm/embedder.ts`) is a
  stateless pipeline handle and exposes `resetLocalEmbedder()` for tests.
- `agent-spawn-seam.test.ts` — `runAgent(profile, prompt, options)` from
  `src/integrations/agent/spawn.ts` exposes the `AgentRunResult` envelope,
  the `AgentFailureReason` discriminated union (`"timeout" |
  "spawn_failed" | "non_zero_exit" | "parse_error"`), and the
  captured/interactive stdio modes documented in §12.2.
- `agent-no-llm-sdk-guard.test.ts` — regression-only file-content guard.
  It scans `src/integrations/agent/**` for known LLM SDK package names
  (e.g. `@anthropic-ai/sdk`, `openai`, `@google/generative-ai`) and
  fails if any are imported. **This guard is defence-in-depth**: the
  primary enforcement is the seam tests above and code review. The guard
  exists to surface accidental regressions in PRs.

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

- `src/registry/providers/static-index.ts` — owns the v2 JSON index schema.
- `src/registry/providers/skills-sh.ts` — extracts current skills.sh special-casing.
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

## 11. Proposal queue (`Planned for v1`)

All proposal-producing commands write through one durable queue. Live stash
content is never mutated by reflection, generation, or distillation paths.

### 11.1 Storage

- Proposals live as one directory per proposal under
  `<stashRoot>/.akm/proposals/<id>/`, each containing a single
  `proposal.json` file. The store is plain filesystem state and survives
  `akm index --full` and binary upgrades. Directory-per-id is what
  guarantees multiple proposals can coexist for the same `ref` without
  path collisions.
- A single `proposal.json` carries: `id` (UUID), `ref` (the target asset
  ref it would propose), `status` (`pending` | `accepted` | `rejected`),
  `source` (e.g. `"reflect"`, `"propose"`, `"distill"`, plugin id),
  `sourceRun` (opaque correlation id), `createdAt`, `updatedAt`,
  `payload.frontmatter`, `payload.content`, and an optional `review`
  block (`outcome`, `reason`, `decidedAt`).
- Rejected proposals are physically moved to
  `<stashRoot>/.akm/proposals/archive/<id>/`. The move is the archival
  state — there is no separate `archived` status, so the on-disk
  location is the source of truth for "active vs. archived" listings.
- Invalid `proposal.json` files are surfaced via `akm proposal list`
  with a clear warning entry. They do not crash the queue.
- The proposal store is queue state, not asset state, so it does **not**
  go through `writeAssetToSource()` for proposal writes themselves
  (only the eventual promotion in `accept` does). This is the single
  documented carve-out from the §5.4 write-helper rule, recorded in the
  module docblock of `src/core/proposals.ts`.

### 11.2 Commands

```sh
akm proposal list                       # list pending proposals
akm proposal list --status accepted     # filter by status
akm proposal show <id>                  # render one proposal
akm proposal diff <id>                  # diff vs. the live ref (if any)
akm proposal accept <id>                # validate, then promote
akm proposal reject <id> --reason "…"   # archive with reason
```

`accept` runs full validation (frontmatter, type-renderer, ref grammar,
write-source policy) **before** promoting. Promotion calls
`writeAssetToSource()` for the configured write target (§5.4) — same path
as `akm remember` / `akm import`.

`reject` writes review metadata (outcome, reason, decidedAt) and moves
the proposal directory under `<stashRoot>/.akm/proposals/archive/<id>/`.
The body is preserved.

`diff` shows the proposed delta against the live asset (or the empty file
if the proposal would create a new ref).

### 11.3 Events

The following events are emitted into `usage_events`:

| Event | When |
|---|---|
| `propose_invoked` | every successful `akm propose` call |
| `reflect_invoked` | every successful `akm reflect` call |
| `distill_invoked` | every successful `akm distill` call |
| `promoted` | `proposal accept` after validation passes |
| `rejected` | `proposal reject` |

All five event names are part of the v1 contract (§9.7). Plugin authors may
emit additional events but cannot reuse these names.

---

## 12. Agent CLI integration (`Planned for v1`)

External coding agents are invoked via CLI shell-out only. akm never imports
a vendor SDK.

### 12.1 Profiles

Built-in profiles ship for `opencode`, `claude`, `codex`, `gemini`, and
`aider`. A profile is a small record:

```ts
interface AgentProfile {
  readonly bin: string;                       // command to spawn
  readonly args: readonly string[];           // base args
  readonly stdio: "captured" | "interactive"; // capture for CI; interactive for users
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;                // overrides agent.timeoutMs
  readonly parseOutput?: "text" | "json";
}
```

Users can override or add profiles via `agent.profiles[<name>]` in config.
Unknown keys are warn-and-ignore (§9.2).

### 12.2 Spawn wrapper

One helper, `runAgent(profile, prompt, options)`, owns process spawn,
streaming or capture, hard timeout, and structured failure reasons. It
returns `{ ok, exitCode, stdout, stderr, durationMs, reason? }` where
`reason` is one of `"timeout" | "spawn_failed" | "non_zero_exit" |
"parse_error"`. The CLI never throws raw process errors past this wrapper.

### 12.3 Setup integration

`akm setup` detects installed agent CLIs (probe each profile's `bin` with
`--version`) and persists `agent.default` to the first one found. Users can
change the default with `akm config set agent.default <name>`.

### 12.4 Commands

```sh
akm agent <profile> [args...]            # raw shell-out
akm reflect <ref> [--task ...]           # produces reflection proposals
akm propose <type> <name> --task "..."   # produces generation proposals
```

`reflect` and `propose` build prompts from asset content, feedback signals
(§6.6), and renderer schema. They write **only** to the proposal queue
(§11). They never mutate live stash content. They emit `reflect_invoked` /
`propose_invoked` (§11.3).

Both commands return structured failures and exit non-zero on
CLI/timeout/parse/validation errors.

---

## 13. Lesson asset type (`Planned for v1`)

`lesson` is a first-class asset type with its own renderer and required
frontmatter.

### 13.1 Frontmatter contract

```yaml
---
description: required, single-line                # what this lesson teaches
when_to_use: required, single-line                # the trigger
tags: [optional]
sources: [optional, list of refs or URLs]
---

# Lesson body in markdown.
```

Lint validates `description` and `when_to_use` are present and non-empty.
Missing either field fails `akm wiki lint`-style validation in the
proposal-accept path.

### 13.2 Storage

`lessons/<name>.md` under the working stash, parallel to `memories/`,
`skills/`, etc. The directory is created lazily on first lesson write.

### 13.3 Origin

Lessons normally arrive via `akm distill <ref>` (§14.5) as `proposed`
quality (§4.2) and are promoted via `akm proposal accept`. They can also be
authored directly with `akm import` or `akm remember`-style flows.

---

## 14. `llm.features.*` (`Planned for v1`)

The in-tree LLM is intentionally bounded. Each call site is gated behind
exactly one feature flag. All defaults are `false` so that adding the flag
to the schema is itself a non-event.

### 14.1 Locked feature keys

| Key | Use site | Behaviour when disabled |
|---|---|---|
| `curate_rerank` | `akm curate` re-orders top-N results via LLM scoring | Curate falls back to the deterministic pipeline (no rerank) |
| `tag_dedup` | indexer LLM-deduplicates tags during enrichment | Dedup uses a deterministic string-equality pass |
| `memory_consolidation` | `akm remember --enrich` consolidation pass | `--enrich` is a no-op; warning printed |
| `feedback_distillation` | `akm distill <ref>` (§14.5) | `akm distill` exits with `ConfigError` and a hint |
| `embedding_fallback_score` | scorer fallback when no embeddings available | Scorer uses lexical-only score |
| `memory_inference` | In-tree LLM split of pending memories into atomic facts during `akm index`. | The memory-inference pass is a no-op; existing inferred children are preserved |
| `graph_extraction` | In-tree LLM extraction of entities and relations from `memory:` and `knowledge:` assets during `akm index`, persisted as a `graph.json` artifact under the stash that feeds the FTS5+boosts pipeline as a single boost component. | The graph-extraction pass is a no-op; an existing `graph.json` is preserved and continues to feed the boost component until it is stale or removed. |

#### `llm.features.<key>` and `index.<pass>.llm` are orthogonal

Some indexer LLM call sites are also addressable by the per-pass opt-out
key documented in §9 / `index.<pass>.llm` (e.g. `memory_inference`
corresponds to the `index.memory.llm` per-pass key, and `graph_extraction`
corresponds to `index.graph.llm`). The two surfaces are deliberately
orthogonal:

- `llm.features.<key>` governs whether the call is **permitted at all**.
  It is the locked feature gate (§14) — disabling it prevents every call
  site under that key from issuing a network request, regardless of any
  per-pass setting.
- `index.<pass>.llm` governs whether the indexer should **run that pass
  during this index** (§9). It is a runtime opt-out for the indexer's
  per-pass orchestration.

A pass runs iff `llm.features.<key> !== false` **AND** the per-pass
`index.<pass>.llm` is not `false`. Either flag set to `false` short-circuits
the pass to its disabled fallback.

### 14.2 Failure modes

Every LLM call site must:

- check the feature flag before any network call,
- enforce a hard timeout,
- catch parse errors and surface a structured `warnings` entry,
- **never** mutate state on failure.

A disabled or failing feature flag returns the deterministic fallback path.
Failure is observable but never blocks unrelated commands.

### 14.3 Configuration

```jsonc
{
  "llm": {
    "endpoint": "http://localhost:11434/v1/chat/completions",
    "model": "llama3.2",
    "temperature": 0.3,
    "maxTokens": 512,
    "features": {
      "curate_rerank":            false,
      "tag_dedup":                false,
      "memory_consolidation":     false,
      "feedback_distillation":    false,
      "embedding_fallback_score": false,
      "memory_inference":         true,
      "graph_extraction":         false
    }
  }
}
```

All seven keys are configurable, default `false`, and must be set to the
literal boolean `true` to opt in. (`memory_inference` and `graph_extraction`
were the first two to ship; the remaining five — `curate_rerank`,
`tag_dedup`, `memory_consolidation`, `feedback_distillation`,
`embedding_fallback_score` — landed alongside the lesson asset type.)
Unknown keys under `llm.features` warn and are ignored (§9.2).

#### Graceful-fallback contract

Every gated call site must use the `tryLlmFeature(feature, config, fn,
fallback, opts?)` wrapper (`src/llm/feature-gate.ts`) or follow the
equivalent inline pattern. The wrapper guarantees:

- **Disabled** → `fallback` is returned without ever calling `fn`.
- **Throw** → `fn`'s error is swallowed; `fallback` is returned. The
  caller may pass `onFallback` to surface a structured `warnings` entry.
- **Timeout** → a hard timeout (default 30s, override via `timeoutMs`)
  produces an `LlmFeatureTimeoutError`; `fallback` is returned.

Pure-predicate access is via `isLlmFeatureEnabled(config, feature)` — used
when the call site needs to branch on the gate without invoking the wrapper
(for example, to short-circuit before assembling the prompt).

### 14.4 Statelessness invariant

The in-tree LLM path holds no state across calls — no caches keyed on
prior responses, no streaming sessions, no persistent connections. Each
call is a single request/response cycle. Long-lived state belongs in the
agent path (§12).

### 14.5 `akm distill <ref>`

`akm distill <ref>` is the canonical example. It:

1. Reads `feedback` events (§6.6) for `<ref>`.
2. Builds one prompt summarising the feedback.
3. Issues a single bounded in-tree LLM call (gated by
   `llm.features.feedback_distillation`).
4. Writes the response as a `lesson` **proposal** (§13) into the queue
   (§11).
5. Emits `distill_invoked`.

It never mutates the live stash. Promotion remains a human-initiated
`akm proposal accept`.

---

## 15. Decisions (resolved)

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
// src/sources/providers/index.ts
import { createProviderRegistry } from "../create-provider-registry";

export const sourceRegistry = createProviderRegistry<SourceProvider>();
sourceRegistry.register("filesystem", (name) => new FilesystemSource(name));
sourceRegistry.register("git",        (name) => new GitSource(name));
sourceRegistry.register("website",    (name) => new WebsiteSource(name));
sourceRegistry.register("npm",        (name) => new NpmSource(name));
```

```ts
// src/registry/providers/index.ts
export const registryRegistry = createProviderRegistry<RegistryProvider>();
registryRegistry.register("static-index", (name) => new StaticIndexRegistry(name));
registryRegistry.register("skills-sh",    (name) => new SkillsShRegistry(name));
```

External plugin packages register into the same registries after load.

---

*End of specification.*
