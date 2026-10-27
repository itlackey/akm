// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `callStructured()` — one model call on any runner kind.
 *
 * It resolves the call once (the runner's target, model and timeout, the call's
 * own settings), lowers it for the runner's transport, dispatches it, and
 * returns the reply text or the failure. A provider's failure (transport error,
 * timeout, abort, a harness that exits non-zero) is a failed outcome, the same
 * for every caller; only a configuration failure throws, because it is not the
 * provider's and no fallback can repair it.
 *
 * What stays per-caller: reading the reply (the structured loop, `llm/structured.ts`),
 * and what a failed outcome means for that caller.
 */

import { ConfigError } from "../core/errors";
import type { LoweringNotice, ResolvedConversationMessage } from "../execution/resolved-request";
import type { UnresolvedExecutionDefaults } from "../execution/source";
import { buildExecution, currentLayer, resolveExecution } from "../integrations/agent/execution";
import type { RunnerSpec } from "../integrations/agent/runner";
import { runExecution } from "../integrations/agent/runner-dispatch";
import type { AgentRunResult } from "../integrations/agent/spawn";
import type { ChatCompletionConfig, ChatMessage } from "./client";
import type { Dispatched } from "./structured";

/**
 * Per-call request shape. Mirrors the subset of direct-LLM options the
 * structured callers actually use, plus an injectable `chat` seam so tests can
 * replace the transport without a network call. Production transport selection
 * stays inside the lowered dispatch seam.
 *
 * KEY-PRESENCE SEMANTICS (`timeoutMs`): an ABSENT `timeoutMs` key means "the
 * runner's own timeout" (the resolver's), while a PRESENT key set to
 * `undefined`/`null` means "timeout explicitly disabled". `callStructured`
 * therefore forwards each option key only when it is present on `request`
 * (`Object.hasOwn`), so callers that omit the key keep the runner's timeout and
 * callers that set it — even to `undefined` — keep the explicit override.
 */
export interface CallStructuredRequest {
  temperature?: number;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  responseSchema?: Record<string, unknown>;
  /** Hard output-token cap forwarded to the transport as `max_tokens`. */
  maxTokens?: number;
  /** Override the connection's `enableThinking` for this call. */
  enableThinking?: boolean;
  onRetryAttempt?: () => void;
  /**
   * Transport override for tests. Production callers leave it unset.
   */
  chat?: (
    config: ChatCompletionConfig,
    messages: ChatMessage[],
    options?: {
      temperature?: number;
      timeoutMs?: number | null;
      signal?: AbortSignal;
      responseSchema?: Record<string, unknown>;
      maxTokens?: number;
      enableThinking?: boolean;
      onRetryAttempt?: () => void;
    },
  ) => Promise<string>;
}

export interface CallStructuredOptions {
  /** Already-resolved symbolic runner, of any kind. Lowering precedes credential lookup and aliases are never re-run. */
  runner: RunnerSpec;
  /** Additional exact invocation fields for the current call. */
  current?: UnresolvedExecutionDefaults;
  /** Receives the stable, secret-free notices emitted by the selected lowerer. */
  onNotices?: (notices: readonly Readonly<LoweringNotice>[]) => void;
  /** The chat messages to send. */
  messages: ChatMessage[];
  /** Per-call request options (temperature/timeout/signal/schema/retry/chat). */
  request?: CallStructuredRequest;
}

/** The reply text, or why there is none: the failed dispatch's own result is carried when it reached a transport. */
export type StructuredOutcome = Dispatched;

function own(value: object | undefined, key: PropertyKey): boolean {
  return value !== undefined && Object.hasOwn(value, key);
}

/**
 * @internal Exact request-to-cascade projection, exported for presence-semantics contracts.
 */
export function resolveStructuredCurrent(
  current: UnresolvedExecutionDefaults | undefined,
  request: CallStructuredRequest | undefined,
): UnresolvedExecutionDefaults | undefined {
  const out: Record<string, unknown> = current ? { ...current } : {};
  const requestHasInference =
    own(request, "temperature") || own(request, "maxTokens") || own(request, "enableThinking");
  const baseInference =
    current?.inference && typeof current.inference === "object" && !Array.isArray(current.inference)
      ? { ...current.inference }
      : {};
  const inference: Record<string, unknown> = { ...baseInference };
  if (own(request, "temperature") && request?.temperature !== undefined) inference.temperature = request.temperature;
  if (own(request, "maxTokens") && request?.maxTokens !== undefined) inference.maxTokens = request.maxTokens;
  if (own(request, "enableThinking") && request?.enableThinking !== undefined) {
    inference.enableThinking = request.enableThinking;
  }
  if (Object.keys(inference).length > 0 || requestHasInference) out.inference = inference;
  else if (current?.inference === null) out.inference = null;
  if (own(request, "responseSchema") && request?.responseSchema !== undefined) {
    out.outputSchema = request.responseSchema;
  }
  if (own(request, "timeoutMs")) out.timeout = request?.timeoutMs ?? null;
  return Object.keys(out).length > 0 ? (out as UnresolvedExecutionDefaults) : undefined;
}

function requireTerminalUserMessage(messages: readonly ChatMessage[]): {
  content: string;
  conversation: readonly Readonly<ResolvedConversationMessage>[];
} {
  const terminal = messages.at(-1);
  if (!terminal || terminal.role !== "user") {
    throw new TypeError("callStructured messages must end with the terminal user command");
  }
  return {
    content: terminal.content,
    conversation: messages.slice(0, -1).map((message) => ({ role: message.role, content: message.content })),
  };
}

/** Timeout and abort come from the dispatch's own reason, whatever the runner's kind. */
function failed(error: string, result?: AgentRunResult): Extract<StructuredOutcome, { ok: false }> {
  const reason = result?.reason;
  return {
    ok: false,
    reason: reason === "timeout" || reason === "aborted" ? reason : "error",
    error,
    ...(result ? { result } : {}),
  };
}

/** A dispatch's result as the reply it produced or the failure it reports. */
export function outcomeOf(result: AgentRunResult): StructuredOutcome {
  return result.ok
    ? { ok: true, raw: result.stdout }
    : failed(result.error ?? result.stderr ?? result.reason ?? "dispatch failed", result);
}

export async function callStructured(opts: CallStructuredOptions): Promise<StructuredOutcome> {
  const { runner, messages, request } = opts;
  try {
    const terminal = requireTerminalUserMessage(messages);
    // Every structured call is unattended model work, so it runs under the model-work tool policy.
    const prepared = resolveExecution({
      content: terminal.content,
      conversation: terminal.conversation,
      runner,
      layers: [currentLayer(resolveStructuredCurrent(opts.current, request) ?? {})],
      modelWork: true,
    });
    const lowered = buildExecution(prepared.request, prepared.runner);
    opts.onNotices?.(lowered.notices);
    const result = await runExecution(lowered, {
      ...(request?.chat ? { chat: request.chat } : {}),
      ...(request?.onRetryAttempt ? { onRetryAttempt: request.onRetryAttempt } : {}),
      ...(request?.signal ? { signal: request.signal } : {}),
    });
    return outcomeOf(result);
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    return failed(err instanceof Error ? err.message : String(err));
  }
}
