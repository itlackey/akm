// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../src/core/config/config";
import { bundleSourceId, filesystemBundleSourceId } from "../../src/core/config/config-sources";
import type { InstalledSchedulerBinding } from "../../src/tasks/scheduler-binding";
import { pendingGrantsFromInstalled, staleGrantsFromInstalled } from "../../src/tasks/scheduler-grant-carry-forward";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    defaultBundle: "team",
    bundles: {
      team: { path: storage.stashDir, writable: true },
      archived: { path: path.join(storage.stashDir, "..", "archived"), writable: true, enabled: false },
    },
  });
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(storage.stashDir, "tasks", "nightly.yml"), "schedule: '0 2 * * *'\n");
});

afterEach(() => storage.cleanup());

function binding(overrides: Partial<InstalledSchedulerBinding> & { id: string }): InstalledSchedulerBinding {
  return {
    enabled: true,
    binding: ["/usr/local/bin/akm"],
    contextPath: "/tmp/context.json",
    ...overrides,
  };
}

describe("pendingGrantsFromInstalled", () => {
  test("an installed row in an enabled bundle with a backing file is a pending grant", () => {
    const config = loadConfig();
    const pending = pendingGrantsFromInstalled(
      [binding({ id: "nightly", invocation: ["task", "run", "nightly", "--bundle", "team", "--scheduled"] })],
      config,
    );
    expect(pending).toEqual([{ kind: "task", ref: "team//tasks/nightly", sourceId: bundleSourceId(config, "team") }]);
  });

  test("an installed row in a disabled bundle is not carried forward", () => {
    const config = loadConfig();
    const pending = pendingGrantsFromInstalled(
      [binding({ id: "old", invocation: ["task", "run", "nightly", "--bundle", "archived", "--scheduled"] })],
      config,
    );
    expect(pending).toEqual([]);
  });

  test("an installed row with no backing file is not carried forward", () => {
    const config = loadConfig();
    const pending = pendingGrantsFromInstalled(
      [binding({ id: "ghost", invocation: ["task", "run", "ghost", "--bundle", "team", "--scheduled"] })],
      config,
    );
    expect(pending).toEqual([]);
  });

  test("a row already granted is not reported as pending again", () => {
    writeSandboxConfig({
      defaultBundle: "team",
      bundles: { team: { path: storage.stashDir, writable: true } },
      scheduler: {
        enabled: [{ kind: "task", ref: "team//tasks/nightly", sourceId: bundleSourceId(loadConfig(), "team") }],
      },
    });
    const config = loadConfig();
    const pending = pendingGrantsFromInstalled(
      [binding({ id: "nightly", invocation: ["task", "run", "nightly", "--bundle", "team", "--scheduled"] })],
      config,
    );
    expect(pending).toEqual([]);
    expect(
      staleGrantsFromInstalled(
        [binding({ id: "nightly", invocation: ["task", "run", "nightly", "--bundle", "team", "--scheduled"] })],
        config,
      ),
    ).toEqual([]);
  });

  test("a row whose ref has a grant bound to a different sourceId is not pending, and is reported as stale", () => {
    const currentSourceId = bundleSourceId(loadConfig(), "team");
    const staleSourceId = filesystemBundleSourceId(path.join(storage.stashDir, "..", "different-origin"));
    writeSandboxConfig({
      defaultBundle: "team",
      bundles: { team: { path: storage.stashDir, writable: true } },
      scheduler: {
        enabled: [{ kind: "task", ref: "team//tasks/nightly", sourceId: staleSourceId }],
      },
    });
    const config = loadConfig();
    const entries = [
      binding({ id: "nightly", invocation: ["task", "run", "nightly", "--bundle", "team", "--scheduled"] }),
    ];
    expect(pendingGrantsFromInstalled(entries, config)).toEqual([]);
    expect(staleGrantsFromInstalled(entries, config)).toEqual([
      { ref: "team//tasks/nightly", grantedSourceId: staleSourceId, currentSourceId },
    ]);
  });
});
