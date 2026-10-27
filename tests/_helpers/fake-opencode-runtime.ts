// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A scripted stand-in for akm's own agent runtime (the pinned OpenCode process),
 * installed on the runtime port (`agentRuntime.run`). Each run is answered by
 * `reply`: the reply's text, or a {@link FakeRuntimeReply} with a provider error.
 * A reply that never settles leaves the run going, for deadline and abort tests,
 * which end the way the real runtime's spawn path ends them: `timeout` and
 * `aborted`. What akm asked of the runtime is recorded in `calls`.
 *
 * Tests that need OpenCode's real behaviour (tools, permissions, the plugin, the
 * sessions it keeps) run the real binary against `startFakeModel()` instead
 * (`tests/integration/opencode-runtime-sessions.test.ts`).
 */

import { mock, spyOn } from "bun:test";
import { effectiveRequestFields } from "../../src/core/llm-inference";
import { agentRuntime } from "../../src/integrations/agent/runtime";
import type { AgentRunResult, AgentTokenUsage } from "../../src/integrations/agent/spawn";
import type { ChatCompletionConfig } from "../../src/llm/client";

export interface FakeRuntimeCall {
  readonly prompt: string;
  readonly agent?: string;
  readonly directory?: string;
  /** The model the run was dispatched with. */
  readonly model: string;
  /** The environment the run's commands were given by the call. */
  readonly environment?: Readonly<Record<string, string>>;
  /** The connection the run was frozen with, key included. */
  readonly connection: ChatCompletionConfig;
  /** The fields the runtime's plugin lays over every model request, in the endpoint's own names. */
  readonly requestBody: Record<string, unknown>;
  /** The bearer token the runtime's provider sends, when the connection has a key. */
  readonly authorization?: string;
}

export interface FakeRuntimeReply {
  readonly text?: string;
  /** The tokens the run reports, as the real runtime reads them from the run's session. */
  readonly usage?: AgentTokenUsage;
  /** A provider error: the run fails. */
  readonly error?: { readonly type: string; readonly message: string };
}

export interface FakeRuntimeOptions {
  readonly reply: (call: FakeRuntimeCall) => string | FakeRuntimeReply | Promise<string | FakeRuntimeReply>;
}

export interface FakeRuntime {
  readonly calls: FakeRuntimeCall[];
}

const TIMED_OUT = Symbol("timed out");
const ABORTED = Symbol("aborted");

/** Replace the runtime's `run` for the current test; the harness restores it (`mock.restore()` in tests/_preload.ts). */
export function installFakeOpencodeRuntime(options: FakeRuntimeOptions): FakeRuntime {
  const calls: FakeRuntimeCall[] = [];
  spyOn(agentRuntime, "run").mockImplementation(async (_profile, opts, connection) => {
    const start = Date.now();
    const call: FakeRuntimeCall = {
      prompt: opts.dispatch?.prompt ?? "",
      ...(opts.dispatch?.agent ? { agent: opts.dispatch.agent } : {}),
      ...(opts.cwd ? { directory: opts.cwd } : {}),
      model: connection.model,
      ...(opts.env ? { environment: opts.env } : {}),
      connection,
      requestBody: effectiveRequestFields(connection.request, connection.inference),
      ...(connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {}),
    };
    calls.push(call);
    const { signal, timeoutMs } = opts;
    if (signal?.aborted) return stopped(start, "aborted");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stops: Promise<typeof TIMED_OUT | typeof ABORTED>[] = [];
    if (typeof timeoutMs === "number")
      stops.push(new Promise((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs))));
    if (signal)
      stops.push(new Promise((resolve) => signal.addEventListener("abort", () => resolve(ABORTED), { once: true })));
    const answered = await Promise.race([Promise.resolve(options.reply(call)), ...stops]).finally(() =>
      clearTimeout(timer),
    );
    if (answered === TIMED_OUT) return stopped(start, "timeout");
    if (answered === ABORTED) return stopped(start, "aborted");
    const reply = typeof answered === "string" ? { text: answered } : answered;
    if (reply.error) {
      const message = `${reply.error.type}: ${reply.error.message}`;
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: message,
        durationMs: Date.now() - start,
        reason: "non_zero_exit",
        error: message,
      };
    }
    return {
      ok: true,
      exitCode: 0,
      stdout: reply.text ?? "",
      stderr: "",
      durationMs: Date.now() - start,
      ...(reply.usage ? { usage: reply.usage } : {}),
    };
  });
  return { calls };
}

/** What a run that is stopped before its reply reports. */
function stopped(start: number, reason: "timeout" | "aborted"): AgentRunResult {
  return {
    ok: false,
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: Date.now() - start,
    reason,
    error: `akm's runtime ${reason === "aborted" ? "aborted by caller signal" : "timed out"}`,
  };
}

/** Undo {@link installFakeOpencodeRuntime} (and the harness's refusal of the real runtime) in a test that runs the real one. */
export function useRealOpencodeRuntime(): void {
  mock.restore();
}
