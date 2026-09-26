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

describe("models copy-defaults", () => {
  test("wraps a failed write as a stable config error without echoing the raw error", () => {
    const sandbox = makeRoot("models-write-error");
    try {
      const mkdir = spyOn(fs, "mkdirSync").mockImplementationOnce(() => {
        throw errno("EACCES");
      });
      const error = expectConfigError(() => copyDefaultModelMap({ env: sandbox.env }));
      expect(error.message).toMatch(/configuration directory/i);
      expect(error.message).not.toContain("raw-EACCES-sentinel");
      mkdir.mockRestore();
      expect(fs.existsSync(sandbox.target)).toBe(false);
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  test("an existing file needs --overwrite", () => {
    const sandbox = makeRoot("models-existing");
    try {
      fs.writeFileSync(sandbox.target, "operator bytes", { mode: 0o600 });
      expectAlreadyExists(() => copyDefaultModelMap({ env: sandbox.env }));
      expect(fs.readFileSync(sandbox.target, "utf8")).toBe("operator bytes");
      expect(copyDefaultModelMap({ env: sandbox.env, overwrite: true }).overwritten).toBe(true);
      expect(fs.readFileSync(sandbox.target, "utf8")).toBe(readInstalledModelMapText());
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  });
});
