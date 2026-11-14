// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A reader that closes the pipe early (`akm search … | head -1`) does not turn a
 * successful command into an internal error, and does not cut the work short: the
 * process exits 0 with nothing on stderr, and an index build still completes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { trackStdioReaderGone } from "../../src/core/stdio-reader-gone";
import { closeDatabase, openExistingDatabase } from "../../src/storage/repositories/index-connection";
import { getMeta } from "../../src/storage/repositories/index-meta-repository";
import { type IsolatedAkmStorage, withDefaultBundle, withIsolatedAkmStorage } from "../_helpers/sandbox";

const repoRoot = path.resolve(import.meta.dir, "../..");
let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig(withDefaultBundle({ semanticSearchMode: "off" }, storage.stashDir));
  for (let i = 0; i < 300; i++) {
    fs.writeFileSync(
      path.join(storage.stashDir, "knowledge", `doc-${i}.md`),
      `---\ndescription: Doc ${i} about deployment\n---\n\n# Doc ${i}\n\n${"deploy ".repeat(100)}\n`,
    );
  }
});

afterEach(() => storage.cleanup());

/** Run the CLI with the read end of its stdout (and stderr, when `both`) already closed, as `| head` leaves it. */
function runWithReaderGone(args: string[], both = false): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("bun", ["src/cli.ts", ...args], { cwd: repoRoot, env: process.env });
    let stderr = "";
    proc.stdout.destroy();
    if (both) proc.stderr.destroy();
    else
      proc.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    proc.on("close", (code) => resolve({ code, stderr }));
  });
}

describe("stdout closed by the reader", () => {
  test("search exits 0 without an error on stderr", async () => {
    expect(spawnSync("bun", ["src/cli.ts", "index", "--full"], { cwd: repoRoot, env: process.env }).status).toBe(0);
    const { stderr, code } = await runWithReaderGone(["search", "deploy", "--limit", "500"]);
    expect(stderr).not.toMatch(/EPIPE|UNHANDLED_REJECTION/);
    expect(code).toBe(0);
  });

  test("an index build whose output reader is gone still completes", async () => {
    const { stderr, code } = await runWithReaderGone(["index", "--full"], true);
    expect(stderr).not.toMatch(/EPIPE|UNHANDLED_REJECTION/);
    expect(code).toBe(0);
    const db = openExistingDatabase(getDbPath());
    try {
      expect(getMeta(db, "builtAt")).toBeTruthy();
    } finally {
      closeDatabase(db);
    }
  });
});

describe("which EPIPE is forgiven", () => {
  const epipe = () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

  test("an EPIPE is ignored once our own stdio reported it, and not before", () => {
    const stdout = new EventEmitter();
    const tracker = trackStdioReaderGone([stdout as unknown as NodeJS.WritableStream]);
    expect(tracker.explains(epipe())).toBe(false);
    stdout.emit("error", epipe());
    expect(tracker.explains(epipe())).toBe(true);
  });

  test("a different error is never ignored, and a stdio error other than EPIPE still throws", () => {
    const stdout = new EventEmitter();
    const tracker = trackStdioReaderGone([stdout as unknown as NodeJS.WritableStream]);
    stdout.emit("error", epipe());
    expect(tracker.explains(new Error("boom"))).toBe(false);
    expect(() => stdout.emit("error", Object.assign(new Error("full"), { code: "ENOSPC" }))).toThrow("full");
  });
});
