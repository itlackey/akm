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
import {
  type AgentFailureReason,
  type AgentRunResult,
  buildChildEnv,
  type RunAgentOptions,
} from "../../../agent/spawn";
import { modelFromArgs, withoutLeading, withoutModelFlag } from "../../harness";
import { type EmbeddedHost, hostFor } from "./host";
import type { HostKind } from "./host-spec";
import { forgetSession, type SessionSettings } from "./plugin";
import { type RunnerModel, runnerModel } from "./runner-models";
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
  /** The connection's model a runtime run brings, declared on the host before its session is created. */
  readonly runner?: RunnerModel;
  /** The model the session is created with on the user's OpenCode; absent, OpenCode's own default decides. */
  readonly model?: { readonly providerID: string; readonly id: string };
  readonly settings: SessionSettings;
}

/** Why a run was stopped before its turn finished: its deadline passed, or its caller gave up. */
class RunStopped extends Error {
  constructor(readonly reason: "timeout" | "aborted") {
    super(`run stopped: ${reason}`);
  }
}

/**
 * The one place a run is made: start (or reach) the host, declare the connection, create the session, set it up,
 * drive its turn, and report. One deadline and one abort signal govern all of it: every step is raced against
 * them, a step that finishes after they have fired starts nothing more, and a session such a step created is
 * released. A run that stops after its session exists interrupts the turn, for at most {@link INTERRUPT_GRACE_MS}.
 */
async function runSession(target: Target, profile: AgentProfile, opts: RunAgentOptions): Promise<AgentRunResult> {
  const prompt = opts.dispatch?.prompt;
  if (prompt === undefined) throw new TypeError("An embedded session is run with a prompt.");
  const start = Date.now();
  const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  const deadline = timeoutMs === null ? null : start + timeoutMs;
  const timers = { set: setTimeout, clear: clearTimeout };
  const name =
    target.kind === "runtime"
      ? `akm's runtime on connection "${profile.name}"`
      : `the opencode harness "${profile.name}"`;
  if (opts.signal?.aborted) return failed(start, "aborted", `${name} not started: caller signal already aborted`);

  const dispatch = opts.dispatch;
  const modelWork = dispatch?.modelWork === true;
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
      const handle = await hostFor(target.kind);
      live();
      reached.handle = handle;
      const { host, sessions } = handle;
      if (target.runner) await handle.models.declare(target.runner);
      live();
      const model = target.runner ? { providerID: target.runner.providerID, id: target.runner.modelID } : target.model;

      const created = await host.sessions.create(
        {
          title: "akm",
          metadata: { akm: modelWork ? "model-work" : "agent" },
          location: { directory: opts.cwd ?? process.cwd() },
          ...(model ? { model } : {}),
          ...(!modelWork && dispatch?.agent ? { agent: dispatch.agent } : {}),
          ...(modelWork ? { permissions: MODEL_WORK_PERMISSIONS } : {}),
        },
        { signal: run.signal },
      );
      reached.sessionId = created.id;
      live();
      const eventSource = opts.env?.AKM_EVENT_SOURCE;
      // OpenCode gives a session's commands this environment in place of the process's, so it is the one a CLI harness's child gets.
      const env = buildChildEnv(profile, opts);
      sessions.set(created.id, { ...target.settings, ...(eventSource ? { eventSource } : {}), env });
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

/**
 * Run one prompt on akm's internal runtime: the embedded OpenCode driven by the
 * connection the run was dispatched with. Nothing below this point reads config:
 * the connection's endpoint, model and window become the provider the session runs
 * on (`./runner-models.ts`), and its key and request fields are the session's.
 */
export function runOpencodeSdk(
  profile: AgentProfile,
  opts: RunAgentOptions,
  connection: ChatCompletionConfig,
): Promise<AgentRunResult> {
  return runSession(
    {
      kind: "runtime",
      runner: runnerModel(connection),
      settings: {
        endpoint: connection.endpoint,
        requestFields: effectiveRequestFields(connection.request, connection.inference),
        ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
      },
    },
    profile,
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
 * The harness's authored `args` the embedded run cannot carry, as OpenCode 1's CLI would have passed them. The
 * `--model` they name is the model unless the request names one (see {@link runOpencodeHarness}); a leading
 * `run` is the CLI's own subcommand; anything else is for the CLI alone, and is named once.
 */
function warnOfUncarriedArgs(profile: AgentProfile): void {
  const uncarried = withoutModelFlag(withoutLeading(profile.args, "run"));
  if (uncarried.length === 0) return;
  warnOnce(
    `opencode-embedded-args:${profile.name}:${uncarried.join(" ")}`,
    `The opencode harness "${profile.name}" runs OpenCode 2 embedded in akm, which carries only the --model of its args; ${uncarried.join(" ")} ${uncarried.length === 1 ? "is" : "are"} not applied. Set the harness's model, agent or workspace instead.`,
  );
}

/**
 * Run one prompt on the user's OpenCode 2, embedded: their config, providers and
 * logins, and their default model unless akm names one. The model is the
 * request's, else the `--model` the harness's authored `args` carry, as on
 * OpenCode 1's CLI. Model work is confined (the deny permissions, akm's read
 * tools) and runs in a fixed directory.
 */
export function runOpencodeHarness(profile: AgentProfile, opts: RunAgentOptions): Promise<AgentRunResult> {
  warnOfUncarriedArgs(profile);
  const model = userModel(opts.dispatch?.model ?? modelFromArgs(profile.args));
  return runSession(
    { kind: "opencode", settings: {}, ...(model ? { model } : {}) },
    profile,
    opts.dispatch?.modelWork === true ? { ...opts, cwd: modelWorkDirectory() } : opts,
  );
}
