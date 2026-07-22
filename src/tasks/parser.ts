// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Parse a task YAML file into a {@link TaskDocument}.
 *
 * The on-disk shape is a pure YAML file at `<stash>/tasks/<id>.yml`:
 *
 * ```yaml
 * schedule: "0 9 * * *"
 * # one of:
 * workflow: workflows/daily-backup
 * params:
 *   region: us-east-1
 * # ...or:
 * prompt: agent:my-agent            # asset ref
 * # ...or:
 * prompt: ./prompts/my-prompt.md    # relative file path
 * # ...or:
 * prompt: |                         # inline multi-line prompt (block scalar)
 *   Do the thing.
 *   And the other thing.
 * # ...or:
 * command: akm improve --auto-accept=90 --limit 25
 * enabled: true                     # default true
 * name: Daily backup
 * description: …
 * when_to_use: …
 * tags: [scheduled, backup]
 * ```
 *
 * Validation lives in {@link validateTaskDocument}. The parser enforces the
 * strict source shape; cron syntax and target reachability are
 * checked separately so callers can choose how strictly to surface errors.
 */

import path from "node:path";
import { parse as parseYaml } from "yaml";
import { stashDirFor } from "../core/asset/asset-placement";
import { isFullRefInput } from "../core/asset/resolve-ref";
import { UsageError } from "../core/errors";
import { formatExtraParamsIssue, validateExtraParams } from "../core/extra-params";
import { findBareAkmExecutableIndex } from "./command-executable";
import { TASK_SCHEMA_VERSION, type TaskDocument, type TaskPromptTarget, type TaskTarget } from "./schema";
import { validateTaskId } from "./task-id";

export interface ParseTaskInput {
  /** The full YAML contents of the task file. */
  yaml: string;
  /** Absolute or relative path used in error messages and `source.path`. */
  filePath: string;
  /** Filename-derived id; usually `path.basename(filePath, ".yml")`. */
  id: string;
}

export function parseTaskDocument(input: ParseTaskInput): TaskDocument {
  const { yaml, filePath } = input;
  const id = validateTaskId(input.id);

  let data: Record<string, unknown>;
  try {
    const parsed = parseYaml(yaml);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new UsageError(
        `Task "${id}" YAML must be a mapping (key: value pairs). File: ${filePath}`,
        "INVALID_FLAG_VALUE",
      );
    }
    data = parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(
      `Task "${id}" has invalid YAML: ${err instanceof Error ? err.message : String(err)}. File: ${filePath}`,
      "INVALID_FLAG_VALUE",
    );
  }

  const legacy = data.version === undefined || data.version === 1;
  if (legacy) data = normalizeV1Task(data, filePath);
  requireVersion(data, id, filePath);
  rejectUnknownKeys(data, id, filePath);

  const schedule = requireString(data.schedule, "schedule", filePath);
  if (!schedule) {
    throw new UsageError(
      `Task "${id}" is missing a schedule (YAML key "schedule"). File: ${filePath}`,
      "MISSING_REQUIRED_ARGUMENT",
    );
  }

  const enabled = readEnabled(data.enabled, filePath);
  const name = optionalString(data.name, "name", filePath);
  const description = optionalString(data.description, "description", filePath);
  const when_to_use = optionalString(data.when_to_use, "when_to_use", filePath);
  const tags = readTags(data.tags, filePath);

  const hasWorkflow = "workflow" in data && data.workflow !== "" && data.workflow != null;
  const hasPrompt = "prompt" in data && data.prompt !== "" && data.prompt != null;
  const hasCommand = "command" in data && data.command !== "" && data.command != null;
  const targetCount = [hasWorkflow, hasPrompt, hasCommand].filter(Boolean).length;
  if (targetCount > 1) {
    throw new UsageError(
      `Task "${id}" sets more than one of \`workflow\`, \`prompt\`, \`command\`; pick exactly one. File: ${filePath}`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (targetCount === 0) {
    throw new UsageError(
      `Task "${id}" must set one of \`workflow\`, \`prompt\`, or \`command\`. File: ${filePath}`,
      "MISSING_REQUIRED_ARGUMENT",
    );
  }

  let target: TaskTarget;
  if (hasWorkflow) {
    rejectTargetFields(data, ["params"], id, filePath);
    const ref = requireString(data.workflow, "workflow", filePath);
    if (!ref) {
      throw new UsageError(`Task "${id}" has empty \`workflow\`. File: ${filePath}`, "INVALID_FLAG_VALUE");
    }
    target = {
      kind: "workflow",
      ref,
      params: readParams(data.params, filePath),
    };
  } else if (hasCommand) {
    rejectTargetFields(data, ["timeoutMs"], id, filePath);
    const parsedCommand = readCommand(data.command, filePath, id);
    const cmd = legacy ? normalizeV1Command(parsedCommand) : parsedCommand;
    target = { kind: "command", cmd };
  } else {
    rejectTargetFields(data, ["engine", "model", "timeoutMs", "llm"], id, filePath);
    const promptRaw = requireString(data.prompt, "prompt", filePath);
    if (!promptRaw) {
      throw new UsageError(`Task "${id}" has empty \`prompt\`. File: ${filePath}`, "INVALID_FLAG_VALUE");
    }
    const engine = optionalString(data.engine, "engine", filePath);
    const model = optionalString(data.model, "model", filePath);
    const timeoutMs = readTimeout(data.timeoutMs, filePath, legacy);
    const llm = readLlmOverrides(data.llm, filePath);
    target = {
      kind: "prompt",
      source: resolvePromptSource(promptRaw, filePath, id),
      ...(engine ? { engine } : {}),
      ...(model ? { model } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(llm ? { llm } : {}),
    };
  }

  const timeoutMs = hasCommand ? readTimeout(data.timeoutMs, filePath, legacy) : undefined;

  return {
    version: TASK_SCHEMA_VERSION,
    schemaVersion: TASK_SCHEMA_VERSION,
    id,
    schedule,
    enabled,
    target,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(when_to_use ? { when_to_use } : {}),
    ...(tags ? { tags } : {}),
    source: { path: filePath },
    timeoutMs,
  };
}

const TASK_KEYS = new Set([
  "version",
  "name",
  "description",
  "when_to_use",
  "tags",
  "schedule",
  "enabled",
  "workflow",
  "prompt",
  "command",
  "params",
  "engine",
  "model",
  "timeoutMs",
  "llm",
]);
const SHARED_KEYS = new Set(["version", "name", "description", "when_to_use", "tags", "schedule", "enabled"]);

/** Lower the complete permissive 0.8 task shape into the strict v2 reader shape. */
function normalizeV1Task(data: Record<string, unknown>, filePath: string): Record<string, unknown> {
  const normalized: Record<string, unknown> = { version: TASK_SCHEMA_VERSION };
  for (const key of ["schedule", "workflow", "prompt", "command", "name", "description", "when_to_use"] as const) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    if (key === "command" && Array.isArray(value)) {
      normalized[key] = value.filter((part): part is string => typeof part === "string" && part.trim().length > 0);
    } else if (key === "command") {
      normalized[key] = value;
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      normalized[key] = String(value).trim();
    } else {
      normalized[key] = value;
    }
  }

  normalized.enabled = data.enabled === undefined ? true : data.enabled === true;

  if (typeof data.tags === "string") {
    normalized.tags = data.tags
      .split(/[\s,]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  } else if (Array.isArray(data.tags)) {
    normalized.tags = data.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
  }

  const hasWorkflow = "workflow" in data && data.workflow !== "" && data.workflow != null;
  const hasPrompt = "prompt" in data && data.prompt !== "" && data.prompt != null;

  if (hasWorkflow && data.params && typeof data.params === "object" && !Array.isArray(data.params)) {
    normalized.params = data.params;
  } else if (hasWorkflow && typeof data.params === "string" && data.params.trim()) {
    try {
      const params = JSON.parse(data.params);
      if (params && typeof params === "object" && !Array.isArray(params)) normalized.params = params;
      else normalized.params = data.params;
    } catch {
      normalized.params = data.params;
    }
  }

  if (hasPrompt && data.profile !== undefined && data.profile !== null) {
    const profile = legacyString(data.profile);
    if (profile === undefined) {
      throw new UsageError(`Key "profile" must be a string. File: ${filePath}`, "INVALID_FLAG_VALUE");
    }
    if (profile) normalized.engine = profile;
  }

  if (!hasWorkflow && "timeoutMs" in data) {
    const timeout = data.timeoutMs;
    if (timeout === null || timeout === "null" || timeout === 0 || (typeof timeout === "number" && timeout < 0)) {
      normalized.timeoutMs = null;
    } else if (typeof timeout === "number" && timeout > 0) {
      normalized.timeoutMs = timeout;
    }
  }

  return normalized;
}

function legacyString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** Rewrite only the removed AKM spelling; arbitrary command arguments remain untouched. */
function normalizeV1Command(cmd: string[]): string[] {
  const akmIndex = findBareAkmExecutableIndex(cmd);
  if (akmIndex === undefined) return cmd;
  const improveIndex = findImproveSubcommandIndex(cmd, akmIndex);
  if (improveIndex === undefined) return cmd;
  return cmd.map((part, index) => {
    if (index <= improveIndex) return part;
    if (part === "--profile") return "--strategy";
    if (part.startsWith("--profile=")) return `--strategy=${part.slice("--profile=".length)}`;
    return part;
  });
}

const AKM_GLOBAL_BOOLEAN_OPTIONS = new Set([
  "--quiet",
  "-q",
  "--verbose",
  "--no-quiet",
  "--no-verbose",
  "--quiet=false",
  "--verbose=false",
]);
const AKM_GLOBAL_VALUE_OPTIONS = new Set(["--format", "--output", "--detail", "--shape"]);

function findImproveSubcommandIndex(cmd: readonly string[], akmIndex: number): number | undefined {
  let index = akmIndex + 1;
  while (index < cmd.length) {
    const part = cmd[index]!;
    if (part === "improve") return index;
    if (AKM_GLOBAL_BOOLEAN_OPTIONS.has(part)) {
      index += 1;
      continue;
    }
    if (AKM_GLOBAL_VALUE_OPTIONS.has(part)) {
      if (index + 1 >= cmd.length) return undefined;
      index += 2;
      continue;
    }
    if (
      [...AKM_GLOBAL_VALUE_OPTIONS].some((option) => part.startsWith(`${option}=`) && part.length > option.length + 1)
    ) {
      index += 1;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function requireVersion(data: Record<string, unknown>, id: string, filePath: string): void {
  if (data.version === TASK_SCHEMA_VERSION) return;
  const actual = data.version === undefined ? "missing" : JSON.stringify(data.version);
  throw new UsageError(
    `TASK_SCHEMA_VERSION_UNSUPPORTED: Task "${id}" uses task schema version ${actual}; version: 2 is required. File: ${filePath}`,
    "TASK_SCHEMA_VERSION_UNSUPPORTED",
    "Use task schema version: 2.",
  );
}

function rejectUnknownKeys(data: Record<string, unknown>, id: string, filePath: string): void {
  const unknown = Object.keys(data).filter((key) => !TASK_KEYS.has(key));
  if (unknown.length > 0) {
    throw new UsageError(
      `Task "${id}" has unknown key(s): ${unknown.join(", ")}. File: ${filePath}`,
      "INVALID_FLAG_VALUE",
    );
  }
}

function rejectTargetFields(
  data: Record<string, unknown>,
  allowed: readonly string[],
  id: string,
  filePath: string,
): void {
  const forbidden = Object.keys(data).filter(
    (key) => !SHARED_KEYS.has(key) && !allowed.includes(key) && !["workflow", "prompt", "command"].includes(key),
  );
  if (forbidden.length > 0) {
    throw new UsageError(
      `Task "${id}" has field(s) not valid for this target: ${forbidden.join(", ")}. File: ${filePath}`,
      "INVALID_FLAG_VALUE",
    );
  }
}

/**
 * Resolve a `prompt:` value into a {@link TaskPromptSource} variant.
 *
 *   • "[bundle//]<subdir>/<name>" (asset ref)  → asset
 *   • "./foo.md", "../foo.md", "/abs"          → file
 *   • "C:\\abs" (Windows absolute)             → file
 *   • "<type>:<name>" (retired colon grammar)  → typed UsageError
 *   • anything else (incl. block scalars)      → inline text
 */
function resolvePromptSource(raw: string, filePath: string, id: string): import("./schema").TaskPromptSource {
  const trimmed = raw.trim();

  if (!trimmed) {
    throw new UsageError(`Task "${id}" has empty \`prompt\`. File: ${filePath}`, "MISSING_REQUIRED_ARGUMENT");
  }

  if (trimmed.startsWith("./") || trimmed.startsWith("../") || path.isAbsolute(trimmed)) {
    return { kind: "file", path: trimmed };
  }

  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return { kind: "file", path: trimmed };
  }

  // Canonical 0.9.0 asset ref: `[bundle//]<stash-subdir>/<name>`. Detection is
  // delegated to the canonical parser (never a hand-rolled regex) — only a
  // conceptId whose leading segment is a real stash subdir counts as a ref; a
  // bare `word/word` inline prompt (no known subdir) stays inline text (D-R3).
  if (isFullRefInput(trimmed)) {
    return { kind: "asset", ref: trimmed };
  }

  // The pre-0.9.0 `type:name` colon grammar is retired (D-R3, ref-grammar
  // decision). Reject it with a typed error naming the canonical form rather
  // than silently degrading to inline text — mirrors `parseTaskRef`'s rejection
  // of `task:<id>`.
  const legacyColon = /^([a-z][a-z0-9_-]*):([^\s]+)/i.exec(trimmed);
  if (legacyColon) {
    const typeTok = legacyColon[1] ?? "";
    const name = legacyColon[2] ?? "";
    const subdir = stashDirFor(typeTok);
    const canonical = subdir ? `${subdir}/${name}` : `<stash-subdir>/${name}`;
    throw new UsageError(
      `Task "${id}" prompt uses the removed \`type:name\` ref grammar ("${trimmed}") — ` +
        `use the canonical asset ref \`${canonical}\`. File: ${filePath}`,
      "INVALID_FLAG_VALUE",
    );
  }

  return { kind: "inline", text: trimmed };
}

function optionalString(value: unknown, key: string, filePath: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  throw new UsageError(`Key "${key}" must be a string. File: ${filePath}`, "INVALID_FLAG_VALUE");
}

function requireString(value: unknown, key: string, filePath: string): string {
  const result = optionalString(value, key, filePath);
  if (result === undefined || result.length === 0) {
    throw new UsageError(`Key "${key}" must be a non-empty string. File: ${filePath}`, "INVALID_FLAG_VALUE");
  }
  return result;
}

function readEnabled(value: unknown, filePath: string): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean")
    throw new UsageError(`Key "enabled" must be a boolean. File: ${filePath}`, "INVALID_FLAG_VALUE");
  return value;
}

function readTags(value: unknown, filePath: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === "string" && entry.length > 0)) {
      throw new UsageError(`Key "tags" must be an array of non-empty strings. File: ${filePath}`, "INVALID_FLAG_VALUE");
    }
    return value as string[];
  }
  throw new UsageError(`Key "tags" must be an array of strings. File: ${filePath}`, "INVALID_FLAG_VALUE");
}

function readCommand(value: unknown, filePath: string, id: string): string[] {
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === "string" && entry.length > 0)) {
      throw new UsageError(
        `Task "${id}" command array must contain non-empty strings. File: ${filePath}`,
        "INVALID_FLAG_VALUE",
      );
    }
    const parts = value as string[];
    if (parts.length === 0) {
      throw new UsageError(`Task "${id}" has empty \`command\` array. File: ${filePath}`, "INVALID_FLAG_VALUE");
    }
    return parts;
  }
  if (typeof value === "string") {
    const parts = value.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      throw new UsageError(`Task "${id}" has empty \`command\`. File: ${filePath}`, "INVALID_FLAG_VALUE");
    }
    return parts;
  }
  throw new UsageError(`Key "command" must be a string or array of strings. File: ${filePath}`, "INVALID_FLAG_VALUE");
}

function readParams(value: unknown, filePath: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new UsageError(`Key "params" must be a mapping. File: ${filePath}`, "INVALID_FLAG_VALUE");
}

function readTimeout(value: unknown, filePath: string, legacy = false): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (legacy && typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new UsageError(`Key "timeoutMs" must be a positive integer or null. File: ${filePath}`, "INVALID_FLAG_VALUE");
}

function readLlmOverrides(value: unknown, filePath: string): TaskPromptTarget["llm"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`Key "llm" must be a mapping. File: ${filePath}`, "INVALID_FLAG_VALUE");
  }
  const data = value as Record<string, unknown>;
  const allowed = new Set([
    "temperature",
    "maxTokens",
    "supportsJsonSchema",
    "extraParams",
    "contextLength",
    "enableThinking",
  ]);
  const unknown = Object.keys(data).filter((key) => !allowed.has(key));
  if (unknown.length)
    throw new UsageError(
      `Key "llm" has unknown field(s): ${unknown.join(", ")}. File: ${filePath}`,
      "INVALID_FLAG_VALUE",
    );
  if (data.temperature !== undefined && (typeof data.temperature !== "number" || !Number.isFinite(data.temperature))) {
    throw new UsageError(`Key "llm.temperature" must be a finite number. File: ${filePath}`, "INVALID_FLAG_VALUE");
  }
  for (const key of ["maxTokens", "contextLength"] as const) {
    if (data[key] !== undefined && (!Number.isInteger(data[key]) || (data[key] as number) <= 0)) {
      throw new UsageError(`Key "llm.${key}" must be a positive integer. File: ${filePath}`, "INVALID_FLAG_VALUE");
    }
  }
  for (const key of ["supportsJsonSchema", "enableThinking"] as const) {
    if (data[key] !== undefined && typeof data[key] !== "boolean") {
      throw new UsageError(`Key "llm.${key}" must be a boolean. File: ${filePath}`, "INVALID_FLAG_VALUE");
    }
  }
  if (data.extraParams !== undefined) {
    const issue = validateExtraParams(data.extraParams)[0];
    if (issue) {
      throw new UsageError(
        `${formatExtraParamsIssue('Key "llm.extraParams"', issue)}. File: ${filePath}`,
        "INVALID_FLAG_VALUE",
      );
    }
  }
  return data as TaskPromptTarget["llm"];
}
