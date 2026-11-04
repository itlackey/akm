// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** First-run setup for a host: what this computer offers, and the one `akm setup --yes` run that creates the library. */

import path from "node:path";
import { loadConfig, primaryBundlePath } from "../core/config/config";
import { UsageError } from "../core/errors";
import { getDefaultStashDir } from "../core/paths";
import { warnOnce } from "../core/warn";
import { detectEnvironment } from "../setup/detect";
import { runCli } from "./cli-child";
import * as configOps from "./config";

const APPLY_FIELDS = ["dir", "harness"];

/**
 * What setup could use here, read from the file system and PATH only: nothing is contacted and nothing is written.
 * `stashDir` is where the library is, or would be created; `harnesses` are the agent programs found on PATH that akm can
 * run work on.
 */
export async function detect() {
  const config = loadConfig();
  const found = await detectEnvironment({ existingStashDir: primaryBundlePath(config), probe: false });
  return {
    stashDir: found.stashSuggestions[0]?.path ?? getDefaultStashDir(),
    harnesses: found.harnesses.map(({ platform, path }) => ({ platform, path })),
  };
}

/**
 * `akm setup --yes --no-probe`: the library directory (created and made the default bundle when there is none) and the
 * agent programs akm may run work on. Nothing the config already holds changes, so running it again is a no-op.
 *
 * `--yes` enables every agent program it finds when none is configured, and so lets akm spend that program's model
 * quota. A host asks for that per program, so an enablement the caller did not name is removed again.
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
  const named = harness ?? [];
  const hadHarnesses = Object.keys(loadConfig().harnesses ?? {}).length > 0;
  const result = await runCli([
    "setup",
    "--yes",
    "--no-probe",
    ...(dir ? [`--dir=${dir}`] : []),
    ...(named.length ? [`--harness=${named.join(",")}`] : []),
  ]);
  if (!named.length && !hadHarnesses) configOps.change({ unset: ["harnesses"] });
  return result;
}
