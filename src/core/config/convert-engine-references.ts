// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Where the engines of improve strategies, index passes and workflow gates went: the
 * `connection` / `harness` they name now, or the process they moved to. See `convert-engines.ts`.
 */

import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../common";
import { type Conversion, type Dict, type EngineTarget, objectAt, str } from "./convert-engines-shared";

/** What a strategy's process, quality gate or judgment once said about where it runs and how. */
const EXECUTION_KEYS = ["connection", "harness", "model", "llm", "timeoutMs"] as const;

export type Retarget = (holder: unknown, where: string, harnessOk?: boolean) => void;

/** Rewrite the `engine` of `holder` as the `connection` or `harness` it names now, unless the holder already says. */
export function retargeter(conversion: Conversion, target: (engine: string) => EngineTarget | undefined): Retarget {
  return (holder, where, harnessOk = true) => {
    if (!isRecord(holder) || !("engine" in holder)) return;
    conversion.changed = true;
    const engine = str(holder.engine);
    delete holder.engine;
    const found = engine === undefined ? undefined : target(engine);
    if (found === undefined) conversion.notes.push(`${where}: engine ${JSON.stringify(engine)} is not carried over.`);
    else if ("harness" in found && !harnessOk)
      conversion.notes.push(`${where}: index passes run on connections only; engine "${engine}" is not carried over.`);
    else for (const [key, value] of Object.entries(found)) holder[key] ??= value;
  };
}

/**
 * A strategy's `engine`, `model`, `llm` and `timeoutMs` are dropped (it says which processes run, not where), and
 * where its processes, quality gates and triage judgment said a process runs moves to `improve.processes.<name>` /
 * `improve.qualityGate`; the first strategy to say it wins.
 */
export function moveStrategyExecution(improve: Dict, conversion: Conversion, retarget: Retarget): void {
  if (!isRecord(improve.strategies)) return;
  const hoist = (holder: unknown, from: string, place: string, destination: () => Dict): void => {
    if (!isRecord(holder)) return;
    retarget(holder, `${from}.engine`);
    const found = EXECUTION_KEYS.filter((key) => key in holder);
    if (found.length === 0) return;
    conversion.changed = true;
    const into = destination();
    for (const key of found) {
      const value = holder[key];
      delete holder[key];
      const names = key === "connection" || key === "harness";
      const taken = names ? "connection" in into || "harness" in into : key in into;
      if (!taken) into[key] = value;
      else if (!isDeepStrictEqual(into[key], value))
        conversion.notes.push(`${from}.${key}: ${place} already says where this runs; the first choice is kept.`);
    }
  };
  const processEntry = (name: string) => () => objectAt(objectAt(improve, "processes"), name);
  for (const [strategyName, strategy] of Object.entries(improve.strategies)) {
    if (!isRecord(strategy)) continue;
    for (const key of ["engine", "model", "llm", "timeoutMs"]) {
      if (key in strategy) {
        delete strategy[key];
        conversion.changed = true;
        conversion.notes.push(
          `improve.strategies.${strategyName}.${key}: a strategy says which processes run, not where; it is dropped.`,
        );
      }
    }
    for (const [processName, process] of Object.entries(isRecord(strategy.processes) ? strategy.processes : {})) {
      const where = `improve.strategies.${strategyName}.processes.${processName}`;
      if (!isRecord(process)) continue;
      // Triage's judgment is the model call; in 0.9 its setting was the nearer one, so it is hoisted first and wins.
      hoist(process.judgment, `${where}.judgment`, "improve.processes.triage", processEntry("triage"));
      hoist(process, where, `improve.processes.${processName}`, processEntry(processName));
      hoist(process.qualityGate, `${where}.qualityGate`, "improve.qualityGate", () => objectAt(improve, "qualityGate"));
    }
  }
}

/** `defaults.improveStrategy`: `improve.strategy`. */
export function improveStrategyDefault(out: Dict, defaults: Dict, improve: unknown): void {
  if (defaults.improveStrategy === undefined) return;
  out.improve = { ...(isRecord(improve) ? improve : {}) };
  (out.improve as Dict).strategy ??= defaults.improveStrategy;
}

/** `workflow.judgeEngine`: a gate's judge is the default connection or harness now. */
export function dropJudgeEngine(out: Dict, conversion: Conversion): void {
  const workflow = out.workflow;
  if (!isRecord(workflow) || !("judgeEngine" in workflow)) return;
  delete workflow.judgeEngine;
  conversion.changed = true;
  conversion.notes.push(
    "workflow.judgeEngine: a gate's judge is the default connection or harness now; it is dropped.",
  );
}

/** `index.defaults.*` and `index.<pass>.engine`: `index.*` and `connection`; a harness cannot run an index pass. */
export function convertIndexEngines(out: Dict, conversion: Conversion, retarget: Retarget): void {
  const index = out.index;
  if (!isRecord(index)) return;
  const indexDefaults = index.defaults;
  delete index.defaults;
  if (isRecord(indexDefaults)) {
    conversion.changed = true;
    retarget(indexDefaults, "index.defaults.engine", false);
    for (const key of ["connection", "model", "timeoutMs", "llm"])
      if (indexDefaults[key] !== undefined) index[key] ??= indexDefaults[key];
  }
  for (const [pass, value] of Object.entries(index))
    if (pass !== "connection") retarget(value, `index.${pass}.engine`, false);
}
