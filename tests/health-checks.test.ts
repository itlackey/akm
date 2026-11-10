// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmHealth } from "../src/commands/health";
import { dominantAgentFailureReason, HEALTH_CHECKS, type HealthCheckContext } from "../src/commands/health/checks";
import {
  type ReachabilityProbe,
  runConnectionsAndHarnessesCheck,
} from "../src/commands/health/connections-and-harnesses-check";
import { type SemanticSearchState, semanticSearchCheck } from "../src/commands/health/semantic-search-check";
import { matchImproveTaskId } from "../src/commands/health/task-runs";
import type { HealthCheckResult, WindowResult } from "../src/commands/health/types";
import { collectUnrunnableTasksAdvisory } from "../src/commands/health/unrunnable-tasks";
import { computeDeltas, readNumericPath } from "../src/commands/health/windows";
import type { AkmConfig } from "../src/core/config/config";
import { saveConfig } from "../src/core/config/config";
import type { SemanticSearchRecord } from "../src/indexer/walk/index-context";
import type { StateDbFreelistInfo, StateDbIntegrityResult } from "../src/storage/state-db-integrity";
import { mockClaudePluginList, selectClaudePlugin } from "./_helpers/claude-plugins";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

/**
 * `scheduler-binary` (#953) as registered in HEALTH_CHECKS: a pure
 * pass-through of ctx.schedulerBinaryDrift, precomputed (process-spawn IO)
 * once in health.ts — the probe/backend logic itself is covered by
 * tests/commands/health/scheduler-binary.test.ts.
 */

const check = HEALTH_CHECKS.find((c) => c.name === "scheduler-binary");

describe("scheduler-binary check (#953)", () => {
  test("is registered as the last advisory in HEALTH_CHECKS — order is load-bearing", () => {
    expect(check).toBeDefined();
    expect(check?.channel).toBe("advisory");
    const names = HEALTH_CHECKS.map((c) => c.name);
    expect(names[names.length - 1]).toBe("scheduler-binary");
  });

  test("is a pure projection of ctx.schedulerBinaryDrift", () => {
    if (!check) throw new Error("scheduler-binary check not registered");
    const schedulerBinaryDrift: HealthCheckResult = {
      name: "scheduler-binary",
      kind: "deterministic",
      status: "warn",
      confidence: "high",
      message: "Scheduled tasks are bound to akm v0.9.14, but the running CLI is v0.9.15 — run `akm task sync`.",
      evidence: { scheduledVersion: "0.9.14", cliVersion: "0.9.15" },
    };
    const r = check.run({ schedulerBinaryDrift } as unknown as HealthCheckContext);
    expect(r).toBe(schedulerBinaryDrift);
  });
});

{
  /**
   * `cli-version` (#950) as registered in HEALTH_CHECKS: a pure pass-through
   * of ctx.versionDrift, precomputed (network IO) once in health.ts — the
   * network/logic itself is covered by
   * tests/commands/health/version-drift.test.ts.
   */

  const check = HEALTH_CHECKS.find((c) => c.name === "cli-version");

  describe("cli-version check (#950)", () => {
    test("is registered as an advisory check, between auto-accept-validation and scheduler-binary", () => {
      expect(check).toBeDefined();
      expect(check?.channel).toBe("advisory");
      const names = HEALTH_CHECKS.map((c) => c.name);
      expect(names.indexOf("cli-version")).toBe(names.indexOf("auto-accept-validation") + 1);
      expect(names.indexOf("cli-version")).toBe(names.indexOf("scheduler-binary") - 1);
    });

    test("is a pure projection of ctx.versionDrift", () => {
      if (!check) throw new Error("cli-version check not registered");
      const versionDrift: HealthCheckResult = {
        name: "cli-version",
        kind: "deterministic",
        status: "warn",
        confidence: "high",
        message: "akm v0.9.12 is installed; v0.9.15 is available — run 'akm upgrade'.",
        evidence: { installedVersion: "0.9.12", latestVersion: "0.9.15" },
      };
      const r = check.run({ versionDrift } as unknown as HealthCheckContext);
      expect(r).toBe(versionDrift);
    });
  });
}

{
  // Item 7: `active-runs` used to report only a count of stuck task runs. It now
  // names WHICH task_ids are stuck (deduped, oldest-first) so an operator knows
  // where to look — no pid/liveness detection, purely a projection of the rows
  // already read. The check is a pure projection of ctx.stuckActiveRuns /
  // ctx.stuckActiveTasks, so we drive it directly with synthetic counts.

  const check = HEALTH_CHECKS.find((c) => c.name === "active-runs");

  function run(stuckActiveRuns: number, stuckActiveTasks: { taskId: string; ageMs: number }[]) {
    if (!check) throw new Error("active-runs check not registered");
    return check.run({ stuckActiveRuns, stuckActiveTasks } as unknown as HealthCheckContext);
  }

  describe("active-runs check (item 7)", () => {
    test("is registered as a hard check", () => {
      expect(check).toBeDefined();
      expect(check?.channel).toBe("hard");
    });

    test("passes with no message detail when nothing is stuck", () => {
      const r = run(0, []);
      expect(r.status).toBe("pass");
      expect(r.message).toBe("No active task runs exceeded the stale threshold.");
      expect(r.evidence?.stuckActiveTasks).toEqual([]);
    });

    test("names each stuck task_id and its age, oldest first", () => {
      const r = run(2, [
        { taskId: "akm-improve", ageMs: 16 * 60_000 },
        { taskId: "nightly-sync", ageMs: 40 * 60_000 },
      ]);
      expect(r.status).toBe("warn");
      // Oldest (nightly-sync, 40m) is named before the newer one (akm-improve, 16m).
      expect(r.message.indexOf("nightly-sync")).toBeLessThan(r.message.indexOf("akm-improve"));
      expect(r.message).toContain("nightly-sync (40m)");
      expect(r.message).toContain("akm-improve (16m)");
      expect(r.message).toContain("2 active task run(s)");
      expect(r.evidence?.stuckActiveRuns).toBe(2);
      expect(r.evidence?.stuckActiveTasks).toEqual([
        { taskId: "akm-improve", ageMs: 16 * 60_000 },
        { taskId: "nightly-sync", ageMs: 40 * 60_000 },
      ]);
    });

    test("dedupes to one entry per distinct task_id (caller's responsibility, but the check trusts it)", () => {
      const r = run(1, [{ taskId: "solo-task", ageMs: 20 * 60_000 }]);
      expect(r.status).toBe("warn");
      expect(r.message).toContain("solo-task (20m)");
    });
  });
}

{
  // Item 6: `task-fail-rate` used to warn only off the aggregate rate, which
  // hides a single consistently-failing task inside a large, mostly-healthy
  // population. It now also warns when the worst single task_id (with enough
  // rows to be a real signal) crosses the same threshold. The check is a pure
  // projection of ctx.taskFailRate / ctx.taskRowCount / ctx.worstTaskFailRate,
  // so we drive it directly with synthetic inputs (the task_id grouping itself
  // is covered end-to-end in tests/integration/health-task-fail-rate.test.ts).

  const check = HEALTH_CHECKS.find((c) => c.name === "task-fail-rate");

  function run(
    taskFailRate: number,
    taskRowCount: number,
    worstTaskFailRate: { taskId: string; rate: number; rows: number } | null,
  ) {
    if (!check) throw new Error("task-fail-rate check not registered");
    return check.run({
      taskFailRate,
      taskRowCount,
      since: "2026-01-01T00:00:00.000Z",
      worstTaskFailRate,
    } as unknown as HealthCheckContext);
  }

  describe("task-fail-rate check worst-single-task signal (item 6)", () => {
    test("stays pass when the aggregate is below threshold and no task qualifies", () => {
      const r = run(0.01, 100, null);
      expect(r.status).toBe("pass");
    });

    test("warns off the worst single task even when the aggregate stays below threshold", () => {
      const r = run(0.01, 100, { taskId: "flaky-task", rate: 0.2, rows: 5 });
      expect(r.status).toBe("warn");
      expect(r.message).toContain('task "flaky-task" fails 20.0%');
      expect(r.message).toContain("5 run(s)");
      expect(r.evidence?.worstTaskFailRate).toEqual({ taskId: "flaky-task", rate: 0.2, rows: 5 });
    });

    test("still warns off the aggregate when no single task qualifies", () => {
      const r = run(0.15, 20, null);
      expect(r.status).toBe("warn");
      expect(r.message).toContain("aggregate 15.0%");
      expect(r.message).not.toContain('task "');
    });

    test("warns with both reasons named when aggregate and worst task both cross the threshold", () => {
      const r = run(0.1, 20, { taskId: "flaky-task", rate: 0.5, rows: 6 });
      expect(r.status).toBe("warn");
      expect(r.message).toContain("aggregate 10.0%");
      expect(r.message).toContain('task "flaky-task" fails 50.0%');
    });

    test("no signal when no cron tasks ran, regardless of worstTaskFailRate", () => {
      const r = run(0, 0, null);
      expect(r.status).toBe("pass");
      expect(r.message).toContain("No cron tasks ran");
    });
  });
}

describe("health-unrunnable-tasks", () => {
  /** `akm health` names an enabled task that dispatch cannot run: nothing else would say so, dispatch.log is rewritten each minute. */

  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
  });
  afterEach(() => storage.cleanup());

  function configure(enabled: string[] | undefined): void {
    saveConfig({
      semanticSearchMode: "off",
      defaultBundle: "stash",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      ...(enabled ? { scheduler: { enabled } } : {}),
    });
  }

  describe("unrunnable-tasks advisory", () => {
    test("passes when every enabled task can be read and scheduled, or none is enabled", () => {
      fs.writeFileSync(path.join(storage.stashDir, "tasks", "ok.yml"), 'version: 4\nrun: "true"\nschedule: "@daily"\n');
      configure(["stash//tasks/ok"]);
      expect(collectUnrunnableTasksAdvisory().status).toBe("pass");
      configure(undefined);
      expect(collectUnrunnableTasksAdvisory().status).toBe("pass");
    });

    test("warns naming each task that cannot run and why", () => {
      fs.writeFileSync(
        path.join(storage.stashDir, "tasks", "reboot.yml"),
        'version: 4\nrun: "true"\nschedule: "@reboot"\n',
      );
      configure(["stash//tasks/reboot", "stash//tasks/gone"]);

      const result = collectUnrunnableTasksAdvisory();

      expect(result.status).toBe("warn");
      expect(result.message).toContain("stash//tasks/reboot");
      expect(result.message).toContain("stash//tasks/gone");
      expect(result.evidence).toMatchObject({
        failures: [{ ref: "stash//tasks/reboot" }, { ref: "stash//tasks/gone" }],
      });
    });

    test("is registered as an advisory that projects the context, ahead of scheduler-binary", () => {
      const names = HEALTH_CHECKS.map((check) => check.name);
      expect(names).toContain("unrunnable-tasks");
      expect(names.indexOf("unrunnable-tasks")).toBeLessThan(names.indexOf("scheduler-binary"));
      const check = HEALTH_CHECKS.find((entry) => entry.name === "unrunnable-tasks");
      const projected = collectUnrunnableTasksAdvisory();
      expect(check?.run({ unrunnableTasks: projected } as unknown as HealthCheckContext)).toBe(projected);
    });
  });
});

describe("readNumericPath", () => {
  test("walks a dotted path to a finite number", () => {
    expect(readNumericPath({ a: { b: 5 } }, "a.b")).toBe(5);
  });

  test("returns 0 for a missing leaf", () => {
    expect(readNumericPath({ a: { b: 5 } }, "a.c")).toBe(0);
  });

  test("returns 0 when an intermediate segment is not an object", () => {
    expect(readNumericPath({ a: 1 }, "a.b")).toBe(0);
  });

  test("returns 0 for null root and for non-finite values", () => {
    expect(readNumericPath(null, "a")).toBe(0);
    expect(readNumericPath({ a: Number.NaN }, "a")).toBe(0);
  });
});

describe("computeDeltas", () => {
  const mk = (failed: number): WindowResult =>
    ({ improve: { actions: { reflect: { failed } } } }) as unknown as WindowResult;

  test("computes percent change for a changed interesting path", () => {
    const out = computeDeltas(mk(2), mk(4));
    expect(out["improve.actions.reflect.failed"]).toEqual({ from: 2, to: 4, pctChange: 100 });
  });

  test("reports +inf when the baseline is zero", () => {
    const out = computeDeltas(mk(0), mk(4));
    expect(out["improve.actions.reflect.failed"]).toEqual({ from: 0, to: 4, pctChange: "+inf" });
  });

  test("skips paths that are zero in both windows", () => {
    expect(computeDeltas(mk(0), mk(0))).toEqual({});
  });
});

describe("matchImproveTaskId", () => {
  const at = (iso: string) => Date.parse(iso);

  test("attributes a run to the nearest scheduled improve task within ±5 min", () => {
    const taskId = matchImproveTaskId("2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z", [
      { taskId: "akm-improve-frequent", startMs: at("2026-01-01T00:00:30Z"), endMs: Number.NaN },
      { taskId: "akm-improve-proactive-weekly", startMs: at("2026-01-01T00:04:00Z"), endMs: Number.NaN },
    ]);
    expect(taskId).toBe("akm-improve-frequent");
  });

  test("returns 'manual' when no task starts within the window", () => {
    const taskId = matchImproveTaskId("2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z", [
      { taskId: "akm-improve-frequent", startMs: at("2026-01-01T00:10:00Z"), endMs: Number.NaN },
    ]);
    expect(taskId).toBe("manual");
  });

  test("returns 'manual' for an unparseable start timestamp", () => {
    expect(matchImproveTaskId("not-a-date", "2026-01-01T00:01:00Z", [])).toBe("manual");
  });
});

describe("dominantAgentFailureReason", () => {
  test("exactly 50% counts as dominant", () => {
    expect(dominantAgentFailureReason({ timeout: 6, non_zero_exit: 6 })).toEqual({
      reason: "non_zero_exit",
      count: 6,
      total: 12,
    });
  });

  test("below 50% is undefined", () => {
    expect(dominantAgentFailureReason({ timeout: 5, non_zero_exit: 4, spawn_failed: 3 })).toBeUndefined();
  });

  test("a tie between two reasons picks the alphabetically first", () => {
    expect(dominantAgentFailureReason({ timeout: 5, spawn_failed: 5 })).toEqual({
      reason: "spawn_failed",
      count: 5,
      total: 10,
    });
  });

  test("an empty object is undefined", () => {
    expect(dominantAgentFailureReason({})).toBeUndefined();
  });
});

describe("health-plugin-version-wiring", () => {
  /**
   * itlackey/akm#832: `akmHealth()` must actually surface the `plugin-version`
   * advisory end-to-end (not just the standalone collector unit-tested in
   * `tests/integration/commands/health/plugin-staleness.test.ts`). Deliberately
   * exercises only the local, network-free path here — no `marketplaces/` dir
   * is written, so the "newest available" lookup (the one path that shells out
   * to `git ls-remote`) never fires and this stays a pure filesystem test.
   */

  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    mockClaudePluginList();
  });

  afterEach(() => {
    storage.cleanup();
  });

  function findChecks(checks: HealthCheckResult[], name: string): HealthCheckResult[] {
    return checks.filter((c) => c.name === name);
  }

  function findCheck(checks: HealthCheckResult[], name: string): HealthCheckResult {
    const found = checks.find((c) => c.name === name);
    if (!found) throw new Error(`expected an advisory named ${name}`);
    return found;
  }

  function installPlugin(pluginsRoot: string, version: string, versionRange: string): void {
    const pluginDir = path.join(pluginsRoot, "cache", "akm-plugins", "akm", version);
    selectClaudePlugin(pluginsRoot, [
      { id: "akm@akm-plugins", version, scope: "user", enabled: true, installPath: pluginDir },
    ]);
    fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "akm", version }));
    fs.mkdirSync(path.join(pluginDir, "shared"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "shared", "akm-version.ts"),
      `export const AKM_VERSION_RANGE = "${versionRange}"\n`,
    );
  }

  describe("plugin-version advisory wiring (itlackey/akm#832)", () => {
    test("no Claude plugin installed produces no plugin-version advisory", async () => {
      const result = await akmHealth({ since: "7d" });
      expect(findChecks(result.advisories, "plugin-version")).toEqual([]);
    });

    test("an installed plugin whose range rejects the running CLI is surfaced as a warn advisory", async () => {
      installPlugin(storage.claudePluginsDir, "0.9.1", "0.9.1");

      const result = await akmHealth({ since: "7d" });
      const advisory = findCheck(result.advisories, "plugin-version");

      expect(advisory.status).toBe("warn");
      expect(advisory.evidence?.admitted).toBe(false);
      expect(advisory.message).toContain("NOT ADMITTED");
      expect(result.status).toBe("warn");
    });
  });
});

{
  /**
   * R0: `akm health` never looked at state.db's own SQLite-level
   * integrity — the pre-existing `state-db-round-trip` check only proves one
   * row can be appended and read back, which stays true on a database that
   * fails `PRAGMA integrity_check` elsewhere (out-of-order rowids, bad index
   * entry counts). `state-db-integrity` closes that gap and also reports the
   * freelist ratio (fraction of pages VACUUM could reclaim).
   *
   * The check is a pure projection of ctx.stateDbIntegrity / ctx.stateDbFreelist
   * (see health-active-runs-check.test.ts for the established pattern), so it
   * is driven directly with synthetic pragma results — no real database.
   */

  const check = HEALTH_CHECKS.find((c) => c.name === "state-db-integrity");

  function run(stateDbIntegrity: StateDbIntegrityResult, stateDbFreelist: StateDbFreelistInfo) {
    if (!check) throw new Error("state-db-integrity check not registered");
    return check.run({
      stateDbPath: "/tmp/state.db",
      stateDbIntegrity,
      stateDbFreelist,
    } as unknown as HealthCheckContext);
  }

  describe("state-db-integrity check (R0)", () => {
    test("is registered as a hard check", () => {
      expect(check).toBeDefined();
      expect(check?.channel).toBe("hard");
    });

    test("passes when integrity_check reports ok and the freelist ratio is low", () => {
      const r = run({ ok: true, lines: ["ok"] }, { freelistCount: 10, pageCount: 1000, ratio: 0.01 });
      expect(r.status).toBe("pass");
      expect(r.message).toBe("state.db passed PRAGMA integrity_check.");
      expect(r.evidence?.freelistRatio).toBe(0.01);
    });

    test("fails and names the repair when integrity_check reports corruption", () => {
      const r = run(
        { ok: false, lines: ["rowid 42 out of order in table events", "wrong # of entries in index idx_events_ts"] },
        { freelistCount: 0, pageCount: 1000, ratio: 0 },
      );
      expect(r.status).toBe("fail");
      expect(r.message).toContain("rowid 42 out of order in table events");
      expect(r.message).toContain("wrong # of entries in index idx_events_ts");
      expect(r.message).toContain('sqlite3 -readonly state.db ".recover" | sqlite3 state.new.db');
      expect(r.message).toContain("delete state.db-wal and state.db-shm");
      expect(r.evidence?.lines).toEqual([
        "rowid 42 out of order in table events",
        "wrong # of entries in index idx_events_ts",
      ]);
    });

    test("fails with the probe's own error when integrity_check could not run at all", () => {
      const r = run(
        { ok: false, lines: [], error: "unable to open database file" },
        { freelistCount: 0, pageCount: 0, ratio: 0 },
      );
      expect(r.status).toBe("fail");
      expect(r.message).toContain("unable to open database file");
    });

    test("warns (not fails) when the freelist ratio exceeds 50%, even though integrity_check is ok", () => {
      const r = run({ ok: true, lines: ["ok"] }, { freelistCount: 700, pageCount: 1000, ratio: 0.7 });
      expect(r.status).toBe("warn");
      expect(r.message).toContain("70.0%");
      expect(r.message).toContain("reclaimable by VACUUM");
      expect(r.evidence?.freelistCount).toBe(700);
      expect(r.evidence?.pageCount).toBe(1000);
    });

    test("passes exactly at the 50% boundary (warn is strictly above threshold)", () => {
      const r = run({ ok: true, lines: ["ok"] }, { freelistCount: 500, pageCount: 1000, ratio: 0.5 });
      expect(r.status).toBe("pass");
    });

    // A3: getStateDbFreelistInfo can fail independently of integrity_check (e.g. the
    // read-only handle it opens itself hits an error the integrity_check probe did
    // not). That must render as a failed check, not a thrown exception.
    test("fails with the freelist probe's own error when integrity_check passed but the freelist read could not run", () => {
      const r = run(
        { ok: true, lines: ["ok"] },
        { freelistCount: 0, pageCount: 0, ratio: 0, error: "unable to open database file" },
      );
      expect(r.status).toBe("fail");
      expect(r.message).toContain("unable to open database file");
    });
  });
}

// `semantic-search` projects what the last `akm index` recorded (and the index's
// counts, read at health time) into one check. Driven here with synthetic state.

const BUILT_AT = "2026-10-26T12:00:00.000Z";

function indexed(record: SemanticSearchRecord, entryCount = 4, embeddingCount = 4): SemanticSearchState {
  return { mode: "auto", index: { record, builtAt: BUILT_AT, entryCount, embeddingCount } };
}

describe("semantic-search check", () => {
  test("is registered as a hard check", () => {
    expect(HEALTH_CHECKS.find((c) => c.name === "semantic-search")?.channel).toBe("hard");
  });

  test("passes when every entry has a vector on the native runtime", () => {
    const r = semanticSearchCheck(indexed({ status: "ready-js", provider: "local", runtime: "onnxruntime-node" }));
    expect(r).toMatchObject({ name: "semantic-search", kind: "deterministic", status: "pass" });
    expect(r.message).toBe("Semantic search ready (4/4 embeddings on onnxruntime-node).");
    expect(r.evidence).toMatchObject({ status: "ready-js", builtAt: BUILT_AT, entryCount: 4, embeddingCount: 4 });
  });

  test("passes for a remote provider, which records no local runtime", () => {
    const r = semanticSearchCheck(indexed({ status: "ready-js", provider: "remote" }));
    expect(r.status).toBe("pass");
    expect(r.message).toBe("Semantic search ready (4/4 embeddings).");
  });

  test("warns when embeddings lag the entries the index holds now", () => {
    const r = semanticSearchCheck(indexed({ status: "ready-js", provider: "local" }, 5, 3));
    expect(r.status).toBe("warn");
    expect(r.message).toContain("Embeddings lag entries (3/5)");
  });

  test("warns when local embeddings ran on a runtime other than the native one", () => {
    const r = semanticSearchCheck(indexed({ status: "ready-js", provider: "local", runtime: "onnxruntime-web" }));
    expect(r.status).toBe("warn");
    expect(r.message).toContain("onnxruntime-web, not the native onnxruntime-node");
  });

  test("fails when blocked, with the recorded reason", () => {
    const r = semanticSearchCheck(
      indexed({ status: "blocked", provider: "remote", reason: "All 3 embedding batch(es) failed: refused" }, 3, 0),
    );
    expect(r.status).toBe("fail");
    expect(r.message).toBe(
      `Semantic search was blocked at the last index (${BUILT_AT}): All 3 embedding batch(es) failed: refused`,
    );
  });

  test("fails when a native library this platform has did not load, with the recorded reason", () => {
    const r = semanticSearchCheck(
      indexed(
        {
          status: "unavailable",
          unavailable: "load",
          provider: "local",
          reason: "failed to map segment from shared object",
        },
        3,
        0,
      ),
    );
    expect(r.status).toBe("fail");
    expect(r.message).toContain("unavailable on this machine");
    expect(r.message).toContain("failed to map segment from shared object");
    expect(r.evidence).toMatchObject({ status: "unavailable", unavailable: "load" });
  });

  test("warns when this platform has no native library, with the reason and the two ways out", () => {
    const r = semanticSearchCheck(
      indexed(
        {
          status: "unavailable",
          unavailable: "platform",
          provider: "local",
          reason: "no native library is available.",
        },
        3,
        0,
      ),
    );
    expect(r.status).toBe("warn");
    expect(r.message).toBe(
      "Semantic search is unavailable on this platform: no native library is available. For keyword search run `akm setup --embedding off`; for a remote endpoint, `akm setup --embedding <model> --embedding-endpoint <url>`.",
    );
    expect(r.evidence).toMatchObject({ status: "unavailable", unavailable: "platform" });
  });

  test("passes when the config turns semantic search off, whatever the last index recorded", () => {
    const r = semanticSearchCheck({ ...indexed({ status: "blocked", provider: "local", reason: "x" }), mode: "off" });
    expect(r.status).toBe("pass");
    expect(r.evidence).toEqual({ mode: "off" });
  });

  test("is unknown with no index, no record, a run with semantic search off, or no entries", () => {
    expect(semanticSearchCheck({ mode: "auto" }).status).toBe("unknown");
    expect(semanticSearchCheck({ mode: "auto", index: { entryCount: 2, embeddingCount: 0 } }).message).toContain(
      "run `akm index`",
    );
    expect(semanticSearchCheck(indexed({ status: "disabled", provider: "local" })).status).toBe("unknown");
    expect(semanticSearchCheck(indexed({ status: "pending", provider: "local" }, 0, 0)).status).toBe("unknown");
    expect(semanticSearchCheck({ mode: "auto", error: "unreadable" }).message).toBe(
      "Could not read the index: unreadable",
    );
  });
});

/**
 * The `connections-and-harnesses` health check: one table of the connections and harnesses and
 * the work that runs on them, with reachability and versions from the probes
 * the caller supplies. Registered in place of the earlier per-connection checks.
 */

const cfg = (partial: Partial<AkmConfig> = {}): AkmConfig => ({ semanticSearchMode: "off", ...partial });
const MODELS = { fast: "small", balanced: "mid", reasoning: "big" };
const onPath =
  (...bins: string[]) =>
  (bin: string) =>
    bins.includes(bin) ? `/usr/bin/${bin}` : undefined;

/** A stand-in for `spawnSync`: the version a binary prints, or a failing exit. */
const versions = (byBin: Record<string, string>): typeof spawnSync =>
  ((bin: string) =>
    bin in byBin
      ? { status: 0, stdout: `${byBin[bin]}\nmore`, stderr: "" }
      : { status: 1, stdout: "", stderr: "" }) as unknown as typeof spawnSync;

const rowsOf = (result: HealthCheckResult) =>
  (result.evidence?.rows as Array<Record<string, unknown>>).map((row) => ({ ...row }));

describe("runConnectionsAndHarnessesCheck", () => {
  const config = cfg({
    connections: { default: { endpoint: "http://localhost:11434/v1", models: MODELS } },
    harnesses: { claude: {} },
  });

  test("passes, with one table, when every connection answers and every harness is installed", async () => {
    const probed: string[] = [];
    const probeReachable: ReachabilityProbe = async ({ endpoint }) => {
      probed.push(endpoint);
      return { reachable: true };
    };

    const result = await runConnectionsAndHarnessesCheck({
      loadConfig: () => config,
      probeReachable,
      which: onPath("claude"),
      spawnSync: versions({ claude: "2.1.0 (Claude Code)" }),
      env: {},
    });

    expect(result).toMatchObject({ name: "connections-and-harnesses", status: "pass", kind: "deterministic" });
    expect(result.message).toBe("1 connection and 1 harness, all ready.");
    const rows = rowsOf(result);
    expect(rows.map((row) => `${row.type}:${row.name ?? row.process}`)).toEqual([
      "connection:default",
      "harness:claude",
      "process:improve",
      "process:judges",
      "process:agents",
      "process:extract",
      "process:enrich",
      "process:embedding",
    ]);
    expect(rows[0]).toMatchObject({ reachable: true, key: "none", default: true });
    expect(rows[1]).toMatchObject({ installed: true, version: "2.1.0 (Claude Code)" });
    expect(probed).toEqual(["http://localhost:11434/v1"]);
  });

  test("an endpoint that does not answer is a warning naming the connection and why", async () => {
    const result = await runConnectionsAndHarnessesCheck({
      loadConfig: () => config,
      probeReachable: async () => ({ reachable: false, error: "connection refused" }),
      which: onPath("claude"),
      spawnSync: versions({}),
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain('connection "default" is not reachable (connection refused)');
  });

  test("a harness that is not installed is a warning", async () => {
    const result = await runConnectionsAndHarnessesCheck({
      loadConfig: () => config,
      which: onPath(),
      spawnSync: versions({}),
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain('harness "claude" (claude) was not found on PATH');
    expect(rowsOf(result)[1]).toMatchObject({ installed: false });
    expect(rowsOf(result)[1]).not.toHaveProperty("version");
  });

  test("a key variable that is not set is a warning that never names the variable", async () => {
    const result = await runConnectionsAndHarnessesCheck({
      loadConfig: () =>
        cfg({ connections: { lab: { endpoint: "http://lab/v1", apiKey: "$LAB_SECRET_VAR", models: MODELS } } }),
      env: {},
      which: onPath(),
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain('connection "lab": the variable holding its key is not set');
    expect(JSON.stringify(result)).not.toContain("LAB_SECRET_VAR");
  });

  test("a version that cannot be read is no reason to warn", async () => {
    const result = await runConnectionsAndHarnessesCheck({
      loadConfig: () => config,
      probeReachable: async () => ({ reachable: true }),
      which: onPath("claude"),
      spawnSync: versions({}),
    });
    expect(result.status).toBe("pass");
    expect(rowsOf(result)[1]).not.toHaveProperty("version");
  });

  test("without a probe nothing is contacted and no harness is run, and the message says so", async () => {
    const ran: string[] = [];
    const spawn = ((bin: string) => {
      ran.push(bin);
      return { status: 0, stdout: "9.9.9", stderr: "" };
    }) as unknown as typeof spawnSync;

    const result = await runConnectionsAndHarnessesCheck({
      loadConfig: () => config,
      which: onPath("claude"),
      spawnSync: spawn,
    });

    expect(ran).toEqual([]);
    expect(result.status).toBe("pass");
    expect(result.message).toBe("1 connection and 1 harness, all ready. Reachability was not probed.");
    expect(rowsOf(result)[0]).not.toHaveProperty("reachable");
    expect(rowsOf(result)[1]).not.toHaveProperty("version");
  });

  test("an endpoint two connections share is asked once", async () => {
    let asked = 0;
    await runConnectionsAndHarnessesCheck({
      loadConfig: () =>
        cfg({
          connections: {
            a: { endpoint: "http://shared/v1", models: MODELS },
            b: { endpoint: "http://shared/v1/", models: MODELS },
          },
        }),
      probeReachable: async () => {
        asked += 1;
        return { reachable: true };
      },
    });
    expect(asked).toBe(1);
  });

  test("nothing configured is unknown, and says how to get started", async () => {
    const result = await runConnectionsAndHarnessesCheck({ loadConfig: () => cfg() });
    expect(result.status).toBe("unknown");
    expect(result.message).toContain("akm setup");
    expect(rowsOf(result).every((row) => row.type === "process" && row.kind === null)).toBe(true);
  });

  test("a work row that cannot resolve because of the config is reported with its reason", async () => {
    const result = await runConnectionsAndHarnessesCheck({
      loadConfig: () => cfg({ connections: { default: { endpoint: "http://a/v1" } } }),
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain('Connection "default" lists no models');
  });

  describe("several connections and none called default", () => {
    const ambiguous = cfg({
      connections: {
        first: { endpoint: "http://a/v1", models: MODELS },
        second: { endpoint: "http://b/v1", models: MODELS },
      },
    });

    test("is a failing check, not 'all ready', and says to name one default", async () => {
      const result = await runConnectionsAndHarnessesCheck({ loadConfig: () => ambiguous, which: onPath() });
      expect(result.status).toBe("warn");
      expect(result.message).not.toContain("all ready");
      expect(result.message).toContain('none is named "default": name one default in config.json');
      // Said once for the work that has nowhere to run, not once per kind of work.
      expect(result.message.match(/name one default/g)).toHaveLength(1);
      const work = rowsOf(result).filter((row) => row.type === "process" && row.problem);
      expect(work.map((row) => row.process)).toEqual(["improve", "judges", "agents", "extract", "enrich"]);
    });

    test("naming one default makes the same installation ready", async () => {
      const named = cfg({
        connections: { default: ambiguous.connections?.first, second: ambiguous.connections?.second } as never,
      });
      const result = await runConnectionsAndHarnessesCheck({ loadConfig: () => named, which: onPath() });
      expect(result.status).toBe("pass");
    });

    test("is still reported with a harness, which gives the work a place to run but does not make the connections' default clear", async () => {
      const result = await runConnectionsAndHarnessesCheck({
        loadConfig: () => ({ ...ambiguous, harnesses: { claude: {} } }) as AkmConfig,
        which: onPath("claude"),
      });
      expect(result.status).toBe("warn");
      expect(result.message).toContain('none is named "default": name one default in config.json');
      expect(rowsOf(result).find((row) => row.process === "agents")?.problem).toBeUndefined();
    });
  });

  test("an empty installation is unknown and a disabled process is not a problem", async () => {
    const empty = await runConnectionsAndHarnessesCheck({ loadConfig: () => cfg() });
    expect(empty.status).toBe("unknown");
    const off = await runConnectionsAndHarnessesCheck({
      loadConfig: () =>
        cfg({
          connections: { default: { endpoint: "http://a/v1", models: MODELS } },
        }),
      which: onPath(),
    });
    expect(off.status).toBe("pass");
    expect(rowsOf(off).find((row) => row.process === "embedding")).toMatchObject({ kind: null });
  });
});

describe("the health-check registry", () => {
  test("`connections-and-harnesses` is one hard check in place of the earlier connection, model-alias and improve-strategy advisories", () => {
    const names = HEALTH_CHECKS.map((check) => check.name);
    expect(names).toContain("connections-and-harnesses");
    expect(HEALTH_CHECKS.find((check) => check.name === "connections-and-harnesses")?.channel).toBe("hard");
    for (const gone of [
      "default-engine",
      "default-llm-engine",
      "configured-engines",
      "selected-model-aliases",
      "model-map-files",
      "active-improve-strategy",
      "thinking-control",
      "engine-last-used",
    ]) {
      expect(names).not.toContain(gone);
    }
  });

  test("is a pure projection of ctx.connectionsAndHarnesses", () => {
    const table: HealthCheckResult = {
      name: "connections-and-harnesses",
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message: "ok",
    };
    const check = HEALTH_CHECKS.find((c) => c.name === "connections-and-harnesses");
    expect(check?.run({ connectionsAndHarnesses: table } as unknown as HealthCheckContext)).toBe(table);
  });
});
