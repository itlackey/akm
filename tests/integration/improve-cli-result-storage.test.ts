// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Integration tests for the 0.8.0+ default behaviour of `akm improve`:
 *   - Full result is recorded as a row in the `improve_runs` table of state.db
 *     (migration 003).
 *   - Stdout is empty in default mode — the existing `[improve] ...` log
 *     lines on stderr remain the canonical console UX.
 *   - `--json-to-stdout` restores the prior behaviour (full JSON on stdout,
 *     no state.db row written).
 *
 * WHY REAL SUBPROCESSES (moved here from tests/commands/improve-result-to-file.test.ts):
 * these tests run `improve` for real, which opens and WRITES the state.db
 * improve_runs table. In-process, a SQLite write lock on state.db is already
 * held within the test process (the suite keeps DB handles open across the
 * run), so an in-process improve aborts with "state DB busy/locked after
 * retries" — a genuine cross-process contention a fresh subprocess avoids.
 * They also run real improve with 60s timeouts, which fits the integration
 * scope rule. Each spawn mints a fresh XDG_DATA_HOME (via the sandbox helper)
 * passed in the child's env — process.env is never mutated — so every run
 * gets a clean, uncontended state.db that the assertions read back.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type SandboxedDir, makeStashDir as sandboxMakeStashDir } from "../_helpers/sandbox";

const disposers: Array<{ cleanup: () => void }> = [];

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function makeStashDir(): string {
  const stash: SandboxedDir = sandboxMakeStashDir();
  // sandboxMakeStashDir lacks the lessons/memories subdirs improve expects.
  for (const sub of ["memories", "lessons"]) {
    fs.mkdirSync(path.join(stash.dir, sub), { recursive: true });
  }
  disposers.push(stash);
  return stash.dir;
}

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
  xdgData: string;
}

function runCli(args: string[], stashDir: string): CliRun {
  // Fresh XDG_DATA_HOME per call so each run writes its own state.db. Use the
  // sandbox helper to keep mkdtempSync out of the test file; the dir is passed
  // to spawnSync's env (not process.env) so it never leaks.
  const data = sandboxMakeStashDir();
  disposers.push(data);
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
      XDG_DATA_HOME: data.dir,
    },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    xdgData: data.dir,
  };
}

/**
 * Read every row from `improve_runs` in the test-scoped state.db. The DB lives
 * under `<xdgData>/akm/state.db` per `getDataDir()`.
 */
function readImproveRuns(xdgData: string): Array<{
  id: string;
  started_at: string;
  completed_at: string | null;
  dry_run: number;
  ok: number;
  scope_mode: string;
  profile: string | null;
  strategy: string | null;
  result: Record<string, unknown>;
}> {
  const dbPath = path.join(xdgData, "akm", "state.db");
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, started_at, completed_at, dry_run, ok, scope_mode, profile, strategy, result_json
         FROM improve_runs ORDER BY started_at ASC`,
      )
      .all() as Array<{
      id: string;
      started_at: string;
      completed_at: string | null;
      dry_run: number;
      ok: number;
      scope_mode: string;
      profile: string | null;
      strategy: string | null;
      result_json: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      started_at: r.started_at,
      completed_at: r.completed_at,
      dry_run: r.dry_run,
      ok: r.ok,
      scope_mode: r.scope_mode,
      profile: r.profile,
      strategy: r.strategy,
      result: JSON.parse(r.result_json) as Record<string, unknown>,
    }));
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
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
    expect(rows[0].profile).toBeNull();
    expect(rows[0].strategy).toBe("default");
    expect(rows[0].result.strategy).toBe("default");
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
    expect(parsed.strategy).toBe("default");
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

  test("--strategy persists the effective strategy without populating the historical profile column", () => {
    const result = runCli(["improve", "--dry-run", "--strategy", "quick"], stashDir);
    expect(result.status).toBe(0);

    const rows = readImproveRuns(result.xdgData);
    expect(rows).toHaveLength(1);
    expect(rows[0].profile).toBeNull();
    expect(rows[0].strategy).toBe("quick");
    expect(rows[0].result.strategy).toBe("quick");
  });
});
