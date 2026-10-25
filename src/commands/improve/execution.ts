// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig } from "../../core/config/config";
import { IMPROVE_ENGINE_PROCESSES } from "../../core/config/engine-semantics";
import { ConfigError } from "../../core/errors";
import type { LoweringNotice } from "../../execution/resolved-request";
import { type ConfiguredExecutionSettings, executionDefaultsOf } from "../../execution/source";
import { buildExecution, currentLayer, resolveExecution } from "../../integrations/agent/execution";
import type { RunnerSpec } from "../../integrations/agent/runner";

/** The settings a layer of improve's cascade can carry: where to run, which model, and how. */
type ImproveExecutionLayer = ConfiguredExecutionSettings;

export interface ResolveImproveExecutionOptions {
  config: AkmConfig;
  /** What the call is for. When it names an improve process, `improve.processes.<name>` applies to it. */
  processName: string;
  /** The `improve.processes` entry that applies, for a call that is not itself an improve process (a judge). */
  process?: (typeof IMPROVE_ENGINE_PROCESSES)[number];
  /**
   * The process's standing `index.<pass>` settings, when the process has one:
   * farther than the process's own settings.
   */
  index?: ImproveExecutionLayer;
  /** Nearer one-shot selection, such as an explicit CLI connection/harness/timeout. */
  current?: ImproveExecutionLayer;
}

export interface ResolvedImproveExecution {
  runner: RunnerSpec;
  notices: readonly Readonly<LoweringNotice>[];
}

/**
 * Resolve improve-owned model work: `improve.connection` / `improve.harness`
 * -> index.<pass> -> `improve.processes.<name>` -> current invocation, nearest
 * wins, over the default by name. A strategy adds no layer: it says which
 * processes run, never where. `null` when no connection or harness is
 * configured for it.
 */
export function resolveImproveExecution(options: ResolveImproveExecutionOptions): ResolvedImproveExecution | null {
  const processKey = options.process ?? options.processName;
  const processes = options.config.improve?.processes as Record<string, ConfiguredExecutionSettings> | undefined;
  try {
    const prepared = resolveExecution({
      content: `improve ${options.processName} execution selection`,
      config: options.config,
      layers: [
        { id: "improve", kind: "invocation-defaults", values: executionDefaultsOf(options.config.improve) },
        { id: "index", kind: "invocation-defaults", values: executionDefaultsOf(options.index) },
        {
          id: `improve.processes.${processKey}`,
          kind: "invocation-defaults",
          values: executionDefaultsOf(
            (IMPROVE_ENGINE_PROCESSES as readonly string[]).includes(processKey) ? processes?.[processKey] : undefined,
          ),
        },
        currentLayer(executionDefaultsOf(options.current)),
      ],
      modelWork: true,
    });
    const lowered = buildExecution(prepared.request, prepared.runner);
    return Object.freeze({ runner: lowered.runner, notices: lowered.notices });
  } catch (error) {
    if (error instanceof ConfigError && error.code === "LLM_NOT_CONFIGURED") return null;
    throw error;
  }
}
