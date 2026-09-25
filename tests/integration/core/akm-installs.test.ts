// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `enumerateAkmInstalls` (upgrade-D D3): every `akm` on the host, deduped by
 * realpath and classified. Runs real stub `akm` scripts under a sandbox
 * `PATH` and fake install roots — a real process spawn for the `--version`
 * probe, hence tests/integration (never a real db or the network).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { enumerateAkmInstalls } from "../../../src/core/akm-installs";
import { makeSandboxDir } from "../../_helpers/sandbox";

/** Writes an executable shell stub that prints `version` for `--version` and exits 0. */
function writeStubAkm(dir: string, version: string, filename = "akm"): string {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, filename);
  fs.writeFileSync(target, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  return target;
}

describe("enumerateAkmInstalls (upgrade-D D3)", () => {
  test("finds a standalone install on PATH and reports its version", () => {
    const sandbox = makeSandboxDir("akm-installs-path");
    try {
      writeStubAkm(sandbox.dir, "0.9.17");
      const installs = enumerateAkmInstalls({ PATH: sandbox.dir }, { runningRealpaths: [] });
      expect(installs).toHaveLength(1);
      expect(installs[0]).toMatchObject({
        path: fs.realpathSync(path.join(sandbox.dir, "akm")),
        manager: "standalone",
        version: "0.9.17",
        isRunning: false,
      });
    } finally {
      sandbox.cleanup();
    }
  });

  test("classifies a bun-global node_modules layout as bun", () => {
    const sandbox = makeSandboxDir("akm-installs-bun");
    try {
      const bunDir = path.join(sandbox.dir, ".bun", "install", "global", "node_modules", "akm-cli", "bin");
      writeStubAkm(bunDir, "0.9.15");
      const installs = enumerateAkmInstalls({ PATH: bunDir }, { runningRealpaths: [] });
      expect(installs).toHaveLength(1);
      expect(installs[0]?.manager).toBe("bun");
    } finally {
      sandbox.cleanup();
    }
  });

  test("finds the bun-global shim through the known ~/.bun/bin root, not just PATH", () => {
    const sandbox = makeSandboxDir("akm-installs-bun-root");
    try {
      const bunDir = path.join(sandbox.dir, ".bun", "install", "global", "node_modules", "akm-cli", "bin");
      const real = writeStubAkm(bunDir, "0.9.15");
      const shimDir = path.join(sandbox.dir, ".bun", "bin");
      fs.mkdirSync(shimDir, { recursive: true });
      fs.symlinkSync(real, path.join(shimDir, "akm"));

      const installs = enumerateAkmInstalls({ HOME: sandbox.dir, PATH: "" }, { runningRealpaths: [] });
      expect(installs).toHaveLength(1);
      expect(installs[0]).toMatchObject({ manager: "bun", version: "0.9.15" });
    } finally {
      sandbox.cleanup();
    }
  });

  test("classifies a pnpm global store layout as pnpm", () => {
    const sandbox = makeSandboxDir("akm-installs-pnpm");
    try {
      const pnpmDir = path.join(sandbox.dir, "pnpm", "global", "5", "node_modules", "akm-cli", "bin");
      writeStubAkm(pnpmDir, "0.9.15");
      const installs = enumerateAkmInstalls({ PATH: pnpmDir }, { runningRealpaths: [] });
      expect(installs).toHaveLength(1);
      expect(installs[0]?.manager).toBe("pnpm");
    } finally {
      sandbox.cleanup();
    }
  });

  test("classifies a generic node_modules layout as npm", () => {
    const sandbox = makeSandboxDir("akm-installs-npm");
    try {
      const npmDir = path.join(sandbox.dir, "lib", "node_modules", "akm-cli", "bin");
      writeStubAkm(npmDir, "0.9.15");
      const installs = enumerateAkmInstalls({ PATH: npmDir }, { runningRealpaths: [] });
      expect(installs).toHaveLength(1);
      expect(installs[0]?.manager).toBe("npm");
    } finally {
      sandbox.cleanup();
    }
  });

  test("classifies an install under a .git checkout as checkout", () => {
    const sandbox = makeSandboxDir("akm-installs-checkout");
    try {
      const repoRoot = path.join(sandbox.dir, "repo");
      fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
      const binDir = path.join(repoRoot, "dist");
      writeStubAkm(binDir, "0.9.16-dev");
      const installs = enumerateAkmInstalls({ PATH: binDir }, { runningRealpaths: [] });
      expect(installs).toHaveLength(1);
      expect(installs[0]?.manager).toBe("checkout");
    } finally {
      sandbox.cleanup();
    }
  });

  test("records binDir as the nvm bin dir, not the realpath's own dirname (upgrade-D D3 r2-1)", () => {
    const sandbox = makeSandboxDir("akm-installs-nvm-bindir");
    try {
      const nvmDir = path.join(sandbox.dir, ".nvm");
      const versionDir = path.join(nvmDir, "versions", "node", "v24.18.0");
      const real = writeStubAkm(path.join(versionDir, "lib", "node_modules", "akm-cli", "dist"), "0.9.17");
      const binDir = path.join(versionDir, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      fs.symlinkSync(real, path.join(binDir, "akm"));

      const installs = enumerateAkmInstalls({ HOME: sandbox.dir, PATH: "", NVM_DIR: nvmDir }, { runningRealpaths: [] });
      expect(installs).toHaveLength(1);
      expect(installs[0]?.path).toBe(fs.realpathSync(real));
      expect(installs[0]?.binDir).toBe(binDir);
    } finally {
      sandbox.cleanup();
    }
  });

  test("dedupes a PATH shim and a known root that resolve to the same realpath", () => {
    const sandbox = makeSandboxDir("akm-installs-dedupe");
    try {
      const targetDir = path.join(sandbox.dir, "target");
      const real = writeStubAkm(targetDir, "0.9.17");

      const pathDir = path.join(sandbox.dir, "on-path");
      fs.mkdirSync(pathDir, { recursive: true });
      fs.symlinkSync(real, path.join(pathDir, "akm"));

      const localBinDir = path.join(sandbox.dir, ".local", "bin");
      fs.mkdirSync(localBinDir, { recursive: true });
      fs.symlinkSync(real, path.join(localBinDir, "akm"));

      const installs = enumerateAkmInstalls({ HOME: sandbox.dir, PATH: pathDir }, { runningRealpaths: [] });
      expect(installs).toHaveLength(1);
      expect(installs[0]?.path).toBe(fs.realpathSync(real));
    } finally {
      sandbox.cleanup();
    }
  });

  test("marks the install matching a given running realpath", () => {
    const sandbox = makeSandboxDir("akm-installs-running");
    try {
      const runningPath = writeStubAkm(path.join(sandbox.dir, "running"), "0.9.17");
      writeStubAkm(path.join(sandbox.dir, "other"), "0.9.16");
      const installs = enumerateAkmInstalls(
        { PATH: [path.join(sandbox.dir, "running"), path.join(sandbox.dir, "other")].join(path.delimiter) },
        { runningRealpaths: [fs.realpathSync(runningPath)] },
      );
      expect(installs).toHaveLength(2);
      const running = installs.find((i) => i.isRunning);
      const notRunning = installs.find((i) => !i.isRunning);
      expect(running?.version).toBe("0.9.17");
      expect(notRunning?.version).toBe("0.9.16");
    } finally {
      sandbox.cleanup();
    }
  });

  test("a failing --version probe reports version undefined rather than throwing", () => {
    const sandbox = makeSandboxDir("akm-installs-fail");
    try {
      fs.mkdirSync(sandbox.dir, { recursive: true });
      const target = path.join(sandbox.dir, "akm");
      fs.writeFileSync(target, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const installs = enumerateAkmInstalls({ PATH: sandbox.dir }, { runningRealpaths: [] });
      expect(installs).toHaveLength(1);
      expect(installs[0]?.version).toBeUndefined();
    } finally {
      sandbox.cleanup();
    }
  });

  test("a nonexistent PATH entry and a nonexistent known root are skipped, not thrown", () => {
    expect(() =>
      enumerateAkmInstalls(
        { HOME: "/definitely/does/not/exist", PATH: "/also/nowhere", NVM_DIR: "/nope" },
        { runningRealpaths: [] },
      ),
    ).not.toThrow();
    expect(
      enumerateAkmInstalls(
        { HOME: "/definitely/does/not/exist", PATH: "/also/nowhere", NVM_DIR: "/nope" },
        { runningRealpaths: [] },
      ),
    ).toEqual([]);
  });
});
