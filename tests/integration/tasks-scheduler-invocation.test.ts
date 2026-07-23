import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildScheduledTaskInvocation,
  resolveScheduledTaskContext,
  SCHEDULED_TASK_CONTEXT_KEYS,
  type ScheduledTaskContext,
} from "../../src/tasks/scheduler-invocation";

const CONTEXT: ScheduledTaskContext = {
  AKM_STASH_DIR: "/srv/akm stash",
  AKM_CONFIG_DIR: "/srv/akm config",
  AKM_DATA_DIR: "/srv/akm data",
  AKM_CACHE_DIR: "/srv/akm cache",
  AKM_STATE_DIR: "/srv/akm state",
};

describe("scheduled task invocation", () => {
  test("uses one marked argv representation shared by every scheduler backend", () => {
    const invocation = buildScheduledTaskInvocation(["/opt/akm/bin/akm"], "ping", CONTEXT);

    expect(invocation.argv).toEqual(["/opt/akm/bin/akm", "tasks", "run", "ping", "--scheduled"]);
    expect(invocation.environment).toEqual(CONTEXT);
  });

  test("embeds --target only for a non-default bundle; omitted / empty stays byte-identical", () => {
    expect(buildScheduledTaskInvocation(["/opt/akm/bin/akm"], "ping", CONTEXT, "work").argv).toEqual([
      "/opt/akm/bin/akm",
      "tasks",
      "run",
      "ping",
      "--target",
      "work",
      "--scheduled",
    ]);
    // An empty target string is treated as "no target" (primary form).
    expect(buildScheduledTaskInvocation(["/opt/akm/bin/akm"], "ping", CONTEXT, "").argv).toEqual([
      "/opt/akm/bin/akm",
      "tasks",
      "run",
      "ping",
      "--scheduled",
    ]);
  });

  test("resolves exactly the five non-secret AKM directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-scheduler-context-"));
    const stashDir = path.join(root, "stash");
    fs.mkdirSync(stashDir, { recursive: true });
    try {
      const context = resolveScheduledTaskContext({
        HOME: root,
        AKM_STASH_DIR: stashDir,
        AKM_CONFIG_DIR: path.join(root, "config"),
        AKM_DATA_DIR: path.join(root, "data"),
        AKM_CACHE_DIR: path.join(root, "cache"),
        AKM_STATE_DIR: path.join(root, "state"),
        AKM_LLM_API_KEY: "must-not-be-serialized",
        AWS_SECRET_ACCESS_KEY: "also-must-not-be-serialized",
        ARBITRARY_ENV: "not-scheduler-context",
      });

      expect(Object.keys(context)).toEqual([...SCHEDULED_TASK_CONTEXT_KEYS]);
      expect(context).toEqual({
        AKM_STASH_DIR: stashDir,
        AKM_CONFIG_DIR: path.join(root, "config"),
        AKM_DATA_DIR: path.join(root, "data"),
        AKM_CACHE_DIR: path.join(root, "cache"),
        AKM_STATE_DIR: path.join(root, "state"),
      });
      expect(JSON.stringify(context)).not.toContain("must-not-be-serialized");
      expect(JSON.stringify(context)).not.toContain("ARBITRARY_ENV");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects scheduler context with missing or unrecognized fields", () => {
    expect(() =>
      buildScheduledTaskInvocation(["/abs/akm"], "ping", {
        ...CONTEXT,
        AKM_LLM_API_KEY: "secret",
      } as ScheduledTaskContext),
    ).toThrow("scheduler context");
    const { AKM_STATE_DIR: _, ...missingState } = CONTEXT;
    expect(() => buildScheduledTaskInvocation(["/abs/akm"], "ping", missingState as ScheduledTaskContext)).toThrow(
      "scheduler context",
    );
  });
});
