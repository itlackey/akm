// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig, LlmConnectionConfig } from "../../core/config/config-types";
import { ConfigError, UsageError } from "../../core/errors";
import { cloneExecutionJsonObject } from "../../execution/json";
import { EXECUTION_MAX_TIMEOUT_MS } from "../../execution/limits";
import { assertSnapshotKeys, snapshotStrictRecord } from "../../execution/record";
import {
  canonicalResolvedExecutionRequest,
  type LoweringNotice,
  type ResolvedExecutionRequestV1,
} from "../../execution/resolved-request";
import type { ToolSelection } from "../../execution/source";
import {
  type ChatCompletionOptions,
  type ChatMessage,
  chatCompletion,
  LlmCallError,
  type LlmCallErrorCode,
} from "../../llm/client";
import { HARNESS_REGISTRY } from "../harnesses";
import type { AgentDispatchRequest, AgentRequestLowerer } from "./builder-shared";
import { resolveEngine } from "./engine-resolution";
import { SDK_FALLBACK_MODEL_FROM_REQUEST_SETTING } from "./execution-definitions";
import type { RunnerSpec } from "./runner";
import {
  acquireRunnerDispatchLease,
  assertRunnerDispatchLease,
  disposeRunnerDispatchLease,
  executeRunner,
  type RunnerDispatchLease,
  type RunnerSeams,
  redactWithRunnerDispatchLease,
} from "./runner-dispatch";
import type { AgentFailureReason, AgentRunResult, RunAgentOptions } from "./spawn";

export const EXECUTION_LOWERING_SCHEMA_VERSION = 1 as const;

interface LoweredExecutionBase {
  readonly schemaVersion: typeof EXECUTION_LOWERING_SCHEMA_VERSION;
  readonly request: ResolvedExecutionRequestV1;
  readonly adapter: string;
  readonly runner: RunnerSpec;
  readonly prompt: string;
  readonly options: Readonly<RunAgentOptions>;
  readonly translatedFields: readonly string[];
  readonly untranslatedFields: readonly string[];
  readonly notices: readonly Readonly<LoweringNotice>[];
}

export interface LoweredAgentExecutionRequest extends LoweredExecutionBase {
  readonly runner: Extract<RunnerSpec, { kind: "agent" | "sdk" }>;
  readonly dispatch: Readonly<AgentDispatchRequest>;
}

export interface LoweredLlmExecutionRequest extends LoweredExecutionBase {
  readonly adapter: "llm";
  readonly runner: Extract<RunnerSpec, { kind: "llm" }>;
  readonly messages: readonly ChatMessage[];
  readonly chatOptions: Readonly<ChatCompletionOptions>;
}

export type LoweredExecutionRequest = LoweredAgentExecutionRequest | LoweredLlmExecutionRequest;

/**
 * Prompt-free native launches are not commands and therefore do not fabricate
 * an empty {@link ResolvedExecutionRequestV1}. They still cross the same
 * engine-owned resolution, symbolic-runner snapshot, lease, and dispatch
 * layer as command/workflow execution.
 */
export interface InteractiveAgentInvocationOptions {
  readonly config: AkmConfig;
  readonly engine: string;
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

export interface InteractiveAgentInvocationSeams {
  readonly runAgent?: RunnerSeams["runAgent"];
  readonly runSdk?: RunnerSeams["runSdk"];
}

interface LoweredInteractiveAgentExecution {
  readonly engine: string;
  readonly runner: Extract<RunnerSpec, { kind: "agent" | "sdk" }>;
  readonly options: Readonly<RunAgentOptions>;
}

export interface InteractiveAgentInvocationResult {
  readonly engine: string;
  readonly result: AgentRunResult;
}

const loweredExecutionInstances = new WeakSet<object>();

function registerLoweredExecution<T extends LoweredExecutionRequest>(value: T): T {
  const frozen = Object.freeze(value);
  loweredExecutionInstances.add(frozen);
  return frozen;
}

export interface DispatchLoweredExecutionOptions {
  readonly executeRunner?: typeof executeRunner;
  readonly chat?: typeof chatCompletion;
  /** Direct-LLM retry telemetry only; never canonicalized or forwarded to agent/SDK transports. */
  readonly onRetryAttempt?: NonNullable<ChatCompletionOptions["onRetryAttempt"]>;
  readonly runAgent?: RunnerSeams["runAgent"];
  readonly runSdk?: RunnerSeams["runSdk"];
  /** Operation-scoped credential capability acquired after lowering. */
  readonly lease?: RunnerDispatchLease;
  /** Operational test/cancellation seams; resolved content/argv/env/cwd/timeout cannot be overridden here. */
  readonly runOptions?: Partial<RunAgentOptions>;
  /**
   * F-1 (spec docs/plans/specs/p1b-model-extraction.md §5.2 point 3): the
   * task runner's resolved provenance event source (already ambient-resolved
   * by the caller — an ambient `process.env.AKM_EVENT_SOURCE` still wins
   * everywhere it wins today; this is only the fallback). Applied as EXACTLY
   * one child-env key, `AKM_EVENT_SOURCE`, layered on top of the lowered
   * request's own resolved `env` — the ONE narrow exception to
   * `runOptions`'s "resolved content … cannot be overridden" rule above,
   * scoped to this single name so a caller cannot use it to replace ANY other
   * resolved value (frozen scheduler-context directories included). Never
   * reaches around the execution boundary's one authorized `runAgent`/
   * `runSdk` caller (`scripts/lint-execution-boundary.ts` permits exactly
   * one, `runner-dispatch.ts`'s `executeRunner`) — it rides the same options
   * object that boundary's one call site already forwards.
   */
  readonly eventSource?: string;
}

export type LoweredExecutionDispatchLease = RunnerDispatchLease;

export interface AcquireLoweredExecutionDispatchLeaseOptions {
  readonly envSource?: NodeJS.ProcessEnv;
}

function own(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

function sterileRecord<T extends object>(value: T): T {
  return Object.assign(Object.create(null), value) as T;
}

function sortedUnique(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function freezeNotices(values: Iterable<Readonly<LoweringNotice>>): readonly Readonly<LoweringNotice>[] {
  return Object.freeze([...values]);
}

const SAFE_ENGINE_FALLBACK_NOTICE: Readonly<LoweringNotice> = Object.freeze({
  code: "engine-fallback",
  severity: "info",
  adapter: "akm",
  field: "engine",
  message: "No engine was selected; using the fixed opencode-sdk fallback.",
});

const UNRECOGNIZED_REQUEST_NOTICE: Readonly<LoweringNotice> = Object.freeze({
  code: "unrecognized-request-notice",
  severity: "warning",
  adapter: "akm",
  message: "An unrecognized durable execution notice was omitted at the engine lowering boundary.",
});

/** Reconstruct durable/untrusted notices without forwarding message/details bytes. */
function safeRequestNotices(request: ResolvedExecutionRequestV1): readonly Readonly<LoweringNotice>[] {
  let fallback = false;
  let unknown = false;
  for (const notice of request.notices) {
    if (notice.code === "engine-fallback") fallback = true;
    else unknown = true;
  }
  return Object.freeze([
    ...(fallback ? [SAFE_ENGINE_FALLBACK_NOTICE] : []),
    ...(unknown ? [UNRECOGNIZED_REQUEST_NOTICE] : []),
  ]);
}

function untranslatedNotice(adapter: string, field: string): Readonly<LoweringNotice> {
  return Object.freeze({
    code: "untranslated-field",
    severity: "warning" as const,
    adapter,
    field,
    message: `The ${adapter} lowerer does not translate resolved field ${field}; dispatch will continue optimistically.`,
  });
}

function requireAuthorizedRequest(request: ResolvedExecutionRequestV1): ResolvedExecutionRequestV1 {
  // The canonical round trip is the public brand/prototype/accessor guard. It
  // deliberately happens before config or registry access.
  canonicalResolvedExecutionRequest(request);
  if (request.authorization.status === "denied") {
    throw new ConfigError(
      request.authorization.reason ?? "Resolved execution is not authorized by operator policy.",
      "EXECUTION_NOT_AUTHORIZED",
    );
  }
  return request;
}

function snapshotConfig(config: AkmConfig): AkmConfig {
  return cloneExecutionJsonObject(config, "execution lowering config") as unknown as AkmConfig;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new TypeError(`${path} contains unsupported field: ${key}`);
  }
}

function requireStringField(value: Record<string, unknown>, key: string, path: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new TypeError(`${path}.${key} must be a string`);
  return field;
}

function validateOptionalString(value: Record<string, unknown>, key: string, path: string): void {
  if (own(value, key) && typeof value[key] !== "string") throw new TypeError(`${path}.${key} must be a string`);
}

function validateTimeout(value: unknown, path: string): void {
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > EXECUTION_MAX_TIMEOUT_MS)
  ) {
    throw new TypeError(`${path} must be null or an integer from 0 through ${EXECUTION_MAX_TIMEOUT_MS}`);
  }
}

function validateStringArray(value: unknown, path: string, allowEmpty = true): void {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new TypeError(`${path} must be ${allowEmpty ? "an" : "a non-empty"} array of strings`);
  }
}

function validateCredential(value: unknown, path: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${path} must be an object`);
  const record = value as Record<string, unknown>;
  assertKeys(record, ["names", "required"], path);
  validateStringArray(record.names, `${path}.names`, false);
  if (typeof record.required !== "boolean") throw new TypeError(`${path}.required must be a boolean`);
}

function validateConnection(value: unknown, path: string, requireModel = true): void {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${path} must be an object`);
  const record = value as Record<string, unknown>;
  requireStringField(record, "endpoint", path);
  if (requireModel || own(record, "model")) requireStringField(record, "model", path);
  if (own(record, "apiKey")) {
    throw new TypeError(`${path}.apiKey must remain a symbolic credential and cannot be frozen as secret material`);
  }
}

function validateProfile(value: unknown, path: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${path} must be an object`);
  const record = value as Record<string, unknown>;
  assertKeys(
    record,
    [
      "name",
      "platform",
      "personaChannel",
      "workspace",
      "bin",
      "args",
      "stdio",
      "env",
      "envPassthrough",
      "parseOutput",
      "model",
    ],
    path,
  );
  requireStringField(record, "name", path);
  requireStringField(record, "bin", path);
  validateOptionalString(record, "platform", path);
  validateOptionalString(record, "workspace", path);
  validateOptionalString(record, "model", path);
  validateStringArray(record.args, `${path}.args`);
  validateStringArray(record.envPassthrough, `${path}.envPassthrough`);
  if (record.stdio !== "captured" && record.stdio !== "interactive") {
    throw new TypeError(`${path}.stdio is invalid`);
  }
  if (record.parseOutput !== "text" && record.parseOutput !== "json") {
    throw new TypeError(`${path}.parseOutput is invalid`);
  }
  if (own(record, "personaChannel") && record.personaChannel !== "native" && record.personaChannel !== "prompt") {
    throw new TypeError(`${path}.personaChannel is invalid`);
  }
  if (own(record, "env")) {
    const env = record.env;
    if (
      env === null ||
      typeof env !== "object" ||
      Array.isArray(env) ||
      Object.values(env).some((entry) => typeof entry !== "string")
    ) {
      throw new TypeError(`${path}.env must be an object of strings`);
    }
  }
}

/** Durable runner material may contain ordinary literals, never credential-shaped bytes. */
function runnerEnvironmentValueLooksSecret(name: string, value: string): boolean {
  const key = name.toLowerCase();
  if (
    [
      "secret",
      "token",
      "password",
      "passwd",
      "apikey",
      "api_key",
      "api-key",
      "accesskey",
      "access_key",
      "privatekey",
      "private_key",
      "credential",
      "bearer",
      "client_secret",
    ].some((hint) => key.includes(hint))
  ) {
    return true;
  }
  const candidate = value.trim();
  if (candidate.length < 20 || /\s/.test(candidate)) return false;
  if (
    /^(?:sk-|rk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|ya29\.|-----BEGIN)/.test(candidate)
  ) {
    return true;
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(candidate)).length;
  return (candidate.length >= 24 && classes >= 3) || (candidate.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(candidate));
}

/** Strictly detach and deep-freeze non-secret runner material before lowering. */
function snapshotRunnerSpec(
  input: RunnerSpec,
  options: { allowMissingLlmModel?: boolean; allowMissingSdkFallbackModel?: boolean } = {},
): RunnerSpec {
  const cloned = cloneExecutionJsonObject(input, "execution runner material") as unknown as Record<string, unknown>;
  const kind = cloned.kind;
  validateOptionalString(cloned, "engine", "execution runner material");
  if (own(cloned, "timeoutMs")) validateTimeout(cloned.timeoutMs, "execution runner material.timeoutMs");
  if (kind === "llm") {
    assertKeys(
      cloned,
      ["kind", "engine", "connection", "credential", "apiKeyFile", "apiKeySecretRef", "timeoutMs"],
      "execution runner material",
    );
    validateConnection(cloned.connection, "execution runner material.connection", !options.allowMissingLlmModel);
    if (own(cloned, "credential")) validateCredential(cloned.credential, "execution runner material.credential");
    // #905: a path, not the secret itself — as safe to freeze as `credential`'s
    // env-var name.
    validateOptionalString(cloned, "apiKeyFile", "execution runner material");
    // #953: a `secret://<name>` reference, not the secret itself — same
    // freeze-safety rationale as apiKeyFile above.
    validateOptionalString(cloned, "apiKeySecretRef", "execution runner material");
  } else if (kind === "agent") {
    assertKeys(cloned, ["kind", "engine", "profile", "timeoutMs"], "execution runner material");
    validateProfile(cloned.profile, "execution runner material.profile");
  } else if (kind === "sdk") {
    assertKeys(
      cloned,
      [
        "kind",
        "engine",
        "profile",
        "fallbackConnection",
        "fallbackCredential",
        "fallbackApiKeyFile",
        "fallbackApiKeySecretRef",
        "fallbackTimeoutMs",
        "timeoutMs",
      ],
      "execution runner material",
    );
    validateProfile(cloned.profile, "execution runner material.profile");
    if (own(cloned, "fallbackConnection")) {
      validateConnection(
        cloned.fallbackConnection,
        "execution runner material.fallbackConnection",
        !options.allowMissingSdkFallbackModel,
      );
    }
    if (own(cloned, "fallbackCredential")) {
      validateCredential(cloned.fallbackCredential, "execution runner material.fallbackCredential");
    }
    validateOptionalString(cloned, "fallbackApiKeyFile", "execution runner material");
    validateOptionalString(cloned, "fallbackApiKeySecretRef", "execution runner material");
    if (own(cloned, "fallbackTimeoutMs")) {
      validateTimeout(cloned.fallbackTimeoutMs, "execution runner material.fallbackTimeoutMs");
    }
  } else {
    throw new TypeError("execution runner material.kind must be llm, agent, or sdk");
  }
  return cloned as unknown as RunnerSpec;
}

/** Strict public decoder for persisted, non-secret runner/transport material. */
export function decodeFrozenRunnerSpec(input: unknown): RunnerSpec {
  const runner = snapshotRunnerSpec(input as RunnerSpec);
  if (runner.kind !== "llm") {
    for (const [name, value] of Object.entries(runner.profile.env ?? {})) {
      if (runnerEnvironmentValueLooksSecret(name, value)) {
        throw new TypeError(
          "execution runner material.profile.env contains a secret-shaped literal; freeze only symbolic environment names",
        );
      }
    }
  }
  return runner;
}

function lowererEntries(): readonly (readonly [string, AgentRequestLowerer])[] {
  return HARNESS_REGISTRY.map((harness) => {
    const lowerer =
      harness.agentBuilder?.lower !== undefined
        ? ({
            platform: harness.agentBuilder.platform,
            personaChannel: harness.agentBuilder.personaChannel,
            lower: harness.agentBuilder.lower,
          } satisfies AgentRequestLowerer)
        : harness.executionLowerer;
    if (!lowerer) {
      throw new Error(`dispatch harness ${harness.id} has no registered resolved-request lowerer`);
    }
    if (lowerer.platform !== harness.id) {
      throw new Error(`dispatch harness ${harness.id} registered mismatched lowerer ${lowerer.platform}`);
    }
    return [harness.id, lowerer] as const;
  });
}

const AGENT_LOWERERS: ReadonlyMap<string, AgentRequestLowerer> = new Map(lowererEntries());

function requireRunnerShape(request: ResolvedExecutionRequestV1, runner: RunnerSpec): void {
  if (!own(runner, "engine") || runner.engine !== request.engine.name) {
    throw new ConfigError(
      `Resolved engine ${JSON.stringify(request.engine.name)} changed engine identity before lowering.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (request.engine.kind !== runner.kind) {
    throw new ConfigError(
      `Resolved engine ${JSON.stringify(request.engine.name)} changed transport kind before lowering.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const platform = own(request.engine, "platform") ? request.engine.platform : undefined;
  const runnerPlatform =
    runner.kind === "llm"
      ? (runner.connection.provider ?? runner.engine)
      : (runner.profile.platform ?? runner.profile.name);
  // A selected platform is an identity binding rather than a capability hint.
  if (typeof platform === "string" && platform !== runnerPlatform) {
    throw new ConfigError(
      `Resolved engine ${JSON.stringify(request.engine.name)} changed provider/harness platform before lowering.`,
      "INVALID_CONFIG_FILE",
    );
  }
}

interface DirectLlmFailureClassification {
  readonly reason: AgentFailureReason;
  readonly code?: LlmCallErrorCode;
}

const LLM_CALL_ERROR_CODES = new Set<LlmCallErrorCode>([
  "aborted",
  "timeout",
  "rate_limited",
  "parse_error",
  "provider_html_error",
  "network_error",
  "provider_error",
]);

function safeLlmCallErrorCode(error: unknown): LlmCallErrorCode | undefined {
  if (!(error instanceof LlmCallError)) return undefined;
  const descriptor = Reflect.getOwnPropertyDescriptor(error, "code");
  if (!descriptor || !("value" in descriptor) || !LLM_CALL_ERROR_CODES.has(descriptor.value as LlmCallErrorCode)) {
    return undefined;
  }
  return descriptor.value as LlmCallErrorCode;
}

function directLlmFailure(error: unknown): DirectLlmFailureClassification {
  const code = safeLlmCallErrorCode(error);
  if (!code) return { reason: "spawn_failed" };
  switch (code) {
    case "aborted":
      return { reason: "aborted", code };
    case "timeout":
      return { reason: "timeout", code };
    case "rate_limited":
      return { reason: "llm_rate_limit", code };
    case "parse_error":
    case "provider_html_error":
      return { reason: "parse_error", code };
    case "network_error":
    case "provider_error":
      return { reason: "spawn_failed", code };
  }
}

function safeCaughtErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const descriptor = Reflect.getOwnPropertyDescriptor(error, "message");
    if (descriptor && "value" in descriptor && typeof descriptor.value === "string") return descriptor.value;
  }
  if (error === null || error === undefined || typeof error === "number" || typeof error === "boolean") {
    return String(error);
  }
  return "LLM transport failed.";
}

function requestRuntimeOptions(request: ResolvedExecutionRequestV1): Readonly<RunAgentOptions> {
  const options: Record<string, unknown> = sterileRecord({ stdio: "captured", parseOutput: "text" });
  if (own(request.runtime, "timeoutMs")) options.timeoutMs = request.runtime.timeoutMs;
  if (own(request.runtime, "workspace") && typeof request.runtime.workspace === "string") {
    options.cwd = request.runtime.workspace;
  }
  if (own(request.runtime, "environment") && request.runtime.environment !== null) {
    options.env = request.runtime.environment;
  }
  return Object.freeze(options) as Readonly<RunAgentOptions>;
}

function projectAgentRunner(
  base: Extract<RunnerSpec, { kind: "agent" | "sdk" }>,
  request: ResolvedExecutionRequestV1,
): Extract<RunnerSpec, { kind: "agent" | "sdk" }> {
  const settings = own(request.engine, "settings") ? request.engine.settings : undefined;
  const profile: Record<string, unknown> = sterileRecord({ ...base.profile });
  delete profile.model;
  delete profile.workspace;
  if (own(request, "model") && request.model) {
    profile.model = request.model.resolved;
  }
  if (own(request.runtime, "workspace") && typeof request.runtime.workspace === "string") {
    profile.workspace = request.runtime.workspace;
  }
  if (settings) {
    if (own(settings, "bin") && typeof settings.bin === "string") profile.bin = settings.bin;
    if (
      own(settings, "args") &&
      Array.isArray(settings.args) &&
      settings.args.every((entry) => typeof entry === "string")
    ) {
      profile.args = Object.freeze([...settings.args]);
    }
  }
  const common: Record<string, unknown> = {
    ...base,
    profile: Object.freeze(profile) as unknown as typeof base.profile,
  };
  const sdkFallbackModelFromRequest =
    base.kind === "sdk" &&
    settings !== null &&
    settings !== undefined &&
    own(settings, SDK_FALLBACK_MODEL_FROM_REQUEST_SETTING);
  const clearsSdkFallbackModel = base.kind === "sdk" && base.fallbackConnection !== undefined && request.model === null;
  if (sdkFallbackModelFromRequest && settings?.[SDK_FALLBACK_MODEL_FROM_REQUEST_SETTING] !== true) {
    throw new ConfigError("Resolved SDK fallback model marker is invalid.", "INVALID_CONFIG_FILE");
  }
  if (sdkFallbackModelFromRequest && (!base.fallbackConnection || !own(request, "model"))) {
    throw new ConfigError("Resolved SDK fallback model material is incomplete.", "INVALID_CONFIG_FILE");
  }
  if (base.kind === "sdk" && base.fallbackConnection) {
    const fallbackConnection: Record<string, unknown> = sterileRecord({ ...base.fallbackConnection });
    if (sdkFallbackModelFromRequest || clearsSdkFallbackModel) {
      delete fallbackConnection.model;
      if (sdkFallbackModelFromRequest && request.model) fallbackConnection.model = request.model.resolved;
    }
    if (own(request, "inference")) {
      for (const key of LLM_INFERENCE_CONNECTION_FIELDS) delete fallbackConnection[key];
      if (request.inference) {
        for (const key of LLM_INFERENCE_CONNECTION_FIELDS) {
          if (own(request.inference, key)) fallbackConnection[key] = request.inference[key];
        }
      }
    }
    common.fallbackConnection = Object.freeze(fallbackConnection) as LlmConnectionConfig;
  }
  delete common.timeoutMs;
  if (own(request.runtime, "timeoutMs")) common.timeoutMs = request.runtime.timeoutMs;
  else if (own(base, "timeoutMs")) common.timeoutMs = base.timeoutMs;
  return snapshotRunnerSpec(common as unknown as RunnerSpec, {
    allowMissingSdkFallbackModel: clearsSdkFallbackModel,
  }) as Extract<RunnerSpec, { kind: "agent" | "sdk" }>;
}

function selectedExtensionPaths(request: ResolvedExecutionRequestV1): string[] {
  const out: string[] = [];
  if (own(request, "extensions")) out.push("extensions");
  if (own(request.command, "extensions")) out.push("command.extensions");
  const persona = own(request, "persona") ? request.persona : undefined;
  if (persona && own(persona, "extensions")) out.push("persona.extensions");
  if (own(request.engine, "extensions")) out.push("engine.extensions");
  if (own(request.runtime, "extensions")) out.push("runtime.extensions");
  return out;
}

const LLM_INFERENCE_CONNECTION_FIELDS = new Set([
  "temperature",
  "maxTokens",
  "supportsJsonSchema",
  "extraParams",
  "contextLength",
  "enableThinking",
  "reasoningEffort",
]);

function projectLlmRunner(
  base: Extract<RunnerSpec, { kind: "llm" }>,
  request: ResolvedExecutionRequestV1,
): Extract<RunnerSpec, { kind: "llm" }> {
  const connection: Record<string, unknown> = sterileRecord({ ...base.connection });
  for (const key of [
    "model",
    "temperature",
    "maxTokens",
    "supportsJsonSchema",
    "extraParams",
    "contextLength",
    "enableThinking",
    "reasoningEffort",
  ]) {
    delete connection[key];
  }
  const settings = own(request.engine, "settings") ? request.engine.settings : undefined;
  if (settings) {
    if (own(settings, "endpoint") && typeof settings.endpoint === "string") connection.endpoint = settings.endpoint;
    if (own(settings, "provider") && typeof settings.provider === "string") connection.provider = settings.provider;
  }
  if (own(request, "model") && request.model) connection.model = request.model.resolved;
  const inference = own(request, "inference") ? request.inference : undefined;
  if (inference) {
    for (const key of LLM_INFERENCE_CONNECTION_FIELDS) {
      if (own(inference, key)) connection[key] = inference[key];
    }
  }
  const projected: Record<string, unknown> = {
    ...base,
    connection: Object.freeze(connection) as LlmConnectionConfig,
  };
  delete projected.timeoutMs;
  if (own(request.runtime, "timeoutMs")) projected.timeoutMs = request.runtime.timeoutMs;
  else if (own(base, "timeoutMs")) projected.timeoutMs = base.timeoutMs;
  return snapshotRunnerSpec(projected as unknown as RunnerSpec, { allowMissingLlmModel: true }) as Extract<
    RunnerSpec,
    { kind: "llm" }
  >;
}

function lowerAgent(
  request: ResolvedExecutionRequestV1,
  base: Extract<RunnerSpec, { kind: "agent" | "sdk" }>,
): LoweredAgentExecutionRequest {
  const platform = own(request.engine, "platform") ? request.engine.platform : undefined;
  if (typeof platform !== "string") {
    throw new ConfigError(
      `Resolved agent engine ${JSON.stringify(request.engine.name)} has no platform.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const lowerer = AGENT_LOWERERS.get(platform);
  if (!lowerer) {
    throw new ConfigError(
      `Agent platform ${JSON.stringify(platform)} has no registered lowerer.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const runner = projectAgentRunner(base, request);
  const lowered = lowerer.lower(runner.profile, request);
  const options = Object.freeze(sterileRecord({ ...requestRuntimeOptions(request), dispatch: lowered.dispatch }));
  return registerLoweredExecution({
    schemaVersion: EXECUTION_LOWERING_SCHEMA_VERSION,
    request,
    adapter: platform,
    runner,
    prompt: lowered.prompt,
    dispatch: lowered.dispatch,
    options,
    translatedFields: sortedUnique([
      ...lowered.translatedFields,
      ...(own(request.engine, "settings") ? ["engine.settings"] : []),
    ]),
    untranslatedFields: lowered.untranslatedFields,
    notices: freezeNotices([...safeRequestNotices(request), ...lowered.notices]),
  });
}

function lowerLlm(
  request: ResolvedExecutionRequestV1,
  base: Extract<RunnerSpec, { kind: "llm" }>,
): LoweredLlmExecutionRequest {
  const runner = projectLlmRunner(base, request);
  const translated = new Set<string>(["command.content", "engine"]);
  const untranslated = new Set<string>();
  const notices: Readonly<LoweringNotice>[] = [...safeRequestNotices(request)];
  const reject = (field: string): void => {
    untranslated.add(field);
    notices.push(untranslatedNotice("llm", field));
  };
  if (own(request.engine, "settings")) translated.add("engine.settings");
  if (own(request, "model")) translated.add("model");
  if (own(request, "persona")) translated.add("persona");
  if (own(request, "agent")) {
    if (typeof request.agent === "string" && request.persona === null) {
      throw new ConfigError(
        `The direct LLM transport cannot consume native agent selector ${JSON.stringify(request.agent)}.`,
        "INVALID_CONFIG_FILE",
      );
    }
    translated.add("agent");
  }
  if (own(request, "conversation")) translated.add("conversation");
  if (own(request, "inference")) {
    const inference = request.inference;
    if (inference && Object.keys(inference).length > 0) {
      for (const key of Object.keys(inference).sort()) {
        const field = `inference.${key}`;
        if (LLM_INFERENCE_CONNECTION_FIELDS.has(key)) translated.add(field);
        else reject(field);
      }
    } else {
      translated.add("inference");
    }
  }
  const chatOptions: Record<string, unknown> = sterileRecord({});
  if (own(request.runtime, "timeoutMs")) {
    translated.add("runtime.timeoutMs");
    chatOptions.timeoutMs = request.runtime.timeoutMs;
  }
  if (own(request, "outputSchema")) {
    if (request.outputSchema === null) translated.add("outputSchema");
    else if (runner.connection.supportsJsonSchema === true) {
      translated.add("outputSchema");
      chatOptions.responseSchema = request.outputSchema;
    } else reject("outputSchema");
  }
  if (own(request, "tools")) {
    const tools = request.tools as ToolSelection;
    const empty =
      tools === null ||
      tools === "" ||
      (Array.isArray(tools) && tools.length === 0) ||
      (typeof tools === "object" && tools !== null && !Array.isArray(tools) && Object.keys(tools).length === 0);
    if (empty) translated.add("tools");
    else reject("tools");
  }
  if (own(request.runtime, "workspace")) {
    if (request.runtime.workspace === null || request.runtime.workspace === "") translated.add("runtime.workspace");
    else reject("runtime.workspace");
  }
  if (own(request.runtime, "environment")) {
    const environment = request.runtime.environment;
    if (environment === null || environment === undefined || Object.keys(environment).length === 0) {
      translated.add("runtime.environment");
    } else reject("runtime.environment");
  }
  if (own(request.runtime, "settings")) {
    const settings = request.runtime.settings;
    if (settings === null || settings === undefined || Object.keys(settings).length === 0) {
      translated.add("runtime.settings");
    } else reject("runtime.settings");
  }
  for (const field of selectedExtensionPaths(request)) reject(field);
  const messages: readonly ChatMessage[] = Object.freeze(
    [
      ...(own(request, "persona") && request.persona
        ? [{ role: "system" as const, content: request.persona.content }]
        : []),
      ...(request.conversation ?? []),
      { role: "user" as const, content: request.command.content },
    ].map((message): ChatMessage => Object.freeze({ role: message.role, content: message.content })),
  );
  return registerLoweredExecution({
    schemaVersion: EXECUTION_LOWERING_SCHEMA_VERSION,
    request,
    adapter: "llm",
    runner,
    prompt: request.command.content,
    messages,
    chatOptions: Object.freeze(chatOptions) as Readonly<ChatCompletionOptions>,
    options: requestRuntimeOptions(request),
    translatedFields: sortedUnique(translated),
    untranslatedFields: sortedUnique(untranslated),
    notices: freezeNotices(notices),
  });
}

/** The sole live-config engine resolver used by every current execution mode. */
function resolveSnapshotRunner(engine: string, config: AkmConfig): RunnerSpec {
  return snapshotRunnerSpec(resolveEngine(engine, config));
}

/**
 * Lower one payload-free interactive launch. The input vocabulary is closed:
 * there is deliberately no command, prompt, model, tool, or arbitrary env.
 */
function lowerInteractiveAgentExecution(input: InteractiveAgentInvocationOptions): LoweredInteractiveAgentExecution {
  if (typeof input.engine !== "string" || input.engine.length === 0) {
    throw new TypeError("interactive agent execution input.engine must be a non-empty string");
  }
  if (input.timeoutMs !== undefined) {
    validateTimeout(input.timeoutMs, "interactive agent execution input.timeoutMs");
  }
  if (input.cwd !== undefined && typeof input.cwd !== "string") {
    throw new TypeError("interactive agent execution input.cwd must be a string");
  }

  const runner = resolveSnapshotRunner(input.engine, snapshotConfig(input.config));
  if (runner.kind === "llm") {
    throw new UsageError(
      `Engine "${input.engine}" is an LLM engine; akm agent requires an agent engine.`,
      "INVALID_FLAG_VALUE",
    );
  }

  const options = Object.freeze(
    sterileRecord({
      stdio: runner.kind === "sdk" ? runner.profile.stdio : ("interactive" as const),
      parseOutput: "text" as const,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    }),
  ) as Readonly<RunAgentOptions>;
  return Object.freeze({
    engine: input.engine,
    runner,
    options,
  });
}

/**
 * The one optimistic lowering boundary. Authorization and request-brand
 * validation precede config, registry, credential, and transport work.
 */
export function lowerResolvedExecutionRequest(
  input: ResolvedExecutionRequestV1,
  config: AkmConfig,
): LoweredExecutionRequest {
  const request = requireAuthorizedRequest(input);
  const frozenConfig = snapshotConfig(config);
  const base = resolveSnapshotRunner(request.engine.name, frozenConfig);
  requireRunnerShape(request, base);
  return base.kind === "llm" ? lowerLlm(request, base) : lowerAgent(request, base);
}

/**
 * Lower from already-frozen, symbolic runner material. Workflow resume uses
 * this entry point so no live config, alias, environment, or credential lookup
 * can alter a journaled request before dispatch.
 */
export function lowerResolvedExecutionRequestWithRunner(
  input: ResolvedExecutionRequestV1,
  runner: RunnerSpec,
): LoweredExecutionRequest {
  const request = requireAuthorizedRequest(input);
  const base = snapshotRunnerSpec(runner);
  requireRunnerShape(request, base);
  return base.kind === "llm" ? lowerLlm(request, base) : lowerAgent(request, base);
}

function requireLoweredExecutionProvenance(lowered: LoweredExecutionRequest): void {
  if (
    typeof lowered !== "object" ||
    lowered === null ||
    !loweredExecutionInstances.has(lowered) ||
    !Object.isFrozen(lowered)
  ) {
    throw new TypeError("lowered execution request must be produced by the engine lowerer registry");
  }
  canonicalResolvedExecutionRequest(lowered.request);
}

/**
 * Acquire an opaque operation capability only after genuine lowered-request
 * provenance and canonical authorization have been revalidated.
 */
export function acquireLoweredExecutionDispatchLease(
  lowered: LoweredExecutionRequest,
  options: AcquireLoweredExecutionDispatchLeaseOptions = {},
): LoweredExecutionDispatchLease {
  requireLoweredExecutionProvenance(lowered);
  const optionSnapshot = snapshotStrictRecord(options, "dispatch lease acquisition options");
  assertSnapshotKeys(optionSnapshot, ["envSource"], "dispatch lease acquisition options");
  const strictOptions = optionSnapshot as unknown as AcquireLoweredExecutionDispatchLeaseOptions;
  return acquireRunnerDispatchLease(lowered.runner, strictOptions.envSource ?? process.env);
}

/** Idempotently scrub and invalidate a genuine operation dispatch lease. */
export function disposeLoweredExecutionDispatchLease(lease: LoweredExecutionDispatchLease): void {
  disposeRunnerDispatchLease(lease);
}

/** Redact text with a lease's private credential inventory without exposing it. */
export function redactWithLoweredExecutionDispatchLease(lease: LoweredExecutionDispatchLease, value: string): string {
  return redactWithRunnerDispatchLease(lease, value);
}

/** One raw runner symbol reference for every shared execution dispatch mode. */
function runnerDispatcher(candidate?: typeof executeRunner): typeof executeRunner {
  return candidate ?? executeRunner;
}

async function dispatchLoweredInteractiveAgentExecution(
  lowered: LoweredInteractiveAgentExecution,
  seams: InteractiveAgentInvocationSeams,
): Promise<AgentRunResult> {
  const lease = acquireRunnerDispatchLease(lowered.runner, process.env);
  try {
    return await runnerDispatcher()(
      lowered.runner,
      "",
      lowered.options,
      {
        ...(seams.runAgent ? { runAgent: seams.runAgent } : {}),
        ...(seams.runSdk ? { runSdk: seams.runSdk } : {}),
      },
      lease,
    );
  } finally {
    disposeRunnerDispatchLease(lease);
  }
}

/** Resolve, lower, and dispatch one native interactive agent invocation. */
export async function executeInteractiveAgentInvocation(
  input: InteractiveAgentInvocationOptions,
  seams: InteractiveAgentInvocationSeams = {},
): Promise<InteractiveAgentInvocationResult> {
  const lowered = lowerInteractiveAgentExecution(input);
  return {
    engine: lowered.engine,
    result: await dispatchLoweredInteractiveAgentExecution(lowered, seams),
  };
}

/** Dispatch a previously lowered request without re-resolving any model, ref, or persona. */
export async function dispatchLoweredExecutionRequest(
  lowered: LoweredExecutionRequest,
  options: DispatchLoweredExecutionOptions = {},
): Promise<AgentRunResult> {
  requireLoweredExecutionProvenance(lowered);
  const optionSnapshot = snapshotStrictRecord(options, "lowered execution dispatch options");
  assertSnapshotKeys(
    optionSnapshot,
    ["executeRunner", "chat", "onRetryAttempt", "runAgent", "runSdk", "lease", "runOptions", "eventSource"],
    "lowered execution dispatch options",
  );
  const strictOptions = optionSnapshot as unknown as DispatchLoweredExecutionOptions;
  if (strictOptions.onRetryAttempt !== undefined && typeof strictOptions.onRetryAttempt !== "function") {
    throw new TypeError("lowered execution dispatch options.onRetryAttempt must be a function");
  }
  if (strictOptions.eventSource !== undefined && typeof strictOptions.eventSource !== "string") {
    throw new TypeError("lowered execution dispatch options.eventSource must be a string");
  }
  const usesDefaultRunner = strictOptions.executeRunner === undefined;
  const run = runnerDispatcher(strictOptions.executeRunner);
  const operationalSnapshot = snapshotStrictRecord(
    strictOptions.runOptions ?? {},
    "lowered execution operational options",
  );
  assertSnapshotKeys(
    operationalSnapshot,
    [
      "stdio",
      "timeoutMs",
      "parseOutput",
      "env",
      "cwd",
      "args",
      "stdin",
      "signal",
      "envSource",
      "spawn",
      "setTimeoutFn",
      "clearTimeoutFn",
      "onEvent",
      "dispatch",
      "builderRegistry",
    ],
    "lowered execution operational options",
  );
  const operational = operationalSnapshot as unknown as Partial<RunAgentOptions>;
  const runOptions = sterileRecord({
    ...lowered.options,
    ...(operational.stdio !== undefined ? { stdio: operational.stdio } : {}),
    ...(operational.parseOutput !== undefined ? { parseOutput: operational.parseOutput } : {}),
    ...(operational.signal !== undefined ? { signal: operational.signal } : {}),
    ...(operational.envSource !== undefined ? { envSource: operational.envSource } : {}),
    ...(operational.spawn !== undefined ? { spawn: operational.spawn } : {}),
    ...(operational.setTimeoutFn !== undefined ? { setTimeoutFn: operational.setTimeoutFn } : {}),
    ...(operational.clearTimeoutFn !== undefined ? { clearTimeoutFn: operational.clearTimeoutFn } : {}),
    ...(operational.onEvent !== undefined ? { onEvent: operational.onEvent } : {}),
    // F-1 (spec docs/plans/specs/p1b-model-extraction.md §5.2 point 3): the
    // ONE narrowly-scoped exception to "resolved content cannot be
    // overridden" — sets exactly the one named key, never a caller-supplied
    // env bag (runOptions.env stays unhonored, same as before P1b; see
    // DispatchLoweredExecutionOptions.eventSource's doc).
    ...(strictOptions.eventSource !== undefined
      ? { env: { ...lowered.options.env, AKM_EVENT_SOURCE: strictOptions.eventSource } }
      : {}),
  });
  const ownedLease = strictOptions.lease === undefined && usesDefaultRunner;
  const lease =
    strictOptions.lease ??
    (ownedLease ? acquireRunnerDispatchLease(lowered.runner, runOptions.envSource ?? process.env) : undefined);
  if (lease) assertRunnerDispatchLease(lease, lowered.runner);
  try {
    return await run(
      lowered.runner,
      lowered.prompt,
      runOptions,
      {
        ...(strictOptions.runAgent ? { runAgent: strictOptions.runAgent } : {}),
        ...(strictOptions.runSdk ? { runSdk: strictOptions.runSdk } : {}),
        ...("messages" in lowered
          ? {
              llm: async (spec, _prompt, runOptions) => {
                const started = Date.now();
                try {
                  const stdout = await (strictOptions.chat ?? chatCompletion)(spec.connection, [...lowered.messages], {
                    ...lowered.chatOptions,
                    ...(!own(lowered.chatOptions, "timeoutMs") && own(runOptions, "timeoutMs")
                      ? { timeoutMs: runOptions.timeoutMs }
                      : {}),
                    ...(runOptions.signal ? { signal: runOptions.signal } : {}),
                    ...(strictOptions.onRetryAttempt ? { onRetryAttempt: strictOptions.onRetryAttempt } : {}),
                  });
                  return { ok: true, exitCode: 0, stdout, stderr: "", durationMs: Date.now() - started };
                } catch (error) {
                  // Return through executeRunner so its credential-aware redactor
                  // handles provider bodies before any caller can persist them.
                  const failure = directLlmFailure(error);
                  return {
                    ok: false,
                    exitCode: null,
                    stdout: "",
                    stderr: "",
                    durationMs: Date.now() - started,
                    error: safeCaughtErrorMessage(error),
                    reason: failure.reason,
                    ...(failure.code ? { llmErrorCode: failure.code } : {}),
                  };
                }
              },
            }
          : {}),
      },
      lease,
    );
  } finally {
    if (ownedLease && lease) disposeRunnerDispatchLease(lease);
  }
}
