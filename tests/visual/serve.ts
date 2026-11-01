// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Serves `akm ui` over the seeded visual dataset on a fixed port, with the
 * clock frozen at FIXED_NOW (plan 8.7). Run by Playwright's `webServer`:
 * `bun tests/visual/serve.ts`.
 */

import { setSystemTime } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startUiServer } from "../../src/commands/ui/server";
import { akmIndex } from "../../src/indexer/indexer";
import { FIXED_NOW, VISUAL_PORT, VISUAL_TOKEN } from "./constants";
import { seedStash, seedVisualState } from "./seed";

setSystemTime(new Date(FIXED_NOW));

/** A fixed path, so no run-specific temp name can reach a screenshot. */
const ROOT = path.join(os.tmpdir(), "akm-visual");

function isolateEnvironment(): string {
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
  fs.mkdirSync(path.join(dirs.config, "akm"));
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
function writeConfig(stashDir: string): void {
  const config = {
    configVersion: "0.9.0",
    bundles: { stash: { path: stashDir, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
    semanticSearchMode: "off",
  };
  fs.writeFileSync(
    path.join(process.env.XDG_CONFIG_HOME as string, "akm", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

const stashDir = isolateEnvironment();
writeConfig(stashDir);
seedStash(stashDir);
await akmIndex({ stashDir, full: true });
seedVisualState(stashDir);

const server = await startUiServer({ port: VISUAL_PORT, token: VISUAL_TOKEN });
console.log(`akm ui (visual harness) listening on ${server.url}`);

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
