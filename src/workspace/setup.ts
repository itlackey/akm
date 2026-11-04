// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** First-run setup for a host: what this computer offers, the library, and the agent programs akm may use. */

import path from "node:path";
import { targetRows } from "../commands/targets";
import { loadConfig, primaryBundlePath } from "../core/config/config";
import { UsageError } from "../core/errors";
import { getDefaultStashDir } from "../core/paths";
import { warnOnce } from "../core/warn";
import { detectEnvironment } from "../setup/detect";
import { describeRuns } from "../setup/summary";
import { runCli } from "./cli-child";
import { preserveUnrelatedConfig } from "./readers";

const APPLY_FIELDS = ["dir", "harness"];

/**
 * What setup could use here, read from the file system, PATH and the config only: nothing is contacted and nothing is
 * written. `stashDir` is where the library is, or would be created; `harnesses` are the agent programs found on PATH
 * that akm can run work on; `modelCalls` is where akm's own model calls (improve, judging, extraction) run, as
 * `akm setup` says it, with the platform when they run on a harness.
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
  return {
    stashDir: found.stashSuggestions[0]?.path ?? getDefaultStashDir(),
    harnesses: found.harnesses.map(({ platform, path }) => ({ platform, path })),
    modelCalls: {
      platform: harness?.type === "harness" ? harness.platform : null,
      description: describeRuns(config).modelCalls,
    },
  };
}

/**
 * The library, and the agent programs akm may use, then `detect()` as it reads afterwards. With `harness`, this is
 * `akm setup --yes --no-probe --harness=<list>`, which also creates the library when there is none. Without it, the
 * library alone: `akm bundle create`, made the default bundle when there is none. `akm setup --yes` would enable every
 * agent program it finds, and so let akm spend that program's model quota, which a host asks for per program.
 */
export async function apply(input: { dir?: string; harness?: string[] }) {
  for (const key of Object.keys(input)) {
    if (!APPLY_FIELDS.includes(key)) warnOnce(`setup-apply:${key}`, `[setup] apply: ignoring unknown field "${key}".`);
  }
  const { dir, harness } = input;
  if (dir !== undefined && (typeof dir !== "string" || !path.isAbsolute(dir)))
    throw new UsageError("dir must be an absolute path.");
  if (harness !== undefined && (!Array.isArray(harness) || harness.some((name) => typeof name !== "string")))
    throw new UsageError("harness must be a list of agent program names.");
  const config = loadConfig();
  preserveUnrelatedConfig(config);
  await runCli(
    harness?.length
      ? ["setup", "--yes", "--no-probe", ...(dir ? [`--dir=${dir}`] : []), `--harness=${harness.join(",")}`]
      : ["bundle", "create", `--dir=${dir ?? primaryBundlePath(config) ?? getDefaultStashDir()}`],
  );
  return detect();
}
