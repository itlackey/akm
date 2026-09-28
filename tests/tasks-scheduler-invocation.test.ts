import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  buildScheduledInvocation,
  consumeSchedulerContextArg,
  parseScheduledInvocationArgv,
  readLegacySchedulerContext,
  scheduledRowEnvironment,
} from "../src/tasks/scheduler-invocation";
import { makeSandboxDir } from "./_helpers/sandbox";

describe("scheduled task invocation", () => {
  test("the installed argv is the launcher followed by the public tail, with no descriptor argument", () => {
    expect(
      buildScheduledInvocation(["/opt/akm/bin/akm"], ["task", "run", "ping", "--bundle", "work", "--scheduled"]),
    ).toEqual(["/opt/akm/bin/akm", "task", "run", "ping", "--bundle", "work", "--scheduled"]);
  });

  test("parses the current argv, a --scheduler-context argv (0.9.0 – 0.9.17-alpha.6), and an older argv with neither", () => {
    const tail = ["task", "run", "sub/deep/nightly", "--bundle", "team", "--scheduled"];
    expect(parseScheduledInvocationArgv(["/usr/bin/bun", "/opt/akm", ...tail])).toEqual({
      binding: ["/usr/bin/bun", "/opt/akm"],
      invocation: tail,
      target: "team",
    });
    expect(
      parseScheduledInvocationArgv(["/usr/bin/bun", "/opt/akm", "--scheduler-context", "/data/ctx.json", ...tail]),
    ).toEqual({
      binding: ["/usr/bin/bun", "/opt/akm"],
      contextPath: "/data/ctx.json",
      invocation: tail,
      target: "team",
    });
    expect(parseScheduledInvocationArgv(["/usr/local/bin/akm", "task", "run", "ping", "--scheduled"])).toEqual({
      binding: ["/usr/local/bin/akm"],
      invocation: ["task", "run", "ping", "--scheduled"],
    });
  });

  test("a row that names --scheduler-context but does not parse around it is never reread as another shape", () => {
    const tail = ["task", "run", "ping", "--scheduled"];
    expect(parseScheduledInvocationArgv(["/opt/akm", "--scheduler-context", ...tail])).toBeUndefined();
    expect(
      parseScheduledInvocationArgv([
        "/opt/akm",
        "--scheduler-context",
        "/a.json",
        "--scheduler-context",
        "/b.json",
        ...tail,
      ]),
    ).toBeUndefined();
    expect(parseScheduledInvocationArgv(["--scheduler-context", "/a.json", ...tail])).toBeUndefined();
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
    expect(
      parseScheduledInvocationArgv(["/opt/akm", "--scheduler-context", "/data/ctx.json", "tasks", "run", "ping"]),
    ).toBeUndefined();
  });

  test("a row sets AKM_BUNDLE_DIR only for the env-selected stash, plus only the AKM_*_DIR overrides set explicitly", () => {
    const env = {
      HOME: "/home/user",
      PATH: "/opt/bin:/usr/bin",
      XDG_STATE_HOME: "/home/user/some-desktop-app",
      AKM_BUNDLE_DIR: "/srv/stash",
      AKM_LLM_API_KEY: "must-not-be-serialized",
    };
    // A configured bundle: `--bundle <name>` finds it at fire time.
    expect(scheduledRowEnvironment(undefined, env)).toEqual({});
    // The env-selected stash: no config names it, so the row carries its path.
    expect(scheduledRowEnvironment("/srv/stash", env)).toEqual({ AKM_BUNDLE_DIR: "/srv/stash" });

    const explicit = scheduledRowEnvironment(undefined, {
      ...env,
      AKM_CONFIG_DIR: "/srv/config",
      AKM_DATA_DIR: "/srv/data",
      AKM_CACHE_DIR: "/srv/cache",
      AKM_STATE_DIR: "/srv/state",
    });
    expect(explicit).toEqual({
      AKM_CONFIG_DIR: "/srv/config",
      AKM_DATA_DIR: "/srv/data",
      AKM_CACHE_DIR: "/srv/cache",
      AKM_STATE_DIR: "/srv/state",
    });
  });
});

describe("rows written before 0.9.17-alpha.7 (`--scheduler-context <descriptor>`)", () => {
  test("the CLI applies the descriptor's environment, PATH included, and removes the argument", () => {
    const sandbox = makeSandboxDir("akm-scheduler-context-legacy-");
    try {
      const file = path.join(sandbox.dir, "context.json");
      fs.writeFileSync(
        file,
        `${JSON.stringify({
          version: 1,
          environment: {
            AKM_BUNDLE_DIR: "/srv/stash",
            AKM_CONFIG_DIR: "/srv/config",
            AKM_DATA_DIR: "/srv/data",
            AKM_CACHE_DIR: "/srv/cache",
            AKM_STATE_DIR: "/srv/state",
            PATH: "/frozen/bin:/usr/bin",
          },
        })}\n`,
      );
      const env: NodeJS.ProcessEnv = { PATH: "/fire/time/bin" };
      const argv = consumeSchedulerContextArg(
        ["bun", "cli.js", "--scheduler-context", file, "task", "run", "ping", "--scheduled"],
        env,
      );
      expect(argv).toEqual(["bun", "cli.js", "task", "run", "ping", "--scheduled"]);
      expect(env).toEqual({
        PATH: "/frozen/bin:/usr/bin",
        AKM_BUNDLE_DIR: "/srv/stash",
        AKM_CONFIG_DIR: "/srv/config",
        AKM_DATA_DIR: "/srv/data",
        AKM_CACHE_DIR: "/srv/cache",
        AKM_STATE_DIR: "/srv/state",
      });
    } finally {
      sandbox.cleanup();
    }
  });

  test("a descriptor is read as plain JSON: its name, mode, and a symlink to it are not checked at fire time", () => {
    const sandbox = makeSandboxDir("akm-scheduler-context-plain-");
    try {
      const file = path.join(sandbox.dir, `${"0".repeat(64)}.json`);
      fs.writeFileSync(file, JSON.stringify({ version: 1, environment: { AKM_BUNDLE_DIR: "/srv/stash" } }));
      if (process.platform !== "win32") fs.chmodSync(file, 0o644);
      const linked = path.join(sandbox.dir, "linked.json");
      fs.symlinkSync(file, linked);
      for (const candidate of [file, linked]) {
        const env: NodeJS.ProcessEnv = {};
        consumeSchedulerContextArg(["bun", "cli.js", "--scheduler-context", candidate, "task", "run", "x"], env);
        expect(env).toEqual({ AKM_BUNDLE_DIR: "/srv/stash" });
      }
      // Only the keys a scheduler context ever carried are applied.
      fs.writeFileSync(
        file,
        JSON.stringify({ version: 1, environment: { AKM_BUNDLE_DIR: "/srv/stash", LD_PRELOAD: "/evil.so" } }),
      );
      expect(readLegacySchedulerContext(file)).toEqual({ AKM_BUNDLE_DIR: "/srv/stash" });
    } finally {
      sandbox.cleanup();
    }
  });

  test("a descriptor that cannot be read fails naming `akm task sync`", () => {
    const sandbox = makeSandboxDir("akm-scheduler-context-missing-");
    try {
      const missing = path.join(sandbox.dir, "gone.json");
      expect(() => consumeSchedulerContextArg(["bun", "cli.js", "--scheduler-context", missing, "task"], {})).toThrow(
        /akm task sync/,
      );
      const garbled = path.join(sandbox.dir, "garbled.json");
      fs.writeFileSync(garbled, "{ not json");
      expect(() => readLegacySchedulerContext(garbled)).toThrow(/akm task sync/);
      expect(() => consumeSchedulerContextArg(["bun", "cli.js", "--scheduler-context"], {})).toThrow(
        /--scheduler-context/,
      );
    } finally {
      sandbox.cleanup();
    }
  });

  test("an argument after `--` belongs to the child command and is left alone", () => {
    const argv = ["bun", "cli.js", "env", "run", "env/prod", "--", "/bin/true", "--scheduler-context", "/nope.json"];
    const env: NodeJS.ProcessEnv = {};
    expect(consumeSchedulerContextArg(argv, env)).toEqual(argv);
    expect(env).toEqual({});
  });
});
