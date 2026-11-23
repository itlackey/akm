// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A file the bundle's adapter does not treat as an asset (a bundle-root README.md) is not listed: its directory is not
 * scanned, so `akm index` has no zero-row directory to report, by default or under `--verbose`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetQuiet, resetVerbose, setVerbose } from "../../../src/core/warn";
import { akmIndex } from "../../../src/indexer/indexer";
import { type Cleanup, makeSandboxDir, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../../_helpers/sandbox";

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  envCleanup = sandboxXdgConfigHome(cacheResult.cleanup).cleanup;
  resetQuiet();
  resetVerbose();
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  resetVerbose();
});

function rootWithReadmeAndKnowledge(): string {
  const dir = makeSandboxDir("akm-zero-row").dir;
  fs.writeFileSync(path.join(dir, "README.md"), "# Readme\n");
  fs.mkdirSync(path.join(dir, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(dir, "knowledge", "note.md"), "# Note\n");
  return dir;
}

async function indexLines(stashDir: string): Promise<{ lines: string[]; totalEntries: number }> {
  const lines: string[] = [];
  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    const result = await akmIndex({ stashDir, full: true });
    return { lines, totalEntries: result.totalEntries };
  } finally {
    console.warn = originalWarn;
  }
}

test("a bundle root holding only a README.md prints no zero-row line by default", async () => {
  const stashDir = rootWithReadmeAndKnowledge();
  const { lines, totalEntries } = await indexLines(stashDir);
  expect(totalEntries).toBe(1);
  expect(lines.filter((l) => l.includes("zero-row"))).toEqual([]);
});

test("--verbose reports no zero-row directory either: the README is not listed, so its directory is not scanned", async () => {
  const stashDir = rootWithReadmeAndKnowledge();
  setVerbose(true);
  const { lines, totalEntries } = await indexLines(stashDir);
  expect(totalEntries).toBe(1);
  expect(lines.filter((l) => l.includes("zero-row"))).toEqual([]);
});
