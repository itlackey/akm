import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm package launcher "));
const packageDir = path.join(testRoot, "package with spaces");
const consumerDir = path.join(testRoot, "consumer with spaces");
const nodeOnlyPathDir = path.join(testRoot, "node path");
const oldBunPathDir = path.join(testRoot, "old bun path");
const unusableBunPathDir = path.join(testRoot, "unusable bun path");
const windowsShimDir = path.join(testRoot, "generated windows shims");
const launcher = path.join(packageDir, "akm");
const migrateLauncher = path.join(packageDir, "akm-migrate-storage");

const launchers = [
  { bin: "akm-fixture", bunArtifact: "bun-cli", nodeArtifact: "node-cli" },
  {
    bin: "akm-migrate-fixture",
    bunArtifact: "bun-migrate",
    nodeArtifact: "node-migrate",
  },
];

function result(stdout: Uint8Array): { artifact: string; args: string[] } {
  const line = new TextDecoder().decode(stdout).trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error("Package launcher produced no output");
  return JSON.parse(line);
}

function installedShim(bin: string): string {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return path.join(consumerDir, "node_modules", ".bin", `${bin}${suffix}`);
}

function runtimePath(...commands: string[]): string {
  return [...new Set(commands.map((command) => path.dirname(command)))].join(path.delimiter);
}

function fakeBun(dir: string, version: string, versionExitCode = 0): string {
  const executable = path.join(dir, "bun");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      'if (process.argv[2] === "--version") {',
      `  console.log(${JSON.stringify(version)});`,
      `  process.exit(${versionExitCode});`,
      "}",
      'console.log(JSON.stringify({ artifact: "unexpected-bun", args: process.argv.slice(2) }));',
      "",
    ].join("\n"),
  );
  fs.chmodSync(executable, 0o755);
  return executable;
}

async function generateWindowsShims(): Promise<void> {
  const cmdShim = createRequire(import.meta.url)("cmd-shim") as (from: string, to: string) => Promise<void>;

  fs.mkdirSync(windowsShimDir, { recursive: true });
  await Promise.all(
    launchers.map((testCase) =>
      cmdShim(
        path.join(packageDir, testCase.bin === "akm-fixture" ? "akm" : "akm-migrate-storage"),
        path.join(windowsShimDir, testCase.bin),
      ),
    ),
  );
}

function launchThroughNpmShim(bin: string, pathValue: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  return Bun.spawnSync([installedShim(bin), "argument with spaces"], {
    cwd: consumerDir,
    env: { ...env, PATH: pathValue },
    stdout: "pipe",
    stderr: "pipe",
  });
}

beforeAll(async () => {
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(consumerDir, { recursive: true });
  fs.mkdirSync(nodeOnlyPathDir, { recursive: true });
  fs.mkdirSync(path.join(packageDir, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", "akm"), launcher);
  fs.copyFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", "akm-migrate-storage"), migrateLauncher);
  fs.chmodSync(launcher, 0o755);
  fs.chmodSync(migrateLauncher, 0o755);
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "akm-launcher-fixture",
      version: "1.0.0",
      type: "module",
      bin: { "akm-fixture": "akm", "akm-migrate-fixture": "akm-migrate-storage" },
    }),
  );
  fs.writeFileSync(
    path.join(packageDir, "cli.js"),
    'console.log(JSON.stringify({ artifact: "bun-cli", args: process.argv.slice(2) }));\n',
  );
  fs.writeFileSync(
    path.join(packageDir, "cli-node.mjs"),
    'console.log(JSON.stringify({ artifact: "node-cli", args: process.argv.slice(2) }));\n',
  );
  fs.writeFileSync(
    path.join(packageDir, "scripts", "migrate-storage.js"),
    'console.log(JSON.stringify({ artifact: "bun-migrate", args: process.argv.slice(2) }));\n',
  );
  fs.writeFileSync(
    path.join(packageDir, "migrate-storage-node.mjs"),
    'console.log(JSON.stringify({ artifact: "node-migrate", args: process.argv.slice(2) }));\n',
  );
  fs.writeFileSync(path.join(consumerDir, "package.json"), JSON.stringify({ name: "consumer", private: true }));

  const npm = Bun.which("npm");
  if (!npm) throw new Error("npm is required for the package launcher contract test");
  const installed = Bun.spawnSync(
    [npm, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline", packageDir],
    { cwd: consumerDir, stdout: "pipe", stderr: "pipe" },
  );
  if (installed.exitCode !== 0) {
    throw new Error(`npm fixture install failed: ${new TextDecoder().decode(installed.stderr)}`);
  }

  const node = Bun.which("node");
  if (!node) throw new Error("Node.js is required for the package launcher contract test");
  const isolatedNode = path.join(nodeOnlyPathDir, process.platform === "win32" ? "node.exe" : "node");
  fs.symlinkSync(fs.realpathSync(node), isolatedNode);

  fakeBun(oldBunPathDir, "0.9.9");
  fakeBun(unusableBunPathDir, "bun probe failed", 1);
  await generateWindowsShims();
});

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("package launcher", () => {
  test("prefers Bun from npm's generated platform shims when package paths contain spaces", () => {
    const node = Bun.which("node");
    const bun = Bun.which("bun");
    if (!node || !bun) throw new Error("Node.js and Bun are required for the package launcher contract test");

    for (const testCase of launchers) {
      const launched = launchThroughNpmShim(testCase.bin, runtimePath(node, bun));

      expect(new TextDecoder().decode(launched.stderr)).toBe("");
      expect(launched.exitCode).toBe(0);
      expect(result(launched.stdout)).toEqual({
        artifact: testCase.bunArtifact,
        args: ["argument with spaces"],
      });
    }
  });

  test("npm's generated platform shims fall back to Node wrappers when Bun is unavailable", () => {
    for (const testCase of launchers) {
      const launched = launchThroughNpmShim(testCase.bin, nodeOnlyPathDir);

      expect(new TextDecoder().decode(launched.stderr)).toBe("");
      expect(launched.exitCode).toBe(0);
      expect(result(launched.stdout)).toEqual({
        artifact: testCase.nodeArtifact,
        args: ["argument with spaces"],
      });
    }
  });

  test("falls back to Node when Bun is below the supported floor or unusable", () => {
    const node = Bun.which("node");
    if (!node) throw new Error("Node.js is required for the package launcher contract test");

    for (const bunDir of [oldBunPathDir, unusableBunPathDir]) {
      for (const testCase of launchers) {
        const launched = launchThroughNpmShim(testCase.bin, runtimePath(node, path.join(bunDir, "bun")));

        expect(new TextDecoder().decode(launched.stderr)).toBe("");
        expect(launched.exitCode).toBe(0);
        expect(result(launched.stdout)).toEqual({
          artifact: testCase.nodeArtifact,
          args: ["argument with spaces"],
        });
      }
    }
  });

  test("npm's generated Windows shims preserve the Node bootstrap contract", () => {
    for (const testCase of launchers) {
      const shim = fs.readFileSync(path.join(windowsShimDir, `${testCase.bin}.cmd`), "utf8");

      expect(shim).toContain('SET "_prog=node"');
      expect(shim).toContain("%*");
      expect(shim).toContain(testCase.bin === "akm-fixture" ? "akm" : "akm-migrate-storage");
      expect(shim).toContain(`package with spaces\\${testCase.bin === "akm-fixture" ? "akm" : "akm-migrate-storage"}`);
      expect(shim).not.toContain("bun.exe");
    }
  });
});
