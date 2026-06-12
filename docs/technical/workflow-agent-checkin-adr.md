# ADR: Agent harness check-in, summary capture, and summary validation

Status: Accepted (release/0.9.0)
Issues: #506 (this design), #501 (reconciled — see below)

## Context

Workflow runs are driven by an agent (Claude Code, OpenCode, …) calling the
`akm workflow start` / `next` / `complete` command loop. Two related issues
asked for the run engine to become more resilient to a *stalled* agent and to
guard *completion quality*:

- **#506** asks for (1) recording the agent harness + session id on a run and
  arming a short-interval "check-in" that nudges a stopped agent with a strong
  `continue` directive, (2) requiring a summary when a step/workflow completes,
  (3) a validation gate that judges the summary against the step's
  `completionCriteria` via the configured LLM and returns corrective feedback on
  failure, and (4) doing the check-in **without a long-running background
  thread** — steer via the command loop or a reliable file-based signal.
- **#501** asks for the *opposite* check-in implementation: an explicit
  long-running background thread/timer that watches the session and injects a
  continue.

These two cannot both be implemented; the conflict had to be resolved before
any code landed.

## Decision

We adopt the **#506 file-signal model** and explicitly reject the #501
background-thread model. Rationale:

1. **No daemon in a CLI.** `akm` is a short-lived, per-invocation CLI. A
   background thread/timer would have to outlive the process (a daemon), which
   adds lifecycle, supervision, and shutdown-leak surface that the rest of the
   tool deliberately avoids. Every other durable concern in akm is a row in a
   SQLite db or a file on disk, polled on the next command — not a resident
   process.
2. **The command loop is already the heartbeat.** The agent *already* polls the
   engine every time it runs `workflow next` / `complete`. That natural cadence
   is the reliable place to surface a check-in directive — no second mechanism
   needs to exist to "wake" the agent because the agent wakes the engine.
3. **Determinism + testability.** A file-based armed-signal plus a pure
   `evaluateCheckin(now, run)` function is trivially unit-testable and has no
   timing flakiness. A thread is neither.

### Mechanism

- **Recording (AC2).** `startWorkflowRun` records `agent_harness` and
  `agent_session_id` on the `workflow_runs` row (new columns via migration
  `002`). Identity is discovered from the `SESSION_LOG_HARNESS` /
  `SESSION_LOG_SESSION_ID` environment hints the harness exports, falling back
  to `null` when unknown (never fatal). At the same time a check-in is *armed*
  by stamping `checkin_armed_at = now`.
- **Check-in (AC5), no thread.** Arming writes a timestamp, not a timer. On the
  next `workflow next` / `status` call the engine calls the pure
  `evaluateCheckin()` helper: if the run is still active and
  `now - max(updated_at, checkin_armed_at) >= CHECKIN_STALL_MS`, the command
  output carries a `checkin` block with a strong `continue` directive. The
  directive is surfaced through the *normal* command output the agent already
  reads — and, for harnesses that watch the filesystem, also written as a
  best-effort `checkin signal file` under the run scope. Re-arming on every
  state change keeps it from firing on a healthy, progressing run.
- **Summary (AC3).** `completeWorkflowStep` accepts a required `summary` of the
  work done and persists it on the step row (new `summary` column). The final
  step's summary doubles as the workflow summary. `akm workflow complete` gains
  a `--summary` flag.
- **Validation gate (AC4).** When a `summary` and the step's
  `completionCriteria` are both present, `validateStepSummary()` builds a
  judging prompt and calls the configured LLM. On `complete: false` it returns
  structured corrective feedback (`missing[]`, `feedback`) and the step is **not**
  marked complete — the directive steers the agent on what to finish/fix. On
  `complete: true` the step is marked complete. When no LLM is configured or no
  criteria exist, the gate is skipped (fail-open) so offline use keeps working.

## Consequences

- No resident process; all state is durable rows/files polled by the next
  command — consistent with the rest of akm.
- #501's background-thread approach is superseded; that issue should be closed
  as "implemented via #506 file-signal model".
- The LLM dependency on the completion path is *optional*: a missing/unreachable
  LLM degrades to the pre-existing behaviour (complete without judging) rather
  than blocking work.
