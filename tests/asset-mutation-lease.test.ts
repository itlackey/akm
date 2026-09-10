import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { isProcessAlive } from "../src/core/common";
import { getIndexWriterLockPath } from "../src/core/paths";
import { _setWarnSinkForTests } from "../src/core/warn";
import {
  _setAssetMutationLeaseSyncTimingForTests,
  acquireAssetMutationLease,
  probeAssetMutationLease,
  withAssetMutationLease,
  withAssetMutationLeaseSync,
} from "../src/indexer/index-writer-lock";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

/**
 * Plant an asset-mutation sentinel owned by a real, foreign, genuinely LIVE
 * pid (our parent process — always alive for the duration of this run and
 * never equal to `process.pid`), with its mtime backdated by `ageMs`.
 */
function plantLiveHolderLock(ageMs: number): string {
  const lockPath = getIndexWriterLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, String(process.ppid), "utf8");
  const backdated = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath, backdated, backdated);
  return lockPath;
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

describe("asset mutation lease", () => {
  test("supports nested same-context reentrancy and releases on the outermost close", async () => {
    await withAssetMutationLease("outer", async () => {
      await withAssetMutationLease("inner", async () => {
        const held = probeAssetMutationLease();
        expect(held.state).toBe("held");
        if (held.state === "held") expect(held.holderPid).toBe(process.pid);
      });
      expect(fs.existsSync(getIndexWriterLockPath())).toBe(true);
    });
    expect(fs.existsSync(getIndexWriterLockPath())).toBe(false);
  });

  test("wait mode acquires after another holder releases", async () => {
    const held = await acquireAssetMutationLease({ purpose: "held" });
    expect(held).toBeDefined();

    const waiter = acquireAssetMutationLease({ purpose: "waiter" });
    setTimeout(() => held?.release(), 50);

    const acquired = await waiter;
    expect(acquired).toBeDefined();
    const probe = probeAssetMutationLease();
    expect(probe.state).toBe("held");
    if (probe.state === "held") expect(probe.holderPid).toBe(process.pid);
    acquired?.release();
  });

  test("wait mode times out when another live holder does not release", async () => {
    const lockPath = getIndexWriterLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // Hold the lock with a real but foreign live PID — our parent process,
    // which is always alive for the duration of this run and never equal to
    // process.pid. probeLock() then classifies it "held" (not "stale"), so the
    // waiter keeps waiting until it times out. No subprocess spawn (banned in
    // unit scope) and portable across platforms.
    fs.writeFileSync(lockPath, String(process.ppid), "utf8");

    await expect(acquireAssetMutationLease({ purpose: "waiter", maxWaitMs: 20 })).rejects.toThrow(
      "timed out waiting for asset mutation lease",
    );
  });

  test("never reclaims a live holder's lease purely on age (#872: no age-based stale window)", async () => {
    // Regression for the opposite direction of the old #757 test: a live
    // holder — however old the sentinel's mtime — must NEVER be reclaimed by
    // an age clock. #872 removed the 12h stale-age window that could strand
    // (or, as here, silently double-grant) a lease out from under a still-live
    // holder purely because a clock elapsed.
    const lockPath = plantLiveHolderLock(24 * 60 * 60 * 1000);
    expect(isProcessAlive(process.ppid)).toBe(true);

    const before = probeAssetMutationLease();
    expect(before.state).toBe("held");
    if (before.state === "held") expect(before.holderPid).toBe(process.ppid);

    const lease = await acquireAssetMutationLease({ purpose: "no-reclaim", mode: "try" });
    expect(lease).toBeUndefined();

    const after = probeAssetMutationLease();
    expect(after.state).toBe("held");
    if (after.state === "held") expect(after.holderPid).toBe(process.ppid);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.ppid));
  });

  test("reclaims a lease whose holder is verifiably dead, regardless of age", async () => {
    const lockPath = getIndexWriterLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // A PID that (barring an extraordinary coincidence) does not correspond to
    // a live process on this machine.
    const deadPid = 999_999;
    fs.writeFileSync(lockPath, String(deadPid), "utf8");
    const recent = new Date();
    fs.utimesSync(lockPath, recent, recent);

    const before = probeAssetMutationLease();
    expect(before.state).toBe("stale");
    if (before.state === "stale") expect(before.reason).toBe("pid_dead");

    const lease = await acquireAssetMutationLease({ purpose: "dead-pid-reclaim", mode: "try" });
    expect(lease).toBeDefined();

    const after = probeAssetMutationLease();
    expect(after.state).toBe("held");
    if (after.state === "held") expect(after.holderPid).toBe(process.pid);

    lease?.release();
  });

  test("wait mode with maxWaitMs:0 still acquires an immediately-free lock", async () => {
    // Regression: the timeout must be checked *after* a real acquisition
    // attempt, not before — otherwise maxWaitMs:0 throws without ever trying,
    // even when the lock is free.
    const lease = await acquireAssetMutationLease({ purpose: "instant", maxWaitMs: 0 });
    expect(lease).toBeDefined();
    const probe = probeAssetMutationLease();
    expect(probe.state).toBe("held");
    if (probe.state === "held") expect(probe.holderPid).toBe(process.pid);
    lease?.release();
  });

  test("withAssetMutationLease holds the lock for the callback", async () => {
    await withAssetMutationLease("callback", async () => {
      const probe = probeAssetMutationLease();
      expect(probe.state).toBe("held");
      if (probe.state === "held") expect(probe.holderPid).toBe(process.pid);
    });
    expect(fs.existsSync(getIndexWriterLockPath())).toBe(false);
  });

  test("reentrancy is scoped to the owning async context, not the whole process", async () => {
    let releaseOuter!: () => void;
    let outerEntered!: () => void;
    const outerReady = new Promise<void>((resolve) => {
      outerEntered = resolve;
    });
    const outerGate = new Promise<void>((resolve) => {
      releaseOuter = resolve;
    });
    const outer = withAssetMutationLease("outer-context", async () => {
      outerEntered();
      await outerGate;
      await withAssetMutationLease("nested-context", async () => {});
    });
    await outerReady;

    let contenderEntered = false;
    const contender = withAssetMutationLease("independent-context", async () => {
      contenderEntered = true;
    });
    await Bun.sleep(30);
    expect(contenderEntered).toBe(false);

    releaseOuter();
    await Promise.all([outer, contender]);
    expect(contenderEntered).toBe(true);
  });

  describe("sync wait notices (#956)", () => {
    afterEach(() => {
      _setWarnSinkForTests(undefined);
      _setAssetMutationLeaseSyncTimingForTests(undefined);
    });

    test("emits a periodic notice naming the holder's purpose, pid, and elapsed time", () => {
      // A real, foreign, live pid (our parent process) so the loop actually
      // waits instead of reclaiming a dead holder on the first attempt.
      const lockPath = getIndexWriterLockPath();
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ purpose: "source-update", pid: process.ppid, startedAt: "2026-01-01T00:00:00.000Z" }),
        "utf8",
      );

      // Shrink the cadence/bound so the test observes at least one notice
      // without waiting the real 15s/10min.
      _setAssetMutationLeaseSyncTimingForTests({ maxWaitMs: 150, waitNoticeIntervalMs: 20 });

      const notices: string[] = [];
      _setWarnSinkForTests((level, args) => {
        if (level === "warn") notices.push(args.map(String).join(" "));
      });

      expect(() => withAssetMutationLeaseSync("waiter", () => {})).toThrow(
        "timed out waiting for asset mutation lease for waiter",
      );

      expect(notices.length).toBeGreaterThan(0);
      expect(
        notices.some((n) =>
          /^waiting for source-update \(pid \d+, started 2026-01-01T00:00:00\.000Z\) — \d+s$/.test(n),
        ),
      ).toBe(true);
    });

    test("emits no notice when the lease is free", () => {
      _setAssetMutationLeaseSyncTimingForTests({ maxWaitMs: 5_000, waitNoticeIntervalMs: 15_000 });
      const notices: string[] = [];
      _setWarnSinkForTests((level, args) => {
        if (level === "warn") notices.push(args.map(String).join(" "));
      });

      withAssetMutationLeaseSync("instant", () => {});

      expect(notices).toEqual([]);
    });
  });
});
