// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode SDK agent runner (migrated from `agent/sdk-runner.ts`, #564).
 *
 * Uses the embedded `@opencode-ai/sdk` instead of `Bun.spawn` for dispatch, so
 * no agent CLI argv is ever constructed — but the SDK is not self-contained:
 * {@link createManagedOpencode} spawns `opencode serve` and talks HTTP to it,
 * so the `opencode` binary must be on PATH (which is why setup's
 * `detectHarness` gates this harness on that probe). The user provides an
 * OpenAI-compatible endpoint (or inherits from the selected fallback LLM
 * engine) for the SDK.
 *
 * This is the runtime surface of the {@link OpencodeSdkHarness} (`id =
 * 'opencode-sdk'`). It is the dispatch path for SDK runner specs; it exposes
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
 *     is the `opencode serve` process environment. {@link getOrStartServer}
 *     snapshots and materializes the complete child environment for each
 *     dispatch, passes it directly to the managed spawn (never mutating
 *     `process.env`), and hashes that exact canonical environment for registry
 *     identity. Identical child material shares one server; any material
 *     difference receives a separate server.
 *
 * This is what removed the workflow engine's `env_unsupported` hard-fail for
 * the sdk runner: injection genuinely reaches the child, because tool
 * subprocesses (bash etc.) inherit the server process environment.
 *
 * Registry hygiene (peer-review fixes):
 *
 *   - **Ports.** `createOpencodeServer` binds a FIXED default port (4096),
 *     so coexisting registry entries would contend for the same bind. Every
 *     entry is started on its own reserved OS-assigned port (see
 *     {@link startServer}).
 *   - **Shutdown.** {@link closeServer} closes resolved servers
 *     SYNCHRONOUSLY — it runs from `process.once('exit')`, where Bun never
 *     drains microtasks, so a `.then()`-based close would orphan every
 *     `opencode serve` child.
 *
 * Process-lifecycle note (owner finding 4): a cached `opencode serve` child is
 * a live OS handle that keeps Bun's event loop OPEN, so a one-shot CLI never
 * becomes idle and `process.once('exit')` never fires — the exit hook alone
 * cannot free a process the child is keeping alive (a deadlock that hangs the
 * caller after an otherwise-successful run). The registry is therefore drained
 * PROACTIVELY at the end of a dispatching command: the workflow engine calls
 * `disposeDispatchResources()` (→ {@link closeServer}) in composition-root and
 * workflow `finally` blocks.
 * The `process.once('exit')` hook stays as the last-resort backstop for paths
 * that never reach that drain.
 *
 * ## Managed server spawn (owner finding 4, live-harness follow-up)
 *
 * Draining the registry is necessary but NOT sufficient with the SDK's own
 * `createOpencodeServer`: its `close()` merely sends SIGTERM and it never
 * `unref()`s the child or its stdio pipes, so akm's event loop stays pinned
 * until the child ACTUALLY exits — and a real `opencode serve` (a live HTTP
 * server with provider children) can outlive SIGTERM long enough to hang the
 * caller indefinitely. {@link createManagedOpencode} therefore owns the spawn
 * (the SDK package is used only for `createOpencodeClient`).
 *
 * Owning the spawn changes the LIFECYCLE, not the REQUIREMENT: the SDK's
 * `createOpencodeServer` is itself a `spawn("opencode", ["serve", ...])`, and
 * the package declares `"dependencies": {}`, so `opencode` must be on PATH
 * either way. akm's version differs only in how it supervises the child:
 *
 *   - after the URL handshake, the child and its stdio are `unref()`ed /
 *     destroyed, so the handle can never hold akm open;
 *   - `close()` sends SIGTERM and arms a bounded grace timer
 *     ({@link SERVER_KILL_GRACE_MS}) that escalates to SIGKILL and is cleared
 *     on cooperative exit, so stubborn children cannot survive parent exit and
 *     stale timers cannot signal a reused PID;
 *   - the spawn receives the immutable per-dispatch environment directly, so
 *     asynchronous factory setup cannot race a temporary process-wide overlay.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isRecord } from "../../../core/common";
import type { LlmConnectionConfig } from "../../../core/config/config";
import { COMMON_SPAWN_ENV_PASSTHROUGH, spawnEnvNamesFor, XDG_BASE_DIR_ENV_PASSTHROUGH } from "../../../core/spawn-env";
import type { ExecutionJsonObject } from "../../../execution/json";
import { isModelWorkTools } from "../../../execution/source";
import type { ShowResponse } from "../../../sources/types";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../agent/config";
import type { AgentProfile } from "../../agent/profiles";
import type { AgentFailureReason, AgentRunResult, AgentTokenUsage, RunAgentOptions } from "../../agent/spawn";
import { opencodeInferenceConfig } from "../opencode/model-config";
import { MODEL_WORK_OPENCODE_AGENT, modelWorkOpencodeConfig } from "../opencode/model-work-agent";

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
      // SessionPromptData.body shape (agent?: string; system?: string; tools?: Record<string, boolean>).
      body: {
        parts: { type: string; text: string }[];
        agent?: string;
        system?: string;
        tools?: Record<string, boolean>;
      };
      query?: SdkDirectoryQuery;
    }): Promise<{
      // The client is created without `throwOnError`, so an HTTP error
      // resolves to `{ error }` (the parsed response body) instead of throwing.
      error?: unknown;
      data?: {
        // AssistantMessage projection (SDK 1.2.20 types.gen.d.ts): token
        // accounting lives on info.tokens, and a provider failure on
        // info.error. Fields optional here so a fake or an older server that
        // omits them cannot crash extraction.
        info?: { tokens?: { input?: number; output?: number; reasoning?: number }; error?: unknown };
        parts?: { type: string; text?: string }[];
      };
    }>;
    delete(args: { path: { id: string }; query?: SdkDirectoryQuery }): Promise<unknown>;
    // Optional so a fake that omits them cannot crash a dispatch; the real client has both.
    abort?(args: { path: { id: string }; query?: SdkDirectoryQuery }): Promise<unknown>;
  };
}

/** Typed server instance returned by `createOpencode`. */
interface SdkServer {
  client: SdkClient;
  server: { close(): void | Promise<void> };
}

/** The `createOpencode` surface this runner needs (real SDK or test fake). */
type SdkServerFactory = (options: {
  bin?: string;
  config?: Record<string, unknown>;
  port?: number;
  env: Record<string, string>;
  startupSignal: AbortSignal;
}) => Promise<SdkServer>;

interface SharedServerStart {
  promise: Promise<SdkServer>;
  controller: AbortController;
  waiters: number;
  server?: SdkServer;
}

// Server registry — one server per complete server-material signature. Caller
// deadlines race the shared promise independently; they never become startup
// configuration inherited by later callers.
const _servers = new Map<string, SharedServerStart>();

// Resolved servers by registry key, mirrored from `_servers` as each start
// promise settles. This exists so closeServer() can close started servers
// SYNCHRONOUSLY: it is wired to `process.once('exit')`, and Bun does not
// drain microtasks scheduled inside 'exit' handlers, so a `.then()`-based
// close never runs there and would orphan every `opencode serve` child.
const _resolvedServers = new Map<string, SdkServer>();

// Listen ports handed to non-default registry entries (see startServer) —
// tracked so two coexisting servers in this process can never be assigned
// the same port.
const _serverPorts = new Map<string, number>();

// Serializes probe-and-reserve so concurrent starts cannot claim one port.
let _portAllocationTail: Promise<void> = Promise.resolve();

/** The port `createOpencodeServer` binds when none is passed (SDK 1.2.20). */
const DEFAULT_SDK_PORT = 4096;

// Test override: when set, every call uses this server (all keys) and no real
// server is ever started.
let _testServer: SdkServer | null = null;

// Test seam replacing the real `createOpencode` import (see __setServerFactory).
let _serverFactory: SdkServerFactory | null = null;

let _exitHookInstalled = false;

/**
 * True once `process.on("exit")` has fired. Close paths consult it because an
 * exit handler runs after the event loop has stopped: no timer scheduled there
 * will ever fire, so any cleanup that needs to happen must happen inline.
 */
let _processExiting = false;

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
 * without the real SDK. The complete child environment is supplied as
 * `options.env`, so async factories observe the same immutable values as the
 * production spawn. Pass `null` to clear.
 */
export function __setServerFactory(factory: SdkServerFactory | null): void {
  _serverFactory = factory;
}

/**
 * Close every started OpenCode SDK server and reset the registry (and any
 * injected test server). Used by tests for clean teardown between runs and
 * wired to `process.once('exit')` — which is why resolved servers MUST be
 * closed synchronously here: Bun never drains microtasks scheduled inside
 * 'exit' handlers, so a promise-based close would silently orphan the
 * `opencode serve` children (leaking processes AND keeping their ports
 * bound for the next invocation).
 */
export async function closeServer(): Promise<void> {
  const closes: Promise<unknown>[] = [];
  for (const [key, entry] of _servers) {
    const resolved = _resolvedServers.get(key);
    if (resolved) {
      // Synchronous close — safe from the 'exit' hook.
      try {
        closes.push(Promise.resolve(resolved.server.close()));
      } catch {
        /* ignore */
      }
    } else {
      // Still starting: cancel the real managed spawn immediately. A custom
      // factory may ignore the signal; the registry settlement handler closes
      // any late result without awaiting it and pinning shutdown indefinitely.
      entry.controller.abort();
    }
  }
  _servers.clear();
  _resolvedServers.clear();
  _serverPorts.clear();
  try {
    if (_testServer) closes.push(Promise.resolve(_testServer.server.close()));
  } catch {
    /* ignore */
  }
  _testServer = null;
  await Promise.allSettled(closes);
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

/** The inference a fallback LLM connection carries, which opencode can take. */
function fallbackInference(llmConfig: LlmConnectionConfig | undefined): ExecutionJsonObject {
  const out: Record<string, unknown> = {};
  for (const key of ["temperature", "maxTokens", "contextLength", "enableThinking", "reasoningEffort"] as const) {
    if (llmConfig?.[key] !== undefined) out[key] = llmConfig[key];
  }
  return out as ExecutionJsonObject;
}

/**
 * Assemble the OpenCode SDK server config from the profile + LLM fallback.
 * Pure and exported for tests. `profile.model` is already exact because model
 * aliases resolve once before harness lowering. A server for model work also
 * defines the confined model-work agent (`../opencode/model-work-agent`).
 *
 * The model the config routes through `akm-custom` is declared in full, with
 * the dispatch's inference (`../opencode/model-config`): the fallback LLM
 * engine's, under `requestInference`, the request's own. For model work the
 * options go on the confined agent instead of the model, which needs no model
 * named: it runs whichever model opencode picks. A model the user's own opencode
 * config provides carries none: set inference there.
 */
export function buildSdkConfig(
  profile: AgentProfile,
  llmConfig?: LlmConnectionConfig,
  modelWork = false,
  requestInference?: ExecutionJsonObject | null,
): Record<string, unknown> {
  const endpoint = llmConfig?.endpoint;
  const apiKey = llmConfig?.apiKey;
  const profileModel = profile.model;
  const model = profileModel ?? llmConfig?.model;
  const inference = requestInference === null ? undefined : { ...fallbackInference(llmConfig), ...requestInference };
  const { entry, agentOptions } = opencodeInferenceConfig(inference, modelWork);

  const sdkConfig: Record<string, unknown> = {};
  if (model) sdkConfig.model = model;
  if (endpoint || apiKey) {
    // The first path segment selects the OpenCode provider. Model IDs may
    // themselves contain slashes, but still belong to this custom endpoint.
    const modelId = model?.startsWith("akm-custom/") ? model.slice("akm-custom/".length) : model;
    // Configure a custom OpenAI-compatible provider. OpenCode registers only
    // the models a custom provider lists, so the routed model is declared
    // (#1015: without it every dispatch failed with ProviderModelNotFoundError).
    sdkConfig.provider = {
      "akm-custom": {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: canonicalProviderBase(endpoint) ?? undefined,
          ...(apiKey ? { apiKey } : {}),
        },
        ...(modelId ? { models: { [modelId]: entry } } : {}),
      },
    };
    if (modelId) sdkConfig.model = `akm-custom/${modelId}`;
  }
  return modelWork ? { ...sdkConfig, ...modelWorkOpencodeConfig(agentOptions) } : sdkConfig;
}

/** Digest the executable and exact environment received by the child. */
function serverRegistryKey(profile: AgentProfile, env: Record<string, string>): string {
  const material = { bin: profile.bin, env };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(material)))
    .digest("hex");
}

/**
 * @internal Exact environment allowlist used to start the OpenCode SDK server:
 * the common baseline, the XDG base-directory variables opencode resolves its
 * config, data, cache and state from, and the profile's own names. The XDG names
 * are the server's, not the profile's: profile `envPassthrough` is frozen into
 * workflow plans, and an SDK profile's list has always been empty.
 */
export function opencodeSdkServerEnvironmentNames(profile: AgentProfile): string[] {
  return [
    ...new Set([
      ...spawnEnvNamesFor(COMMON_SPAWN_ENV_PASSTHROUGH),
      ...XDG_BASE_DIR_ENV_PASSTHROUGH,
      ...(profile.envPassthrough ?? []),
    ]),
  ];
}

function buildServerEnv(
  profile: AgentProfile,
  config: Record<string, unknown>,
  bindings: Record<string, string> | undefined,
  envSource: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of opencodeSdkServerEnvironmentNames(profile)) {
    const value = envSource[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(bindings ?? {})) env[key] = value;
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  return env;
}

function canonicalProviderBase(endpoint: string | undefined): string | null {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    url.pathname = url.pathname.replace(/\/chat\/completions$/, "").replace(/\/$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return endpoint.replace(/\/chat\/completions$/, "").replace(/\/$/, "");
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

/**
 * Ask the OS for a currently-free localhost port (bind :0, read the assigned
 * port, release it). Skips the SDK's fixed default port and any port already
 * handed to another registry entry in this process, so coexisting servers
 * never contend. The probe-then-use gap is the standard free-port race —
 * acceptable here because the failure mode is a clean `spawn_failed` on the
 * next dispatch, not corruption.
 */
async function allocateFreePort(registryKey: string): Promise<number> {
  let release!: () => void;
  const previous = _portAllocationTail;
  _portAllocationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const { createServer } = await import("node:net");
    const taken = new Set(_serverPorts.values());
    for (let attempt = 0; attempt < 10; attempt++) {
      const port = await new Promise<number>((resolve, reject) => {
        const probe = createServer();
        probe.unref();
        probe.on("error", reject);
        probe.listen(0, "127.0.0.1", () => {
          const address = probe.address();
          probe.close(() => {
            if (address && typeof address === "object") resolve(address.port);
            else reject(new Error("could not read the probe socket's port"));
          });
        });
      });
      if (port !== DEFAULT_SDK_PORT && !taken.has(port)) {
        _serverPorts.set(registryKey, port);
        return port;
      }
    }
    throw new Error("could not allocate a free port for the OpenCode SDK server");
  } finally {
    release();
  }
}

/** Grace between SIGTERM and SIGKILL when closing a managed server child. */
const SERVER_KILL_GRACE_MS = 2_000;

// Test seam: override the argv used to spawn the server child ("opencode"
// plus serve flags by default) so the managed-spawn lifecycle (handshake,
// unref, SIGTERM→SIGKILL escalation) is testable without the real binary.
let _serveCommand: string[] | null = null;

/** Test-only seam: replace the `opencode serve` argv. Pass `null` to clear. */
export function __setServeCommand(argv: string[] | null): void {
  _serveCommand = argv;
}

/**
 * Spawn-owning replacement for the SDK's `createOpencode` (module doc,
 * *Managed server spawn*). Mirrors `createOpencodeServer`'s contract — the
 * `spawn` receives the factory's immutable environment directly,
 * `OPENCODE_CONFIG_CONTENT` carries the config, the handshake parses the
 * "opencode server listening on <url>" line — but manages the child so its
 * handle can never pin akm's event loop:
 *
 *   - handshake success → stdio destroyed, listeners dropped, `proc.unref()`;
 *   - `close()` → SIGTERM now, SIGKILL after an unref'ed grace timer;
 *   - handshake failure → the child is killed and unref'ed before rejecting.
 */
async function createManagedOpencode(options: {
  bin?: string;
  config?: Record<string, unknown>;
  port?: number;
  env: Record<string, string>;
  startupSignal: AbortSignal;
}): Promise<SdkServer> {
  const { createOpencodeClient } = (await import("@opencode-ai/sdk").catch(() => {
    throw new Error("OpenCode SDK not available. Install @opencode-ai/sdk or configure a CLI agent instead.");
  })) as { createOpencodeClient: (options: { baseUrl: string }) => SdkClient };

  const port = options.port ?? DEFAULT_SDK_PORT;
  const argv = _serveCommand ?? [options.bin ?? "opencode", "serve", "--hostname=127.0.0.1", `--port=${port}`];
  const proc = spawn(argv[0] as string, argv.slice(1), {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let closeStarted = false;
  let closeEscalation: ReturnType<typeof setTimeout> | undefined;
  const childExited = (): boolean => proc.exitCode !== null || proc.signalCode !== null;
  const clearCloseEscalation = (): void => {
    if (closeEscalation !== undefined) {
      clearTimeout(closeEscalation);
      closeEscalation = undefined;
    }
  };
  const closeManaged = (): void => {
    if (closeStarted) return;
    closeStarted = true;
    if (childExited()) return;

    proc.once("exit", clearCloseEscalation);
    try {
      proc.kill("SIGTERM");
    } catch {
      proc.off("exit", clearCloseEscalation);
      return;
    }
    if (childExited()) return;

    if (_processExiting) {
      // During `process.on("exit")` the event loop is finished, so a timer
      // scheduled here would never fire and the SIGKILL escalation could not
      // happen at all — a server child that ignores SIGTERM outlived akm.
      // Exit handlers must be synchronous, so escalate immediately instead of
      // waiting out a grace period we have no way to wait for.
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      return;
    }

    closeEscalation = setTimeout(() => {
      closeEscalation = undefined;
      if (childExited()) return;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, SERVER_KILL_GRACE_MS);
  };

  const url = await new Promise<string>((resolve, reject) => {
    let output = "";
    let settled = false;
    const cleanupStartup = (): void => {
      proc.stdout?.off("data", onStdoutData);
      proc.stderr?.off("data", onStderrData);
      proc.off("exit", onExit);
      proc.off("error", onError);
      options.startupSignal.removeEventListener("abort", onAbort);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanupStartup();
      closeManaged();
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.unref();
      reject(err);
    };
    const succeed = (serverUrl: string): void => {
      if (settled) return;
      settled = true;
      cleanupStartup();
      resolve(serverUrl);
    };
    const onStdoutData = (chunk: Buffer): void => {
      output += chunk.toString();
      for (const line of output.split("\n")) {
        if (line.startsWith("opencode server listening")) {
          const match = line.match(/on\s+(https?:\/\/\S+)/);
          if (!match?.[1]) {
            fail(new Error(`Failed to parse the OpenCode server url from: ${line}`));
            return;
          }
          succeed(match[1]);
          return;
        }
      }
    };
    const onStderrData = (chunk: Buffer): void => {
      output += chunk.toString();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const status = code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`;
      fail(new Error(`OpenCode server exited with ${status}${output.trim() ? `\nServer output: ${output}` : ""}`));
    };
    const onError = (err: Error): void => {
      fail(err instanceof Error ? err : new Error(String(err)));
    };
    const onAbort = (): void => fail(new Error("OpenCode server startup cancelled because no callers are waiting"));
    proc.stdout?.on("data", onStdoutData);
    proc.stderr?.on("data", onStderrData);
    proc.on("exit", onExit);
    proc.on("error", onError);
    if (options.startupSignal.aborted) onAbort();
    else options.startupSignal.addEventListener("abort", onAbort, { once: true });
  });

  // Handshake done: from here on the child must never hold akm open. Its
  // lifetime is managed explicitly (closeServer → closeManaged), not by the
  // event loop. Destroying the pipes also releases their loop handles.
  proc.stdout?.destroy();
  proc.stderr?.destroy();
  proc.unref();

  return { client: createOpencodeClient({ baseUrl: url }), server: { close: closeManaged } };
}

async function startServer(
  profile: AgentProfile,
  sdkConfig: Record<string, unknown>,
  env: Record<string, string>,
  registryKey: string,
  startupSignal: AbortSignal,
): Promise<SdkServer> {
  const factory: SdkServerFactory = _serverFactory ?? createManagedOpencode;

  const options: {
    bin?: string;
    config?: Record<string, unknown>;
    port?: number;
    env: Record<string, string>;
    startupSignal: AbortSignal;
  } = {
    bin: profile.bin,
    ...(Object.keys(sdkConfig).length > 0 ? { config: sdkConfig } : {}),
    env,
    startupSignal,
  };

  // Every cached server receives a separately reserved port. This avoids both
  // inter-entry contention and collisions with an unrelated process on 4096.
  options.port = await allocateFreePort(registryKey);
  if (startupSignal.aborted) throw new Error("OpenCode server startup cancelled because no callers are waiting");

  // Installed before the spawn, so a child that is still starting up is covered too.
  if (!_exitHookInstalled) {
    _exitHookInstalled = true;
    process.once("exit", () => {
      _processExiting = true;
      void closeServer();
    });
    // A command with no SIGINT/SIGTERM handler of its own dies on the signal without running `exit` hooks, which
    // orphaned every cached server. Close them and re-raise, so the default termination still happens. A command that
    // handles the signal itself (`workflow run`, `improve`, `index`, task runs) unwinds through its own cleanup and is
    // left alone.
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      if (process.listenerCount(signal) > 0) continue;
      process.once(signal, () => {
        _processExiting = true;
        void closeServer();
        process.kill(process.pid, signal);
      });
    }
  }

  const server = await factory(options);
  if (!server) throw new Error("Failed to initialise OpenCode SDK server.");
  return server;
}

/**
 * Get (or lazily start) the server for this call's complete server material.
 * Concurrent callers of the same key share one
 * start (the registry stores the in-flight promise). A failed start is
 * evicted so the next call can retry instead of caching the error forever.
 */
function getOrStartServer(
  profile: AgentProfile,
  llmConfig?: LlmConnectionConfig,
  env?: Record<string, string>,
  envSource: NodeJS.ProcessEnv = process.env,
  modelWork = false,
  inference?: ExecutionJsonObject | null,
): { promise: Promise<SdkServer>; release(): void } {
  if (_testServer) return { promise: Promise.resolve(_testServer), release() {} };
  const sdkConfig = buildSdkConfig(profile, llmConfig, modelWork, inference);
  const serverEnv = buildServerEnv(profile, sdkConfig, env, envSource);
  const key = serverRegistryKey(profile, serverEnv);
  let entry = _servers.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = {
      promise: startServer(profile, sdkConfig, serverEnv, key, controller.signal),
      controller,
      waiters: 0,
    };
    const started = entry;
    _servers.set(key, started);
    started.promise.then(
      (server) => {
        if (_servers.get(key) === started) {
          started.server = server;
          _resolvedServers.set(key, server);
        } else {
          void server.server.close();
        }
      },
      () => {
        if (_servers.get(key) === started) {
          _servers.delete(key);
          _serverPorts.delete(key);
        }
      },
    );
  }
  entry.waiters++;
  let released = false;
  return {
    promise: entry.promise,
    release() {
      if (released) return;
      released = true;
      entry.waiters--;
      if (entry.waiters === 0 && !entry.server && _servers.get(key) === entry) {
        _servers.delete(key);
        _serverPorts.delete(key);
        entry.controller.abort();
      }
    },
  };
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

const SDK_OPERATION_TIMED_OUT = Symbol("opencode-sdk-operation-timeout");
const SDK_OPERATION_ABORTED = Symbol("opencode-sdk-operation-aborted");
const SDK_SESSION_DELETE_TIMEOUT_MS = 5_000;

async function raceSdkOperation<T>(
  operation: Promise<T>,
  opts: {
    timeoutMs: number | null;
    setTimeoutFn: typeof setTimeout;
    clearTimeoutFn: typeof clearTimeout;
    signal?: AbortSignal;
    onLateSettle?: (result: PromiseSettledResult<T>) => void | Promise<void>;
  },
): Promise<T | typeof SDK_OPERATION_TIMED_OUT | typeof SDK_OPERATION_ABORTED> {
  let timer: ReturnType<typeof opts.setTimeoutFn> | undefined;
  let onAbort: (() => void) | undefined;
  let raceFinished = false;
  const racers: Promise<T | typeof SDK_OPERATION_TIMED_OUT | typeof SDK_OPERATION_ABORTED>[] = [operation];

  void operation.then(
    (value) => {
      if (raceFinished && opts.onLateSettle)
        void Promise.resolve(opts.onLateSettle({ status: "fulfilled", value })).catch(() => {});
    },
    (reason) => {
      if (raceFinished && opts.onLateSettle)
        void Promise.resolve(opts.onLateSettle({ status: "rejected", reason })).catch(() => {});
    },
  );

  if (opts.timeoutMs !== null) {
    racers.push(
      new Promise<typeof SDK_OPERATION_TIMED_OUT>((resolve) => {
        timer = opts.setTimeoutFn(() => resolve(SDK_OPERATION_TIMED_OUT), opts.timeoutMs ?? 0);
        if (typeof timer !== "number") timer.unref?.();
      }),
    );
  }
  if (opts.signal) {
    racers.push(
      new Promise<typeof SDK_OPERATION_ABORTED>((resolve) => {
        onAbort = () => resolve(SDK_OPERATION_ABORTED);
        if (opts.signal?.aborted) onAbort();
        else opts.signal?.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }

  try {
    return racers.length === 1 ? await operation : await Promise.race(racers);
  } finally {
    raceFinished = true;
    if (timer !== undefined) opts.clearTimeoutFn(timer);
    if (opts.signal && onAbort) opts.signal.removeEventListener("abort", onAbort);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function appendStderr(stderr: string, message: string): string {
  return stderr ? `${stderr}\n${message}` : message;
}

/**
 * Map an SDK `{ error }` result or a reply's `info.error` onto a failure
 * (#1015). Both are opencode NamedErrors, `{ name, data: { message } }`. An
 * aborted message is `aborted`, a reply cut off at the output limit is
 * `parse_error`, and every other error (auth, API, unknown, an HTTP error
 * body) is `non_zero_exit`.
 */
function sdkErrorFailure(error: unknown): { reason: AgentFailureReason; message: string } {
  if (!isRecord(error) || typeof error.name !== "string") {
    return { reason: "non_zero_exit", message: typeof error === "string" ? error : JSON.stringify(error) };
  }
  const detail = isRecord(error.data) ? error.data.message : undefined;
  const message = typeof detail === "string" ? `${error.name}: ${detail}` : error.name;
  if (error.name === "MessageAbortedError") return { reason: "aborted", message };
  if (error.name === "MessageOutputLengthError") return { reason: "parse_error", message };
  return { reason: "non_zero_exit", message };
}

async function deleteSessionBestEffort(
  client: SdkClient,
  sessionId: string,
  query: SdkDirectoryQuery | undefined,
  setTimeoutFn: typeof setTimeout,
  clearTimeoutFn: typeof clearTimeout,
): Promise<string | undefined> {
  try {
    const deleted = await raceSdkOperation(
      client.session.delete({ path: { id: sessionId }, ...(query ? { query } : {}) }),
      {
        timeoutMs: SDK_SESSION_DELETE_TIMEOUT_MS,
        setTimeoutFn,
        clearTimeoutFn,
      },
    );
    if (deleted === SDK_OPERATION_TIMED_OUT) {
      return `OpenCode session cleanup timed out after ${SDK_SESSION_DELETE_TIMEOUT_MS}ms`;
    }
    return undefined;
  } catch (err) {
    return `OpenCode session cleanup failed: ${errorText(err)}`;
  }
}

/** Stop a server-side session that the dispatch has given up on, so it stops calling the model. */
function abortSessionBestEffort(client: SdkClient, sessionId: string, query: SdkDirectoryQuery | undefined): void {
  void client.session.abort?.({ path: { id: sessionId }, ...(query ? { query } : {}) }).catch(() => {});
}

function abortedBeforeSdkStart(profile: AgentProfile): AgentRunResult {
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

export async function runOpencodeSdk(
  profile: AgentProfile,
  prompt: string,
  opts: RunAgentOptions = {},
  llmConfig?: LlmConnectionConfig,
): Promise<AgentRunResult> {
  const start = Date.now();
  const timeoutMs: number | null = opts.timeoutMs !== undefined ? opts.timeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  const deadline = timeoutMs === null ? null : start + timeoutMs;
  const remainingTimeoutMs = (): number | null => (deadline === null ? null : Math.max(0, deadline - Date.now()));
  const setTimeoutImpl = opts.setTimeoutFn ?? setTimeout;
  const clearTimeoutImpl = opts.clearTimeoutFn ?? clearTimeout;

  if (opts.signal?.aborted) return abortedBeforeSdkStart(profile);
  const modelWork = isModelWorkTools(opts.dispatch?.tools);

  let client: SdkClient;
  if (_testServer) {
    client = _testServer.client;
  } else {
    const startupHandle = getOrStartServer(
      profile,
      llmConfig,
      opts.env,
      opts.envSource,
      modelWork,
      opts.dispatch?.inference,
    );
    try {
      const startup = await raceSdkOperation(startupHandle.promise, {
        timeoutMs: remainingTimeoutMs(),
        setTimeoutFn: setTimeoutImpl,
        clearTimeoutFn: clearTimeoutImpl,
        signal: opts.signal,
      });
      if (startup === SDK_OPERATION_ABORTED) {
        return {
          ok: false,
          stdout: "",
          stderr: "",
          durationMs: Date.now() - start,
          exitCode: null,
          reason: "aborted" as AgentFailureReason,
          error: `opencode-sdk agent "${profile.name}" aborted by caller signal during server startup`,
        };
      }
      if (startup === SDK_OPERATION_TIMED_OUT) {
        return {
          ok: false,
          stdout: "",
          stderr: "",
          durationMs: Date.now() - start,
          exitCode: null,
          reason: "timeout" as AgentFailureReason,
          error: `opencode-sdk agent "${profile.name}" timed out during server startup after ${timeoutMs}ms`,
        };
      }
      client = startup.client;
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
    } finally {
      startupHandle.release();
    }
  }

  // #564 bug fix (3): enforce a hard timeout like the CLI path (runAgent).
  // Previously runOpencodeSdk() awaited SDK calls with no timeout, so a stalled
  // local-model endpoint or wedged server could block the caller indefinitely.
  // The same absolute deadline covers server startup, session creation, and
  // prompting. null disables every dispatch timer. Session cleanup remains a
  // separately bounded best-effort operation.

  // Per-call working directory (module doc): forwarded as the SDK's
  // `query.directory` on every session call, so worktree-isolated units run
  // in their own checkout without a per-cwd server.
  const query: SdkDirectoryQuery | undefined = opts.cwd ? { directory: opts.cwd } : undefined;

  // One session per call — do NOT reuse (history accumulates, token costs grow).
  // Session creation is startup plumbing, so failures map to spawn_failed rather
  // than bubbling out as a generic workflow dispatch exception.
  const abortSignal = opts.signal;
  let sessionId: string | undefined;
  try {
    const created = await raceSdkOperation(
      client.session.create({ body: { title: "akm" }, ...(query ? { query } : {}) }),
      {
        timeoutMs: remainingTimeoutMs(),
        setTimeoutFn: setTimeoutImpl,
        clearTimeoutFn: clearTimeoutImpl,
        signal: abortSignal,
        onLateSettle: (late) => {
          if (late.status === "fulfilled" && late.value.data?.id) {
            void deleteSessionBestEffort(client, late.value.data.id, query, setTimeoutImpl, clearTimeoutImpl);
          }
        },
      },
    );
    if (created === SDK_OPERATION_ABORTED) {
      return {
        ok: false,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - start,
        exitCode: null,
        reason: "aborted" as AgentFailureReason,
        error: `opencode-sdk agent "${profile.name}" aborted by caller signal`,
      };
    }
    if (created === SDK_OPERATION_TIMED_OUT) {
      return {
        ok: false,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - start,
        exitCode: null,
        reason: "timeout" as AgentFailureReason,
        error: `opencode-sdk agent "${profile.name}" timed out creating a session after ${timeoutMs}ms`,
      };
    }
    sessionId = created.data?.id;
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: errorText(err),
      durationMs: Date.now() - start,
      exitCode: 1,
      reason: "spawn_failed" as AgentFailureReason,
      error: errorText(err),
    };
  }

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

  // Forward the exact native agent selector, systemPrompt, and tools from the abstract
  // dispatch request. Both were previously accepted on AgentDispatchRequest but
  // silently dropped on the SDK path, so SDK-mode dispatch ignored agent-asset
  // system prompts and tool policies entirely (the CLI path honours both).
  // Model work runs the confined agent its server config defines; its tools are that agent's.
  const dispatch = opts.dispatch;
  const agent = modelWork ? MODEL_WORK_OPENCODE_AGENT : dispatch?.agent;
  const system = dispatch?.systemPrompt;
  const tools = modelWork ? undefined : toolsToSdkAllowlist(dispatch?.tools);
  const body: {
    parts: { type: string; text: string }[];
    agent?: string;
    system?: string;
    tools?: Record<string, boolean>;
  } = { parts: [{ type: "text", text: prompt }] };
  if (agent) body.agent = agent;
  if (system) body.system = system;
  if (tools) body.tools = tools;

  let result: AgentRunResult;

  try {
    const prompted = await raceSdkOperation(
      client.session.prompt({ path: { id: sessionId }, body, ...(query ? { query } : {}) }),
      {
        timeoutMs: remainingTimeoutMs(),
        setTimeoutFn: setTimeoutImpl,
        clearTimeoutFn: clearTimeoutImpl,
        signal: abortSignal,
        onLateSettle: () => {
          void deleteSessionBestEffort(client, sessionId as string, query, setTimeoutImpl, clearTimeoutImpl);
        },
      },
    );

    // A session the dispatch stops early is aborted on the server too.
    if (prompted === SDK_OPERATION_ABORTED || prompted === SDK_OPERATION_TIMED_OUT) {
      abortSessionBestEffort(client, sessionId, query);
    }
    if (prompted === SDK_OPERATION_ABORTED) {
      result = {
        ok: false,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - start,
        exitCode: null,
        reason: "aborted" as AgentFailureReason,
        error: `opencode-sdk agent "${profile.name}" aborted by caller signal`,
        sessionId,
      };
    } else if (prompted === SDK_OPERATION_TIMED_OUT) {
      result = {
        ok: false,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - start,
        exitCode: null,
        reason: "timeout" as AgentFailureReason,
        error: `opencode-sdk agent "${profile.name}" timed out after ${timeoutMs}ms`,
        sessionId,
      };
    } else {
      const parts = prompted.data?.parts ?? [];
      // The last text part is the answer; earlier ones narrate the steps before it.
      const stdout = parts.filter((p) => p.type === "text").at(-1)?.text ?? "";
      // Token accounting from the AssistantMessage (previously discarded) —
      // the seam that makes workflow budget.maxTokens meterable on the
      // default sdk runner.
      const usage = extractUsage(prompted.data?.info);
      const sdkError = prompted.error ?? prompted.data?.info?.error;

      if (sdkError) {
        const failure = sdkErrorFailure(sdkError);
        result = {
          ok: false,
          stdout,
          stderr: failure.message,
          durationMs: Date.now() - start,
          exitCode: failure.reason === "aborted" ? null : 1,
          reason: failure.reason,
          error: failure.message,
          sessionId,
          ...(usage ? { usage } : {}),
        };
      } else {
        result = {
          ok: true,
          stdout,
          stderr: "",
          durationMs: Date.now() - start,
          exitCode: 0,
          sessionId,
          ...(usage ? { usage } : {}),
        };
      }
    }
  } catch (err) {
    result = {
      ok: false,
      stdout: "",
      stderr: errorText(err),
      durationMs: Date.now() - start,
      exitCode: 1,
      reason: "non_zero_exit" as AgentFailureReason,
      error: errorText(err),
      sessionId,
    };
  }

  // Clean up session to prevent disk accumulation in ~/.local/share/opencode/.
  // Failures are non-fatal to the agent result but must not be invisible.
  const cleanupWarning = await deleteSessionBestEffort(client, sessionId, query, setTimeoutImpl, clearTimeoutImpl);
  if (cleanupWarning) result.stderr = appendStderr(result.stderr, cleanupWarning);
  return result;
}
