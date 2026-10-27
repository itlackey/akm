// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: opens a real index and state.db.
//
// The 0.9 -> 0.10 guide tells a reader to run a sequence of commands on a 0.9
// install and what to see afterwards. The docs lint proves those commands
// exist; this proves they do what the guide says on a config as 0.9 wrote it:
// the dry run changes nothing, the apply moves the engines and the stored key,
// and the verification commands that need no network run.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getCacheDir, getConfigDir } from "../../src/core/paths";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { snapshotTree } from "../_helpers/snapshot-tree";

const GUIDE = fs.readFileSync(path.join(import.meta.dir, "..", "..", "docs", "migration", "v0.9-to-v0.10.md"), "utf8");

/** The command lines the guide shows in its code blocks, without their trailing comments. */
const GUIDE_COMMANDS = new Set(
  GUIDE.split("\n")
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line.startsWith("akm ")),
);

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  const configDir = getConfigDir();
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaultBundle: "stash",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      registries: [],
      engines: {
        cloud: {
          kind: "llm",
          endpoint: "https://cloud.test/v1/chat/completions",
          model: "big",
          apiKey: "sk-cloud-0.9",
        },
      },
      defaults: { llmEngine: "cloud" },
    }),
  );
});

afterEach(() => storage.cleanup());

/** Run a command the guide shows, after checking that it does. */
async function guideStep(line: string) {
  expect(GUIDE_COMMANDS.has(line)).toBe(true);
  return runCliCapture(line.split(" ").slice(1));
}

describe("the commands the 0.9 -> 0.10 guide tells a reader to run, on a config as 0.9 wrote it", () => {
  test("the dry run changes nothing, the apply moves engines and the key, and the status then reads current", async () => {
    const before = snapshotTree(getConfigDir());
    const dry = await guideStep("akm migrate apply --dry-run");
    expect(dry.code).toBe(0);
    expect(snapshotTree(getConfigDir())).toEqual(before);

    const applied = await guideStep("akm migrate apply");
    expect(applied.code).toBe(0);
    const config = JSON.parse(fs.readFileSync(path.join(getConfigDir(), "config.json"), "utf8"));
    expect(config).not.toHaveProperty("engines");
    expect(config).not.toHaveProperty("defaults");
    expect(config.connections).toHaveProperty("default");
    const credentials = fs.readFileSync(path.join(getConfigDir(), "credentials.json"), "utf8");
    expect(JSON.parse(credentials)).toEqual({
      connections: { default: { key: "sk-cloud-0.9", endpoint: "https://cloud.test/v1/chat/completions" } },
    });
    expect(fs.existsSync(path.join(getCacheDir(), "config-backups"))).toBe(true);

    const status = await guideStep("akm migrate status");
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ status: "current", ok: true });
  });

  test("the verification commands that need no network run, and health names the check the guide names", async () => {
    expect((await guideStep("akm migrate apply")).code).toBe(0);
    for (const line of [
      "akm task doctor",
      "akm improve --dry-run",
      "akm lint --type tasks",
      "akm lint --type workflows",
      "akm search --type task",
    ]) {
      const result = await guideStep(line);
      expect({ line, code: result.code, stderr: result.stderr }).toEqual({ line, code: 0, stderr: result.stderr });
    }
    // `akm health` exits 0 when ok and 4 on a warning (a connection that is not reachable is one).
    const health = await guideStep("akm health");
    expect([0, 4]).toContain(health.code);
    expect(health.stdout).toContain("connections-and-harnesses");
  });
});
