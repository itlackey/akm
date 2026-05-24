// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionEvent, SessionLogHarness } from "../types";

function getOpenCodeLogDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "opencode");
  }
  return path.join(os.homedir(), ".local", "share", "opencode");
}

export class OpenCodeProvider implements SessionLogHarness {
  readonly name = "opencode";
  readonly #logDir = getOpenCodeLogDir();

  isAvailable(): boolean {
    return fs.existsSync(this.#logDir);
  }

  *readEvents(input: { sinceMs: number }): Iterable<SessionEvent> {
    try {
      for (const file of fs.readdirSync(this.#logDir)) {
        const full = path.join(this.#logDir, file);
        const stat = fs.statSync(full);
        if (stat.mtimeMs < input.sinceMs) continue;
        if (!file.endsWith(".json") && !file.endsWith(".jsonl") && !file.endsWith(".log")) continue;

        const content = fs.readFileSync(full, "utf8");
        const lines = content.includes("\n") ? content.split("\n") : [content];
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const text = entry?.content ?? entry?.message ?? entry?.text ?? "";
            if (typeof text !== "string" || text.length < 10) continue;
            yield {
              harness: this.name,
              text,
              ts: typeof entry?.timestamp === "number" ? entry.timestamp : stat.mtimeMs,
              sessionId: typeof entry?.sessionId === "string" ? entry.sessionId : undefined,
              role: typeof entry?.role === "string" ? entry.role : "unknown",
              filePath: full,
            };
          } catch {
            // skip malformed
          }
        }
      }
    } catch {
      return;
    }
  }
}
