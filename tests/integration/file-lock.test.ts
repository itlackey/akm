// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

function readWorkerPid(resultPath: string): number {
  return (JSON.parse(fs.readFileSync(resultPath, "utf8")) as { pid: number }).pid;
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

  test("quarantine and acquisition are mutually exclusive across processes", async () => {
    const lock = path.join(dir, "serialized-quarantine.lock");
    fs.writeFileSync(lock, "2147480000");
    const holderReady = path.join(dir, "holder.ready");
    const holderGate = path.join(dir, "holder.go");
    const holderResult = path.join(dir, "holder.result");
    const holder = spawn("bun", [INTERLEAVING_WORKER, "hold-reclaim", lock, holderReady, holderGate, holderResult], {
      stdio: "inherit",
    });
    await waitForFile(holderReady);

    const contenderReady = path.join(dir, "contender.ready");
    const contenderResult = path.join(dir, "contender.result");
    const contenderPayload = JSON.stringify({ pid: process.pid, owner: "third-contender" });
    const contender = spawn(
      "bun",
      [
        INTERLEAVING_WORKER,
        "acquire",
        lock,
        contenderReady,
        path.join(dir, "unused"),
        contenderResult,
        contenderPayload,
      ],
      { stdio: "inherit" },
    );
    await waitForFile(contenderReady);
    expect(fs.existsSync(contenderResult)).toBe(false);

    fs.writeFileSync(holderGate, "go");
    await Promise.all([waitForExit(holder), waitForExit(contender)]);
    expect(readWorkerResult(holderResult)).toBe(true);
    expect(readWorkerResult(contenderResult)).toBe(true);
    expect(fs.readFileSync(lock, "utf8")).toBe(contenderPayload);
    expect(tryAcquireLockSync(lock, "2147480002")).toBeUndefined();
  });

  test("a crashed operation-mutex holder cannot leave a stale guard", async () => {
    const lock = path.join(dir, "crashed-operation.lock");
    fs.writeFileSync(lock, "2147480000");
    const ready = path.join(dir, "crash.ready");
    const holder = spawn(
      "bun",
      [INTERLEAVING_WORKER, "hold-reclaim", lock, ready, path.join(dir, "never"), path.join(dir, "never.result")],
      { stdio: "inherit" },
    );
    await waitForFile(ready);
    holder.kill("SIGKILL");
    await new Promise<void>((resolve) => holder.once("exit", () => resolve()));

    expect(tryAcquireLockSync(lock, JSON.stringify({ pid: process.pid, owner: "after-crash" }))).toBeDefined();
    expect(fs.readFileSync(lock, "utf8")).toContain("after-crash");
  });
});

describe("improve lock stale-holder lifecycle", () => {
  let dir: string;
  let cleanup: Cleanup;
  beforeEach(() => {
    const r = sandboxXdgDataHome();
    dir = r.dir;
    cleanup = r.cleanup;
  });
  afterEach(() => cleanup());

  test("an old holder's final release cannot delete its reclaimed successor", async () => {
    const lock = path.join(dir, "improve.lock");
    const oldReady = path.join(dir, "old.ready");
    const oldGate = path.join(dir, "old.go");
    const oldResult = path.join(dir, "old.result");
    const successorReady = path.join(dir, "successor.ready");
    const successorGate = path.join(dir, "successor.go");
    const successorResult = path.join(dir, "successor.result");
    const thirdReady = path.join(dir, "third.ready");
    const thirdResult = path.join(dir, "third.result");
    const children: ChildProcess[] = [];

    try {
      const oldHolder = spawn(
        "bun",
        [INTERLEAVING_WORKER, "process-holder", lock, oldReady, oldGate, oldResult, "1000"],
        { stdio: "inherit" },
      );
      children.push(oldHolder);
      await waitForFile(oldReady);
      expect(readWorkerResult(oldResult)).toBe(true);

      const staleTime = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, staleTime, staleTime);

      const successor = spawn(
        "bun",
        [INTERLEAVING_WORKER, "process-holder", lock, successorReady, successorGate, successorResult, "1000"],
        { stdio: "inherit" },
      );
      children.push(successor);
      await waitForFile(successorReady);
      expect(readWorkerResult(successorResult)).toBe(true);
      const successorContent = fs.readFileSync(lock, "utf8");

      fs.writeFileSync(oldGate, "release");
      await waitForExit(oldHolder);
      expect(fs.readFileSync(lock, "utf8")).toBe(successorContent);
      const successorProbe = probeLock(lock, { staleAfterMs: 60_000 });
      expect(successorProbe.state).toBe("held");
      if (successorProbe.state === "held") {
        expect(successorProbe.holderPid).toBe(readWorkerPid(successorResult));
      }

      const third = spawn(
        "bun",
        [INTERLEAVING_WORKER, "process-attempt", lock, thirdReady, path.join(dir, "unused"), thirdResult, "60000"],
        { stdio: "inherit" },
      );
      children.push(third);
      await waitForFile(thirdReady);
      await waitForExit(third);
      expect(readWorkerResult(thirdResult)).toBe(false);
      expect(fs.readFileSync(lock, "utf8")).toBe(successorContent);

      fs.writeFileSync(successorGate, "release");
      await waitForExit(successor);
    } finally {
      if (!fs.existsSync(oldGate)) fs.writeFileSync(oldGate, "release");
      if (!fs.existsSync(successorGate)) fs.writeFileSync(successorGate, "release");
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }
  }, 20_000);
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
