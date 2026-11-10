// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #914: `session-extraction` derives its verdict from the `extract_sessions_seen`
 * ledger — the table standalone `akm proposal extract` (including the
 * hook-driven `akm proposal extract --session-id ...` the Claude Code
 * plugin's SessionEnd hook actually issues) writes via
 * `upsertExtractedSession` — instead of `improve_runs.result_json`, which
 * that invocation never populates. Before this fix a hook-driven machine
 * reported "Session extraction not active" as `pass`, forever, no matter how
 * healthy or broken extraction actually was.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmHealth } from "../../../src/commands/health";
import type { HealthCheckResult } from "../../../src/commands/health/types";
import { daysToMs } from "../../../src/core/common";
import { openStateDatabase } from "../../../src/core/state-db";
import { upsertExtractedSession } from "../../../src/storage/repositories/extract-sessions-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

function findAdvisory(checks: HealthCheckResult[], name: string): HealthCheckResult {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`expected an advisory named ${name}`);
  return found;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - daysToMs(days)).toISOString();
}

describe("session-extraction is derived from the extract_sessions_seen ledger (#914)", () => {
  test("no rows in the last 7 days reports unknown, not pass", async () => {
    const result = await akmHealth({ since: "7d" });
    const advisory = findAdvisory(result.advisories, "session-extraction");
    expect(advisory.status).toBe("unknown");
    expect(advisory.kind).toBe("heuristic");
    expect(advisory.confidence).toBe("medium");
    expect(advisory.message).toBe("No extraction recorded in the last 7 days.");
  });

  test("a row older than 7 days does not count toward the window", async () => {
    const db = openStateDatabase();
    try {
      upsertExtractedSession(db, {
        harness: "claude-code",
        sessionId: "old-session",
        processedAt: isoDaysAgo(10),
        outcome: "no_candidates",
        candidateCount: 0,
        proposalCount: 0,
        contentHash: "hash-old",
      });
    } finally {
      db.close();
    }

    const result = await akmHealth({ since: "7d" });
    const advisory = findAdvisory(result.advisories, "session-extraction");
    expect(advisory.status).toBe("unknown");
  });

  test("every session skipped with an infrastructure reason warns, naming the reason and engine", async () => {
    const db = openStateDatabase();
    try {
      for (let i = 0; i < 25; i++) {
        upsertExtractedSession(db, {
          harness: "claude-code",
          sessionId: `session-${i}`,
          processedAt: isoDaysAgo(1),
          outcome: "skipped",
          candidateCount: 0,
          proposalCount: 0,
          contentHash: null,
          metadata: { skipReason: "llm_unavailable", engine: "default" },
        });
      }
    } finally {
      db.close();
    }

    const result = await akmHealth({ since: "7d" });
    const advisory = findAdvisory(result.advisories, "session-extraction");
    expect(advisory.status).toBe("warn");
    expect(advisory.message).toBe('25 of 25 sessions in the last 7 days skipped: llm_unavailable (engine "default").');
  });

  test("every session recorded as failed for an infrastructure reason warns too", async () => {
    // `read_failed` / `exception` land in the ledger as outcome `failed`, not
    // `skipped` (extract.ts `recordExtractSessionOutcome`); the verdict must
    // not depend on which of the two words the writer chose.
    const db = openStateDatabase();
    try {
      for (let i = 0; i < 3; i += 1) {
        upsertExtractedSession(db, {
          harness: "claude-code",
          sessionId: `failed-session-${i}`,
          processedAt: isoDaysAgo(1),
          outcome: "failed",
          candidateCount: 0,
          proposalCount: 0,
          contentHash: null,
          metadata: { skipReason: "exception", engine: "lab" },
        });
      }
    } finally {
      db.close();
    }

    const result = await akmHealth({ since: "7d" });
    const advisory = findAdvisory(result.advisories, "session-extraction");
    expect(advisory.status).toBe("warn");
    expect(advisory.message).toBe('3 of 3 sessions in the last 7 days skipped or failed: exception (engine "lab").');
    // A heuristic warning is still a warning: the overall verdict (and exit code 4) says so too (F4).
    expect(result.status).toBe("warn");
    expect(result.ok).toBe(true);
  });

  test("a legacy skipped row with no metadata still warns as an unknown reason, not pass", async () => {
    const db = openStateDatabase();
    try {
      // No `metadata` — mirrors a row a pre-#912/#913 release wrote, which
      // carries neither `skipReason` nor `engine` at all.
      upsertExtractedSession(db, {
        harness: "claude-code",
        sessionId: "legacy-session",
        processedAt: isoDaysAgo(1),
        outcome: "skipped",
        candidateCount: 0,
        proposalCount: 0,
        contentHash: null,
      });
    } finally {
      db.close();
    }

    const result = await akmHealth({ since: "7d" });
    const advisory = findAdvisory(result.advisories, "session-extraction");
    expect(advisory.status).toBe("warn");
    expect(advisory.message).toContain("unknown reason");
  });

  test("a non-infrastructure skip reason (too_short) reports pass, not warn", async () => {
    const db = openStateDatabase();
    try {
      upsertExtractedSession(db, {
        harness: "claude-code",
        sessionId: "too-short-session",
        processedAt: isoDaysAgo(1),
        outcome: "skipped",
        candidateCount: 0,
        proposalCount: 0,
        contentHash: null,
        metadata: { skipReason: "too_short" },
      });
    } finally {
      db.close();
    }

    const result = await akmHealth({ since: "7d" });
    const advisory = findAdvisory(result.advisories, "session-extraction");
    expect(advisory.status).toBe("pass");
    expect(advisory.message).toContain("skipped: 1");
  });

  test("a mix of outcomes (not every session skipped) reports pass with per-outcome counts", async () => {
    const db = openStateDatabase();
    try {
      upsertExtractedSession(db, {
        harness: "claude-code",
        sessionId: "candidates-session",
        processedAt: isoDaysAgo(1),
        outcome: "candidates_queued",
        candidateCount: 3,
        proposalCount: 1,
        contentHash: "hash-1",
      });
      upsertExtractedSession(db, {
        harness: "claude-code",
        sessionId: "skipped-session",
        processedAt: isoDaysAgo(1),
        outcome: "skipped",
        candidateCount: 0,
        proposalCount: 0,
        contentHash: null,
        metadata: { skipReason: "llm_unavailable", engine: "default" },
      });
    } finally {
      db.close();
    }

    const result = await akmHealth({ since: "7d" });
    const advisory = findAdvisory(result.advisories, "session-extraction");
    expect(advisory.status).toBe("pass");
    expect(advisory.message).toContain("candidates_queued: 1");
    expect(advisory.message).toContain("skipped: 1");
    expect(advisory.evidence?.ledgerRows).toBeDefined();
  });
});
