/**
 * Parse a task markdown file (frontmatter + body) into a {@link TaskDocument}.
 *
 * The on-disk shape is:
 *
 * ```markdown
 * ---
 * schedule: "0 9 * * *"
 * # one of:
 * workflow: workflow:daily-backup
 * params:
 *   region: us-east-1
 * # ...or:
 * prompt: inline                    # body is the prompt
 * profile: opencode                 # optional
 * # ...or:
 * prompt: agent:my-agent            # asset ref
 * # ...or:
 * prompt: ./prompts/my-prompt.md    # relative file path
 * enabled: true                     # default true
 * description: …
 * tags: [scheduled, backup]
 * ---
 *
 * # Task: Daily backup           (optional notes; for prompt:inline this is the prompt)
 * ```
 *
 * Validation lives in {@link validateTaskDocument}. The parser only enforces
 * shape; cron syntax, target reachability, and profile availability are
 * checked separately so callers can choose how strictly to surface errors.
 */

import path from "node:path";
import { UsageError } from "../core/errors";
import { parseFrontmatter } from "../core/frontmatter";
import { TASK_SCHEMA_VERSION, type TaskDocument, type TaskTarget } from "./schema";

export interface ParseTaskInput {
  /** The full markdown contents of the task file. */
  markdown: string;
  /** Absolute or relative path used in error messages and `source.path`. */
  filePath: string;
  /** Filename-derived id; usually `path.basename(filePath, ".md")`. */
  id: string;
}

export function parseTaskDocument(input: ParseTaskInput): TaskDocument {
  const { markdown, filePath, id } = input;
  const fm = parseFrontmatter(markdown);
  const data = fm.data;

  const schedule = readString(data.schedule, "schedule", filePath);
  if (!schedule) {
    throw new UsageError(
      `Task "${id}" is missing a schedule (frontmatter key "schedule"). File: ${filePath}`,
      "MISSING_REQUIRED_ARGUMENT",
    );
  }

  const enabled = data.enabled === undefined ? true : data.enabled === true;
  const description = readString(data.description, "description", filePath);
  const tags = readStringArray(data.tags);

  const hasWorkflow = "workflow" in data && data.workflow !== "";
  const hasPrompt = "prompt" in data && data.prompt !== "";
  if (hasWorkflow && hasPrompt) {
    throw new UsageError(
      `Task "${id}" sets both \`workflow\` and \`prompt\`; pick exactly one. File: ${filePath}`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (!hasWorkflow && !hasPrompt) {
    throw new UsageError(
      `Task "${id}" must set either \`workflow\` or \`prompt\` in frontmatter. File: ${filePath}`,
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
  } else {
    const promptRaw = readString(data.prompt, "prompt", filePath);
    if (!promptRaw) {
      throw new UsageError(`Task "${id}" has empty \`prompt\`. File: ${filePath}`, "INVALID_FLAG_VALUE");
    }
    const profile = readString(data.profile, "profile", filePath);
    target = {
      kind: "prompt",
      source: resolvePromptSource(promptRaw, fm.content, filePath, id),
      profile: profile && profile.length > 0 ? profile : undefined,
    };
  }

  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    id,
    schedule,
    enabled,
    target,
    description: description && description.length > 0 ? description : undefined,
    tags: tags && tags.length > 0 ? tags : undefined,
    source: { path: filePath },
  };
}

/**
 * Split `prompt:` frontmatter into one of {@link TaskPromptSource} variants.
 *
 *   • "inline"                          → body is the prompt
 *   • "<type>:<name>" (asset ref)       → asset
 *   • "./foo.md", "../foo.md", "/abs"   → file
 *   • anything else                     → treated as inline prompt text
 *     (the value itself is the prompt)
 */
function resolvePromptSource(
  raw: string,
  body: string,
  filePath: string,
  id: string,
): import("./schema").TaskPromptSource {
  const trimmed = raw.trim();
  if (trimmed === "inline") {
    const text = body.trim();
    if (!text) {
      throw new UsageError(
        `Task "${id}" sets \`prompt: inline\` but the markdown body is empty. File: ${filePath}`,
        "MISSING_REQUIRED_ARGUMENT",
      );
    }
    return { kind: "inline", text };
  }

  if (trimmed.startsWith("./") || trimmed.startsWith("../") || path.isAbsolute(trimmed)) {
    return { kind: "file", path: trimmed };
  }

  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return { kind: "file", path: trimmed };
  }

  if (/^[a-z][a-z0-9_-]*:[^\s]/i.test(trimmed)) {
    return { kind: "asset", ref: trimmed };
  }

  // Fallback: treat the literal value as the prompt text.
  return { kind: "inline", text: trimmed };
}

function readString(value: unknown, key: string, filePath: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new UsageError(`Frontmatter key "${key}" must be a string. File: ${filePath}`, "INVALID_FLAG_VALUE");
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
  throw new UsageError(
    `Frontmatter key "params" must be a mapping or a JSON object. File: ${filePath}`,
    "INVALID_FLAG_VALUE",
  );
}
