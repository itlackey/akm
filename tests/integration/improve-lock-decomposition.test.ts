import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { probeLock, releaseLock, tryAcquireLockSync } from "../../src/core/file-lock";
import { type Cleanup, withIsolatedAkmStorage } from "../_helpers/sandbox";

const TIMEOUT_MS = 10_000;

let cleanup: Cleanup = () => {};
let lockDir = "";

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  lockDir = path.join(storage.stashDir, ".akm");
  fs.mkdirSync(lockDir, { recursive: true });
  cleanup = storage.cleanup;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  lockDir = "";
});

describe("#607 lock decomposition — per-process locks", () => {
  test(
    "three independent locks can be acquired simultaneously",
    () => {
      const consolidateLock = path.join(lockDir, "consolidate.lock");
      const reflectDistillLock = path.join(lockDir, "reflect-distill.lock");
      const triageLock = path.join(lockDir, "triage.lock");

      const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

      const consolidateOwnership = tryAcquireLockSync(consolidateLock, payload);
      const reflectDistillOwnership = tryAcquireLockSync(reflectDistillLock, payload);
      const triageOwnership = tryAcquireLockSync(triageLock, payload);
      expect(consolidateOwnership).toBeDefined();
      expect(reflectDistillOwnership).toBeDefined();
      expect(triageOwnership).toBeDefined();
      if (!consolidateOwnership || !reflectDistillOwnership || !triageOwnership) {
        throw new Error("expected all independent locks to be acquired");
      }

      expect(fs.existsSync(consolidateLock)).toBe(true);
      expect(fs.existsSync(reflectDistillLock)).toBe(true);
      expect(fs.existsSync(triageLock)).toBe(true);

      releaseLock(consolidateOwnership);
      releaseLock(reflectDistillOwnership);
      releaseLock(triageOwnership);

      expect(fs.existsSync(consolidateLock)).toBe(false);
      expect(fs.existsSync(reflectDistillLock)).toBe(false);
      expect(fs.existsSync(triageLock)).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "same lock cannot be acquired twice (serializes correctly)",
    () => {
      const consolidateLock = path.join(lockDir, "consolidate.lock");
      const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

      const firstOwnership = tryAcquireLockSync(consolidateLock, payload);
      expect(firstOwnership).toBeDefined();
      expect(tryAcquireLockSync(consolidateLock, payload)).toBeUndefined();

      const probe = probeLock(consolidateLock, { staleAfterMs: 60 * 60 * 1000 });
      expect(probe.state).toBe("held");
      if (probe.state === "held") {
        expect(probe.holderPid).toBe(process.pid);
      }

      if (!firstOwnership) throw new Error("expected first lock acquisition");
      releaseLock(firstOwnership);
      const secondOwnership = tryAcquireLockSync(consolidateLock, payload);
      expect(secondOwnership).toBeDefined();
      if (!secondOwnership) throw new Error("expected second lock acquisition");
      releaseLock(secondOwnership);
    },
    TIMEOUT_MS,
  );

  test(
    "releasing one lock does not affect others",
    () => {
      const consolidateLock = path.join(lockDir, "consolidate.lock");
      const reflectDistillLock = path.join(lockDir, "reflect-distill.lock");
      const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

      const consolidateOwnership = tryAcquireLockSync(consolidateLock, payload);
      const reflectDistillOwnership = tryAcquireLockSync(reflectDistillLock, payload);
      expect(consolidateOwnership).toBeDefined();
      expect(reflectDistillOwnership).toBeDefined();
      if (!consolidateOwnership || !reflectDistillOwnership) throw new Error("expected both locks");

      releaseLock(consolidateOwnership);
      expect(fs.existsSync(consolidateLock)).toBe(false);
      expect(fs.existsSync(reflectDistillLock)).toBe(true);

      const probe = probeLock(reflectDistillLock, { staleAfterMs: 60 * 60 * 1000 });
      expect(probe.state).toBe("held");

      releaseLock(reflectDistillOwnership);
    },
    TIMEOUT_MS,
  );

  test(
    "stale detection works per-lock with different timeouts",
    () => {
      const consolidateLock = path.join(lockDir, "consolidate.lock");
      const triageLock = path.join(lockDir, "triage.lock");
      const payload = JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString() });

      fs.writeFileSync(consolidateLock, payload, "utf8");
      fs.writeFileSync(triageLock, payload, "utf8");

      const consolidateProbe = probeLock(consolidateLock, { staleAfterMs: 60 * 60 * 1000 });
      const triageProbe = probeLock(triageLock, { staleAfterMs: 30 * 60 * 1000 });

      expect(consolidateProbe.state).toBe("stale");
      if (consolidateProbe.state === "stale") {
        expect(consolidateProbe.reason).toBe("pid_dead");
      }
      expect(triageProbe.state).toBe("stale");
      if (triageProbe.state === "stale") {
        expect(triageProbe.reason).toBe("pid_dead");
      }
    },
    TIMEOUT_MS,
  );
});
