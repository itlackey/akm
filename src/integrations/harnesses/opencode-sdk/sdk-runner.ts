// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode SDK runner (#1244): OpenCode 2 embedded in akm's process through
 * `@opencode/sdk`. No binary, no server, no port: `OpenCode.create()` runs
 * OpenCode's router in memory.
 *
 * - Agent and workflow runs use the user's default OpenCode config (providers,
 *   plugins, MCP servers, agents), with akm's model on top when akm names one.
 * - Model work runs on an empty akm-owned config directory: none of the user's
 *   plugins, MCP servers or agents load. Its tools are the `read` and `akm`
 *   capabilities; akm's read tools run in-process. Credentials stay where
 *   OpenCode keeps them (its data directory); nothing is copied.
 * - Every session is stored in akm's own OpenCode database
 *   (`<akm data dir>/opencode.db`). `OPENCODE_DB=<that path> opencode` opens it.
 * - Nobody can answer an akm run, so questions are cancelled and permission
 *   requests rejected, each with a message, and the model carries on.
 *
 * Only this folder imports `@opencode/*`, and only lazily (core principle 11).
 */

import fs from "node:fs";
import path from "node:path";
import type { OpenCode } from "@opencode/sdk";
import { isRecord, toErrorMessage } from "../../../core/common";
import type { LlmConnectionConfig } from "../../../core/config/config";
import { getCacheDir, getDataDir } from "../../../core/paths";
import type { ExecutionJsonObject } from "../../../execution/json";
import { AKM_READ_TOOLS } from "../../agent/akm-read-tools";
import { type Capability, MODEL_WORK_CAPABILITIES } from "../../agent/capabilities";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../agent/config";
import type { AgentProfile } from "../../agent/profiles";
import type { AgentFailureReason, AgentRunResult, AgentTokenUsage, RunAgentOptions } from "../../agent/spawn";
import { openCodeImporter } from "../opencode/config-import";
import { opencodeInferenceConfig } from "../opencode/model-config";

type Host = OpenCode.Interface;
type CreateOptions = OpenCode.CreateOptions;
type SdkPlugin = NonNullable<CreateOptions["plugins"]>[number];

/** The message the model gets when akm declines something only a person could answer. */
const NOBODY_TO_ASK =
  "This is an unattended run: nobody can answer questions or approve requests. Continue without it.";

/** OpenCode 2 tools behind each capability. Everything not granted is denied. */
const CAPABILITY_TOOLS: Record<Capability, readonly string[]> = {
  read: ["read", "grep", "glob"],
  edit: ["edit", "write"],
  shell: ["shell"],
  web: ["webfetch", "websearch"],
  subagents: ["subagent"],
  akm: ["akm_search", "akm_show", "akm_curate"],
};

/** OpenCode 2 error types and the akm failure reason each means. Anything else is `non_zero_exit`. */
const FAILURE_REASONS: Record<string, AgentFailureReason> = {
  "output-limit": "parse_error",
  "provider.quota": "llm_rate_limit",
  "provider.free-limit": "llm_rate_limit",
  "provider.rate-limit": "llm_rate_limit",
  "provider.content-filter": "llm_content_filter",
  aborted: "aborted",
};

/** Where akm keeps its OpenCode sessions. */
export function akmOpencodeDatabasePath(): string {
  const directory = getDataDir();
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, "opencode.db");
}

/** Session permission rules for a capability list: deny everything, then allow what is granted. */
export function capabilityPermissions(capabilities: readonly Capability[]) {
  return [
    { action: "*", resource: "*", effect: "deny" as const },
    ...capabilities.flatMap((capability) =>
      CAPABILITY_TOOLS[capability].map((action) => ({ action, resource: "*", effect: "allow" as const })),
    ),
  ];
}

// ── Model ──────────────────────────────────────────────────────────────────

function canonicalProviderBase(endpoint: string): string {
  return endpoint.replace(/\/chat\/completions$/, "").replace(/\/+$/, "");
}

/** The inference a fallback LLM connection carries, which OpenCode can take. */
function fallbackInference(llm: LlmConnectionConfig | undefined): ExecutionJsonObject {
  const out: Record<string, unknown> = {};
  for (const key of ["temperature", "maxTokens", "contextLength", "enableThinking", "reasoningEffort"] as const) {
    if (llm?.[key] !== undefined) out[key] = llm[key];
  }
  return out as ExecutionJsonObject;
}

/**
 * The config content akm adds for one run: the model, and a provider for it
 * when akm supplies the endpoint. Empty when akm names no model, so the user's
 * OpenCode config decides.
 */
export function modelConfig(
  model: string | undefined,
  llm: LlmConnectionConfig | undefined,
  inference: ExecutionJsonObject | null | undefined,
): Record<string, unknown> {
  const merged = inference === null ? undefined : { ...fallbackInference(llm), ...inference };
  const { entry } = opencodeInferenceConfig(merged, false);
  if (llm?.endpoint || llm?.apiKey) {
    const modelId = model?.startsWith("akm-custom/") ? model.slice("akm-custom/".length) : model;
    return {
      ...(modelId ? { model: `akm-custom/${modelId}` } : {}),
      provider: {
        "akm-custom": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            ...(llm.endpoint ? { baseURL: canonicalProviderBase(llm.endpoint) } : {}),
            ...(llm.apiKey ? { apiKey: llm.apiKey } : {}),
          },
          ...(modelId ? { models: { [modelId]: entry } } : {}),
        },
      },
    };
  }
  return model ? { model } : {};
}

/**
 * Model work's model when akm names none: the model selected in the user's
 * OpenCode config, with its provider when the config defines one. An API key
 * is referenced by its environment variable, never copied; a provider the user
 * logged into keeps its credentials in OpenCode's data directory.
 */
function userOpencodeModel(): Record<string, unknown> {
  const imported = openCodeImporter.importConfig();
  if (!imported?.provider || !imported.model) return {};
  const model = `${imported.provider}/${imported.model}`;
  if (!imported.baseUrl) return { model };
  return {
    model,
    provider: {
      [imported.provider]: {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: canonicalProviderBase(imported.baseUrl),
          ...(imported.apiKeyEnvVar ? { apiKey: `{env:${imported.apiKeyEnvVar}}` } : {}),
        },
        models: { [imported.model]: {} },
      },
    },
  };
}

// ── Hosts ──────────────────────────────────────────────────────────────────

/** One embedded OpenCode per distinct configuration, for the life of the process. */
const hosts = new Map<string, Promise<Host>>();
let createHost: (options: CreateOptions) => Promise<Host> = async (options) =>
  (await import("@opencode/sdk")).OpenCode.create(options);

/** Test seam: replace `OpenCode.create`. Pass null to restore it. */
export function __setHostFactory(factory: ((options: CreateOptions) => Promise<Host>) | null): void {
  createHost = factory ?? (async (options) => (await import("@opencode/sdk")).OpenCode.create(options));
}

/** akm's read tools as an OpenCode plugin. */
const AKM_TOOLS_PLUGIN = {
  id: "akm-read-tools",
  setup: async (ctx: {
    tool: { transform: (edit: (editor: { add: (tool: unknown) => void }) => void) => unknown };
  }) => {
    await ctx.tool.transform((editor) => {
      for (const tool of AKM_READ_TOOLS) {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.inputSchema,
          options: { codemode: false },
          execute: async (input: unknown) => {
            try {
              return { content: await tool.run(isRecord(input) ? input : {}) };
            } catch (error) {
              return { content: `${tool.name} failed: ${toErrorMessage(error)}` };
            }
          },
        });
      }
    });
  },
} as unknown as SdkPlugin;

/** Answer everything that would wait for a person: every session on akm's host is unattended. */
async function answerRequests(host: Host, signal: AbortSignal): Promise<void> {
  try {
    for await (const event of host.events.subscribe({ signal }) as AsyncIterable<unknown>) {
      if (!isRecord(event) || !isRecord(event.data)) continue;
      const data = event.data;
      if (event.type === "permission.asked" && typeof data.id === "string" && typeof data.sessionID === "string") {
        await host.permission
          .reply({ sessionID: data.sessionID, requestID: data.id, decision: "reject", message: NOBODY_TO_ASK })
          .catch(() => {});
      } else if (event.type === "form.created" && isRecord(data.form) && typeof data.form.id === "string") {
        const sessionID = typeof data.form.sessionID === "string" ? data.form.sessionID : undefined;
        if (!sessionID) continue;
        await host.sessions.form
          .cancel({ sessionID, formID: data.form.id, message: NOBODY_TO_ASK } as never)
          .catch(() => {});
      }
    }
  } catch {
    // The host closed.
  }
}

function hostFor(key: string, options: CreateOptions): Promise<Host> {
  let host = hosts.get(key);
  if (!host) {
    host = createHost({ ...options, log: { level: "error", emit: () => {} } } as CreateOptions).then((created) => {
      const stop = new AbortController();
      void answerRequests(created, stop.signal);
      const close = created.close.bind(created);
      return Object.assign(created, {
        close: async () => {
          stop.abort();
          await close();
        },
      });
    });
    host.catch(() => hosts.delete(key));
    hosts.set(key, host);
  }
  return host;
}

function agentHost(content: Record<string, unknown>): Promise<Host> {
  const text = JSON.stringify(content);
  return hostFor(`agent:${text}`, {
    database: { path: akmOpencodeDatabasePath() },
    ...(Object.keys(content).length > 0 ? { config: { content: text } } : {}),
  } as CreateOptions);
}

function modelWorkHost(content: Record<string, unknown>): Promise<Host> {
  const text = JSON.stringify(content);
  const directory = path.join(getCacheDir(), "opencode-model-work");
  fs.mkdirSync(directory, { recursive: true });
  return hostFor(`model-work:${text}`, {
    database: { path: akmOpencodeDatabasePath() },
    config: { directory, project: false, claude: false, content: text },
    plugins: [AKM_TOOLS_PLUGIN],
  } as CreateOptions);
}

/** Close every embedded OpenCode this process started. */
export async function closeOpencodeSdk(): Promise<void> {
  const open = [...hosts.values()];
  hosts.clear();
  await Promise.all(open.map(async (host) => (await host.catch(() => undefined))?.close().catch(() => {})));
}

// ── One turn ───────────────────────────────────────────────────────────────

interface Assistant {
  readonly type: "assistant";
  readonly finish?: string;
  readonly error?: { readonly type: string; readonly message: string };
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly tokens?: { readonly input?: number; readonly output?: number; readonly reasoning?: number };
}
interface Turn {
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly assistants: readonly Assistant[];
  readonly error?: { readonly type: string; readonly message: string };
}

/** The messages after the user message `userId`, oldest first; undefined until it is found. Pages the full history, so a compaction cannot hide it. */
async function messagesAfter(host: Host, sessionID: string, userId: string): Promise<unknown[] | undefined> {
  const newestFirst: unknown[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = (await host.message.list({
      sessionID,
      order: "desc",
      limit: 200,
      ...(cursor ? { cursor } : {}),
    } as never)) as {
      data: unknown[];
      cursor?: { next?: string | null };
    };
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

function turnResult(turn: Turn): {
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

const TIMED_OUT = Symbol("timed out");
const ABORTED = Symbol("aborted");

/** Race `work` against the deadline and the caller's signal. */
function bounded<T>(
  work: Promise<T>,
  deadline: number | null,
  signal: AbortSignal | undefined,
  timers: { set: typeof setTimeout; clear: typeof clearTimeout },
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

/** Prompt, then wait until the turn has finished. */
async function runTurn(host: Host, sessionID: string, prompt: string, signal: AbortSignal): Promise<Turn> {
  const user = (await host.sessions.prompt({ sessionID, text: prompt } as never, { signal } as never)) as {
    id: string;
  };
  for (;;) {
    await host.sessions.wait({ sessionID } as never, { signal } as never);
    const after = await messagesAfter(host, sessionID, user.id);
    const turn = after && finishedTurn(after);
    if (turn) return turn;
    // `wait` can return before the queued prompt starts.
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (signal.aborted) throw new Error("OpenCode prompt cancelled");
  }
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

/**
 * Run one prompt on an embedded OpenCode. `llm` is the engine's fallback LLM
 * connection, used when akm supplies the endpoint.
 */
export async function runOpencodeSdk(
  profile: AgentProfile,
  prompt: string,
  opts: RunAgentOptions = {},
  llm?: LlmConnectionConfig,
): Promise<AgentRunResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  const deadline = timeoutMs === null ? null : start + timeoutMs;
  const timers = { set: opts.setTimeoutFn ?? setTimeout, clear: opts.clearTimeoutFn ?? clearTimeout };
  const name = `opencode-sdk agent "${profile.name}"`;
  if (opts.signal?.aborted) return failed(start, "aborted", `${name} not started: caller signal already aborted`);

  const dispatch = opts.dispatch;
  const modelWork = dispatch?.modelWork === true;
  const model = dispatch?.model ?? profile.model ?? llm?.model;
  let content = modelConfig(model, llm, dispatch?.inference);
  if (modelWork && !content.model) content = { ...userOpencodeModel(), ...content };
  const capabilities = modelWork ? MODEL_WORK_CAPABILITIES : dispatch?.permissions;

  const run = new AbortController();
  const forwardAbort = (): void => run.abort();
  opts.signal?.addEventListener("abort", forwardAbort, { once: true });
  let host: Host | undefined;
  let sessionId: string | undefined;
  try {
    const started = await bounded(
      modelWork ? modelWorkHost(content) : agentHost(content),
      deadline,
      run.signal,
      timers,
    );
    if (started === ABORTED) return failed(start, "aborted", `${name} aborted by caller signal during startup`);
    if (started === TIMED_OUT) return failed(start, "timeout", `${name} timed out during startup after ${timeoutMs}ms`);
    host = started;

    const session = (await host.sessions.create({
      title: "akm",
      metadata: { akm: modelWork ? "model-work" : "agent" },
      ...(opts.cwd ? { location: { directory: opts.cwd } } : {}),
      ...(!modelWork && dispatch?.agent ? { agent: dispatch.agent } : {}),
      ...(capabilities ? { permissions: capabilityPermissions(capabilities) } : {}),
    } as never)) as { id: string };
    sessionId = session.id;
    if (dispatch?.systemPrompt) {
      await host.sessions.instructions.entry.put({
        sessionID: session.id,
        key: "akm.system",
        value: dispatch.systemPrompt,
      } as never);
    }

    const turn = await bounded(runTurn(host, session.id, prompt, run.signal), deadline, run.signal, timers);
    if (turn === ABORTED || turn === TIMED_OUT) {
      void host.sessions.interrupt({ sessionID: session.id } as never).catch(() => {});
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
  }
}
