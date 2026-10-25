// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Harness auto-detection for a non-interactive setup, and PATH probing. The
 * embedded OpenCode needs no binary and no harness entry, so nothing is picked
 * when OpenCode is set up for the user or no agent CLI is on PATH; otherwise the
 * first agent CLI on PATH.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultWhich, type WhichFn } from "../../src/integrations/agent/detect";
import { detectHarness } from "../../src/setup/detect";

/** A `which` stub resolving exactly the named binaries. */
const whichFor = (...available: string[]): WhichFn => {
  const set = new Set(available);
  return (bin: string) => (set.has(bin) ? `/usr/local/bin/${bin}` : undefined);
};

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

describe("detectHarness", () => {
  test("picks no harness when the user's OpenCode config selects a model: the embedded runtime needs no entry", async () => {
    write(configFile(), {
      model: "lab/m",
      provider: { lab: { options: { baseURL: "http://127.0.0.1:1/v1" }, models: { m: {} } } },
    });
    expect(await detectHarness(whichFor("claude"))).toBe("none");
  });

  test("picks no harness when the user has logged in to OpenCode", async () => {
    write(authFile(), {});
    expect(await detectHarness(whichFor("claude"))).toBe("none");
  });

  test("otherwise picks the first agent CLI on PATH, in registry order, never the OpenCode 1 CLI", async () => {
    expect(await detectHarness(whichFor("opencode", "claude", "codex"))).toBe("claude");
    expect(await detectHarness(whichFor("codex", "gemini"))).toBe("codex");
    expect(await detectHarness(whichFor("gemini"))).toBe("gemini");
    // `q` is amazonq's binary — detection reports the harness id, not the bin.
    expect(await detectHarness(whichFor("q"))).toBe("amazonq");
  });

  test("picks no harness when no agent CLI is on PATH, the OpenCode 1 CLI included", async () => {
    expect(await detectHarness(whichFor())).toBe("none");
    expect(await detectHarness(whichFor("opencode"))).toBe("none");
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
