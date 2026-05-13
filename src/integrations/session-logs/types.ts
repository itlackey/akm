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

export interface SessionLogHarness {
  readonly name: string;
  /** Return true if this harness's log files exist on this machine */
  isAvailable(): boolean;
  /** Read raw session events since the given timestamp */
  readEvents(input: { sinceMs: number }): Iterable<SessionEvent>;
}
