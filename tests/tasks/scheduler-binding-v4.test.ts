// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  type CompileTaskSchedulerBindingsInput,
  compileTaskSchedulerBindings,
} from "../../src/tasks/scheduler-binding";

describe("compileTaskSchedulerBindings — activation is external to task source", () => {
  test("every binding selected by scheduler config is compiled enabled", () => {
    const input: CompileTaskSchedulerBindingsInput = {
      id: "nightly",
      qualifiedRef: "team//tasks/nightly",
      schedules: [
        { cron: "0 6 * * *", source: "schedule[0].cron", ordinal: 0 },
        { cron: "30 18 * * 1-5", source: "schedule[1].cron", ordinal: 1 },
      ],
    };

    const bindings = compileTaskSchedulerBindings(input);
    expect(bindings.map((binding) => binding.enabled)).toEqual([true, true]);
  });

  test("the public invocation remains bundle-qualified", () => {
    const [binding] = compileTaskSchedulerBindings({
      id: "nightly",
      qualifiedRef: "team//tasks/nightly",
      schedules: [{ cron: "0 2 * * *", source: "akm.schedule", ordinal: 0 }],
    });

    expect(binding).toEqual({
      id: "nightly",
      nativeId: "nightly",
      logicalSource: { kind: "task", ref: "team//tasks/nightly" },
      cron: "0 2 * * *",
      source: "akm.schedule",
      ordinal: 0,
      enabled: true,
      invocation: ["task", "run", "nightly", "--bundle", "team", "--scheduled"],
    });
  });
});
