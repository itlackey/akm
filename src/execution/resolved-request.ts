// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type ExecutionJsonObject, type ExecutionJsonValue, sortExecutionJson } from "./json";
import {
  type AdapterRenderedCommandSource,
  type AdapterRenderedPersonaSource,
  decodeExecutionSourceIdentity,
  type ExecutionSourceIdentity,
} from "./source";

export const RESOLVED_EXECUTION_SCHEMA_VERSION = 2 as const;

export interface ResolvedCommandContent {
  /** Adapter-rendered or anonymous content before portable argument substitution. */
  readonly template: string;
  /** Omitted means no argument input; an explicit empty string is meaningful. */
  readonly argumentInput?: string;
  /** Final command content after the caller's approved one-pass substitution. */
  readonly content: string;
  /** `null` only for explicitly anonymous inline command content. */
  readonly source: Readonly<ExecutionSourceIdentity> | null;
}

export interface ResolvedPersonaContent {
  readonly content: string;
  /** Personas are selected assets; anonymous inline persona input is not a surface. */
  readonly source: Readonly<ExecutionSourceIdentity>;
}

/** What a request runs on: a connection (a model endpoint) or a harness (an agent program). */
export interface ResolvedTargetSelection {
  readonly name: string;
  readonly kind: "connection" | "harness";
  /** The harness's platform; absent for a connection. */
  readonly platform?: string;
}

export interface ResolvedModelSelection {
  /** The exact model identifier sent to the endpoint or passed to the harness. */
  readonly model: string;
  /** The alias the request named, when it named one. */
  readonly alias?: string;
}

export interface ResolvedRuntimeSettings {
  readonly timeoutMs?: number | null;
  readonly workspace?: string | null;
  readonly environment?: Readonly<Record<string, string>> | null;
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
  readonly target: Readonly<ResolvedTargetSelection>;
  readonly model?: Readonly<ResolvedModelSelection> | null;
  readonly inference?: ExecutionJsonObject | null;
  readonly outputSchema?: ExecutionJsonObject | null;
  /** Unattended model work: it changes nothing directly, so the stash stays read-only to it. */
  readonly modelWork: boolean;
  readonly runtime: Readonly<ResolvedRuntimeSettings>;
}

export type ResolvedExecutionRequestInput = Omit<ResolvedExecutionRequestV1, "schemaVersion">;

const COMMAND_KEYS = ["template", "argumentInput", "content", "source"] as const;
const PERSONA_KEYS = ["content", "source"] as const;
const TARGET_KEYS = ["name", "kind", "platform"] as const;
const MODEL_KEYS = ["model", "alias"] as const;
const RUNTIME_KEYS = ["timeoutMs", "workspace", "environment"] as const;
const IDENTITY_KEYS = ["ref", "bundle", "adapter", "file", "hash"] as const;
const OPTIONAL_REQUEST_KEYS = ["conversation", "agent", "persona", "model", "inference", "outputSchema"] as const;

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
  });
}

/** Freeze one request without normalizing away optional-field presence. */
export function createResolvedExecutionRequest(input: ResolvedExecutionRequestInput): ResolvedExecutionRequestV1 {
  if (!input.command || !input.target || !input.runtime || typeof input.modelWork !== "boolean") {
    throw new TypeError("resolved execution request requires command, target, modelWork, and runtime");
  }
  const out: Record<string, unknown> = {
    schemaVersion: RESOLVED_EXECUTION_SCHEMA_VERSION,
    command: input.command,
    target: input.target,
    modelWork: input.modelWork,
    runtime: input.runtime,
    ...pick(input, OPTIONAL_REQUEST_KEYS),
  };
  return Object.freeze(out) as unknown as ResolvedExecutionRequestV1;
}

/**
 * A schemaVersion 1 request named an `engine`, carried an `authorization` result
 * and a model as `{ input, interpretation, resolved }`. Read it as the current
 * request: a `llm` engine was a connection, any other a harness (the runner
 * decoder refuses the one it can no longer run).
 */
function readVersion1Request(input: Record<string, unknown>): Record<string, unknown> {
  const engine = requireRecord(input.engine, "engine");
  if (typeof engine.name !== "string" || typeof engine.kind !== "string") {
    throw new TypeError("engine.name and engine.kind must be strings");
  }
  const authorization = requireRecord(input.authorization, "authorization");
  const { model, ...rest } = input;
  const out: Record<string, unknown> = {
    ...rest,
    target: {
      name: engine.name,
      kind: engine.kind === "llm" ? "connection" : "harness",
      ...(typeof engine.platform === "string" ? { platform: engine.platform } : {}),
    },
    modelWork: authorization.status === "allowed",
  };
  if (model !== undefined) {
    const previous = model === null ? null : requireRecord(model, "model");
    out.model =
      previous === null
        ? null
        : {
            model: previous.resolved,
            ...(previous.interpretation === "alias" ? { alias: previous.input } : {}),
          };
  }
  return out;
}

/**
 * Rehydrate a frozen JSON request after workflow resume/replay. Tolerant of
 * unknown keys; reads schemaVersion 1 as well as the current one and refuses
 * only a request written by a newer schema.
 */
export function decodeResolvedExecutionRequest(value: unknown): ResolvedExecutionRequestV1 {
  let input = requireRecord(value, "resolved execution request");
  const version = input.schemaVersion;
  if (version === 1) input = readVersion1Request(input);
  else if (version !== RESOLVED_EXECUTION_SCHEMA_VERSION) {
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
  const target = requireRecord(input.target, "target");
  if (typeof target.name !== "string" || (target.kind !== "connection" && target.kind !== "harness")) {
    throw new TypeError("target.name must be a string and target.kind must be connection or harness");
  }
  if (typeof input.modelWork !== "boolean") throw new TypeError("modelWork must be a boolean");

  const request: Record<string, unknown> = {
    command: Object.freeze({
      ...pick(command, COMMAND_KEYS),
      source: command.source === null ? null : decodeExecutionSourceIdentity(command.source, "command.source"),
    }),
    target: Object.freeze(pick(target, TARGET_KEYS)),
    modelWork: input.modelWork,
    runtime: Object.freeze(pick(requireRecord(input.runtime, "runtime"), RUNTIME_KEYS)),
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
  for (const key of ["inference", "outputSchema"] as const) {
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
    target: pick(request.target, TARGET_KEYS),
    modelWork: request.modelWork,
    runtime: pick(request.runtime, RUNTIME_KEYS),
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
  for (const key of ["inference", "outputSchema"] as const) {
    if (Object.hasOwn(request, key) && request[key] !== undefined) wire[key] = request[key];
  }
  return `${JSON.stringify(sortExecutionJson(wire as unknown as ExecutionJsonValue))}\n`;
}
