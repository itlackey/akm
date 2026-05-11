# `akm improve` Investigation Report

**Date:** 2026-05-11
**Trigger:** Scheduled 4am `akm-improve` task failure
**Status:** Investigation complete; remediation recommendations documented

---

## Background and Context

`akm improve` is the umbrella command for all background stash improvement processes: reflection, lesson distillation, memory consolidation, and any future background operations. It is designed to run nightly as a scheduled task via `akm tasks`.

On the morning of 2026-05-11, the scheduled 4:00am run failed. Three parallel specialist agents were dispatched to investigate:

- **Code investigator** — read source files directly (`improve.ts`, `reflect.ts`, `distill.ts`, `tasks.ts`, `spawn.ts`)
- **Log failure analyst** — read actual run logs and live stash state
- **Architecture/quality analyst** — compared design intent (spec) against the live system

This document is the permanent record of that investigation and its findings.

---

## Investigation Process

### Step 1 — Root Cause: Cron PATH Stripping

The scheduled task failed at 04:00 on 2026-05-11 after only **1ms** with a `command not found` error for `opencode`. Root cause: cron strips the user's `PATH` environment variable down to `/usr/bin:/bin`, which does not include the directories where `opencode` and `akm` binaries are installed (typically `~/.local/bin`, `~/.bun/bin`, `/usr/local/bin`).

### Step 2 — PATH Fix Implemented

Two coordinated fixes were applied:

- **`spawn.ts` — `buildChildEnv()`**: Now detects when `PATH` is stripped (shorter than a defined threshold) and supplements it with a list of well-known user binary directories (`~/.local/bin`, `~/.bun/bin`, `~/.npm-global/bin`, `/usr/local/bin`, etc.).
- **launchd plist (macOS)**: The `EnvironmentVariables` key is now populated with the full `PATH` captured at install time, so scheduled jobs inherit the correct environment.

### Step 3 — Fix Verified via Simulated Cron Run

A simulated cron run was executed with `PATH=/usr/bin:/bin` to confirm the fix. Result:

| Metric | Value |
|--------|-------|
| Exit code | 0 |
| `opencode` found | Yes |
| Run duration | ~46 minutes |
| Assets processed | Partial (see findings) |

### Step 4 — Three Parallel Agents Dispatched

With the PATH fix confirmed, three specialist agents were dispatched in parallel to perform a deeper investigation of the `akm improve` subsystem. Each agent independently examined source, logs, and design documents, then reported findings. All findings were synthesized into the unified issue list below.

### Step 5 — Findings Synthesized

All agent findings were merged, duplicates removed, and issues ranked by priority. The full list follows.

---

## Findings

### Priority Definitions

| Priority | Label | Description |
|----------|-------|-------------|
| P1 | Blocking | Causes data loss, silent failures, or crashes that skip assets |
| P2 | Significant | Causes correctness or reliability problems at scale |
| P3 | Observability / Quality | Degrades operator experience and maintainability |

---

### P1 — Blocking Issues

#### 1. Unhandled `UsageError` Crash in Per-Asset Loop

**Location:** `improve.ts:286–294`

One bad LLM response (e.g., malformed JSON, `UsageError` thrown by the Anthropic SDK) inside the per-asset loop is not caught. This crashes the entire `akmImprove()` run immediately. All remaining assets in the queue are silently skipped with no record of what was or was not processed.

**Impact:** Any single flaky network call or LLM output can abort a 46-minute run with zero progress saved.

#### 2. Idempotency Failure — No Deduplication Before `distillFn()`

There is zero deduplication check before `distillFn()` is called. As of the investigation, **103 duplicate proposals** are currently pending in the stash. The asset `lesson:command-add-todo-lesson` has **9 identical copies**.

**Impact:** Operator triage burden; proposal queue is unreliable as a signal of genuine new knowledge.

#### 3. Recursive Task Invocation — No Concurrent-Execution Guard

During the investigation run, the agent re-invoked `akm tasks run akm-improve` from within its own active session. There is no lockfile or concurrent-execution guard. A second invocation can start in parallel with a live run, doubling LLM API costs and producing conflicting writes to the stash.

**Impact:** Potential stash corruption, double billing, runaway spawns.

#### 4. `timeoutMs` Never Forwarded to `reflectFn` / `distillFn`

**Location:** `improve.ts:279–294`

`AkmImproveOptions` accepts a `timeoutMs` field, but the value is never passed through to `reflectFn()` or `distillFn()`. Both functions run with whatever default timeouts are compiled into their respective modules. The option is silently ignored.

**Impact:** Operators cannot tune timeouts; long-running or hung LLM calls cannot be bounded via the public API.

#### 5. Filesystem Errors Uncaught

**Location:** `improve.ts:255–276`

Calls to `createProposal()`, `reindexFn()`, and related filesystem operations are not wrapped in try/catch. A filesystem error (disk full, permission denied, ENOENT) throws synchronously and exits the run without producing a structured `AkmImproveResult`. No partial results are returned or logged.

**Impact:** Operator has no visibility into how far the run progressed before failure.

---

### P2 — Significant Issues

#### 6. No Asset Limit or Prioritization

`getAllEntries()` has no LIMIT clause. A stash with 500 assets will schedule 500 serial agent spawns in a single run. Utility scores stored in the database are not consulted when ordering assets for processing.

**Impact:** Run time grows unboundedly with stash size; highest-value assets are not prioritized.

#### 7. No `--since` Flag or Watermark

Every run processes all assets regardless of whether any new signal has been recorded since the last run. There is no watermark or checkpoint file to track the last successful run's high-water mark.

**Impact:** Redundant LLM calls on unchanged assets; 46-minute runs even when only a handful of assets have new feedback.

#### 8. Input Signal Is Noise

498 feedback events are present in the stash, but the vast majority are bare timestamps with no `signal` field populated. Assets with zero meaningful signal are not skipped. When `distillFn()` receives a signal-less asset, the LLM paraphrases the asset's own body back as a "lesson" — producing content-free output.

**Impact:** Lesson quality is poor; proposal queue fills with restatements of existing content.

#### 9. Distill LLM Timeout Is 600s Per Asset

Each asset allows up to 10 minutes for the LLM distillation call. A hung or slow endpoint blocks one processing slot for 10 minutes. With no per-asset timeout enforcement (see Finding 4), this can silently extend total run time far beyond any operator expectation.

**Impact:** A single hung call can delay all downstream assets; total run time is unbounded.

#### 10. Missing `improve_invoked` Event — Spec Violation

The AKM spec §11.3 requires that an `improve_invoked` event be emitted at the start of every `akm improve` run. Zero such events appear in the live log. This means the audit trail for scheduled runs is incomplete and any tooling that listens for this event receives no signal.

**Impact:** Spec violation; observability tooling is blind to improve invocations.

#### 11. `--auto-accept safe` Flag Parses but Is Not Implemented

The `--auto-accept safe` flag is accepted by the CLI argument parser and appears in `--help` output. It has no implementation. Proposals that would qualify for safe auto-acceptance still go to the pending queue for manual review.

**Impact:** Operator is misled by a documented but non-functional feature.

#### 12. `akmConsolidate()` Invisible to Programmatic Callers

`akmConsolidate()` is called only from the CLI layer, not from inside `akmImprove()`. Any caller that invokes `akmImprove()` programmatically (e.g., tests, SDK integrations, other agents) gets reflection and distillation but not consolidation. The umbrella is incomplete.

**Impact:** Consolidation is silently skipped in non-CLI invocations; inconsistent behavior between CLI and programmatic callers.

---

### P3 — Observability and Quality Issues

#### 13. No Progress Output During Long Runs

During a 46-minute run, no output is emitted to stdout or the log. An operator watching a terminal cannot distinguish "working" from "hung". There is no per-asset progress indicator, estimated completion time, or heartbeat.

#### 14. Validation Failures Discovered Serially

When an asset fails validation (malformed frontmatter, missing required fields), the failure is discovered only when that asset is reached in the serial queue. There is no pre-run validation sweep. A stash with 50 invalid assets will fail 50 times across 50 separate LLM calls before the operator is aware.

#### 15. Agent Orientation Overhead

During the investigation run, approximately 5 minutes were consumed by the agent performing AKM stash searches to orient itself before invoking `akm improve`. This overhead is pure latency — all necessary context should be included in the agent's system prompt or task description.

#### 16. All 16 Command Files Missing `when_to_use` Frontmatter

All 16 files in the `commands/` directory were missing the required `when_to_use` frontmatter field. This field is required by the AKM spec for command assets. **This was patched by the agent during the investigation run** — all 16 files now have the required frontmatter. No further action required for this item.

---

## Recommended Fixes

Ordered by implementation priority. Items 1–4 are blockers and should be addressed before the next scheduled run.

| # | Fix | Priority | Notes |
|---|-----|----------|-------|
| 1 | Wrap per-asset loop body in `try/catch` → `continue` on error | P1 | Prevents one bad asset from aborting entire run |
| 2 | Pending-proposal dedup guard before calling `distillFn()` | P1 | Check by asset ref + content hash; skip if duplicate exists |
| 3 | Lockfile at `.akm/improve.lock` to prevent concurrent runs | P1 | Write PID; check + fail fast on second invocation |
| 4 | Move `akmConsolidate()` from CLI layer into `akmImprove()` | P1 | `improve` is the umbrella; consolidation must always run |
| 5 | Skip assets with zero meaningful feedback signals | P2 | Check `signal` field presence before calling `distillFn()` |
| 6 | `--limit N` (default 20) with utility-score ordering from DB | P2 | Prevents unbounded serial spawns; prioritizes high-value assets |
| 7 | Forward `timeoutMs` to `reflectFn()` / `distillFn()` | P2 | Honor the documented option |
| 8 | Emit `improve_invoked` event at run start | P2 | Restores spec §11.3 compliance |
| 9 | Pre-run validation sweep | P3 | Validate all assets before processing begins; report all failures at once |
| 10 | Progress output during run | P3 | Per-asset log line; elapsed/remaining estimate |
| 11 | `--since` / watermark tracking | P3 | Record last run timestamp; skip assets with no new signal since then |

---

## Current Stash State

As of the end of the investigation (2026-05-11):

| Item | State |
|------|-------|
| Total pending proposals | 146 |
| Duplicate proposals | 103 (requires manual triage) |
| `lesson:command-add-todo-lesson` copies | 9 |
| `commands/` frontmatter | Patched — all 16 files now have `when_to_use` |
| Stash consistency | Consistent; no mid-flight writes |
| Ongoing improve run | None |

### Manual Triage Required

The 103 duplicate proposals must be triaged manually. Recommended approach:

1. Run `akm proposals list --status pending` and group by asset ref.
2. For each group with more than one entry, reject all but the most recent.
3. After dedup guard (Fix #2 above) is implemented, re-run `akm improve` with `--limit 20` to generate fresh proposals from the highest-utility assets.

---

## Related Files

| File | Relevance |
|------|-----------|
| `src/commands/improve.ts` | Main umbrella implementation; all P1 findings are here |
| `src/lib/reflect.ts` | `reflectFn` — does not receive `timeoutMs` |
| `src/lib/distill.ts` | `distillFn` — does not receive `timeoutMs`; 600s default |
| `src/lib/spawn.ts` | `buildChildEnv` — PATH fix applied here |
| `src/commands/tasks.ts` | Scheduled task runner; `akm-improve` task definition |
| `src/lib/consolidate.ts` | `akmConsolidate()` — currently CLI-only |

---

*Investigation conducted by three parallel specialist agents. Findings synthesized and documented 2026-05-11.*
