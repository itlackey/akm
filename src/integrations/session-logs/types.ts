export interface SessionLogEntry {
  /** Human-readable topic or error pattern found */
  topic: string;
  /** How many times this pattern appeared in recent sessions */
  frequency: number;
  /** Source harness that produced this entry */
  source: "claude-code" | "opencode";
  /** Whether this looks like a repeated failure (vs a normal topic) */
  isFailurePattern: boolean;
}

export interface SessionLogProvider {
  readonly name: "claude-code" | "opencode";
  /** Return true if this provider's log files exist on this machine */
  isAvailable(): boolean;
  /** Scan recent session logs (last `sinceDays` days) for topics and failure patterns */
  getRecentTopics(sinceDays: number): SessionLogEntry[];
}
