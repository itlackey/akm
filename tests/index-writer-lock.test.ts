import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { getIndexWriterLockPath } from "../src/core/paths";
import { acquireIndexWriterLease, probeIndexWriterLease, withIndexWriterLease } from "../src/indexer/index-writer-lock";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

describe("index writer lease", () => {
  test("supports same-process reentrancy and releases on the outermost close", async () => {
    const outer = await acquireIndexWriterLease({ purpose: "outer" });
    expect(outer).toBeDefined();
    const inner = await acquireIndexWriterLease({ purpose: "inner" });
    expect(inner).toBeDefined();

    const held = probeIndexWriterLease();
    expect(held.state).toBe("held");
    if (held.state === "held") expect(held.holderPid).toBe(process.pid);

    inner?.release();
    expect(fs.existsSync(getIndexWriterLockPath())).toBe(true);

    outer?.release();
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

  test("withIndexWriterLease holds the lock for the callback", async () => {
    await withIndexWriterLease({ purpose: "callback" }, async () => {
      const probe = probeIndexWriterLease();
      expect(probe.state).toBe("held");
      if (probe.state === "held") expect(probe.holderPid).toBe(process.pid);
    });
    expect(fs.existsSync(getIndexWriterLockPath())).toBe(false);
  });
});
