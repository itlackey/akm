// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one reader of OpenCode 1's `run --format json` stream. In its default format OpenCode 1 prints
 * only the reply and exits 0 when a turn ends on a refused tool call; the event stream carries the
 * session id, each step's finish reason, the failed tools and the errors.
 *
 * The reply is rebuilt exactly as OpenCode's default format prints it on a pipe: each finished `text`
 * part trimmed and followed by a newline, empty ones skipped. A line that is not an event (a plugin's
 * `console.log`, a line cut at a kill) stays in the reply as it is, in order, as the default format
 * passes it through.
 *
 * A turn is finished by OpenCode 1's own loop rule: its last step's finish reason is neither
 * `tool-calls` nor `unknown`.
 */

import { asRecord } from "../../../core/common";
import type { HarnessRunReport } from "../harness";

const UNFINISHED_REASONS = new Set(["tool-calls", "unknown"]);

function eventOf(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const event = asRecord(JSON.parse(line));
    return event && typeof event.type === "string" && typeof event.sessionID === "string" ? event : undefined;
  } catch {
    return undefined;
  }
}

/** What OpenCode's printer shows for an `error` event: its message, else its name. */
function errorMessage(error: unknown): string {
  const record = asRecord(error);
  const message = asRecord(record?.data)?.message;
  return typeof message === "string" ? message : String(record?.name);
}

export function readOpencode1Run(stdout: string): HarnessRunReport {
  let reply = "";
  let sessionId: string | undefined;
  let lastFinish: string | undefined;
  let stepFailures: string[] = [];
  const errors: string[] = [];
  const lines = stdout.split("\n");
  // A trailing newline leaves an empty last element that is not a line.
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const event = eventOf(line);
    if (!event) {
      reply += `${line}\n`;
      continue;
    }
    sessionId ??= event.sessionID as string;
    const part = asRecord(event.part);
    switch (event.type) {
      case "text": {
        const text = typeof part?.text === "string" ? part.text.trim() : "";
        if (text !== "") reply += `${text}\n`;
        break;
      }
      case "step_start":
        stepFailures = [];
        break;
      case "tool_use": {
        const state = asRecord(part?.state);
        if (state?.status === "error") stepFailures.push(`${String(part?.tool)} failed: ${String(state.error)}`);
        break;
      }
      case "step_finish":
        lastFinish = typeof part?.reason === "string" ? part.reason : "unknown";
        break;
      case "error":
        errors.push(errorMessage(event.error));
        break;
    }
  }
  let unfinished: string | undefined;
  if (lastFinish === undefined) unfinished = "OpenCode reported no finished step";
  else if (UNFINISHED_REASONS.has(lastFinish)) {
    unfinished = `its last step finished with "${lastFinish}"${stepFailures.length > 0 ? `; ${stepFailures.join("; ")}` : ""}`;
  }
  return { reply, ...(sessionId !== undefined ? { sessionId } : {}), ...(unfinished ? { unfinished } : {}), errors };
}
