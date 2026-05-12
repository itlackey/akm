import { ClaudeCodeProvider } from "./providers/claude-code";
import { OpenCodeProvider } from "./providers/opencode";
import type { SessionLogEntry, SessionLogProvider } from "./types";

export type { SessionLogEntry, SessionLogProvider };

const PROVIDERS: SessionLogProvider[] = [new ClaudeCodeProvider(), new OpenCodeProvider()];

/**
 * Returns all available session log providers for the current machine.
 * Add new providers to PROVIDERS to support additional harnesses.
 */
export function getAvailableProviders(): SessionLogProvider[] {
  return PROVIDERS.filter((p) => p.isAvailable());
}

/**
 * Scan recent session logs from all available harnesses and return
 * repeated failure patterns that might warrant new AKM assets.
 */
export function getExecutionLogCandidates(sinceDays = 7): SessionLogEntry[] {
  const entries: SessionLogEntry[] = [];
  for (const provider of getAvailableProviders()) {
    try {
      entries.push(...provider.getRecentTopics(sinceDays));
    } catch {
      // individual provider failures are non-fatal
    }
  }
  // De-duplicate across providers, sort by frequency descending
  return entries.sort((a, b) => b.frequency - a.frequency).slice(0, 15);
}
