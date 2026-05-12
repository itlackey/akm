import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionLogEntry, SessionLogProvider } from "../types";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const ERROR_PATTERNS = /error|failed|exception|cannot|undefined|null pointer|ENOENT|timeout/i;

export class ClaudeCodeProvider implements SessionLogProvider {
  readonly name = "claude-code" as const;

  isAvailable(): boolean {
    return fs.existsSync(CLAUDE_PROJECTS_DIR);
  }

  getRecentTopics(sinceDays: number): SessionLogEntry[] {
    const since = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
    const topicCounts = new Map<string, { count: number; isFailure: boolean }>();

    try {
      // Walk all .jsonl files under ~/.claude/projects/
      for (const jsonlPath of this.#walkJsonl(CLAUDE_PROJECTS_DIR)) {
        const stat = fs.statSync(jsonlPath);
        if (stat.mtimeMs < since) continue;

        const lines = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            // Look for user messages and assistant messages with errors
            const text = entry?.message?.content ?? entry?.content ?? "";
            if (typeof text !== "string" || text.length < 10) continue;
            // Extract topic: first meaningful noun phrase (naive: first 6 words)
            const topic = text.slice(0, 120).replace(/\n/g, " ").trim();
            const isFailure = ERROR_PATTERNS.test(topic);
            if (isFailure) {
              const key = topic.slice(0, 60).toLowerCase();
              const existing = topicCounts.get(key) ?? { count: 0, isFailure: true };
              topicCounts.set(key, { count: existing.count + 1, isFailure: true });
            }
          } catch {
            // skip malformed lines
          }
        }
      }
    } catch {
      return [];
    }

    return Array.from(topicCounts.entries())
      .filter(([, v]) => v.count >= 2) // only repeated patterns
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, 10)
      .map(([topic, { count, isFailure }]) => ({
        topic,
        frequency: count,
        source: "claude-code" as const,
        isFailurePattern: isFailure,
      }));
  }

  *#walkJsonl(dir: string): Generator<string> {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* this.#walkJsonl(full);
        else if (entry.name.endsWith(".jsonl")) yield full;
      }
    } catch {
      // permission errors etc.
    }
  }
}
