// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  compileTaskSchedulerBindings,
  compileWorkflowSchedulerBindings,
  schedulerNativeBindingId,
} from "../../src/tasks/scheduler-binding";

describe("secret-free scheduler binding compiler", () => {
  test("preserves the legacy task id at ordinal zero and emits only the public task invocation", () => {
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

  test("gives additional task schedules collision-resistant ids and always proves the resolved bundle", () => {
    const bindings = compileTaskSchedulerBindings({
      id: "nightly",
      qualifiedRef: "team//tasks/nightly",
      schedules: [
        { cron: "0 2 * * *", source: "on.schedule[0].cron", ordinal: 0 },
        { cron: "0 3 * * *", source: "on.schedule[1].cron", ordinal: 1 },
      ],
    });

    expect(bindings[0]?.id).toBe("nightly");
    expect(bindings[0]?.nativeId).toBe("nightly");
    expect(bindings[1]?.id).toMatch(/^task-[a-f0-9]{32}$/);
    expect(bindings[1]?.nativeId).toBe(bindings[1]?.id);
    expect(bindings[0]?.invocation).toEqual(["task", "run", "nightly", "--bundle", "team", "--scheduled"]);
    expect(bindings[1]?.invocation).toEqual(["task", "run", "nightly", "--bundle", "team", "--scheduled"]);
  });

  test("accepts a qualified standalone akm-task concept without inventing a tasks/ prefix", () => {
    const [binding] = compileTaskSchedulerBindings({
      id: "nightly",
      qualifiedRef: "team//nightly",
      schedules: [{ cron: "@daily", source: "nightly.yml:akm.schedule", ordinal: 0 }],
    });
    expect(binding?.logicalSource.ref).toBe("team//nightly");
    expect(binding?.id).toBe("nightly");
  });

  test("preserves a nested standalone canonical id in the binding and public invocation", () => {
    const [binding] = compileTaskSchedulerBindings({
      id: "sub/deep/nightly",
      qualifiedRef: "team//sub/deep/nightly",
      schedules: [{ cron: "@daily", source: "sub/deep/nightly.yml:akm.schedule", ordinal: 0 }],
    });
    expect(binding).toMatchObject({
      id: "sub/deep/nightly",
      logicalSource: { kind: "task", ref: "team//sub/deep/nightly" },
      invocation: ["task", "run", "sub/deep/nightly", "--bundle", "team", "--scheduled"],
    });
  });

  test("maps only nested logical ids to a deterministic portable native id", () => {
    expect(schedulerNativeBindingId("nightly")).toBe("nightly");
    expect(schedulerNativeBindingId("sub/deep/nightly")).toMatch(/^task-[a-f0-9]{32}$/);
    expect(schedulerNativeBindingId("sub/deep/nightly")).toBe(schedulerNativeBindingId("sub/deep/nightly"));
    expect(schedulerNativeBindingId("other/deep/nightly")).not.toBe(schedulerNativeBindingId("sub/deep/nightly"));
  });

  test("workflow schedule ids include the qualified ref and ordinal while manual dispatch creates no artifact", () => {
    const input = {
      qualifiedRef: "team//workflows/release",
      schedules: [
        { cron: "0 8 * * 1", source: "workflows/release.yml:4", ordinal: 0 },
        { cron: "0 9 * * 2", source: "workflows/release.yml:5", ordinal: 1 },
      ],
    } as const;
    const first = compileWorkflowSchedulerBindings(input);
    const second = compileWorkflowSchedulerBindings(input);

    expect(first).toEqual(second);
    expect(first.map(({ id }) => id)).toEqual([
      expect.stringMatching(/^wf-[a-f0-9]{32}$/),
      expect.stringMatching(/^wf-[a-f0-9]{32}$/),
    ]);
    expect(first[0]?.id).not.toBe(first[1]?.id);
    expect(first.map(({ nativeId }) => nativeId)).toEqual(first.map(({ id }) => id));
    expect(first[0]?.invocation).toEqual(["workflow", "run", "team//workflows/release"]);
    expect(compileWorkflowSchedulerBindings({ qualifiedRef: "team//workflows/manual", schedules: [] })).toEqual([]);
  });

  test("bindings cannot carry execution values or source content", () => {
    const [binding] = compileWorkflowSchedulerBindings({
      qualifiedRef: "team//workflows/release",
      schedules: [{ cron: "@daily", source: "release.yml:2", ordinal: 0 }],
    });
    const bytes = JSON.stringify(binding);

    expect(Object.keys(binding ?? {}).sort()).toEqual([
      "cron",
      "enabled",
      "id",
      "invocation",
      "logicalSource",
      "nativeId",
      "ordinal",
      "source",
    ]);
    for (const forbidden of ["env", "with", "content", "secret", "resolved", "token-value"]) {
      expect(bytes.toLowerCase()).not.toContain(forbidden);
    }
  });
});
