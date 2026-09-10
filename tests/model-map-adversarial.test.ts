// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, UsageError } from "../src/core/errors";
import {
  copyDefaultModelMap,
  loadModelMap,
  mergeModelMapLayers,
  parseModelMapLayer,
  readInstalledModelMapText,
} from "../src/integrations/agent/model-map";

function makeRoot(label: string): { root: string; env: NodeJS.ProcessEnv; target: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
  return {
    root,
    env: { AKM_CONFIG_DIR: root },
    target: path.join(root, "models.json"),
  };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`raw-${code}-sentinel`), { code });
}

function expectConfigError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe("INVALID_CONFIG_FILE");
    return error as ConfigError;
  }
  throw new Error("expected ConfigError");
}

function expectAlreadyExists(fn: () => unknown): UsageError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("RESOURCE_ALREADY_EXISTS");
    return error as UsageError;
  }
  throw new Error("expected UsageError");
}

describe("models.json bounded safe loader", () => {
  test("treats a dangling symlink the same as true absence", () => {
    const sandbox = makeRoot("models-dangling");
    try {
      fs.symlinkSync(path.join(sandbox.root, "missing.json"), sandbox.target);
      expect(() => loadModelMap({ env: sandbox.env })).not.toThrow();
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  test("reads through a valid symlink instead of refusing it", () => {
    const sandbox = makeRoot("models-valid-symlink");
    const real = path.join(sandbox.root, "real-models.json");
    try {
      fs.writeFileSync(real, JSON.stringify({ version: 1, aliases: { fast: { claude: "via-symlink-802" } } }));
      fs.symlinkSync(real, sandbox.target);
      const { map } = loadModelMap({ env: sandbox.env });
      expect(map.aliases.fast?.claude).toEqual({ model: "via-symlink-802" });
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  test("does not follow a symlink swapped in between lstat and descriptor open", () => {
    const sandbox = makeRoot("models-read-symlink-race");
    const victim = path.join(sandbox.root, "victim.json");
    const originalOpen = fs.openSync.bind(fs);
    try {
      fs.writeFileSync(sandbox.target, '{"version":1,"aliases":{"fast":{"claude":"safe"}}}');
      fs.writeFileSync(victim, '{"version":1,"aliases":{"fast":{"claude":"VICTIMREADSECRET802"}}}');
      const open = spyOn(fs, "openSync");
      let raced = false;
      open.mockImplementation(((candidate: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (path.resolve(String(candidate)) === path.resolve(sandbox.target) && !raced) {
          raced = true;
          fs.unlinkSync(sandbox.target);
          fs.symlinkSync(victim, sandbox.target);
        }
        return originalOpen(candidate, flags, mode);
      }) as typeof fs.openSync);

      const error = expectConfigError(() => loadModelMap({ env: sandbox.env }));
      expect(error.message).not.toContain("VICTIMREADSECRET802");
      expect(fs.lstatSync(sandbox.target).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  });
});

describe("models.json diagnostic secrecy", () => {
  test("does not echo an invalid version value", () => {
    const sentinel = "VERSION-SECRET-SENTINEL-802";
    const error = expectConfigError(() =>
      parseModelMapLayer(JSON.stringify({ version: sentinel, aliases: {} }), "user models.json"),
    );
    expect(error.message).not.toContain(sentinel);
    expect(error.message).toContain("$.version");
  });

  test("does not echo parser snippets from invalid JSON", () => {
    const sentinel = "JSONPARSESECRETSENTINEL802";
    const error = expectConfigError(() => parseModelMapLayer(sentinel, "user models.json"));
    expect(error.message).not.toContain(sentinel);
    expect(error.message).toMatch(/invalid JSON/i);
  });
});

describe("models.json engine indirection (#946)", () => {
  test("rejects model and engine set together in one profile", () => {
    const error = expectConfigError(() =>
      parseModelMapLayer(
        JSON.stringify({ version: 1, aliases: { fast: { opencode: { model: "x", engine: "local-fast" } } } }),
        "models.json",
      ),
    );
    expect(error.message).toMatch(/model and engine cannot both be set/i);
  });

  test("rejects an engine reference that is not lowercase kebab-case", () => {
    const error = expectConfigError(() =>
      parseModelMapLayer(
        JSON.stringify({ version: 1, aliases: { fast: { opencode: { engine: "Local Fast!" } } } }),
        "models.json",
      ),
    );
    expect(error.message).toMatch(/engine.*lowercase kebab-case/i);
  });

  test("rejects a profile with none of model, inference, or engine", () => {
    const error = expectConfigError(() =>
      parseModelMapLayer(JSON.stringify({ version: 1, aliases: { fast: { opencode: {} } } }), "models.json"),
    );
    expect(error.message).toMatch(/model, inference, and\/or engine/i);
  });

  test("names the missing engine when resolving against an unknown reference", () => {
    const installed = parseModelMapLayer(
      JSON.stringify({ version: 1, aliases: { fast: { opencode: { engine: "local-fast" } } } }),
      "installed models.json",
    );
    const error = expectConfigError(() => mergeModelMapLayers(installed, undefined, {}));
    expect(error.message).toMatch(/fast\.opencode\.engine/);
    expect(error.message).toMatch(/unknown engine "local-fast"/);
  });

  test("names the referencing engine when it carries no usable model", () => {
    const installed = parseModelMapLayer(
      JSON.stringify({ version: 1, aliases: { fast: { opencode: { engine: "bare-agent" } } } }),
      "installed models.json",
    );
    const engines = {
      "bare-agent": { kind: "agent" as const, platform: "opencode" as const },
    };
    const error = expectConfigError(() => mergeModelMapLayers(installed, undefined, engines));
    expect(error.message).toMatch(/engine "bare-agent" has no usable model/);
  });
});

describe("models copy-defaults atomic publication", () => {
  test("never clobbers a target created after the absence check", () => {
    const sandbox = makeRoot("models-create-race");
    const originalLstat = fs.lstatSync.bind(fs);
    try {
      const lstat = spyOn(fs, "lstatSync");
      let raced = false;
      lstat.mockImplementation(((candidate: fs.PathLike) => {
        if (path.resolve(String(candidate)) === path.resolve(sandbox.target) && !raced) {
          raced = true;
          fs.writeFileSync(sandbox.target, "attacker-created-after-ENOENT", { mode: 0o600 });
          throw errno("ENOENT");
        }
        return originalLstat(candidate);
      }) as typeof fs.lstatSync);

      expectAlreadyExists(() => copyDefaultModelMap({ env: sandbox.env }));
      expect(fs.readFileSync(sandbox.target, "utf8")).toBe("attacker-created-after-ENOENT");
      lstat.mockRestore();
      expect(originalLstat(sandbox.target).isFile()).toBe(true);
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  test("fails closed when an overwrite target changes from a regular file to a symlink", () => {
    const sandbox = makeRoot("models-overwrite-race");
    const victim = path.join(sandbox.root, "victim.json");
    const originalLstat = fs.lstatSync.bind(fs);
    try {
      fs.writeFileSync(sandbox.target, "original-target", { mode: 0o600 });
      fs.writeFileSync(victim, "victim-bytes", { mode: 0o600 });
      const lstat = spyOn(fs, "lstatSync");
      let raced = false;
      lstat.mockImplementation(((candidate: fs.PathLike) => {
        const stat = originalLstat(candidate);
        if (path.resolve(String(candidate)) === path.resolve(sandbox.target) && !raced) {
          raced = true;
          fs.unlinkSync(sandbox.target);
          fs.symlinkSync(victim, sandbox.target);
        }
        return stat;
      }) as typeof fs.lstatSync);

      expectAlreadyExists(() => copyDefaultModelMap({ env: sandbox.env, overwrite: true }));
      expect(fs.readFileSync(victim, "utf8")).toBe("victim-bytes");
      expect(originalLstat(sandbox.target).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  test("never follows a symlink inserted in the portable post-check rename window", () => {
    const sandbox = makeRoot("models-overwrite-post-check-race");
    const victim = path.join(sandbox.root, "victim.json");
    const originalRename = fs.renameSync.bind(fs);
    try {
      fs.writeFileSync(sandbox.target, "original-target", { mode: 0o600 });
      fs.writeFileSync(victim, "victim-bytes", { mode: 0o600 });
      const rename = spyOn(fs, "renameSync");
      rename.mockImplementation(((source: fs.PathLike, destination: fs.PathLike) => {
        if (path.resolve(String(destination)) === path.resolve(sandbox.target)) {
          fs.unlinkSync(sandbox.target);
          fs.symlinkSync(victim, sandbox.target);
        }
        originalRename(source, destination);
      }) as typeof fs.renameSync);

      expect(copyDefaultModelMap({ env: sandbox.env, overwrite: true }).overwritten).toBe(true);
      expect(fs.readFileSync(victim, "utf8")).toBe("victim-bytes");
      expect(fs.lstatSync(sandbox.target).isFile()).toBe(true);
      expect(fs.readFileSync(sandbox.target, "utf8")).toBe(readInstalledModelMapText());
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  test("fails safely when atomic no-replace hard-link publication is unsupported", () => {
    const sandbox = makeRoot("models-link-unsupported");
    try {
      const link = spyOn(fs, "linkSync").mockImplementationOnce(() => {
        throw errno("EPERM");
      });
      const error = expectConfigError(() => copyDefaultModelMap({ env: sandbox.env }));
      expect(error.message).toMatch(/publish/i);
      expect(fs.existsSync(sandbox.target)).toBe(false);
      expect(fs.readdirSync(sandbox.root)).toEqual([]);
      link.mockRestore();
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  test("does not report failure when one-time stage cleanup fails after no-replace publication", () => {
    const sandbox = makeRoot("models-link-cleanup");
    const originalUnlink = fs.unlinkSync.bind(fs);
    const unlink = spyOn(fs, "unlinkSync");
    let cleanupFailureInjected = false;
    try {
      unlink.mockImplementation(((candidate: fs.PathLike) => {
        if (!cleanupFailureInjected && String(candidate).startsWith(`${sandbox.target}.copy.`)) {
          cleanupFailureInjected = true;
          throw errno("EACCES");
        }
        return originalUnlink(candidate);
      }) as typeof fs.unlinkSync);

      expect(copyDefaultModelMap({ env: sandbox.env })).toEqual({
        path: sandbox.target,
        copied: true,
        overwritten: false,
      });
      expect(cleanupFailureInjected).toBe(true);
      expect(fs.readFileSync(sandbox.target, "utf8")).toBe(readInstalledModelMapText());
      expect(fs.readdirSync(sandbox.root)).toEqual(["models.json"]);
    } finally {
      unlink.mockRestore();
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "reports that a directory-fsync failure may follow successful publication",
    () => {
      const sandbox = makeRoot("models-directory-fsync");
      const originalFsync = fs.fsyncSync.bind(fs);
      const fsync = spyOn(fs, "fsyncSync");
      let fsyncCalls = 0;
      try {
        fsync.mockImplementation(((fd: number) => {
          fsyncCalls += 1;
          if (fsyncCalls === 2) throw errno("EIO");
          return originalFsync(fd);
        }) as typeof fs.fsyncSync);

        const error = expectConfigError(() => copyDefaultModelMap({ env: sandbox.env }));
        expect(error.message).toMatch(/durably publish/i);
        expect(error.hint()).toMatch(/may already exist.*inspect.*before retrying/i);
        expect(fs.readFileSync(sandbox.target, "utf8")).toBe(readInstalledModelMapText());
      } finally {
        fsync.mockRestore();
        fs.rmSync(sandbox.root, { recursive: true, force: true });
      }
    },
  );

  test("wraps expected mkdir, inspect, and publish failures as stable config errors", () => {
    const mkdirSandbox = makeRoot("models-mkdir-error");
    const originalLstat = fs.lstatSync.bind(fs);
    const originalRename = fs.renameSync.bind(fs);
    try {
      const mkdir = spyOn(fs, "mkdirSync").mockImplementationOnce(() => {
        throw errno("EACCES");
      });
      const mkdirError = expectConfigError(() => copyDefaultModelMap({ env: mkdirSandbox.env }));
      expect(mkdirError.message).toMatch(/configuration directory/i);
      expect(mkdirError.message).not.toContain("raw-EACCES-sentinel");
      mkdir.mockRestore();

      const inspect = spyOn(fs, "lstatSync").mockImplementation(((candidate: fs.PathLike) => {
        if (path.resolve(String(candidate)) === path.resolve(mkdirSandbox.target)) throw errno("EACCES");
        return originalLstat(candidate);
      }) as typeof fs.lstatSync);
      const inspectError = expectConfigError(() => copyDefaultModelMap({ env: mkdirSandbox.env }));
      expect(inspectError.message).toMatch(/inspect/i);
      expect(inspectError.message).not.toContain("raw-EACCES-sentinel");
      inspect.mockRestore();

      fs.writeFileSync(mkdirSandbox.target, "old", { mode: 0o600 });
      const rename = spyOn(fs, "renameSync").mockImplementation(((source: fs.PathLike, destination: fs.PathLike) => {
        if (path.resolve(String(destination)) === path.resolve(mkdirSandbox.target)) throw errno("EACCES");
        originalRename(source, destination);
      }) as typeof fs.renameSync);
      const publishError = expectConfigError(() => copyDefaultModelMap({ env: mkdirSandbox.env, overwrite: true }));
      expect(publishError.message).toMatch(/publish|replace|write/i);
      expect(publishError.message).not.toContain("raw-EACCES-sentinel");
      rename.mockRestore();
    } finally {
      fs.rmSync(mkdirSandbox.root, { recursive: true, force: true });
    }
  });
});
