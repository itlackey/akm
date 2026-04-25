/**
 * Regression tests for GitHub issues 191–194 (filed against 0.6.0-rc1).
 *
 * Issue 191 — search misses freshly-added memory
 *   Status at re-run: NOT REPRODUCING. Test asserts the current correct
 *   behavior so we don't regress.
 *
 * Issue 192 — `akm list` reports no stash after `akm init`
 *   Status at re-run: NOT REPRODUCING. Test asserts the current correct
 *   behavior so we don't regress.
 *
 * Issue 193 — `database is locked` during normal CLI use
 *   Status at re-run: NOT REPRODUCING under heavy concurrency, but the
 *   underlying gap (no `PRAGMA busy_timeout`) is real. Test asserts the
 *   pragma is set after fix.
 *
 * Issue 194 — `workflowEntryId: null` after `workflow create --from`
 *   Status at re-run: REPRODUCED. Test asserts the field is non-null on
 *   first start after a fresh import.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(__dirname, "..", "src", "cli.ts");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeEnv(): NodeJS.ProcessEnv {
  const akmHome = makeTempDir("akm-issue-rc1-");
  return {
    ...process.env,
    HOME: akmHome,
    XDG_CONFIG_HOME: path.join(akmHome, "config"),
    XDG_CACHE_HOME: path.join(akmHome, "cache"),
    XDG_DATA_HOME: path.join(akmHome, "data"),
    AKM_STASH_DIR: path.join(akmHome, "stash"),
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const ACA_WORKFLOW = `---
description: Test workflow imported via workflow create --from
tags:
  - test
params:
  app_name: name of the app
---

# Workflow: Imported Test Workflow

## Step: First Step
Step ID: first-step

### Instructions
Do thing one.

### Completion Criteria
- Done

## Step: Second Step
Step ID: second-step

### Instructions
Do thing two.

### Completion Criteria
- Done
`;

describe("issue #191 — memory search misses freshly-added memory", () => {
  test("exact-phrase search returns the memory hit at high score", () => {
    const env = makeEnv();
    expect(runCli(["init"], env).status).toBe(0);

    const phrase = "Sandbox memory for rc1 test";
    const remembered = runCli(["remember", phrase], env);
    expect(remembered.status).toBe(0);

    const searched = runCli(["search", phrase, "--format", "json", "--detail", "full"], env);
    expect(searched.status).toBe(0);
    const json = JSON.parse(searched.stdout) as {
      hits: Array<{ type: string; name: string; score?: number }>;
    };
    const memoryHit = json.hits.find((h) => h.type === "memory");
    expect(memoryHit).toBeDefined();
    expect(memoryHit?.score ?? 0).toBeGreaterThan(0.5);
  });
});

describe("issue #192 — `akm list` after `akm init`", () => {
  test("list resolves the stashDir written by init", () => {
    const env = makeEnv();
    const initRes = runCli(["init"], env);
    expect(initRes.status).toBe(0);
    const initJson = JSON.parse(initRes.stdout) as { stashDir: string };

    const listRes = runCli(["list", "--format", "json"], env);
    expect(listRes.status).toBe(0);
    const listJson = JSON.parse(listRes.stdout) as { stashDir: string };
    expect(listJson.stashDir).toBe(initJson.stashDir);
  });
});

describe("issue #193 — database is locked under contention", () => {
  test("openDatabase sets PRAGMA busy_timeout so contended writers wait", async () => {
    // Use the actual openDatabase helper via dynamic import so we exercise
    // the same code path the CLI uses.
    const { openDatabase, closeDatabase } = await import("../src/indexer/db");
    const tmp = path.join(makeTempDir("akm-issue-193-"), "test.db");
    const db = openDatabase(tmp);
    try {
      const row = db.prepare("PRAGMA busy_timeout").get() as { timeout?: number };
      expect(row).toBeDefined();
      // Any non-zero value is acceptable; we just want the pragma set so
      // SQLITE_BUSY is retried instead of bubbling up to the user.
      expect(row.timeout ?? 0).toBeGreaterThan(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("WAL journal mode is preserved (regression guard)", async () => {
    const { openDatabase, closeDatabase } = await import("../src/indexer/db");
    const tmp = path.join(makeTempDir("akm-issue-193-wal-"), "test.db");
    const db = openDatabase(tmp);
    try {
      const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
      expect(row.journal_mode?.toLowerCase()).toBe("wal");
    } finally {
      closeDatabase(db);
    }
  });
});

describe("issue #194 — workflow create --from then start has non-null workflowEntryId", () => {
  test("imported workflow run carries a real numeric workflowEntryId", () => {
    const env = makeEnv();
    expect(runCli(["init"], env).status).toBe(0);

    const sourceDir = makeTempDir("akm-issue-194-src-");
    const sourcePath = path.join(sourceDir, "imported.md");
    fs.writeFileSync(sourcePath, ACA_WORKFLOW, "utf8");

    const created = runCli(["workflow", "create", "imported", "--from", sourcePath], env);
    expect(created.status).toBe(0);

    // No explicit `akm index` — `workflow create --from` should leave the
    // FTS index in a state that lets `workflow start` resolve a workflowEntryId.
    const started = runCli(["workflow", "start", "workflow:imported", "--params", '{"app_name":"sandbox-app"}'], env);
    expect(started.status).toBe(0);
    const startJson = JSON.parse(started.stdout) as {
      run: { id: string; workflowEntryId: number | null };
    };
    expect(startJson.run.id).toBeTruthy();
    expect(startJson.run.workflowEntryId).not.toBeNull();
    expect(typeof startJson.run.workflowEntryId).toBe("number");
  });
});
