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

function fakeBackend(binding: string[]) {
  return {
    name: "cron" as const,
    install: () => {},
    uninstall: () => {},
    setEnabled: () => {},
    list: () => [{ id: "improve-nightly", binding, contextPath: "/ctx" }],
  };
}

describe("collectSchedulerBinaryAdvisory (#953)", () => {
  test("not probed: unknown, never inspects the scheduler", async () => {
    let listed = false;
    const result = await collectSchedulerBinaryAdvisory(false, {
      cliVersion: "0.9.15",
      backend: {
        name: "cron",
        install: () => {},
        uninstall: () => {},
        setEnabled: () => {},
        list: () => {
          listed = true;
          return [];
        },
      },
    });
    expect(listed).toBe(false);
    expect(result.name).toBe("scheduler-binary");
    expect(result.status).toBe("unknown");
    expect(result.message.toLowerCase()).toContain("not probed");
  });

  test("no scheduled task installed: unknown", async () => {
    const result = await collectSchedulerBinaryAdvisory(true, {
      cliVersion: "0.9.15",
      backend: { ...fakeBackend([]), list: () => [] },
    });
    expect(result.status).toBe("unknown");
    expect(result.message.toLowerCase()).toContain("no scheduled task");
  });

  test("matching versions pass", async () => {
    const result = await collectSchedulerBinaryAdvisory(true, {
      cliVersion: "0.9.15",
      backend: fakeBackend(["/usr/bin/node", "/opt/akm/dist/akm"]),
      spawnSync: (() => ({ status: 0, stdout: "0.9.15\n", stderr: "" })) as never,
    });
    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({ scheduledVersion: "0.9.15", cliVersion: "0.9.15" });
  });

  test("mismatched versions warn, naming both versions and the remedy", async () => {
    const result = await collectSchedulerBinaryAdvisory(true, {
      cliVersion: "0.9.15",
      backend: fakeBackend(["/usr/bin/node", "/opt/akm/dist/akm"]),
      spawnSync: (() => ({ status: 0, stdout: "0.9.14\n", stderr: "" })) as never,
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("0.9.14");
    expect(result.message).toContain("0.9.15");
    expect(result.message).toContain("akm task sync");
    expect(result.evidence).toMatchObject({ scheduledVersion: "0.9.14", cliVersion: "0.9.15" });
  });

  test("the recorded binary cannot be executed: unknown", async () => {
    const result = await collectSchedulerBinaryAdvisory(true, {
      cliVersion: "0.9.15",
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
      cliVersion: "0.9.15",
      backend: {
        name: "cron",
        install: () => {},
        uninstall: () => {},
        setEnabled: () => {},
        list: () => {
          throw new Error("crontab not found");
        },
      },
    });
    expect(result.status).toBe("unknown");
  });
});
