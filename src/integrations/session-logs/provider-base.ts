// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared skeleton for {@link SessionLogHarness} providers (§4.6 dedup).
 *
 * Holds only what the concrete providers genuinely share: safe stat'ing,
 * recursive directory walking, the mtime-filtered file→summary listing loop,
 * the flat JSONL/log line→event scan, and conditional-spread assembly of
 * {@link SessionSummary} refs stamped with the provider's runtime name.
 * Everything platform-specific — file layouts, metadata peeking, SQLite
 * stores, message flattening — stays in the subclasses.
 */

import fs from "node:fs";
import path from "node:path";
import type { SessionData, SessionEvent, SessionLogHarness, SessionRef, SessionSummary } from "./types";

/**
 * Loosely-typed shape of one parsed log/JSONL entry as probed by the flat
 * {@link AbstractSessionLogProvider.logLineEvents} scan. Every property is
 * checked defensively at runtime — the type exists only so per-provider
 * selectors can express their field fallbacks without casts.
 */
export interface LooseLogEntry {
  message?: { content?: unknown };
  content?: unknown;
  text?: unknown;
  timestamp?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  role?: unknown;
}

export abstract class AbstractSessionLogProvider implements SessionLogHarness {
  /** Runtime identity stamped onto every emitted event/ref. */
  abstract readonly name: string;

  /** Root whose existence signals this harness has logs on this machine. */
  protected abstract availabilityRoot(): string;

  abstract watchRoots(): string[];
  abstract readEvents(input: { sinceMs: number }): Iterable<SessionEvent>;
  abstract listSessions(input?: { sinceMs?: number; location?: string }): SessionSummary[];
  abstract readSession(ref: SessionRef): SessionData;

  isAvailable(): boolean {
    return fs.existsSync(this.availabilityRoot());
  }

  /** `fs.statSync` that returns `undefined` instead of throwing. */
  protected statSafe(target: string): fs.Stats | undefined {
    try {
      return fs.statSync(target);
    } catch {
      return undefined;
    }
  }

  /** Recursively yield files under `dir` whose basename passes `matches`. */
  protected *walkFiles(dir: string, matches: (fileName: string) => boolean): Generator<string> {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* this.walkFiles(full, matches);
        else if (matches(entry.name)) yield full;
      }
    } catch {
      // permission errors etc.
    }
  }

  /**
   * Assemble a {@link SessionSummary} stamped with this provider's name.
   * Timestamps are included whenever defined (0 is valid); `projectHint` /
   * `title` only when non-empty, so absent metadata stays absent.
   */
  protected sessionRef(input: {
    sessionId: string;
    filePath: string;
    startedAt?: number;
    endedAt?: number;
    projectHint?: string;
    title?: string;
  }): SessionSummary {
    return {
      harness: this.name,
      sessionId: input.sessionId,
      filePath: input.filePath,
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
      ...(input.projectHint ? { projectHint: input.projectHint } : {}),
      ...(input.title ? { title: input.title } : {}),
    };
  }

  /**
   * The shared listing loop: enumerate candidate session files, drop the
   * unstat'able and the ones older than `sinceMs`, summarize the rest, and
   * sort newest-ended first. An enumeration failure (root missing or
   * unreadable) returns what was collected so far rather than throwing.
   */
  protected listSessionsFromFiles(input: {
    sinceMs: number;
    enumerate: () => Iterable<string>;
    summarize: (filePath: string, stat: fs.Stats) => SessionSummary | undefined;
  }): SessionSummary[] {
    const summaries: SessionSummary[] = [];
    try {
      for (const filePath of input.enumerate()) {
        const stat = this.statSafe(filePath);
        if (!stat) continue;
        if (stat.mtimeMs < input.sinceMs) continue;
        const summary = input.summarize(filePath, stat);
        if (summary) summaries.push(summary);
      }
    } catch {
      // Root missing or unreadable — return what we have.
    }
    return summaries.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  }

  /**
   * The legacy flat line scan shared by both providers' `readEvents`: parse
   * each line as JSON, pull text/session-id through the per-provider
   * selectors, skip entries whose text is missing or under 10 chars, and
   * fall back to the file mtime when the entry carries no numeric timestamp.
   */
  protected *logLineEvents(input: {
    lines: Iterable<string>;
    filePath: string;
    fallbackTsMs: number;
    selectText: (entry: LooseLogEntry | undefined) => unknown;
    selectSessionId: (entry: LooseLogEntry | undefined) => unknown;
  }): Generator<SessionEvent> {
    for (const line of input.lines) {
      try {
        const entry = JSON.parse(line) as LooseLogEntry | undefined;
        const text = input.selectText(entry);
        if (typeof text !== "string" || text.length < 10) continue;
        const sessionId = input.selectSessionId(entry);
        yield {
          harness: this.name,
          text,
          ts: typeof entry?.timestamp === "number" ? entry.timestamp : input.fallbackTsMs,
          sessionId: typeof sessionId === "string" ? sessionId : undefined,
          role: typeof entry?.role === "string" ? (entry.role as SessionEvent["role"]) : "unknown",
          filePath: input.filePath,
        };
      } catch {
        // skip malformed lines
      }
    }
  }
}
