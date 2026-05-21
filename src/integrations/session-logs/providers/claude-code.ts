import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionEvent, SessionLogHarness } from "../types";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

export class ClaudeCodeProvider implements SessionLogHarness {
  readonly name = "claude-code";

  isAvailable(): boolean {
    return fs.existsSync(CLAUDE_PROJECTS_DIR);
  }

  *readEvents(input: { sinceMs: number }): Iterable<SessionEvent> {
    try {
      for (const jsonlPath of this.#walkJsonl(CLAUDE_PROJECTS_DIR)) {
        const stat = fs.statSync(jsonlPath);
        if (stat.mtimeMs < input.sinceMs) continue;

        const lines = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const text = entry?.message?.content ?? entry?.content ?? "";
            if (typeof text !== "string" || text.length < 10) continue;
            yield {
              harness: this.name,
              text,
              ts: typeof entry?.timestamp === "number" ? entry.timestamp : stat.mtimeMs,
              sessionId: typeof entry?.session_id === "string" ? entry.session_id : undefined,
              role: typeof entry?.role === "string" ? entry.role : "unknown",
              filePath: jsonlPath,
            };
          } catch {
            // skip malformed lines
          }
        }
      }
    } catch {
      return;
    }
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
