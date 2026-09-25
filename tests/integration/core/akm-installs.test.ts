// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `enumerateAkmInstalls`: every `akm` on the host, deduped by
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

describe("enumerateAkmInstalls", () => {
  test("finds a standalone install on PATH and reports its version", () => {
    const sandbox = makeSandboxDir("akm-installs-path");
    try {
      writeStubAkm(sandbox.dir, "0.9.17");
      const installs = enumerateAkmInstalls({ PATH: sandbox.dir }, { fixedRoots: [], runningRealpaths: [] });
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
      const installs = enumerateAkmInstalls({ PATH: bunDir }, { fixedRoots: [], runningRealpaths: [] });
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

      const installs = enumerateAkmInstalls({ HOME: sandbox.dir, PATH: "" }, { fixedRoots: [], runningRealpaths: [] });
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
      const installs = enumerateAkmInstalls({ PATH: pnpmDir }, { fixedRoots: [], runningRealpaths: [] });
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
      const installs = enumerateAkmInstalls({ PATH: npmDir }, { fixedRoots: [], runningRealpaths: [] });
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
      const installs = enumerateAkmInstalls({ PATH: binDir }, { fixedRoots: [], runningRealpaths: [] });
      expect(installs).toHaveLength(1);
      expect(installs[0]?.manager).toBe("checkout");
    } finally {
      sandbox.cleanup();
    }
  });

  test("records binDir as the nvm bin dir, not the realpath's own dirname", () => {
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
      // An nvm-bin shim is a real bin-dir candidate, not the direct
      // `akm-cli/dist` scan, so it is linked.
      expect(installs[0]?.linked).toBe(true);
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

      const installs = enumerateAkmInstalls(
        { HOME: sandbox.dir, PATH: pathDir },
        { fixedRoots: [], runningRealpaths: [] },
      );
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
        { fixedRoots: [], runningRealpaths: [fs.realpathSync(runningPath)] },
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
      const installs = enumerateAkmInstalls({ PATH: sandbox.dir }, { fixedRoots: [], runningRealpaths: [] });
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
        { fixedRoots: [], runningRealpaths: [] },
      ),
    ).not.toThrow();
    expect(
      enumerateAkmInstalls(
        { HOME: "/definitely/does/not/exist", PATH: "/also/nowhere", NVM_DIR: "/nope" },
        { fixedRoots: [], runningRealpaths: [] },
      ),
    ).toEqual([]);
  });

  // `fixedRoots` (default `["/usr/local/bin"]`) replaces the
  // old hardcoded `/usr/local/bin` scan so a real standalone install on the
  // host running these tests cannot leak in. This pins the seam itself,
  // independent of whatever `/usr/local/bin` holds on this host: PATH is
  // empty, so the only way the stub can be found is through `fixedRoots`.
  test("fixedRoots scans the given directories unconditionally, regardless of PATH", () => {
    const sandbox = makeSandboxDir("akm-installs-fixed-roots");
    try {
      const fixedDir = path.join(sandbox.dir, "fixed-root");
      const real = writeStubAkm(fixedDir, "0.0.1");
      const installs = enumerateAkmInstalls({ PATH: "" }, { fixedRoots: [fixedDir], runningRealpaths: [] });
      expect(installs).toHaveLength(1);
      expect(installs[0]).toMatchObject({ path: fs.realpathSync(real), version: "0.0.1" });
    } finally {
      sandbox.cleanup();
    }
  });

  // enumeration used to derive an npm global root only for
  // the running node. A `node` on PATH belonging to a different install (an
  // nvm copy, or any other node this process isn't running under) has its
  // own npm global root, and a package installed there is otherwise
  // invisible — even a stray one not linked onto PATH at all.
  test("derives the npm global root of a node found on PATH and reports its install, not on PATH", () => {
    const sandbox = makeSandboxDir("akm-installs-other-node-npm-root");
    try {
      const nodeBinDir = path.join(sandbox.dir, "other-node", "bin");
      fs.mkdirSync(nodeBinDir, { recursive: true });
      const prefixRoot = path.join(sandbox.dir, "scratch-prefix");
      const npmGlobalRoot = path.join(prefixRoot, "lib", "node_modules");
      fs.writeFileSync(path.join(nodeBinDir, "node"), `#!/bin/sh\necho ${JSON.stringify(npmGlobalRoot)}\n`, {
        mode: 0o755,
      });
      // Only needs to exist so resolveAssociatedNpmCli finds a candidate;
      // the fake "node" above ignores argv entirely.
      fs.writeFileSync(path.join(nodeBinDir, "npm"), "", { mode: 0o755 });

      const stub = writeStubAkm(path.join(npmGlobalRoot, "akm-cli", "dist"), "0.9.15-beta.1");

      const installs = enumerateAkmInstalls(
        { PATH: nodeBinDir, HOME: sandbox.dir },
        { fixedRoots: [], runningRealpaths: [] },
      );
      const found = installs.find((i) => i.path === fs.realpathSync(stub));
      expect(found).toMatchObject({
        manager: "npm",
        version: "0.9.15-beta.1",
        binDir: path.join(prefixRoot, "bin"),
        // Nothing links this install onto any bin dir — it was found only
        // through the direct `akm-cli/dist` scan.
        linked: false,
      });
    } finally {
      sandbox.cleanup();
    }
  });

  // when that same npm global root's `bin/` DOES hold a
  // link to the install (a real `npm install -g` result, unlike the orphan
  // case above), the direct `akm-cli/dist` scan finds the same realpath a
  // second time through a non-direct candidate, and `linked` must reflect
  // that — not the direct scan alone.
  test("a prefix bin/ symlink onto the direct akm-cli/dist scan's install gives linked: true", () => {
    const sandbox = makeSandboxDir("akm-installs-linked-bindir");
    try {
      const nodeBinDir = path.join(sandbox.dir, "other-node", "bin");
      fs.mkdirSync(nodeBinDir, { recursive: true });
      const prefixRoot = path.join(sandbox.dir, "scratch-prefix");
      const npmGlobalRoot = path.join(prefixRoot, "lib", "node_modules");
      fs.writeFileSync(path.join(nodeBinDir, "node"), `#!/bin/sh\necho ${JSON.stringify(npmGlobalRoot)}\n`, {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(nodeBinDir, "npm"), "", { mode: 0o755 });

      const stub = writeStubAkm(path.join(npmGlobalRoot, "akm-cli", "dist"), "0.9.15-beta.1");
      const prefixBinDir = path.join(prefixRoot, "bin");
      fs.mkdirSync(prefixBinDir, { recursive: true });
      fs.symlinkSync(stub, path.join(prefixBinDir, "akm"));

      const installs = enumerateAkmInstalls(
        { PATH: nodeBinDir, HOME: sandbox.dir },
        { fixedRoots: [], runningRealpaths: [] },
      );
      const found = installs.find((i) => i.path === fs.realpathSync(stub));
      expect(found).toMatchObject({ manager: "npm", linked: true });
    } finally {
      sandbox.cleanup();
    }
  });

  // a stray `npm install -g` run under the bun-shimmed
  // `node` (`~/.bun/bin/node -> bun`) lands at
  // `${BUN_INSTALL:-~/.bun}/lib/node_modules/akm-cli`, not the bun-global
  // layout, and nothing previously looked there even though it is neither
  // on PATH nor a bun-managed install.
  test("finds a stray npm install under the bun prefix and classifies it npm, not bun", () => {
    const sandbox = makeSandboxDir("akm-installs-bun-prefix-npm");
    try {
      const stub = writeStubAkm(
        path.join(sandbox.dir, ".bun", "lib", "node_modules", "akm-cli", "dist"),
        "0.9.15-beta.1",
      );
      const installs = enumerateAkmInstalls({ HOME: sandbox.dir, PATH: "" }, { fixedRoots: [], runningRealpaths: [] });
      expect(installs).toHaveLength(1);
      expect(installs[0]).toMatchObject({
        path: fs.realpathSync(stub),
        manager: "npm",
        version: "0.9.15-beta.1",
        binDir: path.join(sandbox.dir, ".bun", "bin"),
        // Nothing links this install onto any bin dir — it was found only
        // through the direct `akm-cli/dist` scan.
        linked: false,
      });
    } finally {
      sandbox.cleanup();
    }
  });

  // On Windows npm's global root is `<prefix>\node_modules`, its shims live
  // in the prefix itself, and they are cmd-shim FILES, never symlinks — so
  // the POSIX realpath rule can never mark such an install linked. The
  // `platform` seam exercises that branch on this host.
  function writeWindowsNpmPrefix(sandbox: string, name: string, withShim: boolean): { prefix: string; stub: string } {
    const nodeBinDir = path.join(sandbox, `${name}-node`);
    fs.mkdirSync(nodeBinDir, { recursive: true });
    const prefix = path.join(sandbox, `${name}-prefix`);
    const npmGlobalRoot = path.join(prefix, "node_modules");
    fs.writeFileSync(path.join(nodeBinDir, "node"), `#!/bin/sh\necho ${JSON.stringify(npmGlobalRoot)}\n`, {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(nodeBinDir, "npm"), "", { mode: 0o755 });
    const stub = writeStubAkm(path.join(npmGlobalRoot, "akm-cli", "dist"), "0.9.17");
    if (withShim) fs.writeFileSync(path.join(prefix, "akm.cmd"), "@echo off\r\n");
    return { prefix, stub };
  }

  test("win32: a cmd-shim file in npm's own prefix marks the direct-scan install linked, with the prefix as binDir", () => {
    const sandbox = makeSandboxDir("akm-installs-win32-shim");
    try {
      const { prefix, stub } = writeWindowsNpmPrefix(sandbox.dir, "a", true);
      const installs = enumerateAkmInstalls(
        { PATH: path.join(sandbox.dir, "a-node"), HOME: sandbox.dir },
        { fixedRoots: [], runningRealpaths: [], platform: "win32" },
      );
      const found = installs.find((i) => i.path === fs.realpathSync(stub));
      expect(found).toMatchObject({ manager: "npm", binDir: prefix, linked: true });
    } finally {
      sandbox.cleanup();
    }
  });

  test("win32: without a cmd-shim in the prefix, the direct-scan install stays unlinked", () => {
    const sandbox = makeSandboxDir("akm-installs-win32-noshim");
    try {
      const { prefix, stub } = writeWindowsNpmPrefix(sandbox.dir, "b", false);
      const installs = enumerateAkmInstalls(
        { PATH: path.join(sandbox.dir, "b-node"), HOME: sandbox.dir },
        { fixedRoots: [], runningRealpaths: [], platform: "win32" },
      );
      const found = installs.find((i) => i.path === fs.realpathSync(stub));
      expect(found).toMatchObject({ manager: "npm", binDir: prefix, linked: false });
    } finally {
      sandbox.cleanup();
    }
  });

  // Candidate order must not decide `linked`: an install first reached
  // through one root's direct `akm-cli/dist` scan is promoted when a LATER
  // root's bin dir turns out to link onto it.
  test("a later bin-dir link promotes an install first seen only through the direct scan", () => {
    const sandbox = makeSandboxDir("akm-installs-late-link");
    try {
      const nodeA = path.join(sandbox.dir, "node-a", "bin");
      const nodeB = path.join(sandbox.dir, "node-b", "bin");
      const rootA = path.join(sandbox.dir, "prefix-a", "lib", "node_modules");
      const rootB = path.join(sandbox.dir, "prefix-b", "lib", "node_modules");
      for (const [dir, root] of [
        [nodeA, rootA],
        [nodeB, rootB],
      ] as const) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "node"), `#!/bin/sh\necho ${JSON.stringify(root)}\n`, { mode: 0o755 });
        fs.writeFileSync(path.join(dir, "npm"), "", { mode: 0o755 });
      }
      // Root A holds the package; only root B's bin dir links to it, and
      // root B is discovered after root A (PATH order).
      const stub = writeStubAkm(path.join(rootA, "akm-cli", "dist"), "0.9.17");
      const binB = path.join(sandbox.dir, "prefix-b", "bin");
      fs.mkdirSync(binB, { recursive: true });
      fs.symlinkSync(stub, path.join(binB, "akm"));
      const installs = enumerateAkmInstalls(
        { PATH: [nodeA, nodeB].join(path.delimiter), HOME: sandbox.dir },
        { fixedRoots: [], runningRealpaths: [] },
      );
      const found = installs.find((i) => i.path === fs.realpathSync(stub));
      expect(found).toMatchObject({ manager: "npm", linked: true });
    } finally {
      sandbox.cleanup();
    }
  });
});
