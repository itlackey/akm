// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { probeLock, reclaimStaleLock, releaseLock, tryAcquireLockSync } from "../../src/core/file-lock";
import { type Cleanup, sandboxXdgDataHome } from "../_helpers/sandbox";

const FILE_LOCK_MODULE = path.resolve(import.meta.dir, "../../src/core/file-lock.ts");
const INTERLEAVING_WORKER = path.resolve(import.meta.dir, "_helpers/file-lock-interleaving-worker.ts");

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`worker exited with code ${child.exitCode}`));
  }
  if (child.signalCode !== null) return Promise.reject(new Error(`worker exited with signal ${child.signalCode}`));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`worker exited with code ${code}, signal ${signal}`));
    });
  });
}

function readWorkerResult(resultPath: string): boolean {
  return (JSON.parse(fs.readFileSync(resultPath, "utf8")) as { value: boolean }).value;
}

describe("releaseLock", () => {
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
    const ownership = tryAcquireLockSync(lock, JSON.stringify({ pid: process.pid, startedAt: "t" }));
    expect(ownership).toBeDefined();
    if (!ownership) throw new Error("expected lock ownership");
    releaseLock(ownership);
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("releases a lock owned by this pid (bare-pid sentinel)", () => {
    const lock = path.join(dir, "bare.lock");
    const ownership = tryAcquireLockSync(lock, String(process.pid));
    expect(ownership).toBeDefined();
    if (!ownership) throw new Error("expected lock ownership");
    releaseLock(ownership);
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("leaves a same-content replacement lock intact", () => {
    const lock = path.join(dir, "improve.lock");
    const payload = JSON.stringify({ pid: process.pid, startedAt: "same" });
    const ownership = tryAcquireLockSync(lock, payload);
    expect(ownership).toBeDefined();
    if (!ownership) throw new Error("expected lock ownership");
    fs.rmSync(lock);
    fs.writeFileSync(lock, payload);

    releaseLock(ownership);
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readFileSync(lock, "utf8")).toBe(payload);
  });

  test("is idempotent after the owned lock is absent", () => {
    const ownership = tryAcquireLockSync(path.join(dir, "idempotent.lock"), String(process.pid));
    if (!ownership) throw new Error("expected lock ownership");
    releaseLock(ownership);
    expect(() => releaseLock(ownership)).not.toThrow();
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

  test("a stale probe cannot displace a newer owner while a third process contends", async () => {
    const lock = path.join(dir, "newer-owner.lock");
    fs.writeFileSync(lock, "2147480000");
    const reclaimReady = path.join(dir, "reclaim.ready");
    const reclaimGate = path.join(dir, "reclaim.go");
    const reclaimResult = path.join(dir, "reclaim.result");
    const reclaimer = spawn(
      "bun",
      [INTERLEAVING_WORKER, "probe-reclaim", lock, reclaimReady, reclaimGate, reclaimResult],
      {
        stdio: "inherit",
      },
    );
    await waitForFile(reclaimReady);

    const stale = probeLock(lock);
    expect(stale.state).toBe("stale");
    if (stale.state !== "stale") throw new Error("expected stale lock");
    expect(reclaimStaleLock(lock, stale)).toBe(true);
    const newerPayload = JSON.stringify({ pid: process.pid, owner: "newer" });
    expect(tryAcquireLockSync(lock, newerPayload)).toBeDefined();

    const thirdReady = path.join(dir, "third.ready");
    const thirdResult = path.join(dir, "third.result");
    const third = spawn(
      "bun",
      [INTERLEAVING_WORKER, "acquire", lock, thirdReady, path.join(dir, "unused"), thirdResult, "2147480001"],
      { stdio: "inherit" },
    );
    await waitForFile(thirdReady);
    fs.writeFileSync(reclaimGate, "go");
    await Promise.all([waitForExit(reclaimer), waitForExit(third)]);

    expect(readWorkerResult(reclaimResult)).toBe(false);
    expect(readWorkerResult(thirdResult)).toBe(false);
    expect(fs.readFileSync(lock, "utf8")).toBe(newerPayload);
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
        `import { releaseLock, tryAcquireLockSync } from ${JSON.stringify(FILE_LOCK_MODULE)};`,
        `const lock = process.argv[2];`,
        `const ownership = tryAcquireLockSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));`,
        `if (!ownership) throw new Error("failed to acquire lock");`,
        `process.on("exit", () => releaseLock(ownership));`,
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

describe("probeLock: launcherPid (#956)", () => {
  let dir: string;
  let cleanup: Cleanup;
  beforeEach(() => {
    const r = sandboxXdgDataHome();
    dir = r.dir;
    cleanup = r.cleanup;
  });
  afterEach(() => cleanup());

  test("a 'held' probe exposes the holder's launcherPid when the payload recorded one", () => {
    const lock = path.join(dir, "index-rebuild.lock");
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, launcherPid: 4240, startedAt: new Date().toISOString() }),
      "utf8",
    );

    const probe = probeLock(lock);
    expect(probe.state).toBe("held");
    if (probe.state === "held") {
      expect(probe.holderPid).toBe(process.pid);
      expect(probe.launcherPid).toBe(4240);
    }
  });

  test("a 'held' probe has no launcherPid when the payload carries none (bare-pid or JSON without it)", () => {
    const bareLock = path.join(dir, "bare.lock");
    fs.writeFileSync(bareLock, String(process.pid), "utf8");
    const bareProbe = probeLock(bareLock);
    expect(bareProbe.state).toBe("held");
    if (bareProbe.state === "held") expect(bareProbe.launcherPid).toBeUndefined();

    const jsonLock = path.join(dir, "json-no-launcher.lock");
    fs.writeFileSync(jsonLock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
    const jsonProbe = probeLock(jsonLock);
    expect(jsonProbe.state).toBe("held");
    if (jsonProbe.state === "held") expect(jsonProbe.launcherPid).toBeUndefined();
  });

  test("a 'stale' probe (pid dead) still exposes the recorded launcherPid", () => {
    const lock = path.join(dir, "stale.lock");
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: 999_999, launcherPid: 4240, startedAt: new Date(0).toISOString() }),
      "utf8",
    );

    const probe = probeLock(lock);
    expect(probe.state).toBe("stale");
    if (probe.state === "stale") {
      expect(probe.reason).toBe("pid_dead");
      expect(probe.launcherPid).toBe(4240);
    }
  });
});

// A lock must carry its owner's payload from the moment it exists. It used to be created empty (`wx`)
// and filled in afterwards; a contender probing in that gap read no pid, called the live lock stale
// (`invalid_pid`) and reclaimed it, so two `akm config set` processes wrote at once and one was lost.
describe("tryAcquireLockSync: no empty window", () => {
  let dir: string;
  let cleanup: Cleanup;
  beforeEach(() => {
    const r = sandboxXdgDataHome();
    dir = r.dir;
    cleanup = r.cleanup;
  });
  afterEach(() => cleanup());

  test("a live holder's lock never probes as stale", async () => {
    const lock = path.join(dir, "busy.lock");
    const script = path.join(dir, "acquire-release.ts");
    fs.writeFileSync(
      script,
      [
        `import { createLockPayload, releaseLock, tryAcquireLockSync } from ${JSON.stringify(FILE_LOCK_MODULE)};`,
        `for (let i = 0; i < 2000; i++) {`,
        `  const ownership = tryAcquireLockSync(process.argv[2], createLockPayload());`,
        `  if (ownership) releaseLock(ownership);`,
        `}`,
      ].join("\n"),
      "utf8",
    );
    const child = spawn("bun", [script, lock], { stdio: ["ignore", "ignore", "inherit"] });
    const exited = waitForExit(child);
    const staleReasons: string[] = [];
    let probes = 0;
    while (child.exitCode === null && child.signalCode === null) {
      const probe = probeLock(lock);
      if (probe.state === "stale") staleReasons.push(probe.reason);
      // Yield now and then so the child's exit is observed.
      if (++probes % 200 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    await exited;
    expect(staleReasons).toEqual([]);
  }, 30_000);
});

describe("hard links unsupported (Azure Files SMB, #1505)", () => {
  let dir: string;
  let cleanup: Cleanup;
  let linkSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    const r = sandboxXdgDataHome();
    dir = r.dir;
    cleanup = r.cleanup;
    linkSpy = spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOTSUP: operation not supported on socket, link"), { code: "ENOTSUP" });
    });
  });
  afterEach(() => {
    linkSpy.mockRestore();
    cleanup();
  });

  test("acquires, excludes a second writer, and leaves no temp files", () => {
    const lock = path.join(dir, "config.json.lck");
    const first = tryAcquireLockSync(lock, JSON.stringify({ pid: process.pid, lockId: "a" }));
    expect(first).toBeDefined();
    expect(tryAcquireLockSync(lock, JSON.stringify({ pid: process.pid, lockId: "b" }))).toBeUndefined();
    expect(fs.readFileSync(lock, "utf8")).toContain('"a"');
    expect(fs.readdirSync(dir)).toEqual(["config.json.lck"]);
    if (first) releaseLock(first);
    expect(fs.existsSync(lock)).toBe(false);
    expect(tryAcquireLockSync(lock, String(process.pid))).toBeDefined();
  });

  test("EPERM from link also falls back", () => {
    linkSpy.mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    expect(tryAcquireLockSync(path.join(dir, "x.lck"), String(process.pid))).toBeDefined();
  });

  test("an unrelated link error still throws", () => {
    linkSpy.mockImplementation(() => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    });
    expect(() => tryAcquireLockSync(path.join(dir, "x.lck"), String(process.pid))).toThrow("EIO");
  });

  test("stale-owner takeover still works", () => {
    const lock = path.join(dir, "stale.lck");
    fs.writeFileSync(lock, "2147480000");
    const probe = probeLock(lock);
    expect(probe.state).toBe("stale");
    if (probe.state !== "stale") throw new Error("expected stale");
    expect(reclaimStaleLock(lock, probe)).toBe(true);
    expect(tryAcquireLockSync(lock, String(process.pid))).toBeDefined();
  });

  test("a contender does not reclaim a lock that is still being initialised, but does once it is old", () => {
    const lock = path.join(dir, "init.lck");
    fs.writeFileSync(lock, "");
    const probe = probeLock(lock);
    expect(probe.state).toBe("stale");
    if (probe.state !== "stale") throw new Error("expected stale");
    expect(reclaimStaleLock(lock, probe)).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);

    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const aged = probeLock(lock);
    if (aged.state !== "stale") throw new Error("expected stale");
    expect(reclaimStaleLock(lock, aged)).toBe(true);
  });

  test("old-owner release after replacement leaves the new owner's lock", () => {
    const lock = path.join(dir, "replaced.lck");
    const old = tryAcquireLockSync(lock, JSON.stringify({ pid: process.pid, lockId: "old" }));
    if (!old) throw new Error("expected lock");
    fs.rmSync(lock);
    const next = tryAcquireLockSync(lock, JSON.stringify({ pid: process.pid, lockId: "new" }));
    expect(next).toBeDefined();
    releaseLock(old);
    expect(fs.readFileSync(lock, "utf8")).toContain('"new"');
  });
});

describe("hard links unsupported: races (#1505 review)", () => {
  let dir: string;
  let cleanup: Cleanup;
  let linkSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    const r = sandboxXdgDataHome();
    dir = r.dir;
    cleanup = r.cleanup;
    linkSpy = spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOTSUP"), { code: "ENOTSUP" });
    });
  });
  afterEach(() => {
    linkSpy.mockRestore();
    cleanup();
  });

  test("a reclaim that moved aside a fresh owner restores it so the owner can still release", () => {
    const lock = path.join(dir, "race.lck");
    fs.writeFileSync(lock, "2147480000");
    const stale = probeLock(lock);
    if (stale.state !== "stale") throw new Error("expected stale");
    const realRename = fs.renameSync;
    let owner: ReturnType<typeof tryAcquireLockSync>;
    const renameSpy = spyOn(fs, "renameSync").mockImplementation(((from: string, to: string) => {
      // Between the reclaimer's verification and its rename, a fresh owner replaces the stale file.
      fs.rmSync(lock);
      owner = tryAcquireLockSync(lock, JSON.stringify({ pid: process.pid, lockId: "owner" }));
      renameSpy.mockImplementation(realRename);
      realRename(from, to);
    }) as typeof fs.renameSync);
    try {
      expect(reclaimStaleLock(lock, stale)).toBe(false);
    } finally {
      renameSpy.mockRestore();
    }
    if (!owner) throw new Error("expected owner");
    expect(fs.existsSync(lock)).toBe(true);
    releaseLock(owner);
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("an acquirer whose empty lock was taken over does not adopt the contender's lock", () => {
    const lock = path.join(dir, "adopt.lck");
    const realWrite = fs.writeSync;
    const writeSpy = spyOn(fs, "writeSync").mockImplementation(((_fd: number, data: string) => {
      // Between the O_EXCL create and the payload write the contender replaces the lock.
      fs.rmSync(lock);
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, lockId: "contender" }));
      writeSpy.mockImplementation(realWrite as never);
      return data.length;
    }) as never);
    try {
      expect(tryAcquireLockSync(lock, JSON.stringify({ pid: process.pid, lockId: "owner" }))).toBeUndefined();
    } finally {
      writeSpy.mockRestore();
    }
    expect(fs.readFileSync(lock, "utf8")).toContain("contender");
  });
});
