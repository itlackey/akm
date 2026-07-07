// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode SDK agent runner (migrated from `agent/sdk-runner.ts`, #564).
 *
 * Uses the embedded `@opencode-ai/sdk` instead of `Bun.spawn`. Requires no
 * agent CLI binary to be installed. The user provides an OpenAI-compatible
 * endpoint (or inherits from config.llm) for the SDK.
 *
 * This is the runtime surface of the {@link OpencodeSdkHarness} (`id =
 * 'opencode-sdk'`). It is the dispatch path for `sdkMode` profiles; it exposes
 * no native session logs of its own (`capabilities.sessionLogs = false`).
 *
 * ## Per-call cwd and env (redesign addendum R2, open seam decision 1)
 *
 * The plan left one decision open: per-call cwd/env forwarding vs a server
 * keyed by `(cwd, envKeysHash)`. Reading the SDK settled it as a SPLIT — the
 * two halves have different API realities (verified against
 * `@opencode-ai/sdk` 1.2.20):
 *
 *   - **cwd is PER-CALL.** `session.create` / `session.prompt` /
 *     `session.delete` all accept a `query.directory` parameter that scopes
 *     the session's working directory, so a single server can host sessions
 *     in any number of working directories. {@link RunAgentOptions.cwd} is
 *     forwarded as `query: { directory }` on every session call — no
 *     per-cwd server processes, no server-key explosion for worktree
 *     isolation (which mints a fresh directory per unit attempt).
 *
 *   - **env is PER-SERVER (keyed registry).** The SDK exposes NO per-call or
 *     per-session env surface; the only way env reaches tool child processes
 *     is the `opencode serve` process environment, which
 *     `createOpencodeServer` copies from `process.env` **synchronously**
 *     (its `spawn` call runs before its first `await`, so the snapshot is
 *     taken inside our call frame). {@link getOrStartServer} therefore keys
 *     servers by a hash of the FULL env binding entries (keys AND values —
 *     two bindings that share keys but differ in values must not share a
 *     server), overlays the bindings onto `process.env` for exactly the
 *     synchronous prefix of the `createOpencode` call, and restores the
 *     previous values before awaiting. JavaScript's single-threaded event
 *     loop makes that overlay window atomic: no concurrently-running akm
 *     code can observe the mutated environment. Units with the same
 *     bindings share one server; units with none share the default server
 *     (byte-identical to the pre-R2 singleton behavior).
 *
 * This is what removed the workflow engine's `env_unsupported` hard-fail for
 * the sdk runner: injection genuinely reaches the child, because tool
 * subprocesses (bash etc.) inherit the server process environment.
 */

import { createHash } from "node:crypto";
import { type LlmConnectionConfig, resolveSecret } from "../../../core/config/config";
import type { ShowResponse } from "../../../sources/types";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../agent/config";
import { resolveModel } from "../../agent/model-aliases";
import type { AgentProfile } from "../../agent/profiles";
import type { AgentFailureReason, AgentRunResult, AgentTokenUsage, RunAgentOptions } from "../../agent/spawn";

/** Per-call working-directory scope (see module doc — SDK `query.directory`). */
interface SdkDirectoryQuery {
  directory?: string;
}

/** Minimal surface of the OpenCode SDK client used by this runner. */
interface SdkClient {
  session: {
    create(args: { body: { title: string }; query?: SdkDirectoryQuery }): Promise<{ data?: { id?: string } }>;
    prompt(args: {
      path: { id: string };
      // `system` and `tools` are forwarded when present — see the #564 bug
      // fixes in runOpencodeSdk(). They mirror @opencode-ai/sdk's
      // SessionPromptData.body shape (system?: string; tools?: Record<string, boolean>).
      body: {
        parts: { type: string; text: string }[];
        system?: string;
        tools?: Record<string, boolean>;
      };
      query?: SdkDirectoryQuery;
    }): Promise<{
      data?: {
        // AssistantMessage projection (SDK 1.2.20 types.gen.d.ts): token
        // accounting lives on info.tokens. Fields optional here so a fake or
        // an older server that omits them cannot crash extraction.
        info?: { tokens?: { input?: number; output?: number; reasoning?: number } };
        parts?: { type: string; text?: string }[];
      };
    }>;
    delete(args: { path: { id: string }; query?: SdkDirectoryQuery }): Promise<unknown>;
  };
}

/** Typed server instance returned by `createOpencode`. */
interface SdkServer {
  client: SdkClient;
  server: { close(): void };
}

/** The `createOpencode` surface this runner needs (real SDK or test fake). */
type SdkServerFactory = (options: { config?: Record<string, unknown> }) => Promise<SdkServer>;

// Server registry — one server per env-binding signature, started lazily and
// reused across calls. The default (no env bindings) key is "" and behaves
// exactly like the pre-R2 process-wide singleton.
const _servers = new Map<string, Promise<SdkServer>>();

// Test override: when set, every call uses this server (all keys) and no real
// server is ever started.
let _testServer: SdkServer | null = null;

// Test seam replacing the real `createOpencode` import (see __setServerFactory).
let _serverFactory: SdkServerFactory | null = null;

let _exitHookInstalled = false;

/**
 * Test-only seam: inject a fake {@link SdkServer} so `runOpencodeSdk` can be
 * exercised without the real `@opencode-ai/sdk` (which would spin up a server).
 * Pass `null` to clear. NOT part of the public runtime API — used only to
 * assert the #564 bug fixes (systemPrompt/tools forwarding + timeout). The
 * leading underscores mark it as internal.
 */
export function __setTestServer(server: SdkServer | null): void {
  _testServer = server;
}

/**
 * Test-only seam: replace the `createOpencode` factory so the env-keyed
 * server registry (module doc, *Per-call cwd and env*) can be exercised
 * without the real SDK. The fake MUST read whatever `process.env` state it
 * cares about in its SYNCHRONOUS prefix — exactly like the real
 * `createOpencodeServer`, whose `spawn` snapshot happens before its first
 * await — because the runner restores the env overlay as soon as the factory
 * call returns its promise. Pass `null` to clear.
 */
export function __setServerFactory(factory: SdkServerFactory | null): void {
  _serverFactory = factory;
}

/**
 * Close every started OpenCode SDK server and reset the registry (and any
 * injected test server). Primarily for use in tests to ensure clean teardown
 * between test runs; also wired to process exit.
 */
export function closeServer(): void {
  for (const pending of _servers.values()) {
    pending
      .then((s) => {
        try {
          s.server.close();
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
  }
  _servers.clear();
  try {
    _testServer?.server.close();
  } catch {
    /* ignore */
  }
  _testServer = null;
}

/**
 * Convert an `AgentDispatchRequest.tools` policy into the SDK's tool-allowlist
 * shape (`{ [toolName]: boolean }`).
 *
 * #564 bug fix (2): the tool list was previously dropped entirely. The CLI
 * builder passes tools as a comma-separated `--allowedTools` flag; the SDK
 * instead wants a per-tool boolean map. A list/comma-string of tool names is
 * treated as an allowlist (each name → true). A structured policy object whose
 * values are already booleans is forwarded as-is.
 *
 * Returns `undefined` when there is nothing to forward, so an absent policy
 * leaves the SDK's own defaults untouched (behaviour-preserving for callers
 * that pass no tools).
 */
function toolsToSdkAllowlist(tools: ShowResponse["toolPolicy"]): Record<string, boolean> | undefined {
  if (tools === undefined || tools === null) return undefined;
  const names: string[] = [];
  if (typeof tools === "string") {
    names.push(
      ...tools
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    );
  } else if (Array.isArray(tools)) {
    for (const t of tools) {
      if (typeof t === "string" && t.trim()) names.push(t.trim());
    }
  } else if (typeof tools === "object") {
    // Structured policy: forward boolean entries directly.
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(tools as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  if (names.length === 0) return undefined;
  const out: Record<string, boolean> = {};
  for (const n of names) out[n] = true;
  return out;
}

/**
 * Assemble the OpenCode SDK server config from the profile + LLM fallback.
 * Pure and exported for tests. `profile.model` is resolved through the model
 * alias tables (platform key `"opencode-sdk"`) so config aliases like
 * `"model": "fast"` work on the SDK path the same way they do for CLI
 * builders. Note there is no built-in alias column for `opencode-sdk` —
 * built-in opus/sonnet/haiku strings are CLI-provider-qualified and would
 * collide with the `akm-custom/` provider prefixing below, so only profile
 * and config-root alias tables apply here.
 */
export function buildSdkConfig(profile: AgentProfile, llmConfig?: LlmConnectionConfig): Record<string, unknown> {
  // Resolve endpoint and model: profile fields take precedence over config.llm
  const endpoint = profile.endpoint ?? llmConfig?.endpoint;
  const apiKey = resolveSecret(profile.apiKey ?? llmConfig?.apiKey);
  const model = profile.model
    ? resolveModel(profile.model, "opencode-sdk", profile.modelAliases, profile.globalModelAliases)
    : undefined;

  const sdkConfig: Record<string, unknown> = {};
  if (model) sdkConfig.model = model;
  if (endpoint || apiKey) {
    // Configure a custom OpenAI-compatible provider
    sdkConfig.provider = {
      "akm-custom": {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: endpoint?.replace(/\/chat\/completions$/, "").replace(/\/$/, ""),
          ...(apiKey ? { apiKey } : {}),
        },
      },
    };
    // Use the custom provider's model if not already qualified
    if (model && !model.includes("/")) {
      sdkConfig.model = `akm-custom/${model}`;
    }
  }
  return sdkConfig;
}

/**
 * Stable key for the env-keyed server registry: sha256 over the SORTED
 * binding entries (keys AND values — see module doc), "" when no bindings.
 */
function envServerKey(env: Record<string, string> | undefined): string {
  if (!env || Object.keys(env).length === 0) return "";
  const entries = Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/**
 * Overlay `env` onto `process.env`, returning a restore function. The
 * overlay is intended to live only for the SYNCHRONOUS prefix of the server
 * factory call (module doc): mutation → factory() → restore happens in one
 * uninterruptible event-loop turn, so no other code observes it.
 */
function overlayProcessEnv(env: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, prior] of previous) {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  };
}

async function startServer(
  profile: AgentProfile,
  llmConfig: LlmConnectionConfig | undefined,
  env: Record<string, string> | undefined,
): Promise<SdkServer> {
  const factory: SdkServerFactory =
    _serverFactory ??
    (
      (await import("@opencode-ai/sdk").catch(() => {
        throw new Error("OpenCode SDK not available. Install @opencode-ai/sdk or configure a CLI agent instead.");
      })) as { createOpencode: SdkServerFactory }
    ).createOpencode;

  const sdkConfig = buildSdkConfig(profile, llmConfig);
  const options = Object.keys(sdkConfig).length > 0 ? { config: sdkConfig } : {};

  // Env injection (module doc): the SDK's createOpencodeServer snapshots
  // process.env synchronously (its spawn precedes its first await), so the
  // overlay only needs to survive the factory's synchronous prefix. Restore
  // BEFORE awaiting, so nothing else ever runs under the mutated env.
  let pending: Promise<SdkServer>;
  if (env && Object.keys(env).length > 0) {
    const restore = overlayProcessEnv(env);
    try {
      pending = factory(options);
    } finally {
      restore();
    }
  } else {
    pending = factory(options);
  }

  const server = await pending;
  if (!server) throw new Error("Failed to initialise OpenCode SDK server.");

  if (!_exitHookInstalled) {
    _exitHookInstalled = true;
    process.once("exit", () => {
      closeServer();
    });
  }
  return server;
}

/**
 * Get (or lazily start) the server for this call's env bindings. Servers are
 * keyed by {@link envServerKey}; concurrent callers of the same key share one
 * start (the registry stores the in-flight promise). A failed start is
 * evicted so the next call can retry instead of caching the error forever.
 */
async function getOrStartServer(
  profile: AgentProfile,
  llmConfig?: LlmConnectionConfig,
  env?: Record<string, string>,
): Promise<SdkServer> {
  if (_testServer) return _testServer;
  const key = envServerKey(env);
  let pending = _servers.get(key);
  if (!pending) {
    pending = startServer(profile, llmConfig, env);
    _servers.set(key, pending);
    pending.catch(() => {
      if (_servers.get(key) === pending) _servers.delete(key);
    });
  }
  return pending;
}

/**
 * Extract best-effort token usage from a prompt response. Only numeric
 * fields the server actually reported are copied; returns undefined when
 * nothing usable is present (older servers, test fakes).
 */
function extractUsage(info?: {
  tokens?: { input?: number; output?: number; reasoning?: number };
}): AgentTokenUsage | undefined {
  const tokens = info?.tokens;
  if (!tokens) return undefined;
  const usage: AgentTokenUsage = {};
  if (typeof tokens.input === "number" && Number.isFinite(tokens.input)) usage.inputTokens = tokens.input;
  if (typeof tokens.output === "number" && Number.isFinite(tokens.output)) usage.outputTokens = tokens.output;
  if (typeof tokens.reasoning === "number" && Number.isFinite(tokens.reasoning)) {
    usage.reasoningTokens = tokens.reasoning;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export async function runOpencodeSdk(
  profile: AgentProfile,
  prompt: string,
  opts: RunAgentOptions = {},
  llmConfig?: LlmConnectionConfig,
): Promise<AgentRunResult> {
  const start = Date.now();

  if (opts.signal?.aborted) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      durationMs: 0,
      exitCode: null,
      reason: "aborted" as AgentFailureReason,
      error: `opencode-sdk agent "${profile.name}" not started: caller signal already aborted`,
    };
  }

  let client: SdkClient;
  try {
    ({ client } = await getOrStartServer(profile, llmConfig, opts.env));
  } catch (e) {
    return {
      ok: false,
      stdout: "",
      stderr: String(e),
      durationMs: Date.now() - start,
      exitCode: 1,
      reason: "spawn_failed" as AgentFailureReason,
      error: String(e),
    };
  }

  // Per-call working directory (module doc): forwarded as the SDK's
  // `query.directory` on every session call, so worktree-isolated units run
  // in their own checkout without a per-cwd server.
  const query: SdkDirectoryQuery | undefined = opts.cwd ? { directory: opts.cwd } : undefined;

  // One session per call — do NOT reuse (history accumulates, token costs grow)
  const sessionRes = await client.session.create({ body: { title: "akm" }, ...(query ? { query } : {}) });
  const sessionId = sessionRes.data?.id;
  if (!sessionId) {
    return {
      ok: false,
      stdout: "",
      stderr: "Failed to create session",
      durationMs: Date.now() - start,
      exitCode: 1,
      reason: "spawn_failed" as AgentFailureReason,
      error: "Failed to create OpenCode session",
    };
  }

  // #564 bug fixes (1) + (2): forward systemPrompt and tools from the abstract
  // dispatch request. Both were previously accepted on AgentDispatchRequest but
  // silently dropped on the SDK path, so SDK-mode dispatch ignored agent-asset
  // system prompts and tool policies entirely (the CLI path honours both).
  const dispatch = opts.dispatch;
  const system = dispatch?.systemPrompt;
  const tools = toolsToSdkAllowlist(dispatch?.tools);
  const body: {
    parts: { type: string; text: string }[];
    system?: string;
    tools?: Record<string, boolean>;
  } = { parts: [{ type: "text", text: prompt }] };
  if (system) body.system = system;
  if (tools) body.tools = tools;

  // #564 bug fix (3): enforce a hard timeout like the CLI path (runAgent).
  // Previously runOpencodeSdk() awaited session.prompt() with no timeout, so a
  // hung SDK call (e.g. a stalled local-model endpoint) blocked the caller
  // indefinitely while the CLI path would have killed the process. We resolve
  // the same budget runAgent uses (opts.timeoutMs override → profile.timeoutMs
  // → DEFAULT_AGENT_TIMEOUT_MS) and race the prompt against it. null disables
  // the timer (parity with runAgent's "no timeout" contract). There is no
  // OS process to SIGTERM/SIGKILL here, so on timeout we best-effort delete the
  // session (the SDK's equivalent of reaping the in-flight work) and return a
  // structured `timeout` failure with the same reason vocabulary as the CLI.
  const timeoutMs: number | null =
    opts.timeoutMs !== undefined ? opts.timeoutMs : (profile.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS);
  const setTimeoutImpl = opts.setTimeoutFn ?? setTimeout;
  const clearTimeoutImpl = opts.clearTimeoutFn ?? clearTimeout;

  let timer: ReturnType<typeof setTimeoutImpl> | undefined;
  const TIMED_OUT = Symbol("opencode-sdk-timeout");
  const ABORTED = Symbol("opencode-sdk-aborted");

  // Cooperative cancel: there is no OS process to signal, so an abort simply
  // wins the race below; the finally block reaps the in-flight session, same
  // as the timeout path.
  let onAbort: (() => void) | undefined;
  const abortSignal = opts.signal;

  try {
    const promptPromise = client.session.prompt({ path: { id: sessionId }, body, ...(query ? { query } : {}) });
    type PromptResult = Awaited<typeof promptPromise>;

    const racers: Promise<PromptResult | typeof TIMED_OUT | typeof ABORTED>[] = [promptPromise];
    if (timeoutMs !== null) {
      racers.push(
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeoutImpl(() => resolve(TIMED_OUT), timeoutMs);
        }),
      );
    }
    if (abortSignal) {
      racers.push(
        new Promise<typeof ABORTED>((resolve) => {
          onAbort = () => resolve(ABORTED);
          if (abortSignal.aborted) onAbort();
          else abortSignal.addEventListener("abort", onAbort, { once: true });
        }),
      );
    }

    const result = racers.length === 1 ? await promptPromise : await Promise.race(racers);

    if (result === ABORTED) {
      return {
        ok: false,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - start,
        exitCode: null,
        reason: "aborted" as AgentFailureReason,
        error: `opencode-sdk agent "${profile.name}" aborted by caller signal`,
        sessionId,
      };
    }

    if (result === TIMED_OUT) {
      return {
        ok: false,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - start,
        exitCode: null,
        reason: "timeout" as AgentFailureReason,
        error: `opencode-sdk agent "${profile.name}" timed out after ${timeoutMs}ms`,
        sessionId,
      };
    }

    const parts = result.data?.parts ?? [];
    const textPart = parts.find((p) => p.type === "text");
    const stdout = textPart?.text ?? "";
    // Token accounting from the AssistantMessage (previously discarded) —
    // the seam that makes workflow budget.maxTokens meterable on the
    // default sdk runner.
    const usage = extractUsage(result.data?.info);

    return {
      ok: true,
      stdout,
      stderr: "",
      durationMs: Date.now() - start,
      exitCode: 0,
      sessionId,
      ...(usage ? { usage } : {}),
    };
  } catch (e) {
    return {
      ok: false,
      stdout: "",
      stderr: String(e),
      durationMs: Date.now() - start,
      exitCode: 1,
      reason: "non_zero_exit" as AgentFailureReason,
      error: String(e),
      sessionId,
    };
  } finally {
    if (timer !== undefined) clearTimeoutImpl(timer);
    if (abortSignal && onAbort) abortSignal.removeEventListener("abort", onAbort);
    // Clean up session to prevent disk accumulation in ~/.local/share/opencode/
    await client.session.delete({ path: { id: sessionId }, ...(query ? { query } : {}) }).catch(() => {});
  }
}
