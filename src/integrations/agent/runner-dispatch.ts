// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The low-level exhaustive dispatch seam for the {@link RunnerSpec} transport
 * union (`llm | agent | sdk`). User/model work reaches this function only
 * after `ResolvedExecutionRequestV1` preparation and engine-owned lowering;
 * `dispatchLoweredExecutionRequest` supplies the direct-LLM handler. A
 * prompt-free native launch crosses the explicit payload-free interactive
 * lowerer in that same shared layer.
 *
 * Agent and SDK arms use the shared profile runners. The LLM arm deliberately
 * requires a handler because structured callers own their parse/fallback
 * contract. The `assertNever` arm keeps a fourth transport kind from becoming
 * an implicit fallthrough. Symbolic LLM and SDK-fallback credentials are
 * materialized here, at authorized operation-lease acquisition or the final
 * single-call boundary, then scrubbed from the result.
 */

import { assertNever } from "../../core/assert";
import type { LlmConnectionConfig } from "../../core/config/config";
import {
  collectSensitiveValues,
  isEnvPassthroughValueSafeToExpose,
  redactSensitiveText,
  redactSensitiveValue,
} from "../../core/redaction";
import { spawnEnvNamesFor } from "../../core/spawn-env";
import {
  closeServer as disposeOpencodeSdkServers,
  opencodeSdkServerEnvironmentNames,
  runOpencodeSdk,
} from "../harnesses/opencode-sdk/sdk-runner";
import {
  lookupApiKeyFileValue,
  lookupApiKeySecretRefValue,
  lookupCredentialFromEnv,
  materializeLlmConnection,
  materializeLlmConnectionWithCredential,
  resolveLlmCredentialValue,
} from "./engine-resolution";
import type { AgentProfile } from "./profiles";
import {
  type DispatchedLlmRunner,
  materializeLlmRunnerConnection,
  materializeLlmRunnerConnectionWithCredential,
  type RunnerSpec,
} from "./runner";
import { type AgentRunResult, type RunAgentOptions, runAgent } from "./spawn";

declare const runnerDispatchLeaseBrand: unique symbol;

/** Opaque operation-scoped authority for dispatching with snapshotted credentials. */
export interface RunnerDispatchLease {
  readonly [runnerDispatchLeaseBrand]: true;
}

interface RunnerDispatchLeaseState {
  readonly binding: string;
  readonly environmentSnapshot: Map<string, string | undefined>;
  readonly environmentSource: NodeJS.ProcessEnv;
  primaryCredential: string | undefined;
  fallbackCredential: string | undefined;
  sensitiveValues: string[];
}

const liveRunnerDispatchLeases = new WeakMap<object, RunnerDispatchLeaseState>();
const issuedRunnerDispatchLeases = new WeakSet<object>();
const disposedRunnerDispatchLeases = new WeakSet<object>();

function credentialBinding(credential: { names: readonly string[]; required: boolean } | undefined) {
  return credential ? { names: [...credential.names], required: credential.required } : null;
}

function passthroughBinding(spec: Extract<RunnerSpec, { kind: "agent" | "sdk" }>): string[] {
  return [...new Set(spec.profile.envPassthrough)].sort();
}

function dispatchEnvironmentNames(spec: RunnerSpec): string[] {
  switch (spec.kind) {
    case "llm":
      return [];
    case "agent":
      return spawnEnvNamesFor(spec.profile.envPassthrough);
    case "sdk":
      return opencodeSdkServerEnvironmentNames(spec.profile);
    default:
      return assertNever(spec);
  }
}

function snapshotDispatchEnvironment(spec: RunnerSpec, envSource: NodeJS.ProcessEnv) {
  const snapshot = new Map<string, string | undefined>();
  const read = (name: string): string | undefined => {
    if (!snapshot.has(name)) snapshot.set(name, envSource[name]);
    return snapshot.get(name);
  };
  const environmentSource = new Proxy(Object.create(null) as NodeJS.ProcessEnv, {
    get(_target, property) {
      return typeof property === "string" ? snapshot.get(property) : undefined;
    },
  });
  for (const name of dispatchEnvironmentNames(spec)) read(name);
  const passthroughSensitiveValues = new Set<string>();
  if (spec.kind !== "llm") {
    for (const name of new Set(spec.profile.envPassthrough)) {
      const value = snapshot.get(name);
      if (!isEnvPassthroughValueSafeToExpose(name, value) && value) passthroughSensitiveValues.add(value);
    }
  }
  return { environmentSnapshot: snapshot, environmentSource, passthroughSensitiveValues, read };
}

/** Bind only transport identity; request model/inference/schema/timeout remain per-call. */
function runnerLeaseBinding(spec: RunnerSpec): string {
  switch (spec.kind) {
    case "llm":
      return JSON.stringify({
        kind: spec.kind,
        engine: spec.engine ?? null,
        endpoint: spec.connection.endpoint,
        provider: spec.connection.provider ?? null,
        credential: credentialBinding(spec.credential),
        apiKeyFile: spec.apiKeyFile ?? null,
      });
    case "agent":
      return JSON.stringify({
        kind: spec.kind,
        engine: spec.engine ?? null,
        platform: spec.profile.platform ?? null,
        name: spec.profile.name,
        bin: spec.profile.bin,
        envPassthrough: passthroughBinding(spec),
      });
    case "sdk":
      return JSON.stringify({
        kind: spec.kind,
        engine: spec.engine ?? null,
        platform: spec.profile.platform ?? null,
        name: spec.profile.name,
        bin: spec.profile.bin,
        envPassthrough: passthroughBinding(spec),
        fallbackEndpoint: spec.fallbackConnection?.endpoint ?? null,
        fallbackProvider: spec.fallbackConnection?.provider ?? null,
        fallbackCredential: credentialBinding(spec.fallbackCredential),
        fallbackApiKeyFile: spec.fallbackApiKeyFile ?? null,
      });
    default:
      return assertNever(spec);
  }
}

function requireRunnerDispatchLease(lease: RunnerDispatchLease, spec?: RunnerSpec): RunnerDispatchLeaseState {
  if (typeof lease !== "object" || lease === null) throw new TypeError("invalid dispatch lease");
  const state = liveRunnerDispatchLeases.get(lease);
  if (!state) {
    if (issuedRunnerDispatchLeases.has(lease) && disposedRunnerDispatchLeases.has(lease)) {
      throw new TypeError("dispatch lease is disposed");
    }
    throw new TypeError("invalid dispatch lease");
  }
  if (spec && state.binding !== runnerLeaseBinding(spec)) {
    throw new TypeError("dispatch lease does not match the lowered runner transport");
  }
  return state;
}

/** @internal Verify provenance, liveness, and transport binding without exposing state. */
export function assertRunnerDispatchLease(lease: RunnerDispatchLease, spec: RunnerSpec): void {
  requireRunnerDispatchLease(lease, spec);
}

/** @internal Acquire only through execution-lowering after authorization/provenance validation. */
export function acquireRunnerDispatchLease(
  spec: RunnerSpec,
  envSource: NodeJS.ProcessEnv = process.env,
): RunnerDispatchLease {
  const environment = snapshotDispatchEnvironment(spec, envSource);
  const credentialSource = new Proxy(Object.create(null) as NodeJS.ProcessEnv, {
    get(_target, property) {
      return typeof property === "string" ? environment.read(property) : undefined;
    },
  });
  const primaryCredential =
    spec.kind === "llm"
      ? resolveLlmCredentialValue(spec.engine, spec.credential, spec.apiKeyFile, spec.apiKeySecretRef, credentialSource)
      : undefined;
  const fallbackCredential =
    spec.kind === "sdk"
      ? resolveLlmCredentialValue(
          spec.engine,
          spec.fallbackCredential,
          spec.fallbackApiKeyFile,
          spec.fallbackApiKeySecretRef,
          credentialSource,
        )
      : undefined;
  const handle = Object.create(null) as object;
  Object.defineProperty(handle, "toJSON", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: () => {
      throw new TypeError("dispatch lease is not serializable");
    },
  });
  Object.freeze(handle);
  const sensitiveValues = collectSensitiveValues([
    primaryCredential,
    fallbackCredential,
    ...environment.passthroughSensitiveValues,
  ]);
  liveRunnerDispatchLeases.set(handle, {
    binding: runnerLeaseBinding(spec),
    primaryCredential,
    fallbackCredential,
    environmentSnapshot: environment.environmentSnapshot,
    environmentSource: environment.environmentSource,
    sensitiveValues,
  });
  issuedRunnerDispatchLeases.add(handle);
  return handle as RunnerDispatchLease;
}

/** @internal Scrub private material and invalidate one issued handle. */
export function disposeRunnerDispatchLease(lease: RunnerDispatchLease): void {
  if (typeof lease !== "object" || lease === null || !issuedRunnerDispatchLeases.has(lease)) {
    throw new TypeError("invalid dispatch lease");
  }
  const state = liveRunnerDispatchLeases.get(lease);
  if (!state) return;
  state.primaryCredential = undefined;
  state.fallbackCredential = undefined;
  state.environmentSnapshot.clear();
  state.sensitiveValues.fill("");
  state.sensitiveValues = [];
  liveRunnerDispatchLeases.delete(lease);
  disposedRunnerDispatchLeases.add(lease);
}

/** @internal Redact with private credential material without exposing its values. */
export function redactWithRunnerDispatchLease(lease: RunnerDispatchLease, value: string): string {
  return redactSensitiveText(value, requireRunnerDispatchLease(lease).sensitiveValues);
}

/**
 * Release every long-lived resource the dispatch runners CACHE for reuse, so a
 * one-shot process (the CLI) can exit cleanly once dispatching is done.
 *
 * The `sdk` runner keeps a per-material registry of `opencode serve` CHILD
 * PROCESSES (see `opencode-sdk/sdk-runner.ts`), started lazily and reused
 * across units within a process. Each live child is an OS handle that keeps
 * Bun's event loop open — and the registry's own teardown is wired ONLY to
 * `process.once('exit')`, which never fires while such a child holds the loop
 * open. That is a deadlock: a successful `akm workflow run` that dispatched via
 * the SDK path would hang the CLI (owner finding 4) because the process is
 * never idle enough for the exit hook to run and close the children it is
 * waiting on.
 *
 * The CLI composition root and workflow engine call this in `finally` blocks to
 * drain the registry deterministically before relying on the event loop. Started
 * servers close synchronously; in-flight starts are awaited and closed on
 * arrival. When no SDK server was started this is an idempotent no-op.
 */
export async function disposeDispatchResources(): Promise<void> {
  await disposeOpencodeSdkServers();
}

/** Collect every materialized value that can reach one runner dispatch. */
export function collectDispatchSensitiveValues(
  spec: RunnerSpec,
  opts: RunAgentOptions,
  envSource: NodeJS.ProcessEnv = opts.envSource ?? process.env,
): string[] {
  const values = new Set<string>();
  const add = (value: string | undefined): void => {
    if (value !== undefined && value.length > 0) values.add(value);
  };
  const addConnection = (connection: LlmConnectionConfig | undefined): void => add(connection?.apiKey);

  if (spec.kind === "llm") addConnection(spec.connection);
  if (spec.kind === "sdk") addConnection(spec.fallbackConnection);
  if (spec.kind === "llm") add(lookupCredentialFromEnv(spec.credential, envSource));
  if (spec.kind === "sdk") add(lookupCredentialFromEnv(spec.fallbackCredential, envSource));
  // #905: a file-backed credential is read at dispatch, so it must be in the
  // scrub set for the same reason the env-backed one is.
  if (spec.kind === "llm" && spec.apiKeyFile) add(lookupApiKeyFileValue(spec.apiKeyFile));
  if (spec.kind === "sdk" && spec.fallbackApiKeyFile) add(lookupApiKeyFileValue(spec.fallbackApiKeyFile));
  // #953: a secret-store-backed credential is read at dispatch too — same
  // best-effort scrub-set inclusion rationale.
  if (spec.kind === "llm" && spec.apiKeySecretRef) add(lookupApiKeySecretRefValue(spec.apiKeySecretRef));
  if (spec.kind === "sdk" && spec.fallbackApiKeySecretRef)
    add(lookupApiKeySecretRefValue(spec.fallbackApiKeySecretRef));
  if (spec.kind !== "llm") {
    for (const value of Object.values(spec.profile.env ?? {})) add(value);
    for (const name of spec.profile.envPassthrough) {
      const value = envSource[name];
      if (!isEnvPassthroughValueSafeToExpose(name, value)) add(value);
    }
  }
  for (const [name, value] of Object.entries(opts.env ?? {})) {
    if (!isEnvPassthroughValueSafeToExpose(name, value)) add(value);
  }
  return collectSensitiveValues(values);
}

function collectNonCredentialDispatchSensitiveValues(
  spec: RunnerSpec,
  opts: RunAgentOptions,
  envSource: NodeJS.ProcessEnv = opts.envSource ?? process.env,
  includeProfilePassthrough = true,
): string[] {
  const values = new Set<string>();
  const add = (value: string | undefined): void => {
    if (value !== undefined && value.length > 0) values.add(value);
  };
  if (spec.kind === "llm") add(spec.connection.apiKey);
  if (spec.kind === "sdk") add(spec.fallbackConnection?.apiKey);
  if (spec.kind !== "llm") {
    for (const value of Object.values(spec.profile.env ?? {})) add(value);
    if (includeProfilePassthrough) {
      for (const name of spec.profile.envPassthrough) {
        const value = envSource[name];
        if (!isEnvPassthroughValueSafeToExpose(name, value)) add(value);
      }
    }
  }
  for (const [name, value] of Object.entries(opts.env ?? {})) {
    if (!isEnvPassthroughValueSafeToExpose(name, value)) add(value);
  }
  return collectSensitiveValues(values);
}

function redactResult(result: AgentRunResult, sensitiveValues: readonly string[]): AgentRunResult {
  return {
    ...result,
    stdout: redactSensitiveText(result.stdout, sensitiveValues),
    stderr: redactSensitiveText(result.stderr, sensitiveValues),
    ...(result.error !== undefined ? { error: redactSensitiveText(result.error, sensitiveValues) } : {}),
    ...(result.parsed !== undefined ? { parsed: redactSensitiveValue(result.parsed, sensitiveValues) } : {}),
  };
}

/**
 * Per-kind dispatch overrides. The `llm` handler is required at every real call
 * site (no in-tree default); `runAgent` / `runSdk` default to the real profile
 * runners and exist primarily as test seams.
 */
export interface RunnerSeams {
  /**
   * Handler for the `llm` runner kind. Required — the LLM path differs per
   * caller (reflect's `runReflectViaLlm` vs drain's `chatCompletion`), so it is
   * supplied rather than defaulted. Receives the narrowed `llm` spec and prompt.
   */
  llm?: (spec: DispatchedLlmRunner, prompt: string, opts: RunAgentOptions) => Promise<AgentRunResult>;
  /** Override for the `agent` runner kind. Defaults to {@link runAgent}. */
  runAgent?: (profile: AgentProfile, prompt: string, opts: RunAgentOptions) => Promise<AgentRunResult>;
  /** Override for the `sdk` runner kind. Defaults to {@link runOpencodeSdk}. */
  runSdk?: (
    profile: AgentProfile,
    prompt: string,
    opts: RunAgentOptions,
    fallbackConnection?: LlmConnectionConfig,
  ) => Promise<AgentRunResult>;
}

/**
 * Dispatch a {@link RunnerSpec} to its runner and return the raw
 * {@link AgentRunResult}. `opts` is the {@link RunAgentOptions} for the profile
 * (`agent` / `sdk`) arms. Callers keep their per-call options; a bound lease
 * replaces only `envSource` with its private immutable environment snapshot.
 */
export async function executeRunner(
  spec: RunnerSpec,
  prompt: string,
  opts: RunAgentOptions,
  seams: RunnerSeams = {},
  lease?: RunnerDispatchLease,
): Promise<AgentRunResult> {
  const withSpecOptions = (
    timeoutMs: number | null | undefined,
    workspace?: string,
    environmentSource?: NodeJS.ProcessEnv,
  ): RunAgentOptions => ({
    ...opts,
    ...(Object.hasOwn(opts, "timeoutMs") ? {} : timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(opts.cwd === undefined && workspace ? { cwd: workspace } : {}),
    ...(environmentSource ? { envSource: environmentSource } : {}),
  });
  let result: AgentRunResult;
  const dispatchSensitiveValues: string[] = [];
  const leaseState = lease ? requireRunnerDispatchLease(lease, spec) : undefined;
  const preDispatchSensitiveValues = leaseState
    ? collectSensitiveValues([
        ...leaseState.sensitiveValues,
        ...collectNonCredentialDispatchSensitiveValues(spec, opts, undefined, false),
      ])
    : collectDispatchSensitiveValues(spec, opts);
  switch (spec.kind) {
    case "llm": {
      if (!seams.llm) {
        throw new Error("executeRunner: an `llm` runner requires a `seams.llm` handler (no default LLM dispatch).");
      }
      const connection = leaseState
        ? materializeLlmRunnerConnectionWithCredential(spec, leaseState.primaryCredential)
        : materializeLlmRunnerConnection(spec);
      if (connection.apiKey) dispatchSensitiveValues.push(connection.apiKey);
      result = await seams.llm({ ...spec, connection }, prompt, withSpecOptions(spec.timeoutMs));
      break;
    }
    case "agent": {
      const run = seams.runAgent ?? runAgent;
      result = await run(
        spec.profile,
        prompt,
        withSpecOptions(spec.timeoutMs, spec.profile.workspace, leaseState?.environmentSource),
      );
      break;
    }
    case "sdk": {
      const run = seams.runSdk ?? runOpencodeSdk;
      const fallbackMaterial = spec.fallbackConnection
        ? {
            engine: spec.engine ?? "unnamed-sdk-fallback",
            connection: spec.fallbackConnection,
            ...(spec.fallbackCredential ? { credential: spec.fallbackCredential } : {}),
            ...(spec.fallbackApiKeyFile ? { apiKeyFile: spec.fallbackApiKeyFile } : {}),
            timeoutMs:
              spec.fallbackTimeoutMs !== undefined
                ? spec.fallbackTimeoutMs
                : Object.hasOwn(spec.fallbackConnection, "timeoutMs")
                  ? (spec.fallbackConnection.timeoutMs ?? null)
                  : null,
          }
        : undefined;
      const fallbackConnection = fallbackMaterial
        ? leaseState
          ? materializeLlmConnectionWithCredential(fallbackMaterial, leaseState.fallbackCredential)
          : materializeLlmConnection(fallbackMaterial)
        : undefined;
      if (fallbackConnection?.apiKey) dispatchSensitiveValues.push(fallbackConnection.apiKey);
      result = await run(
        spec.profile,
        prompt,
        withSpecOptions(spec.timeoutMs, spec.profile.workspace, leaseState?.environmentSource),
        fallbackConnection,
      );
      break;
    }
    default:
      // Exhaustiveness arm: a 4th RunnerSpec kind becomes a compile error here.
      return assertNever(spec);
  }
  const sensitiveValues = collectSensitiveValues([...preDispatchSensitiveValues, ...dispatchSensitiveValues]);
  return redactResult(result, sensitiveValues);
}
