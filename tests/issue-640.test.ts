// RED tests for #640 — extract: preserve deterministic session-index asset on
// non-self skips (too_short / triaged_out), so tightening gates don't thin
// #561 coverage.
//
// These tests exercise the PLANNED behaviour of the feature, none of which is
// implemented yet. Every test in this file is expected to FAIL until the
// implementation is complete.
//
// Acceptance cases:
//   A. too_short skip still writes the deterministic session-index asset
//      (when sessionIndexing.enabled and indexSessions is on)
//   B. triaged_out skip still writes the deterministic session-index asset
//   C. improve_review skip does NOT write the session-index asset
//   D. No LLM/generate call on any skipped session path (injected counter)
//   E. Fail-open: if the deterministic write throws, the skip result is
//      unchanged (same skipReason, skipped:true)
//   F. No-op when session indexing is disabled (indexSessions:false)
//   G. Default-preserving guard: a non-skipped normal session still produces
//      an asset (generate is called as before — no regression)
//   H. Counter distinguishes skip-path vs extract-path index writes

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmExtract } from "../src/commands/improve/extract";
import type { SessionSummaryGenerator, SessionSummaryResult } from "../src/commands/improve/session-asset";
import { resolveSessionAssetPath } from "../src/commands/improve/session-asset";
import type { AkmConfig } from "../src/core/config/config";
import type {
  SessionData,
  SessionLogHarness,
  SessionRef,
  SessionSummary,
} from "../src/integrations/session-logs/types";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

// ── Sandbox wiring ───────────────────────────────────────────────────────────

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => {
  storage.cleanup();
});

// ── Config factories ─────────────────────────────────────────────────────────

/**
 * Build an AkmConfig with indexSessions ENABLED (the relevant path for #640).
 * Triage can be optionally enabled to exercise the triaged_out path.
 */
function baseConfig(stashDir: string, extractOverride: Record<string, unknown> = {}): AkmConfig {
  return {
    semanticSearchMode: "auto",
    stashDir,
    sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
    defaultWriteTarget: "stash",
    profiles: {
      llm: {
        default: {
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "test-model",
          supportsJsonSchema: true,
        },
      },
      improve: {
        default: {
          processes: {
            extract: {
              enabled: true,
              // Enable session indexing so the #640 path is active.
              indexSessions: true,
              ...extractOverride,
            },
          },
        },
      },
    },
    defaults: { llm: "default" },
  } as AkmConfig;
}

// ── SessionData builders ─────────────────────────────────────────────────────

/** A session whose raw content is below minContentChars so it gets too_short. */
function tooShortSession(id: string): SessionData {
  const now = Date.now();
  return {
    ref: {
      harness: "claude-code",
      sessionId: id,
      filePath: `/tmp/fake/${id}.jsonl`,
      startedAt: now - 3_600_000,
      endedAt: now,
      title: `Short session ${id}`,
    },
    events: [
      {
        harness: "claude-code",
        // Only 5 chars — below any reasonable minContentChars threshold
        text: "hi",
        ts: now - 3_600_000,
        sessionId: id,
        role: "user" as const,
        filePath: `/tmp/fake/${id}.jsonl`,
      },
    ],
    inlineRefs: [],
  };
}

/**
 * A session that passes minContentChars but is expected to be triaged out by
 * the triage gate when triage is enabled with a very high minScore.
 */
function triagedSession(id: string): SessionData {
  const now = Date.now();
  return {
    ref: {
      harness: "claude-code",
      sessionId: id,
      filePath: `/tmp/fake/${id}.jsonl`,
      startedAt: now - 3_600_000,
      endedAt: now,
      title: `Low-signal session ${id}`,
    },
    events: [
      {
        harness: "claude-code",
        // Enough chars to pass minContentChars but low signal
        text: "user message: just checking in. no issues today. everything is fine.",
        ts: now - 3_600_000,
        sessionId: id,
        role: "user" as const,
        filePath: `/tmp/fake/${id}.jsonl`,
      },
    ],
    inlineRefs: [],
  };
}

/** A session with the improve-review AKM_ORIGIN marker in the first event. */
function improveReviewSession(id: string): SessionData {
  const now = Date.now();
  return {
    ref: {
      harness: "claude-code",
      sessionId: id,
      filePath: `/tmp/fake/${id}.jsonl`,
      startedAt: now - 3_600_000,
      endedAt: now,
      title: `Improve review ${id}`,
    },
    events: [
      {
        harness: "claude-code",
        text: "AKM_ORIGIN: improve-review\nReviewing stash asset memory:auth-jwt-ttl.",
        ts: now - 3_600_000,
        sessionId: id,
        role: "assistant" as const,
        filePath: `/tmp/fake/${id}.jsonl`,
      },
      {
        harness: "claude-code",
        text: "The asset looks good. No changes needed.",
        ts: now - 3_000_000,
        sessionId: id,
        role: "assistant" as const,
        filePath: `/tmp/fake/${id}.jsonl`,
      },
    ],
    inlineRefs: [],
  };
}

/** A normal session that should proceed through the full extract pipeline. */
function normalSession(id: string): SessionData {
  const now = Date.now();
  return {
    ref: {
      harness: "claude-code",
      sessionId: id,
      filePath: `/tmp/fake/${id}.jsonl`,
      startedAt: now - 3_600_000,
      endedAt: now,
      title: `Normal session ${id}`,
    },
    events: [
      {
        harness: "claude-code",
        text: "user message: explain how to recover from VPN-disconnect during deploy and what the root cause is",
        ts: now - 3_600_000,
        sessionId: id,
        role: "user" as const,
        filePath: `/tmp/fake/${id}.jsonl`,
      },
      {
        harness: "claude-code",
        text: "agent: deploy.sh hangs without VPN. The root cause is that the stage push endpoint requires a corporate proxy. When VPN is disconnected the proxy is unreachable and the script waits indefinitely.",
        ts: now - 3_000_000,
        sessionId: id,
        role: "assistant" as const,
        filePath: `/tmp/fake/${id}.jsonl`,
      },
    ],
    inlineRefs: [],
  };
}

function makeFakeHarness(sessions: SessionData[], available = true): SessionLogHarness {
  const summaries: SessionSummary[] = sessions.map((s) => s.ref);
  return {
    name: "claude-code",
    isAvailable: () => available,
    *readEvents() {
      // not used by extract pipeline
    },
    listSessions: (input?: { sinceMs?: number }) => {
      const since = input?.sinceMs ?? 0;
      return summaries.filter((s) => (s.endedAt ?? 0) >= since);
    },
    readSession: (ref: SessionRef): SessionData => {
      const found = sessions.find((s) => s.ref.sessionId === ref.sessionId);
      if (!found) throw new Error(`session not found: ${ref.sessionId}`);
      return found;
    },
  };
}

/** A fake SessionSummaryGenerator that counts calls and returns a fixed summary. */
function makeCountingGenerator(counter: { calls: number }): SessionSummaryGenerator {
  return async (_data: SessionData): Promise<SessionSummaryResult | undefined> => {
    counter.calls += 1;
    return {
      summary: "A fake session summary for testing.",
      keyTopics: ["testing", "fake"],
    };
  };
}

// ── A. too_short skip → deterministic index asset written ────────────────────

describe("#640 — too_short skip preserves deterministic session-index asset", () => {
  test("A1: too_short session produces a session asset file even though the LLM extract is skipped", async () => {
    // #640 PLANNED: on too_short skips, the extract pass should still write
    // the deterministic session-index asset (sessions/<harness>/<id>.md)
    // WITHOUT calling the generateSessionSummary / LLM.
    const stash = storage.stashDir;
    const session = tooShortSession("too-short-a1");

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "too-short-a1",
      stashDir: stash,
      // Force minContentChars high enough to trigger too_short for our 2-char session.
      // indexSkippedSessions: true opts in to the #640 skip-path write (default OFF).
      config: baseConfig(stash, { minContentChars: 100, indexSkippedSessions: true }),
      harnesses: [makeFakeHarness([session])],
      // No chat call expected — session is too short
      chat: async () => {
        throw new Error("chat must NOT be called on a too_short session");
      },
      // Deterministic: no LLM call, so we don't inject a generating function
      // The implementation should NOT call generateSessionSummary on skipped sessions.
      // When #640 is implemented, passing a counting generator should show 0 calls.
      generateSessionSummary: makeCountingGenerator({ calls: 0 }),
    });

    // Session must still be reported as skipped (too_short) — the asset write
    // is a SIDE EFFECT of the skip, not a change to the skip decision.
    expect(result.sessions[0]?.skipReason).toBe("too_short");
    expect(result.sessions[0]?.skipped).toBe(true);

    // #640 ASSERTION: the session asset file must exist on disk even though the
    // session was skipped. This currently FAILS because the too_short path returns
    // early before any asset write.
    const assetPath = resolveSessionAssetPath(stash, "claude-code", "too-short-a1");
    expect(fs.existsSync(assetPath)).toBe(true);
  });

  test("A2: too_short session asset contains deterministic metadata (no LLM summary body required)", async () => {
    // The asset written on a skip path is DETERMINISTIC — derived only from
    // SessionData.ref fields, with no LLM summary. The file must be valid markdown
    // with frontmatter containing at least: session_id, harness, log_path.
    const stash = storage.stashDir;
    const session = tooShortSession("too-short-a2");

    await akmExtract({
      type: "claude-code",
      sessionId: "too-short-a2",
      stashDir: stash,
      config: baseConfig(stash, { minContentChars: 100, indexSkippedSessions: true }),
      harnesses: [makeFakeHarness([session])],
      chat: async () => {
        throw new Error("chat must NOT be called on a too_short session");
      },
      generateSessionSummary: async () => undefined, // must NOT be called
    });

    const assetPath = resolveSessionAssetPath(stash, "claude-code", "too-short-a2");
    // File must exist — this assertion fails until #640 is implemented
    expect(fs.existsSync(assetPath)).toBe(true);

    const content = fs.readFileSync(assetPath, "utf8");
    // Must contain the session_id in frontmatter
    expect(content).toContain("too-short-a2");
    // Must contain the log_path for correlation
    expect(content).toContain("/tmp/fake/too-short-a2.jsonl");
  });

  test("A3: sessionAssetRef is set on the result when deterministic asset is written", async () => {
    // The #561 sessionAssetRef field on ExtractedSessionResult must be populated
    // even on the too_short skip path so state-db tracking can record the
    // asset correlation (same as the normal extract path).
    const stash = storage.stashDir;
    const session = tooShortSession("too-short-a3");

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "too-short-a3",
      stashDir: stash,
      config: baseConfig(stash, { minContentChars: 100, indexSkippedSessions: true }),
      harnesses: [makeFakeHarness([session])],
      chat: async () => {
        throw new Error("chat must NOT be called");
      },
      generateSessionSummary: async () => undefined, // must NOT be called
    });

    // #640 ASSERTION: sessionAssetRef must be set even on too_short skip.
    // Currently fails because the too_short path returns without this field.
    expect(result.sessions[0]?.sessionAssetRef).toBeDefined();
    expect(result.sessions[0]?.sessionAssetRef).toMatch(/^session:/);
  });
});

// ── B. triaged_out skip → deterministic index asset written ──────────────────

describe("#640 — triaged_out skip preserves deterministic session-index asset", () => {
  test("B1: triaged_out session produces a session asset file", async () => {
    // Same as A1 but triggered by the triage gate instead of minContentChars.
    // The triage gate needs to be enabled with a threshold that the
    // triagedSession (low-signal) will fail.
    const stash = storage.stashDir;
    const session = triagedSession("triaged-b1");

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "triaged-b1",
      stashDir: stash,
      config: baseConfig(stash, {
        // Enable triage gate with a very high minScore so the low-signal session fails.
        // indexSkippedSessions: true opts in to the #640 skip-path write (default OFF).
        triage: { enabled: true, minScore: 100 },
        indexSkippedSessions: true,
      }),
      harnesses: [makeFakeHarness([session])],
      chat: async () => {
        throw new Error("chat must NOT be called on a triaged_out session");
      },
      generateSessionSummary: async () => undefined, // must NOT be called
    });

    // Must still be reported as triaged_out
    expect(result.sessions[0]?.skipReason).toBe("triaged_out");
    expect(result.sessions[0]?.skipped).toBe(true);

    // #640 ASSERTION: session asset must exist
    const assetPath = resolveSessionAssetPath(stash, "claude-code", "triaged-b1");
    expect(fs.existsSync(assetPath)).toBe(true);
  });

  test("B2: triaged_out asset sessionAssetRef is set on the result", async () => {
    const stash = storage.stashDir;
    const session = triagedSession("triaged-b2");

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "triaged-b2",
      stashDir: stash,
      config: baseConfig(stash, {
        triage: { enabled: true, minScore: 100 },
        indexSkippedSessions: true,
      }),
      harnesses: [makeFakeHarness([session])],
      chat: async () => {
        throw new Error("chat must NOT be called");
      },
      generateSessionSummary: async () => undefined,
    });

    // #640 ASSERTION: sessionAssetRef set even on triaged_out
    expect(result.sessions[0]?.sessionAssetRef).toBeDefined();
    expect(result.sessions[0]?.sessionAssetRef).toMatch(/^session:/);
  });
});

// ── C. improve_review skip does NOT write the session-index asset ─────────────

describe("#640 — improve_review skip does NOT write the session-index asset", () => {
  test("C1: hard-skip (skipSelfReview:'skip') improve_review → NO session asset written", async () => {
    // This is the critical guard: improve_review skips must NOT write an asset
    // because the sessions have zero informational value and the spec says NEVER.
    const stash = storage.stashDir;
    const session = improveReviewSession("improve-review-c1");

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "improve-review-c1",
      stashDir: stash,
      config: baseConfig(stash, { skipSelfReview: "skip" }),
      harnesses: [makeFakeHarness([session])],
      chat: async () => {
        throw new Error("chat must NOT be called");
      },
      generateSessionSummary: async () => {
        throw new Error("generateSessionSummary must NOT be called on improve_review skips");
      },
    });

    // Must be skipped as improve_review
    expect(result.sessions[0]?.skipReason).toBe("improve_review");
    expect(result.sessions[0]?.skipped).toBe(true);

    // #640 ASSERTION: NO session asset must be written for improve_review
    const assetPath = resolveSessionAssetPath(stash, "claude-code", "improve-review-c1");
    expect(fs.existsSync(assetPath)).toBe(false);
  });

  test("C2: shadow mode improve_review → NO session asset written on skip path", async () => {
    // Shadow mode still extracts (session is not skipped), so the normal
    // maybeWriteSessionAsset path applies. But if the generator returns undefined,
    // NO asset is written — this is existing behaviour, not changed by #640.
    // The key assertion here: the shadow-mode improve_review path is NOT affected
    // by the skip-path asset write of #640.
    const stash = storage.stashDir;
    const session = improveReviewSession("improve-review-c2");

    let _generateCalled = false;
    const result = await akmExtract({
      type: "claude-code",
      sessionId: "improve-review-c2",
      stashDir: stash,
      config: baseConfig(stash, { skipSelfReview: "shadow" }),
      harnesses: [makeFakeHarness([session])],
      chat: async () => JSON.stringify({ candidates: [] }),
      // In shadow mode, generate IS called (normal extract path), so provide one
      generateSessionSummary: async () => {
        _generateCalled = true;
        return undefined; // no summary, so no asset
      },
    });

    // Shadow mode: session proceeds, so generate may be called
    // but the skip-path #640 code must NOT trigger an extra generate call
    // (generate may be called once from the normal path — that's fine).
    // The asset must not exist (generator returned undefined).
    const assetPath = resolveSessionAssetPath(stash, "claude-code", "improve-review-c2");
    expect(fs.existsSync(assetPath)).toBe(false);

    // Not counted as skipped (shadow mode)
    expect(result.sessions[0]?.skipped).toBeFalsy();
  });
});

// ── D. No LLM call on any skipped session ────────────────────────────────────

describe("#640 — no LLM/generate call on skipped sessions", () => {
  test("D1: too_short skip — generateSessionSummary is NOT called", async () => {
    // The deterministic write path must NOT invoke generateSessionSummary
    // (which calls an LLM). The asset is written from pure SessionData.ref fields.
    const stash = storage.stashDir;
    const session = tooShortSession("too-short-d1");
    const counter = { calls: 0 };

    await akmExtract({
      type: "claude-code",
      sessionId: "too-short-d1",
      stashDir: stash,
      // indexSkippedSessions: true opts in to the #640 skip-path write (default OFF).
      config: baseConfig(stash, { minContentChars: 100, indexSkippedSessions: true }),
      harnesses: [makeFakeHarness([session])],
      chat: async () => {
        throw new Error("chat must NOT be called");
      },
      generateSessionSummary: makeCountingGenerator(counter),
    });

    // #640 ASSERTION: generate must NEVER be called on a skipped session.
    // The deterministic write path is pure — it uses SessionData.ref only,
    // never invokes generateSessionSummary / LLM. counter must stay 0.
    expect(counter.calls).toBe(0);
  });

  test("D2: triaged_out skip — generateSessionSummary is NOT called", async () => {
    const stash = storage.stashDir;
    const session = triagedSession("triaged-d2");
    const counter = { calls: 0 };

    await akmExtract({
      type: "claude-code",
      sessionId: "triaged-d2",
      stashDir: stash,
      config: baseConfig(stash, {
        triage: { enabled: true, minScore: 100 },
        indexSkippedSessions: true,
      }),
      harnesses: [makeFakeHarness([session])],
      chat: async () => {
        throw new Error("chat must NOT be called");
      },
      generateSessionSummary: makeCountingGenerator(counter),
    });

    // #640 ASSERTION: generate must NEVER be called on a triaged_out session.
    expect(counter.calls).toBe(0);
  });

  test("D3: improve_review hard-skip — generateSessionSummary is NOT called", async () => {
    const stash = storage.stashDir;
    const session = improveReviewSession("improve-review-d3");
    const counter = { calls: 0 };

    await akmExtract({
      type: "claude-code",
      sessionId: "improve-review-d3",
      stashDir: stash,
      config: baseConfig(stash, { skipSelfReview: "skip" }),
      harnesses: [makeFakeHarness([session])],
      chat: async () => {
        throw new Error("chat must NOT be called");
      },
      generateSessionSummary: makeCountingGenerator(counter),
    });

    // improve_review skip must NOT call generate (and must NOT write an asset — C1)
    expect(counter.calls).toBe(0);
  });
});

// ── E. Fail-open: deterministic write failure does not change skip result ─────

describe("#640 — fail-open: deterministic write failure preserves skip result", () => {
  test("E1: even if the stash dir is read-only, too_short result is unchanged", async () => {
    // The stash directory is made read-only so any write attempt throws.
    // The skip result must remain too_short, skipped:true, no exception thrown.
    const stash = storage.stashDir;
    const session = tooShortSession("too-short-e1");

    // Make sessions dir read-only to force write failure
    const sessionsDir = path.join(stash, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.chmodSync(sessionsDir, 0o444);

    let result: Awaited<ReturnType<typeof akmExtract>>;
    try {
      result = await akmExtract({
        type: "claude-code",
        sessionId: "too-short-e1",
        stashDir: stash,
        // indexSkippedSessions: true opts in so we exercise the fail-open path.
        config: baseConfig(stash, { minContentChars: 100, indexSkippedSessions: true }),
        harnesses: [makeFakeHarness([session])],
        chat: async () => {
          throw new Error("chat must NOT be called");
        },
        generateSessionSummary: async () => undefined,
      });
    } finally {
      // Restore permissions for cleanup
      try {
        fs.chmodSync(sessionsDir, 0o755);
      } catch {
        /* ignore */
      }
    }

    // #640 ASSERTION: fail-open — skip result unchanged even if write fails
    expect(result.sessions[0]?.skipReason).toBe("too_short");
    expect(result.sessions[0]?.skipped).toBe(true);
    // akmExtract must not throw — the write failure is swallowed
    expect(result.ok).toBe(true);
  });
});

// ── F. No-op when session indexing is disabled ────────────────────────────────

describe("#640 — no-op when indexSessions is disabled", () => {
  test("F1: too_short skip with indexSessions:false → no session asset written", async () => {
    // When #561 indexing is globally disabled, the #640 skip-path write must
    // also be a no-op. No file, no generate call, no side effects.
    const stash = storage.stashDir;
    const session = tooShortSession("too-short-f1");
    const counter = { calls: 0 };

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "too-short-f1",
      stashDir: stash,
      // indexSessions: false → the entire #561/#640 path is disabled
      config: baseConfig(stash, { minContentChars: 100, indexSessions: false }),
      harnesses: [makeFakeHarness([session])],
      chat: async () => {
        throw new Error("chat must NOT be called");
      },
      generateSessionSummary: makeCountingGenerator(counter),
    });

    expect(result.sessions[0]?.skipReason).toBe("too_short");

    // No asset file (indexing disabled)
    const assetPath = resolveSessionAssetPath(stash, "claude-code", "too-short-f1");
    expect(fs.existsSync(assetPath)).toBe(false);

    // Generate not called (indexing disabled)
    expect(counter.calls).toBe(0);
  });

  test("F2: too_short skip with indexSessions:true but NO indexSkippedSessions → no asset written (default-preserving)", async () => {
    // DEFAULT-PRESERVING GUARD: with indexSessions at its default (true) but
    // indexSkippedSessions absent (undefined / not set), the skip path must
    // write NOTHING — byte-identical to pre-#640 behaviour.
    // This proves the new flag is truly opt-in and the default is preserved.
    const stash = storage.stashDir;
    const session = tooShortSession("too-short-f2");

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "too-short-f2",
      stashDir: stash,
      // indexSessions defaults to true; indexSkippedSessions is NOT set → skip path is a no-op
      config: baseConfig(stash, { minContentChars: 100 }),
      harnesses: [makeFakeHarness([session])],
      chat: async () => {
        throw new Error("chat must NOT be called");
      },
      generateSessionSummary: async () => undefined,
    });

    expect(result.sessions[0]?.skipReason).toBe("too_short");
    expect(result.sessions[0]?.skipped).toBe(true);

    // NO asset must exist — the skip path is a no-op without the opt-in flag
    const assetPath = resolveSessionAssetPath(stash, "claude-code", "too-short-f2");
    expect(fs.existsSync(assetPath)).toBe(false);

    // skipPathIndexWrites must be 0 (no writes took place)
    expect((result as unknown as Record<string, number>).skipPathIndexWrites).toBe(0);
  });
});

// ── G. Default-preserving guard: normal sessions still use generate ───────────

describe("#640 — default-preserving guard: normal extract path unchanged", () => {
  test("G1: normal session (not skipped) still calls generateSessionSummary once", async () => {
    // The #640 change must not affect the normal extract path. When a session
    // proceeds through the full pipeline, generateSessionSummary is called
    // exactly once (same as before #640).
    const stash = storage.stashDir;
    const session = normalSession("normal-g1");
    const counter = { calls: 0 };

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "normal-g1",
      stashDir: stash,
      config: baseConfig(stash),
      harnesses: [makeFakeHarness([session])],
      chat: async () => JSON.stringify({ candidates: [] }),
      generateSessionSummary: makeCountingGenerator(counter),
    });

    // Not skipped — full pipeline ran
    expect(result.sessions[0]?.skipped).toBeFalsy();
    expect(result.sessionsProcessed).toBe(1);

    // generate called once on the normal path (existing #561 behaviour)
    expect(counter.calls).toBe(1);

    // Session asset written (from the generate call)
    const assetPath = resolveSessionAssetPath(stash, "claude-code", "normal-g1");
    expect(fs.existsSync(assetPath)).toBe(true);
  });
});

// ── H. Counter distinguishes skip-path vs extract-path index writes ───────────

describe("#640 — observability counter: skip-path vs extract-path index writes", () => {
  test("H1: result includes skipPathIndexWrites and extractPathIndexWrites counters", async () => {
    // #640 adds observability counters to the AkmExtractResult (or per-session
    // result) so operators can see how many index writes came from skips vs extracts.
    // This test runs one too_short session and one normal session, then checks
    // that both counters are present and correct.
    const stash = storage.stashDir;
    const shortSession = tooShortSession("too-short-h1");
    const goodSession = normalSession("normal-h1");

    const result = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      // indexSkippedSessions: true opts in to the #640 skip-path write (default OFF).
      config: baseConfig(stash, { minContentChars: 100, indexSkippedSessions: true }),
      harnesses: [makeFakeHarness([shortSession, goodSession])],
      chat: async () => JSON.stringify({ candidates: [] }),
      generateSessionSummary: makeCountingGenerator({ calls: 0 }),
      skipTracking: true,
    });

    // #640 ASSERTION: counters must be present on the result.
    // Currently fails because AkmExtractResult does not have these fields.
    // The exact field names are the implementation's choice — the test uses
    // the names proposed in the ticket (skipPathIndexWrites / extractPathIndexWrites).
    expect(result).toHaveProperty("skipPathIndexWrites");
    expect(result).toHaveProperty("extractPathIndexWrites");

    // 1 skip-path write (too_short), 1 extract-path write (normal)
    // NOTE: the normal session write only happens if indexSessions is enabled
    // and generateSessionSummary returns a summary (counter increments).
    // Our counting generator returns a summary, so both counts should be 1.
    expect((result as unknown as Record<string, number>).skipPathIndexWrites).toBe(1);
    expect((result as unknown as Record<string, number>).extractPathIndexWrites).toBe(1);
  });
});
