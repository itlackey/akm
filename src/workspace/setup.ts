// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** First-run setup for a host: what this computer offers, the library, and the agent programs akm may use. */

import path from "node:path";
import { setConfigValue, unsetConfigValue } from "../commands/config";
import {
  type AkmConfig,
  defaultConnection,
  loadConfig,
  mutateConfig,
  primaryBundlePath,
  resetConfigCache,
} from "../core/config/config";
import { STANDARD_ALIASES } from "../core/config/model-aliases";
import { UsageError } from "../core/errors";
import { getDefaultStashDir } from "../core/paths";
import { warnOnce } from "../core/warn";
import { detectEnvironment } from "../setup/detect";
import { learningStatus, setLearning } from "../setup/learning";
import { parseSetupFlags } from "../setup/setup-flags";
import { applySetupAnswers } from "../setup/setup-plan";
import { describeRuns, runsReadOnly, unrestrictedModelWorkNote } from "../setup/summary";
import { listEmbeddedTasks } from "../tasks/embedded";
import { runCli } from "./cli-child";
import { preserveUnrelatedConfig } from "./readers";
import * as tasks from "./tasks";

const APPLY_FIELDS = ["dir", "harness", "learning", "connection"];
/** The scheduled task that runs `akm improve`: akm's background learning. */
const LEARNING_TASK = "improve";

/**
 * What setup could use here, read from the file system, PATH and the config only: nothing is contacted and nothing is
 * written. `stashDir` is where the library is, or would be created; `harnesses` are the agent programs found on PATH
 * that akm can run work on, each with what its model calls could do (`modelWorkNote`, akm's own words);
 * `enabled` are the platforms the config already has; `modelCalls` is where akm's own model calls (improve, judging, extraction) run, as
 * `akm setup` says it, with the platform when they run on a harness; `connection` is the connection that takes them
 * when no agent does. `learning` is background learning: `on` is the host-wide switch alone (`improve.enabled`, not
 * whether anything is set up to run), `harness` the platform improve runs on (`null`: a connection, or nowhere) and
 * `scheduled` whether the `improve` task is enabled.
 */
export async function detect() {
  const config = loadConfig();
  const found = await detectEnvironment({ existingStashDir: primaryBundlePath(config), probe: false });
  const learning = learningStatus(config);
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
      platform: learning.harness,
      description: describeRuns(config).modelCalls,
    },
    connection: defaultConnection(config)?.name ?? null,
    learning,
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
 * key, and its model for every alias). `learning` turns background learning on or off: off writes the one switch
 * (`improve.enabled: false`) and nothing else; on removes it, runs improve on `harness` (`improve.harness`, else the
 * connection `improve.connection`) and enables the `improve` task.
 */
export async function apply(input: {
  dir?: string;
  harness?: string[];
  connection?: { endpoint: string; model: string; apiKeyEnv?: string };
  learning?: { on: boolean; harness?: string };
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
  await (harness?.length
    ? runCli(
        ["setup", "--yes", "--no-probe", ...(dir ? [`--dir=${dir}`] : []), `--harness=${harness.join(",")}`],
        "setup",
      )
    : runCli(
        ["bundle", "create", `--dir=${dir ?? primaryBundlePath(config) ?? getDefaultStashDir()}`],
        "bundle-create",
      ));
  if (checked || learning) await writeLearning(checked, learning);
  return detect();
}

async function writeLearning(
  connection: { endpoint: string; model: string; apiKeyEnv?: string } | undefined,
  learning: { on: boolean; harness?: string } | undefined,
) {
  resetConfigCache();
  const config = loadConfig();
  const set: Record<string, string> = {};
  const unset: string[] = [];
  const connectionName = defaultConnection(config)?.name ?? (connection ? "default" : undefined);
  // As `akm setup` writes a connection: the same answer, the same rules for the key and the aliases.
  const writesConnection = Boolean(connection && connectionName);
  const withConnection = (current: AkmConfig): AkmConfig =>
    connection && connectionName
      ? {
          ...current,
          connections: applySetupAnswers(current, {
            connection: {
              name: connectionName,
              endpoint: connection.endpoint,
              ...(connection.apiKeyEnv ? { key: { env: connection.apiKeyEnv } } : {}),
              picks: Object.fromEntries(STANDARD_ALIASES.map((alias) => [alias, connection.model])),
            },
          }).patch.connections,
        }
      : current;
  // Where improve runs: the named harness's entry, else the connection. Neither: learning stays off, with a warning.
  const agent = learning?.harness
    ? Object.entries(config.harnesses ?? {}).find(([name, entry]) => (entry.platform ?? name) === learning.harness)?.[0]
    : undefined;
  const target = agent ?? (learning?.harness ? undefined : connectionName);
  const on = learning?.on === true && target !== undefined;
  if (learning?.on && target === undefined)
    warnOnce(
      `setup-apply:learning:${learning.harness ?? "connection"}`,
      learning.harness
        ? `[setup] apply: ${learning.harness} is not enabled; learning stays off.`
        : "[setup] apply: akm has no connection to learn through; learning stays off.",
    );
  if (on) {
    // An improve connection the person chose stays; the connection is named only when nothing says where improve runs.
    if (agent) set["improve.harness"] = target;
    else if (config.improve?.connection === undefined) set["improve.connection"] = target;
    unset.push(agent ? "improve.connection" : "improve.harness");
  }
  if (writesConnection || Object.keys(set).length || unset.length) {
    mutateConfig(
      (current) => {
        let updated = withConnection(current);
        for (const [key, value] of Object.entries(set)) updated = setConfigValue(updated, key, value);
        for (const key of unset) updated = unsetConfigValue(updated, key);
        if (updated !== current) preserveUnrelatedConfig(current);
        return updated;
      },
      // With no config file there is nothing to unset; a connection or a set still has to create it.
      { absentNoop: !writesConnection && Object.keys(set).length === 0 },
    );
    resetConfigCache();
  }
  if (learning) {
    setLearning(on);
    if (on) await enableLearningTask();
  }
}

/**
 * Learning on: the scheduled improve task exists (added from akm's template when the library has none) and is
 * enabled. Turning learning off leaves the schedule alone: the task then exits doing nothing.
 */
async function enableLearningTask() {
  const listed = tasks.list().tasks;
  const task = listed.find((entry) => entry.id === LEARNING_TASK);
  if (!task) {
    const template = listEmbeddedTasks().find((entry) => entry.label === `core/${LEARNING_TASK}`);
    if (!template) throw new Error("akm ships no improve task template.");
    await runCli(
      [
        "task",
        "add",
        LEARNING_TASK,
        `--schedule=${template.schedule}`,
        `--command=${template.command}`,
        `--description=${template.description}`,
        `--bundle=${loadConfig().defaultBundle}`,
      ],
      "task-add",
    );
  } else if (!task.enabled) await tasks.enable({ task: LEARNING_TASK });
}
