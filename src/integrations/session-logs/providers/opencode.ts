import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionLogEntry, SessionLogProvider } from "../types";

function getOpenCodeLogDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "opencode");
  }
  return path.join(os.homedir(), ".local", "share", "opencode");
}

export class OpenCodeProvider implements SessionLogProvider {
  readonly name = "opencode" as const;
  readonly #logDir = getOpenCodeLogDir();

  isAvailable(): boolean {
    return fs.existsSync(this.#logDir);
  }

  getRecentTopics(sinceDays: number): SessionLogEntry[] {
    const since = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
    const topicCounts = new Map<string, { count: number; isFailure: boolean }>();
    const ERROR_PATTERNS = /error|failed|exception|cannot|undefined|ENOENT|timeout/i;

    try {
      for (const file of fs.readdirSync(this.#logDir)) {
        const full = path.join(this.#logDir, file);
        const stat = fs.statSync(full);
        if (stat.mtimeMs < since) continue;
        if (!file.endsWith(".json") && !file.endsWith(".jsonl") && !file.endsWith(".log")) continue;

        const content = fs.readFileSync(full, "utf8");
        const lines = content.includes("\n") ? content.split("\n") : [content];
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const text = entry?.content ?? entry?.message ?? entry?.text ?? "";
            if (typeof text !== "string" || text.length < 10) continue;
            const isFailure = ERROR_PATTERNS.test(text);
            if (isFailure) {
              const key = text.slice(0, 60).toLowerCase();
              const existing = topicCounts.get(key) ?? { count: 0, isFailure: true };
              topicCounts.set(key, { count: existing.count + 1, isFailure: true });
            }
          } catch {
            // skip malformed
          }
        }
      }
    } catch {
      return [];
    }

    return Array.from(topicCounts.entries())
      .filter(([, v]) => v.count >= 2)
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, 10)
      .map(([topic, { count, isFailure }]) => ({
        topic,
        frequency: count,
        source: "opencode" as const,
        isFailurePattern: isFailure,
      }));
  }
}
