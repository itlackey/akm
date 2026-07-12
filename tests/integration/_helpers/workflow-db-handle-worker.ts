// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { openWorkflowDatabase } from "../../../src/workflows/db";

const [mode, readyPath, releasePath] = process.argv.slice(2);

function waitForRelease(): void {
  fs.writeFileSync(readyPath, "ready");
  while (!fs.existsSync(releasePath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

if (mode === "direct") {
  const db = openWorkflowDatabase();
  try {
    db.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get();
    waitForRelease();
  } finally {
    db.close();
  }
} else if (mode === "repository") {
  await withWorkflowRunsRepo((repo) => {
    repo.listRuns({ scopeKey: "restore-open-handle" });
    waitForRelease();
  });
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
