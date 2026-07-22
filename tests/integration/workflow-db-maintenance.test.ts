// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createMigrationBackup, restoreMigrationBackup } from "../../src/core/migration-backup";
import { getConfigPath, getStateDbPathInDataDir } from "../../src/core/paths";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { pollUntil } from "./_helpers/workflow-crossproc";

const HANDLE_WORKER = path.join(import.meta.dir, "_helpers/workflow-db-handle-worker.ts");

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  fs.writeFileSync(getConfigPath(), '{"configVersion":"0.8.0"}\n', { mode: 0o600 });
  createMigrationBackup();
});

afterEach(() => storage.cleanup());

// Chunk-8 WI-8.3: the workflow tables now live in state.db (workflow.db is
// deleted at cutover), so a canonical workflow-runs handle — opened directly via
// openStateDatabase or through withWorkflowRunsRepo — registers the "state-db"
// maintenance activity. The restore-cannot-overlap-a-live-handle invariant is
// unchanged; only the artifact (and activity name) moved.
describe("state.db workflow-tables maintenance activity", () => {
  for (const mode of ["direct", "repository"] as const) {
    test(`restore cannot overlap a canonical ${mode} handle in another process`, async () => {
      const ready = path.join(storage.root, `${mode}.ready`);
      const release = path.join(storage.root, `${mode}.release`);
      const child = spawn("bun", [HANDLE_WORKER, mode, ready, release], {
        env: process.env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const exitPromise = new Promise<number | null>((resolve) => child.once("exit", resolve));
      let exitCode: number | null;
      try {
        await pollUntil(() => fs.existsSync(ready), { label: `${mode} state-db handle open` });
        expect(() => restoreMigrationBackup(true)).toThrow(/maintenance-activities.*state-db/);
        expect(fs.existsSync(getStateDbPathInDataDir())).toBe(true);
      } finally {
        fs.writeFileSync(release, "release");
        exitCode = await exitPromise;
      }
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      restoreMigrationBackup(true);
      expect(fs.existsSync(getStateDbPathInDataDir())).toBe(false);
    });
  }
});
