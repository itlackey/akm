// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type ExecutionJsonObject, type ExecutionJsonValue, sortExecutionJson } from "./json";
import {
  type AdapterOwnedExtensions,
  type AdapterRenderedCommandSource,
  type AdapterRenderedPersonaSource,
  decodeExecutionSourceIdentity,
  type ExecutionSourceIdentity,
  type ToolSelection,
} from "./source";

export const RESOLVED_EXECUTION_SCHEMA_VERSION = 1 as const;

export interface ResolvedCommandContent {
  /** Adapter-rendered or anonymous content before portable argument substitution. */
  readonly template: string;
  /** Omitted means no argument input; an explicit empty string is meaningful. */
  readonly argumentInput?: string;
  /** Final command content after the caller's approved one-pass substitution. */
  readonly content: string;
  /** `null` only for explicitly anonymous inline command content. */
  readonly source: Readonly<ExecutionSourceIdentity> | null;
  readonly extensions?: AdapterOwnedExtensions;
}

export interface ResolvedPersonaContent {
  readonly content: string;
  /** Personas are selected assets; anonymous inline persona input is not a surface. */
  readonly source: Readonly<ExecutionSourceIdentity>;
  readonly extensions?: AdapterOwnedExtensions;
}

export interface ResolvedEngineSelection {
  readonly name: string;
  /** Transport family only, not a claim about model or harness capabilities. */
  readonly kind: "agent" | "sdk" | "llm";
  readonly platform?: string | null;
  readonly settings?: ExecutionJsonObject | null;
  readonly extensions?: AdapterOwnedExtensions;
}

export interface ResolvedModelSelection {
  /** Exact invocation input before alias interpretation. */
  readonly input: string;
  readonly interpretation: "alias" | "exact";
  /** Exact provider/harness model identifier after alias expansion. */
  readonly resolved: string;
  readonly extensions?: AdapterOwnedExtensions;
}

export interface ToolAuthorizationResult {
  /** `not-required` means no tool grant was selected; it is not an unknown authorization state. */
  readonly status: "allowed" | "denied" | "not-required";
  readonly reason?: string | null;
  readonly policy?: ExecutionJsonObject | null;
}

export interface ResolvedRuntimeSettings {
  readonly timeoutMs?: number | null;
  readonly workspace?: string | null;
  readonly environment?: Readonly<Record<string, string>> | null;
  readonly settings?: ExecutionJsonObject | null;
  readonly extensions?: AdapterOwnedExtensions;
}

export interface LoweringNotice {
  readonly code: string;
  readonly severity: "info" | "warning";
  readonly adapter: string;
  readonly field?: string | null;
  readonly message: string;
  readonly details?: ExecutionJsonObject | null;
}

/** One code-owned conversation turn that precedes the terminal user command. */
export interface ResolvedConversationMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** The one dispatch request shape shared by direct, task, and workflow callers. */
export interface ResolvedExecutionRequestV1 {
  readonly schemaVersion: typeof RESOLVED_EXECUTION_SCHEMA_VERSION;
  readonly command: ResolvedCommandContent;
  /** Ordered turns before the required terminal `{role:"user", command.content}` turn. */
  readonly conversation?: readonly Readonly<ResolvedConversationMessage>[];
  /** Exact selected agent ref or native harness selector; null explicitly clears selection. */
  readonly agent?: string | null;
  readonly persona?: ResolvedPersonaContent | null;
  readonly engine: Readonly<ResolvedEngineSelection>;
  readonly model?: Readonly<ResolvedModelSelection> | null;
  readonly inference?: ExecutionJsonObject | null;
  readonly outputSchema?: ExecutionJsonObject | null;
  /** Selected tools. Authorization is deliberately a separate policy result. */
  readonly tools?: ToolSelection;
  readonly authorization: Readonly<ToolAuthorizationResult>;
  readonly runtime: Readonly<ResolvedRuntimeSettings>;
  readonly notices: readonly Readonly<LoweringNotice>[];
  readonly extensions?: AdapterOwnedExtensions;
}

export type ResolvedExecutionRequestInput = Omit<ResolvedExecutionRequestV1, "schemaVersion">;

const COMMAND_KEYS = ["template", "argumentInput", "content", "source", "extensions"] as const;
const PERSONA_KEYS = ["content", "source", "extensions"] as const;
const ENGINE_KEYS = ["name", "kind", "platform", "settings", "extensions"] as const;
const MODEL_KEYS = ["input", "interpretation", "resolved", "extensions"] as const;
const AUTHORIZATION_KEYS = ["status", "reason", "policy"] as const;
const RUNTIME_KEYS = ["timeoutMs", "workspace", "environment", "settings", "extensions"] as const;
const NOTICE_KEYS = ["code", "severity", "adapter", "field", "message", "details"] as const;
const IDENTITY_KEYS = ["ref", "bundle", "adapter", "file", "hash"] as const;
const OPTIONAL_REQUEST_KEYS = [
  "conversation",
  "agent",
  "persona",
  "model",
  "inference",
  "outputSchema",
  "tools",
  "extensions",
] as const;

/** Copy the own, defined fields named by `keys`; omitted stays omitted, `null` stays `null`. */
function pick(value: object, keys: readonly string[]): Record<string, unknown> {
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(record, key) && record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function createResolvedCommand(input: {
  readonly source: AdapterRenderedCommandSource;
  readonly argumentInput?: string;
  readonly content: string;
}): ResolvedCommandContent {
  if (typeof input.content !== "string") throw new TypeError("resolved command content must be a string");
  return Object.freeze({
    template: input.source.content,
    ...(input.argumentInput !== undefined ? { argumentInput: input.argumentInput } : {}),
    content: input.content,
    source: decodeExecutionSourceIdentity(input.source.identity),
    ...(input.source.extensions ? { extensions: input.source.extensions } : {}),
  });
}

export function createInlineResolvedCommand(input: {
  readonly template: string;
  readonly argumentInput?: string;
  readonly content: string;
}): ResolvedCommandContent {
  if (typeof input.template !== "string" || typeof input.content !== "string") {
    throw new TypeError("inline command template and content must be strings");
  }
  return Object.freeze({
    template: input.template,
    ...(input.argumentInput !== undefined ? { argumentInput: input.argumentInput } : {}),
    content: input.content,
    source: null,
  });
}

export function createResolvedPersona(source: AdapterRenderedPersonaSource): ResolvedPersonaContent {
  return Object.freeze({
    content: source.content,
    source: decodeExecutionSourceIdentity(source.identity),
    ...(source.extensions ? { extensions: source.extensions } : {}),
  });
}

/** Freeze one request without normalizing away optional-field presence. */
export function createResolvedExecutionRequest(input: ResolvedExecutionRequestInput): ResolvedExecutionRequestV1 {
  if (!input.command || !input.engine || !input.authorization || !input.runtime || !input.notices) {
    throw new TypeError("resolved execution request requires command, engine, authorization, runtime, and notices");
  }
  const out: Record<string, unknown> = {
    schemaVersion: RESOLVED_EXECUTION_SCHEMA_VERSION,
    command: input.command,
    engine: input.engine,
    authorization: input.authorization,
    runtime: input.runtime,
    notices: input.notices,
    ...pick(input, OPTIONAL_REQUEST_KEYS),
  };
  return Object.freeze(out) as unknown as ResolvedExecutionRequestV1;
}

/**
 * Rehydrate a frozen JSON request after workflow resume/replay. Tolerant of
 * unknown keys; refuses only a request written by a newer schema.
 */
export function decodeResolvedExecutionRequest(value: unknown): ResolvedExecutionRequestV1 {
  const input = requireRecord(value, "resolved execution request");
  const version = input.schemaVersion;
  if (version !== RESOLVED_EXECUTION_SCHEMA_VERSION) {
    throw new TypeError(
      typeof version === "number" && version > RESOLVED_EXECUTION_SCHEMA_VERSION
        ? `resolved execution request schemaVersion ${version} was written by a newer akm; upgrade akm to run it`
        : `unsupported resolved execution schemaVersion: ${String(version)}`,
    );
  }
  const command = requireRecord(input.command, "command");
  if (typeof command.template !== "string" || typeof command.content !== "string") {
    throw new TypeError("command template and content must be strings");
  }
  const engine = requireRecord(input.engine, "engine");
  if (typeof engine.name !== "string" || (engine.kind !== "agent" && engine.kind !== "sdk" && engine.kind !== "llm")) {
    throw new TypeError("engine.name must be a string and engine.kind must be agent, sdk, or llm");
  }
  const notices = input.notices;
  if (!Array.isArray(notices)) throw new TypeError("notices must be an array");

  const request: Record<string, unknown> = {
    command: Object.freeze({
      ...pick(command, COMMAND_KEYS),
      source: command.source === null ? null : decodeExecutionSourceIdentity(command.source, "command.source"),
    }),
    engine: Object.freeze(pick(engine, ENGINE_KEYS)),
    authorization: Object.freeze(pick(requireRecord(input.authorization, "authorization"), AUTHORIZATION_KEYS)),
    runtime: Object.freeze(pick(requireRecord(input.runtime, "runtime"), RUNTIME_KEYS)),
    notices: Object.freeze(
      notices.map((notice, index) => Object.freeze(pick(requireRecord(notice, `notices[${index}]`), NOTICE_KEYS))),
    ),
  };
  if (Array.isArray(input.conversation)) {
    request.conversation = Object.freeze(
      input.conversation.map((message, index) =>
        Object.freeze(pick(requireRecord(message, `conversation[${index}]`), ["role", "content"])),
      ),
    );
  }
  if (Object.hasOwn(input, "agent") && input.agent !== undefined) request.agent = input.agent;
  if (Object.hasOwn(input, "persona") && input.persona !== undefined) {
    if (input.persona === null) request.persona = null;
    else {
      const persona = requireRecord(input.persona, "persona");
      request.persona = Object.freeze({
        ...pick(persona, PERSONA_KEYS),
        source: decodeExecutionSourceIdentity(persona.source, "persona.source"),
      });
    }
  }
  if (Object.hasOwn(input, "model") && input.model !== undefined) {
    request.model = input.model === null ? null : Object.freeze(pick(requireRecord(input.model, "model"), MODEL_KEYS));
  }
  for (const key of ["inference", "outputSchema", "tools", "extensions"] as const) {
    if (Object.hasOwn(input, key) && input[key] !== undefined) request[key] = input[key];
  }
  return createResolvedExecutionRequest(request as unknown as ResolvedExecutionRequestInput);
}

/** Stable bytes for freeze hashes and entrypoint-equivalence projections. */
export function canonicalResolvedExecutionRequest(request: ResolvedExecutionRequestV1): string {
  const wire: Record<string, unknown> = {
    schemaVersion: RESOLVED_EXECUTION_SCHEMA_VERSION,
    command: {
      ...pick(request.command, COMMAND_KEYS),
      source: request.command.source === null ? null : pick(request.command.source, IDENTITY_KEYS),
    },
    engine: pick(request.engine, ENGINE_KEYS),
    authorization: pick(request.authorization, AUTHORIZATION_KEYS),
    runtime: pick(request.runtime, RUNTIME_KEYS),
    notices: request.notices.map((notice) => pick(notice, NOTICE_KEYS)),
  };
  if (request.conversation !== undefined) {
    wire.conversation = request.conversation.map((message) => ({ role: message.role, content: message.content }));
  }
  if (Object.hasOwn(request, "agent") && request.agent !== undefined) wire.agent = request.agent;
  if (Object.hasOwn(request, "persona") && request.persona !== undefined) {
    wire.persona =
      request.persona === null
        ? null
        : { ...pick(request.persona, PERSONA_KEYS), source: pick(request.persona.source, IDENTITY_KEYS) };
  }
  if (Object.hasOwn(request, "model") && request.model !== undefined) {
    wire.model = request.model === null ? null : pick(request.model, MODEL_KEYS);
  }
  for (const key of ["inference", "outputSchema", "tools", "extensions"] as const) {
    if (Object.hasOwn(request, key) && request[key] !== undefined) wire[key] = request[key];
  }
  return `${JSON.stringify(sortExecutionJson(wire as unknown as ExecutionJsonValue))}\n`;
}
