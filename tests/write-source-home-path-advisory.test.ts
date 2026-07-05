// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the write-time absolute-host-path advisory (review 13, D1 lint half).
 *
 * The advisory is a NON-FATAL warning emitted when an asset written through
 * `writeAssetToSource` embeds an absolute host home path (`/home/<user>/…` or
 * `/Users/<user>/…`). Such paths make the stash non-portable and leak the
 * local username. This test covers the pure detector `findAbsoluteHomePaths`
 * (positive + negative content) and confirms the detector is wired into the
 * write seam so a real write fires a `warn` — without blocking the write.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AssetRef } from "../src/core/asset/asset-ref";
import type { SourceConfigEntry } from "../src/core/config/config";
import { _setWarnSinkForTests } from "../src/core/warn";
import { findAbsoluteHomePaths, type WriteTargetSource, writeAssetToSource } from "../src/core/write-source";

describe("findAbsoluteHomePaths", () => {
  test("flags an absolute Linux home path", () => {
    expect(findAbsoluteHomePaths("cd /home/founder3/projects && ls")).toEqual(["/home/founder3"]);
  });

  test("flags an absolute macOS home path", () => {
    expect(findAbsoluteHomePaths("open /Users/alice/notes.md")).toEqual(["/Users/alice"]);
  });

  test("dedupes repeated host paths", () => {
    const content = "/home/founder3/a\n/home/founder3/b\n/Users/bob/c";
    expect(findAbsoluteHomePaths(content)).toEqual(["/home/founder3", "/Users/bob"]);
  });

  test("does NOT flag portable content", () => {
    const content = "Use $HOME/projects or ~/notes.md — never hardcode a user directory.";
    expect(findAbsoluteHomePaths(content)).toEqual([]);
  });

  test("does NOT flag a bare /home/ or /Users/ prefix with no user segment", () => {
    expect(findAbsoluteHomePaths("mounted at /home/ and /Users/")).toEqual([]);
  });
});

describe("writeAssetToSource emits the advisory but still writes", () => {
  const tempDirs: string[] = [];
  const warnings: unknown[][] = [];

  afterEach(() => {
    _setWarnSinkForTests(undefined);
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
    warnings.length = 0;
  });

  function sink(): { source: WriteTargetSource; config: SourceConfigEntry } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-advisory-"));
    tempDirs.push(dir);
    return {
      source: { kind: "filesystem", name: "stash", path: dir },
      config: { type: "filesystem", name: "stash", path: dir, writable: true },
    };
  }

  test("warns on absolute-home-path content, and the file is still written", async () => {
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args);
    });
    const { source, config } = sink();
    const ref: AssetRef = { type: "knowledge", name: "leaky-note" };

    const res = await writeAssetToSource(source, config, ref, "See /home/founder3/secret for details.\n");

    // Non-fatal: the write succeeded.
    expect(fs.existsSync(res.path)).toBe(true);
    // The advisory fired and named the offending path.
    const joined = warnings.map((a) => a.map(String).join(" ")).join("\n");
    expect(joined).toContain("/home/founder3");
  });

  test("does NOT warn on portable content", async () => {
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args);
    });
    const { source, config } = sink();
    const ref: AssetRef = { type: "knowledge", name: "portable-note" };

    await writeAssetToSource(source, config, ref, "Store things under $HOME/projects.\n");

    expect(warnings.length).toBe(0);
  });
});
