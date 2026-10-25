// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Run one prompt as a session on an embedded OpenCode (#1244).
 *
 * The session carries everything that differs from one call to the next: the
 * model (`SessionCreateInput.model`), the environment (`sessions.environment`),
 * the persona (an instructions entry) and the request fields (recorded for the
 * akm plugin, `./plugin.ts`). The host is shared and keyed only by its kind
 * (`./host.ts`).
 *
 * Nobody can answer an akm run, so questions are cancelled and permission
 * requests rejected (`./host.ts`), each with a message, and the model carries on.
 */

import fs from "node:fs";
import path from "node:path";
import { toErrorMessage } from "../../../../core/common";
import { effectiveRequestFields } from "../../../../core/llm-inference";
import { getCacheDir } from "../../../../core/paths";
import { warnOnce } from "../../../../core/warn";
import type { ChatCompletionConfig } from "../../../../llm/client";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../../agent/config";
import type { AgentProfile } from "../../../agent/profiles";
import type { AgentFailureReason, AgentRunResult, RunAgentOptions } from "../../../agent/spawn";
import { type EmbeddedHost, hostFor } from "./host";
import type { HostKind } from "./host-spec";
import { forgetSession, type SessionSettings } from "./plugin";
import { runtimeProviderId } from "./runtime-config";
import { runTurn, turnResult } from "./turn";

/** Model work reads but changes nothing: OpenCode's tools that edit files, run commands or start subagents are denied. */
const MODEL_WORK_PERMISSIONS = ["edit", "shell", "execute", "subagent"].map((action) => ({
  action,
  resource: "*",
  effect: "deny" as const,
}));

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

/** What distinguishes a run on one kind of host from a run on the other. */
interface Target {
  readonly kind: HostKind;
  /** The model the session is created with; absent, OpenCode's own default for the host decides. */
  readonly model?: { readonly providerID: string; readonly id: string };
  readonly settings: SessionSettings;
}

/** The one place a run is made: create the session, set it up, drive its turn, and report. */
async function runSession(
  target: Target,
  profile: AgentProfile,
  prompt: string,
  opts: RunAgentOptions,
): Promise<AgentRunResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  const deadline = timeoutMs === null ? null : start + timeoutMs;
  const timers = { set: setTimeout, clear: clearTimeout };
  const name = `opencode-sdk agent "${profile.name}"`;
  if (opts.signal?.aborted) return failed(start, "aborted", `${name} not started: caller signal already aborted`);

  const dispatch = opts.dispatch;
  const modelWork = dispatch?.modelWork === true;
  const run = new AbortController();
  const forwardAbort = (): void => run.abort();
  opts.signal?.addEventListener("abort", forwardAbort, { once: true });
  let handle: Awaited<ReturnType<typeof hostFor>> | undefined;
  let sessionId: string | undefined;
  try {
    const started = await bounded(hostFor(target.kind), deadline, run.signal, timers);
    if (started === ABORTED) return failed(start, "aborted", `${name} aborted by caller signal during startup`);
    if (started === TIMED_OUT) return failed(start, "timeout", `${name} timed out during startup after ${timeoutMs}ms`);
    handle = started;
    const { host, sessions } = handle;

    const session = await host.sessions.create({
      title: "akm",
      metadata: { akm: modelWork ? "model-work" : "agent" },
      location: { directory: opts.cwd ?? process.cwd() },
      ...(target.model ? { model: target.model } : {}),
      ...(!modelWork && dispatch?.agent ? { agent: dispatch.agent } : {}),
      ...(modelWork ? { permissions: MODEL_WORK_PERMISSIONS } : {}),
    });
    sessionId = session.id;
    const eventSource = opts.env?.AKM_EVENT_SOURCE;
    const env = opts.env && Object.keys(opts.env).length > 0 ? opts.env : undefined;
    sessions.set(session.id, {
      ...target.settings,
      ...(eventSource ? { eventSource } : {}),
      ...(env ? { env } : {}),
    });
    if (env) await host.sessions.environment({ sessionID: session.id, variables: env });
    if (dispatch?.systemPrompt) {
      await host.sessions.instructions.entry.put({
        sessionID: session.id,
        key: "akm.system",
        value: dispatch.systemPrompt,
      });
    }

    const turn = await bounded(runTurn(host, session.id, prompt, run.signal), deadline, run.signal, timers);
    if (turn === ABORTED || turn === TIMED_OUT) {
      await interrupt(host, session.id, timers);
      return turn === ABORTED
        ? failed(start, "aborted", `${name} aborted by caller signal`, sessionId)
        : failed(start, "timeout", `${name} timed out after ${timeoutMs}ms`, sessionId);
    }
    const { text, usage, failure } = turnResult(turn);
    return {
      ok: !failure,
      stdout: text,
      stderr: failure?.message ?? "",
      durationMs: Date.now() - start,
      exitCode: failure ? (failure.reason === "aborted" ? null : 1) : 0,
      ...(failure ? { reason: failure.reason, error: failure.message } : {}),
      sessionId,
      ...(usage ? { usage } : {}),
    };
  } catch (error) {
    return failed(start, sessionId ? "non_zero_exit" : "spawn_failed", toErrorMessage(error), sessionId);
  } finally {
    opts.signal?.removeEventListener("abort", forwardAbort);
    run.abort();
    if (sessionId && handle) forgetSession(handle.sessions, sessionId);
  }
}

/**
 * Run one prompt on akm's internal runtime: the embedded OpenCode driven by the
 * connection the run resolved to. The connection's endpoint is the host's
 * provider (`./runtime-config.ts`); the run contributes its model, request fields
 * and key.
 */
export function runOpencodeSdk(
  profile: AgentProfile,
  prompt: string,
  opts: RunAgentOptions,
  connection: ChatCompletionConfig,
): Promise<AgentRunResult> {
  return runSession(
    {
      kind: "runtime",
      model: { providerID: runtimeProviderId(profile.name), id: connection.model },
      settings: {
        requestFields: effectiveRequestFields(connection.request, connection.inference),
        ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
      },
    },
    profile,
    prompt,
    opts,
  );
}

/** `provider/model` as the user's OpenCode names a model; the model id may itself hold slashes. */
function userModel(model: string | undefined): { providerID: string; id: string } | undefined {
  if (model === undefined) return undefined;
  const slash = model.indexOf("/");
  if (slash > 0 && slash < model.length - 1) return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
  warnOnce(
    `opencode-model:${model}`,
    `OpenCode model ${JSON.stringify(model)} is not provider/model, so OpenCode's own default is used.`,
  );
  return undefined;
}

/** The one working directory of every model-work session this process runs on the user's OpenCode: OpenCode keeps an instance per directory for the life of the process. */
function modelWorkDirectory(): string {
  const directory = path.join(getCacheDir(), "opencode", "model-work");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

/**
 * Run one prompt on the user's OpenCode 2, embedded: their config, providers and
 * logins, and their default model unless akm names one. Model work is confined
 * (the deny permissions, akm's read tools) and runs in a fixed directory.
 */
export function runOpencodeHarness(
  profile: AgentProfile,
  prompt: string,
  opts: RunAgentOptions,
): Promise<AgentRunResult> {
  const model = userModel(opts.dispatch?.model);
  return runSession(
    { kind: "opencode", settings: {}, ...(model ? { model } : {}) },
    profile,
    prompt,
    opts.dispatch?.modelWork === true ? { ...opts, cwd: modelWorkDirectory() } : opts,
  );
}
