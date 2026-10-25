// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Run one prompt as a session on akm's embedded OpenCode (#1244).
 *
 * The session carries everything that differs from one call to the next: the
 * model (`SessionCreateInput.model`), the environment (`sessions.environment`),
 * the persona (an instructions entry) and the request fields (recorded for the
 * akm plugin, `./plugin.ts`). The host is shared (`./host.ts`).
 *
 * Nobody can answer an akm run, so questions are cancelled and permission
 * requests rejected (`./host.ts`), each with a message, and the model carries on.
 */

import { toErrorMessage } from "../../../../core/common";
import { effectiveRequestFields } from "../../../../core/llm-inference";
import type { ChatCompletionConfig } from "../../../../llm/client";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../../agent/config";
import type { AgentProfile } from "../../../agent/profiles";
import {
  type AgentFailureReason,
  type AgentRunResult,
  buildChildEnv,
  type RunAgentOptions,
} from "../../../agent/spawn";
import { type EmbeddedHost, hostFor } from "./host";
import { forgetSession } from "./plugin";
import { runnerModel } from "./runner-models";
import { runTurn, turnResult } from "./turn";

/** How long an interrupt may take before the run is reported without waiting for it. */
const INTERRUPT_GRACE_MS = 5_000;

const TIMED_OUT = Symbol("timed out");
const ABORTED = Symbol("aborted");

interface Timers {
  readonly set: typeof setTimeout;
  readonly clear: typeof clearTimeout;
}

/** Race `work` against the deadline and the caller's signal. */
function bounded<T>(
  work: Promise<T>,
  deadline: number | null,
  signal: AbortSignal | undefined,
  timers: Timers,
): Promise<T | typeof TIMED_OUT | typeof ABORTED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const races: Promise<T | typeof TIMED_OUT | typeof ABORTED>[] = [work];
  if (deadline !== null) {
    races.push(
      new Promise((resolve) => (timer = timers.set(() => resolve(TIMED_OUT), Math.max(0, deadline - Date.now())))),
    );
  }
  if (signal) {
    races.push(
      new Promise((resolve) => {
        onAbort = () => resolve(ABORTED);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }
  return Promise.race(races).finally(() => {
    if (timer !== undefined) timers.clear(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  });
}

function failed(start: number, reason: AgentFailureReason, error: string, sessionId?: string): AgentRunResult {
  return {
    ok: false,
    stdout: "",
    stderr: error,
    durationMs: Date.now() - start,
    exitCode: reason === "aborted" || reason === "timeout" ? null : 1,
    reason,
    error,
    ...(sessionId ? { sessionId } : {}),
  };
}

/** Stop the session's turn and wait for OpenCode to confirm, for at most {@link INTERRUPT_GRACE_MS}. */
async function interrupt(host: EmbeddedHost, sessionID: string, timers: Timers): Promise<void> {
  await bounded(
    host.sessions.interrupt({ sessionID }).catch(() => {}),
    Date.now() + INTERRUPT_GRACE_MS,
    undefined,
    timers,
  );
}

/** Why a run was stopped before its turn finished: its deadline passed, or its caller gave up. */
class RunStopped extends Error {
  constructor(readonly reason: "timeout" | "aborted") {
    super(`run stopped: ${reason}`);
  }
}

/**
 * Run one prompt on akm's internal runtime: the embedded OpenCode driven by the
 * connection the run was dispatched with. Nothing here reads config: the
 * connection's endpoint, model and window become the provider the session runs
 * on (`./runner-models.ts`), and its key and request fields are the session's.
 *
 * The one place a run is made: start (or reach) the host, declare the connection, create the session, set it up,
 * drive its turn, and report. One deadline and one abort signal govern all of it: every step is raced against
 * them, a step that finishes after they have fired starts nothing more, and a session such a step created is
 * released. A run that stops after its session exists interrupts the turn, for at most {@link INTERRUPT_GRACE_MS}.
 */
export async function runOpencodeSdk(
  profile: AgentProfile,
  opts: RunAgentOptions,
  connection: ChatCompletionConfig,
): Promise<AgentRunResult> {
  const prompt = opts.dispatch?.prompt;
  if (prompt === undefined) throw new TypeError("An embedded session is run with a prompt.");
  const runner = runnerModel(connection);
  const settings = {
    endpoint: connection.endpoint,
    requestFields: effectiveRequestFields(connection.request, connection.inference),
    ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
  };
  const start = Date.now();
  const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  const deadline = timeoutMs === null ? null : start + timeoutMs;
  const timers = { set: setTimeout, clear: clearTimeout };
  const name = `akm's runtime on connection "${profile.name}"`;
  if (opts.signal?.aborted) return failed(start, "aborted", `${name} not started: caller signal already aborted`);

  const dispatch = opts.dispatch;
  const run = new AbortController();
  const forwardAbort = (): void => run.abort();
  opts.signal?.addEventListener("abort", forwardAbort, { once: true });
  /** How far the run has got: what a stop has to clean up. */
  const reached: { handle?: Awaited<ReturnType<typeof hostFor>>; sessionId?: string } = {};
  /** Throws once the run's deadline has passed or its caller has given up, so no step starts after either. */
  const live = (): void => {
    if (run.signal.aborted) throw new RunStopped("aborted");
    if (deadline !== null && Date.now() >= deadline) throw new RunStopped("timeout");
  };
  const release = (): void => {
    if (reached.handle && reached.sessionId) forgetSession(reached.handle.sessions, reached.sessionId);
  };

  const lifecycle = async (): Promise<AgentRunResult> => {
    try {
      const handle = await hostFor();
      live();
      reached.handle = handle;
      const { host, sessions } = handle;
      await handle.models.declare(runner);
      live();

      const created = await host.sessions.create(
        {
          title: "akm",
          location: { directory: opts.cwd ?? process.cwd() },
          model: { providerID: runner.providerID, id: runner.modelID },
          ...(dispatch?.agent ? { agent: dispatch.agent } : {}),
        },
        { signal: run.signal },
      );
      reached.sessionId = created.id;
      live();
      const eventSource = opts.env?.AKM_EVENT_SOURCE;
      // OpenCode gives a session's commands this environment in place of the process's, so it is the one a CLI harness's child gets.
      const env = buildChildEnv(profile, opts);
      sessions.set(created.id, { ...settings, ...(eventSource ? { eventSource } : {}), env });
      await host.sessions.environment({ sessionID: created.id, variables: env }, { signal: run.signal });
      live();
      if (dispatch?.systemPrompt) {
        await host.sessions.instructions.entry.put(
          { sessionID: created.id, key: "akm.system", value: dispatch.systemPrompt },
          { signal: run.signal },
        );
        live();
      }

      const { text, usage, failure } = turnResult(await runTurn(host, created.id, prompt, run.signal));
      return {
        ok: !failure,
        stdout: text,
        stderr: failure?.message ?? "",
        durationMs: Date.now() - start,
        exitCode: failure ? (failure.reason === "aborted" ? null : 1) : 0,
        ...(failure ? { reason: failure.reason, error: failure.message } : {}),
        sessionId: created.id,
        ...(usage ? { usage } : {}),
      };
    } finally {
      // Also reached by a step that finishes after the run was given up on: its session is forgotten then too.
      release();
    }
  };

  /** The run was stopped: interrupt its turn if it had a session, and say where it was. */
  const stopped = async (reason: "timeout" | "aborted"): Promise<AgentRunResult> => {
    run.abort();
    const { handle, sessionId } = reached;
    if (handle && sessionId) await interrupt(handle.host, sessionId, timers);
    const during = sessionId === undefined ? " during startup" : "";
    return reason === "aborted"
      ? failed(start, "aborted", `${name} aborted by caller signal${during}`, sessionId)
      : failed(start, "timeout", `${name} timed out${during} after ${timeoutMs}ms`, sessionId);
  };

  try {
    const outcome = await bounded(lifecycle(), deadline, run.signal, timers);
    if (outcome === TIMED_OUT) return await stopped("timeout");
    if (outcome === ABORTED) return await stopped("aborted");
    return outcome;
  } catch (error) {
    if (error instanceof RunStopped) return await stopped(error.reason);
    return failed(
      start,
      reached.sessionId ? "non_zero_exit" : "spawn_failed",
      toErrorMessage(error),
      reached.sessionId,
    );
  } finally {
    opts.signal?.removeEventListener("abort", forwardAbort);
    run.abort();
    release();
  }
}
