// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Background learning: whether akm's own model work (the improve processes and the scheduled `improve` task) may run,
 * and the one change that turns it on or off. `akm info` reads it, `akm setup --learning` and the workspace
 * `setup.apply` write it, `akm proposal new --if-learning` asks it.
 */

import fs from "node:fs";
import path from "node:path";
import { assertUnsettable, setConfigValue, unsetConfigValue } from "../commands/config-cli";
import { targetRows } from "../commands/targets";
import { akmTasksAdd, akmTasksDisable, akmTasksEnable, type TasksActivationResult } from "../commands/tasks/tasks";
import { makeBundleRef } from "../core/asset/asset-ref";
import { toErrorMessage } from "../core/common";
import { type AkmConfig, defaultConnection, loadConfig, mutateConfig, resetConfigCache } from "../core/config/config";
import { IMPROVE_ENGINE_PROCESSES } from "../core/config/engine-semantics";
import { STANDARD_ALIASES } from "../core/config/model-aliases";
import { sameEndpoint } from "../core/endpoint-url";
import { AkmError } from "../core/errors";
import { warn, warnOnce } from "../core/warn";
import { resolveWriteTarget } from "../core/write-source";
import { schedulerEnabledRefs, setSchedulerRefEnabled } from "../tasks/activation-config";
import { listEmbeddedTasks } from "../tasks/embedded";

/** The scheduled task that runs `akm improve`: akm's background learning. */
const LEARNING_TASK = "improve";

/** The strategy `akm improve` runs, and so the one whose process switches background learning uses. */
const activeStrategy = (config: AkmConfig) => config.improve?.strategy ?? "default";
const processKey = (config: AkmConfig, name: string) =>
  `improve.strategies.${activeStrategy(config)}.processes.${name}.enabled`;

/**
 * The keys that remove the switches learning off wrote: each `enabled: false` of the active strategy, and any object
 * left empty by that, up to the strategy itself.
 */
function clearSwitches(config: AkmConfig): string[] {
  const name = activeStrategy(config);
  const base = `improve.strategies.${name}`;
  const off = switchedOff(config);
  const strategy = structuredClone(config.improve?.strategies?.[name] ?? {}) as Record<string, unknown> & {
    processes?: Record<string, Record<string, unknown>>;
  };
  for (const process of off) delete strategy.processes?.[process]?.enabled;
  const kept = Object.values(strategy.processes ?? {}).some((process) => Object.keys(process).length > 0);
  if (off.length === 0) return [];
  if (!kept && Object.keys(strategy).every((key) => key === "processes"))
    return [Object.keys(config.improve?.strategies ?? {}).length === 1 ? "improve.strategies" : base];
  if (!kept) return [`${base}.processes`];
  return off.map((process) =>
    Object.keys(strategy.processes?.[process] ?? {}).length > 0
      ? `${base}.processes.${process}.enabled`
      : `${base}.processes.${process}`,
  );
}

/** The model-calling improve processes the config switches off in the active strategy. */
function switchedOff(config: AkmConfig): string[] {
  const processes = config.improve?.strategies?.[activeStrategy(config)]?.processes as
    | Record<string, { enabled?: boolean } | undefined>
    | undefined;
  return IMPROVE_ENGINE_PROCESSES.filter((name) => processes?.[name]?.enabled === false);
}

/**
 * Background learning, read from the config alone. `on`: akm's model calls run somewhere (`runsOn` names the agent
 * platform when it is one) and the config does not switch every learning process off, so a session-end extract or an
 * improve run could spend model quota. `agent` is the platform they run on (`null`: akm itself, or off).
 */
export function learningState(config: AkmConfig = loadConfig()): {
  on: boolean;
  agent: string | null;
  runsOn: string | null;
} {
  const rows = targetRows({ config });
  const improve = rows.find((row) => row.type === "process" && row.process === "improve");
  const harness =
    improve?.type === "process" && improve.kind === "harness"
      ? rows.find((row) => row.type === "harness" && row.name === improve.target)
      : undefined;
  const runsOn = harness?.type === "harness" ? harness.platform : null;
  const on =
    improve?.type === "process" &&
    improve.kind !== null &&
    switchedOff(config).length < IMPROVE_ENGINE_PROCESSES.length;
  return { on, agent: on ? runsOn : null, runsOn };
}

/** The default bundle's task source and the ref `id` has there, or undefined when there is no usable bundle. */
function taskLocation(config: AkmConfig, id: string) {
  if (!config.defaultBundle) return undefined;
  try {
    const source = resolveWriteTarget(config, config.defaultBundle, { requireWritable: false }).source;
    return { dir: path.join(source.path, "tasks"), ref: makeBundleRef(source.name, `tasks/${id}`) };
  } catch {
    return undefined;
  }
}

/** Whether the `improve` task is enabled on this host, by its ref in `scheduler.enabled`. Parses no task file. */
function learningTaskEnabled(config: AkmConfig): boolean {
  const ref = taskLocation(config, LEARNING_TASK)?.ref;
  return ref !== undefined && new Set(schedulerEnabledRefs(config)).has(ref);
}

/**
 * The learning block of `akm info`. Reads the config and the bundle's task YAML only: nothing is scheduled, probed or
 * written. `scheduled` is the config's word that the improve task is enabled, not the OS scheduler's.
 */
export function learningStatus(config: AkmConfig = loadConfig()) {
  const { on, agent } = learningState(config);
  return { on, agent, scheduled: learningTaskEnabled(config) };
}

/** What a learning change did. */
export interface LearningChange {
  on: boolean;
  agent: string | null;
  /** The improve processes whose `enabled` switch was written (off) or cleared (on). */
  processes: string[];
  tasksEnabled: string[];
  tasksDisabled: string[];
  /** Whether the improve task is scheduled on this host after the change. */
  scheduled: boolean;
}

/** As `akm config set` / `unset`: coerced and validated, and written atomically. */
function changeConfig(set: Record<string, string>, unset: string[]) {
  if (Object.keys(set).length === 0 && unset.length === 0) return;
  mutateConfig(
    (current) => {
      let updated = current;
      for (const [key, value] of Object.entries(set)) updated = setConfigValue(updated, key, value);
      for (const key of unset) {
        assertUnsettable(key);
        updated = unsetConfigValue(updated, key);
      }
      return updated;
    },
    { absentNoop: Object.keys(set).length === 0 },
  );
  resetConfigCache();
}

/**
 * Turn background learning on or off, and optionally write the default connection it runs through.
 *
 * Off switches each model-calling improve process off in the active strategy (which also stops `akm proposal extract`,
 * so a session-end hook makes no model call) and disables the scheduled `improve` task. On clears those switches, so the
 * strategy's own defaults apply again, runs improve on `agent` (`improve.harness`, else the connection
 * `improve.connection`) and enables the task, adding it from akm's template when the bundle has none. A switch the
 * person set themselves is cleared too: the config does not say who wrote it. With nowhere to run, on warns and stays
 * off. A host that cannot schedule (no `crontab`) warns, and the change reports `scheduled: false`.
 */
export async function setLearning(
  learning: { on: boolean; agent?: string } | undefined,
  connection?: { endpoint: string; model: string; apiKeyEnv?: string },
): Promise<LearningChange> {
  resetConfigCache();
  const config = loadConfig();
  const set: Record<string, string> = {};
  const unset: string[] = [];
  const connectionName = defaultConnection(config)?.name ?? (connection ? "default" : undefined);
  if (connection && connectionName) {
    // As `akm setup` writes a connection: a key belongs to the endpoint it was given for, so a new endpoint without
    // its own variable drops the old reference; an alias that carries request fields keeps them (`akm models set`).
    const base = `connections.${connectionName}`;
    const existing = config.connections?.[connectionName];
    set[`${base}.endpoint`] = connection.endpoint;
    if (connection.apiKeyEnv) set[`${base}.apiKey`] = `$${connection.apiKeyEnv}`;
    else if (existing?.apiKey !== undefined && !sameEndpoint(existing.endpoint, connection.endpoint))
      unset.push(`${base}.apiKey`);
    for (const alias of STANDARD_ALIASES) {
      const held = existing?.models?.[alias];
      set[`${base}.models.${alias}${typeof held === "object" ? ".model" : ""}`] = connection.model;
    }
  }
  // Where improve runs: the named agent's entry, else the connection. Neither: learning stays off, with a warning.
  const agent = learning?.agent
    ? Object.entries(config.harnesses ?? {}).find(([name, entry]) => (entry.platform ?? name) === learning.agent)?.[0]
    : undefined;
  const target = agent ?? (learning?.agent ? undefined : (connectionName ?? config.improve?.connection));
  const on = learning?.on === true && target !== undefined;
  if (learning?.on && target === undefined)
    warnOnce(
      `setup-apply:learning:${learning.agent ?? "connection"}`,
      learning.agent
        ? `[setup] apply: ${learning.agent} is not enabled; learning stays off.`
        : "[setup] apply: akm has no connection to learn through; learning stays off.",
    );
  let processes: string[] = [];
  if (learning) {
    if (!on) {
      processes = [...IMPROVE_ENGINE_PROCESSES];
      for (const name of processes) set[processKey(config, name)] = "false";
    } else {
      processes = switchedOff(config);
      unset.push(...clearSwitches(config));
      // An improve connection the person chose stays; the connection is named only when nothing says where improve runs.
      if (agent) set["improve.harness"] = target;
      else if (config.improve?.connection === undefined) set["improve.connection"] = target;
      unset.push(agent ? "improve.connection" : "improve.harness");
    }
  }
  changeConfig(set, unset);
  const tasks = learning
    ? await setLearningTask(on)
    : { enabled: [] as string[], disabled: [] as string[], scheduled: learningTaskEnabled(loadConfig()) };
  const state = learningState(loadConfig());
  return {
    on: state.on,
    agent: state.agent,
    processes,
    tasksEnabled: tasks.enabled,
    tasksDisabled: tasks.disabled,
    scheduled: tasks.scheduled,
  };
}

/**
 * Learning on: the scheduled improve task exists (added from akm's template when the library has none) and is
 * enabled, however learning read before. Off: that task is disabled, and so is any of akm's optional improve templates
 * (`improve/…`, which run `akm improve --strategy …`) that is installed and enabled; none is ever added. A scheduler
 * that cannot be written (no `crontab`) is a warning, not a failure: the config is already changed.
 */
async function setLearningTask(on: boolean) {
  const result = { enabled: [] as string[], disabled: [] as string[], scheduled: false };
  const config = loadConfig();
  const bundle = config.defaultBundle;
  const attempted: string[] = [];
  try {
    if (!on) {
      const optional = listEmbeddedTasks()
        .filter((entry) => entry.label.startsWith("improve/"))
        .map((entry) => entry.id);
      const legacy = schedulerEnabledRefs(config) === undefined;
      const enabled = new Set(schedulerEnabledRefs(config));
      for (const id of [LEARNING_TASK, ...optional]) {
        const where = taskLocation(config, id);
        if (!where || !fs.existsSync(path.join(where.dir, `${id}.yml`))) continue;
        if (!legacy && !enabled.has(where.ref)) continue;
        attempted.push(where.ref);
        await changeActivation(() => akmTasksDisable(id, { target: bundle }), where.ref);
        result.disabled.push(id);
      }
    } else if (!bundle) {
      warn("[setup] learning: there is no default bundle to hold the improve task; it is not scheduled.");
    } else {
      const where = taskLocation(config, LEARNING_TASK);
      if (!where) throw new Error("the default bundle cannot hold tasks");
      attempted.push(where.ref);
      if (!fs.existsSync(path.join(where.dir, `${LEARNING_TASK}.yml`))) {
        const template = listEmbeddedTasks().find((entry) => entry.label === `core/${LEARNING_TASK}`);
        if (!template) throw new Error("akm ships no improve task template.");
        await akmTasksAdd({
          id: LEARNING_TASK,
          schedule: template.schedule,
          command: template.command,
          description: template.description,
          target: bundle,
        });
        result.enabled.push(LEARNING_TASK);
      } else if (!learningTaskEnabled(config)) {
        await changeActivation(() => akmTasksEnable(LEARNING_TASK, { target: bundle }), where.ref);
        result.enabled.push(LEARNING_TASK);
      }
    }
  } catch (err) {
    // A held scheduler lock is a retry, not a host that cannot schedule: it keeps its exit code.
    if (err instanceof AkmError && err.code === "SCHEDULER_LOCK_HELD") throw err;
    warn(
      `[setup] learning: the schedule of the improve task could not be changed on this host: ${toErrorMessage(err)}`,
    );
    resetConfigCache();
    // Put the config back to what the OS scheduler holds, so `akm info` is true and a rerun retries.
    const current = loadConfig();
    const held = new Set(schedulerEnabledRefs(current));
    for (const ref of attempted) if (held.has(ref) !== !on) setSchedulerRefEnabled(ref, !on);
    resetConfigCache();
    return { enabled: [], disabled: [], scheduled: learningTaskEnabled(loadConfig()) };
  }
  resetConfigCache();
  return { ...result, scheduled: learningTaskEnabled(loadConfig()) };
}

/** `akm task enable` / `disable`, where a sync failure for the task is a failure, as it is for `akm task add`. */
async function changeActivation(change: () => Promise<TasksActivationResult>, ref: string) {
  const { sync } = await change();
  const failed = sync.failures.find((failure) => failure.ref === undefined || failure.ref === ref);
  if (failed) throw new Error(failed.reason);
}
