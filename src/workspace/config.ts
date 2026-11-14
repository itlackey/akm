// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The effective config the owner can read, and the validated changes they can make to it. */

import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { assertUnsettable, listConfig, setConfigValue, unsetConfigValue } from "../commands/config";
import { isRecord } from "../core/common";
import { type AkmConfig, defaultConnection, loadConfig, mutateConfig, resetConfigCache } from "../core/config/config";
import { parseConfigText, readConfigText } from "../core/config/config-io";
import { storedCredential, writeCredential } from "../core/config/credentials";
import { dropUnusableProjects, NO_PROJECT, type ProjectConfig } from "../core/config/schema/projects";
import { UsageError } from "../core/errors";
import { getConfigPath } from "../core/paths";
import { isSecretKey, REDACTED, redactUrlCredentials } from "../core/redaction";
import { hasLocalEmbeddings, noLocalEmbeddingsReason } from "../llm/embedders/onnx-runtime";
import { parseSetupFlags } from "../setup/setup-flags";
import { applySetupAnswers, type EmbeddingAnswer } from "../setup/setup-plan";
import { automaticWriteTarget, configSource, preserveUnrelatedConfig } from "./readers";
import { redactForUi } from "./redact";

/** Names that would reach Object.prototype when used as a key. */
const UNSAFE_NAMES = new Set(["__proto__", "constructor", "prototype"]);

interface ConfigEntry {
  path: string;
  value: unknown;
  /** `default` or `file` (this install's config.json); `null` when the key cannot be traced. */
  source: string | null;
}

/** Flatten to dotted leaf paths. Arrays and empty objects are leaves, matching how config layers merge. */
function configLeaves(value: unknown, prefix: string[], out: Array<{ path: string[]; value: unknown }>): void {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) configLeaves(child, [...prefix, key], out);
    return;
  }
  out.push({ path: prefix, value });
}

/**
 * What akm says about the malformed parts of `projects` in this install's config file, in its own words, and the
 * names of the projects that file holds (the others are ones akm ignores).
 */
function localProjects(configPath: string): { warnings: string[]; local: string[]; raw: Record<string, unknown> } {
  const warnings: string[] = [];
  let local: string[] = [];
  let raw: Record<string, unknown> = {};
  try {
    const text = readConfigText(configPath);
    if (text !== undefined) {
      const file = parseConfigText(text, configPath);
      if (isRecord(file.projects)) raw = file.projects;
      const kept = dropUnusableProjects(file, configPath, (_key, message) => warnings.push(message)).projects;
      local = isRecord(kept) ? Object.keys(kept) : [];
    }
  } catch {
    // An unreadable file fails the read above, not this one.
  }
  return { warnings, local, raw };
}

const redactEndpoint = (endpoint: string | undefined) =>
  endpoint === undefined ? null : redactUrlCredentials(endpoint);

export function get() {
  const live = loadConfig();
  const effective = redactForUi(listConfig(live)) as Record<string, unknown>;
  // Projects hold no credentials; redaction would turn a value such as `filters.env` into "[redacted]" and a save would write that back.
  if (live.projects) effective.projects = live.projects;
  const leaves: Array<{ path: string[]; value: unknown }> = [];
  configLeaves(effective, [], leaves);
  const entries: ConfigEntry[] = leaves.map(({ path, value }) => ({
    path: path.join("."),
    value,
    source: configSource(path),
  }));
  const named = (entries: unknown) =>
    Object.entries((entries ?? {}) as Record<string, unknown>).map(([name, entry]) => ({
      name,
      ...(entry as Record<string, unknown>),
    }));
  const env = Object.keys(process.env)
    .filter((name) => name.startsWith("AKM_"))
    .sort()
    .map((name) => ({ name, value: isSecretKey(name, "") ? REDACTED : (process.env[name] ?? "") }));
  const configPath = getConfigPath();
  const projects = localProjects(configPath);
  return {
    path: configPath,
    projectWarnings: projects.warnings,
    exists: fs.existsSync(configPath),
    config: effective,
    // What the embedding settings need beyond the config: whether this platform has the built-in embedder, and the
    // endpoint the stored embedding key belongs to (never the key).
    localEmbeddings: hasLocalEmbeddings(),
    embeddingKeyEndpoint: redactEndpoint(storedCredential({ service: "embedding" })?.endpoint),
    automaticWriteTarget: automaticWriteTarget(live),
    entries,
    connections: named(effective.connections).map((connection) => ({
      ...connection,
      // The configured keys that name it, so a reader can say what depends on it.
      usedBy: connectionReferences(live, connection.name),
      // `file` when this install's config.json sets it, else `default`.
      source: configSource(["connections", connection.name]),
    })),
    // The connection named `default`, else the only one, else none: the rule every consumer without a `connection` follows.
    defaultConnection: defaultConnection(live)?.name ?? null,
    harnesses: named(effective.harnesses),
    env,
  };
}

/**
 * Set and unset config keys through the same validated path as `akm config set` / `unset`: each value is coerced
 * and checked against the schema, literal API keys are refused, and the whole file is validated before one atomic
 * write. An unset the CLI refuses (`assertUnsettable`) or skips (no config file) is refused or skipped here too.
 */
export function change(input: { set?: Record<string, string>; unset?: string[] }) {
  const set = input.set ?? {};
  const unset = input.unset ?? [];
  if (typeof set !== "object" || Array.isArray(set)) throw new UsageError("set must be an object of config keys.");
  if (!Array.isArray(unset) || unset.some((key) => typeof key !== "string" || !key.trim()))
    throw new UsageError("unset must be a list of config keys.");
  for (const [key, value] of Object.entries(set)) {
    if (!key.trim()) throw new UsageError("Config keys must not be empty.");
    if (typeof value !== "string")
      throw new UsageError(`The value for ${key} must be a string, as on the command line.`);
  }
  if (Object.keys(set).length === 0 && unset.length === 0) return { saved: false };
  const result = mutateConfig(
    (current) => {
      let updated = current;
      for (const [key, value] of Object.entries(set)) updated = setConfigValue(updated, key, value);
      for (const key of unset) {
        assertUnsettable(key);
        updated = unsetConfigValue(updated, key);
      }
      if (updated !== current) preserveUnrelatedConfig(current);
      return updated;
    },
    // With no config file there is nothing to unset; a set still has to create it.
    { absentNoop: Object.keys(set).length === 0 },
  );
  resetConfigCache();
  return { saved: result.written };
}

/**
 * Add, replace, rename (set the new name and unset the old) and remove `projects` entries in one atomic write.
 * Each entry is a whole project, written as sent (the reader takes a project whole by name); the complete config is
 * validated as for `change`, so akm's schema decides what is accepted. Names are not dotted config keys, so a name
 * may contain a dot. A project this install's config.json does not hold (one akm ignores) cannot be
 * unset or renamed here, as `akm config unset` refuses a key it cannot remove.
 */
export function changeProjects(input: { set?: Record<string, ProjectConfig>; unset?: string[] }) {
  const set = input.set ?? {};
  const unset = input.unset ?? [];
  if (!isRecord(set) || Object.values(set).some((project) => !isRecord(project)))
    throw new UsageError("set must be an object of project names to project objects.");
  if (!Array.isArray(unset) || unset.some((name) => typeof name !== "string"))
    throw new UsageError("unset must be a list of project names.");
  for (const name of Object.keys(set)) {
    if (!name.trim() || name === NO_PROJECT || UNSAFE_NAMES.has(name))
      throw new UsageError(`"${name}" cannot name a project.`);
  }
  if (Object.keys(set).length === 0 && unset.length === 0) return { saved: false };
  const { local: held, raw } = localProjects(getConfigPath());
  for (const name of unset) {
    if (!held.includes(name))
      throw new UsageError(
        `Project "${name}" is not in ${getConfigPath()}, so it cannot be removed or renamed here.`,
        "TARGET_NOT_UPDATABLE",
        "akm ignores it: edit the file that holds it.",
      );
  }
  // A set is a no-op only when the file already holds exactly that entry, whatever akm makes of the file's own.
  const writeProjects = Object.keys(set).filter((name) => !isDeepStrictEqual(raw[name], set[name]));
  if (writeProjects.length === 0 && unset.length === 0) return { saved: false };
  const result = mutateConfig(
    (current) => {
      const projects: Record<string, ProjectConfig> = { ...current.projects };
      for (const name of unset) delete projects[name];
      Object.assign(projects, set);
      preserveUnrelatedConfig(current);
      return { ...current, projects };
    },
    { absentNoop: Object.keys(set).length === 0, writeProjects },
  );
  resetConfigCache();
  return { saved: result.written };
}

/** Where configured work names a connection: the dotted paths of every `connection` key holding `name`. */
function connectionReferences(value: unknown, name: string, prefix: string[] = []): string[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = [...prefix, key];
    if (key === "connection" && child === name) return [path.join(".")];
    return prefix.length === 0 && key === "connections" ? [] : connectionReferences(child, name, path);
  });
}

/**
 * Remove one connection through the same validated, atomic path as `akm config unset connections.<name>`, and say what
 * the removal touches: the configured `connection` references to the name (a connection named explicitly is never
 * replaced by the default, so each of them fails with "Connection is not configured" until it is changed), whether it was the default and which connection is after.
 */
export function removeConnection(input: { name: string }) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new UsageError("A connection name is required.", "MISSING_REQUIRED_ARGUMENT");
  const before = loadConfig();
  if (!Object.hasOwn(before.connections ?? {}, name)) throw new UsageError(`No connection named "${name}".`);
  const references = connectionReferences(before, name);
  const wasDefault = defaultConnection(before)?.name === name;
  const { saved } = change({ unset: [`connections.${name}`] });
  const after = loadConfig();
  return {
    saved,
    references,
    wasDefault,
    defaultConnection: defaultConnection(after)?.name ?? null,
  };
}

/**
 * `entry` with every mask the view showed (`redactForUi`) replaced by the stored value at the same path. A mask with no
 * stored value behind it is refused: a save never writes one.
 */
function unmask(entry: unknown, stored: unknown, path: string): unknown {
  if (entry === REDACTED) {
    if (stored === undefined || stored === REDACTED)
      throw new UsageError(`${path} is the masked placeholder, not a value: enter the value or remove the field.`);
    return stored;
  }
  if (Array.isArray(entry)) {
    const old = Array.isArray(stored) ? stored : [];
    return entry.map((child, index) => unmask(child, old[index], `${path}[${index}]`));
  }
  if (!isRecord(entry)) return entry;
  const old = isRecord(stored) ? stored : {};
  return Object.fromEntries(
    Object.entries(entry).map(([key, child]) => [key, unmask(child, old[key], `${path}.${key}`)]),
  );
}

/**
 * Replace one connection with `entry` as a whole, through the same validated atomic write as `change`. Keys the entry
 * no longer has (a removed alias, cleared request options) leave the file, which a dotted `set` of the entry would not
 * do. A literal API key is refused.
 */
export function saveConnection(input: { name: string; entry: Record<string, unknown> }) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new UsageError("A connection name is required.", "MISSING_REQUIRED_ARGUMENT");
  if (UNSAFE_NAMES.has(name)) throw new UsageError(`"${name}" cannot name a connection.`);
  if (!isRecord(input.entry)) throw new UsageError("entry must be a connection object.");
  const key = input.entry.apiKey;
  if (key !== undefined && (typeof key !== "string" || !key.startsWith("$")))
    throw new UsageError(
      `connections.${name}.apiKey must be an environment-variable reference such as $OPENAI_API_KEY, not the key itself.`,
    );
  const result = mutateConfig((current) => {
    // What the UI showed carries a mask for each secret; the stored value is what a field the person did not change keeps.
    const entry = unmask(
      input.entry,
      current.connections?.[name] ?? loadConfig().connections?.[name],
      `connections.${name}`,
    );
    // Already exactly this: nothing to write.
    if (isDeepStrictEqual(current.connections?.[name], entry)) return current;
    preserveUnrelatedConfig(current);
    return { ...current, connections: { ...current.connections, [name]: entry } as AkmConfig["connections"] };
  });
  resetConfigCache();
  return { saved: result.written };
}

/** The answer a host sends: `endpoint` is any form `akm setup --embedding-endpoint` takes; `key` is `{ env }` or `{ pasted }`. */
export interface EmbeddingInput {
  kind: "local" | "connection" | "endpoint";
  model?: string;
  endpoint?: string;
  key?: { env?: string; pasted?: string };
}

/**
 * Set the embedding model as `akm setup` does: the same block and credential from the same answer
 * (`applySetupAnswers`), the endpoint and key variable checked and normalized as the setup flags are. A pasted key is
 * stored in `credentials.json` (`services.embedding`) first, so a bad answer fails before the config changes, and is
 * never written to config.json. Choosing an embedder turns semantic search on. Returns the block now configured.
 */
export function saveEmbedding(input: EmbeddingInput) {
  const answer = embeddingAnswer(input);
  const before = loadConfig();
  if (answer.kind === "local" && !hasLocalEmbeddings()) throw new UsageError(noLocalEmbeddingsReason());
  if (answer.kind === "connection" && defaultConnection(before) === undefined)
    throw new UsageError(
      "No default connection serves this model. Add one, or give an endpoint.",
      "MISSING_REQUIRED_ARGUMENT",
    );
  const { patch, credentials } = applySetupAnswers(before, { embedding: answer });
  for (const { slot, key, endpoint } of credentials) writeCredential(slot, key, endpoint);
  const result = mutateConfig((current) => {
    const { embedding: _held, ...rest } = current;
    const next = {
      ...rest,
      semanticSearchMode: "auto" as const,
      ...(patch.embedding ? { embedding: patch.embedding } : {}),
    };
    if (isDeepStrictEqual(next, current)) return current;
    preserveUnrelatedConfig(current);
    return next;
  });
  resetConfigCache();
  return { saved: result.written, embedding: patch.embedding ?? null };
}

/** The answer as `akm setup --embedding … --embedding-endpoint … --embedding-api-key-env …` would take it. */
function embeddingAnswer(input: EmbeddingInput): EmbeddingAnswer {
  if (!isRecord(input)) throw new UsageError("An embedding answer is required.", "MISSING_REQUIRED_ARGUMENT");
  if (input.kind === "local") return { kind: "local" };
  if (input.kind !== "connection" && input.kind !== "endpoint")
    throw new UsageError("kind must be local, connection or endpoint.");
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model) throw new UsageError("An embedding model is required.", "MISSING_REQUIRED_ARGUMENT");
  if (input.kind === "connection") return { kind: "connection", model };
  const { env, pasted } = isRecord(input.key) ? input.key : ({} as { env?: unknown; pasted?: unknown });
  if (input.key !== undefined && typeof env !== "string" && typeof pasted !== "string")
    throw new UsageError("key must name an environment variable ({ env }) or hold the key ({ pasted }).");
  const flags = parseSetupFlags({
    embedding: model,
    embeddingEndpoint: input.endpoint,
    embeddingApiKeyEnv: typeof env === "string" ? env : undefined,
  });
  const key = typeof pasted === "string" ? pasted.trim() : "";
  if (typeof pasted === "string" && !key) throw new UsageError("The embedding key is empty.");
  return {
    kind: "endpoint",
    endpoint: flags.embeddingEndpoint as string,
    model,
    ...(flags.embeddingApiKeyEnv ? { key: { env: flags.embeddingApiKeyEnv } } : key ? { key: { pasted: key } } : {}),
  };
}
