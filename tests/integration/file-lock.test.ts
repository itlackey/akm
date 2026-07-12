// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  probeLock,
  reclaimStaleLock,
  releaseLock,
  releaseLockIfOwned,
  tryAcquireLockSync,
} from "../../src/core/file-lock";
import { type Cleanup, sandboxXdgDataHome } from "../_helpers/sandbox";

const FILE_LOCK_MODULE = path.resolve(import.meta.dir, "../../src/core/file-lock.ts");

describe("releaseLockIfOwned", () => {
  let dir: string;
  let cleanup: Cleanup;
  beforeEach(() => {
    const r = sandboxXdgDataHome();
    dir = r.dir;
    cleanup = r.cleanup;
  });
  afterEach(() => cleanup());

  test("releases a lock owned by this pid (JSON envelope)", () => {
    const lock = path.join(dir, "improve.lock");
    expect(tryAcquireLockSync(lock, JSON.stringify({ pid: process.pid, startedAt: "t" }))).toBe(true);
    releaseLockIfOwned(lock, process.pid);
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("releases a lock owned by this pid (bare-pid sentinel)", () => {
    const lock = path.join(dir, "bare.lock");
    expect(tryAcquireLockSync(lock, String(process.pid))).toBe(true);
    releaseLockIfOwned(lock, process.pid);
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("LEAVES a lock owned by a different pid (no cross-run deletion)", () => {
    const lock = path.join(dir, "improve.lock");
    // A different live-looking owner; releaseLockIfOwned must not touch it.
    tryAcquireLockSync(lock, JSON.stringify({ pid: 2147480000, startedAt: "t" }));
    releaseLockIfOwned(lock, process.pid);
    expect(fs.existsSync(lock)).toBe(true);
    releaseLock(lock);
  });

  test("is a no-op on an absent lock", () => {
    expect(() => releaseLockIfOwned(path.join(dir, "missing.lock"), process.pid)).not.toThrow();
  });
});

describe("reclaimStaleLock", () => {
  let dir: string;
  let cleanup: Cleanup;
  beforeEach(() => {
    const r = sandboxXdgDataHome();
    dir = r.dir;
    cleanup = r.cleanup;
  });
  afterEach(() => cleanup());

  test("does not delete a replacement lock installed after the stale probe", () => {
    const lock = path.join(dir, "adversarial.lock");
    fs.writeFileSync(lock, "2147480000");
    const stale = probeLock(lock);
    expect(stale.state).toBe("stale");
    if (stale.state !== "stale") throw new Error("expected stale lock");

    fs.rmSync(lock);
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, owner: "replacement" }));

    expect(reclaimStaleLock(lock, stale)).toBe(false);
    expect(fs.readFileSync(lock, "utf8")).toContain("replacement");
  });

  test("does not delete a same-content replacement with a different file identity", () => {
    const lock = path.join(dir, "same-content-adversarial.lock");
    const payload = "2147480000";
    fs.writeFileSync(lock, payload);
    const stale = probeLock(lock);
    expect(stale.state).toBe("stale");
    if (stale.state !== "stale") throw new Error("expected stale lock");

    const replacement = `${lock}.replacement`;
    fs.writeFileSync(replacement, payload);
    fs.rmSync(lock);
    fs.renameSync(replacement, lock);

    expect(reclaimStaleLock(lock, stale)).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
  });

  test("a replacement acquired after quarantine verification survives stale cleanup", () => {
    const lock = path.join(dir, "post-verification-replacement.lock");
    fs.writeFileSync(lock, "2147480000");
    const stale = probeLock(lock);
    expect(stale.state).toBe("stale");
    if (stale.state !== "stale") throw new Error("expected stale lock");

    let replacementAcquired = false;
    expect(
      reclaimStaleLock(lock, stale, {
        afterQuarantineVerified: () => {
          replacementAcquired = tryAcquireLockSync(lock, JSON.stringify({ pid: process.pid, owner: "replacement" }));
        },
      }),
    ).toBe(true);

    expect(replacementAcquired).toBe(true);
    expect(fs.readFileSync(lock, "utf8")).toContain("replacement");
  });
});

describe("lock release on process.exit (SIGTERM-leak regression, #improve.lock)", () => {
  let dir: string;
  let cleanup: Cleanup;
  beforeEach(() => {
    const r = sandboxXdgDataHome();
    dir = r.dir;
    cleanup = r.cleanup;
  });
  afterEach(() => cleanup());

  // The improve signal handler (improve-cli.ts) calls process.exit() on
  // SIGTERM/SIGINT/SIGHUP, which does NOT run `finally` blocks — so the lock's
  // normal release never executes. It DOES fire 'exit' listeners, so improve.ts
  // releases the lock from one. This subprocess proves that guarantee end-to-end.
  test("process.exit() runs the 'exit' handler that releases the lock; finally is skipped", () => {
    const lock = path.join(dir, "improve.lock");
    const script = path.join(dir, "exit-release.ts");
    fs.writeFileSync(
      script,
      [
        `import { tryAcquireLockSync, releaseLockIfOwned } from ${JSON.stringify(FILE_LOCK_MODULE)};`,
        `const lock = process.argv[2];`,
        `tryAcquireLockSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));`,
        `process.on("exit", () => releaseLockIfOwned(lock, process.pid));`,
        `try {`,
        `  process.exit(143); // simulates the SIGTERM handler; the finally below is SKIPPED`,
        `} finally {`,
        `  // intentionally NOT reached — proves the lock release cannot rely on finally`,
        `  process.stderr.write("FINALLY_RAN\\n");`,
        `}`,
      ].join("\n"),
      "utf8",
    );

    const res = spawnSync("bun", [script, lock], { encoding: "utf8", timeout: 20_000 });
    expect(res.status).toBe(143);
    expect(res.stderr ?? "").not.toContain("FINALLY_RAN");
    // The lock is gone even though process.exit() skipped the finally.
    expect(fs.existsSync(lock)).toBe(false);
  });
});
