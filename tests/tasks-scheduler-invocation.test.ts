import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  buildScheduledInvocation,
  parseScheduledInvocationArgv,
  scheduledRowEnvironment,
} from "../src/tasks/scheduler-invocation";
import { makeSandboxDir } from "./_helpers/sandbox";

describe("scheduled task invocation", () => {
  test("the installed argv is the launcher followed by the public tail, with no descriptor argument", () => {
    expect(
      buildScheduledInvocation(["/opt/akm/bin/akm"], ["task", "run", "ping", "--bundle", "work", "--scheduled"]),
    ).toEqual(["/opt/akm/bin/akm", "task", "run", "ping", "--bundle", "work", "--scheduled"]);
  });

  test("parses the current argv and an argv with no inline environment", () => {
    const tail = ["task", "run", "sub/deep/nightly", "--bundle", "team", "--scheduled"];
    expect(parseScheduledInvocationArgv(["/usr/bin/bun", "/opt/akm", ...tail])).toEqual({
      binding: ["/usr/bin/bun", "/opt/akm"],
      invocation: tail,
      target: "team",
    });
    expect(parseScheduledInvocationArgv(["/usr/local/bin/akm", "task", "run", "ping", "--scheduled"])).toEqual({
      binding: ["/usr/local/bin/akm"],
      invocation: ["task", "run", "ping", "--scheduled"],
    });
  });

  test("a row from 0.9.17-alpha.6 or earlier, naming `--scheduler-context`, is not a row this release reads", () => {
    const tail = ["task", "run", "ping", "--scheduled"];
    expect(
      parseScheduledInvocationArgv(["/usr/bin/bun", "/opt/akm", "--scheduler-context", "/data/ctx.json", ...tail]),
    ).toBeUndefined();
  });

  test.each([
    "bad%id",
    "bad.yml",
    "bad.",
    "bad\u0001id",
  ])("rejects every invalid flat public task invocation id %p", (taskId) => {
    expect(parseScheduledInvocationArgv(["/opt/akm", "task", "run", taskId, "--scheduled"])).toBeUndefined();
    expect(() => buildScheduledInvocation(["/opt/akm"], ["task", "run", taskId, "--scheduled"])).toThrow(
      "Invalid scheduler invocation",
    );
  });

  test("builds and recognizes the public qualified workflow invocation", () => {
    const argv = buildScheduledInvocation(["/opt/akm"], ["workflow", "run", "team//workflows/release"]);
    expect(argv).toEqual(["/opt/akm", "workflow", "run", "team//workflows/release"]);
    expect(parseScheduledInvocationArgv(argv)).toEqual({
      binding: ["/opt/akm"],
      invocation: ["workflow", "run", "team//workflows/release"],
      target: "team",
    });
    expect(() => buildScheduledInvocation(["/opt/akm"], ["workflow", "run", "workflows/release"])).toThrow(
      "Invalid scheduler invocation",
    );
  });

  // 0.9 scheduler ABI respelling (`tasks run` → `task run`, S6): a pre-rename
  // installed invocation is not parseable — `task sync` treats it as an
  // orphan of its marker id and reinstalls it from the current file state.
  test("does not recognize the pre-rename `tasks run` spelling", () => {
    expect(parseScheduledInvocationArgv(["/opt/akm", "tasks", "run", "ping", "--scheduled"])).toBeUndefined();
  });

  test("every row sets AKM_BUNDLE_DIR to the working stash, plus only the AKM_*_DIR overrides set explicitly", () => {
    const sandbox = makeSandboxDir("akm-row-environment-");
    try {
      const stash = path.join(sandbox.dir, "stash");
      fs.mkdirSync(stash);
      const env = {
        HOME: sandbox.dir,
        PATH: "/opt/bin:/usr/bin",
        // Resolved defaults, including an XDG directory some other application
        // set for this shell, resolve at fire time and are never frozen in.
        XDG_STATE_HOME: path.join(sandbox.dir, "some-desktop-app"),
        AKM_BUNDLE_DIR: stash,
        AKM_LLM_API_KEY: "must-not-be-serialized",
      };
      expect(scheduledRowEnvironment(env)).toEqual({ AKM_BUNDLE_DIR: stash });
      expect(
        scheduledRowEnvironment({
          ...env,
          AKM_CONFIG_DIR: "/srv/config",
          AKM_DATA_DIR: "/srv/data",
          AKM_CACHE_DIR: "/srv/cache",
          AKM_STATE_DIR: "/srv/state",
        }),
      ).toEqual({
        AKM_BUNDLE_DIR: stash,
        AKM_CONFIG_DIR: "/srv/config",
        AKM_DATA_DIR: "/srv/data",
        AKM_CACHE_DIR: "/srv/cache",
        AKM_STATE_DIR: "/srv/state",
      });
    } finally {
      sandbox.cleanup();
    }
  });
});
