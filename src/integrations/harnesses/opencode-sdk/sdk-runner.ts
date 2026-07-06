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
 */

import { type LlmConnectionConfig, resolveSecret } from "../../../core/config/config";
import type { ShowResponse } from "../../../sources/types";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../agent/config";
import { resolveModel } from "../../agent/model-aliases";
import type { AgentProfile } from "../../agent/profiles";
import type { AgentFailureReason, AgentRunResult, AgentTokenUsage, RunAgentOptions } from "../../agent/spawn";

/** Minimal surface of the OpenCode SDK client used by this runner. */
interface SdkClient {
  session: {
    create(args: { body: { title: string } }): Promise<{ data?: { id?: string } }>;
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
    }): Promise<{
      data?: {
        // AssistantMessage projection (SDK 1.2.20 types.gen.d.ts): token
        // accounting lives on info.tokens. Fields optional here so a fake or
        // an older server that omits them cannot crash extraction.
        info?: { tokens?: { input?: number; output?: number; reasoning?: number } };
        parts?: { type: string; text?: string }[];
      };
    }>;
    delete(args: { path: { id: string } }): Promise<unknown>;
  };
}

/** Typed server instance returned by `createOpencode`. */
interface SdkServer {
  client: SdkClient;
  server: { close(): void };
}

// Singleton server — started once per process, reused across calls
let _server: SdkServer | null = null;

/**
 * Test-only seam: inject a fake {@link SdkServer} so `runOpencodeSdk` can be
 * exercised without the real `@opencode-ai/sdk` (which would spin up a server).
 * Pass `null` to clear. NOT part of the public runtime API — used only to
 * assert the #564 bug fixes (systemPrompt/tools forwarding + timeout). The
 * leading underscores mark it as internal.
 */
export function __setTestServer(server: SdkServer | null): void {
  _server = server;
}

/**
 * Close the singleton OpenCode SDK server and reset the handle.
 * Primarily for use in tests to ensure clean teardown between test runs.
 */
export function closeServer(): void {
  try {
    _server?.server.close();
  } catch {
    /* ignore */
  }
  _server = null;
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

async function getOrStartServer(profile: AgentProfile, llmConfig?: LlmConnectionConfig): Promise<SdkServer> {
  if (_server) return _server;

  const { createOpencode } = await import("@opencode-ai/sdk").catch(() => {
    throw new Error("OpenCode SDK not available. Install @opencode-ai/sdk or configure a CLI agent instead.");
  });

  const sdkConfig = buildSdkConfig(profile, llmConfig);

  _server = (await createOpencode(Object.keys(sdkConfig).length > 0 ? { config: sdkConfig } : {})) as SdkServer;

  process.once("exit", () => {
    closeServer();
  });

  if (!_server) throw new Error("Failed to initialise OpenCode SDK server.");
  return _server;
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
    ({ client } = await getOrStartServer(profile, llmConfig));
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

  // One session per call — do NOT reuse (history accumulates, token costs grow)
  const sessionRes = await client.session.create({ body: { title: "akm" } });
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
    const promptPromise = client.session.prompt({ path: { id: sessionId }, body });
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
    await client.session.delete({ path: { id: sessionId } }).catch(() => {});
  }
}
