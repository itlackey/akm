> **ARCHIVED 2026-07-05 (meta-review 14).** 0.6-era v1 planning spec, code-contradicted five ways by ship time (e.g. spec DB_VERSION 9 vs live 17); the owner declined a 1.0 freeze (review 10-Q1), so this is not a live contract.
> Current truth = `docs/technical/architecture.md` + `docs/technical/storage-locations.md`. Git history is the recovery path.

# akm v1 — Architecture Specification

**Status:** Draft for implementation (rev. 2026-04-27 — proposal/agent/lesson surfaces declared)
**Target:** v1.0 freeze
**Audience:** akm core contributors

> **Note (0.8.0):** Some configuration examples below — particularly
> references to `llm.features.*` — predate the 0.8.0 profiles tree. The
> shipping 0.8.0 config uses `profiles.improve.<name>.processes.*` for
> improve-bound gates and first-class `index.*` / `search.*` sections for
> non-improve features. See [`docs/configuration.md`](../configuration.md)
> for the current keys and
> [`docs/migration/v0.7-to-v0.8.md`](../migration/v0.7-to-v0.8.md) for the
> full old → new mapping. The spec sections below are retained for
> historical context and the v1.0 contract framing.

> **Reading guide.** This spec defines the v1.0 contract. It mixes shipped pre-release surfaces (sources, indexer, search, show, write-source, registry providers, vault, wiki, workflow, agent CLI integration, LLM/agent boundary) with **planned v1 surfaces** (proposal queue, `quality: "proposed"`, `lesson` asset type, `llm.features.*`). Planned surfaces are explicitly marked **`Planned for v1`** in their section heading and in §9. Implementation tracks against these declarations via `docs/reviews/v1-implementation-plan.md` and `docs/reviews/v1-agent-reflection-issues.md`. Anything in §9 — shipped or planned — is part of the locked contract once v1.0 ships.

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
  // No commit here — for any kind. See the 0.9.0 amendment below.
}
```

> **0.9.0 amendment (issue #507) — single batch-at-boundary commit.** The
> original v1 design committed (and optionally pushed) per asset write for
> `kind === "git"`, gated on `config.options.pushOnCommit`. That model staged
> only the single asset file (leaving `.akm/` state dirty) and produced one
> noisy commit per asset (~25 per improve run). It is **retired**. `writeAssetToSource`
> / `deleteAssetFromSource` now perform a plain filesystem write/unlink for
> **every** kind and never commit. Git-backed targets are committed **once** at
> the operation boundary by `commitWriteTargetBoundary(target, message, { push })`,
> which delegates to `saveGitStash` — `git add -A` (staging `.akm/` + sibling
> assets as one complete commit), a guarded commit, and a push gated on
> `writable && hasRemote && push !== false` (the same gate as `improve` sync
> push). The deprecated `pushOnCommit` knob still parses but only maps its push
> intent onto that gate and emits a one-time deprecation warning.

With the commit removed, `writeAssetToSource` no longer branches on `source.kind` for commit behaviour — the only remaining `kind` check is the unsupported-kind guard (filesystem / git only).

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
  // No commit here — for any kind (0.9.0 amendment, issue #507). The caller
  // fires commitWriteTargetBoundary() once after a batch of mutations.
}
```

Same pattern — symmetric with the write path, and likewise committed once at the operation boundary rather than per asset.

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
  `env`, `secret`, `wiki`, `task`, `session`, `fact`, and (Planned for v1)
  `lesson`. See
  §13. The `task` type stores cron-style scheduled invocations of workflows or
  prompts; `akm tasks` registers them with the OS-native scheduler (cron /
  launchd / schtasks). The `env` type stores a group of related configuration
  in a whole `.env` file (sourced or injected wholesale); key names are surfaced
  but values (sensitive or not) never appear in structured output and are used
  only via `akm env run` / `akm env export`. The `secret` type stores a single
  sensitive value used on its own for authentication (one per file); like `env`,
  the values never appear in structured output and are used only via
  `akm secret run` / `akm secret path`. The `session` type (#561) is a
  generated, searchable record of a prior agent session, written by the
  `extract` pass to `sessions/<harness>/<id>.md`; it carries `log_path` +
  `access` frontmatter so an agent can navigate into the raw session log, and an
  LLM `## Summary` / `## Key topics` body that is the searchable surface. The
  `fact` type stores durable stash-level semantic knowledge (personal/team/project
  details, coding conventions / "constitution", and stash-meta such as naming
  conventions or the active-projects list); `category` scopes the fact and
  `pinned: true` marks the small always-injected core (see
  `docs/design/fact-asset-type.md`).
- **Plugin-registered types** are allowed via `registerAssetType()` (see
  `src/core/asset-spec.ts`) and behave like well-known types as long as they
  register a renderer. Unknown types parse, index, and search; they render as
  raw markdown.
- The CLI never rejects an `AssetRef` because the type is unknown. The
  asset-ref grammar in Appendix A is the only enforced rule.

### 4.2 Asset quality rules (open set, default-filtered)

Search hits, registry hits, and indexed assets carry an optional `quality`
field. The contract is:

- The field is a string. Four values are well-known:
  - `"generated"` — produced by an automated pipeline. Included in default
    search.
  - `"curated"` — promoted by a human or via the proposal queue (§11).
    Included in default search.
  - `"enriched"` — LLM enrichment pass completed for this asset. Written by
    the indexer after a successful metadata-enhancement pass. Included in default search;
    subsequent index runs skip re-enrichment unless the caller explicitly requests it.
  - `"proposed"` — sitting in the proposal queue, not yet promoted.
    **Excluded from default search**; surfaced only with
    `--include-proposed` or via `akm proposal list` commands.
- Unknown quality values **parse, warn once, and remain searchable** (treated
  as included-by-default). They must not crash the indexer or the search
  pipeline.
- The legacy registry boolean `curated` is removed in v1. Legacy registry
  JSON containing `curated` parses and ignores the key (see §3.3 and
  `docs/archive/pre-1.0-migration.md`).

```ts
// src/core/types.ts
export type AssetQuality = "generated" | "curated" | "enriched" | "proposed" | (string & {});

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
      "options": { "url": "git+https://github.com/team/kit" },
      "writable": true },
    // 0.9.0: a writable git source with a remote is pushed by the single
    // boundary commit; the old per-asset `pushOnCommit` knob is deprecated.

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

  // Agent CLI integration (§12). Built-in profiles: opencode, claude, codex, gemini, aider.
  // Users can override built-ins or add new profiles. Unknown keys are warn-and-ignored.
  "agent": {
    "default": "opencode",
    "profiles": {
      "opencode": { /* built-in profile fields, overridable */ },
      // sdkMode profile example — no CLI binary required:
      "opencode-sdk": {
        "sdkMode": true,
        "model": "anthropic/claude-sonnet-4-5",
        "endpoint": "https://api.openai.com/v1",  // optional; inherits from llm.endpoint
        "apiKey": "sk-..."                         // optional; inherits from llm.apiKey
      }
    },
    "timeoutMs": 60000
  },

  // Planned for v1 — bounded in-tree LLM feature gates (§14).
  "llm": {
    "endpoint": "...",
    "model": "...",
    "features": {
      "curate_rerank":          false,
      "memory_consolidation":   false,
      "feedback_distillation":  false,
      "memory_inference":       true,
      "graph_extraction":       true,
      "lesson_quality_gate":    false,
      "metadata_enhance":       false
    }
  },

  "defaultWriteTarget": "mine"              // optional; falls back to working stash if omitted
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
   For website URLs, the single-page fetch/convert path lives in the shared
   `src/sources/website-ingest.ts` module rather than the website provider
   itself, so one-shot URL ingest and persistent website mirrors reuse the same
   normalization and markdown conversion logic.
2. Pick target: `--target <name>`, else `config.defaultWriteTarget`, else the user's working stash (`config.stashDir` — the source created by `akm setup`). `ConfigError` if none configured (hint: run `akm setup`).
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
    config.ts             # load, validate, resolve env references; getSources() helper
    output.ts             # exhaustive shape registry
    write-source.ts       # writeAssetToSource / deleteAssetFromSource
    parse.ts              # shared JSON parsing utilities (stripThinkBlocks, extractJson, …)
    concurrent.ts         # shared concurrency helpers

  providers/
    types.ts              # SourceProvider interface
    index.ts              # registration
    filesystem.ts
    git.ts
    website.ts
    npm.ts

  sources/
    website-ingest.ts     # shared website URL validation, fetch/convert, mirror generation

  providers/
    types.ts              # RegistryProvider interface
    index.ts              # registration
    static-index.ts       # owns the v2 JSON index schema
    skills-sh.ts          # owns skills.sh API wrapping

  asset-types/            # existing asset-spec.ts pattern, unchanged
  renderers/              # one file per type, three verbosity levels
  embedders/
  ingest/                 # ingest transformers

  integrations/
    agent/
      sdk-runner.ts       # @opencode-ai/sdk runner; enables CLI-free sdkMode profiles
      pipeline.ts         # shared propose/reflect agent pipeline (prompt → spawn/sdk → result)

  llm/
    call-ai.ts            # unified adapter: prefers config.agent, falls back to config.llm

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
  default search; `"generated"`, `"curated"`, and `"enriched"` are included by
  default; unknown values parse-warn-include.
- `SearchHit.quality` and `SearchHit.warnings` are optional fields on the
  locked hit type.

### 9.2 Configuration (shipped + planned)

- Configuration JSON Schema, including literal-or-env value form and the
  `writable` flag.
- `agent.*` block (shipped): `agent.default`, `agent.profiles[<name>]`,
  `agent.timeoutMs`. Profile fields include `bin`, `args`, `stdio`, `env`,
  `envPassthrough`, `timeoutMs`, `parseOutput`, `sdkMode`, `model`,
  `endpoint`, `apiKey`. Unknown keys are warn-and-ignore. Missing `agent`
  block disables agent commands with a clear `ConfigError` (§12).
- **`Planned for v1`** — `llm.features.*` map with the keys named in §14.
  Locked keys: `curate_rerank`, `memory_consolidation`, `feedback_distillation`,
  `memory_inference`, `graph_extraction`, `lesson_quality_gate`, and
  `metadata_enhance`. Defaults are mixed: `memory_inference` and
  `graph_extraction` default to `true`; the rest default to `false`.
  Unknown keys warn and are ignored. (`tag_dedup` and
  `embedding_fallback_score` were removed in 0.7.0 as phantom keys that were
  never read at any call site.)

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
vault * | wiki * | graph * | enable | disable | completions | upgrade | save | help |
hints | config *`.

`akm setup` accepts the following flags:
- `--config <json>` — apply config JSON non-interactively (scripting/CI mode).
- `--yes` — accept all defaults, skip all prompts (idempotent, safe for CI).
- `--dir <path>` — stash directory path (overrides `stashDir` in config or `--config` JSON).
- `--probe` — probe LLM/embedding endpoints after writing config to verify connectivity.
- `--no-init` — skip the `akmInit()` call (useful when the stash directory already exists).

**Shipped in pre-release milestones (0.7–0.8):**
- `proposal list` / `proposal show` / `proposal diff` / `proposal accept` /
  `proposal reject` / `proposal revert` — operate the proposal queue (§11). The
  flat verbs (`proposals` / `show proposal` / `accept` / `reject` / `diff` /
  `revert`) remain as deprecated aliases, removed in 0.9.0. Note: `--type` filter
  on `akm proposal list` is declared but silently ignored in the current
  implementation; use `--ref` to filter instead.
- `improve [ref|type] [--task ...]` — produce improvement proposals into the
  proposal queue (§11, §12).
- `propose <type> <name> [--task ...]` — produce generation proposals into
  the proposal queue (§11, §12).

**`Planned for v1`** (declared by this spec, implemented across milestones
0.9 – 1.0):
- `agent <profile> [--prompt <text>] [--command <ref>] [--workflow <ref>] [args...]`
  — dispatch a configured agent profile with an optional prompt sourced from inline
  text or from a `command:` or `workflow:` asset ref (§12).

Memory consolidation runs automatically as part of `akm improve` whenever
`llm.features.memory_consolidation` is enabled (§14.6). It is not a separate
command and has no dedicated flag — the feature flag is the sole control.

Renaming or removing any command above after v1.0 is a major version bump.

### 9.5 Output shapes (shipped)

- Output shape registry is exhaustive. Each command registers
  `{ shape, textRenderer }` at module load. No silent `JSON.stringify`
  fallback.
- New planned commands (§9.4) each register their own shape; the
  `proposal-list`, `proposal-show`, `proposal-diff`, `agent-result`,
  `improve-result` and `propose-result` shapes are
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

### 9.7 LLM/agent boundary (shipped)

The boundary documented in §12 and §14 is a locked invariant:

- **In-tree LLM helpers** (the `llm.*` config) make **bounded, single-shot,
  stateless** calls. They never spawn shells, manage processes, or persist
  state outside the call site. Each call site is gated behind exactly one
  `llm.features.*` flag and degrades cleanly when disabled or on failure.
- **External agents** (the `agent.*` config) are invoked via CLI shell-out
  through the spawn wrapper documented in §12.2, **or** via the embedded
  `@opencode-ai/sdk` when a profile has `sdkMode: true` (§12.1). The SDK
  runner (`src/integrations/agent/sdk-runner.ts`) enables CLI-free agentic
  commands; it does not import any Anthropic/OpenAI SDK directly — it delegates
  to the OpenCode SDK's own HTTP layer.

**`callAi()` adapter** (`src/llm/call-ai.ts`) — shipped. This unified adapter
is used by `propose` and `reflect` to prefer the `config.agent` path (CLI
shell-out or SDK mode) and fall back to `config.llm` (HTTP chat-completions)
when no agent CLI is installed. When neither is configured it returns a
structured error pointing the user at `akm setup`. It is **not** for use by
background indexer passes, which call `chatCompletion` directly.

Crossing the boundary in either direction (calling vendor SDKs from the agent
path outside the sanctioned SDK runner; calling out to a CLI from the in-tree
LLM feature-gate path) remains a contract violation.

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
  fails if any are imported directly. The `@opencode-ai/sdk` import in
  `sdk-runner.ts` is the single sanctioned exception — it uses a dynamic
  `import()` so failures surface as a structured `spawn_failed` result
  rather than a crash. **This guard is defence-in-depth**: the primary
  enforcement is the seam tests above and code review.

---

## 10. Refactor plan from 0.6.0

Ordered. Each step leaves the build green.

### Step 1 — Drop OpenViking **[COMPLETE]**

Remove `src/stash-providers/openviking.ts`, its tests, its registration, its config migration path. Document as "deferred to post-v1 when API-backed sources get their own tier."

Users with `openviking` in their config get a `ConfigError` at load with a hint pointing at the deferral note.

This single change removes most of the architectural complication the 0.6.0 code is carrying.

### Step 2 — Rename `stash` → `source` throughout **[COMPLETE]**

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

## 11. Proposal queue (shipped)

All proposal-producing commands write through one durable queue. Live stash
content is never mutated by reflection, generation, or distillation paths.

### 11.1 Storage

- Proposals live as rows in the `proposals` table of `state.db` (SQLite,
  WAL mode — the same durable database that holds events and improve
  runs). Each row is keyed by a random UUID `id`, so multiple proposals
  can coexist for the same `ref` without collisions, and is partitioned
  by `stash_dir` so multi-stash installs keep independent queues. The
  store is non-regenerable state and survives `akm index --full` and
  binary upgrades.
- A proposal row carries: `id` (UUID), `ref` (the target asset
  ref it would propose), `status` (`pending` | `accepted` | `rejected` |
  `reverted`),
  `source` (e.g. `"reflect"`, `"propose"`, `"distill"`, plugin id),
  `sourceRun` (opaque correlation id), `createdAt`, `updatedAt`,
  `payload.frontmatter`, `payload.content`, and an optional `review`
  block (`outcome`, `reason`, `decidedAt`).
- Archival is a status flip, not a move: any non-`pending` status is
  archived. There is no separate `archived` flag — the `status` column
  is the source of truth for "active vs. archived" listings.
- Legacy import: stashes created before 0.9.0 stored proposals as
  per-uuid JSON directories under `<stashRoot>/.akm/proposals/<id>/`
  (each containing a `proposal.json`, with archived entries moved under
  `…/proposals/archive/<id>/`). The first proposal operation against
  such a stash imports those files into the `proposals` table (keyed on
  the UUID, so re-runs never duplicate) and records the stash in
  `proposal_fs_imports`; the legacy files are left in place as inert
  artifacts.
- The proposal store is queue state, not asset state, so it does **not**
  go through `writeAssetToSource()` for proposal writes themselves
  (only the eventual promotion in `accept` does). This is the single
  documented carve-out from the §5.4 write-helper rule, recorded in the
  module docblock of `src/commands/proposal/validators/proposals.ts`.

### 11.2 Commands

```sh
akm proposal list                       # list pending proposals
akm proposal list --status accepted     # filter by status
akm proposal show <id>                  # render one proposal
akm proposal diff <id>                  # diff vs. the live ref (if any)
akm proposal accept <id>                # validate, then promote
akm proposal reject <id> --reason "…"   # archive with reason
akm proposal revert <id>                # restore the pre-promotion content
```

The flat verbs `akm proposals`, `akm show proposal <id>`, `akm accept`,
`akm reject`, `akm diff`, and `akm revert` remain as deprecated aliases that
warn on stderr and delegate to the `akm proposal <verb>` forms above. They are
removed in 0.9.0.

`accept` runs full validation (frontmatter, type-renderer, ref grammar,
write-source policy) **before** promoting. Promotion calls
`writeAssetToSource()` for the configured write target (§5.4) — same path
as `akm remember` / `akm import`.

`reject` writes review metadata (outcome, reason, decidedAt) and flips the
row's status to `rejected`, archiving it out of the live queue.
The body is preserved.

`diff` shows the proposed delta against the live asset (or the empty file
if the proposal would create a new ref).

### 11.3 Events

The following events are emitted into `usage_events`:

| Event | When |
|---|---|
| `improve_invoked` | every successful `akm improve` call |
| `promoted` | `accept` after validation passes |
| `rejected` | `reject` |

All three event names are part of the v1 contract (§9.7). Plugin authors may
emit additional events but cannot reuse these names.

---

## 12. Agent CLI integration (shipped)

External coding agents are invoked via CLI shell-out or, for profiles with
`sdkMode: true`, via the embedded `@opencode-ai/sdk` runner
(`src/integrations/agent/sdk-runner.ts`). The SDK runner enables CLI-free
agentic commands: no `bin` on PATH is required when `sdkMode` is true.

### 12.1 Profiles

Built-in profiles ship for `opencode`, `claude`, `codex`, `gemini`, and
`aider` (plus `-headless` variants for automation). A profile is a small record:

```ts
interface AgentProfile {
  readonly name: string;
  readonly bin: string;                       // command to spawn (ignored when sdkMode is true)
  readonly args: readonly string[];           // base args
  readonly stdio: "captured" | "interactive"; // capture for CI; interactive for users
  readonly env?: Record<string, string>;
  readonly envPassthrough: readonly string[]; // env vars forwarded to the child process
  readonly timeoutMs?: number;                // overrides agent.timeoutMs
  readonly parseOutput: "text" | "json";
  /** When true, uses the embedded @opencode-ai/sdk instead of Bun.spawn. No CLI binary required. */
  readonly sdkMode?: boolean;
  /** Model identifier for sdkMode (e.g. "anthropic/claude-sonnet-4-5", "ollama/qwen2.5-coder"). */
  readonly model?: string;
  /** OpenAI-compatible endpoint for sdkMode. If absent, inherits from config.llm.endpoint. */
  readonly endpoint?: string;
  /** API key for sdkMode endpoint. If absent, inherits from config.llm.apiKey. */
  readonly apiKey?: string;
}
```

The persisted user-override shape (`AgentProfileConfig` in
`src/integrations/agent/config.ts`) mirrors these fields — every field is
optional so users can override one piece of a built-in without re-stating the
rest.

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
# Dispatch a named agent profile.
# Prompt may be supplied inline, or sourced from a command or workflow asset.
akm agent <profile> [--prompt <text>] [--command <ref>] [--workflow <ref>] [args...]

# Produces improvement proposals (writes only to the proposal queue)
akm improve [ref] [--task ...]
```

`akm agent <profile>` resolves the profile via `requireAgentProfile()`, then:
1. Resolves the prompt: if `--command <ref>` or `--workflow <ref>` is given, the
   asset is looked up via the index and its body becomes the prompt (with template
   placeholders filled by any remaining `args`). If `--prompt` is given, that text
   is used directly. If neither is given, the agent is launched interactively with
   no injected prompt (equivalent to the bare shell-out described in §12.1).
2. Routes to `runAgentSdk()` when the profile has `sdkMode: true`, else to
   `runAgent()` (Bun.spawn).
3. Returns an `agent-result` envelope. When `stdio: "interactive"`, stdout and
   stderr are empty (output went to the TTY); the text renderer emits only the
   profile name and exit status.

`improve` builds prompts from asset content, feedback signals (§6.6), and
renderer schema. It writes **only** to the proposal queue (§11). It never
mutates live stash content. It emits `improve_invoked` (§11.3).

When reinforced memory facts are consolidated into proposals, `knowledge` is
the more authoritative destination. The deterministic search pipeline also
ranks `knowledge` above `memory` hits, including inferred `.derived`
memories, when the other signals are otherwise comparable.

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

Lessons normally arrive via `akm improve <ref>` (§14.5) as `proposed`
quality (§4.2) and are promoted via `akm proposal accept`. They can also be
authored directly with `akm import` or `akm remember`-style flows.

---

## 14. `llm.features.*` (`Planned for v1`)

The in-tree LLM is intentionally bounded. Each call site is gated behind
exactly one feature flag. Defaults are mixed by design: `memory_inference`
and `graph_extraction` default to `true`; other locked keys default to
`false`.

### 14.1 Locked feature keys

Seven keys are locked in the v1 contract. (`tag_dedup` and `embedding_fallback_score`
were removed in 0.7.0 — they were declared but never read at any call site.)

| Key | Use site | Behaviour when disabled |
|---|---|---|
| `curate_rerank` | `akm curate` re-orders top-N results via LLM scoring | Curate falls back to the deterministic pipeline (no rerank) |
| `memory_consolidation` | `akm improve` consolidation phase — agent-driven cross-memory dedup, merging, and promotion into `knowledge:` assets (§14.6) | Consolidation returns an immediate no-op result (`processed: 0`) |
| `feedback_distillation` | improve-driven lesson distillation (§14.5) | improve skips lesson distillation cleanly when disabled |
| `memory_inference` | In-tree LLM split of pending memories into atomic facts during the memory-maintenance / improve-owned flow. | The memory-inference pass is a no-op; existing inferred children are preserved |
| `graph_extraction` | In-tree LLM extraction of entities and relations from `memory:` and `knowledge:` assets during the graph-refresh / improve-owned flow, persisted in SQLite graph tables inside `index.db` and fed into the FTS5+boosts pipeline as a single boost component. The stored artifact includes considered-but-empty file rows, extractor provenance (`extractor_id`, `extraction_run_id`), and latest-run telemetry (model, prompt version, batch size, cache hits/misses, truncation count, failure count). | The graph-extraction pass is a no-op; existing graph rows are preserved and continue to feed the boost component until later refresh or rebuild. |
| `lesson_quality_gate` | LLM-as-judge quality scoring in `akm distill` | Judge step is skipped; distillation proceeds without judge scoring |
| `metadata_enhance` | `akm index` metadata enhancement pass | Metadata enhancement is skipped (no description/searchHints/tags enrichment) |

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
      "curate_rerank":          false,
      "memory_consolidation":   false,
      "feedback_distillation":  false,
      "memory_inference":       true,
      "graph_extraction":       true,
      "lesson_quality_gate":    false,
      "metadata_enhance":       false
    }
  }
}
```

All seven keys are configurable. `memory_inference` and `graph_extraction`
default to `true`; the remaining keys default to `false`. Boolean `false`
always disables a feature. (`memory_inference` and `graph_extraction` were
the first two to ship. `memory_consolidation` gates the agent-driven
consolidation pass described in §14.6.)
Unknown keys under `llm.features` warn and are ignored (§9.2).

#### Graceful-fallback contract

Every gated call site must use the `tryLlmFeature(feature, config, fn,
fallback, opts?)` wrapper (`src/llm/feature-gate.ts`) or follow the
equivalent inline pattern. The wrapper guarantees:

- **Disabled** → `fallback` is returned without ever calling `fn`.
- **Throw** → `fn`'s error is swallowed; `fallback` is returned. The
  caller may pass `onFallback` to surface a structured `warnings` entry.
- **Timeout** → a hard timeout (default 600s / 10 minutes, override via `timeoutMs`)
  produces an `LlmFeatureTimeoutError`; `fallback` is returned.

Pure-predicate access is via `isLlmFeatureEnabled(config, feature)` — used
when the call site needs to branch on the gate without invoking the wrapper
(for example, to short-circuit before assembling the prompt).

### 14.4 Statelessness invariant

The in-tree LLM path holds no state across calls — no caches keyed on
prior responses, no streaming sessions, no persistent connections. Each
call is a single request/response cycle. Long-lived state belongs in the
agent path (§12).

### 14.5 Improve-driven lesson distillation

`akm improve <ref>` is the canonical example. It:

1. Reads `feedback` events (§6.6) for `<ref>`.
2. Builds one prompt summarising the feedback.
3. Issues a single bounded in-tree LLM call (gated by
   `llm.features.feedback_distillation`).
4. Writes the response as a `lesson` **proposal** (§13) into the queue
   (§11).
5. Emits `improve_invoked`.

It never mutates the live stash. Promotion remains a human-initiated
`akm proposal accept`.

### 14.6 Agent-driven memory consolidation (`Planned for v1`)

Memory consolidation is intentionally placed on the **agent path** (§12), not the
in-tree LLM path (§14.4). Cross-memory deduplication and merging is a multi-step
agentic task — it requires iterative reads, comparison, and targeted rewrites — and
cannot be bounded to a single stateless request/response cycle.

Consolidation runs automatically as part of `akm improve` when
`llm.features.memory_consolidation` is enabled. It is not a separate command and
has no dedicated flag — the feature flag is the sole on/off control.

When the feature is disabled, `akmConsolidate()` returns immediately with
`processed: 0` and no output is emitted. No `ConfigError` is thrown.

Consolidation shares all of `improve`'s existing flags without adding new ones:

```sh
akm improve                          # improve + consolidate (if feature enabled)
akm improve --dry-run                # plan without writing (both improve and consolidate)
akm improve --target <name>          # target a specific source
akm improve --auto-accept=false      # disable auto-accept (interactive prompt on HTTP path)
akm improve --auto-accept=90         # explicit threshold (default when flag is absent)
akm improve --task "..."             # extra AI guidance for both passes
akm improve memory:my-note           # improve a specific ref; consolidation skipped
```

Consolidation is skipped when a specific asset ref is passed as the scope
(e.g. `memory:my-note` contains `:`). It runs when scope is absent or is a
type-level scope like `memory`.

1. **Collect** all `memory:` assets from configured writable sources.
2. **Phase A — Plan**: sends chunked memory summaries (300 chars/body, 12 per chunk
   on HTTP path; 1000 chars/body, 30 per chunk on agent path) to `callAi()`. Each
   chunk returns a list of `merge`, `delete`, and `promote` operations without full
   merged content — just refs and strategy. Plans from multiple chunks are merged,
   with `merge` taking precedence over `delete` when the same ref appears in both.
3. **Phase B — Merge content**: for each `merge` operation, a separate `callAi()`
   call receives the full bodies of primary and secondaries and returns the merged
   markdown as plain text. This phase-split avoids embedding full markdown inside
   plan JSON (which corrupts parse pipelines).
4. **Write changes** — before any writes: back up secondaries and write a
   `.akm/consolidate-journal.json`. Then:
   - Merges: overwrite primary via `writeAssetToSource()`, delete secondaries via
     `deleteAssetFromSource()`.
   - Deletes: `deleteAssetFromSource()`.
   - Promotes: `createProposal()` into the proposal queue (§11) — human review
     required before promotion lands in the live stash. Source memory is not deleted.
5. **Emit event**: `consolidation_run` into `usage_events`. Clean up journal and
   backups on success.

#### Why agent, not in-tree LLM

In-tree LLM calls are single-shot and stateless (§14.4). Consolidation requires
reading many assets, comparing them, and executing writes — more than one request
can encode. The agent path can paginate, chain calls, and use akm tools within a
session. When only `config.llm` is configured (no agent), the HTTP path is used
but operations are not auto-executed: `--execute` is required, and `--yes` or
interactive confirmation is required for destructive steps.

#### Graceful fallback when no agent is configured

`callAi()` routes to `config.llm` (§9.7) for plan generation. The HTTP path emits
a `warnings[]` entry noting the reduced context quality, and requires `--execute`
to apply any operations (without it, the command is effectively `--preview-with-ai`).

#### Output shape

The `consolidate-result` shape is reserved in the output shape registry (§9.5).
It carries: `processed` (count), `merged` (count), `deleted` (count),
`promoted` (list of new proposal IDs), `warnings`, and `durationMs`.

---

## 15. Decisions (resolved)

The four open questions originally listed here are resolved as of 2026-04-24. They are now part of the locked v1 contract (see §9).

1. **`writable` default on `filesystem`: `true`.** Users usually own the directories they point akm at. Read-only filesystem sources require explicit `writable: false`.
2. **Registry results in default `akm search`: behind `--include-registry`.** Default output stays scannable. Registry results never merge into source hits (§6.1).
3. **Write-target resolution: explicit `--target` → `config.defaultWriteTarget` → working stash (`config.stashDir`).** The working stash created by `akm setup` (which calls `akmInit()` internally) is the implicit fallback. There is no "first-writable-in-source-array-order" fallback — it produced ambiguity without payoff.
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
