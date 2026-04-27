/**
 * akm-bench report rendering (spec §13.3).
 *
 * #236 ships a minimal stamped-JSON envelope plus a 5-line markdown summary.
 * The full §13.3 report shape — per-task breakdown, trajectory metrics,
 * delta arrays, warnings — lands in #238.
 */

import type { OutcomeAggregate } from "./metrics";

export interface ReportInput {
  /** ISO-8601 timestamp; caller is free to inject a fixed value in tests. */
  timestamp: string;
  /** Git branch the bench was run on. */
  branch: string;
  /** Git commit SHA. */
  commit: string;
  /** Model identifier; matches the value stamped on every RunResult. */
  model: string;
  /** Track name (`utility` or `evolve`). */
  track: "utility" | "evolve";
  /** Per-arm aggregate. Caller computes via `computeOutcomeAggregate`. */
  arms: Record<string, OutcomeAggregate>;
}

/**
 * Pretty-print a 2-space-indented JSON envelope. The shape is the v1
 * contract — `bench compare` reads it and refuses to diff across mismatched
 * `model` fields.
 */
export function renderJsonReport(input: ReportInput): string {
  const envelope = {
    schemaVersion: 1 as const,
    timestamp: input.timestamp,
    branch: input.branch,
    commit: input.commit,
    track: input.track,
    agent: { harness: "opencode", model: input.model },
    aggregate: input.arms,
  };
  return JSON.stringify(envelope, null, 2);
}

/**
 * 5-ish-line markdown summary for stderr / PR descriptions. The full diff
 * table lands with #238.
 */
export function renderMarkdownSummary(input: ReportInput): string {
  const lines: string[] = [];
  lines.push(`# akm-bench (${input.track}) — ${input.model}`);
  lines.push(`branch \`${input.branch}\` @ \`${input.commit}\` — ${input.timestamp}`);
  for (const [arm, agg] of Object.entries(input.arms)) {
    lines.push(
      `- **${arm}**: pass_rate=${agg.passRate.toFixed(2)}, tokens_per_pass=${agg.tokensPerPass.toFixed(0)}, wallclock_ms=${agg.wallclockMs.toFixed(0)}, budget_exceeded=${agg.budgetExceeded}`,
    );
  }
  return lines.join("\n");
}
