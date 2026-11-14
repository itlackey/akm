// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Every `--skip-if-locked` command, run through the CLI while another live process holds its lock, returns promptly
 * with exit 0 and a skipped result instead of waiting for the holder.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../src/core/config/config";
import { getIndexRebuildLockPath, getStashLocksDir } from "../../src/core/paths";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { runCliCapture } from "../_helpers/cli";
import { withTestImproveLlm } from "../_helpers/improve-config";
import { spawnLiveHolder, stopLiveHolders } from "../_helpers/live-holder";
import {
  type IsolatedAkmStorage,
  withDefaultBundle,
  withIsolatedAkmStorage,
  writeWorkflowTestConfig,
} from "../_helpers/sandbox";
import { plantRunLock } from "../_helpers/workflow";

const WITHIN_MS = 5_000;

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  stopLiveHolders();
  storage.cleanup();
});

function plantLock(lockPath: string): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, spawnLiveHolder().payload(), "utf8");
}

async function skipped(args: string[]): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const result = await runCliCapture([...args, "--skip-if-locked", "--format=json"]);
  expect(Date.now() - startedAt).toBeLessThan(WITHIN_MS);
  expect(result.code).toBe(0);
  const envelope = JSON.parse(result.stdout) as { ok: boolean; skipped?: Record<string, unknown> };
  expect(envelope.ok).toBe(true);
  expect(envelope.skipped).toBeDefined();
  return envelope.skipped as Record<string, unknown>;
}

function addFilesystemBundle(): string {
  const extra = path.join(storage.root, "extra-bundle");
  fs.mkdirSync(path.join(extra, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(extra, "knowledge", "extra.md"), "# Extra\n");
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: true }, extra: { path: extra } },
    defaultBundle: "stash",
  });
  return "extra";
}

describe("--skip-if-locked with a live holder", () => {
  test("index", async () => {
    saveConfig(withDefaultBundle({ semanticSearchMode: "off" }, storage.stashDir));
    plantLock(getIndexRebuildLockPath());
    expect(await skipped(["index"])).toMatchObject({ reason: "lock-held" });
  });

  test("bundle update --all", async () => {
    addFilesystemBundle();
    plantLock(getIndexRebuildLockPath());
    expect(await skipped(["bundle", "update", "--all"])).toMatchObject({ reason: "lock-held" });
  });

  test("bundle update <bundle>", async () => {
    const name = addFilesystemBundle();
    plantLock(getIndexRebuildLockPath());
    expect(await skipped(["bundle", "update", name])).toMatchObject({ reason: "lock-held" });
  });

  test("improve", async () => {
    saveConfig(withDefaultBundle(withTestImproveLlm({ semanticSearchMode: "off" }), storage.stashDir));
    plantLock(path.join(getStashLocksDir(storage.stashDir), "improve.lock"));
    expect(await skipped(["improve", "--json-to-stdout"])).toMatchObject({ reason: "lock-held" });
  });

  test("workflow run", async () => {
    writeWorkflowTestConfig();
    const file = path.join(storage.stashDir, "workflows", "held.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      ["---", "type: workflow", "steps:", "  - id: only-step", "---", "", "## only-step", "", "Do the thing.", ""].join(
        "\n",
      ),
      "utf8",
    );
    const started = await startWorkflowRun("workflows/held", {});
    plantRunLock(started.run.id);
    expect(await skipped(["workflow", "run", started.run.id])).toMatchObject({ reason: "lock-held" });
  });
});
