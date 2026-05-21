import { describe, expect, test } from "bun:test";

import { aggregateSessionEvents, normalizeSessionTopic } from "../src/integrations/session-logs";
import type { SessionEvent, SessionLogHarness } from "../src/integrations/session-logs/types";

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

  test("getExecutionLogCandidates aggregates from available harnesses only", () => {
    const availableHarness: SessionLogHarness = {
      name: "available",
      isAvailable: () => true,
      *readEvents() {
        yield { harness: "available", text: "timeout while syncing repo" };
        yield { harness: "available", text: "timeout while syncing repo" };
      },
    };
    const unavailableHarness: SessionLogHarness = {
      name: "unavailable",
      isAvailable: () => false,
      *readEvents() {
        yield { harness: "unavailable", text: "error should not appear" };
      },
    };

    const entries = getExecutionLogCandidatesFromHarnesses([availableHarness, unavailableHarness], 7);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.topic).toBe("timeout while syncing repo");
    expect(entries[0]?.frequency).toBe(2);
    expect(entries[0]?.source).toBe("available");
  });
});

function getExecutionLogCandidatesFromHarnesses(harnesses: SessionLogHarness[], sinceDays: number) {
  const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const events: SessionEvent[] = [];
  for (const harness of harnesses) {
    if (!harness.isAvailable()) continue;
    events.push(...harness.readEvents({ sinceMs }));
  }
  return aggregateSessionEvents(events);
}
