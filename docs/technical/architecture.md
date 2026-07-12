# Architecture

akm is a Bun-based CLI for discovering and using agent assets from local
filesystem sources, cache-backed sources (git, website, npm), and registry
catalogs.

This document is the operating summary of the current architecture and is the
current-truth reference. The historical v1 planning spec is archived at
`docs/archive/v1-architecture-spec.md` (archived 2026-07-05; not a live contract).

---

## Asset Types

Built-in asset types are:

- `skill`
- `command`
- `agent`
- `knowledge`
- `workflow`
- `script`
- `memory`
- `lesson`
- `fact`
- `env`
- `secret`
- `wiki`
- `task`
- `session`

The deprecated `vault` type was removed in 0.9.0 and replaced by `env` (whole
`.env` files) and `secret` (single-value secret files).

Each type maps to a canonical source directory through `src/core/asset/asset-spec.ts`
(`skills/`, `commands/`, `agents/`, `knowledge/`, `workflows/`, `scripts/`,
`memories/`, `lessons/`, `facts/`, `env/`, `secrets/`, `wikis/`, `tasks/`,
`sessions/`).

---

## Sources and Source Providers

A **source** is a directory plus a way to refresh it from upstream. There are
exactly four source provider types:

- `filesystem` — a local path the user owns
- `git` — a git working tree mirrored under akm's cache
- `website` — recrawled and converted to markdown
- `npm` — installed into the cache

All four kinds expose the same minimal `SourceProvider` interface
(`src/sources/source-provider.ts`):

```ts
interface SourceProvider {
  readonly name: string;
  readonly kind: string;            // "filesystem" | "git" | "website" | "npm"
  init(ctx: ProviderContext): Promise<void>;
  path(): string;                   // directory the indexer walks
  sync?(): Promise<void>;           // refresh from upstream (no-op for filesystem)
}
```

Providers do **not** implement `search`, `show`, `canShow`, or any read method.
The indexer walks `path()`, classifies files, and answers all queries from the
local FTS5 index.

The legacy `LiveStashProvider` / `SyncableStashProvider` split is gone, as is
any "remote-only" provider tier. API-backed sources (mem0, Notion, etc.) are
deferred to a separate `QuerySource` tier post-v1.

### Cache-backed sources are still indexed locally

`git`, `website`, and `npm` all materialise files into a cache directory under
`$XDG_CACHE_HOME/akm/`. Once mirrored, they participate in the same local
indexing pipeline as filesystem sources. There is no parallel scoring system
for "remote" content.

---

## Refs

User-facing asset refs are flat:

```text
[origin//]type:name
```

- `type:name` is the canonical asset identity
- optional `origin//` narrows lookup to a configured source
- refs are parsed by `parseAssetRef` in `src/core/asset-ref.ts`
- markdown-backed asset types strip `.md` from canonical names

Examples:

- `skill:code-review`
- `workflow:release/train`
- `team//command:deploy`

URI schemes (`viking://...`, `github://...`) are **not** asset refs. Install
locators like `github:owner/repo`, `git+https://...`, `npm:@scope/pkg`,
`skills.sh:slug`, and `./local/path` are a separate grammar parsed by
`parseRegistryRef` in `src/registry/resolve.ts` and consumed by
`akm add` / `akm clone`.

---

## Search Pipeline

There is **one** scoring pipeline for all indexed content:

1. multi-column FTS5 search
2. BM25 normalization
3. optional semantic / vector scoring
4. metadata, type, and utility boosts

Indexed field weighting:

- `name` ×10
- `description` ×5
- `tags` ×3
- `hints` ×2
- `content` ×1

Notes:

- `hints` includes `searchHints`, `examples`, `usage`, intent fields, wiki
  cross-references, and page-kind hints
- `content` is primarily TOC headings plus parameter names/descriptions
- registry results live in `registryHits`, never in `hits`
- `--source both` keeps registry results in `registryHits` — they are not
  rank-merged with source hits

`akm search` is implemented in `src/commands/read/search.ts` and queries the
indexer's local search (`src/indexer/search/db-search.ts`). Provider fan-out is gone.

---

## Show Resolution

`akm show` queries the local FTS5 index, then reads the file from disk.

Local show flow (`src/commands/read/show.ts`):

1. parse `[origin//]type:name`
2. `lookup(ref)` against the FTS5 index (`src/indexer/indexer.ts`)
3. fall back to on-disk type-dir traversal only when the index has no row
   (covers the "indexed yet?" gap before `akm index` runs)
4. classify the file and render a response

There is **no remote provider fallback**. Show is local FTS5 only.

Special case: `wiki:<name>` with no page path returns the wiki root summary
payload rather than a single markdown page response.

---

## Writing to Sources

Writes go through one helper: `src/core/write-source.ts`. This is the only
place in the codebase that branches on `source.kind`.

```ts
writeAssetToSource(source, config, ref, content)
deleteAssetFromSource(source, config, ref)
```

The flow:

1. Refuse if the source is not `writable`.
2. Plain filesystem write to `path.join(source.path, …)` — for **every** kind,
   with no commit (0.9.0, issue #507).

Git-backed targets are committed in a single batch at the operation boundary via
`commitWriteTargetBoundary(target, message, { push })`, which delegates to
`saveGitStash`: write/delete helpers carry their exact changed paths to the
boundary, which stages and commits only those files (so unrelated staged work,
including work under the same asset directory, is not included). Improve
auto-sync similarly subtracts the Git dirty-path baseline captured at invocation
start. Push remains gated on `writable && hasRemote && push !== false`. The old
per-asset commit/push path (`options.pushOnCommit`) is deprecated and no longer
commits per asset.

`writable` is a config flag, not an interface concern. Defaults: `true` for
`filesystem`, `false` for everything else. `writable: true` on `website` or
`npm` is rejected at config load — `sync()` would clobber edits on the next
refresh.

Write-target resolution (`resolveWriteTarget`) follows: explicit `--target` →
`config.defaultWriteTarget` → working stash (`config.stashDir`) → `ConfigError`.

### Improve durable-state transition

Improve state written after the source-identity cutover uses
`source//type:name` keys. Pre-cutover bare feedback, proposal-cursor, salience,
and convergence rows are read as a fallback only when the selected source root
equals the configured historical `stashDir`. A qualified row takes precedence.
Named sources at any other root never read bare rows, preventing a duplicate ref
from inheriting the local stash's history. New writes are always qualified, so
the fallback naturally becomes irrelevant as local assets accumulate new state.

Retrieval demand is scoped separately through usage-event entry IDs and selected
source roots, with qualified refs covering detached events. Improve never merges
retrieval counts or last-use timestamps solely by bare ref across sources.

---

## Registry Providers

Registry providers are read-only catalogs of installable kits. The interface
lives in `src/registry/providers/types.ts`:

```ts
interface RegistryProvider {
  readonly type: string;            // "static-index" | "skills-sh"
  search(options): Promise<RegistryProviderResult>;
  searchKits(q): Promise<KitResult[]>;
  searchAssets?(q): Promise<AssetPreview[]>;
  getKit(id): Promise<KitManifest | null>;
  canHandle(ref: ParsedRegistryRef): boolean;
}
```

Built-in registries:

| Kind | Role |
| --- | --- |
| `static-index` | Reads the v2 JSON index schema (official akm registry, team mirrors). |
| `skills-sh` | Wraps the skills.sh REST API. |

Context Hub is **not** a registry provider type. It is just a recommended git
kit installable through the official static-index registry like any other
source.

---

## Workflow Runtime State

Workflow definitions live in `workflows/`, but workflow run state is separate
runtime state stored in `workflow.db`.

- workflow discovery and search use the shared asset index
- workflow run records survive index rebuilds
- workflow run state is not derived from the FTS index

---

## Utility Scoring

Utility is feedback-driven and rebuilt from `usage_events`.

- usage history is preserved across schema resets and full rebuilds
- detached events are re-linked to fresh entry ids by ref
- decay is time-proportional, not tied to index frequency

---

## Errors

`ConfigError`, `UsageError`, and `NotFoundError` (in `src/core/errors.ts`) each
carry a stable `code` and a `hint(): string | undefined` method. The CLI
surfaces hints by calling `error.hint()` directly — there is no regex chain
parsing error messages.

All three extend a shared abstract base `AkmError` carrying a `kind`
discriminant (`"config" | "usage" | "not-found"`). The CLI exit-code classifier
(`classifyExitCode` in `src/cli/shared.ts`) switches exhaustively on `kind`
(`never`-checked via `assertNever`), so adding a new error class is a
compile-time error until its exit code is mapped. Any thrown value that is
**not** an `AkmError` is treated as an unexpected internal failure and maps to
the distinct INTERNAL exit code **70** (sysexits `EX_SOFTWARE`) — this lets
scripts tell "akm threw unexpectedly" apart from an ordinary `NotFoundError`
(exit 1).

| Class / case | Exit code |
| --- | --- |
| `ConfigError` (`kind: "config"`) | 78 |
| `UsageError` (`kind: "usage"`) | 2 |
| `NotFoundError` (`kind: "not-found"`) | 1 |
| unclassified / non-`AkmError` (INTERNAL) | 70 |

---

## Engine Boundary

Public execution selection uses named `engines`, never profiles. An engine is
either `kind: "llm"` (an OpenAI-compatible chat-completions connection) or
`kind: "agent"` (a registered harness platform). `resolveEngine()` lowers the
selected engine into the internal `RunnerSpec` tagged union; the SDK runtime is
an internal lowering of an `opencode-sdk` agent engine, not a public engine kind.
`resolveLlmEngineUse()` selects and overlays one LLM engine without materializing
its symbolic credential until dispatch.

`executeRunner()` is the sole exhaustive switch over `RunnerSpec`. Callers pass
their own LLM handler for the LLM arm; agent and SDK arms use the harness runner.
There is no generic `callAi` adapter: LLM-only processes call the bounded
`chatCompletion()` client with their frozen connection, while mixed runner
surfaces dispatch a frozen `RunnerSpec` through `executeRunner()`.
An explicit missing or incompatible engine is an error and never falls through to
another configured engine. Workflow v3 plans freeze the configured workflow cap,
exact models, symbolic credentials, selected LLM-engine concurrency, and effective
timeout. Dispatch uses the minimum of map width, frozen workflow cap, frozen
LLM-engine cap, and the current host's CPU-derived safety cap.
Timeout authority lives on each frozen invocation, not in engine catalog entries;
an SDK invocation still derives its default timeout from its fallback LLM engine
when the SDK engine does not set one.

### In-tree LLM helpers (`src/llm/`)

Every helper under `src/llm/` is a **bounded, single-shot, stateless** call.
Concretely:

- Each public export is either a pure function (`chatCompletion`,
  `enhanceMetadata`, `splitMemoryIntoAtomicFacts`, `resolveIndexPassLLM`,
  `parseJsonResponse`, …) or a factory that returns a one-shot client tied to
  the connection config the caller passes in.
- No module under `src/llm/` keeps session, conversation, or response state at
  module scope. The only module-level singleton is the local embedder
  pipeline in `src/llm/embedder.ts`, which is an expensive-to-build but
  stateless model handle (see the comment in that file). It exposes
  `resetLocalEmbedder()` so tests can construct a fresh pipeline.
- Improve processes are selected through `improve.strategies` and resolve their
  engine before dispatch. Index and other non-improve consumers use their own
  documented engine-use sections. See `docs/configuration.md` for canonical
  paths.

The seam is locked by `tests/architecture/llm-stateless-seam.test.ts`, which
inspects the module shape of each `src/llm/*` entry — not the source text.

### External agents (`src/integrations/agent/`)

External coding agents are reachable via two execution paths:

**Spawn path** (`src/integrations/agent/spawn.ts`):

- `runAgent(profile, prompt, options)` is the single shell-out entry point.
  It owns process spawn, captured/interactive stdio, hard timeout, and
  structured failure reasons.
- The `AgentRunResult` envelope carries `{ ok, exitCode, stdout, stderr,
  durationMs, reason?, error?, parsed? }` where `reason` is one of
  `"timeout" | "spawn_failed" | "non_zero_exit" | "parse_error"`. Callers
  never see raw process errors.

**SDK path** (`src/integrations/harnesses/opencode-sdk/sdk-runner.ts`):

- `runOpencodeSdk(profile, prompt, opts, llmConfig?)` uses the embedded
  `@opencode-ai/sdk` instead of `Bun.spawn`. No agent CLI binary is required.
- Selected by an agent engine whose `platform` is `"opencode-sdk"`. Its optional
  `llmEngine` (then `defaults.llmEngine`) supplies the LLM fallback connection.
- Manages a single per-process singleton server, creating one fresh session
  per call to avoid history accumulation and unbounded token growth.
- Concurrent calls share startup by server material, but each call races that
  startup against its own deadline (including `null`); no caller's timeout is
  stored in the shared lifecycle.

Prompt tasks are versioned task YAML v2 assets. They resolve `engine` from the
task or `defaults.engine`; LLM prompt tasks use plain chat completion and agent
prompt tasks use the spawn or SDK runner. Task run history writes metadata v2
with an `engine`; historical v1 metadata remains readable without being an active
task configuration surface.

Migration restore holds a global maintenance barrier from its final blocker
check through artifact replacement. Index writers, improve/extract process
locks, lockfile writers, workflow lease claims, and every canonical `state.db`
or `workflow.db` handle register under the same barrier before starting. State
and workflow handles retain their activity registration until close, so task,
event, proposal, workflow-run, and other durable-state access cannot overlap
artifact replacement. Restore's own read-only workflow blocker scan uses the
barrier it already owns rather than recursively registering an activity. Scoped
barrier ownership is reentrant for nested repository opens in the same sync or
async execution context; unrelated work and child processes remain excluded.

---

## Module Boundaries

| Module | Responsibility |
| --- | --- |
| `src/cli.ts` | composition root (~620 LOC); per-family parsing lives in `commands/<family>/*-cli.ts` |
| `src/cli/` | citty composition helpers |
| `src/core/asset/asset-spec.ts` | asset type registry and canonical source directories (re-export shim at `src/core/asset-spec.ts`) |
| `src/core/asset/asset-ref.ts` | asset ref parsing and normalization (re-export shim at `src/core/asset-ref.ts`) |
| `src/core/config/config.ts` | config loading, validation, env resolution (re-export shim at `src/core/config.ts`) |
| `src/core/errors.ts` | error classes with stable codes and hints |
| `src/core/parse.ts` | shared JSON parsing: think/fence stripping, balanced-brace extraction |
| `src/core/concurrent.ts` | bounded concurrency pool (`concurrentMap`, default 1 worker) |
| `src/core/write-source.ts` | the single write helper (branches on `source.kind`) |
| `src/sources/source-provider.ts` | minimal `SourceProvider` interface |
| `src/sources/providers/` | filesystem / git / website / npm implementations |
| `src/sources/source-resolve.ts` | filesystem path resolution for refs |
| `src/indexer/indexer.ts` | walking, metadata generation, index rebuilds, embeddings, utility recompute |
| `src/indexer/walk/` | walker, matchers, path/file/index/project context — the walk phase |
| `src/indexer/db/` | `db`, `db-backup`, `graph-db`, `llm-cache` — the persistence phase |
| `src/indexer/graph/` | graph boost/dedup/extraction — the graph phase |
| `src/indexer/search/` | `db-search`, ranking, search-fields, search-source, enrichers — the search phase |
| `src/indexer/passes/` | memory-inference, staleness-detect, metadata — LLM/metadata passes |
| `src/indexer/usage/` | usage-events, unmigrated-vaults-guard |
| `src/commands/read/search.ts` | `akm search` orchestration |
| `src/commands/read/show.ts` | `akm show` orchestration |
| `src/commands/improve/` | knowledge-evolution slice (improve/consolidate/distill/extract/reflect + `memory/`) |
| `src/commands/proposal/` | proposal-queue slice (proposal/propose + `validators/` core 3-cycle) |
| `src/commands/sources/` | source/stash lifecycle command surface |
| `src/commands/env/` | env/secret command surface |
| `src/commands/graph/` | graph command surface |
| `src/commands/tasks/` | scheduled-task command surface |
| `src/commands/agent/` | contribute/agent command surface |
| `src/registry/providers/` | registry provider implementations (static-index, skills-sh) |
| `src/output/shapes/`, `src/output/text/` | JSON-envelope and text-output registries per command (#490; replaces the old `renderers.ts`) |
| `src/workflows/authoring/` | workflow authoring + scope-key helpers |
| `src/workflows/runtime/runs.ts` | workflow run persistence (raw SQL lives in `src/storage/repositories/workflow-runs-repository.ts`) |
| `src/workflows/runtime/` | run lifecycle: runs, checkin, document-cache, agent-identity |
| `src/llm/client.ts` | OpenAI-compatible chat completions client (stateless, single request/response) |
| `src/llm/index-passes.ts` | per-pass LLM config resolution for `akm index` |
| `src/llm/memory-infer.ts` | atomic-fact split helper (selected through `improve.strategies.<name>.processes.memoryInference`) |
| `src/llm/metadata-enhance.ts` | metadata enhancement helper |
| `src/llm/embedder.ts` | local + remote embedder facade with cached pipeline |
| `src/integrations/agent/spawn.ts` | agent CLI shell-out entry point (`runAgent`) |
| `src/integrations/harnesses/opencode-sdk/sdk-runner.ts` | embedded SDK runner selected by an SDK `RunnerSpec` |
| `src/integrations/agent/runner-dispatch.ts` | exhaustive `RunnerSpec` dispatch to LLM, spawn, or SDK |
| `src/integrations/agent/profiles.ts` | internal spawn descriptors used after agent-engine lowering |
| `src/integrations/agent/engine-resolution.ts` | named engine resolution and `RunnerSpec` lowering |
| `src/integrations/agent/detect.ts` | PATH-based agent CLI detection for `akm setup` |

---

## Tech Stack

- Runtime: Bun
- Language: TypeScript (ESM, strict)
- Database: `bun:sqlite` with FTS5 and optional `sqlite-vec`
- Testing: `bun:test`
- Formatting/linting: Biome
