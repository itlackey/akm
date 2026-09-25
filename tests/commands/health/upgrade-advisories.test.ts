// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `version-reconcile` and `scheduler-grants` advisories for `akm health`
 *. Both are exercised with injected seams (a scratch
 * `version-reconcile.json`, a fake scheduler backend, and a fake `db` that
 * never opens real SQLite) — the `scheduled-startup-failures` advisory,
 * which needs a real `task_history` table, is covered separately under
 * `tests/integration/health/upgrade-advisories.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { HealthCheckResult } from "../../../src/commands/health/types";
import { collectUpgradeAdvisories } from "../../../src/commands/health/upgrade-advisories";
import { loadConfig } from "../../../src/core/config/config";
import { bundleSourceId } from "../../../src/core/config/config-sources";
import type { Database } from "../../../src/storage/database";
import type { SchedulerBackend } from "../../../src/tasks/backends/types";
import type { InstalledSchedulerBinding } from "../../../src/tasks/scheduler-binding";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    defaultBundle: "team",
    bundles: { team: { path: storage.stashDir, writable: true } },
  });
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(storage.stashDir, "tasks", "nightly.yml"), "schedule: '0 2 * * *'\n");
});

afterEach(() => storage.cleanup());

/** A `Database` that never touches real SQLite — `scheduled-startup-failures` sees no rows and passes trivially. */
const emptyDb = { prepare: () => ({ all: () => [] }) } as unknown as Database;

function findCheck(results: HealthCheckResult[], name: string): HealthCheckResult {
  const found = results.find((check) => check.name === name);
  if (!found) throw new Error(`expected an advisory named ${name}`);
  return found;
}

function fakeBackend(
  installed: InstalledSchedulerBinding[],
  overrides: Partial<SchedulerBackend> = {},
): SchedulerBackend {
  return {
    name: "cron",
    install: () => {},
    uninstall: () => {},
    setEnabled: () => {},
    list: () => installed,
    inspectBindings: () => ({ installed, artifacts: [] }),
    ...overrides,
  };
}

function binding(overrides: Partial<InstalledSchedulerBinding> & { id: string }): InstalledSchedulerBinding {
  return {
    enabled: true,
    binding: ["/usr/local/bin/akm"],
    contextPath: "/tmp/context.json",
    ...overrides,
  };
}

const SINCE = "2020-01-01T00:00:00.000Z";

describe("version-reconcile", () => {
  test("pass: stamp version matches the running version", async () => {
    fs.writeFileSync(path.join(storage.stateDir, "version-reconcile.json"), JSON.stringify({ version: "1.2.3" }));
    const results = await collectUpgradeAdvisories({
      db: emptyDb,
      since: SINCE,
      stateDir: storage.stateDir,
      cliVersion: "1.2.3",
      probe: false,
      backend: fakeBackend([]),
    });
    const check = findCheck(results, "version-reconcile");
    expect(check.status).toBe("pass");
  });

  test("warn: no stamp exists on this host yet", async () => {
    const results = await collectUpgradeAdvisories({
      db: emptyDb,
      since: SINCE,
      stateDir: storage.stateDir,
      cliVersion: "1.2.3",
      probe: false,
      backend: fakeBackend([]),
    });
    const check = findCheck(results, "version-reconcile");
    expect(check.status).toBe("warn");
    expect(check.message).toContain("akm migrate status");
  });

  test("warn: stamp names an older version than the one running", async () => {
    fs.writeFileSync(path.join(storage.stateDir, "version-reconcile.json"), JSON.stringify({ version: "1.2.2" }));
    const results = await collectUpgradeAdvisories({
      db: emptyDb,
      since: SINCE,
      stateDir: storage.stateDir,
      cliVersion: "1.2.3",
      probe: false,
      backend: fakeBackend([]),
    });
    const check = findCheck(results, "version-reconcile");
    expect(check.status).toBe("warn");
    expect(check.message).toContain("1.2.3");
  });

  test("warn: last reconciliation attempt was blocked, naming the blocker", async () => {
    fs.writeFileSync(
      path.join(storage.stateDir, "version-reconcile.json"),
      JSON.stringify({
        version: "1.2.2",
        lastAttemptAt: "2026-09-24T00:00:00.000Z",
        lastStatus: "blocked: 12 stale transaction journals",
      }),
    );
    const results = await collectUpgradeAdvisories({
      db: emptyDb,
      since: SINCE,
      stateDir: storage.stateDir,
      cliVersion: "1.2.3",
      probe: false,
      backend: fakeBackend([]),
    });
    const check = findCheck(results, "version-reconcile");
    expect(check.status).toBe("warn");
    expect(check.message).toContain("blocked: 12 stale transaction journals");
    expect(check.message).toContain("akm migrate status");
  });

  test("unknown: the stamp file exists but is not valid JSON", async () => {
    fs.writeFileSync(path.join(storage.stateDir, "version-reconcile.json"), "{not json");
    const results = await collectUpgradeAdvisories({
      db: emptyDb,
      since: SINCE,
      stateDir: storage.stateDir,
      cliVersion: "1.2.3",
      probe: false,
      backend: fakeBackend([]),
    });
    const check = findCheck(results, "version-reconcile");
    expect(check.status).toBe("unknown");
  });
});

describe("scheduler-grants", () => {
  test("unknown: not probed — the native scheduler is never inspected", async () => {
    let inspected = false;
    const results = await collectUpgradeAdvisories({
      db: emptyDb,
      since: SINCE,
      stateDir: storage.stateDir,
      cliVersion: "1.2.3",
      probe: false,
      backend: fakeBackend([], {
        inspectBindings: () => {
          inspected = true;
          return { installed: [], artifacts: [] };
        },
      }),
    });
    expect(inspected).toBe(false);
    const check = findCheck(results, "scheduler-grants");
    expect(check.status).toBe("unknown");
    expect(check.message.toLowerCase()).toContain("not probed");
  });

  test("pass: no installed scheduler rows", async () => {
    const results = await collectUpgradeAdvisories({
      db: emptyDb,
      since: SINCE,
      stateDir: storage.stateDir,
      cliVersion: "1.2.3",
      probe: true,
      backend: fakeBackend([]),
    });
    expect(findCheck(results, "scheduler-grants").status).toBe("pass");
  });

  test("pass: the installed row already has a host-local grant", async () => {
    writeSandboxConfig({
      defaultBundle: "team",
      bundles: { team: { path: storage.stashDir, writable: true } },
      scheduler: {
        enabled: [{ kind: "task", ref: "team//tasks/nightly", sourceId: bundleSourceId(loadConfig(), "team") }],
      },
    });
    const installed = [
      binding({ id: "nightly", invocation: ["task", "run", "nightly", "--bundle", "team", "--scheduled"] }),
    ];
    const results = await collectUpgradeAdvisories({
      db: emptyDb,
      since: SINCE,
      stateDir: storage.stateDir,
      cliVersion: "1.2.3",
      probe: true,
      backend: fakeBackend(installed),
    });
    expect(findCheck(results, "scheduler-grants").status).toBe("pass");
  });

  test("warn: an installed row with a backing file has no grant, naming the ref and the remedy", async () => {
    const installed = [
      binding({ id: "nightly", invocation: ["task", "run", "nightly", "--bundle", "team", "--scheduled"] }),
    ];
    const results = await collectUpgradeAdvisories({
      db: emptyDb,
      since: SINCE,
      stateDir: storage.stateDir,
      cliVersion: "1.2.3",
      probe: true,
      backend: fakeBackend(installed),
    });
    const check = findCheck(results, "scheduler-grants");
    expect(check.status).toBe("warn");
    expect(check.message).toContain("team//tasks/nightly");
    expect(check.message).toContain("akm task sync");
    expect(check.evidence).toMatchObject({ refs: ["team//tasks/nightly"], count: 1 });
  });

  test("unknown: the scheduler backend cannot inspect its own bindings", async () => {
    const backend = fakeBackend([]);
    backend.inspectBindings = undefined;
    const results = await collectUpgradeAdvisories({
      db: emptyDb,
      since: SINCE,
      stateDir: storage.stateDir,
      cliVersion: "1.2.3",
      probe: true,
      backend,
    });
    const check = findCheck(results, "scheduler-grants");
    expect(check.status).toBe("unknown");
  });

  test("unknown: inspecting the scheduler backend throws", async () => {
    const backend = fakeBackend([], {
      inspectBindings: () => {
        throw new Error("crontab not found");
      },
    });
    const results = await collectUpgradeAdvisories({
      db: emptyDb,
      since: SINCE,
      stateDir: storage.stateDir,
      cliVersion: "1.2.3",
      probe: true,
      backend,
    });
    const check = findCheck(results, "scheduler-grants");
    expect(check.status).toBe("unknown");
  });
});
