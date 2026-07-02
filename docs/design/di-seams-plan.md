# DI seams plan — replace `mock.module` with swap-and-restore module seams

Branch: `refactor/di-seams`

## Guardrails (binding, non-negotiable)

This workstream was previously done wrong (~900 dependency-injection parameter
threads, reverted). The rules for THIS attempt:

- **Swap-and-restore, not parameter threading.** Model: `withMockedFetch` in
  `tests/_helpers/sandbox.ts` (swap `globalThis.fetch` → run → finally-restore)
  and `src/storage/database.ts`'s "plain module, not an adapter layer" stance.
- Each seamed module keeps its normal exports. Internally the exported function
  delegates through one module-level binding. The module gains exactly ONE small
  test-only override function (`_set…ForTests(fake | undefined)`); passing
  `undefined` restores the real implementation.
- **Zero changes to production call sites.** No context objects, no new
  parameters on existing functions, no interfaces/ports/adapters, no factories,
  no new wrapper modules. If a module seems to need call-site changes, STOP.
- Net diff per module: tens of lines in `src`, offset by deleted `mock.module`
  boilerplate in tests.
- The override function is inert unless a test calls it. Production behavior is
  byte-identical.

## The seam pattern (canonical shape)

For a module exporting `foo(a, b)`:

```ts
// ── Test seam ────────────────────────────────────────────────────────────────
// Swap-and-restore override. Inert in production; only tests call the setter.
let fooOverride: typeof fooReal | undefined;

/** TEST-ONLY. Swap the implementation of `foo`; pass undefined to restore. */
export function _setFooForTests(fake?: typeof fooReal): void {
  fooOverride = fake;
}

export function foo(a: A, b: B): R {
  if (fooOverride) return fooOverride(a, b);
  return fooReal(a, b);
}

function fooReal(a: A, b: B): R {
  // …existing body, renamed, NOT exported…
}
```

Notes on the shape:

- The existing exported function body is renamed to a private `…Real` function;
  the export becomes a 2-line delegator. Importers see the identical signature.
- Intra-module calls to the exported name (e.g. `client.ts` calls its own
  `chatCompletion` from `probeCapabilities`) go through the delegator too.
  This is a *superset* of what `mock.module` guarantees for internal callers
  and matches the tests' intent (no network, ever).
- One setter per module. When a module has several overridable exports, the
  setter takes a partial overrides object (see per-module specs) — still ONE
  test-only export, one internal binding.
- Naming convention: `_set<Thing>ForTests`, prefixed `_` so the
  it's self-evidently not public API. Never call it from `src`.

## Shared test helper — `tests/_helpers/seams.ts` (new file, ~40 lines)

```ts
// tests/_helpers/seams.ts
type SeamSetter<T> = (fake: T | undefined) => void;

/** Setters that currently hold a fake; drained by resetAllSeams(). */
const active = new Set<SeamSetter<unknown>>();

/**
 * Install a fake for the current test. Restoration is automatic: the
 * tests/_preload.ts afterEach calls resetAllSeams(). Use this for
 * file-scoped or beforeEach-scoped fakes (the common case, mirroring
 * today's top-of-file mock.module blocks).
 */
export function overrideSeam<T>(set: SeamSetter<T>, fake: T): void {
  set(fake);
  active.add(set as SeamSetter<unknown>);
}

/** Scoped swap → run → finally-restore, for fakes needed in one test only. */
export async function withSeam<T, R>(
  set: SeamSetter<T>,
  fake: T,
  run: () => R | Promise<R>,
): Promise<R> {
  set(fake);
  active.add(set as SeamSetter<unknown>);
  try {
    return await run();
  } finally {
    set(undefined);
    active.delete(set as SeamSetter<unknown>);
  }
}

/** Safety net: restore every active seam. Called by tests/_preload.ts. */
export function resetAllSeams(): void {
  for (const set of active) set(undefined);
  active.clear();
}
```

### Wiring into `tests/_preload.ts`

Two one-line additions to the existing harness (no new lifecycle machinery):

1. `resetSingletons()` (tests/_preload.ts:294) gains `resetAllSeams();` — a
   leaked seam from a previous file is cleared before every test, exactly like
   `resetConfigCache()` / `resetLocalEmbedder()` today.
2. The existing `afterEach` (tests/_preload.ts:329) gains `resetAllSeams();`
   so a fake never survives past the test that installed it.

Because tests always install fakes via `overrideSeam`/`withSeam`, the preload
needs no knowledge of individual `_set…ForTests` functions — the registry is
the reset list. A test that calls a `_set…ForTests` setter directly (bypassing
the helper) is a review-reject; grep-able (`_set.*ForTests` outside
`tests/_helpers/seams.ts` usage must go through the helper).

Typical file migration shape (replaces a top-of-file `mock.module` block):

```ts
import { overrideSeam } from "../_helpers/seams";
import { _setChatCompletionForTests } from "../../src/llm/client";

let chatResponder: (userContent: string) => string | Promise<string> = () => "";

beforeEach(() => {
  overrideSeam(_setChatCompletionForTests, async (_conn, messages) => {
    const user = messages.find((m) => m.role === "user");
    return chatResponder(user?.content ?? "");
  });
});
```

Static imports of the module under test become safe again (no more
"`mock.module` must run before the module under test is imported" ordering
comments, no more dynamic-import contortions).

---

## Per-module seam designs

Ordered for sequential implementation, most-used-by-tests first. Implement one
module per commit: add seam → migrate its test files → delete the
`mock.module` blocks → gate green → commit.

### 0. Helper first: `tests/_helpers/seams.ts` + `tests/_preload.ts` wiring

As specified above. Land with module 1 (the helper is exercised immediately).

### 1. `src/llm/client` — 5 test files (easiest, highest fan-out)

- **Binding**: `let chatCompletionOverride: ChatCompletionFn | undefined;` next
  to `chatCompletion` (client.ts:263). Real body → private `chatCompletionReal`.
- **Hook**:
  ```ts
  export function _setChatCompletionForTests(fake?: typeof chatCompletion): void;
  ```
- Internal callers at client.ts:445 (`isLlmAvailable`) and :463
  (`probeCapabilities`-adjacent) route through the delegator — intended.
- **Test migration** (all five spread the real module and override only
  `chatCompletion`; the spread + `mock.module` block deletes, the responder
  var + `overrideSeam` call replaces it):
  - `tests/indexer/staleness-detect.test.ts` — deterministic validator fake →
    `overrideSeam(_setChatCompletionForTests, fake)` in `beforeEach`.
  - `tests/llm/memory-infer.test.ts` — `chatResponder` + `chatCalls` counter
    pattern translates directly (see canonical migration above).
  - `tests/llm/metadata-enhance.test.ts` — same shape.
  - `tests/commands/reflect-response-schema.test.ts` — same shape.
  - `tests/commands/consolidate/consolidate-judged-cache.test.ts` — same shape
    (`chatCalls` recording preserved by the fake closure).
- No module state, no extra reset needed beyond the registry.

### 2. `src/core/warn` — 3 test files

The module already has real hooks for all its *state*
(`setQuiet/resetQuiet/setVerbose/resetVerbose/setLogFile/clearLogFile`). Tests
mock it only to **capture output**. So the seam is a single sink intercept,
not 13 overridable functions:

- **Binding** (warn.ts, next to `quiet`/`verbose`/`logFilePath` at :20-22):
  ```ts
  export type WarnSinkForTests = (
    level: "info" | "warn" | "error" | "warnVerbose",
    args: unknown[],
  ) => void;
  let sinkOverride: WarnSinkForTests | undefined;
  ```
- **Hook**:
  ```ts
  export function _setWarnSinkForTests(fake?: WarnSinkForTests): void;
  ```
- Each of `info`/`warn`/`error`/`warnVerbose` gets a first line:
  `if (sinkOverride) { sinkOverride("<level>", args); return; }`
  Interception happens **before** the quiet/verbose gates — deliberately
  matching today's `mock.module` full-replacement semantics (the existing
  fakes capture every call regardless of flags). All other exports
  (`setQuiet`, `isVerbose`, `getLogFile`, …) stay untouched — the real hooks
  already serve tests.
- **Test migration**:
  - `tests/llm/memory-infer.test.ts` — spread + override of `warn` →
    `overrideSeam(_setWarnSinkForTests, (level, args) => { if (level === "warn") warnCalls.push(join(args)); })`.
  - `tests/llm/metadata-enhance.test.ts` — same, also captures `warnVerbose`
    level.
  - `tests/agent/agent-builders.test.ts` — currently reimplements ALL 13
    exports with parallel `mockedQuiet`/`mockedVerbose`/`mockedLogFile` state.
    Migration = delete the whole reimplementation; use the REAL module's
    `setQuiet`/`setVerbose` hooks for flag control plus the sink to capture
    `warnings`. Assertions about gating move from "did console.warn fire" to
    "what the sink captured + real `isQuiet()`/`isVerbose()`". Largest test
    rewrite in this group but pure subtraction (~60 lines of fake module
    deleted).

### 3. `src/llm/embedder` — 3 test files

Facade module; several mocked names are re-exports of pure constants/math
that need **no seam** (`DEFAULT_LOCAL_MODEL` constant, `cosineSimilarity`
math — the real ones satisfy every test).

- **Binding** (embedder.ts, after the `_localEmbedder` singleton at :50):
  ```ts
  interface EmbedderOverridesForTests {
    embed?: typeof embed;
    embedBatch?: typeof embedBatch;
    resolveEmbeddingModelId?: typeof resolveEmbeddingModelId;
    checkEmbeddingAvailability?: typeof checkEmbeddingAvailability;
    isTransformersAvailable?: () => boolean;
  }
  let embedderOverrides: EmbedderOverridesForTests | undefined;
  ```
- **Hook**:
  ```ts
  export function _setEmbedderForTests(fakes?: EmbedderOverridesForTests): void;
  ```
- Delegation: each listed export gains
  `if (embedderOverrides?.embedBatch) return embedderOverrides.embedBatch(...)`
  as its first line (bodies are already thin dispatchers; no `…Real` rename
  needed except `isTransformersAvailable`, which is currently a re-export from
  `./embedders/local` (embedder.ts:39) and must become a 3-line delegating
  wrapper in the facade — importers unchanged).
- **Implementation-time check**: grep that consumers under these tests import
  from the facade (`src/llm/embedder`), not `./embedders/local` directly; a
  direct submodule import bypasses the facade seam. (indexer and setup do use
  the facade per the facade's own doc comment.)
- **Test migration**:
  - `tests/integration/indexer.test.ts` — spreads real via specifier
    `'../../src/llm/embedder.js'` with a mutable `embedBatch` impl var →
    `overrideSeam(_setEmbedderForTests, { embedBatch: (...) => impl(...) })`.
    Kills the `.js`-specifier fragility entirely.
  - `tests/commands/improve/dedup-cache-wiring.test.ts` — mocks
    `{embedBatch, resolveEmbeddingModelId, cosineSimilarity}` WITHOUT
    spreading → seam `{embedBatch, resolveEmbeddingModelId}`; real
    `cosineSimilarity` is used as-is. Deletes the "mock.module must run before
    import" dance; `dedup` can be statically imported.
  - `tests/integration/setup-run.integration.ts` — replaces with only
    `{DEFAULT_LOCAL_MODEL, isTransformersAvailable, checkEmbeddingAvailability}`
    → seam `{isTransformersAvailable, checkEmbeddingAvailability}`; real
    `DEFAULT_LOCAL_MODEL`.
- Existing state hooks (`resetLocalEmbedder`, `clearEmbeddingCache`) already
  run in `_preload.ts:resetSingletons` — unchanged.

### 4. `@huggingface/transformers` — 2 test files (seam lives in src, NOT the package)

Third-party, but the ONLY consumer is the dynamic
`await import("@huggingface/transformers")` inside
`LocalEmbedder.getPipeline` (src/llm/embedders/local.ts:220). That import is a
perfect internal binding:

- **Binding** (embedders/local.ts, module level):
  ```ts
  type TransformersLoader = () => Promise<{ pipeline: unknown }>;
  const realTransformersLoader: TransformersLoader = () =>
    import("@huggingface/transformers") as Promise<{ pipeline: unknown }>;
  let transformersLoader: TransformersLoader = realTransformersLoader;
  ```
- **Hook**:
  ```ts
  export function _setTransformersLoaderForTests(fake?: TransformersLoader): void {
    transformersLoader = fake ?? realTransformersLoader;
  }
  ```
  Re-export from the facade `src/llm/embedder.ts` so tests import one module.
- `getPipeline` replaces the inline `await import(...)` with
  `await transformersLoader()`. The MODULE_NOT_FOUND error-shaping branch
  (local.ts:222-241) is untouched — a fake loader that throws a
  `Cannot find module` error still exercises the binary-hint path.
- **Test migration**: `tests/integration/embedder.test.ts` and
  `tests/integration/embedding-model-config.test.ts` both mock
  `{pipeline}` today and already call `resetLocalEmbedder()` in `beforeEach`
  (required — the cached `pipelinePromise` must not carry a previous loader's
  result; the preload also resets it). Their fake `pipeline` factory moves
  verbatim into `overrideSeam(_setTransformersLoaderForTests, async () => ({ pipeline: fakePipeline }))`.
- `isTransformersAvailable` (local.ts:289, `resolveModule` probe) is NOT
  seamed here; the facade seam from module 3 covers the one test that fakes it.

### 5. `src/setup/registry-stash-loader` — 1 test file

- **Binding**: real body of `loadSetupStashes` (registry-stash-loader.ts:82)
  → private `loadSetupStashesReal`; exported delegator.
- **Hook**:
  ```ts
  export function _setLoadSetupStashesForTests(fake?: typeof loadSetupStashes): void;
  ```
- `DEFAULT_SELECTED_STASH_IDS` is a plain exported const — no seam; the test's
  mocked copy is deleted and the real constant used.
- **Test migration**: `tests/setup-wizard.test.ts:64` block →
  `overrideSeam(_setLoadSetupStashesForTests, async () => fakeStashEntries)`.
  (Alternative considered: `withMockedFetch` against the real fetch path —
  rejected: couples the test to the registry JSON wire shape for no gain.)
  NOTE: setup-wizard.test.ts also mocks `@clack/prompts` (:68) — that mock
  STAYS (see deferred section); this file gets smaller, not seam-free.

### 6. `src/tasks/backends` — 1 test file

`selectBackend(options)` already accepts injected backends
(src/tasks/backends/index.ts:59-69) but production callers invoke it with no
args — threading a fake backend through `akmTasksAdd` would be a call-site
change (forbidden). Module seam instead:

- **Binding** (index.ts):
  ```ts
  interface BackendsOverridesForTests {
    selectBackend?: typeof selectBackend;
    backendNameForPlatform?: typeof backendNameForPlatform;
  }
  let backendsOverrides: BackendsOverridesForTests | undefined;
  ```
- **Hook**:
  ```ts
  export function _setBackendsForTests(fakes?: BackendsOverridesForTests): void;
  ```
  Both exports gain a first-line delegation check (bodies are small switches;
  no rename needed).
- **Test migration**: `tests/commands/tasks-write-target.test.ts:23` →
  `overrideSeam(_setBackendsForTests, { selectBackend: () => fakeBackend, backendNameForPlatform: () => "cron" })`.

### 7-14. The `tests/integration/setup-run.integration.ts` cluster (one file, 74 `mock.module` calls across 9 near-identical blocks)

This file repeats the same ~10 mocks in every test block. Migrate it LAST, in
one pass, after all seams below exist. Each block's mock stanza collapses to a
single `installSetupSeams(overrides)` local helper (test-file-local function
calling `overrideSeam` per seam) — deleting ~600 lines of repeated mock
boilerplate. Per module:

#### 7. `src/core/config/config` — NO SEAM (subtract the mock)

`resetConfigCache()` exists (config.ts:124) and already runs in the preload.
The module is XDG-env-driven and the sandbox helpers
(`withIsolatedAkmStorage` / `sandboxXdgConfigHome` in tests/_helpers/sandbox.ts)
already isolate it. Migration: delete the mock; let the wizard read/write the
REAL config in the sandboxed XDG home. Assertions on "what was saved" read the
config file (or `loadUserConfig()`) from the sandbox instead of spying on
`saveConfig`. Fallback ONLY if an assertion truly needs call interception: a
minimal `_setSaveConfigForTests` — decide during implementation, default is
no seam.

#### 8. `src/core/paths` — NO SEAM (subtract the mock)

Pure functions of `process.env`; `getConfigDir`/`getDataDir` already take
`(env, platform)`. With sandboxed XDG env vars the mock is dead weight.
Migration: delete the mock block; assert against the sandbox paths.

#### 9. `src/setup/detect` — seam for the two network/host probes

- **Binding** (detect.ts):
  ```ts
  interface DetectOverridesForTests {
    detectOllama?: typeof detectOllama;
    detectAgentPlatforms?: typeof detectAgentPlatforms;
  }
  let detectOverrides: DetectOverridesForTests | undefined;
  ```
- **Hook**: `export function _setDetectForTests(fakes?: DetectOverridesForTests): void;`
- `detectOllama` (detect.ts:44, network probe) and `detectAgentPlatforms`
  (detect.ts:157, host scan) get first-line delegation. `detectLMStudio`,
  `scanProviderEnvVars` (already env-injected), `pickDefaultModel` untouched.

#### 10. `src/commands/sources/init` — seam for `akmInit`

Single export, no state. Real body → `akmInitReal`; delegator +
`export function _setAkmInitForTests(fake?: typeof akmInit): void;`.

#### 11. `src/indexer/indexer` — seam for `akmIndex`

Today's full-module replacement leaves every OTHER export (e.g.
`buildFileBasenameMap`) `undefined` for the module under test — a latent bug
the seam fixes for free. Real body → `akmIndexReal`; delegator +
`export function _setAkmIndexForTests(fake?: typeof akmIndex): void;`. All
other exports stay real.

#### 12. `src/indexer/db/db` — DELETE THE STALE MOCK (no seam, decide fallback in-flight)

The current mock is **broken**: it exports `openDatabase`, but the real module
and setup.ts:41 use `openIndexDatabase` — under the mock, `openIndexDatabase`
is `undefined` and the vec-probe try/catch (setup.ts:582-600) silently
swallows the TypeError. The test has never exercised this path. Migration:
delete the mock and let the vec probe open a REAL index DB inside the
sandboxed tmp dirs (this is an integration test; that is the honest behavior
and un-swallows the probe). Fallback only if a real open proves too slow or
vec-extension-dependent in CI: minimal
`_setIndexDbForTests({ openIndexDatabase?, isVecAvailable? })` delegators.
Default is deletion.

#### 13. `src/integrations/agent` — seam in the DEFINING module

The test spreads the real barrel and overrides `detectAgentCliProfiles` +
`pickDefaultAgentProfile`. Both are defined in
`src/integrations/agent/detect.ts` (:81, :106) and re-exported by the barrel
(index.ts:33). **The seam must live in `detect.ts`** (a barrel re-export of a
delegator carries the seam automatically; seaming the barrel itself would not
affect direct `./detect` importers).

- **Binding** (integrations/agent/detect.ts):
  ```ts
  interface AgentDetectOverridesForTests {
    detectAgentCliProfiles?: typeof detectAgentCliProfiles;
    pickDefaultAgentProfile?: typeof pickDefaultAgentProfile;
  }
  ```
- **Hook**: `export function _setAgentDetectForTests(fakes?: AgentDetectOverridesForTests): void;`
  (re-exported from the barrel so tests import one module).

#### 14. `src/commands/tasks/default-tasks` — seam for the three mocked exports

`registerDefaultTasks(deps)` and `isCiEnvironment(env = process.env)` already
have DI params, but setup.ts:19 imports and calls them bare — using the DI
params would be a call-site change (forbidden). Module seam:

- **Binding** (default-tasks.ts):
  ```ts
  interface DefaultTasksOverridesForTests {
    detectServerDefault?: typeof detectServerDefault;
    isCiEnvironment?: typeof isCiEnvironment;
    registerDefaultTasks?: typeof registerDefaultTasks;
  }
  ```
- **Hook**: `export function _setDefaultTasksForTests(fakes?: DefaultTasksOverridesForTests): void;`
- First-line delegation on all three (note default-tasks.ts:179/:184 call
  `isCiEnvironment()`/`detectServerDefault()` internally — through the
  delegators, so overriding `detectServerDefault` alone still steers a real
  `registerDefaultTasks`, which today's all-or-nothing mock cannot do).
- The existing `installDefaultTasksMock` beforeEach helper in setup-run
  becomes an `overrideSeam` call.

---

## Deferred

### `@clack/prompts` — DEFER (keep `mock.module`)

Checked usage: four src files import it directly (`import * as p from
"@clack/prompts"` in src/setup/setup.ts:17, src/commands/sources/add-cli.ts:7,
src/cli/confirm.ts:40, src/commands/sources/stash-cli.ts:30). There is **no
existing src wrapper module fronting it** — the closest precedent,
`stepScheduledTasks(deps = DEFAULT_SCHEDULED_TASKS_DEPS)` (setup.ts:1961),
injects task primitives, not the prompt surface. Giving it a seam would
require either (a) a new `src/cli/prompts.ts` wrapper module + rewriting four
production import sites, or (b) parameter-threading a prompt object — both
violate the guardrails (no new wrappers/adapters, zero call-site changes), and
we cannot add a `_set…ForTests` export to a third-party package.

Decision: `tests/setup-scheduled-tasks.test.ts`, `tests/setup-wizard.test.ts`,
and `tests/integration/setup-run.integration.ts` KEEP their `@clack/prompts`
`mock.module` blocks and therefore keep needing file isolation.
Mitigations inside the test files (no src impact):
- setup-run: hoist the 9 duplicated clack mocks into ONE file-local
  `mockClack(answers)` helper (pure dedup, ~200 lines removed).
- setup-scheduled-tasks already restores the real module in `afterAll`
  (`mock.module(REAL_CLACK)` + `mock.restore()`) — keep that pattern; add the
  same restore to setup-wizard and setup-run if absent.

Revisit only if the owner approves a first-class `src/cli/prompts.ts` facade
as its own (separate, explicitly-scoped) refactor.

---

## Implementation order (one commit per numbered step, gate green each time)

1. `tests/_helpers/seams.ts` + `tests/_preload.ts` wiring **+** `src/llm/client`
   seam, migrating its 5 test files (proves the whole pattern end-to-end on the
   easiest group).
2. `src/core/warn` sink seam — 3 files (includes the agent-builders rewrite).
3. `src/llm/embedder` facade seam — indexer.test.ts + dedup-cache-wiring
   migrations (setup-run's embedder block waits for step 7).
4. `@huggingface/transformers` loader seam in `embedders/local.ts` — 2 files.
5. `src/setup/registry-stash-loader` — setup-wizard partial migration
   (clack mock stays).
6. `src/tasks/backends` — tasks-write-target.
7. setup-run cluster, one seam-module at a time inside the single file:
   add seams for detect / init / indexer / agent-detect / default-tasks;
   delete the config + paths + indexer-db mocks (sandbox/real replacements);
   dedupe the clack mock; collapse the 9 stanzas into `installSetupSeams()`.

Per-commit gate: `bun run check` (types + lint + unit/integration per repo
release-gate rule) — 0 errors, 0 warnings, 0 failures. Expected net effect:
~15-20 added lines per seamed src module vs hundreds of deleted mock lines in
tests (setup-run alone should shrink by roughly half).
