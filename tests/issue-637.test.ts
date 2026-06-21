// RED tests for #637 — extract: skip improve-review subagent sessions
//
// These tests exercise the PLANNED behaviour of the feature, none of which
// is implemented yet.  Every test in this file is expected to FAIL until the
// implementation is complete.
//
// Acceptance cases:
//   A. AKM_ORIGIN marker in first event → origin='improve-review' on ref
//   B. prose fallback (both 'Asset path:' AND 'Stash root:' in events[0].text)
//      → treated as improve-review
//   C. near-miss: only ONE of the two prose markers → NOT detected
//   D. AKM_ORIGIN mid-conversation (not first event) → NOT detected
//   E. shadow mode (default): still extracts (zero behaviour change), but
//      records skipReason='improve_review' on the session result
//   F. skip mode: returns skipped:true, skipReason='improve_review', NO chat call
//   G. default-preserving guard: when config is absent (no skipSelfReview key)
//      the extract runs byte-identically (no skip, no shadow tag)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmExtract } from "../src/commands/improve/extract";
import type { AkmConfig } from "../src/core/config/config";
import type {
  SessionData,
  SessionLogHarness,
  SessionRef,
  SessionSummary,
} from "../src/integrations/session-logs/types";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

// ── Sandbox wiring ───────────────────────────────────────────────────────────

const tempDirs: string[] = [];
let storage: IsolatedAkmStorage;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function makeStashDir(): string {
  const stash = makeTempDir("akm-637-stash-");
  for (const sub of ["memories", "lessons", "knowledge"]) {
    fs.mkdirSync(path.join(stash, sub), { recursive: true });
  }
  return stash;
}
beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => {
  storage.cleanup();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Config factories ─────────────────────────────────────────────────────────

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
              indexSessions: false,
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

/** Build a SessionData whose first event.text contains the AKM_ORIGIN marker. */
function reviewSessionWithMarker(id: string): SessionData {
  const now = Date.now();
  return {
    ref: {
      harness: "claude-code",
      sessionId: id,
      filePath: `/tmp/fake/${id}.jsonl`,
      startedAt: now - 3_600_000,
      endedAt: now,
      title: `Review ${id}`,
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

/** Build a SessionData whose first event.text contains the prose-fallback markers. */
function reviewSessionWithProseFallback(id: string): SessionData {
  const now = Date.now();
  return {
    ref: {
      harness: "claude-code",
      sessionId: id,
      filePath: `/tmp/fake/${id}.jsonl`,
      startedAt: now - 3_600_000,
      endedAt: now,
      title: `Review prose ${id}`,
    },
    events: [
      {
        harness: "claude-code",
        // Contains BOTH prose markers the ticket specifies as belt-and-suspenders
        text: "Asset path: /home/user/.stash/memories/auth-jwt.md\nStash root: /home/user/.stash\nPlease review this asset.",
        ts: now - 3_600_000,
        sessionId: id,
        role: "user" as const,
        filePath: `/tmp/fake/${id}.jsonl`,
      },
      {
        harness: "claude-code",
        text: "The memory looks accurate and complete.",
        ts: now - 3_000_000,
        sessionId: id,
        role: "assistant" as const,
        filePath: `/tmp/fake/${id}.jsonl`,
      },
    ],
    inlineRefs: [],
  };
}

/** Session with ONLY one of the two prose markers (should NOT be detected). */
function reviewSessionWithOneMarker(id: string): SessionData {
  const now = Date.now();
  return {
    ref: {
      harness: "claude-code",
      sessionId: id,
      filePath: `/tmp/fake/${id}.jsonl`,
      startedAt: now - 3_600_000,
      endedAt: now,
    },
    events: [
      {
        harness: "claude-code",
        // Only 'Asset path:' — missing 'Stash root:'
        text: "Asset path: /home/user/.stash/memories/auth-jwt.md\nLet me help you with this.",
        ts: now - 3_600_000,
        sessionId: id,
        role: "user" as const,
        filePath: `/tmp/fake/${id}.jsonl`,
      },
    ],
    inlineRefs: [],
  };
}

/** Session where AKM_ORIGIN appears in event[1] (not first event) → NOT detected. */
function reviewSessionWithMarkerMidConversation(id: string): SessionData {
  const now = Date.now();
  return {
    ref: {
      harness: "claude-code",
      sessionId: id,
      filePath: `/tmp/fake/${id}.jsonl`,
      startedAt: now - 3_600_000,
      endedAt: now,
    },
    events: [
      {
        harness: "claude-code",
        // normal first event — no marker here
        text: "Hello, how can I help?",
        ts: now - 3_600_000,
        sessionId: id,
        role: "assistant" as const,
        filePath: `/tmp/fake/${id}.jsonl`,
      },
      {
        harness: "claude-code",
        // marker appears LATER — must NOT trigger detection
        text: "AKM_ORIGIN: improve-review\nSome later message.",
        ts: now - 3_000_000,
        sessionId: id,
        role: "user" as const,
        filePath: `/tmp/fake/${id}.jsonl`,
      },
    ],
    inlineRefs: [],
  };
}

/** Normal session (no markers). */
function normalSession(id: string): SessionData {
  const now = Date.now();
  return {
    ref: {
      harness: "claude-code",
      sessionId: id,
      filePath: `/tmp/fake/${id}.jsonl`,
      startedAt: now - 3_600_000,
      endedAt: now,
      title: `Session ${id}`,
    },
    events: [
      {
        harness: "claude-code",
        text: "user message: explain how to recover from VPN-disconnect during deploy",
        ts: now - 3_600_000,
        sessionId: id,
        role: "user" as const,
        filePath: `/tmp/fake/${id}.jsonl`,
      },
      {
        harness: "claude-code",
        text: "agent: I see the issue — deploy.sh hangs without VPN. The error message is misleading.",
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

// ── A. AKM_ORIGIN marker → origin field set on ref ──────────────────────────

describe("#637 — AKM_ORIGIN marker detection", () => {
  test("A1: AKM_ORIGIN marker in first event sets ref.origin to 'improve-review'", async () => {
    // This exercises the readSession path in session-log.ts:
    //   scan first event text for /^AKM_ORIGIN:\s*improve-review$/m
    //   → set ref.origin = 'improve-review'
    //
    // The 'ref.origin' field does not yet exist on SessionSummary/SessionData.
    // This test will FAIL until types.ts, session-log.ts, and the detection
    // logic are implemented.
    const session = reviewSessionWithMarker("review-a1");
    // The marker is in events[0].text — after readSession processes it, the
    // returned SessionData.ref should expose origin.
    const stash = makeStashDir();
    let capturedData: SessionData | undefined;
    const harness = makeFakeHarness([session]);

    // Wrap readSession to capture what the pipeline returns
    const origRead = harness.readSession.bind(harness);
    harness.readSession = (ref: SessionRef): SessionData => {
      const data = origRead(ref);
      capturedData = data;
      return data;
    };

    await akmExtract({
      type: "claude-code",
      sessionId: "review-a1",
      stashDir: stash,
      config: baseConfig(stash, { skipSelfReview: "shadow" }),
      harnesses: [harness],
      chat: async () => JSON.stringify({ candidates: [] }),
    });

    // origin field must be set on the ref after readSession
    expect(capturedData?.ref?.origin).toBe("improve-review");
  });
});

// ── B. Prose fallback detection ──────────────────────────────────────────────

describe("#637 — prose fallback detection", () => {
  test("B1: first-event text with both 'Asset path:' and 'Stash root:' is treated as improve-review", async () => {
    const session = reviewSessionWithProseFallback("review-b1");
    const stash = makeStashDir();
    let capturedData: SessionData | undefined;
    const harness = makeFakeHarness([session]);
    const origRead = harness.readSession.bind(harness);
    harness.readSession = (ref: SessionRef): SessionData => {
      const data = origRead(ref);
      capturedData = data;
      return data;
    };

    await akmExtract({
      type: "claude-code",
      sessionId: "review-b1",
      stashDir: stash,
      config: baseConfig(stash, { skipSelfReview: "shadow" }),
      harnesses: [harness],
      chat: async () => JSON.stringify({ candidates: [] }),
    });

    // The prose fallback must also set origin
    expect(capturedData?.ref?.origin).toBe("improve-review");
  });
});

// ── C. Near-miss: only one prose marker ──────────────────────────────────────

describe("#637 — near-miss guard (one prose marker only)", () => {
  test("C1: only 'Asset path:' (missing 'Stash root:') → origin NOT set", async () => {
    const session = reviewSessionWithOneMarker("review-c1");
    const stash = makeStashDir();
    let capturedData: SessionData | undefined;
    const harness = makeFakeHarness([session]);
    const origRead = harness.readSession.bind(harness);
    harness.readSession = (ref: SessionRef): SessionData => {
      const data = origRead(ref);
      capturedData = data;
      return data;
    };

    await akmExtract({
      type: "claude-code",
      sessionId: "review-c1",
      stashDir: stash,
      config: baseConfig(stash, { skipSelfReview: "shadow" }),
      harnesses: [harness],
      chat: async () => JSON.stringify({ candidates: [] }),
    });

    expect(capturedData?.ref?.origin).toBeUndefined();
  });
});

// ── D. AKM_ORIGIN mid-conversation ──────────────────────────────────────────

describe("#637 — mid-conversation AKM_ORIGIN guard", () => {
  test("D1: AKM_ORIGIN only in event[1] (not first event) → NOT detected", async () => {
    const session = reviewSessionWithMarkerMidConversation("review-d1");
    const stash = makeStashDir();
    let capturedData: SessionData | undefined;
    const harness = makeFakeHarness([session]);
    const origRead = harness.readSession.bind(harness);
    harness.readSession = (ref: SessionRef): SessionData => {
      const data = origRead(ref);
      capturedData = data;
      return data;
    };

    await akmExtract({
      type: "claude-code",
      sessionId: "review-d1",
      stashDir: stash,
      config: baseConfig(stash, { skipSelfReview: "shadow" }),
      harnesses: [harness],
      chat: async () => JSON.stringify({ candidates: [] }),
    });

    expect(capturedData?.ref?.origin).toBeUndefined();
  });
});

// ── E. Shadow mode — still extracts but records skipReason ──────────────────

describe("#637 — shadow mode (skipSelfReview: 'shadow')", () => {
  test("E1: shadow mode still calls chat (byte-identical token spend)", async () => {
    const session = reviewSessionWithMarker("review-e1");
    const stash = makeStashDir();
    let chatCalls = 0;

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "review-e1",
      stashDir: stash,
      config: baseConfig(stash, { skipSelfReview: "shadow" }),
      harnesses: [makeFakeHarness([session])],
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
    });

    // MUST still call chat (shadow = observability only, no behaviour change)
    expect(chatCalls).toBe(1);
    // session not counted as "skipped" in the result counts
    expect(result.sessionsProcessed).toBe(1);
    expect(result.sessionsSkipped).toBe(0);
    // BUT the per-session result tags the skipReason for audit
    expect(result.sessions[0]?.skipReason).toBe("improve_review");
  });

  test("E2: shadow mode — session NOT skipped even though detected as improve-review", async () => {
    const session = reviewSessionWithProseFallback("review-e2");
    const stash = makeStashDir();

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "review-e2",
      stashDir: stash,
      config: baseConfig(stash, { skipSelfReview: "shadow" }),
      harnesses: [makeFakeHarness([session])],
      chat: async () => JSON.stringify({ candidates: [] }),
    });

    expect(result.sessions[0]?.skipped).toBeFalsy();
    expect(result.sessionsProcessed).toBe(1);
  });
});

// ── F. Skip mode — actually skips ────────────────────────────────────────────

describe("#637 — skip mode (skipSelfReview: 'skip')", () => {
  test("F1: skip mode returns skipped:true, skipReason:'improve_review', no chat call", async () => {
    const session = reviewSessionWithMarker("review-f1");
    const stash = makeStashDir();
    let chatCalls = 0;

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "review-f1",
      stashDir: stash,
      config: baseConfig(stash, { skipSelfReview: "skip" }),
      harnesses: [makeFakeHarness([session])],
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
    });

    // Absolutely NO LLM call in skip mode
    expect(chatCalls).toBe(0);
    expect(result.sessions[0]?.skipped).toBe(true);
    expect(result.sessions[0]?.skipReason).toBe("improve_review");
    expect(result.sessionsSkipped).toBe(1);
    expect(result.sessionsProcessed).toBe(0);
  });

  test("F2: skip mode with prose-fallback also skips", async () => {
    const session = reviewSessionWithProseFallback("review-f2");
    const stash = makeStashDir();
    let chatCalls = 0;

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "review-f2",
      stashDir: stash,
      config: baseConfig(stash, { skipSelfReview: "skip" }),
      harnesses: [makeFakeHarness([session])],
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
    });

    expect(chatCalls).toBe(0);
    expect(result.sessions[0]?.skipped).toBe(true);
    expect(result.sessions[0]?.skipReason).toBe("improve_review");
  });

  test("F3: skip mode near-miss (one marker) does NOT skip", async () => {
    const session = reviewSessionWithOneMarker("review-f3");
    const stash = makeStashDir();
    let chatCalls = 0;

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "review-f3",
      stashDir: stash,
      config: baseConfig(stash, { skipSelfReview: "skip" }),
      harnesses: [makeFakeHarness([session])],
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
    });

    // Should NOT be skipped — one marker is not enough
    expect(chatCalls).toBe(1);
    expect(result.sessions[0]?.skipped).toBeFalsy();
    expect(result.sessions[0]?.skipReason).not.toBe("improve_review");
  });
});

// ── G. Default-preserving guard ───────────────────────────────────────────────

describe("#637 — default-preserving guard (skipSelfReview absent = shadow)", () => {
  test("G1: config without skipSelfReview — improve-review session still extracts (no skip)", async () => {
    // The default is 'shadow' but shadow by definition does NOT change behaviour.
    // So a session with the marker, run with NO skipSelfReview in config, must
    // behave byte-identically: chat called, sessionsProcessed=1, session not skipped.
    const session = reviewSessionWithMarker("review-g1");
    const stash = makeStashDir();
    let chatCalls = 0;

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "review-g1",
      stashDir: stash,
      // NO skipSelfReview key in config — default must apply
      config: baseConfig(stash, {}),
      harnesses: [makeFakeHarness([session])],
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
    });

    // Default shadow = no skip, chat is called
    expect(chatCalls).toBe(1);
    expect(result.sessionsProcessed).toBe(1);
    expect(result.sessionsSkipped).toBe(0);
    // skipped must not be true
    expect(result.sessions[0]?.skipped).toBeFalsy();
  });

  test("G2: normal session (no markers) is unaffected in all modes", async () => {
    const session = normalSession("normal-g2");
    const stash = makeStashDir();
    let chatCalls = 0;

    // Test with both shadow and skip modes — normal sessions must always extract
    for (const mode of ["shadow", "skip"] as const) {
      chatCalls = 0;
      const result = await akmExtract({
        type: "claude-code",
        sessionId: "normal-g2",
        stashDir: stash,
        config: baseConfig(stash, { skipSelfReview: mode }),
        harnesses: [makeFakeHarness([session])],
        chat: async () => {
          chatCalls += 1;
          return JSON.stringify({ candidates: [] });
        },
      });

      expect(chatCalls).toBe(1);
      expect(result.sessionsProcessed).toBe(1);
      expect(result.sessions[0]?.skipReason).not.toBe("improve_review");
    }
  });
});

// ── H. Config schema accepts skipSelfReview ───────────────────────────────────

describe("#637 — config schema: skipSelfReview field", () => {
  test("H1: ImproveProcessConfigSchema accepts skipSelfReview: 'shadow'", async () => {
    // Dynamically import so we don't fail at module resolution if the field
    // doesn't exist yet — we want the test assertion to fail, not an import error.
    const { ImproveProcessConfigSchema } = await import("../src/core/config/config-schema");
    const result = ImproveProcessConfigSchema.safeParse({ skipSelfReview: "shadow" });
    expect(result.success).toBe(true);
  });

  test("H2: ImproveProcessConfigSchema accepts skipSelfReview: 'skip'", async () => {
    const { ImproveProcessConfigSchema } = await import("../src/core/config/config-schema");
    const result = ImproveProcessConfigSchema.safeParse({ skipSelfReview: "skip" });
    expect(result.success).toBe(true);
  });

  test("H3: ImproveProcessConfigSchema rejects unknown skipSelfReview value", async () => {
    const { ImproveProcessConfigSchema } = await import("../src/core/config/config-schema");
    const result = ImproveProcessConfigSchema.safeParse({ skipSelfReview: "always" });
    // 'always' is not in the enum — must be rejected
    expect(result.success).toBe(false);
  });
});
