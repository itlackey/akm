import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getIndexWriterLockPath } from "../../src/core/paths";
import {
  acquireIndexWriterLease,
  probeIndexWriterLease,
  withIndexWriterLease,
} from "../../src/indexer/index-writer-lock";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

describe("index writer lease", () => {
  test("supports nested same-context reentrancy and releases on the outermost close", async () => {
    await withIndexWriterLease({ purpose: "outer" }, async () => {
      await withIndexWriterLease({ purpose: "inner" }, async () => {
        const held = probeIndexWriterLease();
        expect(held.state).toBe("held");
        if (held.state === "held") expect(held.holderPid).toBe(process.pid);
      });
      expect(fs.existsSync(getIndexWriterLockPath())).toBe(true);
    });
    expect(fs.existsSync(getIndexWriterLockPath())).toBe(false);
  });

  test("wait mode acquires after another holder releases", async () => {
    const held = await acquireIndexWriterLease({ purpose: "held" });
    expect(held).toBeDefined();

    const waiter = acquireIndexWriterLease({ purpose: "waiter" });
    setTimeout(() => held?.release(), 50);

    const acquired = await waiter;
    expect(acquired).toBeDefined();
    const probe = probeIndexWriterLease();
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

    await expect(acquireIndexWriterLease({ purpose: "waiter", maxWaitMs: 20 })).rejects.toThrow(
      "timed out waiting for index writer lease",
    );
  });

  test("wait mode with maxWaitMs:0 still acquires an immediately-free lock", async () => {
    // Regression: the timeout must be checked *after* a real acquisition
    // attempt, not before — otherwise maxWaitMs:0 throws without ever trying,
    // even when the lock is free.
    const lease = await acquireIndexWriterLease({ purpose: "instant", maxWaitMs: 0 });
    expect(lease).toBeDefined();
    const probe = probeIndexWriterLease();
    expect(probe.state).toBe("held");
    if (probe.state === "held") expect(probe.holderPid).toBe(process.pid);
    lease?.release();
  });

  test("withIndexWriterLease holds the lock for the callback", async () => {
    await withIndexWriterLease({ purpose: "callback" }, async () => {
      const probe = probeIndexWriterLease();
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
    const outer = withIndexWriterLease({ purpose: "outer-context" }, async () => {
      outerEntered();
      await outerGate;
      await withIndexWriterLease({ purpose: "nested-context" }, async () => {});
    });
    await outerReady;

    let contenderEntered = false;
    const contender = withIndexWriterLease({ purpose: "independent-context" }, async () => {
      contenderEntered = true;
    });
    await Bun.sleep(30);
    expect(contenderEntered).toBe(false);

    releaseOuter();
    await Promise.all([outer, contender]);
    expect(contenderEntered).toBe(true);
  });
});
