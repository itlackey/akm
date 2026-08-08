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
 * timeoutMs: 3600000               # whole-run bound; omit for the unattended
 *                                  # default, `null` to opt out entirely
 * maxSteps: 20                     # optional run bounds, same as the
 * maxRetries: 1                    # `akm workflow run` flags
 * # ...or:
 * prompt: agents/my-agent           # asset ref
 * # ...or:
 * prompt: ./prompts/my-prompt.md    # relative file path
 * # ...or:
 * prompt: |                         # inline multi-line prompt (block scalar)
 *   Do the thing.
 *   And the other thing.
 * # ...or:
 * command: akm improve --strategy quick --limit 25
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
import { isFullRefInput } from "../core/asset/resolve-ref";
import { UsageError } from "../core/errors";
import { formatExtraParamsIssue, validateExtraParams } from "../core/extra-params";
import { WORKFLOW_MAX_RETRIES } from "../workflows/resource-limits";
import {
  TASK_MAX_TIMEOUT_MS,
  TASK_SCHEMA_VERSION,
  type TaskDocument,
  type TaskPromptTarget,
  type TaskTarget,
} from "./schema";
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
    rejectTargetFields(data, ["params", "timeoutMs", "maxSteps", "maxRetries"], id, filePath);
    const ref = requireString(data.workflow, "workflow", filePath);
    if (!ref) {
      throw new UsageError(`Task "${id}" has empty \`workflow\`. File: ${filePath}`, "INVALID_FLAG_VALUE");
    }
    // The three run bounds `akm workflow run` takes as flags, declared in the
    // task file instead: an unattended run gets the same abort path the
    // interactive CLI has. `timeoutMs` left unset falls back to the runner's
    // default (see DEFAULT_WORKFLOW_TASK_TIMEOUT_MS); `null` opts out.
    const workflowTimeoutMs = readTimeout(data.timeoutMs, filePath);
    const maxSteps = readBoundedInteger(data.maxSteps, "maxSteps", 1, undefined, filePath);
    const maxRetries = readBoundedInteger(data.maxRetries, "maxRetries", 0, WORKFLOW_MAX_RETRIES, filePath);
    target = {
      kind: "workflow",
      ref,
      params: readParams(data.params, filePath),
      ...(workflowTimeoutMs !== undefined ? { timeoutMs: workflowTimeoutMs } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
    };
  } else if (hasCommand) {
    rejectTargetFields(data, ["timeoutMs"], id, filePath);
    target = { kind: "command", cmd: readCommand(data.command, filePath, id) };
  } else {
    rejectTargetFields(data, ["engine", "model", "timeoutMs", "llm"], id, filePath);
    const promptRaw = requireString(data.prompt, "prompt", filePath);
    if (!promptRaw) {
      throw new UsageError(`Task "${id}" has empty \`prompt\`. File: ${filePath}`, "INVALID_FLAG_VALUE");
    }
    const engine = optionalString(data.engine, "engine", filePath);
    const model = optionalString(data.model, "model", filePath);
    const timeoutMs = readTimeout(data.timeoutMs, filePath);
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

  const timeoutMs = hasCommand ? readTimeout(data.timeoutMs, filePath) : undefined;

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
  "maxSteps",
  "maxRetries",
  "llm",
]);
const SHARED_KEYS = new Set(["version", "name", "description", "when_to_use", "tags", "schedule", "enabled"]);

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
 *   • anything else (including colon text and block scalars) → inline text
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

function readTimeout(value: unknown, filePath: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  // The ceiling is `setTimeout`'s, not a policy: a larger delay overflows and
  // fires immediately, turning a generous timeout into an instant abort.
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= TASK_MAX_TIMEOUT_MS) return value;
  throw new UsageError(
    `Key "timeoutMs" must be an integer from 1 through ${TASK_MAX_TIMEOUT_MS}, or null. File: ${filePath}`,
    "INVALID_FLAG_VALUE",
  );
}

function readBoundedInteger(
  value: unknown,
  key: string,
  minimum: number,
  maximum: number | undefined,
  filePath: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    (maximum === undefined || value <= maximum)
  ) {
    return value;
  }
  const range = maximum === undefined ? `at least ${minimum}` : `from ${minimum} through ${maximum}`;
  throw new UsageError(`Key "${key}" must be an integer ${range}. File: ${filePath}`, "INVALID_FLAG_VALUE");
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
