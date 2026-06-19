// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #626 — extract session-triage pre-LLM heuristic gate (RED step).
 *
 * A pure, deterministic heuristic scorer (`scoreSessionTriage`) decides — BEFORE
 * the extraction LLM call — whether a session carries enough signal to be worth
 * extracting. The gate is DEFAULT-OFF: with `processes.extract.triage` absent (or
 * `enabled:false`), akmExtract reproduces today's behaviour byte-for-byte (no
 * scorer call, no new skipReason, no telemetry event).
 *
 * When enabled it runs AFTER the minContentChars + already-extracted skip checks
 * and BEFORE `buildExtractPrompt` / the session-asset write. A low-signal session
 * is triaged out: no chat() call, no session asset, no proposals, skipReason
 * 'triaged_out', counted as skipped. Telemetry is COUNTS-ONLY: exactly one
 * aggregated `extract_triaged` event per run (never per-session).
 *
 * DESIGN-COHERENCE (#615): a high-action session (dense tool-use / edits /
 * commits) with NO narrative-lesson markers must still PASS — the procedural
 * sub-scores alone clear the bar so ordered-action data is never dropped.
 *
 * These tests import the not-yet-existing `triage.ts` module and assert behaviour
 * not yet wired into extract.ts — they MUST fail now (RED).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmExtract } from "../../../src/commands/improve/extract";
import type { AkmConfig } from "../../../src/core/config/config";
import { loadConfig, saveConfig } from "../../../src/core/config/config";
import { readEvents } from "../../../src/core/events";
import type {
  SessionData,
  SessionEvent,
  SessionLogHarness,
  SessionSummary,
} from "../../../src/integrations/session-logs/types";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const TIMEOUT_MS = 20_000;

// ── Triage module (does not exist yet — RED step) ──────────────────────────────
//
// Imported dynamically inside each unit test so the missing module only fails
// the UNIT tests; the INTEGRATION tests below drive the real `akmExtract` and
// must fail on UNWIRED BEHAVIOUR (chat() called for a session that should have
// been triaged out / no aggregated telemetry event), not on the module import.

interface TriageScore {
  pass: boolean;
  score: number;
  subscores: { markers: number; toolDensity: number; editCommit: number; substantiveRatio: number };
  reason?: "low_signal";
}
interface TriageModule {
  DEFAULT_TRIAGE_MIN_SCORE: number;
  scoreSessionTriage: (data: SessionData, minScore: number) => TriageScore;
  resolveTriageConfig: (extractProcess: unknown) => { enabled: boolean; minScore: number };
}

function loadTriage(): Promise<TriageModule> {
  return import("../../../src/commands/improve/triage") as Promise<TriageModule>;
}

// ── Sandbox ──────────────────────────────────────────────────────────────────

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => {
  storage.cleanup();
});

// ── Fixtures ───────────────────────────────────────────────────────────────────

const HARNESS = "claude-code";

function ev(role: SessionEvent["role"], text: string, extra?: Partial<SessionEvent>): SessionEvent {
  return {
    harness: HARNESS,
    text,
    ts: Date.now(),
    sessionId: "fixture",
    role,
    ...extra,
  };
}

/** Build a SessionData fixture from a list of events. */
function sessionData(sessionId: string, events: SessionEvent[]): SessionData {
  return {
    ref: {
      harness: HARNESS,
      sessionId,
      filePath: `/tmp/fake/${sessionId}.jsonl`,
      startedAt: Date.now() - 3_600_000,
      endedAt: Date.now(),
      title: sessionId,
    },
    events: events.map((e) => ({ ...e, sessionId })),
    inlineRefs: [],
  };
}

// Pure read-only Q&A: no markers, no tool use, no edits, short turns.
function lowSignalEvents(): SessionEvent[] {
  return [
    ev("user", "what is the capital of france?"),
    ev("assistant", "Paris."),
    ev("user", "and germany?"),
    ev("assistant", "Berlin."),
    ev("user", "thanks"),
    ev("assistant", "You're welcome."),
  ];
}

// Decision/outcome/error narrative markers + substantive assistant turns.
function highSignalEvents(): SessionEvent[] {
  return [
    ev("user", "the build is broken, the tests error out"),
    ev(
      "assistant",
      "Turns out the root cause was a missing import. I fixed it by adding the dependency. The error was because the module path changed; the workaround is to pin the version.",
    ),
    ev("user", "great, why did it regress?"),
    ev(
      "assistant",
      "It broke when the refactor landed. Decided to add a regression test instead of just patching, because the same gotcha had bitten us before. TIL the resolver caches stale paths.",
    ),
  ];
}

// High procedural density: many tool-use + edit/commit events, NO narrative
// lesson markers. #615 needs these KEPT.
function proceduralEvents(): SessionEvent[] {
  return [
    ev("user", "set up the project"),
    ev("tool", "Edit src/a.ts", { filePath: "src/a.ts" }),
    ev("tool", "Write src/b.ts", { filePath: "src/b.ts" }),
    ev("tool", "Edit src/c.ts", { filePath: "src/c.ts" }),
    ev("tool", "git commit -m 'scaffold'"),
    ev("tool", "Edit src/d.ts", { filePath: "src/d.ts" }),
    ev("tool", "Write src/e.ts", { filePath: "src/e.ts" }),
    ev("tool", "git commit -m 'wire up'"),
    ev("assistant", "Done."),
  ];
}

// ── UNIT: scoreSessionTriage ───────────────────────────────────────────────────

describe("scoreSessionTriage — empty signal (AC1)", () => {
  test("pure read-only Q&A scores below threshold → pass:false, reason:'low_signal'", async () => {
    const { scoreSessionTriage, DEFAULT_TRIAGE_MIN_SCORE } = await loadTriage();
    const data = sessionData("low", lowSignalEvents());
    const result = scoreSessionTriage(data, DEFAULT_TRIAGE_MIN_SCORE);
    expect(result.pass).toBe(false);
    expect(result.score).toBeLessThan(DEFAULT_TRIAGE_MIN_SCORE);
    expect(result.reason).toBe("low_signal");
  });
});

describe("scoreSessionTriage — real signal (AC3)", () => {
  test("decision/outcome/error markers + assistant turns score above threshold → pass:true", async () => {
    const { scoreSessionTriage, DEFAULT_TRIAGE_MIN_SCORE } = await loadTriage();
    const data = sessionData("high", highSignalEvents());
    const result = scoreSessionTriage(data, DEFAULT_TRIAGE_MIN_SCORE);
    expect(result.pass).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(DEFAULT_TRIAGE_MIN_SCORE);
    expect(result.reason).toBeUndefined();
  });
});

describe("scoreSessionTriage — procedural-density keep (AC3 / #615)", () => {
  test("dense tool-use/edit/commit, NO narrative markers → still passes on procedural sub-scores alone", async () => {
    const { scoreSessionTriage, DEFAULT_TRIAGE_MIN_SCORE } = await loadTriage();
    const data = sessionData("proc", proceduralEvents());
    const result = scoreSessionTriage(data, DEFAULT_TRIAGE_MIN_SCORE);
    // No narrative markers should be present, yet the session must be KEPT.
    expect(result.subscores.markers).toBe(0);
    expect(result.subscores.toolDensity).toBeGreaterThan(0);
    expect(result.subscores.editCommit).toBeGreaterThan(0);
    expect(result.pass).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(DEFAULT_TRIAGE_MIN_SCORE);
  });
});

describe("scoreSessionTriage — deterministic + pure", () => {
  test("same SessionData in → identical {score, subscores, pass} out", async () => {
    const { scoreSessionTriage, DEFAULT_TRIAGE_MIN_SCORE } = await loadTriage();
    const data = sessionData("det", highSignalEvents());
    const a: TriageScore = scoreSessionTriage(data, DEFAULT_TRIAGE_MIN_SCORE);
    const b: TriageScore = scoreSessionTriage(data, DEFAULT_TRIAGE_MIN_SCORE);
    expect(a).toEqual(b);
  });

  test("subscores object has exactly the four documented sub-signals; score == their sum", async () => {
    const { scoreSessionTriage, DEFAULT_TRIAGE_MIN_SCORE } = await loadTriage();
    const data = sessionData("shape", proceduralEvents());
    const r = scoreSessionTriage(data, DEFAULT_TRIAGE_MIN_SCORE);
    expect(Object.keys(r.subscores).sort()).toEqual(["editCommit", "markers", "substantiveRatio", "toolDensity"]);
    const sum = r.subscores.markers + r.subscores.toolDensity + r.subscores.editCommit + r.subscores.substantiveRatio;
    expect(r.score).toBeCloseTo(sum, 10);
  });

  test("DEFAULT_TRIAGE_MIN_SCORE is exported and positive", async () => {
    const { DEFAULT_TRIAGE_MIN_SCORE } = await loadTriage();
    expect(typeof DEFAULT_TRIAGE_MIN_SCORE).toBe("number");
    expect(DEFAULT_TRIAGE_MIN_SCORE).toBeGreaterThan(0);
  });
});

// ── UNIT: resolveTriageConfig ───────────────────────────────────────────────────

describe("resolveTriageConfig", () => {
  test("absent config → enabled:false (default-off)", async () => {
    const { resolveTriageConfig } = await loadTriage();
    expect(resolveTriageConfig(undefined).enabled).toBe(false);
  });

  test("absent triage on an otherwise-present extract process → enabled:false", async () => {
    const { resolveTriageConfig } = await loadTriage();
    expect(resolveTriageConfig({ enabled: true }).enabled).toBe(false);
  });

  test("explicit enabled:true, no minScore → minScore === DEFAULT_TRIAGE_MIN_SCORE", async () => {
    const { resolveTriageConfig, DEFAULT_TRIAGE_MIN_SCORE } = await loadTriage();
    const r = resolveTriageConfig({ triage: { enabled: true } });
    expect(r.enabled).toBe(true);
    expect(r.minScore).toBe(DEFAULT_TRIAGE_MIN_SCORE);
  });

  test("explicit minScore honored", async () => {
    const { resolveTriageConfig } = await loadTriage();
    const r = resolveTriageConfig({ triage: { enabled: true, minScore: 7 } });
    expect(r.enabled).toBe(true);
    expect(r.minScore).toBe(7);
  });
});

// ── Integration harness scaffolding ─────────────────────────────────────────────

interface HarnessControl {
  harness: SessionLogHarness;
  readCount: () => number;
}

/**
 * Fake harness exposing a fixed set of sessions. Each session id maps to a
 * SessionData built from the provided event lists. Counts readSession calls so
 * tests can assert which sessions reached the extraction body.
 */
function makeHarness(sessions: Array<{ id: string; events: SessionEvent[] }>): HarnessControl {
  let reads = 0;
  const summaries: SessionSummary[] = sessions.map((s) => ({
    harness: HARNESS,
    sessionId: s.id,
    filePath: `/tmp/fake/${s.id}.jsonl`,
    endedAt: Date.now(),
    startedAt: Date.now() - 3_600_000,
  }));
  const byId = new Map(sessions.map((s) => [s.id, sessionData(s.id, s.events)]));
  return {
    readCount: () => reads,
    harness: {
      name: HARNESS,
      isAvailable: () => true,
      readEvents: () => [],
      listSessions: () => summaries,
      readSession: (ref) => {
        reads += 1;
        const d = byId.get(ref.sessionId);
        if (!d) throw new Error(`no fixture for ${ref.sessionId}`);
        return d;
      },
    },
  };
}

/** Minimal config; triage block included only when provided. */
function makeConfig(triage?: { enabled?: boolean; minScore?: number }): AkmConfig {
  return {
    semanticSearchMode: "off",
    profiles: {
      improve: {
        default: {
          processes: {
            consolidate: { enabled: false },
            extract: {
              enabled: true,
              indexSessions: false,
              minContentChars: 1, // keep our small fixtures above the floor
              ...(triage ? { triage } : {}),
            },
          },
        },
      },
      llm: {
        default: {
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "test",
          supportsJsonSchema: true,
        },
      },
    },
    defaults: { llm: "default" },
  } as unknown as AkmConfig;
}

/** A chat() spy returning one lesson candidate. */
function makeChatSpy() {
  let calls = 0;
  const seenPrompts: string[] = [];
  const chat = async (_cfg: unknown, messages: Array<{ role: string; content: string }>) => {
    calls += 1;
    seenPrompts.push(messages[0]?.content ?? "");
    // Fully-valid candidate so parseExtractPayload + createProposal accept it
    // (description ≥20 chars, body ≥50 chars, when_to_use ≥15 chars, evidence ≥5).
    return JSON.stringify({
      candidates: [
        {
          type: "lesson",
          name: "triage-test-lesson",
          description: "Run the cheap heuristic triage gate before the extraction LLM call.",
          body: "When extracting durable insight from a session, run the deterministic triage gate first so low-signal sessions never reach the LLM.",
          evidence: "observed in the triage gate fixture session",
          confidence: 0.8,
          when_to_use: "before invoking the extraction LLM on a discovered session",
        },
      ],
    });
  };
  return { chat, calls: () => calls, seenPrompts };
}

function triagedEvents() {
  return readEvents({ type: "extract_triaged" }).events;
}

// ── INTEGRATION: default-off parity (AC2) ───────────────────────────────────────

describe("akmExtract — triage default-off parity (AC2)", () => {
  test(
    "triage config ABSENT → chat() called once for the (low-signal) session, no triage skipReason, no telemetry",
    async () => {
      const { harness } = makeHarness([{ id: "s-low", events: lowSignalEvents() }]);
      const spy = makeChatSpy();

      const result = await akmExtract({
        type: HARNESS,
        stashDir: storage.stashDir,
        config: makeConfig(), // no triage block
        skipTracking: true,
        harnesses: [harness],
        chat: spy.chat as never,
      });

      expect(result.ok).toBe(true);
      // Default-off: even a low-signal session goes to the LLM exactly as today.
      expect(spy.calls()).toBe(1);
      expect(result.sessions.every((s) => s.skipReason !== "triaged_out")).toBe(true);
      // No aggregated telemetry event when triage is off.
      expect(triagedEvents()).toHaveLength(0);
    },
    TIMEOUT_MS,
  );
});

describe("akmExtract — triage explicitly disabled (AC2)", () => {
  test(
    "triage:{enabled:false} reproduces default-off behaviour (chat called for low-signal session)",
    async () => {
      const { harness } = makeHarness([{ id: "s-low", events: lowSignalEvents() }]);
      const spy = makeChatSpy();

      const result = await akmExtract({
        type: HARNESS,
        stashDir: storage.stashDir,
        config: makeConfig({ enabled: false }),
        skipTracking: true,
        harnesses: [harness],
        chat: spy.chat as never,
      });

      expect(result.ok).toBe(true);
      expect(spy.calls()).toBe(1);
      expect(result.sessions.every((s) => s.skipReason !== "triaged_out")).toBe(true);
      expect(triagedEvents()).toHaveLength(0);
    },
    TIMEOUT_MS,
  );
});

// ── INTEGRATION: gate triages out (AC1) ─────────────────────────────────────────

describe("akmExtract — triage gates out a low-signal session (AC1)", () => {
  test(
    "enabled + low-signal session → chat NEVER called, skipped:true, skipReason 'triaged_out', no proposals",
    async () => {
      const { harness } = makeHarness([{ id: "s-low", events: lowSignalEvents() }]);
      const spy = makeChatSpy();

      const result = await akmExtract({
        type: HARNESS,
        stashDir: storage.stashDir,
        config: makeConfig({ enabled: true }),
        skipTracking: true,
        harnesses: [harness],
        chat: spy.chat as never,
      });

      expect(result.ok).toBe(true);
      // The LLM was never invoked for the triaged-out session.
      expect(spy.calls()).toBe(0);
      const low = result.sessions.find((s) => s.sessionId === "s-low");
      expect(low?.skipped).toBe(true);
      expect(low?.skipReason).toBe("triaged_out");
      expect(low?.proposalIds ?? []).toHaveLength(0);
      expect(result.sessionsSkipped).toBeGreaterThanOrEqual(1);
      expect(result.proposals).toHaveLength(0);
    },
    TIMEOUT_MS,
  );
});

// ── INTEGRATION: gate passes a real-signal session (AC3) ────────────────────────

describe("akmExtract — triage passes a real-signal session (AC3)", () => {
  test(
    "enabled + high-signal session → chat IS called, proposals created",
    async () => {
      const { harness } = makeHarness([{ id: "s-high", events: highSignalEvents() }]);
      const spy = makeChatSpy();

      const result = await akmExtract({
        type: HARNESS,
        stashDir: storage.stashDir,
        config: makeConfig({ enabled: true }),
        skipTracking: true,
        harnesses: [harness],
        chat: spy.chat as never,
      });

      expect(result.ok).toBe(true);
      expect(spy.calls()).toBe(1);
      const high = result.sessions.find((s) => s.sessionId === "s-high");
      expect(high?.skipReason).not.toBe("triaged_out");
      expect(result.proposals.length).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT_MS,
  );
});

// ── INTEGRATION: skip-ordering — already-skipped sessions never reach triage ─────

describe("akmExtract — skip-ordering: too_short preempts triage", () => {
  test(
    "a session below minContentChars is skipReason 'too_short', NOT 'triaged_out'",
    async () => {
      // minContentChars 10_000 forces a too-short skip before triage runs.
      const { harness } = makeHarness([{ id: "s-tiny", events: [ev("user", "hi")] }]);
      const spy = makeChatSpy();

      const config = makeConfig({ enabled: true });
      // Override minContentChars to a large value so the tiny session is too_short.
      // (makeConfig sets it to 1; bump it here.)
      (
        config as unknown as {
          profiles: { improve: { default: { processes: { extract: { minContentChars: number } } } } };
        }
      ).profiles.improve.default.processes.extract.minContentChars = 10_000;

      const result = await akmExtract({
        type: HARNESS,
        stashDir: storage.stashDir,
        config,
        skipTracking: true,
        harnesses: [harness],
        chat: spy.chat as never,
      });

      expect(result.ok).toBe(true);
      expect(spy.calls()).toBe(0);
      const tiny = result.sessions.find((s) => s.sessionId === "s-tiny");
      expect(tiny?.skipReason).toBe("too_short");
      expect(tiny?.skipReason).not.toBe("triaged_out");
    },
    TIMEOUT_MS,
  );
});

// ── INTEGRATION: telemetry aggregation (AC4) ────────────────────────────────────

describe("akmExtract — triage telemetry aggregation (AC4)", () => {
  test(
    "mixed batch → exactly ONE extract_triaged event with counts-only metadata",
    async () => {
      const { harness } = makeHarness([
        { id: "low-1", events: lowSignalEvents() },
        { id: "low-2", events: lowSignalEvents() },
        { id: "low-3", events: lowSignalEvents() },
        { id: "high-1", events: highSignalEvents() },
        { id: "high-2", events: highSignalEvents() },
      ]);
      const spy = makeChatSpy();

      const result = await akmExtract({
        type: HARNESS,
        stashDir: storage.stashDir,
        config: makeConfig({ enabled: true }),
        skipTracking: true,
        harnesses: [harness],
        sourceRun: "run-triage-agg",
        chat: spy.chat as never,
      });

      expect(result.ok).toBe(true);
      // Only the two high-signal sessions reach the LLM.
      expect(spy.calls()).toBe(2);

      const events = triagedEvents();
      expect(events).toHaveLength(1);
      const meta = events[0]?.metadata ?? {};
      expect(meta.evaluated).toBe(5);
      expect(meta.passed).toBe(2);
      expect(meta.triagedOut).toBe(3);
      expect(meta.sourceRun).toBe("run-triage-agg");

      // Counts-only: no per-session triage events exist.
      const perSession = readEvents({ type: "extract_triaged" }).events.filter(
        (e) => "sessionId" in (e.metadata ?? {}),
      );
      expect(perSession).toHaveLength(0);
    },
    TIMEOUT_MS,
  );
});

describe("akmExtract — triage telemetry suppressed when disabled", () => {
  test(
    "triage disabled → NO extract_triaged event emitted",
    async () => {
      const { harness } = makeHarness([{ id: "s-low", events: lowSignalEvents() }]);
      const spy = makeChatSpy();

      await akmExtract({
        type: HARNESS,
        stashDir: storage.stashDir,
        config: makeConfig({ enabled: false }),
        skipTracking: true,
        harnesses: [harness],
        chat: spy.chat as never,
      });

      expect(triagedEvents()).toHaveLength(0);
    },
    TIMEOUT_MS,
  );
});

// ── UNIT: config schema round-trip ──────────────────────────────────────────────

describe("triage config — saveConfig/loadConfig round-trip", () => {
  test("processes.extract.triage survives save → load", () => {
    saveConfig({
      semanticSearchMode: "off",
      profiles: {
        improve: {
          default: {
            processes: {
              extract: { enabled: true, triage: { enabled: true, minScore: 4 } },
            },
          },
        },
      },
    } as unknown as AkmConfig);

    const loaded = loadConfig();
    const triage = loaded.profiles?.improve?.default?.processes?.extract?.triage as
      | { enabled?: boolean; minScore?: number }
      | undefined;
    expect(triage?.enabled).toBe(true);
    expect(triage?.minScore).toBe(4);
  });
});
