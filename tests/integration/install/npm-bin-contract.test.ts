import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { realNodeExecutable } from "../../_helpers/node-runtime";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const NPM_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?((?:[^ \t=]+=[^ \t=]+\s+)*))?([^ \t]+)(.*)$/;

function npmShimInterpreter(source: string): string | undefined {
  return source.trim().split(/\r*\n/, 1)[0]?.match(NPM_SHEBANG)?.[2];
}

function runAsNodeVersion(version: string, program: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    realNodeExecutable(),
    [
      "--input-type=module",
      "--eval",
      `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)}, configurable: true });\n${program}`,
    ],
    { encoding: "utf8", env: { PATH: path.dirname(realNodeExecutable()) } },
  );
}

function launcherFixture(bin: "akm" | "akm-migrate"): { launcher: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-node-runtime-minimum-"));
  const launcher = path.join(root, bin);
  fs.copyFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", bin), launcher);
  if (bin === "akm") {
    fs.writeFileSync(path.join(root, "cli-node.mjs"), 'console.log("NODE_22_LAUNCHER_RAN");\n');
  } else {
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "akm-migrate-node.js"), 'console.log("NODE_22_LAUNCHER_RAN");\n');
  }
  return { launcher, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("npm bin contract", () => {
  test("uses Node as the single interpreter shared by npm's POSIX and Windows shims", () => {
    for (const bin of ["akm", "akm-migrate"]) {
      const launcher = fs.readFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", bin), "utf8");

      // POSIX executes this shebang and npm embeds the same interpreter in its
      // generated Windows shims. It cannot express a Bun-or-Node choice.
      expect(npmShimInterpreter(launcher)).toBe("node");
    }
  });

  test("declares the Node bootstrap required before Bun can be preferred", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      engines?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(pkg.engines).toEqual({ node: ">=22" });
    // npm 12 blocks install scripts by default, so the floor is checked where akm starts (the launchers, the CLI).
    expect(pkg.scripts?.preinstall).toBeUndefined();
    expect(pkg.scripts?.install).toBeUndefined();
    expect(pkg.scripts?.postinstall).toBeUndefined();
  });

  test("published bins select their supported runtime paths after the Node bootstrap", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };

    expect(pkg.bin?.akm).toBe("dist/akm");
    expect(pkg.bin?.["akm-migrate"]).toBe("dist/akm-migrate");

    const akmLauncher = fs.readFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", "akm"), "utf8");
    expect(akmLauncher.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(akmLauncher).toContain("requires Node.js >= 22 to bootstrap");
    expect(akmLauncher).toContain('new URL("./cli.js", import.meta.url)');
    expect(akmLauncher).toContain('await import("./cli-node.mjs")');

    const migrateLauncher = fs.readFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", "akm-migrate"), "utf8");
    expect(migrateLauncher.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(migrateLauncher).toContain("requires Node.js >= 22 to bootstrap");
    expect(migrateLauncher).toContain('new URL("./scripts/akm-migrate.js", import.meta.url)');
    expect(migrateLauncher).toContain('new URL("./scripts/akm-migrate-node.js", import.meta.url)');
    expect(migrateLauncher).toContain('process.versions.bun ? process.execPath : useBun ? "bun" : process.execPath');
    expect(migrateLauncher).toContain("process.versions.bun || useBun ? bunEntry : nodeEntry");
    expect(migrateLauncher).not.toContain("migrate-storage-node.mjs");

    const wrapper = fs.readFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", "cli-node.mjs"), "utf8");
    expect(wrapper.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, "scripts", "node-runtime", "akm-migrate-storage"))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, "scripts", "node-runtime", "migrate-storage-node.mjs"))).toBe(false);

    for (const launcherSource of [akmLauncher, migrateLauncher]) {
      expect(launcherSource).toContain('"bun", ["--version"]');
      expect(launcherSource).toContain("bunMajor >= 1");
    }
  });

  test("rejects Node 20 (below the 22 floor) before either published launcher can execute its payload", () => {
    for (const bin of ["akm", "akm-migrate"] as const) {
      const fixture = launcherFixture(bin);
      try {
        const result = runAsNodeVersion(
          "20.0.0",
          `await import(${JSON.stringify(pathToFileURL(fixture.launcher).href)});`,
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("requires Node.js >= 22 to bootstrap");
        expect(result.stdout).not.toContain("NODE_22_LAUNCHER_RAN");
      } finally {
        fixture.cleanup();
      }
    }
  });
});
