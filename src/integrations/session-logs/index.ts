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

/**
 * A single harness's watch configuration: the harness's runtime name plus the
 * absolute directories it writes session files under (#606). Harnesses with no
 * roots on this machine are skipped, so every entry has at least one root.
 */
export interface WatchTarget {
  harnessName: string;
  roots: string[];
}

/**
 * Map each available harness to its `{ harnessName, roots }` watch target,
 * skipping harnesses that expose no roots (absent `watchRoots()` or an empty
 * result). This is the one stable entry point the watcher uses so it never
 * reaches into providers directly.
 */
export function getWatchTargets(): WatchTarget[] {
  const targets: WatchTarget[] = [];
  for (const harness of getAvailableHarnesses()) {
    const roots = harness.watchRoots?.() ?? [];
    if (roots.length === 0) continue;
    targets.push({ harnessName: harness.name, roots });
  }
  return targets;
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
 * Collect normalized session events from a set of harnesses for the health
 * candidate scan (#568).
 *
 * Pipeline selection per harness (capability-gated):
 *   - readSession-capable harness (`supportsReadSession !== false`): drive the
 *     richer `listSessions()` + `readSession()` pipeline. `readSession` flattens
 *     structured content — tool calls, assistant content blocks, thinking,
 *     tool_result — into event text (e.g. ClaudeCodeProvider's `parseClaudeEvent`
 *     surfaces `[tool:*]` / `[tool_result]` blocks that the legacy flat
 *     `readEvents` scan drops entirely). This is what lets health advisories see
 *     repeated tool failures / long runs that the flat scan hid.
 *   - legacy-only harness (`supportsReadSession === false`): fall back to the
 *     legacy flat `readEvents()` scan (behaviour-preserving).
 *
 * Extracted as a pure function (harnesses injected) so it is unit-testable
 * without touching the real on-disk session-log locations.
 *
 * `maxSessionsPerHarness` bounds the rich path: `readSession()` reads each
 * session file IN FULL (unlike the legacy flat scan, which only touched files
 * with mtime ≥ sinceMs and skipped non-string content). On a machine with a
 * deep `~/.claude/projects` history a 30-day window can hold hundreds of
 * multi-MB session files, and reading+parsing every one in full made the
 * health command (`akm health`, which calls this synchronously) blow past its
 * latency budget. `listSessions()` returns summaries sorted newest-first, so
 * capping to the most-recent N sessions per harness keeps the richer signal
 * for what actually matters (recent activity) while bounding cost. The legacy
 * flat-scan path is naturally cheaper and is left uncapped.
 */
const DEFAULT_MAX_SESSIONS_PER_HARNESS = 50;

export function collectSessionEvents(
  harnesses: Iterable<SessionLogHarness>,
  sinceMs: number,
  maxSessionsPerHarness = DEFAULT_MAX_SESSIONS_PER_HARNESS,
): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const harness of harnesses) {
    try {
      if (harness.supportsReadSession === false) {
        // Legacy-only harness: only the flat event scan is available.
        events.push(...harness.readEvents({ sinceMs }));
        continue;
      }
      // Rich path: enumerate sessions cheaply, then read each one's full
      // structured event stream. Falls back to readEvents if listSessions
      // surfaces nothing (e.g. a harness that wired readSession but whose
      // listSessions returns empty on this machine) so we never regress
      // coverage relative to the legacy scan.
      const summaries = harness.listSessions({ sinceMs });
      if (summaries.length === 0) {
        events.push(...harness.readEvents({ sinceMs }));
        continue;
      }
      // summaries are newest-first; bound the full-file reads (see doc above).
      for (const summary of summaries.slice(0, maxSessionsPerHarness)) {
        try {
          const session = harness.readSession(summary);
          events.push(...session.events);
        } catch {
          // a single unreadable session is non-fatal
        }
      }
    } catch {
      // individual harness failures are non-fatal
    }
  }
  return events;
}

/**
 * Scan recent session logs from all available harnesses and return
 * repeated failure patterns that might warrant new AKM assets.
 */
export function getExecutionLogCandidates(sinceDays = 7): SessionLogEntry[] {
  const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const events = collectSessionEvents(getAvailableHarnesses(), sinceMs);
  return aggregateSessionEvents(events);
}
