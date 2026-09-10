# Architecture

akm is a Bun-based CLI for discovering and using agent assets from local
filesystem sources, cache-backed sources (git, website, npm), and registry
catalogs.

This document is the operating summary of the current architecture and is the
current-truth reference.

---

## Asset Types

The `akm` adapter's fourteen built-in asset types (`skill`, `command`,
`agent`, `knowledge`, `instruction`, `workflow`, `script`, `memory`,
`lesson`, `fact`, `env`, `secret`, `task`, `session`) each map to a
canonical source directory through `src/core/asset/asset-placement.ts`'s
`PLACEMENT_SPECS` map. See
[Bundle Types](../reference/bundle-types.md) for the full table.

The deprecated `vault` type was removed in 0.9.0 and replaced by `env` (whole
`.env` files) and `secret` (single-value secret files). `wiki` is not an item
type: multi-page wikis are a bundle *format* owned by the `llm-wiki` adapter,
not a per-file type stamped by the classifier (see
[Classification](internals/classification.md) and
[Bundle Types](../reference/bundle-types.md) for the other ten formats akm
recognizes besides its own native one).

---

## Sources and Source Providers

A **source** is a directory plus a way to refresh it from upstream. There are
exactly four source provider types:

- `filesystem` — a local path the user owns
- `git` — a git working tree mirrored under akm's cache
- `website` — recrawled and converted to markdown
- `npm` — installed into the cache

All four kinds expose the same minimal `SourceProvider` interface
(`src/sources/provider.ts`):

```ts
interface SourceProvider {
  readonly name: string;
  readonly kind: string;                        // "filesystem" | "git" | "website" | "npm"
  path(): string;                               // directory the indexer walks
  sync?(options?: { force?: boolean }): Promise<void>; // refresh from upstream (no-op for filesystem)
}
```

Providers do **not** implement `search`, `show`, `canShow`, or any read method.
The indexer walks `path()`, classifies files, and answers all queries from the
local FTS5 index.

File semantics are owned by the selected bundle adapter. OKF is the first-class
least-common-denominator for Markdown path identity, open types, content, links,
and heading fragments. The `akm` format is an OKF-compatible Markdown superset:
its adapter progressively adds native command, script, workflow, task,
environment, secret, memory, and lesson behavior. Non-Markdown formats retain
their native serialization and every adapter retains its own capability,
validation, redaction, and placement rules.

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

User-facing item refs are path-identified:

```text
[bundle//]conceptId[#fragment]
```

- the subdir-qualified `conceptId` (`skills/code-review`) identifies an item
  within a bundle; `type` is no longer a separate ref segment
- the fully qualified `bundle//conceptId` spelling is canonical in index rows
  and durable state; index-backed local read output keeps the short form for the
  default bundle and qualifies every non-default bundle
- optional `bundle//` narrows input lookup to a configured bundle
- refs are parsed by `parseBundleRef` in `src/core/asset/asset-ref.ts`
- markdown-backed items strip `.md` from canonical names
- `#fragment` is input-only and never stored: on markdown-document items the
  core resolves it as a section selector (`knowledge/api-guide#authentication`);
  elsewhere it is an adapter-owned selector opaque to the core
- refs embedded in prose must be fully qualified (`bundle//conceptId`) or a
  native adapter link form — a bare conceptId in prose is ordinary text, and no
  tool rewrites it
- a rename is delete plus create: the new path is a new identity and learned
  state does not follow it

See [`specs/ref.md`](./specs/ref.md) for the normative grammar and
[`specs/0.9.0-decisions.md`](./specs/0.9.0-decisions.md) for the rationale
behind the 0.9.0 changes.

Each indexed entry stores that identity as `item_ref`, with `bundle_id` and
`concept_id` provenance, and stores its absolute materialized local file as
`file_path`. Search and show return these index-backed refs and paths, so two
bundles containing the same concept remain distinguishable. Rows without the
current identity columns are ignored until they are reindexed.

Examples:

- `skills/code-review`
- `workflows/release/train`
- `team//commands/deploy`

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

- lexical queries are tokenized once with Unicode letter/number semantics and
  execute strict AND, then prefix-AND, then one OR/prefix-OR recovery only when
  both strict forms return no candidates; there are no caller stopword lists
- `hints` includes `searchHints`, `examples`, `usage`, intent fields, wiki
  cross-references, and page-kind hints
- `content` is bounded low-weight body prose plus TOC headings and parameter metadata; secret/env/session material is excluded at the adapter boundary
- registry results live in `registryHits`, never in `hits`
- `--from all` keeps registry results in `registryHits` — they are not
  rank-merged with source hits
- local search and curate expose the actual execution in `searchMode`:
  `semantic`, intentional/unavailable `keyword`, or `fts-fallback` when a
  ready semantic runtime failed during the query; that degradation also
  surfaces as one sanitized `warnings[]` entry, including in agent shape
- usage-event writes are best-effort; `EROFS`/`EACCES` from a read-only
  environment are silent and never affect `searchMode`

`akm search` is implemented in `src/commands/read/search.ts` and queries the
indexer's local search (`src/indexer/search/db-search.ts`). Provider fan-out is gone.

---

## Show Resolution

`akm show` queries the local FTS5 index, then reads the file from disk.

Local show flow (`src/commands/read/show.ts`):

1. parse `[bundle//]conceptId`
2. `lookup(ref)` by indexed `item_ref` and materialized source root
3. return the indexed canonical ref and read `file_path` from disk
4. report not-found when no index row resolves; physical ownership can prevent
   a lower-priority source from retargeting a ref, but never authorizes a
   direct file read
5. apply generic Markdown content/fragment presentation for OKF, or the owning
   adapter's progressively enhanced native presentation

An opaque `#akm-fragment-...` selector resolves against the safe Markdown
revision persisted in `entry_fragments`, so search and show remain consistent
if the materialized file changes before it is reindexed. Bare fragment show is
still exact. The opt-in `--context lead` projection assembles the first and
selected fragments from that same indexed revision under a hard character
budget, labels the selected match, and keeps it last. It never reconstructs
neighbors from the current raw file. Fragment search plus opaque/contextual show
JSON exposes the selected and parent refs, one-based ordinal/count and
source-line bounds, neighbor refs, and separate fragment/parent size estimates;
canonical `ref` remains the parent on show. A default exact friendly-heading
show stays source-live and omits indexed provenance.

There is **no provider or local-disk fallback** for asset refs. The file is
read only after an indexed row resolves it.

### Local access metadata

Agent-shaped search, show, and curate results for materialized local assets
include the index-backed `ref`, absolute `path`, and `editable`. `editHint` is
included only when `editable` is `false`; it is secondary guidance and never
replaces the normal show, run, or use action (or curate follow-up). Registry-only
results have no local path or editability fields.

`editable` means current AKM source policy authorizes direct in-place
modification of that exact file. It is computed when the response is built from
the current resolved source roots and effective `writable` policy, is not stored
in the index, and fails closed when no configured source owns the path.

---

## Writing to Sources

Writes go through one helper: `src/core/write-source.ts`. This is the only
place in the codebase that branches on `source.kind`, and that is **enforced**
by `scripts/lint-write-source-chokepoint.ts` in the `lint` chain — it was
prose-only until 0.9.0, and drifted.

Command layers therefore never hold provider knowledge. Where a step is
meaningful only for a publication-backed target, `write-source.ts` exposes a
kind-neutral wrapper that absorbs the guard and no-ops otherwise:
`commitWriteTargetBoundary`, `captureGitPublication`,
`captureWriteTargetPathSnapshot`, and `publishWriteTargetTransaction`.
Recording or comparing a kind for transaction *identity* (`targetKind:
target.source.kind`) is not branching and stays in the command layer.

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
per-asset commit/push path (`options.pushOnCommit`) is **hard-rejected** at
config load — not merely deprecated — by a `superRefine` on the bundle/source
schema (`src/core/config/schema/sources-bundles.ts`).

`writable` is a config flag, not an interface concern. Defaults: `true` for
`filesystem`, `false` for everything else. `writable: true` on `website` or
`npm` is rejected at config load — `sync()` would clobber edits on the next
refresh.

Write-target resolution (`resolveWriteTarget`) follows: an explicit
destination flag (`--bundle` on `remember`/`clone`/`improve`, `--target` on
`import`/env/secret mutations) -> `config.defaultWriteTarget` -> working
bundle (`defaultBundle`) -> `ConfigError`. The resolved target keeps the
optional configured selector separate from the stable `source.name`: APIs
that must re-resolve a destination use the selector, while durable refs and
state rows always use `source.name`. The implicit working bundle therefore has
no selector but has durable identity `stash`.

On mutation surfaces that accept asset refs, a qualified ref implies its
bundle as the write target. A matching explicit destination flag is allowed;
a different one is a usage error. This applies, for example, to env/secret
mutations, ref-scoped improve, and qualified `--supersedes` refs on
remember/import.

`akm clone` uses the same managed write-target fallback and accepts
`--bundle` for an explicit managed destination. `--dest` is the unmanaged
path escape hatch: it bypasses managed target resolution and cannot be
combined with `--bundle`.

### Improve durable-state identity

Improve readers and writers use one current key for each asset. A resolved
indexed entry uses its fully qualified `item_ref`; a direct or provenance-free
ref uses its current concept ID. There is no alternate root-based key, bare alias
merge, or second state lookup. This prevents a duplicate concept in another
installation from inheriting unrelated feedback, proposal-cursor, salience, or
convergence state.

Retrieval demand is scoped separately through usage-event entry IDs and selected
source roots, with qualified refs covering detached events. Improve never merges
retrieval counts or last-use timestamps solely by bare ref across sources.

### Proposal queues and destinations

`akm proposal ... --queue <source>` selects the configured writable source root
whose proposal queue is read or adjudicated; it does not override the proposal's
write destination. Qualified proposals and unqualified proposals created in a
configured secondary queue record the destination source name and materialized
root. Diff, accept, and revert use that binding by default and reject an explicit
`--target` that resolves elsewhere. An unbound short proposal requires either
an explicit `--target` or an authenticated `--queue` context; it does not
inherit a default write target.

---

## Registry Providers

Registry providers are read-only catalogs of installable kits. The interface
lives in `src/registry/providers/types.ts`:

```ts
interface RegistryProvider {
  readonly type: string;            // "static-index" | "skills-sh"
  search(options: RegistryProviderSearchOptions): Promise<RegistryProviderResult>;
}
```

The contract is a single `search()` method — the orchestrator's only entry
point. Implementations must never throw; errors are returned as
`warnings[]` on the result.

Built-in registries:

| Kind | Role |
| --- | --- |
| `static-index` | Reads the v2 or v3 JSON index schema, same `stashes[]` wire format (official akm registry, team mirrors). `scripts/build-registry-index.ts` emits v3; the live official registry currently publishes v2. |
| `skills-sh` | Wraps the skills.sh REST API. |

Context Hub is **not** a registry provider type. It is just a recommended git
kit installable through the official static-index registry like any other
source.

---

## Workflow Runtime State

Workflow definitions live in `workflows/`, but workflow run state is separate
durable runtime state. `workflow_runs`, `workflow_run_steps`,
`workflow_run_units`, and `workflow_run_unit_attempts` live in `state.db`
alongside events, tasks, and proposals. `index.db` remains rebuildable search
state, while `logs.db` stores task/run log lines.

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

The approved target semantics that connect native agent and command assets to
this engine boundary are specified in
[Agent, Command, Engine, and Model Resolution](specs/agent-command-engine-model-design.md).
The WP2/WP3 model-map and common-cascade path, WP4 command surface, WP5 runtime
lowering convergence, WP6 task v3, and WP7 source-to-frozen durable workflow
IR are implemented. Direct commands, task execution, and new workflow freezes
share this boundary.

Public execution selection uses named `engines`, never profiles. An engine is
either `kind: "llm"` (an OpenAI-compatible chat-completions connection) or
`kind: "agent"` (a registered harness platform). The SDK runtime is an
internal transport kind for an `opencode-sdk` agent engine, not a public engine
kind.

Current non-interactive execution follows this common shape:

```text
adapter-rendered or anonymous work
  -> prepareResolvedExecution / prepareInlineExecution
  -> planExecutionCascade
  -> authorized ResolvedExecutionRequestV1 with exact model/inference
  -> lowerResolvedExecutionRequest
  -> dispatchLoweredExecutionRequest
  -> executeRunner -> agent CLI, OpenCode SDK, or direct LLM transport
```

The cascade applies installation -> selected engine -> selected agent ->
selected command -> invocation defaults -> current invocation, preserving
omitted, explicit `null`, zero, and empty values. A recognized model-map alias
expands as defaults at the layer that selected it; explicit sibling and nearer
fields then win. The request records the exact final model ID. Lowering calls
`resolveEngine()` once for symbolic transport/profile material and projects
that request-owned exact model into it; transports never resolve aliases.
Tool selection uses the same nearest-explicit rule, while
operator authorization remains a separate pre-lowering decision.

Agent lowerers are a structural implementation registry derived from
`HARNESS_REGISTRY`: OpenCode, Claude, OpenCode SDK, Codex, Copilot, Pi, Gemini,
Aider, Amazon Q, and OpenHands each register a lowerer, and direct LLM is the
remaining lowering arm. This is not a model/provider capability matrix. Each
lowerer translates what its transport actually implements, returns sorted
translated/untranslated field paths, emits a stable structured notice for
every selected field it does not translate, and still dispatches
optimistically. A provider or harness rejection is a runtime failure; invalid
configuration and authorization denial remain pre-dispatch failures.

Lowering notices are fixed, secret-free records (`code`, `severity`,
`adapter`, optional `field`, fixed `message`, and optional safe structured
`details`). They never copy prompt content, environment values, credential
values, or provider error bodies. Command, task, improve, proposal, index, and
current workflow execution surfaces carry these records in live result or
diagnostic output. Current persisted workflow result/evidence fields
deliberately exclude them; no future persistence ownership is implied here.

LLM and SDK-fallback credentials remain symbolic descriptors in engine
transport and frozen runner material; secret values never enter the resolved
request. `executeRunner()` materializes the current value only at final
dispatch and scrubs it from transport results. The
`lowerResolvedExecutionRequestWithRunner()` entry point lowers an already
frozen `RunnerSpec` without consulting live config, model maps, environment
variables, credentials, or transports; current workflow units/judges and
structured model-work adapters use that config-free path.

`executeRunner()` remains the sole exhaustive low-level switch over the
`RunnerSpec` transport union. It is below, not instead of, the resolved-request
lowering boundary. The only public execution exemption is an explicitly
prompt-free interactive `akm agent` launch, which has no user/model payload to
resolve or lower. An explicit missing or incompatible engine is an error and
never falls through to another configured engine.

Task-v3 execution and durable workflow-v4 dispatch use this runtime boundary.
Markdown and GitHub-shaped YAML compile through source IR v1; new starts freeze
v4-family `irVersion: 5`, and only `irVersion: 5` plans execute.
Pre-`irVersion`-5 stored plans are rejected; start a new
run from current source. AKM does not support full GitHub Actions semantics or
arbitrary remote action execution.

### In-tree LLM helpers (`src/llm/`)

Every helper under `src/llm/` is a **bounded, single-shot, stateless** call.
Concretely:

- Each public export is either a pure function (`chatCompletion`,
  `enhanceMetadata`, `splitMemoryIntoAtomicFacts`,
  `resolveIndexPassExecution`, `resolveIndexPassRunner`,
  `parseJsonResponse`, …) or a factory that returns a one-shot client tied to
  the symbolic runner/config the caller passes in.
- No module under `src/llm/` keeps session, conversation, or response state at
  module scope. The only module-level singleton is the local embedder
  pipeline in `src/llm/embedder.ts`, which is an expensive-to-build but
  stateless model handle (see the comment in that file). It exposes
  `resetLocalEmbedder()` so tests can construct a fresh pipeline.
- `callStructured()` is the common bounded structured-LLM seam: it adapts an
  already-resolved symbolic runner into an inline resolved request, lowers it,
  and dispatches without re-reading aliases or credentials. Index callers use
  `resolveIndexPassExecution()` to freeze the typed `{ runner, notices }`
  selection once per invocation. `resolveIndexPassRunner()` is its readiness
  projection, not a second dispatch seam. Improve processes are selected
  through `improve.strategies`; see `docs/reference/configuration.md` for
  canonical config paths.

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

New tasks are task source v4 `.yml` assets. Normal execution rejects v2 and v3
and directs operators to the explicit preview/apply migrator. Task source v4
command, workflow, script, and shell targets use the common resolved/lowered
execution boundary. Historical task-run metadata remains readable.

Long-lived mutable operations coordinate start ownership through one maintenance
barrier. Index writers, improve/extract process locks, lockfile writers, and
workflow lease claims acquire their own lock or lease while holding that short
barrier section, then release the barrier for the operation's duration.
Canonical `state.db` handles register an activity the same way and retain that
activity until close, covering task, event, proposal, workflow-run, and other
durable-state access. Scoped barrier ownership is reentrant for nested
repository opens in the same synchronous or asynchronous execution context.

---

## Module Boundaries

| Module | Responsibility |
| --- | --- |
| `src/cli.ts` | composition root; per-family parsing lives in `commands/<family>/*-cli.ts` |
| `src/cli/` | citty composition helpers |
| `src/core/asset/asset-placement.ts` | asset type registry and canonical source directories (`PLACEMENT_SPECS`) |
| `src/core/asset/asset-ref.ts` | asset ref parsing and normalization (`parseBundleRef`) |
| `src/core/config/config.ts` | config loading, validation, env resolution |
| `src/core/errors.ts` | error classes with stable codes and hints |
| `src/core/parse.ts` | shared JSON parsing: think/fence stripping, balanced-brace extraction |
| `src/core/concurrent.ts` | bounded concurrency pool (`concurrentMap`, default 1 worker) |
| `src/core/write-source.ts` | the single write helper (branches on `source.kind`) |
| `src/execution/resolved-request.ts` | branded, versioned resolved execution request and strict canonical wire form |
| `src/integrations/agent/execution-preparation.ts` | caller adapter into the common cascade/model-map resolver |
| `src/integrations/agent/execution-lowering.ts` | optimistic engine lowering, structural lowerer inventory, and lowered dispatch authority |
| `src/integrations/agent/request-lowering.ts` | shared factory used by harness-owned resolved-request lowerers |
| `src/integrations/agent/inline-execution.ts` | anonymous-work adapters for live config and already-frozen runner material |
| `src/sources/provider.ts` | minimal `SourceProvider` interface |
| `src/sources/providers/` | filesystem / git / website / npm implementations |
| `src/sources/resolve.ts` | filesystem path resolution for refs |
| `src/indexer/indexer.ts` | walking, metadata generation, index rebuilds, embeddings, utility recompute |
| `src/indexer/walk/` | walker, matchers, path/file/index/project context — the walk phase |
| `src/indexer/db/` | `db`, `db-backup`, `graph-db`, `llm-cache` — the persistence phase |
| `src/indexer/graph/` | graph boost/dedup/extraction — the graph phase |
| `src/indexer/search/` | `db-search`, ranking, search-fields, search-source, enrichers — the search phase |
| `src/indexer/passes/` | memory-inference, staleness-detect, metadata — LLM/metadata passes |
| `src/indexer/usage/` | usage-events |
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
| `src/output/shapes/`, `src/output/text/` | JSON-envelope and text-output registries per command (#490) — a parallel concern to `src/output/renderers.ts`'s per-asset-type `show` renderers, which is still live and self-registering, not replaced |
| `src/workflows/authoring/` | workflow authoring + scope-key helpers |
| `src/workflows/runtime/runs.ts` | workflow run persistence (raw SQL lives in `src/storage/repositories/workflow-runs-repository.ts`) |
| `src/workflows/runtime/` | run lifecycle: runs, checkin, agent-identity |
| `src/llm/client.ts` | OpenAI-compatible chat completions client (stateless, single request/response) |
| `src/llm/index-passes.ts` | per-pass LLM config resolution for `akm index` |
| `src/llm/memory-infer.ts` | atomic-fact split helper (selected through `improve.strategies.<name>.processes.memoryInference`) |
| `src/llm/metadata-enhance.ts` | metadata enhancement helper |
| `src/llm/embedder.ts` | local + remote embedder facade with cached pipeline |
| `src/integrations/agent/spawn.ts` | agent CLI shell-out entry point (`runAgent`) |
| `src/integrations/harnesses/opencode-sdk/sdk-runner.ts` | embedded SDK runner selected by an SDK `RunnerSpec` |
| `src/integrations/agent/runner-dispatch.ts` | low-level exhaustive `RunnerSpec` transport dispatch and dispatch-time credential redaction |
| `src/integrations/agent/profiles.ts` | internal spawn descriptors used after agent-engine lowering |
| `src/integrations/agent/engine-resolution.ts` | named engine and symbolic transport-material resolution; exact request model projection happens in execution lowering |
| `src/llm/structured-call.ts` | bounded structured-LLM adapter through the common resolved/lowered execution seam |
| `src/integrations/agent/detect.ts` | PATH-based agent CLI detection for `akm setup` |

---

## Tech Stack

- Runtime: Bun
- Language: TypeScript (ESM, strict)
- Database: `bun:sqlite` with FTS5 and optional `sqlite-vec`
- Testing: `bun:test`
- Formatting/linting: Biome
