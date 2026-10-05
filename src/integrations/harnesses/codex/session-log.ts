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
 * Root directory holding Codex's rollout files, one per session, as
 * `YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl`.
 *
 * Resolved per call (not memoized at module load) so `CODEX_HOME` — Codex's own
 * override of `~/.codex` — can be set after import; tests point it at a fixture
 * directory instead of the real history.
 */
function codexSessionsDir(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
}

/** Bytes read to get a rollout's first record, `session_meta`: its embedded base instructions make it 20-50 KB. */
const META_PEEK_BYTES = 128 * 1024;

/**
 * User-role blocks Codex injects itself, which are not the person's words: the
 * AGENTS.md instructions and the context tags it is known to wrap (environment,
 * plugin recommendations, an invoked skill's text, ...). Any other block is kept:
 * a stray bit of context costs less than a dropped reply.
 */
const INJECTED_CONTEXT_RE =
  /^\s*(?:# AGENTS\.md instructions[\s\S]*<\/INSTRUCTIONS>|<(environment_context|user_instructions|recommended_plugins|skill|turn_aborted)>[\s\S]*<\/\1>)\s*$/i;

interface RolloutMeta {
  startedAt?: number;
  /** The session's working directory. */
  cwd?: string;
  /**
   * A subagent or another of Codex's internal agents. Codex gives these an
   * object `source` (`{"subagent": ...}`, `{"internal": ...}`) where a person's
   * session has a bare string (`cli`, `vscode`, `exec`, ...), and writes each to a
   * rollout of its own: they are not sessions, so `listSessions` leaves them out.
   */
  isAgent: boolean;
}

/** The `session_meta` record, always a rollout's first; `undefined` for any other record. */
function parseSessionMeta(entry: unknown): RolloutMeta | undefined {
  const e = entry as { type?: unknown; payload?: Record<string, unknown> } | null;
  if (e?.type !== "session_meta" || !e.payload) return undefined;
  const { timestamp, cwd, source } = e.payload;
  const startedAt = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  return {
    ...(Number.isNaN(startedAt) ? {} : { startedAt }),
    ...(typeof cwd === "string" ? { cwd } : {}),
    isAgent: typeof source === "object" && source !== null && ("subagent" in source || "internal" in source),
  };
}

/** The text of a message's or tool output's content: a plain string, or blocks whose images and audio carry none. */
function blockText(blocks: unknown, keep: (text: string) => boolean = () => true): string {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    const text = (block as { text?: unknown } | null)?.text;
    if (typeof text === "string" && keep(text)) parts.push(text);
  }
  return parts.join("\n");
}

/**
 * A tool call's input as text. A shell call surfaces its command line (`cmd`, or
 * `command` as a string or an argv array) so the inline-ref scanner can match
 * `akm remember "..."` without JSON-quote escaping mangling the regex; any
 * other input stays as it was written.
 */
function toolInputText(input: unknown): string {
  let args = input;
  if (typeof input === "string") {
    try {
      args = JSON.parse(input);
    } catch {
      return input;
    }
  }
  const fields = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const cmd = fields.cmd ?? fields.command;
  if (typeof cmd === "string") return cmd;
  if (Array.isArray(cmd)) return cmd.join(" ");
  return typeof input === "string" ? input : (JSON.stringify(input) ?? "");
}

/**
 * Parse one rollout record into a normalized {@link SessionEvent}. The
 * conversation lives in `response_item` records; the rest (`event_msg` UI events
 * that repeat it, `turn_context`, `world_state`, token counts, compaction
 * markers) and items with nothing to read (`reasoning` is encrypted) give
 * `undefined`. Codex's `developer` messages are its own instructions, so they
 * are skipped too.
 *
 * Tool calls become `[tool:<name>] <input>` and their results `[tool_result]
 * <output>`, the shapes the Claude reader writes. A result is a `tool` event:
 * Codex has no enclosing user message to give it.
 */
function parseCodexRecord(
  entry: unknown,
  sessionId: string,
  filePath: string,
  fallbackTsMs: number,
): SessionEvent | undefined {
  const e = entry as { timestamp?: unknown; type?: unknown; payload?: Record<string, unknown> } | null;
  const item = e?.type === "response_item" ? e.payload : undefined;
  if (!item) return undefined;
  const toolName = typeof item.name === "string" ? item.name : "tool";
  let role: SessionEvent["role"] = "assistant";
  let text: string;
  switch (item.type) {
    case "message":
      if (item.role !== "user" && item.role !== "assistant") return undefined;
      role = item.role;
      text = blockText(item.content, item.role === "user" ? (t) => !INJECTED_CONTEXT_RE.test(t) : undefined);
      break;
    case "function_call":
      text = `[tool:${toolName}] ${toolInputText(item.arguments)}`;
      break;
    case "custom_tool_call":
      text = `[tool:${toolName}] ${typeof item.input === "string" ? item.input : ""}`;
      break;
    case "local_shell_call":
      text = `[tool:shell] ${toolInputText(item.action)}`;
      break;
    case "function_call_output":
    case "custom_tool_call_output": {
      role = "tool";
      const output = blockText(item.output);
      text = output ? `[tool_result] ${output}` : "";
      break;
    }
    default:
      return undefined;
  }
  if (!text.trim()) return undefined;
  const ts = typeof e?.timestamp === "string" ? Date.parse(e.timestamp) || fallbackTsMs : fallbackTsMs;
  return { harness: "codex", text, ts, sessionId, role, filePath };
}

/**
 * Codex native session-log reader.
 *
 * Events, refs, extraction keys, and the harness registry all use `codex`. The
 * session id is the thread id in the rollout's file name (the id `codex resume`
 * takes) and `projectHint` is the session's working directory.
 */
export class CodexProvider extends AbstractSessionLogProvider implements SessionLogHarness {
  readonly name = "codex";

  protected availabilityRoot(): string {
    return codexSessionsDir();
  }

  listSessions(input: { sinceMs?: number; location?: string; isolatedSnapshot?: boolean } = {}): SessionSummary[] {
    return this.listSessionsFromFiles({
      sinceMs: input.sinceMs ?? 0,
      enumerate: () => this.walkFiles(input.location ?? codexSessionsDir(), (name) => /^rollout-.+\.jsonl$/.test(name)),
      summarize: (rolloutPath, stat) => {
        const meta = this.#peekMeta(rolloutPath);
        if (meta?.isAgent) return undefined;
        return this.sessionRef({
          // The thread id is the 36-character UUID that ends the file name.
          sessionId: path.basename(rolloutPath, ".jsonl").slice(-36),
          filePath: rolloutPath,
          startedAt: meta?.startedAt ?? stat.ctimeMs,
          endedAt: stat.mtimeMs,
          projectHint: meta?.cwd,
        });
      },
    });
  }

  readSession(ref: SessionRef): SessionData {
    const stat = fs.statSync(ref.filePath);
    const events: SessionEvent[] = [];
    const inlineRefs: InlineRefMention[] = [];
    let meta: RolloutMeta | undefined;
    for (const line of fs.readFileSync(ref.filePath, "utf8").split("\n").filter(Boolean)) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a partial line (the session is still being written) or garbage
      }
      meta ??= parseSessionMeta(entry);
      const parsed = parseCodexRecord(entry, ref.sessionId, ref.filePath, stat.mtimeMs);
      if (!parsed) continue;
      events.push(parsed);
      inlineRefs.push(...extractInlineRefMentions(parsed.text, parsed.ts));
    }
    return {
      ref: this.sessionRef({
        sessionId: ref.sessionId,
        filePath: ref.filePath,
        startedAt: meta?.startedAt ?? events[0]?.ts ?? stat.ctimeMs,
        endedAt: events[events.length - 1]?.ts ?? stat.mtimeMs,
        projectHint: meta?.cwd,
      }),
      events,
      inlineRefs,
    };
  }

  /** The `session_meta` record on a rollout's first line, read without loading the file. */
  #peekMeta(filePath: string): RolloutMeta | undefined {
    try {
      const fd = fs.openSync(filePath, "r");
      try {
        const head = Buffer.alloc(META_PEEK_BYTES);
        const firstLine = head.toString("utf8", 0, fs.readSync(fd, head, 0, head.length, 0)).split("\n", 1)[0] ?? "";
        return parseSessionMeta(JSON.parse(firstLine));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return undefined; // unreadable / vanished file, or a first line that is not one whole record
    }
  }
}
