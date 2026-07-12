// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { probeLock, reclaimStaleLock, tryAcquireLockSync } from "../../../src/core/file-lock";

const [mode, lockPath, readyPath, gatePath, resultPath, payload = String(process.pid)] = process.argv.slice(2);

function waitForGate(): void {
  while (!fs.existsSync(gatePath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

function writeResult(value: boolean): void {
  fs.writeFileSync(resultPath, JSON.stringify({ value, pid: process.pid }));
}

if (mode === "acquire") {
  fs.writeFileSync(readyPath, "ready");
  writeResult(tryAcquireLockSync(lockPath, payload));
} else {
  const probe = probeLock(lockPath);
  if (probe.state !== "stale") throw new Error(`Expected stale lock, got ${probe.state}.`);
  if (mode === "probe-reclaim") {
    fs.writeFileSync(readyPath, "ready");
    waitForGate();
    writeResult(reclaimStaleLock(lockPath, probe));
  } else if (mode === "hold-reclaim") {
    writeResult(
      reclaimStaleLock(lockPath, probe, {
        afterQuarantineVerified() {
          fs.writeFileSync(readyPath, "ready");
          waitForGate();
        },
      }),
    );
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }
}
