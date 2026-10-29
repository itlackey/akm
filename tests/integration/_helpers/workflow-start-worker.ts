// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { resetConfigCache } from "../../../src/core/config/config";
import { AkmError } from "../../../src/core/errors";
import type { Database } from "../../../src/storage/database";
import { WorkflowRunsRepository } from "../../../src/storage/repositories/workflow-runs-repository";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";

const marker = process.env.WORKFLOW_START_READY as string;
const release = process.env.WORKFLOW_START_RELEASE as string;
const resultPath = process.env.WORKFLOW_START_RESULT as string;
const target = process.env.WORKFLOW_START_TARGET as string;
let synchronized = false;

process.env.AKM_BUNDLE_DIR = process.env.WORKFLOW_START_STASH_DIR;
process.env.XDG_CONFIG_HOME = process.env.WORKFLOW_START_CONFIG_HOME;
process.env.XDG_DATA_HOME = process.env.WORKFLOW_START_DATA_HOME;
process.env.XDG_CACHE_HOME = process.env.WORKFLOW_START_CACHE_HOME;
process.env.XDG_STATE_HOME = process.env.WORKFLOW_START_STATE_HOME;
resetConfigCache();

function barrier(): void {
  if (synchronized) return;
  synchronized = true;
  fs.writeFileSync(marker, String(process.pid));
  while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}

const transaction = WorkflowRunsRepository.prototype.transaction;
WorkflowRunsRepository.prototype.transaction = function <T>(fn: () => T): T {
  barrier();
  return transaction.call(this, fn) as T;
};
const immediateTransaction = WorkflowRunsRepository.prototype.immediateTransaction;
WorkflowRunsRepository.prototype.immediateTransaction = function <T>(fn: (db: Database) => T): T {
  barrier();
  return immediateTransaction.call(this, fn) as T;
};

try {
  const started = await startWorkflowRun(target, {});
  fs.writeFileSync(resultPath, JSON.stringify({ ok: true, runId: started.run.id }));
} catch (error) {
  fs.writeFileSync(
    resultPath,
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof AkmError ? { code: error.code } : {}),
    }),
  );
}
