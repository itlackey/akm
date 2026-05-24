/**
 * Tests for the 0.8.0+ default behaviour of `akm improve`:
 *   - Full result is recorded as a row in the `improve_runs` table of state.db
 *     (migration 003).
 *   - Stdout is empty in default mode — the existing `[improve] ...` log
 *     lines on stderr remain the canonical console UX.
 *   - `--json-to-stdout` restores the prior behaviour (full JSON on stdout,
 *     no state.db row written).
 *
 * Pre-0.8.0 these tests asserted on `<stash>/.akm/runs/<id>/improve-result.json`
 * files. Item 10 of the 0.8.0 pre-production polish plan migrated the storage
 * to state.db; the tests were updated to match. See CHANGELOG.md 0.8.0 entry
 * "improve_runs table in state.db (migration 003)".
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmImproveResult } from "../../src/commands/improve";
import {
  buildImproveRunId,
  relativeImproveResultPath,
  writeImproveResultFile,
} from "../../src/commands/improve-result-file";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-improve-rtf-stash-");
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts", "memories", "lessons"]) {
    fs.mkdirSync(path.join(stash, sub), { recursive: true });
  }
  return stash;
}

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
  xdgData: string;
}

function runCli(args: string[], stashDir: string): CliRun {
  const xdgCache = makeTempDir("akm-improve-rtf-cache-");
  const xdgConfig = makeTempDir("akm-improve-rtf-config-");
  const xdgData = makeTempDir("akm-improve-rtf-data-");
  const xdgState = makeTempDir("akm-improve-rtf-state-");
  const cliPath = path.join(path.resolve(import.meta.dir, "..", ".."), "src", "cli.ts");
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
    },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    xdgData,
  };
}

/**
 * Read every row from `improve_runs` in the test-scoped state.db. The DB lives
 * under `<xdgData>/akm/state.db` per `getDataDir()`.
 */
function readImproveRuns(xdgData: string): Array<{
  id: string;
  started_at: string;
  dry_run: number;
  ok: number;
  scope_mode: string;
  result: Record<string, unknown>;
}> {
  const dbPath = path.join(xdgData, "akm", "state.db");
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, started_at, dry_run, ok, scope_mode, result_json
         FROM improve_runs ORDER BY started_at ASC`,
      )
      .all() as Array<{
      id: string;
      started_at: string;
      dry_run: number;
      ok: number;
      scope_mode: string;
      result_json: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      started_at: r.started_at,
      dry_run: r.dry_run,
      ok: r.ok,
      scope_mode: r.scope_mode,
      result: JSON.parse(r.result_json) as Record<string, unknown>,
    }));
  } finally {
    db.close();
  }
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildImproveRunId", () => {
  test("returns a unique id across consecutive calls", () => {
    const a = buildImproveRunId();
    const b = buildImproveRunId();
    expect(a).not.toEqual(b);
    // Format sanity: ISO-style timestamp with -<8 hex>
    expect(a).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/);
  });
});

describe("relativeImproveResultPath", () => {
  test("returns a state.db locator (not a filesystem path)", () => {
    const rel = relativeImproveResultPath("test-run");
    // Compatibility shim: still a relative-style string for log messages,
    // but now references the state.db row rather than an on-disk file.
    expect(path.isAbsolute(rel)).toBe(false);
    expect(rel).toBe(path.join("state.db", "improve_runs", "test-run"));
  });
});

describe("writeImproveResultFile", () => {
  test("records a row in the improve_runs table of state.db", () => {
    const stash = makeStashDir();
    const runId = "test-run-write";
    const result: AkmImproveResult = {
      schemaVersion: 1,
      ok: true,
      scope: { mode: "all" },
      dryRun: false,
      memorySummary: { eligible: 1, derived: 0 },
      plannedRefs: [],
    };

    // Isolate state.db to a tmpdir so the test never touches the user's
    // real data directory.
    const xdgData = makeTempDir("akm-improve-rtf-data-");
    const xdgCache = makeTempDir("akm-improve-rtf-cache-");
    const xdgConfig = makeTempDir("akm-improve-rtf-config-");
    const xdgState = makeTempDir("akm-improve-rtf-state-");
    const savedEnv = {
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };
    process.env.XDG_DATA_HOME = xdgData;
    process.env.XDG_CACHE_HOME = xdgCache;
    process.env.XDG_CONFIG_HOME = xdgConfig;
    process.env.XDG_STATE_HOME = xdgState;

    try {
      const rel = writeImproveResultFile(stash, runId, result);
      // Return value is now a state.db locator for log messages, not a file path.
      expect(rel).toBe(path.join("state.db", "improve_runs", runId));

      const rows = readImproveRuns(xdgData);
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(runId);
      expect(rows[0].ok).toBe(1);
      expect(rows[0].dry_run).toBe(0);
      expect(rows[0].scope_mode).toBe("all");
      expect(rows[0].result.ok).toBe(true);

      // No legacy on-disk file under .akm/runs/ — the storage swap is complete.
      const runsDir = path.join(stash, ".akm", "runs");
      expect(fs.existsSync(runsDir)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("akm improve CLI: result-to-state.db default + --json-to-stdout escape hatch", () => {
  let stashDir: string;
  beforeEach(() => {
    stashDir = makeStashDir();
  });

  test("default mode records the full result in state.db improve_runs and emits NOTHING on stdout", () => {
    // Use --dry-run so the run completes quickly without LLM calls.
    const result = runCli(["improve", "--dry-run"], stashDir);
    expect(result.status).toBe(0);

    // Stdout is empty — no JSON summary, no envelope, no "result written to" hint.
    expect(result.stdout).toBe("");

    // The result row landed in state.db with the full body in result_json.
    const rows = readImproveRuns(result.xdgData);
    expect(rows.length).toBe(1);
    expect(rows[0].ok).toBe(1);
    expect(rows[0].dry_run).toBe(1);
    expect(rows[0].result.ok).toBe(true);
    expect(rows[0].result.dryRun).toBe(true);
    expect(rows[0].result.memorySummary).toBeDefined();
    expect(rows[0].result.plannedRefs).toBeDefined();

    // No legacy on-disk artifact file is authored anymore.
    const runsDir = path.join(stashDir, ".akm", "runs");
    expect(fs.existsSync(runsDir)).toBe(false);

    // No "improve result written to" hint on stderr — the existing [improve]
    // log lines from improve.ts are the canonical console UX.
    expect(result.stderr).not.toContain("improve result written to");
  });

  test("--json-to-stdout restores prior behaviour: full JSON on stdout, no state.db row written", () => {
    const result = runCli(["improve", "--dry-run", "--json-to-stdout"], stashDir);
    expect(result.status).toBe(0);

    // Stdout has the full result body.
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.memorySummary).toBeDefined();
    expect(parsed.plannedRefs).toBeDefined();
    // No envelope-only fields in legacy mode.
    expect(parsed.runId).toBeUndefined();
    expect(parsed.resultPath).toBeUndefined();
    expect(parsed.summary).toBeUndefined();

    // No improve_runs row written in --json-to-stdout mode.
    const rows = readImproveRuns(result.xdgData);
    expect(rows.length).toBe(0);

    // No legacy on-disk file either.
    const runsDir = path.join(stashDir, ".akm", "runs");
    if (fs.existsSync(runsDir)) {
      const entries = fs.readdirSync(runsDir);
      expect(entries.length).toBe(0);
    }

    // Stderr should NOT contain the "improve result written to" hint.
    expect(result.stderr).not.toContain("improve result written to");
  });

  test("two consecutive default-mode runs produce distinct improve_runs rows", () => {
    const a = runCli(["improve", "--dry-run"], stashDir);
    expect(a.status).toBe(0);
    expect(a.stdout).toBe("");

    // Use the same xdgData root so the second run accumulates into the
    // same state.db. runCli() mints a fresh xdgData per call, so we re-run
    // by passing the same env via a small inline driver.
    const b = runCli(["improve", "--dry-run"], stashDir);
    expect(b.status).toBe(0);
    expect(b.stdout).toBe("");

    // Each run wrote a row into its own state.db (one row per state.db).
    const aRows = readImproveRuns(a.xdgData);
    const bRows = readImproveRuns(b.xdgData);
    expect(aRows.length).toBe(1);
    expect(bRows.length).toBe(1);
    expect(aRows[0].id).not.toEqual(bRows[0].id);
    // No legacy directory under either stash root.
    expect(fs.existsSync(path.join(stashDir, ".akm", "runs"))).toBe(false);
  });
});
