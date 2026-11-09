// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** `akm health` names an enabled task that dispatch cannot run: nothing else would say so, dispatch.log is rewritten each minute. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { HEALTH_CHECKS, type HealthCheckContext } from "../src/commands/health/checks";
import { collectUnrunnableTasksAdvisory } from "../src/commands/health/unrunnable-tasks";
import { saveConfig } from "../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
});
afterEach(() => storage.cleanup());

function configure(enabled: string[] | undefined): void {
  saveConfig({
    semanticSearchMode: "off",
    defaultBundle: "stash",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    ...(enabled ? { scheduler: { enabled } } : {}),
  });
}

describe("unrunnable-tasks advisory", () => {
  test("passes when every enabled task can be read and scheduled, or none is enabled", () => {
    fs.writeFileSync(path.join(storage.stashDir, "tasks", "ok.yml"), 'version: 4\nrun: "true"\nschedule: "@daily"\n');
    configure(["stash//tasks/ok"]);
    expect(collectUnrunnableTasksAdvisory().status).toBe("pass");
    configure(undefined);
    expect(collectUnrunnableTasksAdvisory().status).toBe("pass");
  });

  test("warns naming each task that cannot run and why", () => {
    fs.writeFileSync(
      path.join(storage.stashDir, "tasks", "reboot.yml"),
      'version: 4\nrun: "true"\nschedule: "@reboot"\n',
    );
    configure(["stash//tasks/reboot", "stash//tasks/gone"]);

    const result = collectUnrunnableTasksAdvisory();

    expect(result.status).toBe("warn");
    expect(result.message).toContain("stash//tasks/reboot");
    expect(result.message).toContain("stash//tasks/gone");
    expect(result.evidence).toMatchObject({ failures: [{ ref: "stash//tasks/reboot" }, { ref: "stash//tasks/gone" }] });
  });

  test("is registered as an advisory that projects the context, ahead of scheduler-binary", () => {
    const names = HEALTH_CHECKS.map((check) => check.name);
    expect(names).toContain("unrunnable-tasks");
    expect(names.indexOf("unrunnable-tasks")).toBeLessThan(names.indexOf("scheduler-binary"));
    const check = HEALTH_CHECKS.find((entry) => entry.name === "unrunnable-tasks");
    const projected = collectUnrunnableTasksAdvisory();
    expect(check?.run({ unrunnableTasks: projected } as unknown as HealthCheckContext)).toBe(projected);
  });
});
