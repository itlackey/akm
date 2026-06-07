<!--
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

# Code-Health Brittleness Audit

Branch context: `release/0.8.2` (scans reference `release/0.9.0` line numbers; the
findings are structural and survive the rename). Synthesis of five independent
brittleness scans: Registration/Init, Stringly-Typed Dispatch, Error/Exit/Resource,
Concurrency/Timing/Test-Isolation, and Structural-Patterns.

## Executive summary

Every scan converges on one root anti-pattern and its siblings: **correctness that
depends on remembering to do a side-effecting step at each call site, with silence on
omission.** This is the exact failure mode the #490 output-registry fix already retired
(explicit assembly that fails at compile time). The audit finds that fix's living
siblings.

Three families dominate:

1. **Implicit registration / late global reads** — bare side-effect imports register
   providers (`sources/providers/index.ts`, `registry/providers/index.ts`); leaf
   functions read `process.env.XDG_*` live at call time (`paths.ts`, `events.ts`,
   `health.ts`). Forgetting the import silently empties a registry; the late env read
   is the confirmed root cause of the #553/#554/#499 health-test timeouts (a cross-file
   env data race in a shared test process).

2. **Unguarded stringly-typed dispatch** — `assertNever` exists **zero** times in
   `src/` (confirmed by grep). The `ImproveActionResult.mode` union has already drifted:
   `state-db.ts:1134` handles 10 of 11 variants and silently drops
   `reflect-guard-rejected` from the audit aggregate — a **live data-integrity bug**.
   The `RunnerSpec` union is dispatched ad-hoc in 7+ files with no exhaustiveness arm.

3. **Manual resource/exit lifecycle** — hand-rolled DB open/close with no `finally`
   (registry providers leak `bun:sqlite` handles on early return/throw); control flow
   routed through `process.exit` inside `try/catch` and matched by the magic string
   `"process.exit called"`; detached `setTimeout(() => process.exit(0))` racing in-flight
   writes.

**Keystone fix:** introduce one `assertNever(x: never): never` helper. It converts three
silent enum-drift sites into compile errors and immediately surfaces the live #1 bug.
This is the single highest-leverage, lowest-churn move in the register.

**Repo-rule guardrails honored throughout:**

- **No `src/services/` layer.** All proposed helpers land in existing homes
  (`src/core/`, `src/tasks/backends/exec-utils.ts`, etc.). No new service tier.
- **#490 layered + slice structure.** Fixes target the slice they belong to; the
  output-registry shape (explicit assembly, throw-on-miss) is the convergence target,
  not a new abstraction.
- **Test-isolation harness.** The harness (`tests/_preload.ts`,
  `tests/_helpers/sandbox.ts`) already resets the documented singletons. Safe fixes must
  not add new module-level mutable state; behaviour-changing isolation work
  (env-threading) is deferred to design review.
- **MPL header.** Every new `.ts`/`.md` file must carry the MPL-2.0 header block (as
  this document does).

## Severity-ranked defect register

Deduplicated across scanners. Each row: file:line, failure mode, proper pattern,
behaviour-preserving (Y/N/judgment), churn.

### CRITICAL

| # | File:line | Failure mode | Proper pattern | Behaviour-preserving | Churn |
|---|---|---|---|---|---|
| C1 | `src/core/state-db.ts:1134` | `switch(action.mode)` covers 10 of 11 union variants; omits `reflect-guard-rejected`. No `default`, no exhaustiveness. The dropped action is counted in NONE of accepted/rejected/error — silently vanishes from audit totals. **Live bug.** | `assertNever` exhaustiveness + add the missing case to the correct bucket | **N** (adding the case changes counts; choosing the bucket is a judgment call) | ~15 LOC + helper |
| C2 | `src/core/paths.ts:206`, `src/core/events.ts:140-147`, `src/commands/health.ts:1487` | `getDataDir(env=process.env)` / `appendEvent` / `akmHealth` resolve the state-db path from `process.env.XDG_DATA_HOME` **live at call time**. Parallel test files mutate that global in `beforeEach`; an async yield lets file B's reassignment redirect file A's DB open/migrate to a wrong/just-deleted tmpdir → **the #553/#554/#499 timeout** (surfaces as a hang, not an assertion). | parameter-object: resolve a `HealthContext`/`EventsContext` path once at the command boundary and thread it; leaves never re-read env | Y for production resolution; signature/threading refactor | **High** (~dozen call sites) |
| C3 | `src/commands/sources/add-cli.ts:302-306` | Vault-key security audit wraps `process.exit(1)` in a broad `try/catch` and distinguishes "intended exit" from "real bug" by string-matching `err.message === "process.exit called"` (the test mock's sentinel). In prod `process.exit` never throws → branch is test-only; if the sentinel string changes, the DANGEROUS_VAULT_KEY abort silently becomes fail-open and an insecure stash installs. The catch also swallows any genuine audit bug. | typed sentinel: audit returns `{blocked:true,findings}|{blocked:false}`; decide exit OUTSIDE the catch. Or a dedicated `class ProcessExitSignal extends Error` + `instanceof` | **N (judgment)** — changes which errors abort vs. swallow (the point) | ~30-50 LOC, 1 file |

### HIGH

| # | File:line | Failure mode | Proper pattern | Behaviour-preserving | Churn |
|---|---|---|---|---|---|
| H1 | `src/integrations/agent/runner.ts:12` + 7 dispatch sites (`drain.ts:344`, `reflect.ts:1060,971`, `consolidate.ts:1038`, `extract.ts:435`, `tasks/runner.ts:355`, `staleness-detect.ts:140`) | `RunnerSpec = llm|agent|sdk` dispatched ad-hoc; two `switch(kind)` have no `default: assertNever`, five `kind !== "llm"` guards are hand-inlined. A 4th kind compiles clean and crashes at runtime (`raw`/`iterResult` undefined) or is mis-routed. | `assertNever` arms on the switches + co-located `runnerIsLlm(runner)` predicate; optional central `dispatchRunner(runner, handlers)` | Y for assertNever-arms + predicate extraction (pure refactor); central dispatcher is judgment | ~7 files, ~40 LOC |
| H2 | `src/cli/shared.ts:113` producer; `src/output/shapes.ts:110`, `src/output/text.ts:170` consumers | `output(command: string)` keyed by free `string` across ~82 literal call sites; no compile-time link to the registered handlers. A typo'd/renamed key fails only at runtime (and `formatPlain` returns `null` → silent YAML fallback). | exported `type OutputCommandName` union (or derive from the handlers map) typed on both `output()`'s param and `register*` keys | **Y** (types only; surfaces latent typos at compile time) | 1 union + 2 sigs; ~82 sites auto-checked |
| H3 | `src/commands/improve/improve.ts:1310` | Second independent `switch(action.mode)` over the same 11-variant union with its own parallel counters; must stay in lockstep with C1's switch and the type. No exhaustiveness. | hoist one `classifyImproveAction(mode): "accepted"|"rejected"|"error"|"noop"` used by both consumers; `assertNever` guard | Y if mapping reproduced exactly | ~40 LOC, 2 modules + tests |
| H4 | `src/commands/lint/base-linter.ts:100` (REF_RE) + `:108` (`refToRelPath`) | Three-way drift surface for the asset-type list: regex alternation, the path switch, and the registry's `ASSET_SPECS`. Already drifted — both omit `env` and `secret` (real 0.9 asset types), so those refs are invisible to the missing-ref linter; the switch re-encodes path layout the registry owns. | derive the regex from `getAssetTypes()`; replace `refToRelPath` with the registry's `toAssetPath` (single path-layout authority) | **N** — `env`/`secret` would start being linted (desired, needs a deliberate path-mapping decision); regex-from-registry alone is preserving | Medium; contract test updates |
| H5 | `src/registry/providers/static-index.ts:176-234`, `src/registry/providers/skills-sh.ts:127-200` | DB lifecycle with **no `try/finally`**; `closeDatabase(db)` duplicated at 3-4 return sites. `JSON.parse(dbCacheResult.indexJson)` (static:190) runs BEFORE the close at :193 → malformed cache throws and leaks the handle. Any new early return leaks too. | RAII/`withResource`: `withRegistryCacheDb(fn)` (or `using` + `Symbol.dispose`) so close is structural and order-independent | **Y** (pure refactor; close moves to finally) | ~40 LOC, 2 files + helper |
| H6 | `src/cli/shared.ts:41-46` | `classifyExitCode` collapses ALL unrecognized errors to exit 1; the `default` branch is identical to the `NotFoundError` branch, so "asset not found" and "akm internally threw" are indistinguishable. New error classes need edits at two sites with no compile-time guard. | strategy keyed off a `kind` discriminant on a base `AkmError`, exhaustive switch (`never`-checked), distinct INTERNAL exit code (e.g. 70) for unclassified | **N** — exit codes change for the unexpected path (low blast radius) | ~20 LOC + error base |
| H7 | `src/commands/improve/improve.ts:974-980` | On budget exhaustion: `setTimeout(() => process.exit(0), 5_000)` as a hard-kill, never captured/cleared. If the run drains cleanly within 5s the `exit(0)` still fires mid-flush → truncated logs / partial `state.db` transaction. Hard-codes exit 0 for partial runs. | cooperative cancellation via the existing AbortController + a captured timer cleared in `finally`; only hard-exit if drain itself exceeds a deadline | **N (judgment)** — timing/exit semantics change | ~15 LOC, concurrency-sensitive |
| H8 | `src/core/config/config-io.ts:201-203` | Synchronous busy-spin (`while (Date.now() < deadline)`) used as a sleep in the config-lock retry loop — up to 10×50ms freezes the single JS thread, starving co-scheduled tests and amplifying the parallel-load timeout pressure. Lock is already best-effort. | async backoff (`await Bun.sleep`) OR drop to a single `O_EXCL` attempt + fail-loud | **N** — async ripples through sync `withConfigLock` callers; shrinking the spin budget is a low-risk interim | Medium |

### MEDIUM

| # | File:line | Failure mode | Proper pattern | Behaviour-preserving | Churn |
|---|---|---|---|---|---|
| M1 | `src/indexer/walk/file-context.ts:183-200` + `src/indexer/passes/metadata-contributors.ts:22-30` | Two independent lazy `builtinsPromise` registries that `import()` hardcoded `.js` paths (overlapping on `renderers.js`); registration gated on first accessor call. A render path that bypasses the accessor silently produces entries missing contributor metadata. The two hardcoded lists drift independently. | fold both into one explicit `initIndexer()` composition root that calls the existing `registerBuiltin*()` exports eagerly | Y if init is wired before first use (de-lazying); duplicate-name-error part is behaviour-changing | Medium, ~4-6 files |
| M2 | `src/output/renderers.ts:631-666` vs `:694` | Split registration timing in one module: metadata contributors register as top-level load side-effects; renderers only inside exported `registerBuiltinRenderers()`. Importing registers half. (Note: #490 supersedes much of this via `src/output/shapes/`+`text/`; confirm residual contributors before touching.) | one mechanism: explicit `registerBuiltinMetadataContributors()` export, no top-level side-effects, called from the init root | Y (same registrations, relocated) | Low-medium |
| M3 | `src/core/common.ts:29-42` | `getAssetTypes()` cast `as ["skill",...,"task"]` — runtime array and hand-written literal tuple must agree by hand; the `as` suppresses mismatch. A new built-in works at runtime but is invisible to the type system. Guarded only by `tests/asset-type-union-source.test.ts` (test-time, not compile-time). | invert ownership (tuple as source, derive registry seed) or add `satisfies readonly AkmAssetType[]`; document the test as load-bearing | Y (refactor) | Low-medium |
| M4 | `src/workflows/runtime/runs.ts:252-647` | `WorkflowRunStatus` compared as bare string literals at ~10 sites; legal transitions implicit in if-guards. `mapWorkflowStatus` (`tasks/runner.ts:296`) has a silent `default:"completed"` that mislabels unknown statuses → exit 0. | a small `transition(from,event)->to|error` table + typed enums; replace the silent default with `assertNever` | Y if table reproduces guards; runner default-arm change preserving for known statuses | Medium-high (engine core) |
| M5 | `src/commands/improve/improve-cli.ts:170-186` | SIGTERM/SIGINT/SIGHUP handlers call `persistTerminated(sig)` (async) then `process.exit()` synchronously → the "terminated run" row may never be written. | make `persistTerminated` fully sync (bun:sqlite is sync — verify) or `await` then exit; encode signal→exit-code as a table | Y if persist path already sync (verify) | ~20 LOC, 1 file |
| M6 | `src/indexer/db/db.ts` (~25 sites), `src/indexer/db/db-backup.ts` (~11) | Many bare `} catch {}` with no `err` capture, so they cannot call `rethrowIfTestIsolationError` — inconsistent with the project's own established guard (static-index, improve.ts). A leaked-test cold cache or real schema bug is silently downgraded to fallback. | one `bestEffort(fn, {rethrow: rethrowIfTestIsolationError})` chokepoint | Mostly Y; adding the guard to silent sites is behaviour-changing for leaky tests (intended) | High churn (~36 sites), mechanical |
| M7 | `src/core/file-lock.ts:84-99` (used `config-io.ts:195-197`) | "stale lock" age mixes FS `mtimeMs` and caller `Date.now()` (two unsynchronized clocks). Skew yields negative age (never stale) or premature reclaim of a live lock → broken mutual exclusion. `improve.ts` passes `staleAfterMs` and inherits the full hazard. | prefer PID+start-time liveness; if age needed, single clock domain; treat negative/skewed ages as indeterminate → do not reclaim | Y for the negative-age guard; removing age-reclaim is behaviour-changing (crash recovery) | Low churn, medium risk |
| M8 | `src/commands/health.ts:475,1417,1516,1306-1309` | Health read path has no injectable clock; `ACTIVE_RUN_WARN_MS = 15min` compared against `Date.now()`. A row seeded near the boundary flips classification depending on suite load → flaky. | inject `now: () => number` into `akmHealth(options)` (mirror the existing `EventsContext.now` seam) | **Y** (default `now = Date.now`, additive seam) | Low |
| M9 | `tests/_helpers/cli.ts:106-107` vs ~7 production caches | Shared harness resets only `cachedConfig` + output-mode centrally; `resetGraphBoostCache`, `resetLocalEmbedder`, `clearEmbeddingCache`, quiet/verbose, log-file path must be remembered per-author. A `(stashPath, generatedAt)` cache returns a prior test's graph on stable `generatedAt`. | fold all `reset*()` into one `resetAllProcessState()` invoked centrally in the shared `beforeEach` | **Y** (pure test-harness refactor) | Low |
| M10 | `src/commands/sources/*-cli.ts` (~8 `*_SUBCOMMAND_SET`) | Hand-maintained Set duplicates each command's `subCommands` keys. Add a subcommand, forget the Set → `hasSubcommand` returns false → parent re-runs the default action instead of routing — silent wrong-output, no error. | derive `new Set(Object.keys(cmd.subCommands))` or a `defineFamilyCommand` factory building both together | Y (pure refactor) **if** the derived set is verified identical to today's hand-written set | ~8 files |

### LOW

| # | File:line | Failure mode | Proper pattern | Behaviour-preserving | Churn |
|---|---|---|---|---|---|
| L1 | `src/integrations/agent/sdk-runner.ts:34,49-51` | Module-level mutable `_server` singleton; cleanup via manually-called `closeServer()` ("primarily for tests"). Forgetting it leaks across test files in the shared process. | RAII: `withServer(fn)` / disposable handle pairing start→stop lexically | N (API shape) | Low |
| L2 | `src/llm/embedder.ts:45`, `src/core/config/config.ts:122` | Module-level memoization singletons; `cachedConfig` keys on mtime/size (same-mtime-granularity staleness risk in the in-process harness). | parameter-object / explicit cache handle, or at minimum a `reset*()` (config has one; embedder has `resetLocalEmbedder()`) | Y if reset added; threading is broader | Low–high |
| L3 | `src/llm/feature-gate.ts:167-205`, `config-migration.ts:618`, `index-passes.ts:43` | snake_case↔camelCase process-name aliases re-listed inline at multiple sites (`"memory_inference" \|\| "memoryInference"`); a new process means editing several `\|\|` chains; unknown pairs fail-silent to `false`. | one `PROCESS_NAMES` registry (canonical ↔ aliases ↔ config location) consumed by all three; extend the existing `FEATURE_LOCATION` map | Y if table mirrors current sets | Low-medium, 3 files |
| L4 | `src/registry/providers/static-index.ts:241-245`, `src/sources/providers/provider-utils.ts:24` | Cache TTL is `Date.now() - mtimeMs > TTL` (two-clock skew); a tmpdir copied with preserved mtimes reads fresh-as-expired. | store explicit `generatedAt` inside the cache payload (single clock domain) | N at the margin (judgment); negative-delta guard is safe | Low-medium |
| L5 | `src/tasks/backends/launchd.ts:204-238`, `schtasks.ts:246-273` | Near-identical `defaultFs` (node:fs wrappers) and `defaultExec` (wrapping `spawnCommand`) duplicated per backend; a fix to default behaviour must be applied 3×. | shared `nodeFs()` / `nodeExec()` factory in the existing `exec-utils.ts`, injected as defaults | **Y** (interfaces already identical) | ~3 files, ~60 LOC removed |
| L6 | `src/sources/providers/provider-utils.ts:65-66` | temp-name uniqueness `${Date.now()}-${Math.random()}` — theoretically collidable, non-reproducible. | `crypto.randomUUID()` | Y | Trivial |
| L7 | `src/cli.ts:596,614`, `src/version.ts:18` | bare `} catch {}` startup probes predating the guard convention; no `err` capture. | route through the `bestEffort` helper from M6 once it exists | Y | Trivial |
| L8 | `src/cli.ts:502-542` | 40-entry hand-maintained `subCommands` map. **Noted as the GOOD contrast case** — explicit, order-independent, greppable. No action; convergence target for the registries above. | keep explicit assembly | n/a | none |

### Cleared (verified NOT brittle — do not re-spend effort)

- `src/output/text.ts` / `src/output/shapes/` — already explicit order-independent
  assembly that throws on a missing registration (#490 landed). The registry half is done.
- `src/core/asset/asset-registry.ts` `TYPE_TO_RENDERER`/`ACTION_BUILDERS` — proper registry,
  no import-order self-registration.
- `src/tasks/runner.ts:547` `exitCodeForStatus` — exhaustive over `TaskRunStatus` with NO
  default: the one place the right pattern is already applied. Model for C1/H3/M4.
- `src/setup/setup.ts:562-589` — try/finally + `if (db) closeDatabase(db)`: the reference
  shape H5 should converge to.
- `runImproveLoopStage` (`ImproveRunContext`), `health.ts` decomposition (~35 small fns),
  task-backend exec/fs strategy seams — all already correct.

## Split: safe auto-fix now vs. needs design discussion

### Safe to auto-fix now (behaviour-preserving, test-greenable)

These apply a proper pattern, change no observable behaviour / exit codes / output bytes,
and are file-disjoint so they parallelize:

- **H2** — `OutputCommandName` union (types only; latent typos become compile errors).
- **H5** — `withRegistryCacheDb` RAII helper for the two registry providers (close moves
  to `finally`, identical observable behaviour).
- **M8** — additive `now` clock seam on `akmHealth` (default `Date.now`).
- **M9** — central `resetAllProcessState()` folding the existing reset hooks in the shared
  harness (pure test-harness change).
- **L5** — shared `nodeFs()`/`nodeExec()` defaults in `exec-utils.ts` (identical interfaces).
- **L6** — `crypto.randomUUID()` for temp names.

The **assertNever helper** is the keystone, but applying it is entangled with
behaviour-changing case additions (C1/M4) and a multi-file consumer set that overlaps H3.
It is therefore routed to design review (below) rather than auto-fix, so the missing-case
bucket decisions get owner sign-off and the file-disjoint constraint is not violated.

### Needs design discussion (owner review)

- **C1 + H3** — the missing `reflect-guard-rejected` case (which bucket?) and the parallel
  second switch; introduce `assertNever` and a shared `classifyImproveAction` together so
  both consumers and the live count-fix land coherently.
- **C2** — the env-threading parameter-object overhaul (the #553/#554/#499 root cause).
  High churn across ~dozen command boundaries; the single highest-value fix but a
  signature redesign, not a mechanical refactor.
- **C3** — replace the `"process.exit called"` magic-string security control flow with a
  typed audit result / `ProcessExitSignal`. Security-relevant fail-open semantics; needs
  test coverage of the fail-open case.
- **H1** — full `dispatchRunner` central dispatcher (assertNever-arm-only subset is safe but
  touches the same 7 files as other improve-slice work; sequence under review).
- **H4** — wire the linter regex + path mapping to the registry; decide `env`/`secret`
  path semantics (they currently return null/skip).
- **H6** — error-envelope strategy with a distinct INTERNAL exit code (changes exit codes).
- **H7** — replace the detached `setTimeout(process.exit(0))` hard-kill with cooperative
  drain (concurrency-sensitive, exit-semantics change).
- **H8** — config-lock busy-spin → async backoff (ripples through sync `withConfigLock`).
- **M1/M2** — single `initIndexer()` composition root folding the two lazy
  `builtinsPromise` registries; confirm residual `renderers.ts` contributors post-#490.
- **M4** — workflow status state-machine + remove `mapWorkflowStatus` silent default.
- **M5** — sequence signal-handler persist→exit.
- **M6** — `bestEffort` chokepoint across ~36 catch sites (mechanical but the guard
  addition is behaviour-changing for leaky tests).
- **M7** — file-lock clock-skew / staleness redesign (crash-recovery semantics).
- **M10** — derive `*_SUBCOMMAND_SET` from `subCommands` keys. Behaviour-preserving in
  principle, but the derived set must be verified identical to each current hand-written
  set first (potential latent drift, e.g. `doctor`) — a verification step, not a blind
  refactor; held for review.
- **M3 / L1–L4 / L7** — lower-value lifecycle/cache/type-cast cleanups.
