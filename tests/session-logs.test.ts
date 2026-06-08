import { describe, expect, test } from "bun:test";

import { aggregateSessionEvents, collectSessionEvents, normalizeSessionTopic } from "../src/integrations/session-logs";
import type {
  SessionData,
  SessionEvent,
  SessionLogHarness,
  SessionSummary,
} from "../src/integrations/session-logs/types";

describe("session log aggregation", () => {
  test("normalizes topic text into a shared aggregation key", () => {
    expect(normalizeSessionTopic("  Error: build failed on deploy   ")).toBe("error: build failed on deploy");
  });

  test("deduplicates repeated failure patterns across harnesses", () => {
    const events: SessionEvent[] = [
      { harness: "claude-code", text: "Error: build failed on deploy" },
      { harness: "opencode", text: "error: build failed on deploy" },
      { harness: "opencode", text: "error: build failed on deploy" },
      { harness: "claude-code", text: "all good now" },
    ];

    const entries = aggregateSessionEvents(events);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      topic: "error: build failed on deploy",
      frequency: 3,
      source: "claude-code,opencode",
      isFailurePattern: true,
    });
  });

  test("collectSessionEvents falls back to readEvents for legacy-only harnesses", () => {
    // A legacy-only harness opts out of readSession via supportsReadSession:false
    // and MUST keep working off the flat readEvents scan (behaviour-preserving).
    const legacyHarness: SessionLogHarness = {
      name: "legacy",
      supportsReadSession: false,
      isAvailable: () => true,
      *readEvents() {
        yield { harness: "legacy", text: "timeout while syncing repo" };
        yield { harness: "legacy", text: "timeout while syncing repo" };
      },
      // listSessions/readSession would surface different data — assert they are
      // NOT consulted for a legacy-only harness.
      listSessions: () => {
        throw new Error("listSessions must not be called for supportsReadSession:false");
      },
      readSession: () => {
        throw new Error("readSession must not be called for supportsReadSession:false");
      },
    };

    const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const entries = aggregateSessionEvents(collectSessionEvents([legacyHarness], sinceMs));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.topic).toBe("timeout while syncing repo");
    expect(entries[0]?.frequency).toBe(2);
    expect(entries[0]?.source).toBe("legacy");
  });

  test("collectSessionEvents surfaces structured readSession content to the candidate path (#568)", () => {
    // The richer readSession pipeline exposes structured tool-call content that
    // the legacy flat readEvents scan dropped. Here readEvents yields only a
    // single bland line (no failure pattern), while readSession yields the
    // structured `[tool_result]` blocks that reveal a repeated failure. Promoting
    // the pipeline to readSession is what makes the failure pattern visible to
    // health advisories — that is the behaviour #568 fixes.
    const summaries: SessionSummary[] = [
      { harness: "rich", sessionId: "s1", filePath: "/sessions/s1.jsonl", endedAt: 2 },
    ];
    const richSession: SessionData = {
      ref: summaries[0] as SessionSummary,
      events: [
        { harness: "rich", text: "[tool_result] error: deploy step failed", role: "tool" },
        { harness: "rich", text: "[tool_result] error: deploy step failed", role: "tool" },
      ],
      inlineRefs: [],
    };
    const richHarness: SessionLogHarness = {
      name: "rich",
      // supportsReadSession omitted ⇒ treated as readSession-capable.
      isAvailable: () => true,
      // Legacy scan loses the structured tool content — only a bland status line.
      *readEvents() {
        yield { harness: "rich", text: "session started normally" };
      },
      listSessions: () => summaries,
      readSession: () => richSession,
    };

    const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const entries = aggregateSessionEvents(collectSessionEvents([richHarness], sinceMs));
    // The repeated tool-failure pattern is only present in the readSession data.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.topic).toBe("[tool_result] error: deploy step failed");
    expect(entries[0]?.frequency).toBe(2);
    expect(entries[0]?.isFailurePattern).toBe(true);
    expect(entries[0]?.source).toBe("rich");
  });

  test("collectSessionEvents falls back to readEvents when listSessions is empty", () => {
    // A readSession-capable harness whose listSessions returns nothing on this
    // machine must still contribute via the flat scan — never regress coverage.
    const fallbackHarness: SessionLogHarness = {
      name: "fallback",
      isAvailable: () => true,
      *readEvents() {
        yield { harness: "fallback", text: "exception thrown during build" };
        yield { harness: "fallback", text: "exception thrown during build" };
      },
      listSessions: () => [],
      readSession: (ref) => ({ ref: { ...ref, harness: "fallback" }, events: [], inlineRefs: [] }),
    };

    const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const entries = aggregateSessionEvents(collectSessionEvents([fallbackHarness], sinceMs));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.frequency).toBe(2);
    expect(entries[0]?.source).toBe("fallback");
  });
});
