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
 *   plugins, MCP servers or agents load. Its tools are OpenCode's read-only
 *   ones and akm's read tools, which run in-process. Credentials stay where
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
import { warnOnce } from "../../../core/warn";
import type { ExecutionJsonObject } from "../../../execution/json";
import { AKM_READ_TOOLS } from "../../agent/akm-read-tools";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../agent/config";
import type { AgentProfile } from "../../agent/profiles";
import type { AgentFailureReason, AgentRunResult, AgentTokenUsage, RunAgentOptions } from "../../agent/spawn";
import { openCodeImporter } from "../opencode/config-import";
import { opencodeModelEntry } from "./model-entry";

type Host = OpenCode.Interface;
type CreateOptions = OpenCode.CreateOptions;
type SdkPlugin = NonNullable<CreateOptions["plugins"]>[number];

/** The message the model gets when akm declines something only a person could answer. */
const NOBODY_TO_ASK =
  "This is an unattended run: nobody can answer questions or approve requests. Continue without it.";

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

/** Model work reads but changes nothing: OpenCode's tools that write, run commands or start subagents are denied. */
const MODEL_WORK_PERMISSIONS = ["edit", "write", "shell", "execute", "subagent"].map((action) => ({
  action,
  resource: "*",
  effect: "deny",
}));

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
 *
 * Inference reaches a model akm supplies in full. On a `provider/model` from
 * the user's OpenCode config it is laid over that model, best effort: OpenCode
 * merges some fields and not others, so akm warns once.
 */
export function modelConfig(
  named: string | undefined,
  llm: LlmConnectionConfig | undefined,
  inference: ExecutionJsonObject | null | undefined,
): Record<string, unknown> {
  const model = named ?? llm?.model;
  const merged = inference === null ? undefined : { ...fallbackInference(llm), ...inference };
  const entry = opencodeModelEntry(merged);
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
  if (!model) return {};
  const slash = model.indexOf("/");
  if (slash <= 0 || Object.keys(entry).length === 0) return { model };
  warnOnce(
    `opencode-sdk-inference-overlay:${model}`,
    `[akm] OpenCode model ${JSON.stringify(model)} comes from your OpenCode config, so akm applies its inference settings (${Object.keys(merged ?? {}).join(", ")}) best effort, and OpenCode may ignore some. Give the engine an llmEngine, or set them in your OpenCode config, to apply them reliably.`,
  );
  return { model, provider: { [model.slice(0, slash)]: { models: { [model.slice(slash + 1)]: entry } } } };
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
const createEmbedded = async (options: CreateOptions): Promise<Host> =>
  (await import("@opencode/sdk")).OpenCode.create(options);
let createHost = createEmbedded;

/** Test seam: replace `OpenCode.create`; undefined restores it. Hosts already open are closed. */
export function _setOpencodeHostFactoryForTests(
  factory: ((options: CreateOptions) => Promise<Host>) | undefined,
): void {
  createHost = factory ?? createEmbedded;
  void closeOpencodeSdk();
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

// ── Session history ────────────────────────────────────────────────────────

/** A top-level session in an OpenCode 2 database. */
export interface OpencodeStoredSession {
  readonly id: string;
  readonly title?: string;
  readonly directory?: string;
  readonly created: number;
  readonly updated: number;
}

/**
 * An embedded OpenCode that only reads the database at `dbPath`: an empty
 * config (no plugins, MCP servers or agents) and no model catalog fetch.
 */
function sessionStoreHost(dbPath: string): Promise<Host> {
  const directory = path.join(getCacheDir(), "opencode-session-store");
  fs.mkdirSync(directory, { recursive: true });
  return hostFor(`store:${dbPath}`, {
    database: { path: dbPath },
    config: { directory, project: false, claude: false },
    models: { fetch: false },
  } as CreateOptions);
}

/** Close the session-store host for `dbPath`, for a database copy that is about to be removed. */
export async function closeOpencodeSessionStore(dbPath: string): Promise<void> {
  const key = `store:${dbPath}`;
  const host = hosts.get(key);
  hosts.delete(key);
  await (await host?.catch(() => undefined))?.close().catch(() => {});
}

/** The top-level sessions in the OpenCode 2 database at `dbPath`, newest first, without akm's model-work sessions. */
export async function listOpencodeSessions(dbPath: string): Promise<OpencodeStoredSession[]> {
  const host = await sessionStoreHost(dbPath);
  const sessions: OpencodeStoredSession[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = (await host.sessions.list({
      limit: 200,
      ...(cursor ? { cursor } : { parentID: null, order: "desc" }),
    } as never)) as { data: unknown[]; cursor?: { next?: string | null } };
    for (const session of page.data) {
      if (!isRecord(session) || typeof session.id !== "string") continue;
      if (isRecord(session.metadata) && session.metadata.akm === "model-work") continue;
      sessions.push(storedSession(session));
    }
    if (!page.cursor?.next || page.data.length === 0) break;
    cursor = page.cursor.next;
  }
  return sessions.sort((a, b) => b.updated - a.updated);
}

/** One session and its messages, oldest first; undefined when the database has no such session. */
export async function readOpencodeSession(
  dbPath: string,
  sessionId: string,
): Promise<{ session: OpencodeStoredSession; messages: unknown[] } | undefined> {
  const host = await sessionStoreHost(dbPath);
  const session = await host.sessions.get({ sessionID: sessionId } as never).catch(() => undefined);
  if (!isRecord(session) || typeof session.id !== "string") return undefined;
  const messages: unknown[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = (await host.message.list({
      sessionID: sessionId,
      limit: 200,
      ...(cursor ? { cursor } : { order: "asc" }),
    } as never)) as { data: unknown[]; cursor?: { next?: string | null } };
    messages.push(...page.data);
    if (!page.cursor?.next || page.data.length === 0) break;
    cursor = page.cursor.next;
  }
  return { session: storedSession(session), messages };
}

function storedSession(session: Record<string, unknown>): OpencodeStoredSession {
  const time = isRecord(session.time) ? session.time : {};
  const location = isRecord(session.location) ? session.location : {};
  return {
    id: session.id as string,
    ...(typeof session.title === "string" && session.title ? { title: session.title } : {}),
    ...(typeof location.directory === "string" && location.directory ? { directory: location.directory } : {}),
    created: typeof time.created === "number" ? time.created : 0,
    updated: typeof time.updated === "number" ? time.updated : 0,
  };
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
    // A cursor carries its page's order; OpenCode refuses one combined with `order`.
    const page = (await host.message.list({
      sessionID,
      limit: 200,
      ...(cursor ? { cursor } : { order: "desc" }),
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
  let content = modelConfig(dispatch?.model ?? profile.model, llm, dispatch?.inference);
  if (modelWork && !content.model) content = { ...userOpencodeModel(), ...content };

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
      ...(modelWork ? { permissions: MODEL_WORK_PERMISSIONS } : {}),
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
