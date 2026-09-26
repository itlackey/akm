import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
      AKM_BUNDLE_DIR: path.join(root, "stash"),
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

describe("package scheduler context launcher", () => {
  test("passes --scheduler-context through to the CLI, which loads and validates it", () => {
    const sandbox = makeSandboxDir("akm-scheduler-launcher-");
    try {
      // A current descriptor carries only the bundle path. The launcher used to
      // re-validate it against the old five-directory schema and refuse every
      // descriptor 0.9.17 writes; it now leaves loading to the CLI.
      const file = writeDescriptor(path.join(sandbox.dir, "context"), {
        version: 1,
        environment: { AKM_BUNDLE_DIR: path.join(sandbox.dir, "stash") },
      });
      const fixture = launcherFixture(sandbox.dir);

      const result = runLauncher(fixture.launcher, file, fixture.output);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(fixture.output, "utf8"))).toEqual({
        argv: ["--scheduler-context", file, "sentinel"],
        configDir: "/ambient/wrong-config",
        launcherNode: process.execPath,
        launcherPath: fixture.launcher,
        path: process.env.PATH,
      });
    } finally {
      sandbox.cleanup();
    }
  });
});

test("standalone/direct CLI bootstrap applies scheduler context before config resolution", () => {
  const sandbox = makeSandboxDir("akm-scheduler-direct-cli-");
  try {
    const descriptor = contextFor(sandbox.dir);
    fs.mkdirSync(descriptor.environment.AKM_BUNDLE_DIR, { recursive: true });
    fs.mkdirSync(descriptor.environment.AKM_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(descriptor.environment.AKM_CONFIG_DIR, "config.json"),
      `${JSON.stringify({
        configVersion: "0.9.0",
        bundles: { stash: { path: descriptor.environment.AKM_BUNDLE_DIR } },
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
      [path.resolve("src/cli.ts"), "--scheduler-context", file, "task", "doctor", "--format=json"],
      {
        encoding: "utf8",
        env: { ...process.env, BUN_TEST: "1", AKM_CONFIG_DIR: ambientConfig },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).warnings).toContain(
      "Native scheduler inspection is skipped inside the bun test harness.",
    );

    // A current descriptor (bundle path only) bootstraps too; directories it
    // does not carry resolve from the fire-time environment.
    const minimal = writeDescriptor(path.join(sandbox.dir, "minimal-context"), {
      version: 1,
      environment: { AKM_BUNDLE_DIR: descriptor.environment.AKM_BUNDLE_DIR },
    });
    const minimalResult = spawnSync(
      process.execPath,
      [path.resolve("src/cli.ts"), "--scheduler-context", minimal, "task", "doctor", "--format=json"],
      {
        encoding: "utf8",
        env: { ...process.env, BUN_TEST: "1", AKM_CONFIG_DIR: descriptor.environment.AKM_CONFIG_DIR },
      },
    );
    expect(minimalResult.status, minimalResult.stderr).toBe(0);

    const tampered = writeDescriptor(path.join(sandbox.dir, "tampered-context"), descriptor);
    fs.writeFileSync(tampered, fs.readFileSync(tampered, "utf8").replace('"PATH":"', '"PATH":"/tampered:'), {
      mode: 0o600,
    });
    const invalidResult = spawnSync(
      process.execPath,
      [path.resolve("src/cli.ts"), "--scheduler-context", tampered, "task", "doctor", "--format=json"],
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
