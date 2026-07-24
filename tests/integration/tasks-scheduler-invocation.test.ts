import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildScheduledTaskInvocation,
  loadSchedulerContextDescriptor,
  resolveScheduledTaskContext,
  SCHEDULED_TASK_CONTEXT_KEYS,
  schedulerContextDescriptor,
  writeSchedulerContextDescriptor,
} from "../../src/tasks/scheduler-invocation";
import { makeSandboxDir } from "../_helpers/sandbox";

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
    AKM_STASH_DIR: path.join(root, "stash"),
    AKM_CONFIG_DIR: path.join(root, "config"),
    AKM_DATA_DIR: path.join(root, "data"),
    AKM_CACHE_DIR: path.join(root, "cache"),
    AKM_STATE_DIR: path.join(root, "state"),
  };
  fs.mkdirSync(context.AKM_STASH_DIR, { recursive: true });
  return context;
}

describe("scheduled task invocation", () => {
  test("uses a compact descriptor bootstrap shared by every scheduler backend", () => {
    expect(buildScheduledTaskInvocation(["/opt/akm/bin/akm"], "ping", "/data/tasks/context/one.json").argv).toEqual([
      "/opt/akm/bin/akm",
      "--scheduler-context",
      "/data/tasks/context/one.json",
      "tasks",
      "run",
      "ping",
      "--scheduled",
    ]);
  });

  test("embeds --target only for a non-default bundle", () => {
    expect(buildScheduledTaskInvocation(["/opt/akm"], "ping", "/data/context.json", "work").argv).toEqual([
      "/opt/akm",
      "--scheduler-context",
      "/data/context.json",
      "tasks",
      "run",
      "ping",
      "--target",
      "work",
      "--scheduled",
    ]);
  });

  test("writes an immutable restrictive descriptor containing only directories and PATH", () => {
    const sandbox = makeSandboxDir("akm-scheduler-context-");
    try {
      fs.mkdirSync(path.join(sandbox.dir, "stash"));
      const context = resolveScheduledTaskContext({
        HOME: sandbox.dir,
        AKM_STASH_DIR: path.join(sandbox.dir, "stash"),
        AKM_CONFIG_DIR: path.join(sandbox.dir, "config"),
        AKM_DATA_DIR: path.join(sandbox.dir, "data"),
        AKM_CACHE_DIR: path.join(sandbox.dir, "cache"),
        AKM_STATE_DIR: path.join(sandbox.dir, "state"),
        AKM_LLM_API_KEY: "must-not-be-serialized",
      });
      const descriptor = schedulerContextDescriptor(context, "/opt/bin:/usr/bin");
      const file = writeSchedulerContextDescriptor(descriptor);
      const serialized = fs.readFileSync(file, "utf8");

      expect(JSON.parse(serialized)).toEqual({ version: 1, environment: { ...context, PATH: "/opt/bin:/usr/bin" } });
      expect(Object.keys(context)).toEqual([...SCHEDULED_TASK_CONTEXT_KEYS]);
      expect(serialized).not.toContain("must-not-be-serialized");
      if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(writeSchedulerContextDescriptor(descriptor)).toBe(file);

      const loaded: NodeJS.ProcessEnv = {};
      loadSchedulerContextDescriptor(file, loaded);
      expect(loaded).toEqual({ ...context, PATH: "/opt/bin:/usr/bin" });
    } finally {
      sandbox.cleanup();
    }
  });

  test("rejects tampered content and a mismatched content-addressed filename", () => {
    const sandbox = makeSandboxDir("akm-scheduler-context-hash-");
    try {
      const descriptor = schedulerContextDescriptor(testContext(sandbox.dir), "/usr/bin");
      const file = writeSchedulerContextDescriptor(descriptor);
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("/usr/bin", "/opt/bin"), { mode: 0o600 });
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
      const descriptor = schedulerContextDescriptor(testContext(sandbox.dir), "/usr/bin");
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
      const file = writeSchedulerContextDescriptor(schedulerContextDescriptor(testContext(sandbox.dir), "/usr/bin"));
      fs.chmodSync(file, 0o644);
      expect(() => loadSchedulerContextDescriptor(file, {})).toThrow("group or other permissions");
    } finally {
      sandbox.cleanup();
    }
  });

  test("validates the fixed v1 schema after content verification", () => {
    const sandbox = makeSandboxDir("akm-scheduler-context-schema-");
    try {
      const context = testContext(sandbox.dir);
      const file = writeRawDescriptor(path.join(sandbox.dir, "context"), {
        version: 1,
        environment: { ...context, PATH: "/usr/bin", EXTRA: "not-allowed" },
      });
      expect(() => loadSchedulerContextDescriptor(file, {})).toThrow("Invalid scheduler context");
    } finally {
      sandbox.cleanup();
    }
  });
});
