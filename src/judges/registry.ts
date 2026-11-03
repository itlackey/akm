// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The registry of akm's model judges (#1306). A judge registers once, with the
 * schema of everything it reads, the schema of its verdict and a schema version.
 * `akm judge <name>` and akm's own pipeline both call a judge through its entry
 * (`run`), so the command and the pipeline cannot drift. A judge failure is an
 * outcome of its own (`error`, `unparseable`), never a verdict.
 */

import { pairJudge } from "../commands/improve/consolidate/pair-pass";
import { lessonQualityJudge, reflectQualityJudge } from "../commands/improve/stage";
import { judgmentJudge } from "../commands/proposal/drain";
import type { AkmConfig } from "../core/config/config";
import { ConfigError, UsageError } from "../core/errors";
import { validateJsonSchemaSubset } from "../core/json-schema";
import type { NoticeSink } from "../execution/notices";
import type { ConfiguredExecutionSettings } from "../execution/source";
import type { RunnerSpec } from "../integrations/agent/runner";
import type { ChatCompletionConfig, ChatCompletionOptions, ChatMessage } from "../llm/client";

export type JudgeOutcome<V> =
  | { outcome: "verdict"; verdict: V }
  | { outcome: "error"; reason: string }
  | { outcome: "unparseable"; reason: string };

/** What one judge call runs on. The runner is already resolved; a judge never picks its own. */
export interface JudgeCall {
  runner: RunnerSpec;
  /** Transport override for tests. */
  chat?: (
    connection: ChatCompletionConfig,
    messages: ChatMessage[],
    options?: ChatCompletionOptions,
  ) => Promise<string>;
  signal?: AbortSignal;
  /** An own key set to `null` or `undefined` disables the runner's timeout; absent keeps it. */
  timeoutMs?: number | null;
  onNotices?: NoticeSink;
}

export interface Judge<I = unknown, V = unknown> {
  /** Stable name, `<process>.<what>`. */
  name: string;
  description: string;
  /** Bumped when the input or the verdict changes shape. */
  schemaVersion: number;
  /** Everything the judge reads. Unknown fields are refused. */
  inputSchema: Record<string, unknown>;
  /** The verdict, when there is one. */
  outputSchema: Record<string, unknown>;
  /** What the judge may read on its own when it runs on a harness. */
  harnessReads: string;
  /** The runner akm gives this judge when the call selects none; `run` is what the call selected. */
  defaultRunner(config: AkmConfig, run?: ConfiguredExecutionSettings): RunnerSpec | undefined;
  run(input: I, call: JudgeCall): Promise<JudgeOutcome<V>>;
}

// biome-ignore lint/suspicious/noExplicitAny: the registry holds judges of different input and verdict types.
const judges = new Map<string, Judge<any, any>>();

// biome-ignore lint/suspicious/noExplicitAny: see above.
export function registerJudge(judge: Judge<any, any>): void {
  judges.set(judge.name, judge);
}

export function getJudge(name: string): Judge {
  const judge = judges.get(name);
  if (!judge) {
    throw new UsageError(
      `Unknown judge "${name}". Registered judges: ${[...judges.keys()].join(", ")}.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return judge;
}

export function listJudges(): Judge[] {
  return [...judges.values()];
}

export interface JudgeEnvelope {
  judge: string;
  schemaVersion: number;
  runner: { kind: RunnerSpec["kind"]; name: string; platform?: string; model: string | null };
  outcome: JudgeOutcome<unknown>["outcome"];
  verdict?: unknown;
  reason?: string;
}

/** One judge call from outside the pipeline: check the input, pick the runner, run, and wrap the result with the runner it ran on. */
export async function runJudge(
  name: string,
  input: unknown,
  config: AkmConfig,
  selection: ConfiguredExecutionSettings,
  call: Omit<JudgeCall, "runner"> = {},
): Promise<JudgeEnvelope> {
  const judge = getJudge(name);
  const errors = validateJsonSchemaSubset(input, judge.inputSchema);
  if (errors.length > 0) {
    throw new UsageError(`Input for judge ${name} is invalid: ${errors.join("; ")}`, "INVALID_JSON_ARGUMENT");
  }
  const runner = judge.defaultRunner(config, selection);
  if (!runner) {
    throw new ConfigError(
      `Judge ${name} has no connection or harness to run on. Pass --connection or --harness, or run \`akm setup\`.`,
      "LLM_NOT_CONFIGURED",
    );
  }
  const result = await judge.run(input, { ...call, runner });
  return {
    judge: name,
    schemaVersion: judge.schemaVersion,
    runner: {
      kind: runner.kind,
      name: runner.name,
      ...(runner.kind === "harness" ? { platform: runner.platform } : {}),
      model: runner.model ?? null,
    },
    outcome: result.outcome,
    ...(result.outcome === "verdict" ? { verdict: result.verdict } : { reason: result.reason }),
  };
}

for (const judge of [reflectQualityJudge, lessonQualityJudge, pairJudge, judgmentJudge]) registerJudge(judge);
