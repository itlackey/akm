# D1 / D1b — Finalized design: decompose `improve.ts` via lock-RAII-first, then scoped dedup + cohesion moves

**Verdict (one line):** Do **D1b (`withProcessLock` RAII) first** — it is the strongest coupling-delete and pins the regressed exit-78 family — then the small verified dedups (`runWithTelemetry` over **2** sites; a recombine+procedural **duo** registry), then honest relocations (`eligibility.ts`, an `ImproveBaseContext` spine, and a new **D1c** decomposition of the 1,656-LOC `runImprovePreparationStage`). **Drop** the `budget.ts` extraction and the `extract`-in-registry / full-`ImproveRunContext`-unification over-scopes.

A 3-lens design team (template-dedup / service-boundary / failure-sequencing) ran on `src/commands/improve/improve.ts` (5,395 LOC). This synthesis re-verified against the code; as with R5/D2/D3 the team SHRANK the plan after verification. **Re-anchor on symbol names — the plan's line numbers (4806/4842, "5,406 LOC") are stale.**

---

## 1. Corrections to the plan (with receipts)

| Plan claim | Reality (verified) |
|---|---|
| `runWithTelemetry` dedups "8+ near-identical sites" | **2 clean fits** — memory-inference (`~4998`) + graph-extraction (`~5108`), both in `runImproveMaintenancePasses`, both with the full `start→withLlmStage→catch→allWarnings.push→durationMs` shape. The other ~8 `withLlmStage` sites (consolidate `2297`, reflect `4335/4340/4367`, distill `4586`, extract `2583`, contradiction `1254`, staleness `5301`) each break the template (no try / different warning sink / voting loop / self-reported duration). |
| Registry over a recombine/procedural/extract **trio** | **Duo.** recombine (`~4798-4831`) + procedural (`~4837-4859`) are near-byte-identical (same guard, same `options.Xfn ?? akmX` seam, same `try/catch→allWarnings.push`, both post-loop). **`extract` is NOT a member**: no `extractFn` seam exists on `AkmImproveOptions` (only `recombineFn:317`, `proceduralFn:323`), different guard, a `for (const h of harnesses)` loop, `cleanupWarnings` sink, a `minNewSessions` gate, and it runs in the **prep** stage. Forcing it in = the X2 "20 callers were 4" over-count. |
| "Promote 12-18-field arg bags into a single `ImproveRunContext`" | **Already ~70% done.** `ImproveRunContext` (`~4069`, 20 fields) is built at `~1676` and consumed by the loop stage (`4101`). The prep/post-loop/maintenance stages take **genuinely distinct** per-stage inputs (data-flow ordering — `loopRefs` can't be in the prep bag because prep produces it). Unifying all four = a mutable blackboard. Only factor the ~8-field **shared spine** (`scope/options/primaryStashDir/improveProfile/eventsCtx/budgetSignal/startMs/budgetMs`) into an `ImproveBaseContext`. |
| `eligibility.ts` "extracts cross-cutting services / reduces coupling" | **Relocation, not coupling-delete.** All 15 helpers (`collectEligibleRefs 595`, `resolveImproveScope 511`, `isLessonCandidate 790`, … `buildUtilityMap 5356`, `findAssetFilePath 5386`) are already module-level free functions with no `akmImprove`-closure entanglement. Worth doing for cohesion/testability (~400 LOC, biggest mover) — but describe it honestly. Move shared leaves (`findAssetFilePath`) **with** `collectEligibleRefs` to avoid a back-edge. |
| `budget.ts` service | **Weakest — skip.** `armBudgetWatchdog 948` (wall-clock watchdog) and `maybeAutoTuneThreshold 1007` (gate calibration) are two unrelated domains under one word; both already `export`ed + fully dependency-injected. Near-zero coupling win. |
| "improve.ts drops toward ~1,200 LOC" | **Unreachable without decomposing `runImprovePreparationStage` (`~2412-4068`, 1,656 LOC)** — the real god-within-the-god, absent from the plan. Add it as **D1c** (sequential phase functions: memory-health / consolidation[done] / session-extract / eligibility-assembly). Bigger LOC mover than the registry, lower risk (no polymorphism). |

**De-risking facts:** SIGTERM/persistence is NOT in D1 (R8 lifted `SIGNAL_TABLE`/persist-before-exit to `improve-session.ts` + `improve-cli.ts`; improve.ts imports none of it). improve.ts has **zero** `console.log`/`process.stdout`/`getOutputMode` — all output via `info`/`warn`→stderr; the JSON envelope is in `improve-cli.ts` (not D1 scope). So the JSON-stdout-purity risk is only "don't introduce a stdout call in an extracted module."

---

## 2. D1b `withProcessLock` — the invariant (highest-risk, highest-value)

Current: module-global `heldProcessLocks` Set (`154`) mutated from 8 sites + a manual `process.on("exit")` backstop (`~1272-1290`) + 4 hand-balanced acquire/release pairs + two `releaseAllProcessLocks()` safety nets (`~1359`, `~1918`). Correctness is an emergent property of correctly-paired calls across 5,395 lines — exactly the anti-pattern to delete.

**`withProcessLock(name, opts, body)` must preserve 3 invariants (each currently emergent):**
- **I-a — ownership-safe exit release:** the exit-backstop path uses `releaseLockIfOwned(path, pid)` (`~1286`), NOT bare `unlinkSync` (`releaseProcessLock`, `233`). A naive RAII finally using bare unlink would delete a lock another PID re-acquired after stale recovery.
- **I-b — tri-state, not throw:** unavailable → `"skipped"` (skip the body, run continues) unless `skipIfLocked=false` → throw the exact `ConfigError("…already running…")`. This is the OPPOSITE of `withIndexWriterLease` (which always throws) — do not copy that shape.
- **I-c — stale-recovery ladder:** probe → emit `improve_lock_recovered` event → `releaseLock` → re-acquire → still-locked → skip/throw (`~189-218`) must survive.

**Pin-without-spawning:** the seam already exists — `tests/commands/improve/improve-skip-if-locked.test.ts` drives `akmImprove` in-process with `resetHeldProcessLocks()` in before/afterEach, asserting skip (`:79`) and throw (`:98`). Force a stage throw via the existing `collectEligibleRefsFn` seam (`299`). The currently-UNPINNED behaviors that must get RED tests first: (a) `heldProcessLocks` empty after a throwing run, (b) `process.listenerCount("exit")` returns to baseline after N runs, (c) stale-lock recovery emits `improve_lock_recovered`. Prefer asserting on-disk lock-file absence over a new Set getter (no surface widening).

---

## 3. Increment ordering (each: RED → move → green → adversarial review → commit-or-revert; gate = lint warning-COUNT / tsc 0 / unit 0 / integration 0 (re-verify by hand, #664) / node-compat parity)

**PR-A — D1b lock RAII (do first; the coupling-delete + regressed-family net):**
0. Land the 3 lock-invariant RED tests against CURRENT code (must pass on today's manual-Set impl). Safety net, no production change.
1. Extract `improve/locks.ts` as a **pure move** (Set + `PROCESS_LOCK_DEFS` + `processLockPath` + acquire/release/releaseAll/reset) behind re-export shims. No RAII yet. Mechanical, lowest risk.
2. Introduce `withProcessLock` in `locks.ts`; convert the 4 acquire/release sites **one at a time**, preserving I-a/I-b/I-c. Remove the manual exit-backstop + the `releaseAllProcessLocks` net **only after** all sites are wrapped and the empty-Set-after-throw test stays green.

**PR-B — verified dedups:**
3. `runWithTelemetry(name, fn): Promise<{result?, durationMs, warning?}>` in `improve/run-telemetry.ts`; adopt at the **2** fitting sites only (caller keeps `actions.push`/`info`). Per-site RED pin (success + failure, asserting duration is timed across the catch).
4. recombine+procedural **duo** registry — only if it earns the `{name,isEligible,run}` interface over two inline closures (judgment call at execution; do NOT include extract).

**PR-C — cohesion (honest relocations):**
5. `improve/eligibility.ts` — move the 15 free helpers (shared leaves together) behind re-export shims. Relocation; cohesion/testability win.
6. `ImproveBaseContext` — factor only the ~8-field shared spine; leave per-stage bags distinct.
7. **D1c** — decompose `runImprovePreparationStage` (1,656 LOC) into named phase functions. Biggest LOC mover; sequential, low-risk.

Splitting D1 into PR-A/B/C keeps each reviewable (the 40-commit PR was "a lot"). PR-A is the load-bearing one; B and C are optional follow-ups if scope/time warrants.

**Stop conditions:** if a lock conversion can't preserve I-a/I-b/I-c as a local change, stop. If `runWithTelemetry` would need an `actions.push`/`info` fold to fit a site, that site is not a fit — skip it. Never force `extract` into the registry.
