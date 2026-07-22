// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractInlineRefMentions } from "../../session-logs/inline-refs";
import { AbstractSessionLogProvider } from "../../session-logs/provider-base";
import type {
  InlineRefMention,
  SessionData,
  SessionEvent,
  SessionLogHarness,
  SessionRef,
  SessionSummary,
} from "../../session-logs/types";

/**
 * Root directory holding Claude Code's per-project JSONL session logs.
 *
 * Resolved per call (not memoized at module load) so the `AKM_CLAUDE_PROJECTS_DIR`
 * override can be set after import. The override exists so tests — and the
 * isolated-storage sandbox — can point the scan at an empty fixture directory
 * instead of the real `~/.claude/projects`, which on an actively-used machine
 * holds many large session files and would make `akm health` (which scans it
 * synchronously) slow and non-hermetic.
 */
function claudeProjectsDir(): string {
  return process.env.AKM_CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), ".claude", "projects");
}

/**
 * Parse a single Claude Code JSONL event into a normalized {@link SessionEvent}.
 * Returns `undefined` for events that don't carry textual content (file
 * snapshots, attachments, queue metadata). Tool calls are flattened from the
 * `message.content` array into a stable text representation so downstream
 * consumers don't need to know the Anthropic-tool-call shape.
 */
function parseClaudeEvent(
  entry: unknown,
  sessionId: string | undefined,
  filePath: string,
  fallbackTsMs: number,
): SessionEvent | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as Record<string, unknown>;
  const tsRaw = e.timestamp;
  const ts =
    typeof tsRaw === "number" ? tsRaw : typeof tsRaw === "string" ? Date.parse(tsRaw) || fallbackTsMs : fallbackTsMs;
  const message = (e.message as Record<string, unknown> | undefined) ?? undefined;
  const role =
    typeof message?.role === "string"
      ? (message.role as SessionEvent["role"])
      : ((e.type as SessionEvent["role"]) ?? "unknown");

  const content = message?.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    // Assistant messages: array of content blocks. Flatten text/thinking/tool_use
    // into a stable representation. tool_use entries become `[tool: <name>] <input>`
    // so the inline-ref scanner can detect `akm remember` / `akm feedback` calls.
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "thinking" && typeof b.thinking === "string") parts.push(b.thinking);
      else if (b.type === "tool_use") {
        const toolName = typeof b.name === "string" ? b.name : "tool";
        // For shell-like tools, surface the `command` field directly so
        // inline-ref detection can match `akm remember "..."` without
        // JSON-quote escaping mangling the regex.
        const inputObj = b.input;
        let inputText = "";
        if (inputObj && typeof inputObj === "object") {
          const cmd = (inputObj as Record<string, unknown>).command;
          inputText = typeof cmd === "string" ? cmd : JSON.stringify(inputObj);
        } else if (typeof inputObj === "string") {
          inputText = inputObj;
        }
        parts.push(`[tool:${toolName}] ${inputText}`);
      } else if (b.type === "tool_result") {
        const out = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        parts.push(`[tool_result] ${out}`);
      }
    }
    text = parts.join("\n");
  }
  if (!text || text.length < 1) return undefined;
  return {
    harness: "claude-code",
    text,
    ts,
    sessionId,
    role,
    filePath,
  };
}

/**
 * Claude Code native session-log reader.
 *
 * id-normalization note (#563): the canonical harness id is `'claude'`, but
 * the provider's `name` — which is STAMPED onto every {@link SessionEvent} /
 * {@link SessionRef} (`harness: this.name`), used as the extracted-session
 * dedup key, and embedded in `session:<harness>:<id>` proposal refs — stays
 * `'claude-code'` (the harness runtimeId). Changing it would silently break
 * round-tripping of already-persisted session-tracking rows and refs. Registry
 * lookups normalize `'claude-code'` → `'claude'` via the #562 bridge
 * (`getHarness`), and the `--type` flag accepts both, so the canonical id and
 * the persisted runtime string coexist without drift.
 */
export class ClaudeCodeProvider extends AbstractSessionLogProvider implements SessionLogHarness {
  // Runtime identity (NOT the canonical id) — see class doc. Equals
  // HARNESS_BY_ID.get("claude").runtimeId.
  readonly name = "claude-code";

  protected availabilityRoot(): string {
    return claudeProjectsDir();
  }

  /**
   * Directory holding Claude Code's per-project session JSONL files
   * (`~/.claude/projects`, honoring `AKM_CLAUDE_PROJECTS_DIR`). Returns `[]`
   * when the directory does not exist on this machine. See {@link
   * SessionLogHarness.watchRoots}.
   */
  watchRoots(): string[] {
    const dir = claudeProjectsDir();
    return fs.existsSync(dir) ? [dir] : [];
  }

  *readEvents(input: { sinceMs: number }): Iterable<SessionEvent> {
    try {
      for (const jsonlPath of this.#walkJsonl(claudeProjectsDir())) {
        const stat = fs.statSync(jsonlPath);
        if (stat.mtimeMs < input.sinceMs) continue;

        const lines = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
        yield* this.logLineEvents({
          lines,
          filePath: jsonlPath,
          fallbackTsMs: stat.mtimeMs,
          selectText: (entry) => entry?.message?.content ?? entry?.content ?? "",
          selectSessionId: (entry) => entry?.session_id,
        });
      }
    } catch {
      return;
    }
  }

  listSessions(input: { sinceMs?: number; location?: string } = {}): SessionSummary[] {
    const root = input.location ?? claudeProjectsDir();
    return this.listSessionsFromFiles({
      sinceMs: input.sinceMs ?? 0,
      enumerate: () => this.#walkJsonl(root),
      summarize: (jsonlPath, stat) => {
        // Peek first + last non-empty line to derive start/end timestamps and
        // title. Reading the whole file would be wasteful for listing.
        const peek = this.#peekJsonl(jsonlPath);
        return this.sessionRef({
          sessionId: path.basename(jsonlPath, ".jsonl"),
          filePath: jsonlPath,
          startedAt: peek.firstTsMs ?? stat.ctimeMs,
          endedAt: peek.lastTsMs ?? stat.mtimeMs,
          projectHint: path.basename(path.dirname(jsonlPath)),
          title: peek.title,
        });
      },
    });
  }

  readSession(ref: SessionRef): SessionData {
    const stat = fs.statSync(ref.filePath);
    const lines = fs.readFileSync(ref.filePath, "utf8").split("\n").filter(Boolean);
    const events: SessionEvent[] = [];
    const inlineRefs: InlineRefMention[] = [];
    let title: string | undefined;
    let firstTsMs: number | undefined;
    let lastTsMs: number | undefined;
    const projectHint = path.basename(path.dirname(ref.filePath));

    for (const line of lines) {
      let entry: Record<string, unknown> | undefined;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!entry) continue;
      if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
        title = entry.customTitle;
        continue;
      }
      const parsed = parseClaudeEvent(entry, ref.sessionId, ref.filePath, stat.mtimeMs);
      if (!parsed) continue;
      events.push(parsed);
      if (firstTsMs === undefined || (parsed.ts ?? 0) < firstTsMs) firstTsMs = parsed.ts;
      if (lastTsMs === undefined || (parsed.ts ?? 0) > lastTsMs) lastTsMs = parsed.ts;
      // Extract inline akm-remember/feedback invocations from this event's text.
      inlineRefs.push(...extractInlineRefMentions(parsed.text, parsed.ts));
    }

    return {
      ref: this.sessionRef({
        sessionId: ref.sessionId,
        filePath: ref.filePath,
        startedAt: firstTsMs ?? stat.ctimeMs,
        endedAt: lastTsMs ?? stat.mtimeMs,
        projectHint,
        title,
      }),
      events,
      inlineRefs,
    };
  }

  /**
   * Cheap metadata peek — reads the first ~4KB to grab the `custom-title`
   * event (always early in the file) and the first event timestamp, then
   * reads the tail (~4KB) for the last timestamp. Avoids slurping multi-MB
   * session files during `listSessions`.
   */
  #peekJsonl(filePath: string): { firstTsMs?: number; lastTsMs?: number; title?: string } {
    const result: { firstTsMs?: number; lastTsMs?: number; title?: string } = {};
    try {
      const fd = fs.openSync(filePath, "r");
      try {
        const stat = fs.fstatSync(fd);
        const headSize = Math.min(stat.size, 4096);
        const head = Buffer.alloc(headSize);
        fs.readSync(fd, head, 0, headSize, 0);
        const headLines = head.toString("utf8").split("\n").filter(Boolean);
        // Walk head: track title, first timestamp, and (if file fits in head)
        // also the last timestamp seen — saves a tail read for small files.
        for (const line of headLines) {
          try {
            const e = JSON.parse(line) as Record<string, unknown>;
            if (e.type === "custom-title" && typeof e.customTitle === "string") {
              result.title = e.customTitle;
            }
            if (typeof e.timestamp === "string") {
              const t = Date.parse(e.timestamp);
              if (!Number.isNaN(t)) {
                if (result.firstTsMs === undefined) result.firstTsMs = t;
                result.lastTsMs = t;
              }
            }
          } catch {
            // partial line at buffer boundary — fine, skip
          }
        }
        // Large-file tail read overrides lastTsMs with a value closer to EOF.
        if (stat.size > 4096) {
          const tailSize = Math.min(stat.size, 4096);
          const tail = Buffer.alloc(tailSize);
          fs.readSync(fd, tail, 0, tailSize, stat.size - tailSize);
          const tailLines = tail.toString("utf8").split("\n").filter(Boolean);
          for (let i = tailLines.length - 1; i >= 0; i--) {
            try {
              const e = JSON.parse(tailLines[i] ?? "") as Record<string, unknown>;
              if (typeof e.timestamp === "string") {
                const t = Date.parse(e.timestamp);
                if (!Number.isNaN(t)) {
                  result.lastTsMs = t;
                  break;
                }
              }
            } catch {
              // skip partial lines from buffer boundary
            }
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // unreadable / vanished file — caller falls back to stat times
    }
    return result;
  }

  /** Session JSONL files under `dir`, excluding the shared journal file. */
  #walkJsonl(dir: string): Generator<string> {
    return this.walkFiles(dir, (name) => name.endsWith(".jsonl") && name !== "journal.jsonl");
  }
}
