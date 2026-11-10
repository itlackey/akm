// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache, saveConfig } from "../src/core/config/config";
import { isFormatExemptCommand } from "../src/output/format-exempt";
import { runCliCapture } from "./_helpers/cli";
import { withIsolatedAkmStorage } from "./_helpers/sandbox";

function configureBundle(stashDir: string): void {
  saveConfig({
    semanticSearchMode: "off",
    defaultBundle: "local",
    bundles: {
      local: {
        path: stashDir,
        writable: true,
        components: { main: { root: ".", adapter: "akm", writable: true } },
      },
    },
    connections: { lab: { endpoint: "http://lab:8080/v1", models: { fast: "m" } } },
  });
  resetConfigCache();
}

/** A command still carrying the retired `engine:` key. */
function writeEngineCommand(stashDir: string): string {
  const file = path.join(stashDir, "commands", "review.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "---\nname: review\nakm:\n  engine: lab\n---\nReview it.\n", "utf8");
  return file;
}

test("migrate status/apply use the normal format pipeline", () => {
  expect(isFormatExemptCommand(["migrate", "status"])).toBe(false);
  expect(isFormatExemptCommand(["migrate", "apply"])).toBe(false);
});

test("status reports the combined plan without mutation", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    configureBundle(storage.stashDir);
    const file = writeEngineCommand(storage.stashDir);
    const before = fs.readFileSync(file);

    const status = await runCliCapture(["migrate", "status"]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      schemaVersion: 1,
      status: "ready",
      blockers: [],
      assetEngineKeys: { changed: 1, skipped: 0 },
    });
    expect(fs.readFileSync(file)).toEqual(before);
  } finally {
    storage.cleanup();
  }
});

test("apply rewrites the retired engine key under one backup", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    configureBundle(storage.stashDir);
    const file = writeEngineCommand(storage.stashDir);

    const applied = await runCliCapture(["migrate", "apply"]);
    expect(applied.code, applied.stderr).toBe(0);
    const result = JSON.parse(applied.stdout) as {
      status: string;
      assetEngineKeys: { applied: number; backupPath: string };
    };
    expect(result.status).toBe("current");
    expect(result.assetEngineKeys.applied).toBe(1);
    expect(fs.existsSync(result.assetEngineKeys.backupPath)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("connection: lab");
  } finally {
    storage.cleanup();
  }
});

test("text output summarizes the asset engine-key step", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    configureBundle(storage.stashDir);
    writeEngineCommand(storage.stashDir);
    const result = await runCliCapture(["migrate", "status", "--format", "text"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("ready");
    expect(result.stdout).toContain("asset engine keys: 1 change, 0 skipped");
    expect(result.stdout).not.toContain("config.json");
    expect(result.stdout).not.toContain("state.db");
  } finally {
    storage.cleanup();
  }
});
