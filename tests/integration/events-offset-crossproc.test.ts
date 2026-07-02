// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// INTEGRATION (real subprocess required): the `--since @offset:N` durability
// contract is that a cursor persisted by one process resumes correctly in a
// SEPARATE process. An in-process harness cannot express this — there is no
// second process, so the exec boundary (fresh module state, fresh env-derived
// XDG paths, fresh SQLite connection) would not be exercised. Moved here from
// tests/commands/events.test.ts as part of the spawn-allowlist drain.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEvent, readEvents } from "../../src/core/events";

const CLI = path.join(__dirname, "..", "..", "src", "cli.ts");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Subprocess runner for the cross-process @offset durability test. It passes
 * env to spawnSync rather than mutating process.env, so the parent test
 * process is untouched.
 */
function spawnCli(
  args: string[],
  env: Record<string, string | undefined>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("events @offset cursor across a real process boundary", () => {
  test("`akm log list --since @offset:N` resumes across a real process boundary", () => {
    // This is the cross-process durability contract: a producer writes N
    // events, persists nextOffset to a temp file, appends MORE events, and
    // then a SECOND `bun src/cli.ts log list` invocation reads the cursor
    // from the file and must emit only the post-cursor events with no
    // duplicates and no losses.
    const dataDir = makeTempDir("akm-events-xproc-data-");
    const cacheDir = makeTempDir("akm-events-xproc-cache-");
    const configDir = makeTempDir("akm-events-xproc-config-");
    const stateDir = makeTempDir("akm-events-xproc-statedir-");
    const cursorFile = path.join(makeTempDir("akm-events-xproc-state-"), "cursor.txt");
    // Drive both processes through the same XDG_DATA_HOME so they share
    // the same state.db path (events now live in state.db, not events.jsonl).
    const childEnv = {
      XDG_DATA_HOME: dataDir,
      XDG_CACHE_HOME: cacheDir,
      XDG_CONFIG_HOME: configDir,
      XDG_STATE_HOME: stateDir,
    };
    // The dbPath for the writer must match what the CLI child process resolves.
    // The CLI resolves state.db as <XDG_DATA_HOME>/akm/state.db.
    const dbPath = path.join(dataDir, "akm", "state.db");
    const ctx = { dbPath };

    // 1. Producer writes events 0..2 (the "first batch").
    appendEvent({ eventType: "remember", ref: "memory:e0" }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:e1" }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:e2" }, ctx);

    // 2. Producer persists nextOffset to a temp file.
    const cursor = readEvents({}, ctx).nextOffset;
    fs.writeFileSync(cursorFile, String(cursor));

    // 3. Producer appends MORE events (3..5) BEFORE the second process reads.
    appendEvent({ eventType: "remember", ref: "memory:e3" }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:e4" }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:e5" }, ctx);

    // 4. Spawn a SECOND bun process; it reads the cursor from the temp file
    //    and asks the CLI for events with `--since @offset:<cursor>`. This
    //    exercises a real exec boundary, not just in-process arithmetic.
    const persisted = fs.readFileSync(cursorFile, "utf8").trim();
    const child = spawnCli(["log", "list", "--since", `@offset:${persisted}`, "--format=json"], childEnv);
    expect(child.status).toBe(0);
    const parsed = JSON.parse(child.stdout) as {
      events: Array<{ ref: string }>;
      totalCount: number;
      nextOffset: number;
      sinceOffset?: number;
    };

    // 5. Assert: exactly the post-cursor events, in order, no duplicates,
    //    no losses. The pre-cursor events MUST NOT appear.
    expect(parsed.events.map((e) => e.ref)).toEqual(["memory:e3", "memory:e4", "memory:e5"]);
    expect(parsed.totalCount).toBe(3);
    expect(parsed.sinceOffset).toBe(Number(persisted));
    expect(parsed.nextOffset).toBeGreaterThan(Number(persisted));
  });
});
