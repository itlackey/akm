# Architecture

akm is a Bun-based CLI for discovering and using agent assets from local
filesystem sources, cache-backed sources (git, website, npm), and registry
catalogs. This page summarizes how it is put together.

---

## Asset Types

The `akm` adapter's fourteen built-in asset types (`skill`, `command`,
`agent`, `knowledge`, `instruction`, `workflow`, `script`, `memory`,
`lesson`, `fact`, `env`, `secret`, `task`, `session`) each map to a
canonical source directory through `src/core/asset/asset-placement.ts`'s
`PLACEMENT_SPECS` map. See
[Bundle Types](../reference/bundle-types.md) for the full table.

`env` holds whole `.env` files and `secret` holds single-value secret files.
`wiki` is not an item type: multi-page wikis are a bundle *format* owned by the
`llm-wiki` adapter, not a per-file type stamped by the classifier (see
[Classification](internals/classification.md) and
[Bundle Types](../reference/bundle-types.md) for the ten other formats akm
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
  readonly kind: SourceKind;                    // "filesystem" | "git" | "website" | "npm"
  path(): string;                               // directory the indexer walks
  sync?(options?: SyncOptions): Promise<void>;  // refresh from upstream (no-op for filesystem)
}
```

Providers do **not** implement `search`, `show`, `canShow`, or any read method.
The indexer walks `path()`, classifies files, and answers all queries from the
local FTS5 index.

File semantics are owned by the selected bundle adapter (see
[Adapters](adapters.md)). OKF is the first-class least-common-denominator for
Markdown path identity, open types, content, links, and heading fragments. The
`akm` format is an OKF-compatible Markdown superset: its adapter progressively
adds native command, script, workflow, task, environment, secret, memory, and
lesson behavior. Non-Markdown formats retain their native serialization and
every adapter retains its own capability, validation, redaction, and placement
rules.

### Cache-backed sources are still indexed locally

`git`, `website`, and `npm` all materialise files into a cache directory under
`$XDG_CACHE_HOME/akm/`. Once mirrored, they participate in the same local
indexing pipeline as filesystem sources. There is no parallel scoring system
for "remote" content.

`akm index` indexes each source through its bundle's adapter. A source that
could not be walked completely keeps its previously indexed rows and the index
run warns; a bundle whose adapter id is unknown is skipped with a warning.

---

## Refs

User-facing item refs are path-identified:

```text
[bundle//]conceptId[#fragment]
```

- the subdir-qualified `conceptId` (`skills/code-review`) identifies an item
  within a bundle; `type` is not a ref segment
- the fully qualified `bundle//conceptId` spelling is canonical in index rows
  and durable state; index-backed local read output keeps the short form for the
  default bundle and qualifies every non-default bundle
- optional `bundle//` narrows input lookup to a configured bundle
- refs are parsed by `parseBundleRef` in `src/core/asset/asset-ref.ts`
- markdown-backed items strip `.md` from canonical names
- `#fragment` is input-only and never stored, and `akm show` is the only command
  that accepts one: on markdown-document items the core resolves it as a
  section selector (`knowledge/api-guide#authentication`); elsewhere it is an
  adapter-owned selector opaque to the core
- refs embedded in prose must be fully qualified (`bundle//conceptId`) or a
  native adapter link form — a bare conceptId in prose is ordinary text, and no
  tool rewrites it
- a rename is delete plus create: the new path is a new identity and learned
  state does not follow it

See [`specs/ref.md`](./specs/ref.md) for the normative grammar.

Each indexed entry stores that identity as `item_ref`, with `bundle_id` and
`concept_id` provenance, and stores its absolute materialized local file as
`file_path`. Search and show return these index-backed refs and paths, so two
bundles containing the same concept remain distinguishable. Rows without the
current identity columns are ignored until they are reindexed.

Examples:

- `skills/code-review`
- `workflows/release/train`
- `team//commands/deploy`

URI schemes are **not** asset refs. Install locators like `github:owner/repo`,
`git+https://...`, `npm:@scope/pkg`, and `./local/path` are a
separate grammar parsed by `parseRegistryRef` in `src/registry/resolve.ts` and
consumed by `akm bundle add` and `akm clone`.

---

## Search Pipeline

There is **one** ranking for all indexed content: reciprocal rank fusion
(k = 60, equal weights) of two candidate lists, 100 each.

1. lexical: BM25 over the whole-document FTS5 table (`entries_fts`, columns
   `name`, `description`, `tags`, `hints`, `content`, equal weights),
   matching any of the query's non-stopword tokens
2. vector: the document vectors nearest to the query embedding, embedded
   through the model's embedding profile (`src/llm/embedders/profile.ts`)

Filters (type, source, scope, belief, proposed quality, default-excluded
types) and one-hit-per-file deduplication narrow the fused list without
reordering it, and a hit's `score` is its fused score. Of entries with
identical indexed content only the highest-ranked is kept. Nothing else — name,
type, tag, graph, usage or belief-state signals — changes the order.

Notes:

- lexical queries are tokenized once with Unicode letter/number semantics,
  lowercased, and stripped of English stopwords unless the query is nothing
  else; the tokens are quoted and OR-ed
- the query embedding is requested before the FTS query runs and is bounded
  by `embedding.queryTimeoutMs` (default 3000); on timeout or failure the
  search is served by the lexical list alone
- Markdown fragments are not searched; they are a `show` feature (see
  [Show Resolution](#show-resolution))
- `hints` carries search hints, examples, usage, intent fields, cross-references,
  page kind, and when-to-use text
- `content` is bounded body text plus TOC headings and parameter metadata; `env`
  and `secret` entries index key names and file names only
- registry results live in `registryHits`, never in `hits`
- `--from all` keeps registry results in `registryHits` — they are not
  rank-merged with source hits
- local search and curate expose the actual execution in `searchMode`:
  `semantic`, intentional/unavailable `keyword`, or `fts-fallback` when a
  ready semantic runtime failed during the query; that degradation also
  surfaces as one `warnings[]` entry, including in agent shape
- usage-event writes are best-effort; a read-only filesystem drops them
  silently and does not change `searchMode`

`akm search` is implemented in `src/commands/read/search.ts` and queries the
indexer's local search (`src/indexer/search/db-search.ts`).

---

## Show Resolution

`akm show` queries the local FTS5 index, then reads the file from disk.

Local show flow (`src/commands/read/show.ts`):

1. parse `[bundle//]conceptId`
2. `lookup(ref)` by indexed `item_ref` and materialized source root
3. return the indexed canonical ref and read `file_path` from disk
4. report not-found when no index row resolves
5. apply generic Markdown content/fragment presentation for OKF, or the owning
   adapter's progressively enhanced native presentation

A friendly heading fragment (`#authentication`) selects a section of the live
file. An opaque `#akm-fragment-...` selector resolves against the safe Markdown
revision persisted in `entry_fragments`, so it stays consistent if the
materialized file changes before it is reindexed. The opt-in `--context lead`
projection assembles the first and selected fragments from that same indexed
revision under a character budget (`--max-chars` or `--max-tokens`), labels the
selected match, and keeps it last. Opaque and contextual show JSON exposes the
selected and parent refs, one-based ordinal and count, source-line bounds,
neighbor refs, and separate fragment and parent size estimates; the canonical
`ref` remains the parent. An exact friendly-heading show stays source-live and
omits indexed provenance.

There is **no provider or local-disk fallback** for asset refs. The file is
read only after an indexed row resolves it.

### Local access metadata

Agent-shaped search, show, and curate results for materialized local assets
include the index-backed `ref`, absolute `path`, and `editable`. `editHint` is
included only when `editable` is `false`; it is secondary guidance and does not
replace the normal show, run, or use action (or curate follow-up). Registry-only
results have no local path or editability fields.

`editable` means the asset's file belongs to a configured source whose
effective `writable` policy is true. It is computed when the response is built
from the current resolved source roots, is not stored in the index, and is
`false` when no configured source owns the path.

---

## Writing to Sources

Writes go through one helper: `src/core/write-source.ts`. It is the only
place that should branch on `source.kind`; command layers do not hold provider
knowledge. That is a convention that code review holds, not a lint rule. Where
a step is meaningful only for a publication-backed target, `write-source.ts`
exposes a kind-neutral wrapper that does the work for a git target and does
nothing otherwise:
`prepareWriteTargetForMutation`, `commitWriteTargetBoundary`, and
`withWriteTargetMutation` (write the file, `git add` exactly the recorded
paths, commit, push with `--force-with-lease` when configured). Recording a
kind for display (`targetKind: target.source.kind`) is not branching and stays
in the command layer.

```ts
writeAssetToSource(source, config, ref, content)
deleteAssetFromSource(source, config, ref)
```

The flow:

1. Refuse if the source is not `writable`, is not a `filesystem` or `git`
   source, or belongs to a bundle whose adapter is not on the write allowlist
   (see [Adapters](adapters.md#write-allowlists)).
2. Atomic filesystem write to `path.join(source.path, …)` with no commit. A git
   target records the path for the boundary commit.

Git-backed targets are committed in a single batch at the operation boundary via
`commitWriteTargetBoundary(target, message, { push })`, which delegates to
`saveGitStash`: write/delete helpers carry their exact changed paths to the
boundary, which stages and commits only those files (so unrelated staged work,
including work under the same asset directory, is not included). Improve
auto-sync similarly subtracts the Git dirty-path baseline captured at invocation
start. Push happens when the target is writable, has an upstream, and `push` is
not `false`. `options.pushOnCommit` is not supported: config load reports it
(`src/core/config/schema/sources-bundles.ts`).

`writable` is a config flag, not an interface concern. Defaults: `true` for
`filesystem`, `false` for everything else. `writable: true` on `website` or
`npm` is rejected at config load — `sync()` would clobber edits on the next
refresh.

Write-target resolution (`resolveWriteTarget`) follows: an explicit
destination flag (`--bundle` on `remember`/`clone`/`improve`, `--target` on
`import`/env/secret mutations) -> `config.defaultWriteTarget` -> working
bundle (`defaultBundle`) -> `ConfigError`. There is no fallback to the first
writable source. The resolved target keeps the optional configured selector
separate from the stable `source.name`: APIs that must re-resolve a destination
use the selector, while durable refs and state rows always use `source.name`.

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

Improve readers and writers use one current key for each asset (`stateKey`,
`src/commands/improve/ledger.ts`). A resolved indexed entry uses its fully
qualified `item_ref`; a direct or provenance-free ref uses its current concept
ID. There is no alternate root-based key, bare alias merge, or second state
lookup, so a duplicate concept in another installation does not inherit
unrelated feedback, proposal-cursor, salience, or convergence state.

Retrieval demand is scoped separately through usage-event entry IDs and selected
source roots, with qualified refs covering detached events. Improve does not
merge retrieval counts or last-use timestamps by bare ref across sources.

### Proposal queues and destinations

`akm proposal ... --queue <source>` selects the configured writable source root
whose proposal queue is read or adjudicated; it does not override the proposal's
write destination. Qualified proposals and unqualified proposals created in a
configured secondary queue record the destination source name and materialized
root. Diff, accept, and revert use that binding by default and refuse an
explicit `--target` that resolves elsewhere. An unbound short proposal needs
either `--target` or `--queue`; it does not inherit a default write target.

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
point. Implementations return errors as `warnings[]` on the result instead of
throwing.

Built-in registries:

| Kind | Role |
| --- | --- |
| `static-index` | Reads the v2 or v3 JSON index schema, same `stashes[]` wire format (official akm registry, team mirrors). `scripts/build-registry-index.ts` emits v3. |
| `skills-sh` | Wraps the skills.sh REST API. |

These two are the only registry provider types, and Context Hub is **not** a registry provider type.

---

## Workflow Runtime State

Workflow definitions live in `workflows/`, but workflow run state is separate
durable runtime state. `workflow_runs`, `workflow_run_steps`,
`workflow_run_units`, and `workflow_run_unit_attempts` live in `state.db`
alongside events, tasks, and proposals. `index.db` remains rebuildable search
state, while `logs.db` stores task/run log lines. See
[The Workflow Engine](workflow-engine.md) for how a run is frozen, driven, and
resumed.

- workflow discovery and search use the shared asset index
- workflow run records survive index rebuilds
- workflow run state is not derived from the FTS index

---

## Utility Scoring

Utility is feedback-driven and rebuilt from `usage_events`. It orders
improve's salience work; search ranking does not read it.

- usage history is preserved across schema resets and full rebuilds
- detached events are re-linked to fresh entry ids by ref
- decay is time-proportional, not tied to index frequency

---

## Errors

`ConfigError`, `UsageError`, `NotFoundError`, and `TransientError` (in
`src/core/errors.ts`) each carry a stable `code` and a `hint(): string |
undefined` method. The CLI surfaces hints by calling `error.hint()` directly —
there is no regex chain parsing error messages.

All four extend a shared abstract base `AkmError` carrying a `kind`
discriminant (`"config" | "usage" | "not-found" | "transient"`). The CLI
exit-code classifier (`classifyExitCode` in `src/cli/shared.ts`) switches
exhaustively on `kind` (`never`-checked via `assertNever`), so adding a new
error class is a compile-time error until its exit code is mapped. Any thrown
value that is **not** an `AkmError` is treated as an unexpected internal
failure and maps to the distinct INTERNAL exit code **70** (sysexits
`EX_SOFTWARE`) — this lets scripts tell "akm threw unexpectedly" apart from an
ordinary `NotFoundError` (exit 1).

| Class / case | Exit code |
| --- | --- |
| `ConfigError` (`kind: "config"`) | 78 |
| `UsageError` (`kind: "usage"`) | 2 |
| `NotFoundError` (`kind: "not-found"`) | 1 |
| `TransientError` (`kind: "transient"`) — another akm process holds a lock; retry shortly | 75 |
| unclassified / non-`AkmError` (INTERNAL) | 70 |

`akm health` exits 4 when it reports a warning (`EXIT_CODES.HEALTH_WARN`).

---

## Engine Boundary

Direct commands, task execution, workflows, improve, proposals, and index
passes all execute through one engine boundary. The other places akm runs code
are `env run` and `secret run` (a child process that receives the injected
values) and fetcher modules from the working bundle's `scripts/wiki-fetchers/` directory, imported during website sync
(`src/sources/snapshot-fetchers/registry.ts`); `search` and `show` execute
nothing.

Public execution selection uses named `engines`, never profiles. An engine is
either `kind: "llm"` (an OpenAI-compatible chat-completions connection) or
`kind: "agent"` (a registered harness platform). The SDK runtime is an
internal transport kind for an `opencode-sdk` agent engine, not a public engine
kind.

Every execution takes the same four steps
(`src/integrations/agent/execution.ts`, `runner-dispatch.ts`):

```text
adapter-rendered or anonymous work
  -> resolveExecution(input)          -> { request, runner (a RunnerSpec), provenance }
  -> buildExecution(request, runner)  -> harness argv inputs or chat messages
  -> runExecution(built, options)     -> agent CLI, OpenCode SDK, or direct LLM
```

`resolveExecution` picks the engine from an ordered list — the nearest layer
that names one, then `defaults.engine`, then the implicit `opencode-sdk`
fallback when its binary is present — and merges one set of defaults, nearest
wins: the selected engine's own model/inference/timeout/workspace, then the
persona, the command, the invocation defaults, and the current call. Omitted,
explicit `null`, zero, and empty values stay distinct. A recognized
`models.json` alias expands once, at the layer that chose it; the request
records the exact final model. Tools are checked against the host-local
`execution.allowedTools` ceiling; an asset can request tools but not grant
itself any. The result's `provenance` names the layer behind each field
(`akm task explain`, `command run --dry-run`).

An agent asset is a persona (system prompt, requested tools, model preference),
not executable work. An `agents/<name>` selector (optionally `bundle//`-qualified)
is resolved by akm into a persona; any other agent string is a native harness
selector that replaces the persona.

`buildExecution` hands the request to the selected harness's own builder
(registered on `HARNESS_REGISTRY`), or builds chat messages for a direct LLM.
A tool policy the transport cannot enforce, or a denied tool selection, stops
here; any other field the transport cannot carry becomes an
`untranslated-field` notice and dispatch continues.

Credentials stay symbolic (an env descriptor, an `apiKeyFile` path, or a
`secret://` reference) in everything `resolveExecution` returns, so a request
and runner can be journaled. `runExecution()` reads the current value at each
dispatch and removes it, with other secret-looking values the child could
see, from the result. Workflow resume calls `buildExecutionFromWire()` on the
journaled `{ request, runner }` and does not read config, `models.json`, or
credentials, so a config edit after the freeze does not change a resumed unit.
The prompt-free interactive `akm agent` launch resolves its engine directly.
An explicit missing or incompatible engine is an error and does not fall
through to another configured engine.

Tasks (source v4) and workflows use this boundary. Markdown and GitHub-shaped
YAML workflow sources compile to one plan, and a new run freezes plan
`irVersion` 6 (`WORKFLOW_PLAN_VERSION`). A stored plan that decodes runs
whatever release froze it, with one warning; one that does not decode is marked
abandoned and `akm workflow run <ref>` starts afresh. A plan that a newer akm
froze and this one cannot decode is refused, naming the upgrade. akm does not
support full GitHub Actions semantics or arbitrary remote action execution.

Tasks are `tasks/<name>.yml` documents in task source v4 (`parseTaskSource`).
Version 2 and 3 files are not read at runtime: they are refused with a message
naming `akm migrate apply`, which converts them. Historical task-run metadata
remains readable.

### In-tree LLM helpers (`src/llm/`)

Every helper under `src/llm/` is a **bounded, single-shot, stateless** call.
Concretely:

- Each public export is either a pure function (`chatCompletion`,
  `resolveIndexPassExecution`, `parseJsonResponse` in `src/core/parse.ts`, …)
  or a factory that returns a one-shot client tied to the symbolic
  runner/config the caller passes in.
- No module under `src/llm/` keeps session, conversation, or response state at
  module scope. The module-level state is the local embedder pipeline and the
  embedding cache in `src/llm/embedder.ts` — an expensive-to-build but
  stateless model handle and an LRU of vectors. `resetLocalEmbedder()` lets
  tests construct a fresh pipeline.
- `callStructured()` (`src/llm/structured-call.ts`) is the common bounded
  structured-LLM seam: it adapts an already-resolved symbolic runner into an
  inline resolved request, lowers it, and dispatches without re-reading aliases
  or credentials. Index callers use `resolveIndexPassExecution()`
  (`src/llm/index-passes.ts`) to freeze the typed `{ runner, notices }`
  selection once per invocation. Improve processes are selected through
  `improve.strategies`; see `docs/reference/configuration.md` for canonical
  config paths.

### External agents (`src/integrations/agent/`)

External coding agents are reachable via two execution paths:

**Spawn path** (`src/integrations/agent/spawn.ts`):

- `runAgent(profile, prompt, options)` is the single shell-out entry point.
  It owns process spawn, captured/interactive stdio, hard timeout, and
  structured failure reasons.
- The `AgentRunResult` envelope carries `{ ok, exitCode, stdout, stderr,
  durationMs, reason?, error?, parsed?, … }` where `reason` is a failure code
  such as `"timeout"`, `"spawn_failed"`, `"non_zero_exit"`, or `"parse_error"`.

**SDK path** (`src/integrations/harnesses/opencode-sdk/sdk-runner.ts`):

- `runOpencodeSdk(profile, prompt, opts, llmConfig?)` uses the embedded
  `@opencode-ai/sdk` instead of `Bun.spawn`. The SDK starts `opencode serve`
  and talks to it over HTTP, so the `opencode` binary must be on `PATH`.
- Selected by an agent engine whose `platform` is `"opencode-sdk"`. Its optional
  `llmEngine` supplies the LLM fallback connection. With none, there is no
  fallback and opencode uses its own configuration; `defaults.llmEngine` is not
  borrowed.
- One `opencode serve` child is started per distinct child environment and
  cached for the process; each dispatch creates its own session, which stays in
  OpenCode's history. The working directory is passed per call.
- A cached server keeps the event loop open, so a dispatching command closes
  the registry (`disposeDispatchResources`, `src/integrations/agent/runner-dispatch.ts`)
  when it finishes — from the CLI composition root and from the `finally` of
  `akm workflow run` — on every exit path. A new dispatch backend that leaves a
  long-lived child process running must be closed by that same drain.

---

## Locks

Long-lived mutable operations each take their own lock file, one `O_EXCL`
create (`src/core/file-lock.ts`, `src/core/run-lock.ts`): index writers, improve
and extract process locks, lockfile writers, the scheduler lock, and each
workflow run's lock. A lock whose holder process is gone is reclaimed; nothing
expires by age. There is no shared barrier or activity registry around them;
`state.db` writers serialize on SQLite's own `BEGIN IMMEDIATE`.

---

## Module Boundaries

| Module | Responsibility |
| --- | --- |
| `src/cli.ts` | composition root; per-family parsing lives in `commands/<family>/*-cli.ts` |
| `src/cli/` | citty composition helpers |
| `src/core/asset/asset-placement.ts` | asset type registry and canonical source directories (`PLACEMENT_SPECS`) |
| `src/core/asset/asset-ref.ts` | asset ref parsing and normalization (`parseBundleRef`) |
| `src/core/adapter/` | the `BundleAdapter` contract and the built-in adapters (see [Adapters](adapters.md)) |
| `src/core/config/config.ts` | config loading, validation, env resolution |
| `src/core/errors.ts` | error classes with stable codes and hints |
| `src/core/parse.ts` | shared JSON parsing: think/fence stripping, balanced-brace extraction |
| `src/core/concurrent.ts` | bounded concurrency pool (`concurrentMap`, default 1 worker) and keyed serialization |
| `src/core/write-source.ts` | the single write helper (branches on `source.kind`) |
| `src/execution/resolved-request.ts` | the versioned resolved execution request and its canonical wire form (tolerant decode) |
| `src/integrations/agent/execution.ts` | `resolveExecution` (engine, layers, model alias, tools) and `buildExecution` / `buildExecutionFromWire` |
| `src/integrations/agent/runner-dispatch.ts` | `runExecution`: reads credentials at dispatch, runs agent/SDK/LLM, redacts the result |
| `src/integrations/agent/request-lowering.ts` | shared factory for the harness-owned request builders |
| `src/sources/provider.ts` | minimal `SourceProvider` interface |
| `src/sources/providers/` | filesystem / git / website / npm implementations |
| `src/sources/resolve.ts` | filesystem path resolution for refs |
| `src/storage/repositories/` | SQL for `index.db`, `state.db`, and `logs.db` (entries, FTS, proposals, task history, workflow runs, …) |
| `src/indexer/indexer.ts` | walking, metadata generation, index rebuilds, embeddings, utility recompute |
| `src/indexer/walk/` | walker, matchers, path/file/index context — the walk phase |
| `src/indexer/db/` | `llm-cache` — the persistence phase (entries/embeddings persistence lives in `src/storage/repositories/`) |
| `src/indexer/search/` | `db-search`, `fts-query`, ranking, search-fields, search-source, enrichers — the search phase |
| `src/indexer/passes/` | memory-inference, dir-staleness, metadata — LLM/metadata passes |
| `src/indexer/usage/` | usage-events |
| `src/commands/read/search.ts` | `akm search` orchestration |
| `src/commands/read/show.ts` | `akm show` orchestration |
| `src/commands/improve/` | knowledge-evolution slice (improve/consolidate/distill/extract/reflect + `memory/`) |
| `src/commands/proposal/` | proposal-queue slice (proposal/propose + `validators/` core 3-cycle) |
| `src/commands/sources/` | source/stash lifecycle command surface |
| `src/commands/env/` | env/secret command surface |
| `src/commands/tasks/` | scheduled-task command surface |
| `src/commands/agent/` | contribute/agent command surface |
| `src/registry/providers/` | registry provider implementations (static-index, skills-sh) |
| `src/output/shapes/`, `src/output/text/` | JSON-envelope and text-output registries per command — a parallel concern to `src/output/renderers.ts`'s per-asset-type `show` renderers, which register themselves when the module loads |
| `src/workflows/authoring/` | workflow authoring + scope-key helpers |
| `src/workflows/runtime/runs.ts` | workflow run persistence (raw SQL lives in `src/storage/repositories/workflow-runs-repository.ts`) |
| `src/workflows/runtime/` | run lifecycle: runs, run-plan decoding, run outputs, agent-identity |
| `src/llm/client.ts` | OpenAI-compatible chat completions client (stateless, single request/response) |
| `src/llm/index-passes.ts` | per-pass LLM config resolution for `akm index` |
| `src/llm/memory-infer.ts` | atomic-fact split helper (selected through `improve.strategies.<name>.processes.memoryInference`) |
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
- Database: `bun:sqlite` with FTS5; vectors are float32 BLOBs scanned in JavaScript
- Testing: `bun:test`
- Formatting/linting: Biome
