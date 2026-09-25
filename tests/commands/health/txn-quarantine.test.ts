// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `txn-quarantine` health advisory must fire when `$DATA/txn-quarantine`
 * holds at least one quarantined transaction (src/core/fs-txn.ts's
 * `recoverTxnsForRoot`) and stay silent when the dir is missing or empty.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectTxnQuarantineAdvisory } from "../../../src/commands/health/txn-quarantine";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function seedQuarantinedTxn(dataDir: string, ns: string, id: string): void {
  const dir = path.join(dataDir, "txn-quarantine", ns, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "journal.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "reason.json"), "{}\n");
}

describe("collectTxnQuarantineAdvisory", () => {
  test("returns undefined when the data dir does not exist", () => {
    expect(collectTxnQuarantineAdvisory(path.join(os.tmpdir(), "akm-txn-quarantine-does-not-exist"))).toBeUndefined();
  });

  test("returns undefined when the quarantine dir does not exist", () => {
    const dataDir = makeTempDir("akm-txnq-none-");
    fs.mkdirSync(path.join(dataDir, "txn"), { recursive: true });
    expect(collectTxnQuarantineAdvisory(dataDir)).toBeUndefined();
  });

  test("returns undefined for an empty quarantine dir", () => {
    const dataDir = makeTempDir("akm-txnq-empty-");
    fs.mkdirSync(path.join(dataDir, "txn-quarantine"), { recursive: true });
    expect(collectTxnQuarantineAdvisory(dataDir)).toBeUndefined();
  });

  test("warns naming the count and the path for a non-empty quarantine dir", () => {
    const dataDir = makeTempDir("akm-txnq-nonempty-");
    seedQuarantinedTxn(dataDir, "root-ns-1", "txn-a");
    seedQuarantinedTxn(dataDir, "root-ns-1", "txn-b");
    seedQuarantinedTxn(dataDir, "root-ns-2", "txn-c");

    const advisory = collectTxnQuarantineAdvisory(dataDir);
    expect(advisory?.name).toBe("txn-quarantine");
    expect(advisory?.status).toBe("warn");
    expect(advisory?.message).toContain("3 transaction journal(s)");
    expect(advisory?.message).toContain(path.join(dataDir, "txn-quarantine"));
    expect(advisory?.evidence?.count).toBe(3);
  });
});
