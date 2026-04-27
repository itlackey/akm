/**
 * akm-bench trajectory parser (spec §6.2).
 *
 * Trajectory metrics describe the *path* the agent took through the run, not
 * just the terminal outcome. For #238 we score two booleans per run:
 *
 *   • `correctAssetLoaded` — did the agent invoke `akm show <goldRef>` (or
 *     a sufficient prefix thereof) at any point during the run? `null` when
 *     the task carries no `goldRef` (and so the metric is undefined).
 *   • `feedbackRecorded` — did the agent emit any `feedback` event into
 *     `events.jsonl` during the run? Always `false` for the `noakm` arm
 *     because that arm runs without a stash.
 *
 * The driver hands us a `RunResult` after the run has finished. We never
 * mutate it; we return a fresh `TrajectoryRecord` and let the runner splice
 * it back in. This keeps `runOne`'s signature stable and lets `#239`/`#240`
 * extend the trajectory shape without touching the driver.
 */

import type { RunResult, TrajectoryRecord } from "./driver";

/** Inputs the trajectory parser cares about — we accept a TaskMetadata-ish duck. */
export interface TrajectoryTaskInput {
  /** Asset ref like `skill:docker-homelab`. Optional. */
  goldRef?: string;
}

/**
 * Compute the trajectory record for a single run.
 *
 * The `correctAssetLoaded` heuristic looks for the `akm show <ref>` invocation
 * in two places:
 *   1. The `events.jsonl` events array (if `akm show` ever emits an event —
 *      currently it does not, but we future-proof).
 *   2. The agent's stdout/verifier stdout (`runResult.verifierStdout`). When
 *      opencode logs its tool calls, the literal string `akm show <ref>`
 *      appears verbatim in the trace.
 *
 * We accept a "sufficient prefix": `skill:docker-homelab` matches both the
 * exact ref and `skill:docker-homelab/anything`. The match is conservative
 * — case-sensitive, exact substring on `akm show <ref>` (whitespace-flexible).
 */
export function computeTrajectory(task: TrajectoryTaskInput, runResult: RunResult): TrajectoryRecord {
  const correctAssetLoaded = computeCorrectAssetLoaded(task, runResult);
  const feedbackRecorded = computeFeedbackRecorded(runResult);
  return { correctAssetLoaded, feedbackRecorded };
}

function computeCorrectAssetLoaded(task: TrajectoryTaskInput, runResult: RunResult): boolean | null {
  if (!task.goldRef) return null;
  const ref = task.goldRef;

  // Search the events stream for any tool-call event that carries the ref.
  // akm itself does not emit an event for `show`, but third parties might,
  // and the field is forward-compatible.
  for (const event of runResult.events) {
    const refField = event.ref;
    if (typeof refField === "string" && matchesRef(refField, ref)) return true;
    const meta = event.metadata;
    if (meta && typeof meta === "object") {
      const candidate = (meta as Record<string, unknown>).ref;
      if (typeof candidate === "string" && matchesRef(candidate, ref)) return true;
    }
  }

  // Substring scan on the captured agent/verifier stdout. We look for either
  //   - `akm show <ref>` (the canonical form opencode logs when the agent
  //     invokes the akm CLI as a tool), or
  //   - the bare ref appearing on a line that mentions `show` (covers tool-
  //     call JSON like `{"command":"akm","args":["show","skill:foo"]}`).
  const haystack = runResult.verifierStdout;
  if (haystack && containsAkmShow(haystack, ref)) return true;

  return false;
}

function matchesRef(candidate: string, gold: string): boolean {
  if (candidate === gold) return true;
  // Allow goldRef to be a prefix of a more-specific ref (e.g. team//skill:foo
  // when the task says skill:foo). Keep the check anchored to ref segments.
  if (candidate.endsWith(`//${gold}`)) return true;
  if (candidate.startsWith(`${gold}/`)) return true;
  return false;
}

function containsAkmShow(text: string, ref: string): boolean {
  // Whitespace-flexible match for `akm show <ref>`. We escape regex metas in
  // the ref because asset refs may contain `:` (always) and `/` (origin form).
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`akm\\s+show\\s+(?:["'])?${escaped}(?:\\b|\\W)`);
  if (pattern.test(text)) return true;

  // Tool-call JSON form: `"args":["show","<ref>"]` or similar. Cheap heuristic.
  if (text.includes(`"show"`) && text.includes(ref)) return true;

  return false;
}

function computeFeedbackRecorded(runResult: RunResult): boolean {
  // The `noakm` arm runs without an akm stash, so events.jsonl will be empty
  // by construction. Still honour the same scan — the assertion is an
  // invariant of the events stream, not arm-specific behaviour.
  for (const event of runResult.events) {
    if (event.eventType === "feedback") return true;
  }
  return false;
}
