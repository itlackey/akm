// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig } from "../../core/config/config";
import { IMPROVE_ENGINE_PROCESSES } from "../../core/config/engine-semantics";
import type { StandardAlias } from "../../core/config/model-aliases";
import { ConfigError } from "../../core/errors";
import type { LoweringNotice } from "../../execution/resolved-request";
import { type ConfiguredExecutionSettings, executionDefaultsOf } from "../../execution/source";
import { buildExecution, currentLayer, resolveExecution, shippedAlias } from "../../integrations/agent/execution";
import type { RunnerSpec } from "../../integrations/agent/runner";

/** The settings a layer of improve's cascade can carry: where to run, which model, and how. */
type ImproveExecutionLayer = ConfiguredExecutionSettings;

export interface ResolveImproveExecutionOptions {
  config: AkmConfig;
  /** What the call is for. When it names an improve process, `improve.processes.<name>` applies to it. */
  processName: string;
  /** The alias this kind of call asks for when no layer names a model. */
  alias: StandardAlias;
  /** The `improve.processes` entry that applies, for a call that is not itself an improve process (a judge). */
  process?: (typeof IMPROVE_ENGINE_PROCESSES)[number];
  /**
   * The process's standing `index.<pass>` settings, when the process has one:
   * farther than the process's own settings.
   */
  index?: ImproveExecutionLayer;
  /** Nearer one-shot selection for this call, such as a quality gate's own judge settings. */
  current?: ImproveExecutionLayer;
  /** What the run itself selected (a flag naming a connection or harness): the nearest layer of every call in it, judges included. */
  run?: ImproveExecutionLayer;
}

export interface ResolvedImproveExecution {
  runner: RunnerSpec;
  notices: readonly Readonly<LoweringNotice>[];
}

/**
 * Resolve improve-owned model work: `improve.connection` / `improve.harness`
 * -> index.<pass> -> `improve.processes.<name>` -> the call's own settings ->
 * the run's selection, nearest wins, over the default by name. A strategy adds no layer: it says which
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
        shippedAlias(options.alias),
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
        { id: "run", kind: "current", values: executionDefaultsOf(options.run) },
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
