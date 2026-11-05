// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** First-run setup for a host: what this computer offers, the library, and the agent programs akm may use. */

import path from "node:path";
import { targetRows } from "../commands/targets";
import {
  type AkmConfig,
  defaultConnection,
  loadConfig,
  primaryBundlePath,
  resetConfigCache,
} from "../core/config/config";
import { IMPROVE_ENGINE_PROCESSES } from "../core/config/engine-semantics";
import { STANDARD_ALIASES } from "../core/config/model-aliases";
import { sameEndpoint } from "../core/endpoint-url";
import { UsageError } from "../core/errors";
import { getDefaultStashDir } from "../core/paths";
import { warnOnce } from "../core/warn";
import { detectEnvironment } from "../setup/detect";
import { parseSetupFlags } from "../setup/setup-flags";
import { describeRuns, runsReadOnly, unrestrictedModelWorkNote } from "../setup/summary";
import { listEmbeddedTasks } from "../tasks/embedded";
import { runCli } from "./cli-child";
import { change } from "./config";
import { preserveUnrelatedConfig } from "./readers";
import * as tasks from "./tasks";

const APPLY_FIELDS = ["dir", "harness", "learning", "connection"];
/** The scheduled task that runs `akm improve`: akm's background learning. */
const LEARNING_TASK = "improve";

/** The strategy `akm improve` runs, and so the one whose process switches background learning uses. */
const activeStrategy = (config: AkmConfig) => config.improve?.strategy ?? "default";
const processKey = (config: AkmConfig, name: string) =>
  `improve.strategies.${activeStrategy(config)}.processes.${name}.enabled`;

/**
 * The keys that remove the switches setup wrote: each `enabled: false` of the active strategy, and any object left
 * empty by that, up to the strategy itself.
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

/** The model-calling improve processes the person's own config switches off in the active strategy. */
function switchedOff(config: AkmConfig): string[] {
  const processes = config.improve?.strategies?.[activeStrategy(config)]?.processes as
    | Record<string, { enabled?: boolean } | undefined>
    | undefined;
  return IMPROVE_ENGINE_PROCESSES.filter((name) => processes?.[name]?.enabled === false);
}

/**
 * What setup could use here, read from the file system, PATH and the config only: nothing is contacted and nothing is
 * written. `stashDir` is where the library is, or would be created; `harnesses` are the agent programs found on PATH
 * that akm can run work on, each with what its model calls could do (`modelWorkNote`, akm's own words);
 * `enabled` are the platforms the config already has; `modelCalls` is where akm's own model calls (improve, judging, extraction) run, as
 * `akm setup` says it, with the platform when they run on a harness; `connection` is the connection that takes them
 * when no agent does. `learning` is background learning: on when akm's model calls run somewhere (`modelCalls`) and
 * the config does not switch every learning process off, as learning off does, so a session-end extract or an improve
 * run could spend model quota; `agent` is the platform they run on (`null`: akm itself, or off).
 */
export async function detect() {
  const config = loadConfig();
  const found = await detectEnvironment({ existingStashDir: primaryBundlePath(config), probe: false });
  const rows = targetRows({ config });
  const improve = rows.find((row) => row.type === "process" && row.process === "improve");
  const harness =
    improve?.type === "process" && improve.kind === "harness"
      ? rows.find((row) => row.type === "harness" && row.name === improve.target)
      : undefined;
  const runsOn = harness?.type === "harness" ? harness.platform : null;
  const learning =
    improve?.type === "process" &&
    improve.kind !== null &&
    switchedOff(config).length < IMPROVE_ENGINE_PROCESSES.length;
  return {
    stashDir: found.stashSuggestions[0]?.path ?? getDefaultStashDir(),
    harnesses: found.harnesses.map(({ platform, path }) => ({
      platform,
      path,
      modelWorkNote: runsReadOnly(platform)
        ? "model calls are limited to reading and searching"
        : unrestrictedModelWorkNote(platform),
    })),
    enabled: [...new Set(Object.entries(config.harnesses ?? {}).map(([name, entry]) => entry.platform ?? name))],
    modelCalls: {
      platform: runsOn,
      description: describeRuns(config).modelCalls,
    },
    connection: defaultConnection(config)?.name ?? null,
    learning: { on: learning, agent: learning ? runsOn : null },
  };
}

/**
 * The library, the agent programs akm may use, and background learning, then `detect()` as it reads afterwards. With
 * `harness`, this is `akm setup --yes --no-probe --harness=<list>`, which also creates the library when there is none.
 * Without it, the library alone: `akm bundle create`, made the default bundle when there is none. `akm setup --yes`
 * would enable every agent program it finds, and so let akm spend that program's model quota, which a host asks for
 * per program.
 *
 * `connection` is written as the default connection (the endpoint's base URL, the NAME of the variable holding its
 * key, and its model for every alias). `learning` turns background learning on or off: off switches each
 * model-calling improve process off in the active strategy (which also stops `akm proposal extract`, so a session-end
 * hook makes no model call) and disables the scheduled `improve` task; on clears those switches, so the strategy's own
 * defaults apply again, runs improve on `agent` (`improve.harness`, else the connection `improve.connection`) and
 * enables the task. A switch the person set themselves is cleared too: the config does not say who wrote it.
 */
export async function apply(input: {
  dir?: string;
  harness?: string[];
  connection?: { endpoint: string; model: string; apiKeyEnv?: string };
  learning?: { on: boolean; agent?: string };
}) {
  for (const key of Object.keys(input)) {
    if (!APPLY_FIELDS.includes(key)) warnOnce(`setup-apply:${key}`, `[setup] apply: ignoring unknown field "${key}".`);
  }
  const { dir, harness, connection, learning } = input;
  if (dir !== undefined && (typeof dir !== "string" || !path.isAbsolute(dir)))
    throw new UsageError("dir must be an absolute path.");
  if (harness !== undefined && (!Array.isArray(harness) || harness.some((name) => typeof name !== "string")))
    throw new UsageError("harness must be a list of agent program names.");
  if (connection !== undefined && !(typeof connection?.endpoint === "string" && typeof connection.model === "string"))
    throw new UsageError("connection needs an endpoint and a model.");
  // Checked as `akm setup --endpoint --api-key-env` checks them: a base URL, and the NAME of a variable, never a key.
  const flags = connection && parseSetupFlags({ endpoint: connection.endpoint, apiKeyEnv: connection.apiKeyEnv });
  const checked = connection && { ...connection, endpoint: flags?.endpoint as string, apiKeyEnv: flags?.apiKeyEnv };
  if (learning !== undefined && typeof learning?.on !== "boolean")
    throw new UsageError("learning must say whether it is on.");
  const config = loadConfig();
  preserveUnrelatedConfig(config);
  await runCli(
    harness?.length
      ? ["setup", "--yes", "--no-probe", ...(dir ? [`--dir=${dir}`] : []), `--harness=${harness.join(",")}`]
      : ["bundle", "create", `--dir=${dir ?? primaryBundlePath(config) ?? getDefaultStashDir()}`],
  );
  if (checked || learning) await writeLearning(checked, learning);
  return detect();
}

async function writeLearning(
  connection: { endpoint: string; model: string; apiKeyEnv?: string } | undefined,
  learning: { on: boolean; agent?: string } | undefined,
) {
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
  const target = agent ?? (learning?.agent ? undefined : connectionName);
  const on = learning?.on === true && target !== undefined;
  if (learning?.on && target === undefined)
    warnOnce(
      `setup-apply:learning:${learning.agent ?? "connection"}`,
      learning.agent
        ? `[setup] apply: ${learning.agent} is not enabled; learning stays off.`
        : "[setup] apply: akm has no connection to learn through; learning stays off.",
    );
  if (learning) {
    for (const name of IMPROVE_ENGINE_PROCESSES) {
      if (!on) set[processKey(config, name)] = "false";
    }
    if (on) unset.push(...clearSwitches(config));
    if (on) {
      set[agent ? "improve.harness" : "improve.connection"] = target;
      unset.push(agent ? "improve.connection" : "improve.harness");
    }
  }
  if (Object.keys(set).length || unset.length) change({ set, unset });
  if (learning) await setLearningTask(on);
}

/** Enable the scheduled improve task (adding it from akm's template when the library has none), or disable it. */
async function setLearningTask(on: boolean) {
  const task = tasks.list().tasks.find((entry) => entry.id === LEARNING_TASK);
  if (!on) {
    if (task?.enabled) await tasks.disable({ task: LEARNING_TASK });
  } else if (!task) {
    const template = listEmbeddedTasks().find((entry) => entry.label === `core/${LEARNING_TASK}`);
    if (!template) throw new Error("akm ships no improve task template.");
    await runCli([
      "task",
      "add",
      LEARNING_TASK,
      `--schedule=${template.schedule}`,
      `--command=${template.command}`,
      `--description=${template.description}`,
      `--bundle=${loadConfig().defaultBundle}`,
    ]);
  } else if (!task.enabled) await tasks.enable({ task: LEARNING_TASK });
}
