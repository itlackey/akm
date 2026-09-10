/**
 * Tests for the 0.8.0+ default behaviour of `akm improve`:
 *   - Full result is recorded as a row in the `improve_runs` table of state.db
 *     (migration 003).
 *   - Stdout is empty in default mode — the existing `[improve] ...` log
 *     lines on stderr remain the canonical console UX.
 *   - `--json-to-stdout` can additionally emit the persisted result.
 *
 * Pre-0.8.0 these tests asserted on `<stash>/.akm/runs/<id>/improve-result.json`
 * files. Item 10 of the 0.8.0 pre-production polish plan migrated the storage
 * to state.db; the tests were updated to match. See CHANGELOG.md 0.8.0 entry
 * "improve_runs table in state.db (migration 003)".
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmImproveResult } from "../../../src/commands/improve/improve";
import {
  buildImproveRunId,
  recordImproveRunResult,
  recordTerminatedImproveRun,
} from "../../../src/commands/improve/improve-result-file";
import * as stateDbModule from "../../../src/core/state-db";
import { type SandboxedDir, makeStashDir as sandboxMakeStashDir, sandboxXdgDataHome } from "../../_helpers/sandbox";

// The buildImproveRunId and recordImproveRunResult tests run in-process;
// recordImproveRunResult isolates
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
  strategy: string | null;
  result: Record<string, unknown>;
}> {
  const dbPath = path.join(xdgData, "akm", "state.db");
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, started_at, completed_at, dry_run, ok, scope_mode, strategy, result_json
         FROM improve_runs ORDER BY started_at ASC`,
      )
      .all() as Array<{
      id: string;
      started_at: string;
      completed_at: string | null;
      dry_run: number;
      ok: number;
      scope_mode: string;
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
      recordImproveRunResult(stash, runId, baseResult);

      const rows = readImproveRuns(xdgData);
      expect(rows.length).toBe(1);
      expect(rows[0]!.id).toBe(runId);
      expect(rows[0]!.ok).toBe(1);
      expect(rows[0]!.dry_run).toBe(0);
      expect(rows[0]!.scope_mode).toBe("all");
      expect(rows[0]!.strategy).toBe("default");
      expect(rows[0]!.result.ok).toBe(true);

      // No legacy on-disk file under .akm/runs/ — the storage swap is complete.
      const runsDir = path.join(stash, ".akm", "runs");
      expect(fs.existsSync(runsDir)).toBe(false);
    } finally {
      dataSb.cleanup();
    }
  });

  test("records the passed-through v2 strategy", () => {
    const stash = makeStashDir();
    const runId = "test-run-with-strategy";

    const dataSb = sandboxXdgDataHome();
    const xdgData = dataSb.dir;
    try {
      recordImproveRunResult(stash, runId, { ...baseResult, strategy: "quick" });
      const rows = readImproveRuns(xdgData);
      expect(rows.length).toBe(1);
      expect(rows[0]!.strategy).toBe("quick");
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
      expect(rows[0]!.started_at).toBe(startedAt);
      // completed_at is set to now() at write time — must be >= started_at
      expect(rows[0]!.completed_at).not.toBeNull();
      expect(new Date(rows[0]!.completed_at!).getTime()).toBeGreaterThanOrEqual(
        new Date(rows[0]!.started_at).getTime(),
      );
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
      const storedStart = new Date(rows[0]!.started_at).getTime();
      expect(Math.abs(storedStart - past.getTime())).toBeLessThan(1000);
      // completed_at must be after started_at
      expect(new Date(rows[0]!.completed_at!).getTime()).toBeGreaterThan(storedStart);
    } finally {
      dataSb.cleanup();
    }
  });
});

describe("BEGIN IMMEDIATE retry path (#948)", () => {
  /**
   * Wrap `fn` so the FIRST `BEGIN IMMEDIATE` issued by the real
   * `withImmediateTransaction` call inside `fn` fails "database is locked" —
   * the shared contention classifier (`isSqliteContentionError`) — and every
   * later attempt runs for real against the real connection. Same technique
   * as tests/integration/state-db/with-immediate-transaction.test.ts's
   * fake-exec tests, applied via a spy on `withImmediateTransaction` (rather
   * than a hand-built fake `Database`) since the real connection here is
   * opened internally by `withStateDb`, not passed in from the test. Pins
   * that `recordImproveRunResult`/`recordTerminatedImproveRun` go through the
   * retrying helper — not a bare write that would surface the raw driver
   * error as an exit-70 crash — by proving the row still gets written after
   * one induced contention failure.
   */
  function withOneBeginImmediateFailure<T>(fn: () => T): T {
    const real = stateDbModule.withImmediateTransaction;
    let beginAttempts = 0;
    const spy = spyOn(stateDbModule, "withImmediateTransaction").mockImplementation((db, txFn) => {
      const originalExec = db.exec.bind(db);
      db.exec = ((sql: string) => {
        if (sql === "BEGIN IMMEDIATE" && beginAttempts === 0) {
          beginAttempts += 1;
          throw new Error("database is locked");
        }
        originalExec(sql);
      }) as typeof db.exec;
      try {
        return real(db, txFn);
      } finally {
        db.exec = originalExec;
      }
    });
    try {
      const result = fn();
      expect(beginAttempts).toBe(1); // the induced failure actually fired, and was retried
      return result;
    } finally {
      spy.mockRestore();
    }
  }

  const baseResult: AkmImproveResult = {
    schemaVersion: 2,
    ok: true,
    strategy: "default",
    scope: { mode: "all" },
    dryRun: false,
    memorySummary: { eligible: 1, derived: 0 },
    plannedRefs: [],
  };

  test("recordImproveRunResult: a transient BEGIN IMMEDIATE failure is retried, not surfaced — the row is recorded", () => {
    const stash = makeStashDir();
    const runId = "test-run-begin-immediate-retry";
    const dataSb = sandboxXdgDataHome();
    try {
      withOneBeginImmediateFailure(() => recordImproveRunResult(stash, runId, baseResult));
      const rows = readImproveRuns(dataSb.dir);
      expect(rows.length).toBe(1);
      expect(rows[0]!.id).toBe(runId);
      expect(rows[0]!.ok).toBe(1);
    } finally {
      dataSb.cleanup();
    }
  });

  test("recordTerminatedImproveRun: a transient BEGIN IMMEDIATE failure is retried, not surfaced — the row is recorded", () => {
    const stash = makeStashDir();
    const runId = "test-run-terminated-begin-immediate-retry";
    const dataSb = sandboxXdgDataHome();
    try {
      withOneBeginImmediateFailure(() =>
        recordTerminatedImproveRun(stash, runId, new Date().toISOString(), "SIGTERM", { strategy: "default" }),
      );
      const rows = readImproveRuns(dataSb.dir);
      expect(rows.length).toBe(1);
      expect(rows[0]!.id).toBe(runId);
      expect(rows[0]!.ok).toBe(0);
    } finally {
      dataSb.cleanup();
    }
  });
});
