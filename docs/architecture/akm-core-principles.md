# akm Core Principles

akm is a portable capability library for AI agents — give every coding agent
the capabilities your team has already built. It indexes existing agent
assets in place, loads only what a task needs, packages capabilities into
shareable bundles, improves the library through reviewable proposals, and
runs durable workflows, locally and without tying the library to one
assistant.

## Precedence

When two principles collide, the one that protects a user's files and data wins, then the one that
keeps output lean, then everything else. When the code violates a principle, the code is wrong.
The exception is a principle this document marks as a goal not yet reached.

## Principles

### 1. Files are the truth

Capabilities are ordinary files in bundles. The index (`index.db`) is a derived view that
`akm index` rebuilds from those files, and the only other authoritative store is `state.db`
(events, proposals, runs, salience); `logs.db` holds purgeable task log lines. Every change akm makes to a
capability lands as a file inside a bundle: an accepted proposal becomes the asset, memory
inference writes derived children, retirement leaves an archive and a tombstone, and extraction
writes session assets. `state.db` holds akm's bookkeeping about those files, never the
capabilities themselves.

Cost: The index can lag the files until `akm index` runs, and anything held only in `state.db` does not travel with a bundle.

Enforced by: `tests/integration/indexer/ensure-index-serve.test.ts` (a missing index rebuilds from the files); the rule that akm's own writes land as files is not enforced; relies on review.

### 2. One local retrieval layer

Every configured source, whatever its kind, materializes to a directory on disk, and the indexer
walks those directories the same way. `search`, `curate` and `show` therefore behave the same
wherever a file came from, and `show` resolves through the index and reads from disk. Registries
are a separate, read-only catalog of installable bundles: their results are opt-in and appear in
`registryHits`, never merged into source `hits`.

Cost: A source must be synced to disk before it is searchable, so there are no remote-only sources and no live queries against an upstream.

Enforced by: the `SourceProvider` interface in `src/sources/provider.ts` (it has a name, kind, path and optional sync, and no query method; adding one is a visible interface change) and `tests/integration/output-baseline.test.ts` (registry hits arrive in `registryHits`).

### 3. Discovery chooses, show delivers, the file is the last resort

`search` and `curate` return enough to pick an asset and a `ref` to act on; `show` returns the
payload. The `ref` is present in every search, curate and show result, at every detail level and in
every shape. Agent-shaped search, show and curate results also carry the file `path` and whether it is
`editable`, for anything `show` does not deliver.

Cost: Default search results carry no description, so a caller sometimes needs a second call to choose between near matches.

Enforced by: `tests/output-shapes-unit.test.ts` (fields per detail level and shape) and `tests/integration/output-baseline.test.ts` (default search and show output).

### 4. Refs are path identities, passed back unchanged

A ref names an asset: an optional bundle, `//`, then the slash-separated concept id of the
asset inside that bundle. `show` also accepts a `#fragment` that selects a section; every other
boundary rejects it. A ref without a bundle resolves against `defaultBundle`, then the remaining
bundles in installation-priority order. A person may type a short ref; an agent hands back the refs akm emitted
rather than parsing or rebuilding them. Renaming or moving an asset gives it a new identity.

Cost: A rename or move orphans the feedback and usage history recorded against the old ref.

Enforced by: `tests/asset-ref.test.ts` and `tests/resolve-ref.test.ts` (grammar, resolution order, fragment boundary) and `tests/contracts/ref-resolver-contract.test.ts` (ref to file mapping).

### 5. Execution happens only through named surfaces

akm runs code only through: workflow runs, tasks (including scheduled ones), agent and command
dispatch, `env run` and `secret run` (read a value and inject it into a child process), the
improve and proposal processes, index passes, and fetcher modules in the working bundle's
`scripts/wiki-fetchers/` directory, imported during any website sync. `search` and `show` never
execute anything. A script runs only as a task or workflow target; `show` returns its run hint
as text. `upgrade`, `health` and source sync run tools akm itself chooses, such as git, npm and
the harness CLIs; none of that is indexed content.

Cost: Running anything new means adding a named surface here, and a fetcher module in the working bundle runs whenever a website source syncs, with no separate approval.

Enforced by: not enforced; relies on review.

### 6. Improvement is review-first

Proposals are the unit of change: `improve` stages reflect, distill, consolidate and extract output
as proposals that a person accepts, rejects or reverts. With `experimental.improveAutonomy` on,
three lanes act without a person: memory inference, memory cleanup, and triage in `promote` mode,
where the drain accepts the proposals an LLM judge passed and the retire proposals the
consolidation pair pass itself staged. Regardless of that setting, `improve` writes session assets,
purges retirement archives past their grace period, commits accepted proposals, and by default
commits and pushes a git-backed bundle at the end of a run.

Cost: Unattended improvement is slower and the proposal queue needs tending.

Enforced by: `tests/improve-plan-autonomy-wiring.test.ts` and `tests/config-experimental-improve-autonomy.test.ts` (the gate and its default of off); the always-on writes are not enforced; relies on review.

### 7. Writes go through one chokepoint and resolve one way

`src/core/write-source.ts` is the only module that branches on a source's kind for writes. A
destination resolves in one order: the `--target` flag, then `defaultWriteTarget`, then the
working bundle (`defaultBundle`), then an error. A destination that is not writable is an error,
never a fallback to another source. akm never prints env and secret values: `list`, `show` and
search return names only, and values reach a child process through `env run` and `secret run`
or a file through `env export --out`.

Cost: A write with no usable destination stops and asks for one instead of guessing.

Enforced by: `tests/integration/write/write-source.test.ts` (resolution order and the non-writable error), `tests/integration/env/env.test.ts` and `tests/integration/secret/secret-indexing.test.ts` (values stay out of the index and `show`); the single-chokepoint rule is not enforced; relies on review.

### 8. Output is for automation first

The defaults are `--format json`, `--detail brief` and `--shape human`. The human shape is the
default projection and the agent shape (`--shape agent`) is opt-in and Experimental. Fuller detail
is opt-in, and failures print as `{ok, error, code}` on stderr with a stable exit code.

Cost: Default output is terse for a person at a terminal, who asks for `--format text` or `--detail normal` to see more.

Enforced by: `tests/integration/output-baseline.test.ts` (default JSON for search and show) and `tests/output-shapes-unit.test.ts`.

### 9. Harnesses are plural and registered in one place

Any number of agent harnesses may exist. Each registers once in `HARNESS_REGISTRY`
(`src/integrations/harnesses/index.ts`), and core code imports the registry, not a harness. That
is a goal not yet reached: today the opencode-sdk path is still special-cased in the config
schema, setup, health, the implicit engine fallback and workflow teardown, setup's config import
reads two harnesses directly, and the SDK is a hard dependency; closing that gap is open work.

Cost: A new harness has to fit the shared registry shape, which a one-off integration would not.

Enforced by: the construction-time drift guard on `HARNESS_REGISTRY` for registration; the no-direct-imports rule is not enforced; relies on review.

### 10. Host authority is local and never inferred

Inherited config (`extends`) shares portable policy only; sources, defaults, registries, scheduler,
execution and experimental state, credentials and connections stay in the host's own config.
Installing a bundle does not schedule its tasks, a disabled bundle is inert for reads, writes,
indexing and execution, and the default bundle is carried explicitly, never inferred from position.
Runtime code fills in no authority on its own, except that a config without `scheduler.enabled`
adopts the scheduler entries akm already wrote on this host.

Cost: A shared config cannot set up a new machine end to end; each host still declares its own sources, credentials and scheduled tasks.

Enforced by: `tests/config.test.ts` (inherited host-local keys are dropped, `HOST_LOCAL_CONFIG_KEYS` in `src/core/config/config.ts`) and `tests/core/activation-policy.test.ts`.

### 11. Guards must earn their place

A guard, cap, version gate or fencing check stays only if it has demonstrably helped a real user.
It also stays only if its failure mode costs less than the hazard it prevents. And it stays only
if the operation is not already gated behind a deliberate human command. When something must
change, remove the limit first, degrade with a warning second and abort last; machinery that
prevents data loss or corruption is exempt.

Cost: Some conceivable hazards go unguarded, and a removed guard can let a bad input through.

Enforced by: not enforced; relies on review.

## What akm does not do

- replace MCP or assistant-native skills; it complements them
- require agents to understand source layouts or provider internals
- publish to registries; registries are read-only catalogs
- serve remote-only sources; every source is materialized on disk first
