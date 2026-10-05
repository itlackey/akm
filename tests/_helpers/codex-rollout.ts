/**
 * Synthetic Codex rollouts for the session-log tests, shaped after what Codex
 * writes — `sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl`, a
 * `session_meta` record first, then one `{timestamp, type, payload}` record per
 * item — so no real (private) session is ever needed.
 */

import fs from "node:fs";
import path from "node:path";

/** A rollout record without its timestamp; a string is written as a raw line (to model a malformed one). */
export type RolloutRecord = { type: string; payload: unknown } | string;

/** A `response_item` message; every text is one content block. */
export function codexMessage(role: "user" | "assistant" | "developer", ...texts: string[]): RolloutRecord {
  const type = role === "assistant" ? "output_text" : "input_text";
  return {
    type: "response_item",
    payload: { type: "message", role, content: texts.map((text) => ({ type, text })) },
  };
}

/**
 * Write a rollout under `sessionsDir` and return its path. `source` is the
 * `session_meta` source: a bare string (`cli`, `vscode`, `exec`) for a person's
 * session, `{ subagent: ... }` for a spawned agent. Records are stamped a minute
 * apart, starting a minute after `startedAt`.
 */
export function writeCodexRollout(
  sessionsDir: string,
  meta: { id: string; source?: unknown; cwd?: string; startedAt?: string },
  records: RolloutRecord[] = [],
): string {
  const startedAt = meta.startedAt ?? "2026-08-01T10:00:00.000Z";
  const filePath = path.join(
    sessionsDir,
    ...startedAt.slice(0, 10).split("-"),
    `rollout-${startedAt.slice(0, 19).replace(/:/g, "-")}-${meta.id}.jsonl`,
  );
  const lines = [
    JSON.stringify({
      timestamp: startedAt,
      type: "session_meta",
      payload: {
        id: meta.id,
        timestamp: startedAt,
        cwd: meta.cwd ?? "/home/user/project-a",
        originator: "codex-tui",
        cli_version: "0.0.0-test",
        source: meta.source ?? "cli",
        base_instructions: { text: "synthetic base instructions" },
      },
    }),
    ...records.map((record, i) =>
      typeof record === "string"
        ? record
        : JSON.stringify({ timestamp: new Date(Date.parse(startedAt) + (i + 1) * 60_000).toISOString(), ...record }),
    ),
  ];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}
