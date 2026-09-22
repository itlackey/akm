// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  applySchedulerActivationMigration,
  inspectSchedulerActivationMigration,
} from "../../scripts/akm-migrate/migrate/scheduler-activation";
import { loadConfig } from "../../src/core/config/config";
import { bundleSourceId } from "../../src/core/config/config-sources";
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
});
