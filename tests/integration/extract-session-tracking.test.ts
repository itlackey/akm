// Tests for the extract_sessions_seen tracking (state-db migration 004) and the
// #602 content-hash-based incrementality that REPLACES the old timestamp logic.
//
// #602: skip authority moved from `session_ended_at` (clock/timestamp-based,
// brittle — caused the Jun 11-12 double-extract + over-throttle incident) to a
// sha256 hash of the normalized session content. A session is skipped iff its
// content is byte-identical to the last processed run; any content change (or a
// hash-less legacy row) forces a re-process.
//
// Tests for the #602 content-hash session-skip API:
//   - shouldSkipAlreadyExtractedSession(prior, currentContentHash: string)
//   - ExtractedSessionRow.content_hash
//   - upsertExtractedSession({ ..., contentHash })
//   - hashSessionContent(data) exported from extract.ts
//   - migration 013-extract-sessions-content-hash (content_hash column)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as extractModule from "../../src/commands/improve/extract";
import { akmExtract } from "../../src/commands/improve/extract";
import type { AkmConfig } from "../../src/core/config/config";
import { tryAcquireLockSync } from "../../src/core/file-lock";
import { openStateDatabase } from "../../src/core/state-db";
import type {
  SessionData,
  SessionLogHarness,
  SessionRef,
  SessionSummary,
} from "../../src/integrations/session-logs/types";
import {
  type ExtractedSessionRow,
  getExtractedSession,
  getExtractedSessionsMap,
  getLastExtractRunAt,
  shouldSkipAlreadyExtractedSession,
  upsertExtractedSession,
} from "../../src/storage/repositories/extract-sessions-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

// hashSessionContent (#602) is reached via the namespace import for ESM-safety;
// it resolves to the real export from extract.ts.
const hashSessionContent = (data: SessionData): string =>
  (extractModule as { hashSessionContent: (d: SessionData) => string }).hashSessionContent(data);

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
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    stashDir,
    sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
    defaultWriteTarget: "stash",
    engines: {
      default: {
        kind: "llm",
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "test",
        supportsJsonSchema: true,
      },
    },
    improve: {
      strategies: {
        // #561 — disable session indexing so chat-call assertions count only the
        // distillation call (session indexing has dedicated coverage elsewhere).
        tracking: {
          processes: { extract: { enabled: true, indexSessions: false, triage: { enabled: false } } },
        },
      },
    },
    defaults: { llmEngine: "default", improveStrategy: "tracking" },
  } as AkmConfig;
}

// Build a session whose content (events) is parameterizable so we can prove the
// hash tracks event content, not ref metadata (title/endedAt/inlineRefs).
function fakeSession(id: string, endedAt: number, opts: { text?: string; title?: string } = {}): SessionData {
  return {
    ref: {
      harness: "claude-code",
      sessionId: id,
      filePath: `/tmp/fake/${id}.jsonl`,
      startedAt: endedAt - 3600_000,
      endedAt,
      title: opts.title ?? `Session ${id}`,
    },
    events: [
      {
        harness: "claude-code",
        text: opts.text ?? "user: explain how the auth pipeline currently issues JWTs",
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

// Helper to build a prior row with a given content_hash and (optional) ended-at.
function priorRow(overrides: Partial<ExtractedSessionRow> = {}): ExtractedSessionRow {
  return {
    harness: "x",
    session_id: "y",
    processed_at: "2026-06-01T00:00:00.000Z",
    session_ended_at: "2026-06-01T00:00:00.000Z",
    outcome: "no_candidates",
    candidate_count: 0,
    proposal_count: 0,
    rationale: null,
    source_run: null,
    metadata_json: "{}",
    content_hash: null,
    ...overrides,
  };
}

// ── shouldSkipAlreadyExtractedSession — hash-based pure helper (#602) ────────

describe("shouldSkipAlreadyExtractedSession (content-hash)", () => {
  // AC3 — never-seen session is always processed.
  test("returns false when there is no prior record (AC3)", () => {
    expect(shouldSkipAlreadyExtractedSession(undefined, "anyhash")).toBe(false);
  });

  // AC1 — byte-identical content is skipped.
  test("returns true when prior content_hash equals current hash (AC1)", () => {
    const prior = priorRow({ content_hash: "H" });
    expect(shouldSkipAlreadyExtractedSession(prior, "H")).toBe(true);
  });

  // AC1 (clock-independence) — the skip decision must NOT depend on
  // session_ended_at. Same hash → skip regardless of recorded ended-at.
  test("skip decision is independent of session_ended_at (AC1 clock-skew immunity)", () => {
    const farFuture = priorRow({ content_hash: "H", session_ended_at: "2999-01-01T00:00:00.000Z" });
    const farPast = priorRow({ content_hash: "H", session_ended_at: "1971-01-01T00:00:00.000Z" });
    const nullEnded = priorRow({ content_hash: "H", session_ended_at: null });
    expect(shouldSkipAlreadyExtractedSession(farFuture, "H")).toBe(true);
    expect(shouldSkipAlreadyExtractedSession(farPast, "H")).toBe(true);
    expect(shouldSkipAlreadyExtractedSession(nullEnded, "H")).toBe(true);
  });

  // AC2 — changed content forces a re-process.
  test("returns false when prior content_hash differs from current hash (AC2)", () => {
    const prior = priorRow({ content_hash: "H1" });
    expect(shouldSkipAlreadyExtractedSession(prior, "H2")).toBe(false);
  });

  // AC4 — a legacy/hash-less row is re-processed exactly once to backfill.
  test("returns false when prior content_hash is null (AC4 backfill once)", () => {
    const prior = priorRow({ content_hash: null });
    expect(shouldSkipAlreadyExtractedSession(prior, "H")).toBe(false);
  });
});

// ── hashSessionContent — canonicalization (#602) ────────────────────────────

describe("hashSessionContent", () => {
  test("is deterministic — same SessionData hashes the same across calls", () => {
    const s = fakeSession("ses_det", Date.now());
    expect(hashSessionContent(s)).toBe(hashSessionContent(s));
  });

  test("returns a 64-char hex sha256 digest", () => {
    const s = fakeSession("ses_hex", Date.now());
    expect(hashSessionContent(s)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("ignores ref.title / ref.endedAt / inlineRefs (clock & title churn must not change the hash)", () => {
    const base = fakeSession("ses_meta", 1_000_000, { title: "Original title" });
    const reTitled = fakeSession("ses_meta", 9_000_000, { title: "Totally different title" });
    // Same event text, divergent ref metadata.
    reTitled.inlineRefs = [{ kind: "remember", ref: "memory:foo", text: "added mid-session", ts: 5_000_000 }];
    expect(hashSessionContent(reTitled)).toBe(hashSessionContent(base));
  });

  test("changes when an event's text changes (AC2 source)", () => {
    const a = fakeSession("ses_text", 1_000_000, { text: "user: first version of the question" });
    const b = fakeSession("ses_text", 1_000_000, { text: "user: a DIFFERENT question entirely" });
    expect(hashSessionContent(a)).not.toBe(hashSessionContent(b));
  });

  test("hashes the RAW event stream (config maxTotalChars / truncation must not change it)", () => {
    // Two identical sessions; the hash must be stable irrespective of any
    // downstream pre-filter/truncation config (hash is computed on data.events).
    const a = fakeSession("ses_raw", 1_000_000, { text: "x".repeat(100_000) });
    const b = fakeSession("ses_raw", 1_000_000, { text: "x".repeat(100_000) });
    expect(hashSessionContent(a)).toBe(hashSessionContent(b));
  });

  test("event boundaries cannot be forged by newlines in text (NUL-delimited, role-tagged)", () => {
    // Single event containing what looks like a second event vs. two real events
    // must NOT collide.
    const single = fakeSession("ses_forge_a", 1_000_000);
    single.events = [
      { harness: "claude-code", text: "first\nassistant\nsecond", role: "user", sessionId: "ses_forge_a" },
    ];
    const split = fakeSession("ses_forge_b", 1_000_000);
    split.events = [
      { harness: "claude-code", text: "first", role: "user", sessionId: "ses_forge_b" },
      { harness: "claude-code", text: "second", role: "assistant", sessionId: "ses_forge_b" },
    ];
    expect(hashSessionContent(single)).not.toBe(hashSessionContent(split));
  });
});

// ── state.db round-trip ─────────────────────────────────────────────────────

describe("extract_sessions_seen — state.db round-trip", () => {
  function openInMem() {
    return openStateDatabase(":memory:");
  }

  test("upsertExtractedSession + getExtractedSession round-trip persists content_hash", () => {
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
      contentHash: "H",
    });

    const row = getExtractedSession(db, "claude-code", "ses_a");
    expect(row).toBeDefined();
    expect(row?.session_id).toBe("ses_a");
    expect(row?.outcome).toBe("candidates_queued");
    expect(row?.candidate_count).toBe(2);
    // session_ended_at is still written (telemetry/back-compat) but is no longer
    // the skip authority.
    expect(row?.session_ended_at).toBe(new Date(endedAt).toISOString());
    expect(row?.source_run).toBe("run-1");
    expect(JSON.parse(row?.metadata_json ?? "{}")).toEqual({ foo: "bar" });
    expect(row?.content_hash).toBe("H");
    db.close();
  });

  test("upsert is INSERT-OR-REPLACE (latest content_hash wins, incl. back to null)", () => {
    const db = openInMem();
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_b",
      processedAt: "2026-05-25T00:00:00.000Z",
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
      contentHash: "H",
    });
    expect(getExtractedSession(db, "claude-code", "ses_b")?.content_hash).toBe("H");
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_b",
      processedAt: "2026-05-26T00:00:00.000Z",
      outcome: "candidates_queued",
      candidateCount: 3,
      proposalCount: 3,
      contentHash: null,
    });
    const row = getExtractedSession(db, "claude-code", "ses_b");
    expect(row?.outcome).toBe("candidates_queued");
    expect(row?.processed_at).toBe("2026-05-26T00:00:00.000Z");
    expect(row?.candidate_count).toBe(3);
    expect(row?.content_hash).toBeNull();
    db.close();
  });

  // AC4 migration-level: a pre-013 row (written without a content_hash) reads
  // back content_hash === null and does not throw.
  test("migration 013: a row written without content_hash reads back null (AC4)", () => {
    const db = openInMem();
    // Simulate a legacy (pre-013) write using only the original column set.
    db.prepare(`
      INSERT OR REPLACE INTO extract_sessions_seen
        (harness, session_id, processed_at, session_ended_at, outcome,
         candidate_count, proposal_count, rationale, source_run, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("claude-code", "ses_legacy", "2026-05-01T00:00:00.000Z", null, "no_candidates", 0, 0, null, null, "{}");

    const row = getExtractedSession(db, "claude-code", "ses_legacy");
    expect(row).toBeDefined();
    expect(row?.content_hash).toBeNull();
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
      contentHash: "H",
    });
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_b",
      processedAt: "x",
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
      contentHash: "H",
    });
    upsertExtractedSession(db, {
      harness: "opencode",
      sessionId: "ses_a",
      processedAt: "x",
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
      contentHash: "H",
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

// ── akmExtract — skip-already-extracted integration (#602 hash-based) ───────

describe("akmExtract — skip-already-extracted (content-hash)", () => {
  // AC1 end-to-end: seed the SAME content_hash the run will compute; the session
  // must be skipped (zero chat() calls) EVEN WHEN the recorded session_ended_at
  // diverges wildly from the live session (clock-skew immunity).
  test("skips a session whose content_hash matches, regardless of endedAt (AC1)", async () => {
    const stash = makeStashDir();
    const liveEndedAt = Date.now();
    const session = fakeSession("ses_seen", liveEndedAt);
    const matchingHash = hashSessionContent(session);
    const db = openStateDatabase(":memory:");
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_seen",
      processedAt: new Date(liveEndedAt - 1_000).toISOString(),
      // Deliberately divergent recorded ended-at to prove timestamps don't gate.
      sessionEndedAt: liveEndedAt - 999_999_999,
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
      contentHash: matchingHash,
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

  // AC2 end-to-end: seed a stale content_hash; the run must re-process and UPDATE
  // the stored hash to the freshly computed value.
  test("re-processes when the stored content_hash is stale, and updates it (AC2)", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_updated", Date.now());
    const freshHash = hashSessionContent(session);
    const db = openStateDatabase(":memory:");
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_updated",
      processedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
      contentHash: "stale-hash",
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
    expect(getExtractedSession(db, "claude-code", "ses_updated")?.content_hash).toBe(freshHash);
    db.close();
  });

  // AC4 end-to-end: a legacy null-hash row is processed once (backfill) and the
  // hash becomes stable, so a second unchanged run skips it.
  test("backfills a null content_hash row once, then skips on the next unchanged run (AC4)", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_backfill", Date.now());
    const db = openStateDatabase(":memory:");
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_backfill",
      processedAt: new Date(Date.now() - 60_000).toISOString(),
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
      contentHash: null,
    });

    let chatCalls = 0;
    const chat = async () => {
      chatCalls += 1;
      return JSON.stringify({ candidates: [] });
    };

    // First run: backfill → processed.
    const first = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeHarness([session])],
      stateDb: db,
      chat,
    });
    expect(first.sessionsProcessed).toBe(1);
    expect(chatCalls).toBe(1);
    const backfilled = getExtractedSession(db, "claude-code", "ses_backfill")?.content_hash;
    expect(backfilled).toBe(hashSessionContent(session));

    // Second run: unchanged content → skipped, no further chat().
    const second = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeHarness([session])],
      stateDb: db,
      chat,
    });
    expect(second.sessionsSkipped).toBe(1);
    expect(second.sessionsProcessed).toBe(0);
    expect(chatCalls).toBe(1);
    db.close();
  });

  test("explicit sessionId RESPECTS the content-hash skip (idempotent; --force overrides)", async () => {
    // A session-end hook firing `extract --session-id <id>` must be idempotent:
    // if the session was already extracted and its content is unchanged, the
    // targeted run skips (no LLM call) — exactly like discovery mode. Only
    // --force re-extracts (covered by the sibling test below).
    const stash = makeStashDir();
    const session = fakeSession("ses_force", Date.now());
    const db = openStateDatabase(":memory:");
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_force",
      processedAt: new Date(Date.now() - 1_000).toISOString(),
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
      // Matching hash — targeted single-session extract must SKIP it (no --force).
      contentHash: hashSessionContent(session),
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

    // No LLM call, session skipped as already-extracted (idempotent hook fire).
    expect(chatCalls).toBe(0);
    expect(result.sessionsProcessed).toBe(0);
    db.close();
  });

  test("--force bypasses the skip-tracking check (even with matching hash)", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_forced", Date.now());
    const db = openStateDatabase(":memory:");
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_forced",
      processedAt: new Date(Date.now() - 1_000).toISOString(),
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
      contentHash: hashSessionContent(session),
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

  test("processing a session records its outcome AND content_hash in state.db", async () => {
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
    expect(row?.content_hash).toBe(hashSessionContent(session));
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

// ── countNewExtractCandidates — conservative pre-LLM approximation (#554/#602) ─
//
// This cheap gate does NOT read sessions, so it cannot compute the content hash.
// It must therefore over-estimate "new": a session counts as new when there is
// no prior row OR the prior row's content_hash is null (never-seen or
// backfill-eligible). A prior row WITH a non-null content_hash counts as NOT new
// (the precise per-session hash check happens later in processSession).

describe("countNewExtractCandidates — row-presence approximation", () => {
  test("never-seen session counts as new (so the #554 gate still fires)", async () => {
    const { countNewExtractCandidates } = await import("../../src/commands/improve/extract");
    const stash = makeStashDir();
    const session = fakeSession("ses_new", Date.now());
    const db = openStateDatabase(":memory:");
    const n = countNewExtractCandidates(configEnabled(stash), {
      harnesses: [makeHarness([session])],
      stateDb: db,
    });
    expect(n).toBe(1);
    db.close();
  });

  test("prior row with a null content_hash counts as new (backfill-eligible)", async () => {
    const { countNewExtractCandidates } = await import("../../src/commands/improve/extract");
    const stash = makeStashDir();
    const session = fakeSession("ses_nullhash", Date.now());
    const db = openStateDatabase(":memory:");
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_nullhash",
      processedAt: new Date().toISOString(),
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
      contentHash: null,
    });
    const n = countNewExtractCandidates(configEnabled(stash), {
      harnesses: [makeHarness([session])],
      stateDb: db,
    });
    expect(n).toBe(1);
    db.close();
  });

  test("prior row with a non-null content_hash counts as NOT new", async () => {
    const { countNewExtractCandidates } = await import("../../src/commands/improve/extract");
    const stash = makeStashDir();
    const session = fakeSession("ses_hashed", Date.now());
    const db = openStateDatabase(":memory:");
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_hashed",
      processedAt: new Date().toISOString(),
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
      contentHash: "some-non-null-hash",
    });
    const n = countNewExtractCandidates(configEnabled(stash), {
      harnesses: [makeHarness([session])],
      stateDb: db,
    });
    expect(n).toBe(0);
    db.close();
  });
});

// ── getLastExtractRunAt — discovery watermark source ────────────────────────

describe("getLastExtractRunAt", () => {
  test("returns null when the harness has never been extracted", () => {
    const db = openStateDatabase(":memory:");
    expect(getLastExtractRunAt(db, "claude-code")).toBeNull();
    db.close();
  });

  test("returns the most recent processed_at (ms epoch) for the harness", () => {
    const db = openStateDatabase(":memory:");
    const older = "2026-06-01T00:00:00.000Z";
    const newer = "2026-06-10T12:00:00.000Z";
    for (const [sid, at] of [
      ["ses_a", older],
      ["ses_b", newer],
    ] as const) {
      upsertExtractedSession(db, {
        harness: "claude-code",
        sessionId: sid,
        processedAt: at,
        outcome: "no_candidates",
        candidateCount: 0,
        proposalCount: 0,
        contentHash: "h",
      });
    }
    // A different harness must not bleed into the watermark.
    upsertExtractedSession(db, {
      harness: "opencode",
      sessionId: "ses_oc",
      processedAt: "2030-01-01T00:00:00.000Z",
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
      contentHash: "h",
    });
    expect(getLastExtractRunAt(db, "claude-code")).toBe(Date.parse(newer));
    db.close();
  });
});

// ── default discovery window — "since last run", floored at 48h ──────────────

describe("akmExtract — default since (watermark)", () => {
  test("floors at 48h when there is no prior run (older sessions excluded)", async () => {
    const stash = makeStashDir();
    const db = openStateDatabase(":memory:");
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const withinFloor = Date.now() - 1 * 60 * 60 * 1000;
    const old = fakeSession("ses_3d", threeDaysAgo);
    const recent = fakeSession("ses_1h", withinFloor);

    const result = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeHarness([old, recent])],
      stateDb: db,
      chat: async () => JSON.stringify({ candidates: [] }),
    });

    // 3-day-old session is outside the 48h floor; the 1h-old one is inside.
    expect(result.sessions.map((s) => s.sessionId)).toEqual(["ses_1h"]);
    db.close();
  });

  test("widens to the last run so an intermittent host doesn't lose sessions", async () => {
    const stash = makeStashDir();
    const db = openStateDatabase(":memory:");
    // Establish a watermark: the last recorded run was 10 days ago.
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    upsertExtractedSession(db, {
      harness: "claude-code",
      sessionId: "ses_prior_run",
      processedAt: new Date(tenDaysAgo).toISOString(),
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
      contentHash: "h",
    });
    // A session that ended 5 days ago: OUTSIDE the 48h floor, INSIDE the 10-day
    // watermark — must be discovered (would be lost under a fixed 24h/48h window).
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const session = fakeSession("ses_5d", fiveDaysAgo);

    const result = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeHarness([session])],
      stateDb: db,
      chat: async () => JSON.stringify({ candidates: [] }),
    });

    expect(result.sessions.find((s) => s.sessionId === "ses_5d")).toBeDefined();
    expect(result.sessionsProcessed).toBe(1);
    db.close();
  });
});

// ── Q5 per-session lock — concurrent-extract guard ──────────────────────────

describe("akmExtract — per-session lock", () => {
  test("skips a session whose lock is held by another live run (zero LLM calls)", async () => {
    const stash = makeStashDir();
    const stateDir = makeTempDir("akm-extract-lock-");
    const stateDbPath = path.join(stateDir, "state.db");
    const session = fakeSession("ses_locked", Date.now());

    // Pre-create the lock held by THIS (live) process at the path akmExtract derives.
    const lockPath = path.join(stateDir, "extract-locks", "extract-claude-code-ses_locked.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    expect(tryAcquireLockSync(lockPath, String(process.pid))).toBeDefined();

    let chatCalls = 0;
    const result = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeHarness([session])],
      // No stateDb handle → real cross-process path → lock engages; pinned to temp.
      stateDbPath,
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
    });

    expect(chatCalls).toBe(0);
    expect(result.sessionsProcessed).toBe(0);
    expect(result.sessions[0]?.skipReason).toBe("locked_concurrent");
  });

  test("processes normally when no lock is held, and releases the lock after", async () => {
    const stash = makeStashDir();
    const stateDir = makeTempDir("akm-extract-lock-free-");
    const stateDbPath = path.join(stateDir, "state.db");
    const session = fakeSession("ses_free", Date.now());

    const result = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeHarness([session])],
      stateDbPath,
      chat: async () => JSON.stringify({ candidates: [] }),
    });

    expect(result.sessionsProcessed).toBe(1);
    // Lock released → a fresh acquire succeeds.
    const lockPath = path.join(stateDir, "extract-locks", "extract-claude-code-ses_free.lock");
    expect(tryAcquireLockSync(lockPath, String(process.pid))).toBeDefined();
  });
});

// ── R4: transient skip outcomes persist a NULL content_hash (stay retryable) ──
//
// llm_unavailable (the LLM was down) and triaged_out (deferred by the triage
// gate) must NOT pin the session against its current byte content — persisting
// the hash would make the next run skip it as "already_extracted" and it would
// never be retried once the LLM recovers / the triage bar changes. Persisting a
// null hash keeps the row eligible for the existing null-hash retry.
describe("akmExtract — R4 transient outcomes stay retryable (null content_hash)", () => {
  test("llm_unavailable → tracked row carries a null content_hash", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_llm_down", Date.now());
    const db = openStateDatabase(":memory:");

    const result = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeHarness([session])],
      stateDb: db,
      // A throwing chat drives tryLlmFeature onto its fallback path → the
      // session is skipped with skipReason "llm_unavailable".
      chat: async () => {
        throw new Error("llm endpoint unreachable");
      },
    });

    expect(result.sessions[0]?.skipReason).toBe("llm_unavailable");
    const row = getExtractedSession(db, "claude-code", "ses_llm_down");
    expect(row).toBeDefined();
    expect(row?.content_hash).toBeNull();
    db.close();
  });

  test("triaged_out → tracked row carries a null content_hash", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_triaged", Date.now());
    const db = openStateDatabase(":memory:");

    // Force triage-out for ANY session by setting an unreachable minScore, so the
    // outcome does not depend on a fragile low-signal fixture.
    const config = configEnabled(stash);
    const extractProcess = config.improve?.strategies?.tracking?.processes?.extract as Record<string, unknown>;
    extractProcess.minContentChars = 1;
    extractProcess.triage = { enabled: true, minScore: 999_999 };

    let chatCalls = 0;
    const result = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config,
      harnesses: [makeHarness([session])],
      stateDb: db,
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
    });

    // Triaged out before the LLM call: no chat, skipReason triaged_out.
    expect(chatCalls).toBe(0);
    expect(result.sessions[0]?.skipReason).toBe("triaged_out");
    const row = getExtractedSession(db, "claude-code", "ses_triaged");
    expect(row).toBeDefined();
    expect(row?.content_hash).toBeNull();
    db.close();
  });
});
