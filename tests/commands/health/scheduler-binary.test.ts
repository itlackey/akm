// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `scheduler-binary` advisory for `akm health` (#953). Injects the scheduler
 * backend and the `--version` runner so no real crontab/launchd/schtasks
 * inspection or process spawn ever happens — mirrors
 * `tests/commands/health/version-drift.test.ts`'s injected-seam pattern.
 */

import { describe, expect, test } from "bun:test";
import { collectSchedulerBinaryAdvisory } from "../../../src/commands/health/scheduler-binary";

const DEFAULT_ENV = { HOME: "/home/nobody" };

function fakeBackend(launcher: string[]) {
  return {
    name: "cron" as const,
    apply: () => {},
    inspect: () => ({ entry: { launcher }, legacy: [] }),
  };
}

describe("collectSchedulerBinaryAdvisory (#953)", () => {
  test("not probed: unknown, never inspects the scheduler", async () => {
    let listed = false;
    const result = await collectSchedulerBinaryAdvisory(false, {
      cliVersion: "0.10.0",
      env: DEFAULT_ENV,
      backend: {
        name: "cron",
        apply: () => {},
        inspect: () => {
          listed = true;
          return { legacy: [] };
        },
      },
    });
    expect(listed).toBe(false);
    expect(result.name).toBe("scheduler-binary");
    expect(result.status).toBe("unknown");
    expect(result.message.toLowerCase()).toContain("not probed");
  });

  test("no scheduler entry installed: unknown", async () => {
    const result = await collectSchedulerBinaryAdvisory(true, {
      cliVersion: "0.10.0",
      env: DEFAULT_ENV,
      backend: { ...fakeBackend([]), inspect: () => ({ legacy: [] }) },
    });
    expect(result.status).toBe("unknown");
    expect(result.message.toLowerCase()).toContain("no scheduler entry");
  });

  test("matching versions pass", async () => {
    const result = await collectSchedulerBinaryAdvisory(true, {
      cliVersion: "0.10.0",
      env: DEFAULT_ENV,
      backend: fakeBackend(["/usr/bin/node", "/opt/akm/dist/akm"]),
      spawnSync: (() => ({ status: 0, stdout: "0.10.0\n", stderr: "" })) as never,
    });
    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({ scheduledVersion: "0.10.0", cliVersion: "0.10.0" });
  });

  test("mismatched versions warn, naming both versions and the remedy", async () => {
    const result = await collectSchedulerBinaryAdvisory(true, {
      cliVersion: "0.10.0",
      env: DEFAULT_ENV,
      backend: fakeBackend(["/usr/bin/node", "/opt/akm/dist/akm"]),
      spawnSync: (() => ({ status: 0, stdout: "0.9.32\n", stderr: "" })) as never,
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("0.9.32");
    expect(result.message).toContain("0.10.0");
    expect(result.message).toContain("akm task sync --rebind");
    expect(result.evidence).toMatchObject({ scheduledVersion: "0.9.32", cliVersion: "0.10.0" });
  });

  test("the recorded binary cannot be executed: unknown", async () => {
    const result = await collectSchedulerBinaryAdvisory(true, {
      cliVersion: "0.10.0",
      env: DEFAULT_ENV,
      backend: fakeBackend(["/usr/bin/node", "/opt/akm/dist/akm"]),
      spawnSync: () => {
        throw new Error("ENOENT");
      },
    });
    expect(result.status).toBe("unknown");
    expect(result.message.toLowerCase()).toContain("could not");
  });

  test("backend inspection failure degrades to unknown, never a false warn", async () => {
    const result = await collectSchedulerBinaryAdvisory(true, {
      cliVersion: "0.10.0",
      env: DEFAULT_ENV,
      backend: {
        name: "cron",
        apply: () => {},
        inspect: () => {
          throw new Error("crontab not found");
        },
      },
    });
    expect(result.status).toBe("unknown");
    expect(result.message).toContain("could not be inspected");
  });

  // A host with no scheduler binary runs no scheduled task, so the row says that instead of reading as a fault (F22).
  test("a missing scheduler binary is reported as no scheduler on this host", async () => {
    const result = await collectSchedulerBinaryAdvisory(true, {
      cliVersion: "0.9.15",
      env: DEFAULT_ENV,
      backend: {
        name: "cron",
        apply: () => {},
        inspect: () => {
          throw new Error("crontab -l failed: the `crontab` binary was not found on PATH");
        },
      },
    });
    expect(result.status).toBe("unknown");
    expect(result.message).toContain("No scheduler is available on this host");
    expect(result.message).toContain("crontab");
  });

  test("an installation that moves its locations does not own the entry: unknown, never inspected", async () => {
    let inspected = false;
    const result = await collectSchedulerBinaryAdvisory(true, {
      cliVersion: "0.10.0",
      env: { ...DEFAULT_ENV, XDG_STATE_HOME: "/srv/state" },
      backend: {
        name: "cron",
        apply: () => {},
        inspect: () => {
          inspected = true;
          return { legacy: [] };
        },
      },
    });
    expect(inspected).toBe(false);
    expect(result.status).toBe("unknown");
    expect(result.message).toContain("does not own");
  });
});
