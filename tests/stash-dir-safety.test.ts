// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError } from "../src/core/errors";
import { assertSafeStashDir } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { runCliCapture } from "./_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

// Regression suite for #473 — stashDir path validation.
// `akm init --dir /` or `akm init --dir ~` would previously mkdirSync +
// git-init the user's system root or home directory. assertSafeStashDir
// refuses these and other catastrophic-on-misuse paths.

function refuses(p: string): { ok: false; code?: string; message: string } | { ok: true } {
  try {
    assertSafeStashDir(p);
    return { ok: true };
  } catch (err) {
    if (err instanceof ConfigError) {
      return { ok: false, code: err.code, message: err.message };
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function warnsOnly(p: string): { threw: boolean; warnings: string[] } {
  const warnings: string[] = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  let threw = false;
  try {
    assertSafeStashDir(p);
  } catch {
    threw = true;
  } finally {
    _setWarnSinkForTests(undefined);
  }
  return { threw, warnings };
}

describe("assertSafeStashDir (#473)", () => {
  describe("refuses catastrophic paths", () => {
    it("refuses filesystem root", () => {
      const r = refuses("/");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("UNSAFE_STASH_DIR");
    });

    it("refuses Windows drive root forms (Windows-only)", () => {
      if (process.platform !== "win32") {
        // On POSIX, `path.resolve("C:")` produces `<cwd>/C:`, not a drive root,
        // so the validator correctly treats it as a relative path. The check
        // is only meaningful when path.resolve preserves drive semantics.
        return;
      }
      expect(refuses("C:").ok).toBe(false);
      expect(refuses("C:/").ok).toBe(false);
      expect(refuses("C:\\").ok).toBe(false);
    });

    it("refuses major system roots", () => {
      const roots = [
        "/etc",
        "/var",
        "/usr",
        "/usr/local",
        "/opt",
        "/sys",
        "/proc",
        "/boot",
        "/bin",
        "/sbin",
        "/lib",
        "/dev",
        "/run",
        "/home",
        "/root",
      ];
      for (const r of roots) {
        const result = refuses(r);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe("UNSAFE_STASH_DIR");
      }
    });

    it("refuses the user's home directory itself", () => {
      const home = os.homedir();
      const r = refuses(home);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("UNSAFE_STASH_DIR");
    });

    it("refuses sensitive dotfile parents", () => {
      const home = os.homedir();
      for (const sub of [".config", ".local", ".cache", ".ssh", ".gnupg", ".aws", ".kube", ".docker"]) {
        const r = refuses(path.join(home, sub));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("UNSAFE_STASH_DIR");
      }
    });
  });

  describe("allows safe paths", () => {
    it("allows ~/akm", () => {
      expect(refuses(path.join(os.homedir(), "akm")).ok).toBe(true);
    });

    it("allows nested workspaces under home", () => {
      expect(refuses(path.join(os.homedir(), "work", "stash")).ok).toBe(true);
    });

    it("allows /tmp/* (assertInitSandbox separately gates this under bun test)", () => {
      expect(refuses("/tmp/akm-fixture-12345").ok).toBe(true);
    });

    it("allows subdirs of refused parents", () => {
      // ~/.config is refused, but ~/.config/akm-test is fine — only exact
      // matches are refused so legitimate nested use isn't blocked.
      expect(refuses(path.join(os.homedir(), ".config", "akm-test")).ok).toBe(true);
      expect(refuses(path.join(os.homedir(), ".local", "share", "akm-test")).ok).toBe(true);
    });

    it("allows relative paths that resolve to a safe location", () => {
      const cwd = process.cwd();
      // path.resolve('./scratch') → <cwd>/scratch; cwd here is the repo root.
      expect(refuses("./scratch-stash").ok).toBe(true);
      expect(refuses(path.join(cwd, "scratch")).ok).toBe(true);
    });
  });

  describe("warns instead of refusing merely-inconvenient paths", () => {
    it("warns but allows /var/tmp", () => {
      const { threw, warnings } = warnsOnly("/var/tmp");
      expect(threw).toBe(false);
      expect(warnings.some((w) => w.includes("/var/tmp"))).toBe(true);
    });

    it("warns but allows Documents/Downloads/AppData under home", () => {
      const home = os.homedir();
      for (const sub of ["Documents", "Downloads", "AppData"]) {
        const { threw, warnings } = warnsOnly(path.join(home, sub));
        expect(threw).toBe(false);
        expect(warnings.some((w) => w.includes(sub))).toBe(true);
      }
    });

    it("still allows subdirs of the warned-about paths, silently", () => {
      const home = os.homedir();
      expect(refuses(path.join(home, "Documents", "notes")).ok).toBe(true);
      expect(refuses("/var/tmp/akm-fixture").ok).toBe(true);
    });
  });
});

describe("stash-cli-index-progress-visibility", () => {
  /**
   * #954: the default `akm index` output format is JSON, and a
   * non-verbose JSON run used to print NOTHING to stderr until the very end —
   * a stalled run looked identical to "no database open, nothing written"
   * (field report). Phase-start messages and the embedding heartbeat now reach
   * stderr via `info()` in non-verbose JSON mode too; text mode keeps the
   * spinner (no stderr line growth); verbose still gets everything, including
   * the high-frequency per-batch `Embedded N/M entries.` line that JSON mode
   * deliberately does NOT surface (that would defeat the point — spam instead
   * of a heartbeat).
   */

  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    writeSandboxConfig({ semanticSearchMode: "off" });
    fs.writeFileSync(
      path.join(storage.stashDir, "knowledge", "guide.md"),
      "---\ndescription: A guide\n---\n\nSome content.\n",
    );
  });

  afterEach(() => storage.cleanup());

  test("non-verbose JSON mode (the default) now prints phase-start progress to stderr", async () => {
    const result = await runCliCapture(["index", "--format", "json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("[index:preflight]");
    expect(result.stderr).toContain("[index:scan]");
  });

  test("non-verbose text mode still uses the spinner, not stderr progress lines", async () => {
    const result = await runCliCapture(["index", "--format", "text"]);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("[index:preflight]");
  });

  test("--verbose still prints every phase message, unchanged", async () => {
    const result = await runCliCapture(["index", "--format", "json", "--verbose"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("[index:preflight]");
  });
});
