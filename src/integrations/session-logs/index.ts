import { ClaudeCodeProvider } from "./providers/claude-code";
import { OpenCodeProvider } from "./providers/opencode";
import type { SessionEvent, SessionLogEntry, SessionLogHarness } from "./types";

export type { SessionEvent, SessionLogEntry, SessionLogHarness };

const HARNESSES: SessionLogHarness[] = [new ClaudeCodeProvider(), new OpenCodeProvider()];
const ERROR_PATTERNS = /error|failed|exception|cannot|undefined|null pointer|ENOENT|timeout/i;

/**
 * Returns all available session log harnesses for the current machine.
 * Add new harnesses to HARNESSES to support additional agent runtimes.
 */
export function getAvailableHarnesses(): SessionLogHarness[] {
  return HARNESSES.filter((harness) => harness.isAvailable());
}

export function normalizeSessionTopic(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized.length < 10) return undefined;
  return normalized.slice(0, 60);
}

export function aggregateSessionEvents(events: Iterable<SessionEvent>): SessionLogEntry[] {
  const counts = new Map<string, { count: number; isFailurePattern: boolean; sources: Set<string>; topic: string }>();

  for (const event of events) {
    const topic = normalizeSessionTopic(event.text);
    if (!topic) continue;
    const isFailurePattern = ERROR_PATTERNS.test(topic);
    if (!isFailurePattern) continue;

    const existing = counts.get(topic) ?? {
      count: 0,
      isFailurePattern,
      sources: new Set<string>(),
      topic,
    };
    existing.count += 1;
    existing.isFailurePattern = existing.isFailurePattern || isFailurePattern;
    existing.sources.add(event.harness);
    counts.set(topic, existing);
  }

  return [...counts.values()]
    .filter((entry) => entry.count >= 2)
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
    .slice(0, 15)
    .map((entry) => ({
      topic: entry.topic,
      frequency: entry.count,
      source: [...entry.sources].sort().join(","),
      isFailurePattern: entry.isFailurePattern,
    }));
}

/**
 * Scan recent session logs from all available harnesses and return
 * repeated failure patterns that might warrant new AKM assets.
 */
export function getExecutionLogCandidates(sinceDays = 7): SessionLogEntry[] {
  const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const events: SessionEvent[] = [];
  for (const harness of getAvailableHarnesses()) {
    try {
      events.push(...harness.readEvents({ sinceMs }));
    } catch {
      // individual harness failures are non-fatal
    }
  }
  return aggregateSessionEvents(events);
}
