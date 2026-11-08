// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** First-run setup for a host: what this computer offers, the library, and the agent programs akm may use. */

import path from "node:path";
import { defaultConnection, loadConfig, primaryBundlePath } from "../core/config/config";
import { UsageError } from "../core/errors";
import { getDefaultStashDir } from "../core/paths";
import { warnOnce } from "../core/warn";
import { detectEnvironment } from "../setup/detect";
import { learningState, setLearning } from "../setup/learning";
import { parseSetupFlags } from "../setup/setup-flags";
import { describeRuns, runsReadOnly, unrestrictedModelWorkNote } from "../setup/summary";
import { runCli } from "./cli-child";
import { preserveUnrelatedConfig } from "./readers";

const APPLY_FIELDS = ["dir", "harness", "learning", "connection"];

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
  const { runsOn, ...learning } = learningState(config);
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
 * key, and its model for every alias). `learning` turns background learning on or off: off switches each
 * model-calling improve process off in the active strategy (which also stops `akm proposal extract`, so a session-end
 * hook makes no model call) and disables the scheduled `improve` task; on clears those switches, so the strategy's own
 * defaults apply again, runs improve on `agent` (`improve.harness`, else the connection `improve.connection`) and
 * enables the task. A switch the person set themselves is cleared too: the config does not say who wrote it.
 * Learning alone (no `dir`, `harness` or `connection`) changes only learning and creates no library.
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
  // Learning alone changes only learning: no library is created for it.
  if (harness?.length || dir !== undefined || checked || !learning)
    await runCli(
      harness?.length
        ? ["setup", "--yes", "--no-probe", ...(dir ? [`--dir=${dir}`] : []), `--harness=${harness.join(",")}`]
        : ["bundle", "create", `--dir=${dir ?? primaryBundlePath(config) ?? getDefaultStashDir()}`],
    );
  if (checked || learning) await setLearning(learning, checked);
  return detect();
}
