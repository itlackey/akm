import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadSchedulerContextDescriptor } from "../../src/tasks/scheduler-invocation";
import { makeSandboxDir } from "../_helpers/sandbox";

function writeDescriptor(dir: string, value: unknown): string {
  const content = `${JSON.stringify(value)}\n`;
  const digest = createHash("sha256").update(content).digest("hex");
  const file = path.join(dir, `${digest}.json`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

function contextFor(root: string) {
  return {
    version: 1,
    environment: {
      AKM_STASH_DIR: path.join(root, "stash"),
      AKM_CONFIG_DIR: path.join(root, "config"),
      AKM_DATA_DIR: path.join(root, "data"),
      AKM_CACHE_DIR: path.join(root, "cache"),
      AKM_STATE_DIR: path.join(root, "state"),
      PATH: process.env.PATH ?? "",
    },
  };
}

function launcherFixture(root: string): { launcher: string; output: string } {
  const dist = path.join(root, "package", "dist");
  const launcher = path.join(dist, "akm");
  const output = path.join(root, "launcher-output.json");
  fs.mkdirSync(dist, { recursive: true });
  fs.copyFileSync(path.resolve("scripts/node-runtime/akm"), launcher);
  fs.writeFileSync(
    path.join(dist, "cli.js"),
    [
      'import fs from "node:fs";',
      "fs.writeFileSync(process.env.LAUNCHER_TEST_OUTPUT, JSON.stringify({",
      "  argv: process.argv.slice(2),",
      "  configDir: process.env.AKM_CONFIG_DIR,",
      "  launcherNode: process.env.AKM_LAUNCHER_NODE,",
      "  launcherPath: process.env.AKM_LAUNCHER_PATH,",
      "  path: process.env.PATH,",
      "}));",
    ].join("\n"),
  );
  return { launcher, output };
}

function runLauncher(launcher: string, descriptor: string, output: string) {
  return spawnSync(process.execPath, [launcher, "--scheduler-context", descriptor, "sentinel"], {
    encoding: "utf8",
    env: { ...process.env, LAUNCHER_TEST_OUTPUT: output, AKM_CONFIG_DIR: "/ambient/wrong-config" },
  });
}

function expectLauncherConfigFailure(result: ReturnType<typeof runLauncher>, expectedMessage: string): void {
  expect(result.status).toBe(78);
  expect(result.stderr).toContain(expectedMessage);
  expect(result.stderr).toStartWith("akm: ");
  expect(result.stderr).not.toMatch(/\n\s+at\s/);
}

describe("package scheduler context launcher", () => {
  test("loads context before runtime selection and removes the hidden argument", () => {
    const sandbox = makeSandboxDir("akm-scheduler-launcher-");
    try {
      const descriptor = contextFor(sandbox.dir);
      fs.mkdirSync(descriptor.environment.AKM_STASH_DIR, { recursive: true });
      const file = writeDescriptor(path.join(sandbox.dir, "context"), descriptor);
      const fixture = launcherFixture(sandbox.dir);

      const result = runLauncher(fixture.launcher, file, fixture.output);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(fixture.output, "utf8"))).toEqual({
        argv: ["sentinel"],
        configDir: descriptor.environment.AKM_CONFIG_DIR,
        launcherNode: process.execPath,
        launcherPath: fixture.launcher,
        path: descriptor.environment.PATH,
      });
    } finally {
      sandbox.cleanup();
    }
  });

  test("rejects the same hash, symlink, permission, and schema violations as the CLI loader", () => {
    const sandbox = makeSandboxDir("akm-scheduler-launcher-reject-");
    try {
      const descriptor = contextFor(sandbox.dir);
      fs.mkdirSync(descriptor.environment.AKM_STASH_DIR, { recursive: true });
      const fixture = launcherFixture(sandbox.dir);

      const tampered = writeDescriptor(path.join(sandbox.dir, "tampered"), descriptor);
      fs.writeFileSync(tampered, fs.readFileSync(tampered, "utf8").replace('"PATH":"', '"PATH":"/tampered:'), {
        mode: 0o600,
      });
      expect(() => loadSchedulerContextDescriptor(tampered, {})).toThrow("content SHA-256");
      expectLauncherConfigFailure(runLauncher(fixture.launcher, tampered, fixture.output), "content SHA-256");

      const valid = writeDescriptor(path.join(sandbox.dir, "valid"), descriptor);
      if (process.platform !== "win32") {
        const symlinkDir = path.join(sandbox.dir, "symlink");
        fs.mkdirSync(symlinkDir);
        const symlink = path.join(symlinkDir, path.basename(valid));
        fs.symlinkSync(valid, symlink);
        expect(() => loadSchedulerContextDescriptor(symlink, {})).toThrow("symbolic links");
        expectLauncherConfigFailure(runLauncher(fixture.launcher, symlink, fixture.output), "symbolic links");
      }

      if (process.platform !== "win32") {
        fs.chmodSync(valid, 0o644);
        expect(() => loadSchedulerContextDescriptor(valid, {})).toThrow("group or other permissions");
        expectLauncherConfigFailure(runLauncher(fixture.launcher, valid, fixture.output), "group or other permissions");
      }

      const invalidSchema = writeDescriptor(path.join(sandbox.dir, "schema"), {
        ...descriptor,
        unexpected: true,
      });
      expect(() => loadSchedulerContextDescriptor(invalidSchema, {})).toThrow("Invalid scheduler context");
      expectLauncherConfigFailure(
        runLauncher(fixture.launcher, invalidSchema, fixture.output),
        "expected the scheduler context v1 schema",
      );
    } finally {
      sandbox.cleanup();
    }
  });
});

test("standalone/direct CLI bootstrap applies scheduler context before config resolution", () => {
  const sandbox = makeSandboxDir("akm-scheduler-direct-cli-");
  try {
    const descriptor = contextFor(sandbox.dir);
    fs.mkdirSync(descriptor.environment.AKM_STASH_DIR, { recursive: true });
    fs.mkdirSync(descriptor.environment.AKM_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(descriptor.environment.AKM_CONFIG_DIR, "config.json"),
      `${JSON.stringify({
        configVersion: "0.9.0",
        bundles: { stash: { path: descriptor.environment.AKM_STASH_DIR } },
        defaultBundle: "stash",
        semanticSearchMode: "off",
      })}\n`,
      { mode: 0o600 },
    );
    const ambientConfig = path.join(sandbox.dir, "ambient-config");
    fs.mkdirSync(ambientConfig);
    fs.writeFileSync(path.join(ambientConfig, "config.json"), "{ invalid json");
    const file = writeDescriptor(path.join(sandbox.dir, "context"), descriptor);

    const result = spawnSync(
      process.execPath,
      [path.resolve("src/cli.ts"), "--scheduler-context", file, "tasks", "doctor", "--format=json"],
      {
        encoding: "utf8",
        env: { ...process.env, BUN_TEST: "1", AKM_CONFIG_DIR: ambientConfig },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).warnings).toContain(
      "Native scheduler inspection is skipped inside the bun test harness.",
    );

    const tampered = writeDescriptor(path.join(sandbox.dir, "tampered-context"), descriptor);
    fs.writeFileSync(tampered, fs.readFileSync(tampered, "utf8").replace('"PATH":"', '"PATH":"/tampered:'), {
      mode: 0o600,
    });
    const invalidResult = spawnSync(
      process.execPath,
      [path.resolve("src/cli.ts"), "--scheduler-context", tampered, "tasks", "doctor", "--format=json"],
      {
        encoding: "utf8",
        env: { ...process.env, BUN_TEST: "1", AKM_CONFIG_DIR: ambientConfig },
      },
    );
    expect(invalidResult.status).toBe(78);
    expect(JSON.parse(invalidResult.stderr)).toMatchObject({
      ok: false,
      code: "INVALID_CONFIG_FILE",
      error: expect.stringContaining("content SHA-256"),
    });
  } finally {
    sandbox.cleanup();
  }
});
