import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildScheduledBindingInvocation,
  loadSchedulerContextDescriptor,
  parseScheduledBindingArgv,
  resolveScheduledTaskContext,
  SCHEDULED_TASK_CONTEXT_KEYS,
  schedulerContextDescriptor,
  writeSchedulerContextDescriptor,
} from "../src/tasks/scheduler-invocation";
import { makeSandboxDir } from "./_helpers/sandbox";

function writeRawDescriptor(dir: string, value: unknown): string {
  const content = `${JSON.stringify(value)}\n`;
  const digest = createHash("sha256").update(content).digest("hex");
  const file = path.join(dir, `${digest}.json`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

function testContext(root: string) {
  const context = {
    AKM_BUNDLE_DIR: path.join(root, "stash"),
    AKM_CONFIG_DIR: path.join(root, "config"),
    AKM_DATA_DIR: path.join(root, "data"),
    AKM_CACHE_DIR: path.join(root, "cache"),
    AKM_STATE_DIR: path.join(root, "state"),
  };
  fs.mkdirSync(context.AKM_BUNDLE_DIR, { recursive: true });
  return context;
}

describe("scheduled task invocation", () => {
  test("uses a compact descriptor bootstrap shared by every scheduler backend", () => {
    expect(
      buildScheduledBindingInvocation(["/opt/akm/bin/akm"], "/data/tasks/context/one.json", [
        "task",
        "run",
        "ping",
        "--scheduled",
      ]).argv,
    ).toEqual([
      "/opt/akm/bin/akm",
      "--scheduler-context",
      "/data/tasks/context/one.json",
      "task",
      "run",
      "ping",
      "--scheduled",
    ]);
  });

  test("embeds --bundle only for a non-default bundle", () => {
    expect(
      buildScheduledBindingInvocation(["/opt/akm"], "/data/context.json", [
        "task",
        "run",
        "ping",
        "--bundle",
        "work",
        "--scheduled",
      ]).argv,
    ).toEqual([
      "/opt/akm",
      "--scheduler-context",
      "/data/context.json",
      "task",
      "run",
      "ping",
      "--bundle",
      "work",
      "--scheduled",
    ]);
  });

  test("round-trips a bundle-qualified nested standalone task invocation", () => {
    const argv = buildScheduledBindingInvocation(["/opt/akm"], "/data/context.json", [
      "task",
      "run",
      "sub/deep/nightly",
      "--bundle",
      "team",
      "--scheduled",
    ]).argv;
    expect(parseScheduledBindingArgv(argv)).toEqual({
      binding: ["/opt/akm"],
      contextPath: "/data/context.json",
      invocation: ["task", "run", "sub/deep/nightly", "--bundle", "team", "--scheduled"],
      target: "team",
    });
  });

  test.each([
    "bad%id",
    "bad.yml",
    "bad.",
    "bad\u0001id",
  ])("rejects every invalid flat public task invocation id %p", (taskId) => {
    const argv = ["/opt/akm", "--scheduler-context", "/data/context.json", "task", "run", taskId, "--scheduled"];
    expect(parseScheduledBindingArgv(argv)).toBeUndefined();
    expect(() =>
      buildScheduledBindingInvocation(["/opt/akm"], "/data/context.json", ["task", "run", taskId, "--scheduled"]),
    ).toThrow("Invalid scheduler invocation");
  });

  test("builds and recognizes the public qualified workflow invocation without hidden scheduler flags", () => {
    const argv = buildScheduledBindingInvocation(["/opt/akm"], "/data/context.json", [
      "workflow",
      "run",
      "team//workflows/release",
    ]).argv;

    expect(argv).toEqual([
      "/opt/akm",
      "--scheduler-context",
      "/data/context.json",
      "workflow",
      "run",
      "team//workflows/release",
    ]);
    expect(parseScheduledBindingArgv(argv)).toEqual({
      binding: ["/opt/akm"],
      contextPath: "/data/context.json",
      invocation: ["workflow", "run", "team//workflows/release"],
      target: "team",
    });
    expect(() =>
      buildScheduledBindingInvocation(["/opt/akm"], "/data/context.json", ["workflow", "run", "workflows/release"]),
    ).toThrow("Invalid scheduler invocation");
  });

  test("recognizes only the current descriptor-bearing invocation shape", () => {
    expect(parseScheduledBindingArgv(["/opt/akm", "task", "run", "ping", "--scheduled"])).toBeUndefined();
    expect(
      parseScheduledBindingArgv([
        "/opt/akm",
        "--scheduler-context",
        "/data/context.json",
        "task",
        "run",
        "ping",
        "--scheduled",
      ]),
    ).toEqual({
      binding: ["/opt/akm"],
      contextPath: "/data/context.json",
      invocation: ["task", "run", "ping", "--scheduled"],
    });
  });

  // 0.9 scheduler ABI respelling (`tasks run` → `task run`, S6): a pre-rename
  // installed invocation is no longer parseable — `task sync` treats it as an
  // orphan of its marker id and reinstalls it from the current file state
  // rather than crashing (src/tasks/backends/{cron,launchd,schtasks}.ts).
  test("no longer recognizes the pre-rename `tasks run` spelling", () => {
    expect(
      parseScheduledBindingArgv([
        "/opt/akm",
        "--scheduler-context",
        "/data/context.json",
        "tasks",
        "run",
        "ping",
        "--scheduled",
      ]),
    ).toBeUndefined();
  });

  test("captures the bundle path plus only the AKM_*_DIR overrides set explicitly, and never PATH", () => {
    const sandbox = makeSandboxDir("akm-scheduler-context-");
    try {
      fs.mkdirSync(path.join(sandbox.dir, "stash"));
      const explicit = resolveScheduledTaskContext({
        HOME: sandbox.dir,
        PATH: "/opt/bin:/usr/bin",
        AKM_BUNDLE_DIR: path.join(sandbox.dir, "stash"),
        AKM_CONFIG_DIR: path.join(sandbox.dir, "config"),
        AKM_DATA_DIR: path.join(sandbox.dir, "data"),
        AKM_CACHE_DIR: path.join(sandbox.dir, "cache"),
        AKM_STATE_DIR: path.join(sandbox.dir, "state"),
        AKM_LLM_API_KEY: "must-not-be-serialized",
      });
      expect(Object.keys(explicit)).toEqual([...SCHEDULED_TASK_CONTEXT_KEYS]);

      // Defaults — including an XDG_STATE_HOME some other application set for
      // this shell — resolve at fire time and are never frozen into the row.
      const implicit = resolveScheduledTaskContext({
        HOME: sandbox.dir,
        PATH: "/opt/bin:/usr/bin",
        XDG_STATE_HOME: path.join(sandbox.dir, "some-desktop-app"),
        AKM_BUNDLE_DIR: path.join(sandbox.dir, "stash"),
      });
      expect(implicit).toEqual({ AKM_BUNDLE_DIR: path.join(sandbox.dir, "stash") });

      const descriptor = schedulerContextDescriptor(explicit);
      const file = writeSchedulerContextDescriptor(descriptor);
      const serialized = fs.readFileSync(file, "utf8");
      expect(JSON.parse(serialized)).toEqual({ version: 1, environment: explicit });
      expect(serialized).not.toContain("PATH");
      expect(serialized).not.toContain("must-not-be-serialized");
      if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(writeSchedulerContextDescriptor(descriptor)).toBe(file);

      // Loading applies only what the descriptor carries; the fire-time
      // environment keeps its own PATH and state directory.
      const loaded: NodeJS.ProcessEnv = { PATH: "/fire/time/bin", AKM_STATE_DIR: "/fire/time/state" };
      loadSchedulerContextDescriptor(writeSchedulerContextDescriptor(schedulerContextDescriptor(implicit)), loaded);
      expect(loaded).toEqual({
        PATH: "/fire/time/bin",
        AKM_STATE_DIR: "/fire/time/state",
        AKM_BUNDLE_DIR: path.join(sandbox.dir, "stash"),
      });
    } finally {
      sandbox.cleanup();
    }
  });

  test("still applies a pre-0.9.17 descriptor, PATH included, until sync rewrites the row", () => {
    const sandbox = makeSandboxDir("akm-scheduler-context-legacy-");
    try {
      const context = testContext(sandbox.dir);
      const file = writeRawDescriptor(path.join(sandbox.dir, "context"), {
        version: 1,
        environment: { ...context, PATH: "/frozen/bin:/usr/bin" },
      });
      const loaded: NodeJS.ProcessEnv = {};
      loadSchedulerContextDescriptor(file, loaded);
      expect(loaded).toEqual({ ...context, PATH: "/frozen/bin:/usr/bin" });
    } finally {
      sandbox.cleanup();
    }
  });

  test("rejects tampered content and a mismatched content-addressed filename", () => {
    const sandbox = makeSandboxDir("akm-scheduler-context-hash-");
    try {
      const descriptor = schedulerContextDescriptor(testContext(sandbox.dir));
      const file = writeSchedulerContextDescriptor(descriptor);
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("config", "confog"), { mode: 0o600 });
      expect(() => loadSchedulerContextDescriptor(file, {})).toThrow("content SHA-256");

      const valid = writeRawDescriptor(path.join(sandbox.dir, "other"), descriptor);
      const wrongName = path.join(path.dirname(valid), `${"0".repeat(64)}.json`);
      fs.renameSync(valid, wrongName);
      expect(() => loadSchedulerContextDescriptor(wrongName, {})).toThrow("content SHA-256");
    } finally {
      sandbox.cleanup();
    }
  });

  test("rejects symlinked and non-regular descriptor paths", () => {
    const sandbox = makeSandboxDir("akm-scheduler-context-type-");
    try {
      const descriptor = schedulerContextDescriptor(testContext(sandbox.dir));
      const file = writeSchedulerContextDescriptor(descriptor);
      if (process.platform !== "win32") {
        const symlinkDir = path.join(sandbox.dir, "links");
        fs.mkdirSync(symlinkDir);
        const symlink = path.join(symlinkDir, path.basename(file));
        fs.symlinkSync(file, symlink);
        expect(() => loadSchedulerContextDescriptor(symlink, {})).toThrow("symbolic links are not allowed");
      }

      const directory = path.join(sandbox.dir, `${"1".repeat(64)}.json`);
      fs.mkdirSync(directory);
      expect(() => loadSchedulerContextDescriptor(directory, {})).toThrow("not a regular file");
    } finally {
      sandbox.cleanup();
    }
  });

  test.skipIf(process.platform === "win32")("rejects group or other permissions on POSIX", () => {
    const sandbox = makeSandboxDir("akm-scheduler-context-mode-");
    try {
      const file = writeSchedulerContextDescriptor(schedulerContextDescriptor(testContext(sandbox.dir)));
      fs.chmodSync(file, 0o644);
      expect(() => loadSchedulerContextDescriptor(file, {})).toThrow("group or other permissions");
    } finally {
      sandbox.cleanup();
    }
  });

  test("validates the v1 schema after content verification", () => {
    const sandbox = makeSandboxDir("akm-scheduler-context-schema-");
    try {
      const context = testContext(sandbox.dir);
      const extra = writeRawDescriptor(path.join(sandbox.dir, "extra"), {
        version: 1,
        environment: { ...context, EXTRA: "not-allowed" },
      });
      expect(() => loadSchedulerContextDescriptor(extra, {})).toThrow("Invalid scheduler context");

      const { AKM_BUNDLE_DIR: _, ...withoutBundle } = context;
      const missing = writeRawDescriptor(path.join(sandbox.dir, "missing"), {
        version: 1,
        environment: withoutBundle,
      });
      expect(() => loadSchedulerContextDescriptor(missing, {})).toThrow("Invalid scheduler context");

      const minimal = writeRawDescriptor(path.join(sandbox.dir, "minimal"), {
        version: 1,
        environment: { AKM_BUNDLE_DIR: context.AKM_BUNDLE_DIR },
      });
      const loaded: NodeJS.ProcessEnv = {};
      loadSchedulerContextDescriptor(minimal, loaded);
      expect(loaded).toEqual({ AKM_BUNDLE_DIR: context.AKM_BUNDLE_DIR });
    } finally {
      sandbox.cleanup();
    }
  });
});
