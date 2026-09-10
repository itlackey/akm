// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #944 end-to-end coverage: a real (non-dry-run) `akm improve` invocation
 * persists a `usageReport` in `result_json` and prints its table to stderr;
 * `akm improve report` reads it back — by default, by `--run <id>`, and
 * aggregated with `--since`; a pre-#944 row (seeded directly, no persisted
 * `usageReport`) degrades to a recomputed cross-tab with a `notes` entry
 * rather than fabricating eligibility reasons.
 *
 * Subprocess, not in-process: a real (non-dry-run) improve run opens and
 * writes state.db, and this suite additionally seeds rows/events into that
 * same file directly with bun:sqlite — same rationale as
 * `improve-cli-flags.test.ts`/`improve-cli-result-storage.test.ts` in this
 * directory (a held in-process DB handle would contend with a subprocess-free
 * approach; a real subprocess gets an uncontended DB per invocation).
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type SandboxedDir, makeStashDir as sandboxMakeStashDir } from "../../../_helpers/sandbox";

const disposers: SandboxedDir[] = [];
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function makeStashDir(): string {
  const stash = sandboxMakeStashDir();
  for (const sub of ["memories", "lessons"]) {
    fs.mkdirSync(path.join(stash.dir, sub), { recursive: true });
  }
  disposers.push(stash);
  return stash.dir;
}

interface TestEnv {
  env: NodeJS.ProcessEnv;
  stateDbPath: string;
}

function makeEnv(stashDir: string): TestEnv {
  const data = sandboxMakeStashDir();
  const cache = sandboxMakeStashDir();
  const config = sandboxMakeStashDir();
  const state = sandboxMakeStashDir();
  disposers.push(data, cache, config, state);
  const configDir = path.join(config.dir, "akm");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        test: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "test" },
      },
      defaults: { llmEngine: "test" },
    }),
  );
  return {
    env: {
      ...process.env,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      AKM_BUNDLE_DIR: stashDir,
      XDG_CACHE_HOME: cache.dir,
      XDG_CONFIG_HOME: config.dir,
      XDG_DATA_HOME: data.dir,
      XDG_STATE_HOME: state.dir,
    },
    stateDbPath: path.join(data.dir, "akm", "state.db"),
  };
}

function runCli(args: string[], testEnv: TestEnv): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bun", [cliPath, ...args], { encoding: "utf8", timeout: 60_000, env: testEnv.env });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

describe("akm improve report (#944)", () => {
  test("a live run persists usageReport, prints its table, and `improve report` reads it back", () => {
    const testEnv = makeEnv(makeStashDir());

    const live = runCli(["improve", "--json-to-stdout"], testEnv);
    expect(live.status).toBe(0);
    const parsed = JSON.parse(live.stdout) as Record<string, unknown>;
    expect(parsed.usageReport).toBeDefined();
    const usageReport = parsed.usageReport as {
      byProcessEngineModel: unknown[];
      noCalls: Array<Record<string, unknown>>;
    };
    // Empty stash: no eligible refs anywhere, so no LLM calls were made at all.
    expect(usageReport.byProcessEngineModel).toEqual([]);
    // memoryInference is autonomy-gated off by default (experimental.improveAutonomy unset).
    expect(usageReport.noCalls).toEqual(
      expect.arrayContaining([{ process: "memoryInference", reason: "autonomy_gated" }]),
    );
    // reflect/distill/consolidate/graphExtraction/validation are enabled by the
    // default strategy but made no calls on an empty stash — no fabricated reason.
    for (const process of ["reflect", "distill", "consolidate", "graphExtraction"]) {
      expect(usageReport.noCalls.some((row) => row.process === process && row.reason === "no_signal")).toBe(true);
    }
    // extract/proactiveMaintenance/triage are disabled by the default strategy — never listed.
    for (const process of ["extract", "proactiveMaintenance", "triage"]) {
      expect(usageReport.noCalls.some((row) => row.process === process)).toBe(false);
    }

    // The same table is printed to stderr after a real run.
    expect(live.stderr).toContain("[improve] usage report");
    expect(live.stderr).toContain("enabled processes with zero calls");

    // `akm improve report` with no flags finds the same run and returns the
    // same usageReport.
    const reportDefault = runCli(["improve", "report"], testEnv);
    expect(reportDefault.status).toBe(0);
    const reportDefaultParsed = JSON.parse(reportDefault.stdout) as Record<string, unknown>;
    expect(reportDefaultParsed.mode).toBe("run");
    expect(reportDefaultParsed.runId).toBe(parsed.runId);
    expect(reportDefaultParsed.strategy).toBe("default");
    expect(reportDefaultParsed.usageReport).toEqual(usageReport);

    // `--run <id>` selects the same run explicitly.
    const reportByRun = runCli(["improve", "report", "--run", String(parsed.runId)], testEnv);
    expect(reportByRun.status).toBe(0);
    expect(JSON.parse(reportByRun.stdout).runId).toBe(parsed.runId);

    // An unknown run id is a clean "not found" (exit 1), not a crash.
    const missing = runCli(["improve", "report", "--run", "does-not-exist"], testEnv);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stderr)).toMatchObject({ ok: false, code: "IMPROVE_RUN_NOT_FOUND" });

    // --run and --since are mutually exclusive (usage error, exit 2).
    const both = runCli(["improve", "report", "--run", "x", "--since", "24h"], testEnv);
    expect(both.status).toBe(2);
    expect(JSON.parse(both.stderr)).toMatchObject({ ok: false, code: "INVALID_FLAG_VALUE" });
  });

  test("--since aggregates multiple runs; a pre-0.9.15 row degrades to a recomputed cross-tab with a note", () => {
    const testEnv = makeEnv(makeStashDir());

    const first = runCli(["improve", "--json-to-stdout"], testEnv);
    expect(first.status).toBe(0);
    const second = runCli(["improve", "--json-to-stdout"], testEnv);
    expect(second.status).toBe(0);

    // Seed a third, pre-#944 row directly: a valid v2 envelope with NO
    // usageReport field (the shape every improve_runs row had before this
    // issue), plus its own llm_usage events on the SAME state.db a real run
    // just created (and migrated) above.
    const db = new Database(testEnv.stateDbPath);
    try {
      const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
      const completedAt = new Date(Date.now() - 4 * 60_000).toISOString();
      const legacyId = "legacy-run-pre-0.9.15";
      const legacyResult = {
        schemaVersion: 2,
        ok: true,
        strategy: "default",
        scope: { mode: "all" },
        dryRun: false,
        memorySummary: { eligible: 0, derived: 0 },
        plannedRefs: [],
        actions: [],
      };
      db.prepare(
        `INSERT INTO improve_runs
           (id, started_at, completed_at, stash_dir, dry_run, strategy, scope_mode, scope_value, guidance, ok, result_json, metrics_json, metadata_json)
         VALUES (?, ?, ?, ?, 0, ?, 'all', NULL, NULL, 1, ?, NULL, '{}')`,
      ).run(legacyId, startedAt, completedAt, "/legacy/stash", "default", JSON.stringify(legacyResult));
      const eventTs = new Date(Date.now() - 4.5 * 60_000).toISOString();
      for (let i = 0; i < 2; i++) {
        db.prepare(`INSERT INTO events (event_type, ts, ref, metadata_json) VALUES ('llm_usage', ?, NULL, ?)`).run(
          eventTs,
          JSON.stringify({
            outcome: "success",
            modelSource: "configured",
            durationMs: 40,
            process: "reflect",
            engine: "legacy-engine",
            model: "legacy-model",
            promptTokens: 3,
            completionTokens: 2,
            totalTokens: 5,
          }),
        );
      }

      // --run on the legacy row: recomputed cross-tab, empty noCalls (never
      // fabricated), a note explaining the degradation.
      const legacyReport = runCli(["improve", "report", "--run", legacyId], testEnv);
      expect(legacyReport.status).toBe(0);
      const legacyParsed = JSON.parse(legacyReport.stdout) as Record<string, unknown>;
      expect(legacyParsed.usageReport).toMatchObject({
        byProcessEngineModel: [
          {
            process: "reflect",
            engine: "legacy-engine",
            model: "legacy-model",
            calls: 2,
            failures: 0,
            promptTokens: 6,
            completionTokens: 4,
            totalTokens: 10,
          },
        ],
        noCalls: [],
      });
      expect(legacyParsed.notes).toEqual(expect.arrayContaining([expect.stringContaining("before 0.9.15")]));

      // --since covering all three runs (two real + the seeded legacy one).
      const since = runCli(["improve", "report", "--since", "24h"], testEnv);
      expect(since.status).toBe(0);
      const sinceParsed = JSON.parse(since.stdout) as Record<string, unknown>;
      expect(sinceParsed.mode).toBe("since");
      expect(sinceParsed.runIds).toEqual(
        expect.arrayContaining([
          first ? JSON.parse(first.stdout).runId : "",
          second ? JSON.parse(second.stdout).runId : "",
          legacyId,
        ]),
      );
      expect((sinceParsed.runIds as string[]).length).toBe(3);
      const sinceUsage = sinceParsed.usageReport as { byProcessEngineModel: Array<Record<string, unknown>> };
      const reflectAgg = sinceUsage.byProcessEngineModel.find(
        (row) => row.process === "reflect" && row.engine === "legacy-engine",
      );
      expect(reflectAgg).toMatchObject({ calls: 2, promptTokens: 6 });
    } finally {
      db.close();
    }
  });

  test("--since surfaces the most recent run's noCalls reason per process, not the oldest", () => {
    const testEnv = makeEnv(makeStashDir());

    // `improve report --since` on its own initialises and migrates
    // state.db without making any LLM calls or improve_runs rows.
    const init = runCli(["improve", "report", "--since", "24h"], testEnv);
    expect(init.status).toBe(0);

    // Seed two rows directly, both WITH a persisted usageReport, whose
    // noCalls reason for the same process ("consolidate") differs: the
    // older run says engine_unavailable, the newer one says no_signal.
    // `queryImproveRuns` returns rows newest-first, so `--since` must
    // surface the newer run's reason, not the older run's.
    const db = new Database(testEnv.stateDbPath);
    try {
      const baseResult = {
        schemaVersion: 2,
        ok: true,
        strategy: "default",
        scope: { mode: "all" },
        dryRun: false,
        memorySummary: { eligible: 0, derived: 0 },
        plannedRefs: [],
        actions: [],
      };
      const insertRun = (id: string, startedAt: string, completedAt: string, reason: string) => {
        db.prepare(
          `INSERT INTO improve_runs
             (id, started_at, completed_at, stash_dir, dry_run, strategy, scope_mode, scope_value, guidance, ok, result_json, metrics_json, metadata_json)
           VALUES (?, ?, ?, ?, 0, ?, 'all', NULL, NULL, 1, ?, NULL, '{}')`,
        ).run(
          id,
          startedAt,
          completedAt,
          "/order-test/stash",
          "default",
          JSON.stringify({
            ...baseResult,
            usageReport: {
              byProcessEngineModel: [],
              noCalls: [{ process: "consolidate", reason }],
            },
          }),
        );
      };
      insertRun(
        "since-order-run-older",
        new Date(Date.now() - 10 * 60_000).toISOString(),
        new Date(Date.now() - 9 * 60_000).toISOString(),
        "engine_unavailable",
      );
      insertRun(
        "since-order-run-newer",
        new Date(Date.now() - 2 * 60_000).toISOString(),
        new Date(Date.now() - 1 * 60_000).toISOString(),
        "no_signal",
      );

      const since = runCli(["improve", "report", "--since", "24h"], testEnv);
      expect(since.status).toBe(0);
      const sinceParsed = JSON.parse(since.stdout) as {
        usageReport: { noCalls: Array<Record<string, unknown>> };
      };
      expect(sinceParsed.usageReport.noCalls).toEqual(
        expect.arrayContaining([{ process: "consolidate", reason: "no_signal" }]),
      );
      expect(sinceParsed.usageReport.noCalls).not.toEqual(
        expect.arrayContaining([{ process: "consolidate", reason: "engine_unavailable" }]),
      );
    } finally {
      db.close();
    }
  });

  test("a terminated run (recordTerminatedImproveRun) degrades with an accurate note, not the pre-0.9.15 claim", () => {
    const testEnv = makeEnv(makeStashDir());

    // A live run first, so state.db exists and is migrated (same pattern as
    // the pre-0.9.15 legacy-row test above).
    const live = runCli(["improve", "--json-to-stdout"], testEnv);
    expect(live.status).toBe(0);

    // Seed a row shaped exactly like recordTerminatedImproveRun's envelope
    // (improve-result-file.ts): current, but never reached
    // finalizeImproveResult, so it also has no persisted usageReport.
    const db = new Database(testEnv.stateDbPath);
    try {
      const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
      const completedAt = new Date().toISOString();
      const terminatedId = "terminated-run";
      const terminatedResult = {
        schemaVersion: 2,
        ok: false,
        strategy: "default",
        scope: { mode: "all" },
        dryRun: false,
        memorySummary: { eligible: 0, derived: 0 },
        actions: [],
        plannedRefs: [],
        terminated: { reason: "SIGTERM", at: completedAt },
      };
      db.prepare(
        `INSERT INTO improve_runs
           (id, started_at, completed_at, stash_dir, dry_run, strategy, scope_mode, scope_value, guidance, ok, result_json, metrics_json, metadata_json)
         VALUES (?, ?, ?, ?, 0, ?, 'all', NULL, NULL, 0, ?, NULL, ?)`,
      ).run(
        terminatedId,
        startedAt,
        completedAt,
        "/legacy/stash",
        "default",
        JSON.stringify(terminatedResult),
        JSON.stringify({ terminated: { reason: "SIGTERM", at: completedAt } }),
      );

      const report = runCli(["improve", "report", "--run", terminatedId], testEnv);
      expect(report.status).toBe(0);
      const parsed = JSON.parse(report.stdout) as Record<string, unknown>;
      expect(parsed.notes).toEqual(["run terminated before completion; no usage report was recorded"]);
      expect((parsed.notes as string[])[0]).not.toContain("before 0.9.15");
    } finally {
      db.close();
    }
  });
});
