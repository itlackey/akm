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
    ref: { harness: "claude", sessionId: "test", filePath: "/tmp/test.jsonl" },
    events,
    inlineRefs: [],
  };
}

function event(overrides: Partial<SessionEvent>): SessionEvent {
  return {
    harness: "claude",
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
        event({ text: "[tool:Bash] akm show knowledge/foo" }),
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

  test("drops the akm plugin's read tools and keeps its writes (#1577)", () => {
    const result = preFilterSession(
      makeData([
        event({ text: '[tool:akm_search] {"query":"deploy pipeline"}' }),
        event({ text: '[tool:akm_show] {"ref":"knowledge/deploy"}' }),
        event({ text: '[tool:akm_curate] {"query":"deploy pipeline"}' }),
        event({ text: '[tool:akm_remember] {"content":"Staging deploys need the corp VPN cert"}' }),
        event({ text: '[tool:akm_feedback] {"ref":"knowledge/deploy","note":"the rollback section is current"}' }),
      ]),
    );
    expect(result.events.map((e) => e.text)).toEqual([
      '[tool:akm_remember] {"content":"Staging deploys need the corp VPN cert"}',
      '[tool:akm_feedback] {"ref":"knowledge/deploy","note":"the rollback section is current"}',
    ]);
    expect(result.stats.droppedByRule["akm-readonly-search"]).toBe(1);
    expect(result.stats.droppedByRule["akm-readonly-show"]).toBe(1);
    expect(result.stats.droppedByRule["akm-readonly-curate"]).toBe(1);
  });

  test("keeps mutating akm commands (remember, feedback, accept, reject, extract, import)", () => {
    const events = [
      event({ text: `[tool:Bash] akm remember "VPN needed before deploy"` }),
      event({ text: `[tool:Bash] akm feedback knowledge/auth --positive --note "saved time"` }),
      event({ text: "[tool:Bash] akm accept abc123" }),
      event({ text: "[tool:Bash] akm reject xyz789 --reason 'duplicate'" }),
      event({ text: "[tool:Bash] akm extract --type claude --session-id foo" }),
      event({ text: "[tool:Bash] akm import ./doc.md" }),
    ];
    const result = preFilterSession(makeData(events));
    expect(result.events).toHaveLength(events.length);
  });

  test("matches akm verb even when prose surrounds it", () => {
    const result = preFilterSession(
      makeData([
        event({ text: "agent's response: I'll run akm show knowledge/foo to check the existing asset content" }),
      ]),
    );
    expect(result.events).toHaveLength(0);
    expect(result.stats.droppedByRule["akm-readonly-show"]).toBe(1);
  });

  test("drops claude local-command-caveat preamble", () => {
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

describe("preFilterSession — subagent task-notification dedupe (#839)", () => {
  // A subagent transcript's folded final event, as #830's `readSession` stamps
  // it: provenance prefix + the subagent's own last message.
  const subagentFinalText =
    "[subagent:general-purpose] Verify V28+V32: dead surface\n" +
    'Verdict: CONFIRMED -> zero live callers found via grep across src/tests. {"ok":true}';
  const subagentEvent = event({
    role: "assistant",
    text: subagentFinalText,
    ts: 1700000000000,
    filePath: "/proj/session-1/subagents/agent-a4f581608db6e05b1.jsonl",
  });

  function notification(resultBody: string, opts: { taskId?: string; summary?: string } = {}): SessionEvent {
    const taskId = opts.taskId ?? "a4f581608db6e05b1";
    const summary = opts.summary ?? 'Agent "Verify V28+V32: dead surface" finished';
    return event({
      role: "user",
      ts: 1700000001000,
      filePath: "/proj/session-1.jsonl",
      text:
        `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n` +
        `<status>completed</status>\n<summary>${summary}</summary>\n<result>${resultBody}</result>\n</task-notification>`,
    });
  }

  test("stubs a notification whose <result> duplicates the folded subagent's final message", () => {
    // The <result> body is what Claude Code actually writes: the subagent's own
    // final text, XML-entity-escaped (its `->` becomes `-&gt;`), with no
    // provenance prefix (that's #830's own stamp, added only on the folded copy).
    const resultBody = 'Verdict: CONFIRMED -&gt; zero live callers found via grep across src/tests. {"ok":true}';
    const events = [subagentEvent, notification(resultBody)];
    const result = preFilterSession(makeData(events));

    expect(result.events).toHaveLength(2); // event is stubbed, not dropped
    const stubbed = result.events.find((e) => e.role === "user");
    expect(stubbed?.text).toBe("[subagent a4f581608db6e05b1 completed: Verify V28+V32: dead surface]");
    // The subagent's own original is untouched.
    const original = result.events.find((e) => e.role === "assistant");
    expect(original?.text).toBe(subagentFinalText);
  });

  test("does not stub a notification with no <result> (e.g. a background-command notification)", () => {
    const bgNotification = event({
      role: "user",
      filePath: "/proj/session-1.jsonl",
      text:
        "<task-notification>\n<task-id>b0pvowrru</task-id>\n<status>completed</status>\n" +
        '<summary>Background command "Run tests" completed (exit code 0)</summary>\n</task-notification>',
    });
    const result = preFilterSession(makeData([subagentEvent, bgNotification]));
    const kept = result.events.find((e) => e.role === "user");
    expect(kept?.text).toBe(bgNotification.text);
  });

  test("does not stub when the <result> genuinely differs, even for the same <task-id> (resumed-agent false positive)", () => {
    // Claude Code's own note: "A task-notification fires each time this agent
    // stops ... the same task-id may notify more than once." An earlier
    // notification for a resumed agent can carry a different, intermediate
    // result — that must survive untouched.
    const intermediateResult = "Still investigating V28a, no verdict yet. Continuing to grep for callers.";
    const events = [subagentEvent, notification(intermediateResult)];
    const result = preFilterSession(makeData(events));
    const kept = result.events.find((e) => e.role === "user");
    expect(kept?.text).toContain("<result>Still investigating");
  });

  test("does not stub when the <task-id> names no folded subagent transcript", () => {
    const events = [subagentEvent, notification("some unrelated result text here", { taskId: "not-a-real-agent" })];
    const result = preFilterSession(makeData(events));
    const kept = result.events.find((e) => e.role === "user");
    expect(kept?.text).toContain("<task-id>not-a-real-agent</task-id>");
  });

  test("is a no-op when the session has no folded subagent events at all", () => {
    const resultBody = "anything";
    const events = [notification(resultBody)];
    const result = preFilterSession(makeData(events));
    expect(result.events[0]?.text).toContain("<task-notification>");
  });

  test("does not stub when the subagent's own event was evicted by the budget cap (#840 hazard)", () => {
    // The recency-biased budget can (and per #840's measurement, usually does)
    // evict one side of a raw duplicate pair before dedupe ever runs. If the
    // NOTIFICATION survives but the subagent's own (older) event does not,
    // stubbing the notification would delete the only surviving trace of that
    // delegated work — exactly the hazard #840's design doc flags for any
    // future prompt-composition design where the subagent's own copy is never
    // in the prompt at all. The dedupe must be a no-op here.
    const resultBody = 'Verdict: CONFIRMED -&gt; zero live callers found via grep across src/tests. {"ok":true}';
    const notif = notification(resultBody);
    const events = [subagentEvent, notif]; // subagentEvent is OLDER (ts 1700000000000 < 1700000001000)
    // Budget just barely fits the (newer) notification alone — the older
    // subagent event gets evicted by the recency-biased budget pass.
    const tightBudget = notif.text.length + 10;
    const result = preFilterSession(makeData(events), { maxTotalChars: tightBudget });

    expect(result.events).toHaveLength(1);
    expect(result.stats.budgetDroppedCount).toBe(1);
    // The notification survives UNSTUBBED — its would-be duplicate never made it into this kept set.
    expect(result.events[0]?.text).toBe(notif.text);
    expect(result.events[0]?.text).toContain("<task-notification>");
  });

  test("does not stub when the subagent's own event was dropped by a per-event rule (not merely evicted)", () => {
    // Same hazard as the budget case, via a different exclusion path: the
    // subagent's folded event is dropped by an ordinary per-event rule
    // (too-short) rather than the budget cap. Either way, if the subagent's
    // own copy isn't in the kept set, the notification must survive untouched.
    const resultBody = 'Verdict: CONFIRMED -&gt; zero live callers found via grep across src/tests. {"ok":true}';
    const tooShortSubagentEvent = event({
      role: "assistant",
      text: "hi", // under the 10-char floor — dropped by classifyEvent's "too-short" rule
      filePath: "/proj/session-1/subagents/agent-a4f581608db6e05b1.jsonl",
    });
    const result = preFilterSession(makeData([tooShortSubagentEvent, notification(resultBody)]));

    expect(result.events).toHaveLength(1); // the too-short subagent event was dropped, not just the notification stubbed
    expect(result.events[0]?.text).toContain("<task-notification>");
  });

  test("falls back to a generic stub when the notification has no <summary>", () => {
    const resultBody = 'Verdict: CONFIRMED -&gt; zero live callers found via grep across src/tests. {"ok":true}';
    const noSummary = event({
      role: "user",
      filePath: "/proj/session-1.jsonl",
      text:
        "<task-notification>\n<task-id>a4f581608db6e05b1</task-id>\n<status>completed</status>\n" +
        `<result>${resultBody}</result>\n</task-notification>`,
    });
    const result = preFilterSession(makeData([subagentEvent, noSummary]));
    const stubbed = result.events.find((e) => e.role === "user");
    expect(stubbed?.text).toBe("[subagent a4f581608db6e05b1 completed: completed]");
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
