// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { getHarness, SESSION_LOG_HARNESSES } from "../harnesses";
import { ClaudeCodeProvider } from "../harnesses/claude/session-log";
import { OpenCodeProvider } from "../harnesses/opencode/session-log";
import type {
  InlineRefMention,
  SessionData,
  SessionEvent,
  SessionLogEntry,
  SessionLogHarness,
  SessionRef,
  SessionSummary,
} from "./types";

export { extractInlineRefMentions } from "./inline-refs";
export type {
  InlineRefMention,
  SessionData,
  SessionEvent,
  SessionLogEntry,
  SessionLogHarness,
  SessionRef,
  SessionSummary,
};

const HARNESSES: SessionLogHarness[] = [new ClaudeCodeProvider(), new OpenCodeProvider()];

// #562: the unified HARNESS_REGISTRY is the single source of truth for which
// harnesses expose session logs. Validate (behaviour-preserving) that every
// session-log provider instantiated above resolves to a registry harness whose
// `sessionLogs` capability is set — and via the id-normalization bridge, so a
// provider named "claude-code" still maps to the canonical "claude" harness.
// This turns a silently-drifting third registry into a startup invariant.
for (const provider of HARNESSES) {
  const harness = getHarness(provider.name);
  if (!harness?.capabilities.sessionLogs) {
    throw new Error(
      `[akm] session-log provider "${provider.name}" is not registered as a sessionLogs harness in HARNESS_REGISTRY (src/integrations/harnesses). Add it there.`,
    );
  }
}
// Touch the derived list so the dependency is explicit and tree-shake-safe.
void SESSION_LOG_HARNESSES;

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
