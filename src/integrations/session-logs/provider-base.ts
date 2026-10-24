// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared skeleton for {@link SessionLogHarness} providers (§4.6 dedup).
 *
 * Holds only what the concrete providers genuinely share: safe stat'ing,
 * recursive directory walking, the mtime-filtered file→summary listing loop,
 * and conditional-spread assembly of
 * {@link SessionSummary} refs stamped with the provider's runtime name.
 * Everything platform-specific — file layouts, metadata peeking, SQLite
 * stores, message flattening — stays in the subclasses.
 */

import fs from "node:fs";
import path from "node:path";
import type { SessionData, SessionLogHarness, SessionRef, SessionSummary } from "./types";

export abstract class AbstractSessionLogProvider implements SessionLogHarness {
  /** Runtime identity stamped onto every emitted event/ref. */
  abstract readonly name: string;

  /** Root whose existence signals this harness has logs on this machine. */
  protected abstract availabilityRoot(): string;

  abstract listSessions(input?: { sinceMs?: number; location?: string; isolatedSnapshot?: boolean }): SessionSummary[];
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
}
