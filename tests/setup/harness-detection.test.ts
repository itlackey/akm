// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Installed-harness detection for setup, and PATH probing. A harness is
 * installed when its binary is on PATH; OpenCode is detected like any other,
 * and nothing about the user's OpenCode config or logins changes the answer.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultWhich, type WhichFn } from "../../src/integrations/agent/detect";
import { detectInstalledHarnesses } from "../../src/setup/detect";

/** A `which` stub resolving exactly the named binaries. */
const whichFor = (...available: string[]): WhichFn => {
  const set = new Set(available);
  return (bin: string) => (set.has(bin) ? `/usr/local/bin/${bin}` : undefined);
};
const platforms = (...available: string[]) => detectInstalledHarnesses(whichFor(...available)).map((h) => h.platform);

const configFile = () => path.join(process.env.XDG_CONFIG_HOME ?? "", "opencode", "opencode.json");
const authFile = () => path.join(process.env.XDG_DATA_HOME ?? "", "opencode", "auth.json");
const write = (file: string, content: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(content));
};

afterEach(() => {
  fs.rmSync(configFile(), { force: true });
  fs.rmSync(authFile(), { force: true });
});

describe("detectInstalledHarnesses", () => {
  test("lists the agent programs on PATH in registry order, OpenCode among them", () => {
    expect(platforms("opencode", "claude", "codex")).toEqual(["opencode", "claude", "codex"]);
    expect(platforms("gemini", "codex")).toEqual(["codex", "gemini"]);
    // `q` is amazonq's binary — detection reports the harness id, not the bin.
    expect(platforms("q")).toEqual(["amazonq"]);
  });

  test("carries the binary and where it was found", () => {
    expect(detectInstalledHarnesses(whichFor("claude"))).toEqual([
      { platform: "claude", bin: "claude", path: "/usr/local/bin/claude" },
    ]);
  });

  test("finds nothing when no agent program is on PATH", () => {
    expect(platforms()).toEqual([]);
  });

  test("the user's OpenCode config and logins do not make OpenCode installed or hide the others", () => {
    write(configFile(), {
      model: "lab/m",
      provider: { lab: { options: { baseURL: "http://127.0.0.1:1/v1" }, models: { m: {} } } },
    });
    write(authFile(), {});
    expect(platforms("claude")).toEqual(["claude"]);
    expect(platforms()).toEqual([]);
  });
});

describe("defaultWhich", () => {
  const posixEnv = { PATH: "/nope/a:/nope/b" } as NodeJS.ProcessEnv;

  test("returns undefined without a PATH", () => {
    expect(defaultWhich("claude", {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  test("finds nothing for a bin that is not on PATH", () => {
    expect(defaultWhich("definitely-not-installed-akm-test", posixEnv)).toBeUndefined();
  });

  test("resolves a real file on PATH", () => {
    // `sh` is guaranteed on the POSIX runners this suite targets.
    const resolved = defaultWhich("sh", { PATH: "/bin:/usr/bin" } as NodeJS.ProcessEnv);
    expect(resolved).toBeDefined();
    expect(resolved).toMatch(/\/sh$/);
  });

  test("probes PATHEXT spellings so Windows shims resolve", () => {
    // Windows installs agent CLIs as `claude.cmd` / `q.exe`; an exact-name
    // probe reports every one of them missing, which silently hid the
    // "installed CLI agent" option on Windows. PATHEXT in the env is the seam
    // that lets this be covered from a POSIX runner.
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "which-pathext-"));
    try {
      // Windows resolves PATHEXT case-insensitively; this POSIX runner does
      // not, so the fixture matches the PATHEXT spelling exactly.
      fs.writeFileSync(path.join(shimDir, "claude.CMD"), "@echo off\n");
      const winEnv = { PATH: shimDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv;

      expect(defaultWhich("claude", winEnv)).toBe(path.join(shimDir, "claude.CMD"));
      // Without PATHEXT (POSIX), the extension-bearing shim stays invisible.
      expect(defaultWhich("claude", { PATH: shimDir } as NodeJS.ProcessEnv)).toBeUndefined();
      expect(defaultWhich("definitely-not-installed-akm-test", winEnv)).toBeUndefined();
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  test("prefers a bare name over its PATHEXT spellings", () => {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "which-pathext-"));
    try {
      fs.writeFileSync(path.join(shimDir, "codex"), "#!/bin/sh\n");
      fs.writeFileSync(path.join(shimDir, "codex.CMD"), "@echo off\n");
      const winEnv = { PATH: shimDir, PATHEXT: ".CMD" } as NodeJS.ProcessEnv;

      expect(defaultWhich("codex", winEnv)).toBe(path.join(shimDir, "codex"));
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  test("keeps bare-name resolution first on POSIX", () => {
    expect(defaultWhich("sh", { PATH: "/bin" } as NodeJS.ProcessEnv)).toBe("/bin/sh");
  });
});
