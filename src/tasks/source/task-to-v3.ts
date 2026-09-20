// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Pure, byte-producing legacy-task to task-v3 migration planner. */

import crypto from "node:crypto";
import path from "node:path";
import { LineCounter, parseDocument, stringify as stringifyYaml } from "yaml";
import { bundleRefToString, parseBundleRef } from "../../core/asset/asset-ref";
import { formatExtraParamsIssue, validateExtraParams } from "../../core/extra-params";
import { WORKFLOW_ENV_VAR_NAME_PATTERN, WORKFLOW_MAX_TIMEOUT_MS } from "../../workflows/resource-limits";
import { validateTaskId } from "../task-id";
import { assertBoundedTaskYamlDocument, TASK_V3_MAX_REDACT_NAMES } from "./bounded-document";
import { classifyTaskV3Uses, parseTaskV3Yaml, type TaskV3UsesTarget } from "./task-source-v3-frozen";

export interface TaskToV3FileInput {
  readonly filePath: string;
  readonly bytes: Buffer;
  readonly mode: number;
  readonly writable: boolean;
  /** False when the inspected file or its publication directory has no write bit. */
  readonly onDiskWritable?: boolean;
  /** Physical bundle/component root recorded by the filesystem inspector. */
  readonly containmentRoot?: string;
}

interface TaskToV3OutcomeBase {
  readonly filePath: string;
  readonly before: Buffer;
  readonly beforeHash: string;
  readonly mode: number;
  readonly writable: boolean;
  readonly onDiskWritable?: boolean;
  readonly containmentRoot?: string;
  readonly reason: string;
  readonly detail?: string;
}

export interface TaskToV3Changed extends TaskToV3OutcomeBase {
  readonly status: "changed";
  readonly reason: "task-converted";
  readonly after: Buffer;
  readonly afterHash: string;
}

export interface TaskToV3Skipped extends TaskToV3OutcomeBase {
  readonly status: "skipped";
  /**
   * `already-v4` (spec docs/plans/specs/p4-deletions-closeout.md §3.2.5):
   * generation 1 (v2 -> v3) has nothing to do to a file that has already
   * moved past v3 into task source v4 — that is generation 2's domain, not
   * a "this file is malformed" signal. Reported as skipped, not blocked, so
   * a combined `akm migrate status`/`apply` run does not misreport a
   * perfectly healthy v4-only tree as needing manual review.
   */
  readonly reason: "already-v3" | "already-v4";
}

export interface TaskToV3Blocked extends TaskToV3OutcomeBase {
  readonly status: "blocked";
}

export type TaskToV3FileOutcome = TaskToV3Changed | TaskToV3Skipped | TaskToV3Blocked;

export interface TaskToV3MigrationPlan {
  readonly schemaVersion: 1;
  readonly generation: string;
  readonly files: readonly TaskToV3FileOutcome[];
}

const V2_KEYS = new Set([
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
  "redact",
]);
const V2_SHARED_KEYS = new Set([
  "version",
  "name",
  "description",
  "when_to_use",
  "tags",
  "schedule",
  "enabled",
  "redact",
]);
const V2_LLM_KEYS = new Set([
  "temperature",
  "maxTokens",
  "supportsJsonSchema",
  "extraParams",
  "contextLength",
  "enableThinking",
  "reasoningEffort",
]);
const SAFE_V2_COMMAND_TOKEN = /^[A-Za-z0-9_./:=+,-]+$/;
const SHELL_ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * V2 executed argv directly, while v3 `run:` enters a host shell. An explicit
 * path bypasses shell aliases/builtins; `akm` is the one bare executable whose
 * v3 runtime resolution is contractually pinned to the current installation.
 */
function shellStableV2Executable(executable: string): boolean {
  return executable === "akm" || executable.includes("/");
}
/**
 * `env NAME=value... cmd args...` is env(1) itself resolving and exec'ing
 * `cmd` via its own PATH search — that lookup happens inside env's execvp()
 * regardless of whether env was launched by direct execve (v2) or by a host
 * shell (v3 `run:`). The shell-vs-argv divergence `shellStableV2Executable`
 * guards against (bare names shadowed by shell aliases/builtins/functions)
 * therefore does not apply to whatever env ultimately invokes, so skip past
 * a leading `env` and its `NAME=value` assignments to find the real target.
 * Returns the original tokens, unchanged, when there is no such target
 * (e.g. `env` with nothing after its assignments).
 */
function skipEnvAssignmentPrefix(tokens: readonly string[]): { tokens: readonly string[]; envWrapped: boolean } {
  if (tokens[0] !== "env") return { tokens, envWrapped: false };
  let index = 1;
  while (index < tokens.length && SHELL_ASSIGNMENT_WORD.test(tokens[index] as string)) index += 1;
  if (index >= tokens.length) return { tokens, envWrapped: false };
  return { tokens: tokens.slice(index), envWrapped: true };
}
const KNOWN_PROMPT_REF_FAMILIES = new Set([
  "agents",
  "commands",
  "env",
  "facts",
  "instructions",
  "knowledge",
  "lessons",
  "memories",
  "scripts",
  "secrets",
  "sessions",
  "skills",
  "tasks",
  "workflows",
]);

function hash(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function base(input: TaskToV3FileInput): Omit<TaskToV3OutcomeBase, "reason"> {
  return {
    filePath: input.filePath,
    before: Buffer.from(input.bytes),
    beforeHash: hash(input.bytes),
    mode: input.mode,
    writable: input.writable,
    ...(input.onDiskWritable !== undefined ? { onDiskWritable: input.onDiskWritable } : {}),
    ...(input.containmentRoot ? { containmentRoot: input.containmentRoot } : {}),
  };
}

/**
 * #902: the one blocker with an unambiguous remedy. The sibling shell-safety
 * reasons need a case-by-case judgement and stay reason-only.
 */
const ARGV_ARRAY_BLOCK_DETAIL =
  "Manual conversion required: an array `command:` has no safe v3 `run:` string. Rewrite it by hand as " +
  "`run:` (string) plus `shell:` — see docs/migration/v0.9.1-to-v0.9.2.md for the full v2 to v4 field mapping.";

function blocked(input: TaskToV3FileInput, reason: string, detail?: string): TaskToV3Blocked {
  return Object.freeze({ status: "blocked" as const, ...base(input), reason, ...(detail ? { detail } : {}) });
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be a mapping`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${label} must use a plain or null prototype`);
  return value as Record<string, unknown>;
}

function exactString(value: unknown, label: string, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && value.trim().length === 0)) {
    throw new Error(`${label} must be ${nonempty ? "a non-empty " : "a "}string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return exactString(value, label);
}

function parseLegacyTaskYaml(input: TaskToV3FileInput): { data: Record<string, unknown>; source: string } {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input.bytes);
  } catch {
    throw new Error("task YAML contains invalid UTF-8 bytes");
  }
  const lineCounter = new LineCounter();
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(source, { lineCounter, uniqueKeys: true });
  } catch (cause) {
    throw new Error(`invalid YAML: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const [parseError] = document.errors;
  if (parseError) throw new Error(`invalid YAML: ${parseError.message.split("\n")[0]}`);
  const [parseWarning] = document.warnings;
  if (parseWarning) throw new Error(`unsupported YAML construct: ${parseWarning.message}`);
  assertBoundedTaskYamlDocument(document, {
    filePath: input.filePath,
    sourceLabel: "task v2 migration source",
    lineCounter,
  });
  return { data: plainRecord(document.toJS({ maxAliasCount: 0 }), "task YAML"), source };
}

function validateCommonV2(data: Record<string, unknown>): void {
  const unknown = Object.keys(data).filter((key) => !V2_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`unknown v2 field(s): ${unknown.join(", ")}`);
  exactString(data.schedule, "schedule", true);
  if (data.enabled !== undefined && typeof data.enabled !== "boolean") throw new Error("enabled must be a boolean");
  for (const key of ["name", "description", "when_to_use"] as const) optionalString(data[key], key);
  if (data.tags !== undefined && data.tags !== null) {
    if (!Array.isArray(data.tags) || data.tags.some((entry) => typeof entry !== "string" || entry.length === 0)) {
      throw new Error("tags must be an array of non-empty strings");
    }
  }
  if (data.timeoutMs !== undefined && data.timeoutMs !== null) {
    if (
      !Number.isInteger(data.timeoutMs) ||
      (data.timeoutMs as number) < 1 ||
      (data.timeoutMs as number) > WORKFLOW_MAX_TIMEOUT_MS
    ) {
      throw new Error(`timeoutMs must be null or an integer from 1 through ${WORKFLOW_MAX_TIMEOUT_MS}`);
    }
  }
  if (data.redact !== undefined && data.redact !== null) {
    if (
      !Array.isArray(data.redact) ||
      data.redact.length > TASK_V3_MAX_REDACT_NAMES ||
      data.redact.some((entry) => typeof entry !== "string" || !WORKFLOW_ENV_VAR_NAME_PATTERN.test(entry))
    ) {
      throw new Error("redact must contain only bounded environment variable names");
    }
  }
}

function validateTargetFields(data: Record<string, unknown>, allowed: readonly string[]): void {
  const targetFields = new Set([...allowed, "workflow", "prompt", "command"]);
  const invalid = Object.keys(data).filter((key) => !V2_SHARED_KEYS.has(key) && !targetFields.has(key));
  if (invalid.length > 0) throw new Error(`field(s) not valid for this target: ${invalid.join(", ")}`);
}

function validateV2Llm(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const llm = plainRecord(value, "llm");
  const unknown = Object.keys(llm).filter((key) => !V2_LLM_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`llm has unknown field(s): ${unknown.join(", ")}`);
  if (llm.temperature !== undefined && (typeof llm.temperature !== "number" || !Number.isFinite(llm.temperature))) {
    throw new Error("llm.temperature must be a finite number");
  }
  for (const key of ["maxTokens", "contextLength"] as const) {
    if (llm[key] !== undefined && (!Number.isInteger(llm[key]) || (llm[key] as number) <= 0)) {
      throw new Error(`llm.${key} must be a positive integer`);
    }
  }
  for (const key of ["supportsJsonSchema", "enableThinking"] as const) {
    if (llm[key] !== undefined && typeof llm[key] !== "boolean") throw new Error(`llm.${key} must be a boolean`);
  }
  if (llm.reasoningEffort !== undefined && (typeof llm.reasoningEffort !== "string" || !llm.reasoningEffort.trim())) {
    throw new Error("llm.reasoningEffort must be a non-empty string");
  }
  if (llm.extraParams !== undefined) {
    const issue = validateExtraParams(llm.extraParams)[0];
    if (issue) throw new Error(formatExtraParamsIssue("llm.extraParams", issue));
  }
  return llm;
}

function commonAkm(data: Record<string, unknown>): Record<string, unknown> {
  const akm: Record<string, unknown> = {
    schedule: exactString(data.schedule, "schedule", true),
    enabled: data.enabled === undefined ? true : data.enabled,
  };
  for (const key of ["description", "when_to_use", "tags"] as const) {
    if (data[key] !== undefined && data[key] !== null) akm[key] = data[key];
  }
  return akm;
}

function addRuntimeOverrides(data: Record<string, unknown>, akm: Record<string, unknown>): void {
  for (const key of ["engine", "model"] as const) {
    const value = optionalString(data[key], key);
    if (value) akm[key] = value;
  }
  const llm = validateV2Llm(data.llm);
  if (llm !== undefined) akm.inference = llm;
  if (data.timeoutMs !== undefined) akm.timeout = data.timeoutMs;
  if (data.redact !== undefined && data.redact !== null) {
    akm.redact = [...new Set(data.redact as string[])];
  }
}

function addSharedNonPromptOverrides(data: Record<string, unknown>, akm: Record<string, unknown>): void {
  if (data.timeoutMs !== undefined) akm.timeout = data.timeoutMs;
  if (data.redact !== undefined && data.redact !== null) {
    akm.redact = [...new Set(data.redact as string[])];
  }
}

function promptSourceKind(raw: string): "file" | "agent" | "command" | "other-ref" | "inline" {
  const trimmed = raw.trim();
  if (
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    path.isAbsolute(trimmed) ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    return "file";
  }
  try {
    const parsed = parseBundleRef(trimmed);
    const family = parsed.conceptId.split("/", 1)[0] ?? "";
    if (bundleRefToString(parsed) !== trimmed || !parsed.conceptId.includes("/")) {
      return "inline";
    }
    if (!KNOWN_PROMPT_REF_FAMILIES.has(family)) return parsed.bundle === undefined ? "inline" : "other-ref";
    if (family === "agents") return "agent";
    if (family === "commands") return "command";
    return "other-ref";
  } catch {
    return "inline";
  }
}

function migratedObject(data: Record<string, unknown>): Record<string, unknown> | TaskToV3Blocked["reason"] {
  validateCommonV2(data);
  const targets = ["workflow", "prompt", "command"].filter(
    (key) => Object.hasOwn(data, key) && data[key] !== null && data[key] !== "",
  );
  if (targets.length !== 1) throw new Error("v2 task must declare exactly one of workflow, prompt, or command");
  const output: Record<string, unknown> = { version: 3 };
  if (data.name !== undefined && data.name !== null) output.name = data.name;
  const akm = commonAkm(data);

  if (targets[0] === "workflow") {
    validateTargetFields(data, ["params", "timeoutMs", "maxSteps", "maxRetries"]);
    const ref = exactString(data.workflow, "workflow", true).trim();
    let target: TaskV3UsesTarget;
    try {
      target = classifyTaskV3Uses(ref);
    } catch {
      throw new Error("workflow is not a canonical v3 asset ref");
    }
    if (target.kind !== "workflow") throw new Error("workflow target is not a workflows/ ref");
    output.uses = ref;
    if (data.params !== undefined && data.params !== null) {
      const params = plainRecord(data.params, "params");
      output.with = params;
    }
    if (data.maxSteps !== undefined && data.maxSteps !== null) {
      if (!Number.isSafeInteger(data.maxSteps) || (data.maxSteps as number) < 1)
        throw new Error("maxSteps must be positive");
      akm.maxSteps = data.maxSteps;
    }
    if (data.maxRetries !== undefined && data.maxRetries !== null) {
      if (!Number.isSafeInteger(data.maxRetries) || (data.maxRetries as number) < 0) {
        throw new Error("maxRetries must be a non-negative integer");
      }
      akm.maxRetries = data.maxRetries;
    }
    addSharedNonPromptOverrides(data, akm);
  } else if (targets[0] === "prompt") {
    validateTargetFields(data, ["engine", "model", "timeoutMs", "llm"]);
    const prompt = exactString(data.prompt, "prompt", true).trim();
    const kind = promptSourceKind(prompt);
    if (kind === "file") return "dynamic-file-read-cannot-be-inlined-without-changing-semantics";
    if (kind === "agent") return "agent-ref-has-persona-but-no-command-work";
    if (kind === "other-ref") return "non-command-asset-has-no-v3-command-ref-equivalent";
    if (kind === "command") output.uses = prompt;
    else {
      output.uses = "akm/command";
      output.with = { content: prompt };
    }
    addRuntimeOverrides(data, akm);
  } else {
    validateTargetFields(data, ["timeoutMs"]);
    if (Array.isArray(data.command)) return "argv-array-has-no-portable-shell-string";
    const command = exactString(data.command, "command", true).trim();
    if (/['"\\]/.test(command)) return "shell-quoting-changes-v2-whitespace-split-semantics";
    const tokens = command.split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || tokens.some((token) => !SAFE_V2_COMMAND_TOKEN.test(token))) {
      return "shell-operators-change-v2-literal-argv-semantics";
    }
    const { tokens: targetTokens, envWrapped } = skipEnvAssignmentPrefix(tokens);
    const executable = targetTokens[0] as string;
    if (SHELL_ASSIGNMENT_WORD.test(executable) || (!envWrapped && !shellStableV2Executable(executable))) {
      return "shell-command-resolution-changes-v2-literal-argv-semantics";
    }
    output.run = tokens.join(" ");
    addSharedNonPromptOverrides(data, akm);
  }
  output.akm = akm;
  return output;
}

function isReason(value: Record<string, unknown> | string): value is string {
  return typeof value === "string";
}

/** Convert one already-normalized legacy record directly to final task v3. */
export function planLegacyTaskDataToV3(input: TaskToV3FileInput, data: Record<string, unknown>): TaskToV3FileOutcome {
  if (data.version !== 2) {
    return blocked(
      input,
      "unsupported-task-version",
      `expected normalized legacy version 2, got ${String(data.version)}`,
    );
  }
  if (!input.writable || input.onDiskWritable === false) {
    return blocked(
      input,
      "read-only-source",
      !input.writable ? "the owning source is not writable" : "the source file or publication directory is read-only",
    );
  }
  try {
    validateTaskId(path.basename(input.filePath, ".yml"));
  } catch (cause) {
    return blocked(input, "invalid-v2-task", cause instanceof Error ? cause.message : String(cause));
  }
  let migrated: Record<string, unknown> | string;
  try {
    migrated = migratedObject(data);
  } catch (cause) {
    return blocked(input, "invalid-v2-task", cause instanceof Error ? cause.message : String(cause));
  }
  if (isReason(migrated)) {
    const detail = migrated === "argv-array-has-no-portable-shell-string" ? ARGV_ARRAY_BLOCK_DETAIL : undefined;
    return blocked(input, migrated, detail);
  }
  const after = Buffer.from(stringifyYaml(migrated), "utf8");
  try {
    parseTaskV3Yaml({
      yaml: after.toString("utf8"),
      filePath: input.filePath,
      ...(input.containmentRoot ? { workspaceRoot: input.containmentRoot } : {}),
    });
  } catch (cause) {
    return blocked(input, "generated-v3-validation-failed", cause instanceof Error ? cause.message : String(cause));
  }
  return Object.freeze({
    status: "changed" as const,
    ...base(input),
    reason: "task-converted" as const,
    after,
    afterHash: hash(after),
  });
}

/** Plan exactly one source file without touching disk. */
export function planTaskToV3File(input: TaskToV3FileInput): TaskToV3FileOutcome {
  let data: Record<string, unknown>;
  let source: string;
  try {
    ({ data, source } = parseLegacyTaskYaml(input));
  } catch (cause) {
    return blocked(input, "invalid-task-yaml", cause instanceof Error ? cause.message : String(cause));
  }
  if (data.version === 3) {
    try {
      parseTaskV3Yaml({
        yaml: source,
        filePath: input.filePath,
        ...(input.containmentRoot ? { workspaceRoot: input.containmentRoot } : {}),
      });
      return Object.freeze({ status: "skipped" as const, ...base(input), reason: "already-v3" as const });
    } catch (cause) {
      return blocked(input, "invalid-v3-task", cause instanceof Error ? cause.message : String(cause));
    }
  }
  if (data.version === 4) {
    // Generation 1 owns v2 only. Do not validate v4 here: generation 2 must
    // be allowed to recognize and remove the retired schedule[].enabled field
    // before the current runtime parser sees those bytes.
    return Object.freeze({ status: "skipped" as const, ...base(input), reason: "already-v4" as const });
  }
  if (data.version !== 2) {
    return blocked(input, "unsupported-task-version", `expected version 2, 3, or 4, got ${String(data.version)}`);
  }
  return planLegacyTaskDataToV3(input, data);
}

function generationFor(files: readonly TaskToV3FileOutcome[]): string {
  const digest = crypto.createHash("sha256");
  digest.update("akm-task-to-v3-plan-v1\0");
  for (const file of files) {
    digest.update(file.filePath);
    digest.update("\0");
    digest.update(file.status);
    digest.update("\0");
    digest.update(file.reason);
    digest.update("\0");
    digest.update(String(file.mode));
    digest.update("\0");
    digest.update(file.writable ? "writable" : "read-only");
    digest.update("\0");
    digest.update(file.onDiskWritable === false ? "disk-read-only" : "disk-writable-or-unspecified");
    digest.update("\0");
    if (file.containmentRoot) digest.update(file.containmentRoot);
    digest.update("\0");
    digest.update(file.beforeHash);
    digest.update("\0");
    if (file.status === "changed") digest.update(file.afterHash);
    digest.update("\0");
    if (file.detail) digest.update(file.detail);
    digest.update("\0");
  }
  return digest.digest("hex");
}

/** Build/fingerprint a plan from already-derived immutable outcomes. */
export function taskToV3PlanFromOutcomes(outcomes: readonly TaskToV3FileOutcome[]): TaskToV3MigrationPlan {
  const files = [...outcomes].sort((left, right) =>
    left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0,
  );
  for (let index = 1; index < files.length; index += 1) {
    const previous = files[index - 1];
    const current = files[index];
    if (previous && current && path.resolve(previous.filePath) === path.resolve(current.filePath)) {
      throw new Error(`duplicate task migration file path: ${current.filePath}`);
    }
  }
  return Object.freeze({ schemaVersion: 1 as const, generation: generationFor(files), files: Object.freeze(files) });
}

/** Plan a complete, stable file set. Input order cannot change the result. */
export function planTaskToV3Migration(inputs: readonly TaskToV3FileInput[]): TaskToV3MigrationPlan {
  const sorted = [...inputs].sort((left, right) =>
    left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0,
  );
  let previous: TaskToV3FileInput | undefined;
  for (const current of sorted) {
    if (previous && path.resolve(previous.filePath) === path.resolve(current.filePath)) {
      throw new Error(`duplicate task migration file path: ${current.filePath}`);
    }
    previous = current;
  }
  return taskToV3PlanFromOutcomes(sorted.map(planTaskToV3File));
}
