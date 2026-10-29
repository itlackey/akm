// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * itlackey/akm#832: `akmHealth()` must actually surface the `plugin-version`
 * advisory end-to-end (not just the standalone collector unit-tested in
 * `tests/integration/commands/health/plugin-staleness.test.ts`). Deliberately
 * exercises only the local, network-free path here — no `marketplaces/` dir
 * is written, so the "newest available" lookup (the one path that shells out
 * to `git ls-remote`) never fires and this stays a pure filesystem test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmHealth } from "../src/commands/health";
import type { HealthCheckResult } from "../src/commands/health/types";
import { mockClaudePluginList, selectClaudePlugin } from "./_helpers/claude-plugins";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  mockClaudePluginList();
});

afterEach(() => {
  storage.cleanup();
});

function findChecks(checks: HealthCheckResult[], name: string): HealthCheckResult[] {
  return checks.filter((c) => c.name === name);
}

function findCheck(checks: HealthCheckResult[], name: string): HealthCheckResult {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`expected an advisory named ${name}`);
  return found;
}

function installPlugin(pluginsRoot: string, version: string, versionRange: string): void {
  const pluginDir = path.join(pluginsRoot, "cache", "akm-plugins", "akm", version);
  selectClaudePlugin(pluginsRoot, [
    { id: "akm@akm-plugins", version, scope: "user", enabled: true, installPath: pluginDir },
  ]);
  fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "akm", version }));
  fs.mkdirSync(path.join(pluginDir, "shared"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "shared", "akm-version.ts"),
    `export const AKM_VERSION_RANGE = "${versionRange}"\n`,
  );
}

describe("plugin-version advisory wiring (itlackey/akm#832)", () => {
  test("no Claude plugin installed produces no plugin-version advisory", async () => {
    const result = await akmHealth({ since: "7d" });
    expect(findChecks(result.advisories, "plugin-version")).toEqual([]);
  });

  test("an installed plugin whose range rejects the running CLI is surfaced as a warn advisory", async () => {
    installPlugin(storage.claudePluginsDir, "0.9.1", "0.9.1");

    const result = await akmHealth({ since: "7d" });
    const advisory = findCheck(result.advisories, "plugin-version");

    expect(advisory.status).toBe("warn");
    expect(advisory.evidence?.admitted).toBe(false);
    expect(advisory.message).toContain("NOT ADMITTED");
    expect(result.status).toBe("warn");
  });
});
