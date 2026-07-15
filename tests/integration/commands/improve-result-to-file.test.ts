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
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmImproveResult } from "../../../src/commands/improve/improve";
import {
  buildImproveRunId,
  improveRunLocator,
  recordImproveRunResult,
} from "../../../src/commands/improve/improve-result-file";
import { type SandboxedDir, makeStashDir as sandboxMakeStashDir, sandboxXdgDataHome } from "../../_helpers/sandbox";

// The pure-function tests (buildImproveRunId, improveRunLocator,
// recordImproveRunResult) run in-process — recordImproveRunResult isolates
// state.db via the allowlisted sandboxXdgDataHome helper. The three `akm
// improve` CLI tests that used to live here run `improve` for real (which
// opens and WRITES the state.db improve_runs table, hitting genuine
// cross-process SQLite contention in-process) and were moved to
// tests/integration/improve-cli-result-storage.test.ts.

const disposers: Array<{ cleanup: () => void }> = [];

function makeStashDir(): string {
  const stash: SandboxedDir = sandboxMakeStashDir();
  // sandboxMakeStashDir lacks the lessons/memories subdirs improve expects.
  for (const sub of ["memories", "lessons"]) {
    fs.mkdirSync(path.join(stash.dir, sub), { recursive: true });
  }
  disposers.push(stash);
  return stash.dir;
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

describe("buildImproveRunId", () => {
  test("returns a unique id across consecutive calls", () => {
    const a = buildImproveRunId();
    const b = buildImproveRunId();
    expect(a).not.toEqual(b);
    // Format sanity: ISO-style timestamp with -<8 hex>
    expect(a).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/);
  });
});

describe("improveRunLocator", () => {
  test("returns a state.db locator (not a filesystem path)", () => {
    const rel = improveRunLocator("test-run");
    // Compatibility shim: still a relative-style string for log messages,
    // but now references the state.db row rather than an on-disk file.
    expect(path.isAbsolute(rel)).toBe(false);
    expect(rel).toBe(path.join("state.db", "improve_runs", "test-run"));
  });
});

describe("recordImproveRunResult", () => {
  const baseResult: AkmImproveResult = {
    schemaVersion: 2,
    ok: true,
    strategy: "default",
    scope: { mode: "all" },
    dryRun: false,
    memorySummary: { eligible: 1, derived: 0 },
    plannedRefs: [],
  };

  test("records a row in the improve_runs table of state.db", () => {
    const stash = makeStashDir();
    const runId = "test-run-write";

    // Isolate state.db to a tmpdir so the test never touches the user's real
    // data directory. The sandbox helper sets + restores XDG_DATA_HOME so the
    // test-isolation lint stays satisfied (recordImproveRunResult resolves
    // state.db from getDataDir() → <XDG_DATA_HOME>/akm/state.db).
    const dataSb = sandboxXdgDataHome();
    const xdgData = dataSb.dir;

    try {
      const rel = recordImproveRunResult(stash, runId, baseResult);
      // Return value is now a state.db locator for log messages, not a file path.
      expect(rel).toBe(path.join("state.db", "improve_runs", runId));

      const rows = readImproveRuns(xdgData);
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(runId);
      expect(rows[0].ok).toBe(1);
      expect(rows[0].dry_run).toBe(0);
      expect(rows[0].scope_mode).toBe("all");
      expect(rows[0].profile).toBeNull();
      expect(rows[0].strategy).toBe("default");
      expect(rows[0].result.ok).toBe(true);

      // No legacy on-disk file under .akm/runs/ — the storage swap is complete.
      const runsDir = path.join(stash, ".akm", "runs");
      expect(fs.existsSync(runsDir)).toBe(false);
    } finally {
      dataSb.cleanup();
    }
  });

  test("records the passed-through v2 strategy without relabeling it as a profile", () => {
    const stash = makeStashDir();
    const runId = "test-run-with-strategy";

    const dataSb = sandboxXdgDataHome();
    const xdgData = dataSb.dir;
    try {
      recordImproveRunResult(stash, runId, { ...baseResult, strategy: "quick" });
      const rows = readImproveRuns(xdgData);
      expect(rows.length).toBe(1);
      expect(rows[0].profile).toBeNull();
      expect(rows[0].strategy).toBe("quick");
    } finally {
      dataSb.cleanup();
    }
  });

  test("redacts even a one-character engine secret before durable result persistence", () => {
    const stash = makeStashDir();
    const dataSb = sandboxXdgDataHome();
    try {
      recordImproveRunResult(
        stash,
        "test-run-redacted",
        { ...baseResult, guidance: "credential x echoed" },
        undefined,
        ["x"],
      );
      const persisted = JSON.stringify(readImproveRuns(dataSb.dir));
      expect(persisted).not.toContain("credential x echoed");
      expect(persisted).toContain("credential [REDACTED] echoed");
    } finally {
      dataSb.cleanup();
    }
  });

  test("started_at uses the explicit startedAt parameter and differs from completed_at", () => {
    const stash = makeStashDir();
    const runId = buildImproveRunId(new Date("2026-05-01T10:00:00.000Z"));
    const startedAt = "2026-05-01T10:00:00.000Z";

    const dataSb = sandboxXdgDataHome();
    const xdgData = dataSb.dir;
    try {
      recordImproveRunResult(stash, runId, baseResult, startedAt);
      const rows = readImproveRuns(xdgData);
      expect(rows.length).toBe(1);
      expect(rows[0].started_at).toBe(startedAt);
      // completed_at is set to now() at write time — must be >= started_at
      expect(rows[0].completed_at).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null on the line above
      expect(new Date(rows[0].completed_at!).getTime()).toBeGreaterThanOrEqual(new Date(rows[0].started_at).getTime());
    } finally {
      dataSb.cleanup();
    }
  });

  test("started_at fallback decodes correctly from runId when startedAt is omitted", () => {
    const stash = makeStashDir();
    // Use a runId whose embedded timestamp is at least a second in the past
    const past = new Date(Date.now() - 60_000);
    const runId = buildImproveRunId(past);

    const dataSb = sandboxXdgDataHome();
    const xdgData = dataSb.dir;
    try {
      recordImproveRunResult(stash, runId, baseResult);
      const rows = readImproveRuns(xdgData);
      expect(rows.length).toBe(1);
      // started_at should be close to `past`, not to now()
      const storedStart = new Date(rows[0].started_at).getTime();
      expect(Math.abs(storedStart - past.getTime())).toBeLessThan(1000);
      // completed_at must be after started_at
      // biome-ignore lint/style/noNonNullAssertion: completed_at is always set on successful writes
      expect(new Date(rows[0].completed_at!).getTime()).toBeGreaterThan(storedStart);
    } finally {
      dataSb.cleanup();
    }
  });
});
