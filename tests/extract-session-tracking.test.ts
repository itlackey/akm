// Tests for the extract_sessions_seen tracking added in state-db migration 004
// plus the akmExtract skip-already-extracted behavior.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmExtract } from "../src/commands/improve/extract";
import type { AkmConfig } from "../src/core/config/config";
import {
  getExtractedSession,
  getExtractedSessionsMap,
  openStateDatabase,
  shouldSkipAlreadyExtractedSession,
  upsertExtractedSession,
} from "../src/core/state-db";
import type {
  SessionData,
  SessionLogHarness,
  SessionRef,
  SessionSummary,
} from "../src/integrations/session-logs/types";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

const tempDirs: string[] = [];
let storage: IsolatedAkmStorage;
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function makeStashDir(): string {
  const stash = makeTempDir("akm-extract-track-stash-");
  for (const dir of ["memories", "lessons", "knowledge"]) fs.mkdirSync(path.join(stash, dir), { recursive: true });
  return stash;
}
beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => {
  storage.cleanup();
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function configEnabled(stashDir: string): AkmConfig {
  return {
    semanticSearchMode: "auto",
    stashDir,
    sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
    defaultWriteTarget: "stash",
    profiles: {
      llm: {
        default: { endpoint: "http://localhost:11434/v1/chat/completions", model: "test", supportsJsonSchema: true },
      },
      // #561 — disable session indexing so chat-call assertions count only the
      // distillation call (session indexing has dedicated coverage elsewhere).
      improve: { default: { processes: { extract: { enabled: true, indexSessions: false } } } },
    },
    defaults: { llm: "default" },
  } as AkmConfig;
}

function fakeSession(id: string, endedAt: number): SessionData {
  return {
    ref: {
      harness: "claude-code",
      sessionId: id,
      filePath: `/tmp/fake/${id}.jsonl`,
      startedAt: endedAt - 3600_000,
      endedAt,
      title: `Session ${id}`,
    },
    events: [
      {
        harness: "claude-code",
        text: "user: explain how the auth pipeline currently issues JWTs",
        ts: endedAt - 1000_000,
        sessionId: id,
        role: "user",
        filePath: `/tmp/fake/${id}.jsonl`,
      },
    ],
    inlineRefs: [],
  };
}

function makeHarness(sessions: SessionData[]): SessionLogHarness {
  const summaries: SessionSummary[] = sessions.map((s) => s.ref);
  return {
    name: "claude-code",
    isAvailable: () => true,
    *readEvents() {},
    listSessions: (input?: { sinceMs?: number }) => summaries.filter((s) => (s.endedAt ?? 0) >= (input?.sinceMs ?? 0)),
    readSession: (ref: SessionRef): SessionData => {
      const found = sessions.find((s) => s.ref.sessionId === ref.sessionId);
      if (!found) throw new Error(`session not found: ${ref.sessionId}`);
      return found;
    },
  };
}

// ── shouldSkipAlreadyExtractedSession — pure helper ─────────────────────────

describe("shouldSkipAlreadyExtractedSession", () => {
  test("returns false when there is no prior record", () => {
    expect(shouldSkipAlreadyExtractedSession(undefined, Date.now())).toBe(false);
  });

  test("returns true when prior endedAt equals live endedAt (unchanged session)", () => {
    const ts = Date.now();
    const prior = {
      harness: "x",
      session_id: "y",
      processed_at: new Date().toISOString(),
      session_ended_at: new Date(ts).toISOString(),
      outcome: "no_candidates" as const,
      candidate_count: 0,
      proposal_count: 0,
      rationale: null,
      source_run: null,
      metadata_json: "{}",
    };
    expect(shouldSkipAlreadyExtractedSession(prior, ts)).toBe(true);
  });

  test("returns false when live endedAt is strictly later than prior (new events arrived)", () => {
    const ts = Date.now();
    const prior = {
      harness: "x",
      session_id: "y",
      processed_at: new Date().toISOString(),
      session_ended_at: new Date(ts).toISOString(),
      outcome: "no_candidates" as const,
      candidate_count: 0,
      proposal_count: 0,
      rationale: null,
      source_run: null,
      metadata_json: "{}",
    };
    expect(shouldSkipAlreadyExtractedSession(prior, ts + 60_000)).toBe(false);
  });

  test("returns true when live endedAt is missing (can't tell — be conservative)", () => {
    const prior = {
      harness: "x",
      session_id: "y",
      processed_at: new Date().toISOString(),
      session_ended_at: new Date().toISOString(),
      outcome: "skipped" as const,
      candidate_count: 0,
      proposal_count: 0,
      rationale: null,
      source_run: null,
      metadata_json: "{}",
    };
    expect(shouldSkipAlreadyExtractedSession(prior, undefined)).toBe(true);
  });

  test("returns false when prior session_ended_at is null (legacy row — re-process)", () => {
    const prior = {
      harness: "x",
      session_id: "y",
      processed_at: new Date().toISOString(),
      session_ended_at: null,
      outcome: "no_candidates" as const,
      candidate_count: 0,
      proposal_count: 0,
      rationale: null,
      source_run: null,
      metadata_json: "{}",
    };
    expect(shouldSkipAlreadyExtractedSession(prior, Date.now())).toBe(false);
  });
});

// ── state.db round-trip ─────────────────────────────────────────────────────

describe("extract_sessions_seen — state.db round-trip", () => {
  function openInMem() {
    return openStateDatabase(":memory:");
  }

  test("upsertExtractedSession + getExtractedSession round-trip", () => {
    const db = openInMem();
    const endedAt = Date.now();
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_a",
      processedAt: "2026-05-26T10:00:00.000Z",
      sessionEndedAt: endedAt,
      outcome: "candidates_queued",
      candidateCount: 2,
      proposalCount: 2,
      sourceRun: "run-1",
      metadata: { foo: "bar" },
    });

    const row = getExtractedSession(db, "claude-code", "ses_a");
    expect(row).toBeDefined();
    expect(row?.session_id).toBe("ses_a");
    expect(row?.outcome).toBe("candidates_queued");
    expect(row?.candidate_count).toBe(2);
    expect(row?.session_ended_at).toBe(new Date(endedAt).toISOString());
    expect(row?.source_run).toBe("run-1");
    expect(JSON.parse(row?.metadata_json ?? "{}")).toEqual({ foo: "bar" });
    db.close();
  });

  test("upsert is INSERT-OR-REPLACE (latest row wins)", () => {
    const db = openInMem();
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_b",
      processedAt: "2026-05-25T00:00:00.000Z",
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
    });
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_b",
      processedAt: "2026-05-26T00:00:00.000Z",
      outcome: "candidates_queued",
      candidateCount: 3,
      proposalCount: 3,
    });
    const row = getExtractedSession(db, "claude-code", "ses_b");
    expect(row?.outcome).toBe("candidates_queued");
    expect(row?.processed_at).toBe("2026-05-26T00:00:00.000Z");
    expect(row?.candidate_count).toBe(3);
    db.close();
  });

  test("getExtractedSessionsMap returns a Map keyed by sessionId, filtered to the harness", () => {
    const db = openInMem();
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_a",
      processedAt: "x",
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
    });
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_b",
      processedAt: "x",
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
    });
    upsertExtractedSession(db, {
      harness: "opencode",
      sessionId: "ses_a",
      processedAt: "x",
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
    });

    const claudeMap = getExtractedSessionsMap(db, "claude-code", ["ses_a", "ses_b", "ses_missing"]);
    expect(claudeMap.size).toBe(2);
    expect(claudeMap.get("ses_a")?.harness).toBe("claude-code");
    expect(claudeMap.get("ses_b")?.harness).toBe("claude-code");
    expect(claudeMap.has("ses_missing")).toBe(false);

    const opencodeMap = getExtractedSessionsMap(db, "opencode", ["ses_a", "ses_b"]);
    expect(opencodeMap.size).toBe(1);
    expect(opencodeMap.has("ses_a")).toBe(true);
    expect(opencodeMap.has("ses_b")).toBe(false);

    db.close();
  });

  test("getExtractedSessionsMap returns empty map when sessionIds is empty", () => {
    const db = openInMem();
    expect(getExtractedSessionsMap(db, "claude-code", []).size).toBe(0);
    db.close();
  });
});

// ── akmExtract — skip-already-extracted integration ─────────────────────────

describe("akmExtract — skip-already-extracted", () => {
  test("skips a session that was already processed and has the same endedAt", async () => {
    const stash = makeStashDir();
    const endedAt = Date.now();
    const session = fakeSession("ses_seen", endedAt);
    const db = openStateDatabase(":memory:");
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_seen",
      processedAt: new Date(endedAt - 1_000).toISOString(),
      sessionEndedAt: endedAt,
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
    });

    let chatCalls = 0;
    const result = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeHarness([session])],
      stateDb: db,
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
    });

    expect(chatCalls).toBe(0);
    expect(result.sessionsSkipped).toBe(1);
    expect(result.sessionsProcessed).toBe(0);
    expect(result.sessions[0]?.skipReason).toBe("already_extracted");
    db.close();
  });

  test("re-processes a session when its endedAt is later than the recorded value", async () => {
    const stash = makeStashDir();
    const oldEndedAt = Date.now() - 5 * 60_000;
    const newEndedAt = Date.now();
    const session = fakeSession("ses_updated", newEndedAt);
    const db = openStateDatabase(":memory:");
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_updated",
      processedAt: new Date(oldEndedAt).toISOString(),
      sessionEndedAt: oldEndedAt,
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
    });

    let chatCalls = 0;
    const result = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeHarness([session])],
      stateDb: db,
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
    });

    expect(chatCalls).toBe(1);
    expect(result.sessionsProcessed).toBe(1);
    db.close();
  });

  test("explicit sessionId bypasses the skip-tracking check (always processes)", async () => {
    const stash = makeStashDir();
    const endedAt = Date.now();
    const session = fakeSession("ses_force", endedAt);
    const db = openStateDatabase(":memory:");
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_force",
      processedAt: new Date(endedAt - 1_000).toISOString(),
      sessionEndedAt: endedAt,
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
    });

    let chatCalls = 0;
    const result = await akmExtract({
      type: "claude-code",
      sessionId: "ses_force",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeHarness([session])],
      stateDb: db,
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
    });

    expect(chatCalls).toBe(1);
    expect(result.sessionsProcessed).toBe(1);
    db.close();
  });

  test("--force bypasses the skip-tracking check", async () => {
    const stash = makeStashDir();
    const endedAt = Date.now();
    const session = fakeSession("ses_forced", endedAt);
    const db = openStateDatabase(":memory:");
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_forced",
      processedAt: new Date(endedAt - 1_000).toISOString(),
      sessionEndedAt: endedAt,
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
    });

    let chatCalls = 0;
    const result = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeHarness([session])],
      stateDb: db,
      force: true,
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
    });

    expect(chatCalls).toBe(1);
    expect(result.sessionsProcessed).toBe(1);
    db.close();
  });

  test("processing a session records its outcome in state.db", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_record", Date.now());
    const db = openStateDatabase(":memory:");

    await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeHarness([session])],
      stateDb: db,
      chat: async () => JSON.stringify({ candidates: [], rationale_if_empty: "nothing durable in session" }),
    });

    const row = getExtractedSession(db, "claude-code", "ses_record");
    expect(row).toBeDefined();
    expect(row?.outcome).toBe("no_candidates");
    expect(row?.candidate_count).toBe(0);
    expect(row?.rationale).toBe("nothing durable in session");
    db.close();
  });

  test("dry-run does NOT write to state.db (so seen-table stays clean)", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_dry", Date.now());
    const db = openStateDatabase(":memory:");

    await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeHarness([session])],
      stateDb: db,
      dryRun: true,
      chat: async () => JSON.stringify({ candidates: [] }),
    });

    expect(getExtractedSession(db, "claude-code", "ses_dry")).toBeUndefined();
    db.close();
  });

  test("skipTracking opts out of state.db entirely", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_notrack", Date.now());
    const db = openStateDatabase(":memory:");

    await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeHarness([session])],
      stateDb: db,
      skipTracking: true,
      chat: async () => JSON.stringify({ candidates: [] }),
    });

    expect(getExtractedSession(db, "claude-code", "ses_notrack")).toBeUndefined();
    db.close();
  });
});
