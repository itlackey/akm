// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One prompt on an embedded OpenCode, from the prompt to its reply: wait for the
 * turn to finish, read its messages and turn them into the text, token usage and
 * failure an {@link AgentRunResult} carries.
 */

import { isRecord } from "../../../../core/common";
import type { AgentFailureReason, AgentTokenUsage } from "../../../agent/spawn";
import type { EmbeddedHost } from "./host";

/** OpenCode 2 error types and the akm failure reason each means. Anything else is `non_zero_exit`. */
const FAILURE_REASONS: Record<string, AgentFailureReason> = {
  "output-limit": "parse_error",
  "provider.quota": "llm_rate_limit",
  "provider.free-limit": "llm_rate_limit",
  "provider.rate-limit": "llm_rate_limit",
  "provider.content-filter": "llm_content_filter",
  aborted: "aborted",
};

interface Assistant {
  readonly type: "assistant";
  readonly finish?: string;
  readonly error?: { readonly type: string; readonly message: string };
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly tokens?: { readonly input?: number; readonly output?: number; readonly reasoning?: number };
}
export interface Turn {
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly assistants: readonly Assistant[];
  readonly error?: { readonly type: string; readonly message: string };
}

/** The messages after the user message `userId`, oldest first; undefined until it is found. Pages the full history, so a compaction cannot hide it. */
async function messagesAfter(host: EmbeddedHost, sessionID: string, userId: string): Promise<unknown[] | undefined> {
  const newestFirst: unknown[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await host.message.list({ sessionID, limit: 200, ...(cursor ? { cursor } : { order: "desc" }) });
    for (const message of page.data) {
      if (isRecord(message) && message.id === userId) return newestFirst.reverse();
      newestFirst.push(message);
    }
    if (!page.cursor?.next || page.data.length === 0) return undefined;
    cursor = page.cursor.next;
  }
}

/** The finished turn, or undefined while it is still running. */
function finishedTurn(messages: readonly unknown[]): Turn | undefined {
  const assistants: Assistant[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.type === "assistant") assistants.push(message as unknown as Assistant);
    else if (message.type === "idle") {
      return {
        outcome: message.outcome as Turn["outcome"],
        assistants,
        ...(isRecord(message.error) ? { error: message.error as Turn["error"] } : {}),
      };
    }
  }
  // OpenCode ends a step it interrupts without an `idle` message.
  const last = assistants.at(-1);
  return last?.finish === "error" && last.error?.type === "aborted"
    ? { outcome: "interrupted", assistants }
    : undefined;
}

/** A step OpenCode continued in the next one: cut at the output limit, or a stream that broke mid-reply. */
function continued(a: Assistant): boolean {
  return (
    a.finish === "length" ||
    (a.finish === "error" && (a.error?.type === "provider.transport" || a.error?.type === "provider.invalid-output"))
  );
}

export function turnResult(turn: Turn): {
  text: string;
  usage?: AgentTokenUsage;
  failure?: { reason: AgentFailureReason; message: string };
} {
  let text = "";
  let joinNext = false;
  const usage: AgentTokenUsage = {};
  const add = (key: keyof AgentTokenUsage, value: number | undefined): void => {
    if (typeof value === "number" && Number.isFinite(value)) usage[key] = (usage[key] ?? 0) + value;
  };
  for (const a of turn.assistants) {
    const own = a.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    if (own) text = joinNext ? text + own : own;
    joinNext = continued(a);
    add("inputTokens", a.tokens?.input);
    add("outputTokens", a.tokens?.output);
    add("reasoningTokens", a.tokens?.reasoning);
  }
  const error = turn.error ?? [...turn.assistants].reverse().find((a) => a.error)?.error;
  const last = turn.assistants.at(-1);
  const failure =
    turn.outcome === "interrupted"
      ? { reason: "aborted" as const, message: `OpenCode session was interrupted${error ? ` (${error.message})` : ""}` }
      : turn.outcome === "failed"
        ? {
            reason: (error && FAILURE_REASONS[error.type]) ?? "non_zero_exit",
            message: error ? `${error.type}: ${error.message}` : "OpenCode session failed",
          }
        : last?.finish === "length"
          ? { reason: "parse_error" as const, message: "OpenCode reply was cut off at the output limit" }
          : undefined;
  return { text, ...(Object.keys(usage).length > 0 ? { usage } : {}), ...(failure ? { failure } : {}) };
}

/** Prompt, then wait until the turn has finished. */
export async function runTurn(
  host: EmbeddedHost,
  sessionID: string,
  prompt: string,
  signal: AbortSignal,
): Promise<Turn> {
  const user = await host.sessions.prompt({ sessionID, text: prompt }, { signal });
  for (;;) {
    await host.sessions.wait({ sessionID }, { signal });
    const after = await messagesAfter(host, sessionID, user.id);
    const turn = after && finishedTurn(after);
    if (turn) return turn;
    // `wait` can return before the queued prompt starts.
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (signal.aborted) throw new Error("OpenCode prompt cancelled");
  }
}
