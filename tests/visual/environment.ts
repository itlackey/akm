// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The harness sandbox: environment, directories and config (plan 8.7). */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfigPath } from "../../src/core/paths";

/** A fixed path, so no run-specific temp name can reach a screenshot. */
const ROOT = path.join(os.tmpdir(), "akm-visual");

export function isolateEnvironment(): string {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const dirs = {
    stash: path.join(ROOT, "stash"),
    config: path.join(ROOT, "config"),
    data: path.join(ROOT, "data"),
    cache: path.join(ROOT, "cache"),
    state: path.join(ROOT, "state"),
    home: path.join(ROOT, "home"),
    empty: path.join(ROOT, "empty"),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  Object.assign(process.env, {
    HOME: dirs.home,
    AKM_BUNDLE_DIR: dirs.stash,
    AKM_CONFIG_DIR: dirs.config,
    AKM_DATA_DIR: dirs.data,
    AKM_CACHE_DIR: dirs.cache,
    AKM_STATE_DIR: dirs.state,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    // Nothing from the host's agent installs may reach a health check.
    AKM_CLAUDE_PROJECTS_DIR: dirs.empty,
    AKM_CLAUDE_PLUGINS_DIR: dirs.empty,
    AKM_OPENCODE_CACHE_DIR: dirs.empty,
    CODEX_HOME: dirs.empty,
    TZ: "UTC",
  });
  return dirs.stash;
}

/** No connections, no embeddings and no probes: nothing leaves the machine. */
export function writeConfig(stashDir: string): void {
  const config = {
    configVersion: "0.9.0",
    bundles: { stash: { path: stashDir, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
    semanticSearchMode: "off",
  };
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}
