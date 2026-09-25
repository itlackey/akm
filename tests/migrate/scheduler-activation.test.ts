// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  applySchedulerActivationMigration,
  inspectSchedulerActivationMigration,
} from "../../scripts/akm-migrate/migrate/scheduler-activation";
import { loadConfig } from "../../src/core/config/config";
import { bundleSourceId, filesystemBundleSourceId } from "../../src/core/config/config-sources";
import { schedulerActivations } from "../../src/tasks/activation-config";
import type { SchedulerBackend } from "../../src/tasks/scheduler-binding";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    defaultBundle: "team",
    bundles: { team: { path: storage.stashDir, writable: true } },
  });
  // A carried-forward grant requires a backing file (upgrade-B policy 1):
  // "nightly" and "release" back the two installed rows that qualify below.
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(storage.stashDir, "tasks", "nightly.yml"), "schedule: '0 2 * * *'\n");
  fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
  fs.writeFileSync(path.join(storage.stashDir, "workflows", "release.yml"), "steps: []\n");
});

afterEach(() => storage.cleanup());

function backend(): SchedulerBackend {
  return {
    name: "cron",
    install() {},
    uninstall() {},
    setEnabled() {},
    list: () => [],
    inspectBindings: () => ({
      installed: [
        {
          id: "nightly",
          enabled: true,
          binding: ["/usr/local/bin/akm"],
          contextPath: "/tmp/context.json",
          invocation: ["task", "run", "nightly", "--bundle", "team", "--scheduled"],
        },
        {
          id: "disabled",
          enabled: false,
          binding: ["/usr/local/bin/akm"],
          contextPath: "/tmp/context.json",
          invocation: ["task", "run", "disabled", "--bundle", "team", "--scheduled"],
        },
        {
          id: "release",
          enabled: true,
          binding: ["/usr/local/bin/akm"],
          contextPath: "/tmp/context.json",
          invocation: ["workflow", "run", "team//workflows/release"],
        },
        {
          id: "untrusted",
          enabled: true,
          binding: ["/usr/local/bin/akm"],
          contextPath: "/tmp/context.json",
          invocation: ["workflow", "run", "not-a-qualified-ref"],
        },
      ],
      artifacts: [],
    }),
  };
}

describe("scheduler activation migration", () => {
  test("status is read-only and reports only proven, natively enabled bindings", async () => {
    const plan = await inspectSchedulerActivationMigration(backend());
    const sourceId = bundleSourceId(loadConfig(), "team");

    expect(plan.pending).toEqual([
      { kind: "task", ref: "team//tasks/nightly", sourceId },
      { kind: "workflow", ref: "team//workflows/release", sourceId },
    ]);
    expect(schedulerActivations(loadConfig())).toEqual([]);
  });

  test("apply seeds host-local activation and converges", async () => {
    const result = await applySchedulerActivationMigration(backend());
    const sourceId = bundleSourceId(loadConfig(), "team");

    expect(result.applied).toHaveLength(2);
    expect(schedulerActivations(loadConfig())).toEqual([
      { kind: "task", ref: "team//tasks/nightly", sourceId },
      { kind: "workflow", ref: "team//workflows/release", sourceId },
    ]);
    expect((await inspectSchedulerActivationMigration(backend())).pending).toEqual([]);
  });

  test("a ref already granted to a stale sourceId is reported as a warning, never rebound", async () => {
    const sourceId = bundleSourceId(loadConfig(), "team");
    const staleSourceId = filesystemBundleSourceId(path.join(storage.stashDir, "..", "different-origin"));
    writeSandboxConfig({
      defaultBundle: "team",
      bundles: { team: { path: storage.stashDir, writable: true } },
      scheduler: { enabled: [{ kind: "task", ref: "team//tasks/nightly", sourceId: staleSourceId }] },
    });

    const plan = await inspectSchedulerActivationMigration(backend());
    expect(plan.pending).toEqual([{ kind: "workflow", ref: "team//workflows/release", sourceId }]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("team//tasks/nightly");
    expect(plan.warnings[0]).toContain("akm migrate apply");

    const result = await applySchedulerActivationMigration(backend());
    expect(result.applied).toEqual([{ kind: "workflow", ref: "team//workflows/release", sourceId }]);
    expect(result.staleGrants).toEqual([
      { ref: "team//tasks/nightly", grantedSourceId: staleSourceId, currentSourceId: sourceId },
    ]);
    // The stale grant is reported, not silently rebound to the new source.
    expect(schedulerActivations(loadConfig())).toContainEqual({
      kind: "task",
      ref: "team//tasks/nightly",
      sourceId: staleSourceId,
    });
  });
});
