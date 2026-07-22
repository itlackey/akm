// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression tests for the dangerous-env-key INSTALL gate (audit item C3).
 *
 * Background: the gate used to wrap `process.exit(1)` in a broad try/catch and
 * distinguish an intended exit from a real audit bug by string-matching
 * `err.message === "process.exit called"` — a TEST mock sentinel. In production
 * `process.exit` never throws, so the abort branch was test-only, and if the
 * sentinel string ever drifted the DANGEROUS_VAULT_KEY abort would silently
 * become fail-OPEN: an insecure stash would install.
 *
 * `auditInstalledStashForDangerousKeys` now returns a TYPED decision and the
 * caller performs `process.exit` outside any catch. These tests assert the
 * gate's fail-CLOSED behaviour WITHOUT relying on any sentinel string, so a
 * future change to (or removal of) that magic string cannot reopen the hole.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditInstalledStashForDangerousKeys } from "../../src/commands/sources/add-cli";

const tempDirs: string[] = [];

function makeStashWithEnv(content: string, name = ".env"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-install-gate-"));
  tempDirs.push(dir);
  const envDir = path.join(dir, "env");
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, name), content, { encoding: "utf8", mode: 0o600 });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("dangerous-key install gate (C3 fail-closed)", () => {
  test("non-TTY install with a dangerous key is BLOCKED (no --allow-insecure)", async () => {
    const stashRoot = makeStashWithEnv("LD_PRELOAD=/evil/lib.so\nSAFE=ok\n");

    const decision = await auditInstalledStashForDangerousKeys({
      installedStashRoot: stashRoot,
      ref: "evil/stash",
      allowDangerousKeys: false,
      // Use the stash root itself as the rollback target. Rollback is
      // best-effort inside the audit; even if it fails the decision must stay
      // blocked, which is exactly the fail-closed property under test.
      rollbackTarget: stashRoot,
      isTTY: false,
    });

    // Fail-CLOSED: a dangerous key found on a non-interactive install must block,
    // regardless of any sentinel/magic string.
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.exitCode).toBe(1);
    }
  });

  test("--allow-insecure lets a dangerous-key install proceed (not blocked)", async () => {
    const stashRoot = makeStashWithEnv("LD_PRELOAD=/evil/lib.so\n");

    const decision = await auditInstalledStashForDangerousKeys({
      installedStashRoot: stashRoot,
      ref: "evil/stash",
      allowDangerousKeys: true,
      rollbackTarget: stashRoot,
      isTTY: false,
    });

    expect(decision.blocked).toBe(false);
  });

  test("a stash with only safe keys is NOT blocked", async () => {
    const stashRoot = makeStashWithEnv("API_TOKEN=abc\nDB_URL=postgres://localhost/db\n");

    const decision = await auditInstalledStashForDangerousKeys({
      installedStashRoot: stashRoot,
      ref: "safe/stash",
      allowDangerousKeys: false,
      rollbackTarget: stashRoot,
      isTTY: false,
    });

    expect(decision.blocked).toBe(false);
  });

  test("a stash with no env/ dir is NOT blocked", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-install-gate-noenv-"));
    tempDirs.push(dir);

    const decision = await auditInstalledStashForDangerousKeys({
      installedStashRoot: dir,
      ref: "empty/stash",
      allowDangerousKeys: false,
      rollbackTarget: dir,
      isTTY: false,
    });

    expect(decision.blocked).toBe(false);
  });
});
