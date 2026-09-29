// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { cloneExecutionJson, cloneExecutionJsonObject, type ExecutionJsonObject } from "./json";

export const EXECUTION_SOURCE_SCHEMA_VERSION = 1 as const;

/** Current internal adapter identifiers are lowercase kebab-case registry keys. */
export const EXECUTION_ADAPTER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Exact identity of the authoritative native file from which content was rendered. */
export interface ExecutionSourceIdentity {
  /** Fully-qualified `bundle//conceptId`; short input sugar is never frozen. */
  readonly ref: string;
  readonly bundle: string;
  readonly adapter: string;
  /** POSIX path relative to the owning bundle/component root. */
  readonly file: string;
  /** SHA-256 of the authoritative native file bytes decoded as UTF-8. */
  readonly hash: string;
}

/** Extensions are keyed by their owning adapter, not merged into common fields. */
export type AdapterOwnedExtensions = Readonly<Record<string, ExecutionJsonObject>>;

/** Portable selected-tool spellings; policy objects may contain nested JSON values. */
export type ToolSelection = string | readonly string[] | ExecutionJsonObject | null;

/** Ordinary defaults contributed by one command or persona source layer. */
export interface UnresolvedExecutionDefaults {
  readonly agent?: string | null;
  readonly engine?: string | null;
  readonly model?: string | null;
  readonly inference?: ExecutionJsonObject | null;
  readonly outputSchema?: ExecutionJsonObject | null;
  readonly tools?: ToolSelection;
  /** Native duration spelling or already-normalized milliseconds. */
  readonly timeout?: string | number | null;
  readonly workspace?: string | null;
  readonly environment?: Readonly<Record<string, string>> | null;
  readonly runtime?: ExecutionJsonObject | null;
}

interface AdapterRenderedExecutionSourceBase {
  readonly schemaVersion: typeof EXECUTION_SOURCE_SCHEMA_VERSION;
  readonly content: string;
  readonly defaults: Readonly<UnresolvedExecutionDefaults>;
  readonly identity: Readonly<ExecutionSourceIdentity>;
  readonly extensions?: AdapterOwnedExtensions;
}

export interface AdapterRenderedCommandSource extends AdapterRenderedExecutionSourceBase {
  readonly kind: "command";
}

export interface AdapterRenderedPersonaSource extends AdapterRenderedExecutionSourceBase {
  readonly kind: "persona";
}

export type AdapterRenderedExecutionSource = AdapterRenderedCommandSource | AdapterRenderedPersonaSource;

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

type ExtensionEntry = readonly [owner: string, values: ExecutionJsonObject];

export function createAdapterExtensions(owner: string, values: ExecutionJsonObject): AdapterOwnedExtensions;
export function createAdapterExtensions(
  first: ExtensionEntry,
  ...rest: readonly ExtensionEntry[]
): AdapterOwnedExtensions;
export function createAdapterExtensions(
  first: string | ExtensionEntry,
  second?: ExecutionJsonObject | ExtensionEntry,
  ...rest: readonly ExtensionEntry[]
): AdapterOwnedExtensions {
  const entries: readonly ExtensionEntry[] =
    typeof first === "string"
      ? [[first, second as ExecutionJsonObject]]
      : [first, ...(second === undefined ? [] : [second as ExtensionEntry]), ...rest];
  const out: Record<string, ExecutionJsonObject> = {};
  for (const [owner, values] of entries) out[owner] = cloneExecutionJsonObject(values, `extensions.${owner}`);
  return Object.freeze(out);
}

export function cloneAdapterExtensions(value: unknown, path: string): AdapterOwnedExtensions {
  const out: Record<string, ExecutionJsonObject> = {};
  for (const [owner, fields] of Object.entries(requireRecord(value, path))) {
    out[owner] = cloneExecutionJsonObject(fields, `${path}.${owner}`);
  }
  return Object.freeze(out);
}

/** A selector or layer identifier that may cross the durable execution boundary. */
export function requireStableExecutionSelector(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${path} must be a non-empty stable identifier`);
  }
  return value;
}

export function isPortableExecutionAgentSelector(value: string): boolean {
  return /^(?:[^/]+\/\/)?agents\/[^/]/.test(value);
}

export function executionPersonaMatchesSelector(selector: string, personaRef: string): boolean {
  return selector.includes("//") ? selector === personaRef : personaRef.endsWith(`//${selector}`);
}

const IDENTITY_KEYS = ["ref", "bundle", "adapter", "file", "hash"] as const;

function identityFrom(value: unknown, path: string): Readonly<ExecutionSourceIdentity> {
  const record = requireRecord(value, path);
  const out: Record<string, string> = {};
  for (const key of IDENTITY_KEYS) {
    const field = record[key];
    if (typeof field !== "string" || field.length === 0)
      throw new TypeError(`${path}.${key} must be a non-empty string`);
    out[key] = field;
  }
  return Object.freeze(out) as unknown as Readonly<ExecutionSourceIdentity>;
}

/** Copy and freeze an identity produced by an adapter renderer. */
export function createExecutionSourceIdentity(input: ExecutionSourceIdentity): Readonly<ExecutionSourceIdentity> {
  return identityFrom(input, "execution source identity");
}

/** Read a source identity back from a frozen request. */
export function decodeExecutionSourceIdentity(
  value: unknown,
  path = "execution source identity",
): Readonly<ExecutionSourceIdentity> {
  return identityFrom(value, path);
}

/** Type-check the common frontmatter defaults; unknown keys are ignored. */
export function cloneUnresolvedExecutionDefaults(
  input: UnresolvedExecutionDefaults,
  path = "execution source defaults",
): Readonly<UnresolvedExecutionDefaults> {
  const record = requireRecord(input, path);
  const present = (key: string): boolean => Object.hasOwn(record, key) && record[key] !== undefined;
  const out: Record<string, unknown> = {};
  for (const key of ["agent", "engine", "model", "workspace"] as const) {
    if (!present(key)) continue;
    const value = record[key];
    if (value !== null && typeof value !== "string") throw new TypeError(`${path}.${key} must be a string or null`);
    out[key] = value;
  }
  if (present("timeout")) {
    const timeout = record.timeout;
    if (timeout !== null && typeof timeout !== "string" && typeof timeout !== "number") {
      throw new TypeError(`${path}.timeout must be a string, number, or null`);
    }
    out.timeout = timeout;
  }
  for (const key of ["inference", "outputSchema", "runtime"] as const) {
    if (!present(key)) continue;
    out[key] = record[key] === null ? null : cloneExecutionJsonObject(record[key], `${path}.${key}`);
  }
  if (present("environment")) {
    const environment =
      record.environment === null ? null : cloneExecutionJsonObject(record.environment, `${path}.environment`);
    if (environment !== null && Object.values(environment).some((value) => typeof value !== "string")) {
      throw new TypeError(`${path}.environment values must be strings`);
    }
    out.environment = environment;
  }
  if (present("tools")) out.tools = cloneToolSelection(record.tools, `${path}.tools`);
  return Object.freeze(out) as UnresolvedExecutionDefaults;
}

export function cloneToolSelection(value: unknown, path = "tools"): ToolSelection {
  if (value === null || typeof value === "string") return value;
  const cloned = cloneExecutionJson(value, path);
  if (Array.isArray(cloned)) {
    if (cloned.some((tool) => typeof tool !== "string")) throw new TypeError(`${path} array values must be strings`);
    return cloned as readonly string[];
  }
  return cloneExecutionJsonObject(cloned, path);
}

export interface CreateAdapterRenderedExecutionSourceInput {
  readonly kind: "command" | "persona";
  /** Body-only content after the owning adapter has removed native metadata. */
  readonly content: string;
  readonly identity: ExecutionSourceIdentity;
  readonly defaults?: UnresolvedExecutionDefaults;
  readonly extensions?: AdapterOwnedExtensions;
}

/** Freeze a fully adapter-rendered, body-only source. */
export function createAdapterRenderedExecutionSource(
  input: CreateAdapterRenderedExecutionSourceInput & { readonly kind: "command" },
): AdapterRenderedCommandSource;
export function createAdapterRenderedExecutionSource(
  input: CreateAdapterRenderedExecutionSourceInput & { readonly kind: "persona" },
): AdapterRenderedPersonaSource;
export function createAdapterRenderedExecutionSource(
  input: CreateAdapterRenderedExecutionSourceInput,
): AdapterRenderedExecutionSource;
export function createAdapterRenderedExecutionSource(
  input: CreateAdapterRenderedExecutionSourceInput,
): AdapterRenderedExecutionSource {
  const { kind, content } = input;
  if (kind !== "command" && kind !== "persona") throw new TypeError("execution source kind is invalid");
  if (typeof content !== "string") throw new TypeError("execution source content must be a string");
  return Object.freeze({
    schemaVersion: EXECUTION_SOURCE_SCHEMA_VERSION,
    kind,
    content,
    defaults: cloneUnresolvedExecutionDefaults(input.defaults ?? {}),
    identity: createExecutionSourceIdentity(input.identity),
    ...(input.extensions
      ? { extensions: cloneAdapterExtensions(input.extensions, "execution source extensions") }
      : {}),
  }) as AdapterRenderedExecutionSource;
}
