import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmHealth } from "../src/commands/health";
import type { HealthCheckResult } from "../src/commands/health/types";
import { appendEvent } from "../src/core/events";
import { openStateDatabase } from "../src/core/state-db";
import type { SessionLogEntry } from "../src/integrations/session-logs";
import { upsertTaskHistory } from "../src/storage/repositories/task-history-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

// Characterization net for WS9 (#490): pins the FULL ordered hardChecks +
// advisories structure of `akmHealth` — names, order, kind, status,
// confidence, and message — so the registry refactor can be proven
// byte-identical. Volatile substrings (timings, absolute paths) are not part
// of the assertion; the check identity/order/status/message contract is.
//
// This snapshot is intentionally exhaustive about ORDER because the registry
// design must preserve emission order exactly.

let storage: IsolatedAkmStorage;
const extraTempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  extraTempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
  for (const dir of extraTempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Project a check to the stable identity fields (drop evidence which carries
// timings/paths; messages with embedded counts are stable for the seeded data).
function project(check: HealthCheckResult) {
  return {
    name: check.name,
    kind: check.kind,
    status: check.status,
    confidence: check.confidence,
    message: check.message,
  };
}

function findCheck(checks: HealthCheckResult[], name: string): HealthCheckResult {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`expected a check named ${name}`);
  return found;
}

describe("health checks characterization (WS9)", () => {
  test("empty stash: full ordered check structure is stable", () => {
    // Inject an empty session-log source so the empty-stash baseline is not
    // polluted by host session logs.
    const result = akmHealth({ since: "7d", getExecutionLogCandidatesFn: () => [] });

    expect(result.hardChecks.map(project)).toEqual([
      {
        name: "state-db-schema",
        kind: "deterministic",
        status: "pass",
        confidence: "high",
        message: "state.db opened and required tables are present.",
      },
      {
        name: "state-db-round-trip",
        kind: "deterministic",
        status: "pass",
        confidence: "high",
        message: "state.db append/read round-trip succeeded.",
      },
      {
        name: "task-history-read",
        kind: "deterministic",
        status: "pass",
        confidence: "high",
        message: findCheck(result.hardChecks, "task-history-read").message,
      },
      {
        name: "task-log-backing",
        kind: "deterministic",
        status: "pass",
        confidence: "high",
        message: "Every task_history log_path resolved on disk.",
      },
      {
        name: "active-runs",
        kind: "deterministic",
        status: "pass",
        confidence: "high",
        message: "No active task runs exceeded the stale threshold.",
      },
      {
        name: "agent-profile",
        kind: "deterministic",
        status: "unknown",
        confidence: "high",
        message: "No agent config present.",
      },
    ]);

    expect(result.advisories.map(project)).toEqual([
      {
        name: "collapse-churn-detector",
        kind: "deterministic",
        status: "unknown",
        confidence: "high",
        message:
          "No detector cycle rows yet — the collapse/churn detector runs only on improve cycles where consolidate/recombine did work (synthesis lanes may be idle).",
      },
      {
        name: "semantic-search-runtime",
        kind: "deterministic",
        status: "pass",
        confidence: "medium",
        message: "No semantic-search runtime status recorded yet.",
      },
      {
        name: "session-log-failures",
        kind: "heuristic",
        status: "pass",
        confidence: "low",
        message: "No repeated external session-log failure patterns were detected.",
      },
      {
        name: "session-extraction",
        kind: "heuristic",
        status: "pass",
        confidence: "low",
        message: "Session extraction not active (feature disabled or no harness available).",
      },
      {
        name: "pool-saturation",
        kind: "heuristic",
        status: "pass",
        confidence: "low",
        message: "Pool saturation: no extract activity in the window — no signal.",
      },
      {
        name: "auto-accept-validation",
        kind: "heuristic",
        status: "pass",
        confidence: "low",
        message: "Auto-accept gate did not run (disabled or no proposals above threshold).",
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("pass");
    expect(result.schemaVersion).toBe(2);
  });

  test("seeded failure stash: ordered structure with a hard fail + advisory warn", () => {
    const logDir = makeTempDir("akm-healthchar-logs-");
    const db = openStateDatabase();
    try {
      // One completed prompt task with a resolvable log, one failed prompt task
      // with a MISSING log -> task-log-backing fails, agentFailureRate > 0.
      upsertTaskHistory(db, {
        task_id: "ok-task",
        status: "completed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        failed_at: null,
        log_path: (() => {
          const p = path.join(logDir, "ok.log");
          fs.writeFileSync(p, "ok");
          return p;
        })(),
        target_kind: "prompt",
        target_ref: null,
        metadata_json: JSON.stringify({ durationMs: 10, detail: { exitCode: 0 }, profile: "opencode" }),
      });
      upsertTaskHistory(db, {
        task_id: "failed-task",
        status: "failed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        failed_at: new Date().toISOString(),
        log_path: path.join(logDir, "missing.log"),
        target_kind: "prompt",
        target_ref: null,
        metadata_json: JSON.stringify({
          durationMs: 20,
          detail: { exitCode: 2, reason: "non_zero_exit", error: "boom" },
          profile: "opencode",
        }),
      });
    } finally {
      db.close();
    }

    appendEvent({ eventType: "improve_invoked", ref: "improve:all:all", metadata: { dryRun: false } });

    const sessionLogs: SessionLogEntry[] = [
      { topic: "boom failed", frequency: 3, source: "claude-code", isFailurePattern: true },
    ];
    const result = akmHealth({ since: "7d", getExecutionLogCandidatesFn: () => sessionLogs });

    // Order + identity of hard checks is unchanged even with a fail present.
    expect(result.hardChecks.map((c) => c.name)).toEqual([
      "state-db-schema",
      "state-db-round-trip",
      "task-history-read",
      "task-log-backing",
      "active-runs",
      "agent-profile",
    ]);
    expect(result.advisories.map((c) => c.name)).toEqual([
      "collapse-churn-detector",
      "semantic-search-runtime",
      "session-log-failures",
      "session-extraction",
      "pool-saturation",
      "auto-accept-validation",
    ]);

    const logBacking = findCheck(result.hardChecks, "task-log-backing");
    expect(logBacking.status).toBe("fail");
    expect(logBacking.message).toBe("1 task log(s) referenced in task_history are missing.");

    // session-log-failures is informational: even with a failure pattern it
    // never warns and reports the raw match count.
    const slf = findCheck(result.advisories, "session-log-failures");
    expect(slf.status).toBe("pass");
    expect(slf.message).toBe("1 raw session-log keyword match(es) detected (pre-LLM, informational only).");

    expect(result.ok).toBe(false);
    expect(result.status).toBe("fail");
  });
});

describe("semantic-search-runtime embedding-endpoint advisory", () => {
  test("blocked remote endpoint while semanticSearchMode=auto names the endpoint and the fixes", async () => {
    const { resetConfigCache, saveConfig } = await import("../src/core/config/config");
    const { deriveSemanticProviderFingerprint, writeSemanticStatus } = await import(
      "../src/indexer/search/semantic-status"
    );
    resetConfigCache();
    const embedding = { endpoint: "http://localhost:1234/v1/embeddings", model: "test-embed" };
    saveConfig({ semanticSearchMode: "auto", embedding });
    writeSemanticStatus({
      status: "blocked",
      reason: "remote-network",
      message: "Unable to connect",
      providerFingerprint: deriveSemanticProviderFingerprint(embedding),
      lastCheckedAt: new Date().toISOString(),
    });

    const result = akmHealth({ since: "7d", getExecutionLogCandidatesFn: () => [] });
    const advisory = findCheck(result.advisories, "semantic-search-runtime");
    expect(advisory.status).toBe("warn");
    expect(advisory.message).toContain("http://localhost:1234/v1/embeddings");
    expect(advisory.message).toContain("remote-network");
    expect(advisory.message).toContain('semanticSearchMode is "auto"');
    expect(advisory.message).toContain("keyword-only");
  });

  test("non-remote blocked reason keeps the generic message", async () => {
    const { resetConfigCache, saveConfig } = await import("../src/core/config/config");
    const { deriveSemanticProviderFingerprint, writeSemanticStatus } = await import(
      "../src/indexer/search/semantic-status"
    );
    resetConfigCache();
    saveConfig({ semanticSearchMode: "auto" });
    writeSemanticStatus({
      status: "blocked",
      reason: "missing-package",
      providerFingerprint: deriveSemanticProviderFingerprint(undefined),
      lastCheckedAt: new Date().toISOString(),
    });

    const result = akmHealth({ since: "7d", getExecutionLogCandidatesFn: () => [] });
    const advisory = findCheck(result.advisories, "semantic-search-runtime");
    expect(advisory.status).toBe("warn");
    expect(advisory.message).toBe("Semantic search status: blocked");
  });
});
