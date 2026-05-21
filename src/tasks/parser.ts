/**
 * Parse a task YAML file into a {@link TaskDocument}.
 *
 * The on-disk shape is a pure YAML file at `<stash>/tasks/<id>.yml`:
 *
 * ```yaml
 * schedule: "0 9 * * *"
 * # one of:
 * workflow: workflow:daily-backup
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
 * Validation lives in {@link validateTaskDocument}. The parser only enforces
 * shape; cron syntax, target reachability, and profile availability are
 * checked separately so callers can choose how strictly to surface errors.
 */

import path from "node:path";
import { parse as parseYaml } from "yaml";
import { UsageError } from "../core/errors";
import { TASK_SCHEMA_VERSION, type TaskDocument, type TaskTarget } from "./schema";

export interface ParseTaskInput {
  /** The full YAML contents of the task file. */
  yaml: string;
  /** Absolute or relative path used in error messages and `source.path`. */
  filePath: string;
  /** Filename-derived id; usually `path.basename(filePath, ".yml")`. */
  id: string;
}

export function parseTaskDocument(input: ParseTaskInput): TaskDocument {
  const { yaml, filePath, id } = input;

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

  const schedule = readString(data.schedule, "schedule", filePath);
  if (!schedule) {
    throw new UsageError(
      `Task "${id}" is missing a schedule (YAML key "schedule"). File: ${filePath}`,
      "MISSING_REQUIRED_ARGUMENT",
    );
  }

  const enabled = data.enabled === undefined ? true : data.enabled === true;
  const name = readString(data.name, "name", filePath);
  const description = readString(data.description, "description", filePath);
  const when_to_use = readString(data.when_to_use, "when_to_use", filePath);
  const tags = readStringArray(data.tags);

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
    const ref = readString(data.workflow, "workflow", filePath);
    if (!ref) {
      throw new UsageError(`Task "${id}" has empty \`workflow\`. File: ${filePath}`, "INVALID_FLAG_VALUE");
    }
    target = {
      kind: "workflow",
      ref,
      params: readParams(data.params, filePath),
    };
  } else if (hasCommand) {
    const cmd = readCommand(data.command, filePath, id);
    target = { kind: "command", cmd };
  } else {
    const promptRaw = readString(data.prompt, "prompt", filePath);
    if (!promptRaw) {
      throw new UsageError(`Task "${id}" has empty \`prompt\`. File: ${filePath}`, "INVALID_FLAG_VALUE");
    }
    const profile = readString(data.profile, "profile", filePath);
    target = {
      kind: "prompt",
      source: resolvePromptSource(promptRaw, filePath, id),
      profile: profile && profile.length > 0 ? profile : undefined,
    };
  }

  // null / 0 / negative → disabled (no timeout). Positive number → override.
  // Omitted → undefined (inherits config.agent.timeoutMs).
  let timeoutMs: number | null | undefined;
  if ("timeoutMs" in data) {
    const raw = data.timeoutMs;
    if (raw === null || raw === "null" || raw === 0 || (typeof raw === "number" && raw < 0)) {
      timeoutMs = null;
    } else if (typeof raw === "number" && raw > 0) {
      timeoutMs = raw;
    }
    // non-numeric / unrecognised → leave as undefined (inherit)
  }

  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    id,
    schedule,
    enabled,
    target,
    name: name && name.length > 0 ? name : undefined,
    description: description && description.length > 0 ? description : undefined,
    when_to_use: when_to_use && when_to_use.length > 0 ? when_to_use : undefined,
    tags: tags && tags.length > 0 ? tags : undefined,
    source: { path: filePath },
    timeoutMs,
  };
}

/**
 * Resolve a `prompt:` value into a {@link TaskPromptSource} variant.
 *
 *   • "<type>:<name>" (asset ref)              → asset
 *   • "./foo.md", "../foo.md", "/abs"          → file
 *   • "C:\\abs" (Windows absolute)             → file
 *   • anything else (incl. block scalars)      → inline text
 */
function resolvePromptSource(raw: string, filePath: string, id: string): import("./schema").TaskPromptSource {
  const trimmed = raw.trim();

  if (trimmed.startsWith("./") || trimmed.startsWith("../") || path.isAbsolute(trimmed)) {
    return { kind: "file", path: trimmed };
  }

  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return { kind: "file", path: trimmed };
  }

  if (/^[a-z][a-z0-9_-]*:[^\s]/i.test(trimmed)) {
    return { kind: "asset", ref: trimmed };
  }

  if (!trimmed) {
    throw new UsageError(`Task "${id}" has empty \`prompt\`. File: ${filePath}`, "MISSING_REQUIRED_ARGUMENT");
  }
  return { kind: "inline", text: trimmed };
}

function readString(value: unknown, key: string, filePath: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new UsageError(`Key "${key}" must be a string. File: ${filePath}`, "INVALID_FLAG_VALUE");
}

function readStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  }
  return undefined;
}

function readCommand(value: unknown, filePath: string, id: string): string[] {
  if (Array.isArray(value)) {
    const parts = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
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
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }
  throw new UsageError(`Key "params" must be a mapping or a JSON object. File: ${filePath}`, "INVALID_FLAG_VALUE");
}
