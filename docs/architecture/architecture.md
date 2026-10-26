# Architecture

akm is a Bun-based CLI for discovering and using agent assets from local
filesystem sources, cache-backed sources (git, website, npm), and registry
catalogs.

This document is the operating summary of the current architecture and is the
current-truth reference.

---

## Invariants

These behaviors hold across every command. Each names the test that pins it;
one that names none is held by review. The rules for how the code itself is
written are in [Core Principles](akm-core-principles.md).

- **Files are the truth.** Capabilities are files in bundles. `index.db` is
  a derived view that `akm index` rebuilds; `state.db` holds akm's
  bookkeeping (events, proposals, runs, salience), never capability
  content; `logs.db` holds purgeable log lines. Every change akm makes to a
  capability lands as a file: an accepted proposal becomes the asset, memory
  inference writes derived children, retirement leaves an archive and a
  tombstone, extraction writes session assets. Pinned by
  `tests/integration/indexer/ensure-index-serve.test.ts`.
- **One local retrieval layer.** Every source materializes to disk and is
  indexed the same way; `show` resolves through the index and reads from
  disk. Registry results are opt-in and arrive in `registryHits`, never
  merged into `hits`. A source provider fetches and refreshes and implements
  no search or show, so source resolution, registry install and provider
  plumbing stay behind indexing and the path from `search` or `curate` to
  `show` is a lookup in the local index. Pinned by the `SourceProvider`
  interface in `src/sources/provider.ts` and
  `tests/integration/output-baseline.test.ts`.
- **Discovery chooses, show delivers.** `search` and `curate` return enough
  to pick an asset and its `ref` at every detail level (a registry hit
  carries `installRef` instead); `show` returns the payload; `--detail agent`
  results also carry `path` and `editable`. Pinned by
  `tests/output-shapes-unit.test.ts` and `tests/output-baseline.test.ts`.
- **Every token earns its place.** Default output is lean: `--detail brief`
  lists only what is needed to choose the next asset, and `normal`, `full`
  and `agent` widen or reshape it. `show` returns what a consumer needs to
  act on the asset (a script's run hints, a skill's instructions, a
  command's template, an agent's prompt, knowledge content, a workflow's
  steps and parameters, env key names, secret metadata) and never an env or
  secret value. Pinned by `tests/output-shapes-unit.test.ts`.
- **Refs are path identities.** `[bundle//]conceptId`, with `#fragment`
  accepted by `show` only. A short ref resolves against `defaultBundle`,
  then the remaining bundles in installation order. A rename is a new
  identity. An agent passes the ref `search` returned to `show` and never
  parses or builds one. Pinned by `tests/asset-ref.test.ts`,
  `tests/resolve-ref.test.ts` and
  `tests/contracts/ref-resolver-contract.test.ts`.
- **Execution happens only through named surfaces.** Workflow runs, tasks,
  agent and command dispatch, `env run` and `secret run`, the improve and
  proposal processes, index passes, and fetcher modules in the working
  bundle's `scripts/wiki-fetchers/` directory during website sync. `search`
  and `show` execute nothing; a script runs only as a task or workflow
  target. Held by review.
- **Improvement is review-first.** Proposals are the unit of change: reflect,
  distill, extract and consolidate only emit proposals. Three lanes act
  without a person, and only with `experimental.improveAutonomy` on: memory
  inference, memory cleanup, and a triage promote that runs the judgment
  tier (a promote through the deterministic gates alone needs no opt-in). A
  fix a person types with `akm feedback --replace` is applied at once, as a
  normal accept that `akm proposal revert` undoes. Regardless of the opt-in,
  session extraction writes session assets, and `improve` purges graced
  archives, commits accepted proposals and auto-syncs a git-backed bundle.
  Pinned by
  `tests/improve-plan-autonomy-wiring.test.ts` and
  `tests/config-experimental-improve-autonomy.test.ts`.
- **Writes resolve one way.** An explicit `--bundle`, then
  `defaultWriteTarget`, then the working bundle, then an error. A
  destination that is not writable is an error, never a fallback. Env and
  secret values are never printed. Pinned by
  `tests/integration/write/write-source.test.ts`,
  `tests/integration/env/env.test.ts` and
  `tests/integration/secret/secret-indexing.test.ts`.
- **Output is for automation first.** `--format json` and `--detail brief`
  by default; failures are `{ok, error, code}` on stderr with a stable exit
  code. Pinned by `tests/integration/output-baseline.test.ts` and
  `tests/integration/cli-errors.test.ts`.
- **A workflow run executes the plan frozen at creation.** The plan, the
  resolved request, the runner selection and the fan-out widths are
  journaled when the run starts; a resumed run reads the journal and never
  config, so editing config changes the next run and not the one in flight.
  The journaled runner is symbolic (a `$VAR` reference, or a connection's name
  for its stored key), so a credential is not frozen: dispatch materializes the
  current key, for the frozen endpoint only. Pinned by `tests/workflows/child-plan-immutability.test.ts`
  and `tests/workflows/immutable-execution-v4-red.test.ts`.
- **Host authority is local and never inferred.** Inherited config shares
  portable policy only. A disabled bundle (`enabled: false`) is inert across
  content reads, writes, indexing and execution; an explicit bundle lifecycle
  command may still update a named disabled bundle without activating it. The
  default bundle is carried as explicit identity and default status, never
  taken from array position. Runtime code never invents authority: the one
  host-local choice it fills in by itself is `scheduler.enabled`, and only from
  evidence the operator already created on this host (a config without the list
  takes the akm-written rows already in the native scheduler as the choice;
  see [Configuration](../reference/configuration.md#scheduler-activation)).
  Anything else that would need a new trust decision is reported, never
  invented. Pinned by `tests/config.test.ts` and
  `tests/source-source.test.ts`.
- **An unsafe override names one risk.** `--allow-insecure-transport` allows
  plain HTTP and nothing else, and there is no combined bypass. Pinned for the
  flag by `tests/integration/registry/registry-network-boundary.test.ts`; the
  absence of a combined bypass is held by review.

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

URI schemes (`viking://...`, `github://...`) are **not** asset refs. Install
locators like `github:owner/repo`, `git+https://...`, `npm:@scope/pkg`,
`skills.sh:slug`, and `./local/path` are a separate grammar parsed by
`parseRegistryRef` in `src/registry/resolve.ts` and consumed by
`akm add` / `akm clone`.

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
type, tag, graph, usage or belief-state signals — changes the order. The
design and its measured alternatives are in the retrieval evaluation
(`akm/eval/retrieval/reports/baseline-2026-09-27.md`).

Notes:

- lexical queries are tokenized once with Unicode letter/number semantics,
  lowercased, and stripped of English stopwords unless the query is nothing
  else; the tokens are quoted and OR-ed
- the query embedding is requested before the FTS query runs and is bounded
  by `embedding.queryTimeoutMs` (default 3000); on timeout or failure the
  search is served by the lexical list alone
- Markdown fragments are not searched; `akm show` reads the stored safe
  Markdown (`entry_fragments`) for `#fragment` refs
- `hints` includes `searchHints`, `examples`, `usage`, intent fields, wiki
  cross-references, and page-kind hints
- `content` is bounded low-weight body prose plus TOC headings and parameter metadata; secret/env/session material is excluded at the adapter boundary
- registry results live in `registryHits`, never in `hits`
- `--from all` keeps registry results in `registryHits` — they are not
  rank-merged with source hits
- curate carries search's normalized scope/source/type/belief controls through
  selection, derived-surface enrichment, support refs and packing. Search and curate default
  to current; explicit all/historical evidence is labelled as historical context.
  Direct show remains a deliberate inspection path without a belief default.
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
place in the codebase that branches on `source.kind`. Review holds that line
(core principle 2); the lint script that once checked it was deleted.

Command layers therefore never hold provider knowledge. Where a step is
meaningful only for a publication-backed target, `write-source.ts` exposes a
kind-neutral wrapper that absorbs the guard and no-ops otherwise:
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
destination flag (`--bundle`) -> `config.defaultWriteTarget` -> working
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
`--bundle` that resolves elsewhere. An unbound short proposal requires either
an explicit `--bundle` or an authenticated `--queue` context; it does not
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

Utility is feedback-driven and rebuilt from `usage_events`. It orders
improve's salience work; search ranking does not read it.

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

## Connections and Harnesses

akm reaches models through two things, and nothing else is configured to run
work. A **connection** is an OpenAI-compatible endpoint with an optional key and
the models it serves under aliases. A **harness** is an agent program the user
already has (Claude Code, Codex, OpenCode, and the other platforms registered in
`HARNESS_REGISTRY`). The connection named `default`, or the only one, is the
default connection; harnesses follow the same rule. Public execution selection
names a connection or a harness, never a profile, and
[Configuration](../reference/configuration.md) is the reference for both.

What runs where follows from the kind of work:

- **Model work** (the improve processes, judges, index passes, extraction,
  `remember --enrich`) runs on the default connection as a direct request to its
  endpoint; with no connection, on the default harness, with its tools restricted
  where the harness can be.
- **Agent work** (`akm agent`, `command run`, `proposal new`, agent tasks,
  workflow agent steps) runs on the default harness; with no harness, on **akm's
  own runtime** over the default connection. The runtime is an OpenCode embedded
  in akm's process, has no name in config, and is not a harness.
- With neither a connection nor a harness, those features are off, and each
  command that needs one says so and points at `akm setup`. There is no fallback
  and nothing hidden.

Every execution — direct commands, tasks, workflows, improve, proposals, and
index passes — takes the same steps
(`src/integrations/agent/resolution.ts`, `execution.ts`, `runner-dispatch.ts`):

```text
adapter-rendered or anonymous work
  -> resolveExecution(input)          -> { request, runner (a RunnerSpec), provenance }
  -> buildExecution(request, runner)  -> harness argv inputs, runtime inputs, or chat messages
  -> runExecution(built, options)     -> harness program, embedded OpenCode, or direct chat
```

`resolveExecution` asks `resolveTarget` (the one resolver; `akm health`, `akm
info` and `akm task explain` use it too, so what they print is what a call does)
for the connection or harness and the model, then merges one set of defaults,
nearest wins. The layers run farthest to nearest: the shipped alias for the kind
of work, the configuration for the process, the persona, the command, the
invocation defaults, and the current call's flags. A connection or harness that
is named and not configured is an error (exit 78) that lists the configured names;
the default is used only when nothing was named. A
model is an alias, looked up on the selected connection or harness, or an exact
name; the request records the exact final model. A connection's request fields
and the model entry's are sent as written, under the portable settings
(`temperature`, `maxTokens`, ...) the layers ask for, which the one translation
in `src/core/llm-inference.ts` writes in the endpoint's own spelling. Omitted,
explicit `null`, zero, and empty values stay distinct. The result's
`provenance` names the layer behind each field (`akm task explain`,
`command run --dry-run`).

`buildExecution` hands the request to the selected harness's own builder
(registered on `HARNESS_REGISTRY`), to the runtime's lowerer, or builds chat
messages for a direct request. A harness builder is a thin shell: it names the
program's arguments, delivers the prompt (on stdin where the program reads it,
as an argument otherwise) and takes standard output as the reply. A field the
transport cannot carry becomes a secret-free `untranslated-field` notice and
dispatch continues.

Credentials stay symbolic (a `$VAR` reference, or the connection's name for its
`credentials.json` entry) in everything `resolveExecution` returns, so a request
and runner can be journaled. `runExecution()` materializes the current value at
each dispatch (`src/core/config/credentials.ts`: the variable's value, else the
key stored for that connection and the endpoint it was frozen with) and scrubs it,
with every other secret-looking value the child could see, from the result. Two
things are therefore different at resume: workflow resume calls
`buildExecutionFromWire()` on the journaled `{ request, runner }` and reads no
config, so a config edit after the freeze cannot change a resumed unit's
endpoint, model or settings; but the key is read again at dispatch (a stored key is used only for a
connection this host's own config defines), so a rotated key reaches the resumed
unit, and only at the endpoint it was frozen with. The prompt-free interactive `akm agent` launch resolves its
harness directly and starts it with the terminal inherited; a connection has
nothing to start.

A config in the older `engines` form is converted to `connections` and
`harnesses` by one pure function (`src/core/config/convert-engines.ts`), in
memory on every load and permanently by `akm migrate apply`.

Task source v4 execution and durable workflow dispatch use this runtime
boundary. Markdown workflows compile through source IR v1; new starts freeze
`irVersion: 8`, which records a connection or harness where earlier versions
recorded an engine. A stored plan that decodes runs whatever release froze it
(plans with only exec steps from `irVersion` 5 on decode); one that does not,
which includes every earlier plan with a command step, is marked abandoned and
`akm workflow run <ref>` starts afresh. Only a plan a newer akm froze is
refused, naming the upgrade. AKM does not support full GitHub Actions semantics
or arbitrary remote action execution.

### In-tree LLM helpers (`src/llm/`)

Every helper under `src/llm/` is a **bounded, single-shot, stateless** call.
Concretely:

- Each public export is either a stateless function (`chatCompletion` performs
  one HTTP request and keeps nothing between calls; `splitMemoryIntoAtomicFacts`,
  `resolveIndexPassExecution`, `parseJsonResponse`, …) or a factory that returns
  a one-shot client tied to the symbolic runner/config the caller passes in.
- No module under `src/llm/` keeps session, conversation, or response state at
  module scope. The only module-level singleton is the local embedder
  pipeline in `src/llm/embedder.ts`, which is an expensive-to-build but
  stateless model handle (see the comment in that file). It exposes
  `resetLocalEmbedder()` so tests can construct a fresh pipeline.
- `callStructured()` is the common bounded structured-LLM seam: it adapts an
  already-resolved symbolic runner into an inline resolved request, lowers it,
  and dispatches it through `runExecution`, which materializes the connection's
  key at dispatch like every other dispatch and re-runs no alias resolution.
  Index callers use `resolveIndexPassExecution()` to freeze the typed
  `{ runner, notices }` selection once per invocation; there is no separate
  readiness projection. Which improve processes run is chosen
  by `improve.strategies`, and where each runs by `improve.processes`; see
  `docs/reference/configuration.md` for canonical config paths.

Review holds the seam; the test that once inspected the module shape of each
`src/llm/*` entry was deleted.

### External agents (`src/integrations/agent/`, `src/integrations/harnesses/`)

Agent programs are reachable by two execution paths, both behind
`runExecution`:

**Spawn path** (`src/integrations/agent/spawn.ts`):

- `runAgent(profile, options)` is the single shell-out entry point. It owns
  process spawn, captured/interactive stdio, hard timeout, and structured
  failure reasons. The child's environment is an allowlist plus the directories
  this akm resolved and the harness's own pass-through names.
- The `opencode` harness is the user's installed OpenCode, both majors, through
  `opencode run` with the prompt on stdin
  (`src/integrations/harnesses/opencode/agent-builder.ts`). Their OpenCode owns
  its configuration, logins and sessions; akm embeds, copies and reads none of it
  to run.
- The `AgentRunResult` envelope carries `{ ok, exitCode, stdout, stderr,
  durationMs, reason?, error?, ... }` where `reason` is a typed code such as
  `"timeout"`, `"spawn_failed"`, `"non_zero_exit"` or `"parse_error"`. Callers
  never see raw process errors.

**Embedded OpenCode** (`src/integrations/harnesses/opencode/embedded/`):

- It is akm's agent runtime behind one application-owned port,
  `src/integrations/agent/runtime-port.ts`: the lowering target a request is
  lowered for (`lowering`), `run` for one resolved dispatch, and `dispose` for what
  the process started. Lowering and dispatch use only the port; the one module that
  names this folder is `src/integrations/agent/runtime.ts`, and the folder reads no
  config (`tests/contracts/runtime-port-boundary.test.ts` checks both).
- It is OpenCode 2 in akm's process through `@opencode/sdk`
  (`OpenCode.create()`, an in-memory router): no binary, no server, no port.
  Only this folder imports `@opencode/*` (one file, `sdk-host.ts`, does the SDK
  wiring), and only lazily, so the harness stays replaceable.
- A process starts one host, on first use, kept until
  `disposeDispatchResources()`: akm's own agent runtime, driven by the connection
  a run was dispatched with (a provider declared from that connection's
  endpoint, model and context window as the run froze them, never from the live
  config; no user or project OpenCode configuration, though OpenCode still reads
  `~/.agents` and its system config; its files under akm's data, cache and state
  directories). The host serves any number of sessions; what differs per call
  (model, environment, request fields, persona) is set on the session.
- The host loads akm's plugin: `akm_search`, `akm_show` and `akm_curate` run in
  akm's process, and the connection's key and request fields are laid over the
  runtime's requests per session.
- A model-work call on a connection never reaches the runtime, it goes straight
  to the endpoint.
- Every session is stored in akm's own OpenCode database
  (`<akm data dir>/opencode.db`), which `akm proposal extract --type opencode`
  reads back with SQLite alone, beside your own OpenCode's database.
- Nobody can answer an akm run: questions are cancelled and permission requests
  rejected, each with a message, and the model carries on.
- One deadline and one abort signal govern a run from the start of its host to
  the end of its turn (`runOpencodeSdk`, `src/integrations/harnesses/opencode/embedded/run.ts`):
  every step is raced against them, a step that finishes after either has fired
  starts nothing more, and a session such a step created is released. Closing the
  host (`closeOpencodeSdk`) asks a start in flight to stop and waits at most 5 s
  for it, then at most 5 s for the host to close, naming in a warning what did
  not finish.

New tasks are task source v4 `.yml` assets. Normal execution rejects v2 and v3
and directs operators to the explicit preview/apply migrator. Task source v4
command, workflow, script, and shell targets use the common resolved/lowered
execution boundary. Historical task-run metadata remains readable.

Long-lived mutable operations each take their own lock file, one `O_EXCL`
create (`src/core/file-lock.ts`): index writers, improve and extract process
locks, lockfile writers, the scheduler lock, and each workflow run's lock. A
lock whose holder process is gone is reclaimed. There is no shared barrier or
activity registry around them; `state.db` writers serialize on SQLite's own
`BEGIN IMMEDIATE`.

---

## Module Boundaries

| Module | Responsibility |
| --- | --- |
| `src/cli.ts` | composition root; per-family parsing lives in `commands/<family>/*-cli.ts` |
| `src/cli/` | citty composition helpers |
| `src/core/asset/asset-placement.ts` | asset type registry and canonical source directories (`PLACEMENT_SPECS`) |
| `src/core/asset/asset-ref.ts` | asset ref parsing and normalization (`parseBundleRef`) |
| `src/core/config/config.ts` | config loading, validation, env resolution; the default connection and harness |
| `src/core/config/credentials.ts` | `credentials.json` and the dispatch-time resolution of a connection's key (`$VAR`, else the stored entry) |
| `src/core/config/convert-engines.ts` | the one conversion of the older `engines` / `defaults` form to `connections` / `harnesses`, called by the loader and by `akm migrate apply` |
| `src/core/errors.ts` | error classes with stable codes and hints |
| `src/core/parse.ts` | shared JSON parsing: think/fence stripping, balanced-brace extraction |
| `src/core/concurrent.ts` | bounded concurrency pool (`concurrentMap`, default 1 worker) |
| `src/core/write-source.ts` | the single write helper (branches on `source.kind`) |
| `src/execution/resolved-request.ts` | the versioned resolved execution request and its canonical wire form (tolerant decode) |
| `src/integrations/agent/resolution.ts` | `resolveTarget`: the connection or harness a call runs on, and its model, timeout and request fields |
| `src/integrations/agent/execution.ts` | `resolveExecution` (target, layers, model alias, persona) and `buildExecution` / `buildExecutionFromWire` |
| `src/integrations/agent/runner-dispatch.ts` | `runExecution`: reads credentials at dispatch, runs harness / runtime / chat, redacts the result |
| `src/integrations/agent/request-lowering.ts` | lowers a resolved request for a harness or the runtime, reporting what the target cannot carry |
| `src/integrations/harnesses/` | `HARNESS_REGISTRY` and one folder per harness (thin shells that turn a request into argv, env and stdin) |
| `src/commands/targets.ts` | the table of connections, harnesses and the work on them that `akm health`, `akm info` and `akm setup` print |
| `src/sources/provider.ts` | minimal `SourceProvider` interface |
| `src/sources/providers/` | filesystem / git / website / npm implementations |
| `src/sources/resolve.ts` | filesystem path resolution for refs |
| `src/indexer/indexer.ts` | walking, metadata generation, index rebuilds, embeddings, utility recompute |
| `src/indexer/walk/` | walker, matchers, path/file/index context — the walk phase |
| `src/indexer/db/` | `llm-cache` — the persistence phase (entries/embeddings persistence lives in `src/storage/repositories/`) |
| `src/indexer/search/` | `db-search`, ranking, search-fields, search-source, enrichers — the search phase |
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
| `src/output/shapes/`, `src/output/text/` | JSON-envelope and text-output registries per command (#490) — a parallel concern to `src/output/renderers.ts`'s per-asset-type `show` renderers, which is still live and self-registering, not replaced |
| `src/workflows/authoring/` | workflow authoring |
| `src/workflows/runtime/runs.ts` | workflow run persistence (raw SQL lives in `src/storage/repositories/workflow-runs-repository.ts`) |
| `src/workflows/runtime/` | run lifecycle: runs, checkin, agent-identity |
| `src/llm/client.ts` | OpenAI-compatible chat completions client (stateless, single request/response) |
| `src/llm/index-passes.ts` | per-pass connection or harness resolution for `akm index` (`index.*`) |
| `src/llm/memory-infer.ts` | atomic-fact split helper (runs where `improve.processes.memoryInference` or `index.memory` says) |
| `src/llm/embedder.ts` | local + remote embedder facade with cached pipeline |
| `src/integrations/agent/spawn.ts` | agent CLI shell-out entry point (`runAgent`) |
| `src/integrations/harnesses/opencode/embedded/` | the embedded OpenCode: akm's own runtime |
| `src/integrations/agent/profiles.ts` | internal spawn descriptors, built from the harness registry |
| `src/llm/structured-call.ts` | bounded structured-LLM adapter through the common resolved/lowered execution seam |
| `src/integrations/agent/detect.ts` | PATH-based agent CLI detection for `akm setup` |

---

## Tech Stack

- Runtime: Bun
- Language: TypeScript (ESM, strict)
- Database: `bun:sqlite` with FTS5; vectors are float32 BLOBs scanned in JavaScript
- Testing: `bun:test`
- Formatting/linting: Biome
