// Tests for preFilterSession: drop rules + truncation behavior.
// Pure deterministic function — no fs, no LLM, no test seams needed.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AKM_READONLY_OPS,
  DEFAULT_MAX_EVENT_LENGTH,
  preFilterSession,
} from "../src/integrations/session-logs/pre-filter";
import type { SessionData, SessionEvent } from "../src/integrations/session-logs/types";

function makeData(events: SessionEvent[]): SessionData {
  return {
    ref: { harness: "claude-code", sessionId: "test", filePath: "/tmp/test.jsonl" },
    events,
    inlineRefs: [],
  };
}

function event(overrides: Partial<SessionEvent>): SessionEvent {
  return {
    harness: "claude-code",
    text: "default text body that is at least ten characters long",
    ts: 1700000000000,
    sessionId: "test",
    role: "user",
    filePath: "/tmp/test.jsonl",
    ...overrides,
  };
}

describe("preFilterSession — drop rules", () => {
  test("drops events with text under 10 chars", () => {
    const result = preFilterSession(
      makeData([event({ text: "hi" }), event({ text: "short" }), event({ text: "long enough text" })]),
    );
    expect(result.events).toHaveLength(1);
    expect(result.stats.droppedByRule["too-short"]).toBe(2);
  });

  test("drops read-only akm meta-ops via flattened tool_use", () => {
    const result = preFilterSession(
      makeData([
        event({ text: "[tool:Bash] akm show knowledge:foo" }),
        event({ text: "[tool:Bash] akm search 'auth pattern' --type lesson" }),
        event({ text: "[tool:Bash] akm curate 'session extractor'" }),
        event({ text: "[tool:Bash] akm history --include-proposals" }),
        event({ text: "[tool:Bash] akm info" }),
      ]),
    );
    expect(result.events).toHaveLength(0);
    expect(result.stats.droppedByRule["akm-readonly-show"]).toBe(1);
    expect(result.stats.droppedByRule["akm-readonly-search"]).toBe(1);
    expect(result.stats.droppedByRule["akm-readonly-curate"]).toBe(1);
    expect(result.stats.droppedByRule["akm-readonly-history"]).toBe(1);
    expect(result.stats.droppedByRule["akm-readonly-info"]).toBe(1);
  });

  test("keeps mutating akm commands (remember, feedback, accept, reject, extract, import)", () => {
    const events = [
      event({ text: `[tool:Bash] akm remember "VPN needed before deploy"` }),
      event({ text: `[tool:Bash] akm feedback knowledge:auth --positive --note "saved time"` }),
      event({ text: "[tool:Bash] akm accept abc123" }),
      event({ text: "[tool:Bash] akm reject xyz789 --reason 'duplicate'" }),
      event({ text: "[tool:Bash] akm extract --type claude-code --session-id foo" }),
      event({ text: "[tool:Bash] akm import ./doc.md" }),
    ];
    const result = preFilterSession(makeData(events));
    expect(result.events).toHaveLength(events.length);
  });

  test("matches akm verb even when prose surrounds it", () => {
    const result = preFilterSession(
      makeData([
        event({ text: "agent's response: I'll run akm show knowledge:foo to check the existing asset content" }),
      ]),
    );
    expect(result.events).toHaveLength(0);
    expect(result.stats.droppedByRule["akm-readonly-show"]).toBe(1);
  });

  test("drops claude-code local-command-caveat preamble", () => {
    const result = preFilterSession(
      makeData([
        event({
          text: "<local-command-caveat>Caveat: messages below were generated locally and should not be considered.</local-command-caveat>",
        }),
      ]),
    );
    expect(result.events).toHaveLength(0);
    expect(Object.keys(result.stats.droppedByRule).some((r) => r.startsWith("noise-pattern-"))).toBe(true);
  });

  test("drops post-compact analysis/summary XML dumps", () => {
    const longAnalysis = `<analysis>${"this is a long analysis paste ".repeat(20)}</analysis>`;
    const result = preFilterSession(makeData([event({ text: longAnalysis })]));
    expect(result.events).toHaveLength(0);
  });

  test("drops short system-role boilerplate events", () => {
    const result = preFilterSession(
      makeData([event({ role: "system", text: "<system-reminder>Use the TaskCreate tool.</system-reminder>" })]),
    );
    expect(result.events).toHaveLength(0);
  });

  test("keeps system events that look substantive", () => {
    const substantive = `system: deploy pipeline completed with these results: ${"real content ".repeat(40)}`;
    const result = preFilterSession(makeData([event({ role: "system", text: substantive })]));
    expect(result.events).toHaveLength(1);
  });

  test("drops opencode tool-event aggregate dumps", () => {
    const aggregate = Array.from({ length: 6 }, (_, i) => `## 2026-05-23T0${i}:00:00Z — akm_search unknown`).join("\n");
    const result = preFilterSession(makeData([event({ text: aggregate })]));
    expect(result.events).toHaveLength(0);
  });
});

describe("preFilterSession — truncation", () => {
  test("truncates events whose text exceeds the max length", () => {
    const longText = "x".repeat(DEFAULT_MAX_EVENT_LENGTH + 1000);
    const result = preFilterSession(makeData([event({ text: longText })]));
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.text.length).toBeLessThanOrEqual(DEFAULT_MAX_EVENT_LENGTH);
    expect(result.events[0]?.text).toContain("[truncated");
    expect(result.stats.truncatedCount).toBe(1);
  });

  test("does not truncate events at the limit", () => {
    const exactText = "y".repeat(DEFAULT_MAX_EVENT_LENGTH);
    const result = preFilterSession(makeData([event({ text: exactText })]));
    expect(result.events[0]?.text.length).toBe(DEFAULT_MAX_EVENT_LENGTH);
    expect(result.stats.truncatedCount).toBe(0);
  });

  test("honors a custom maxEventTextLength", () => {
    const text = "x".repeat(500);
    const result = preFilterSession(makeData([event({ text })]), { maxEventTextLength: 200 });
    expect(result.events[0]?.text.length).toBeLessThanOrEqual(200);
    expect(result.stats.truncatedCount).toBe(1);
  });
});

describe("preFilterSession — stats", () => {
  test("reports input + output counts", () => {
    const events = [
      event({ text: "real engineering content goes here in this body" }),
      event({ text: "[tool:Bash] akm show foo" }), // dropped
      event({ text: "another substantive event with engineering content" }),
    ];
    const result = preFilterSession(makeData(events));
    expect(result.stats.inputCount).toBe(3);
    expect(result.stats.outputCount).toBe(2);
  });

  test("returns no drops when input is all clean signal", () => {
    const result = preFilterSession(
      makeData([event({ text: "user asks: please refactor the auth module to handle the case described above" })]),
    );
    expect(result.stats.droppedByRule).toEqual({});
    expect(result.stats.outputCount).toBe(1);
  });
});

describe("preFilterSession — total-character budget", () => {
  test("drops oldest events when running total would exceed maxTotalChars", () => {
    // 5 events × 1000 chars each = 5000. With maxTotalChars=2500, only the
    // most recent 2-3 should survive.
    const events = Array.from({ length: 5 }, (_, i) =>
      event({ text: "x".repeat(1000), ts: 1700000000000 + i * 60_000 }),
    );
    const result = preFilterSession(makeData(events), { maxTotalChars: 2500 });
    expect(result.events.length).toBeLessThanOrEqual(3);
    expect(result.stats.totalChars).toBeLessThanOrEqual(2500);
    expect(result.stats.budgetDroppedCount).toBeGreaterThanOrEqual(2);
    // Recency bias: the LAST event must always survive (highest signal density).
    expect(result.events.at(-1)?.ts).toBe(events.at(-1)?.ts);
  });

  test("preserves timestamp order in the output even when dropping from the head", () => {
    const events = [
      event({ text: "old".padEnd(500, "."), ts: 100 }),
      event({ text: "mid".padEnd(500, "."), ts: 200 }),
      event({ text: "new".padEnd(500, "."), ts: 300 }),
    ];
    const result = preFilterSession(makeData(events), { maxTotalChars: 1100 });
    // Should keep at least the newest two
    const timestamps = result.events.map((e) => e.ts);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });

  test("when all events fit in budget, none are budget-dropped", () => {
    const events = Array.from({ length: 3 }, (_, i) => event({ text: "x".repeat(500), ts: i }));
    const result = preFilterSession(makeData(events), { maxTotalChars: 10_000 });
    expect(result.events).toHaveLength(3);
    expect(result.stats.budgetDroppedCount).toBe(0);
  });

  test("always keeps at least the most recent event even if it exceeds the budget", () => {
    // Single huge event larger than the budget — keep it anyway so the LLM
    // never sees an empty transcript.
    const huge = event({ text: "x".repeat(5000), ts: 100 });
    const result = preFilterSession(makeData([huge]), { maxTotalChars: 1000 });
    expect(result.events).toHaveLength(1);
  });

  test("stats.totalChars matches the sum of kept event text lengths", () => {
    const events = [event({ text: "a".repeat(200) }), event({ text: "b".repeat(300) })];
    const result = preFilterSession(makeData(events), { maxTotalChars: 10_000 });
    expect(result.stats.totalChars).toBe(500);
  });
});

describe("preFilterSession — custom options", () => {
  test("custom akmReadOnlyOps lets the caller broaden what counts as noise", () => {
    // Treat `remember` as read-only too (just for this test) and confirm it
    // gets dropped while the default behavior would keep it.
    const customOps = new Set([...DEFAULT_AKM_READONLY_OPS, "remember"]);
    const e = event({ text: `[tool:Bash] akm remember "test"` });
    const defaultResult = preFilterSession(makeData([e]));
    expect(defaultResult.events).toHaveLength(1);
    const customResult = preFilterSession(makeData([e]), { akmReadOnlyOps: customOps });
    expect(customResult.events).toHaveLength(0);
  });
});
