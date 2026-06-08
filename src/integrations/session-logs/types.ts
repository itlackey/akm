// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export interface SessionLogEntry {
  /** Human-readable topic or error pattern found */
  topic: string;
  /** How many times this pattern appeared in recent sessions */
  frequency: number;
  /** Source harness that produced this entry */
  source: string;
  /** Whether this looks like a repeated failure (vs a normal topic) */
  isFailurePattern: boolean;
}

export interface SessionEvent {
  harness: string;
  text: string;
  ts?: number;
  sessionId?: string;
  role?: "user" | "assistant" | "system" | "tool" | "unknown";
  filePath?: string;
}

/**
 * Lightweight handle for a single session — enough to fetch full event data
 * via {@link SessionLogHarness.readSession} without parsing every event up
 * front. Used by the extractor pipeline + the `akm extract` CLI.
 */
export interface SessionRef {
  /** Harness name that produced this ref (e.g. `"claude-code"`, `"opencode"`). */
  harness: string;
  /** Platform-native session identifier. */
  sessionId: string;
  /** Primary on-disk path for this session (parser entry point). */
  filePath: string;
}

/**
 * Per-session metadata returned by {@link SessionLogHarness.listSessions}.
 * Extends {@link SessionRef} with cheap-to-derive metadata so callers can
 * filter / sort sessions without paying the cost of reading every event.
 */
export interface SessionSummary extends SessionRef {
  /** Session start in ms epoch (from first event or file ctime). */
  startedAt?: number;
  /** Session end in ms epoch (from last event or file mtime). */
  endedAt?: number;
  /** Platform-specific project hint (claude-code: project dir; opencode: working dir). */
  projectHint?: string;
  /** Human-readable session title when the platform provides one. */
  title?: string;
}

/**
 * Inline AKM invocation the agent made during the session — used by the
 * extractor to detect "this is already preserved, don't re-extract" without
 * needing to compare against the full stash.
 */
export interface InlineRefMention {
  kind: "remember" | "feedback";
  /** Asset ref (for `feedback`) or remember name/slug (for `remember`). */
  ref?: string;
  /** Note / body text the agent passed to the command. */
  text: string;
  /** Event timestamp (ms epoch) when the invocation happened. */
  ts?: number;
}

/**
 * Full read of one session, returned by {@link SessionLogHarness.readSession}.
 * Events are time-ordered; `inlineRefs` is extracted up-front so downstream
 * code doesn't have to re-scan the event stream.
 */
export interface SessionData {
  ref: SessionSummary;
  events: SessionEvent[];
  inlineRefs: InlineRefMention[];
}

export interface SessionLogHarness {
  readonly name: string;
  /** Return true if this harness's log files exist on this machine */
  isAvailable(): boolean;
  /**
   * Whether this harness exposes the rich `listSessions()` + `readSession()`
   * pipeline (structured tool calls, assistant content blocks, timing) for the
   * health-advisory candidate scan (#568). When `true` (or absent — see below),
   * `getExecutionLogCandidates` drives the harness through `listSessions()` +
   * `readSession()` so structured content reaches health advisories. When
   * `false`, it falls back to the legacy flat {@link readEvents} scan.
   *
   * Absent is treated as `true`: every harness in this codebase implements a
   * real `readSession`, and a legacy-only harness must OPT OUT explicitly by
   * setting this to `false`. This keeps behaviour-preserving for any future
   * harness that only implements `readEvents`.
   */
  readonly supportsReadSession?: boolean;
  /**
   * Read raw session events since the given timestamp.
   *
   * @deprecated (#568) Prefer the richer {@link listSessions} + {@link readSession}
   * pipeline, which preserves structured message content (tool calls, assistant
   * content blocks, timing) instead of the flat text scan. `readEvents` remains
   * only as the fallback path for legacy harnesses that set
   * {@link supportsReadSession} to `false`.
   */
  readEvents(input: { sinceMs: number }): Iterable<SessionEvent>;
  /**
   * Enumerate available sessions for this harness, optionally filtered by
   * staleness (`sinceMs`) and overriding the default location. Cheap — does
   * not parse event content. Sessions whose file mtime is older than
   * `sinceMs` (when provided) are omitted.
   */
  listSessions(input?: { sinceMs?: number; location?: string }): SessionSummary[];
  /**
   * Read a single session's full event stream + the inline `akm remember`/
   * `akm feedback` invocations the agent made during it. `ref.filePath` must
   * point at a file this harness can parse — call {@link listSessions} first
   * to obtain a valid ref.
   */
  readSession(ref: SessionRef): SessionData;
}
