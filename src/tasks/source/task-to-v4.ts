// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure, byte-producing task-source migration planner: a v2, v3, or v4 task
 * file straight to task source v4 (spec docs/plans/specs/p2b-input-bindings.md
 * §1.3, §1.7 C-N1, §5). One planner, one outcome per file — the former
 * two-generation chain (legacy task to v3, then v3 to v4, composed by
 * `scripts/akm-migrate/migrate/task-files.ts`) is gone: a v2 file is read
 * once and converted directly, with no intermediate v3 file ever written to
 * disk or reported as its own outcome.
 *
 * A v3 document — real, or the v3-shape record a v2 file converts to in
 * memory — is read as a raw record by a vendored bounded-YAML reader, never
 * the typed `parseTaskV3Yaml`, which would normalize away exactly the value
 * bytes this migrator must preserve (a duration string like "5m", or a bare
 * numeric `timeout`, would be converted to milliseconds by the real parser).
 * The one exception is a pre-validation gate: every v3-versioned document —
 * real, or freshly built from v2 — is first checked against the REAL typed
 * `parseTaskV3Yaml`, exactly as the prior two-generation chain did at each of
 * its hops, so every blocked reason only the typed parser catches (an
 * escaping `working-directory` symlink, a GitHub-expression schedule, an
 * invalid builtin-command `with:` shape, and so on) still blocks here, with
 * the same reason. The OUTPUT side is validated through the REAL
 * `parseTaskSourceV4` before a "changed" outcome is ever handed back (C-N1,
 * B-71).
 *
 * `inputs:` is never invented — the migrator translates structure, not
 * intent (spec §5.3).
 */

import crypto from "node:crypto";
import path from "node:path";
import { isMap, isSeq, LineCounter, parseDocument, stringify as stringifyYaml } from "yaml";
import { bundleRefToString, parseBundleRef } from "../../core/asset/asset-ref";
import { formatExtraParamsIssue, validateExtraParams } from "../../core/extra-params";
import { WORKFLOW_ENV_VAR_NAME_PATTERN, WORKFLOW_MAX_TIMEOUT_MS } from "../../workflows/resource-limits";
import { validateTaskId } from "../task-id";
import { assertBoundedTaskYamlDocument, TASK_V3_MAX_REDACT_NAMES } from "./bounded-document";
import { classifyTaskV3Uses, parseTaskV3Yaml, type TaskV3UsesTarget } from "./task-source-v3-frozen";
import { parseTaskSourceV4 } from "./task-source-v4";

export interface TaskToV4FileInput {
  readonly filePath: string;
  readonly bytes: Buffer;
  readonly mode: number;
  readonly writable: boolean;
  /** False when the inspected file or its publication directory has no write bit. */
  readonly onDiskWritable?: boolean;
  /** Physical bundle/component root recorded by the filesystem inspector. */
  readonly containmentRoot?: string;
}

interface TaskToV4OutcomeBase {
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

export interface TaskToV4Changed extends TaskToV4OutcomeBase {
  readonly status: "changed";
  readonly reason: "task-converted" | "source-enablement-removed";
  readonly after: Buffer;
  readonly afterHash: string;
  /** Set only when a v3 trigger was dropped without a v4 equivalent (manual-only, B-62). */
  readonly notice?: string;
}

export interface TaskToV4Skipped extends TaskToV4OutcomeBase {
  readonly status: "skipped";
  readonly reason: "already-v4";
}

export interface TaskToV4Blocked extends TaskToV4OutcomeBase {
  readonly status: "blocked";
}

export type TaskToV4FileOutcome = TaskToV4Changed | TaskToV4Skipped | TaskToV4Blocked;

export interface TaskToV4MigrationPlan {
  readonly schemaVersion: 1;
  readonly generation: string;
  readonly files: readonly TaskToV4FileOutcome[];
}

// ── v3 grammar (real v3 input, and the v3-shape record a v2 file builds) ────

/** The closed v3 top-level key set (`src/tasks/source-v3.ts`'s own, vendored — not exported there). */
const V3_TOP_LEVEL_KEYS = new Set([
  "version",
  "name",
  "uses",
  "run",
  "with",
  "env",
  "shell",
  "working-directory",
  "akm",
  "on",
]);
/** The closed v3 `akm.*` key set, vendored from `src/tasks/source-v3.ts`. */
const V3_AKM_KEYS = new Set([
  "schedule",
  "enabled",
  "description",
  "when_to_use",
  "tags",
  "agent",
  "engine",
  "model",
  "inference",
  "outputSchema",
  "tools",
  "timeout",
  "redact",
  "maxSteps",
  "maxRetries",
]);
/** The closed v3 `on.*` key set, vendored from `src/tasks/source-v3.ts`. */
const V3_ON_KEYS = new Set(["schedule", "workflow_dispatch"]);
/** `akm.*` keys hoisted verbatim to the identical top-level v4 key (schedule/enabled handled separately). */
const AKM_HOIST_KEYS = [
  "description",
  "when_to_use",
  "tags",
  "agent",
  "engine",
  "model",
  "inference",
  "tools",
  "timeout",
  "redact",
  "maxSteps",
  "maxRetries",
] as const;

// ── v2 grammar ────────────────────────────────────────────────────────────────

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
/**
 * #902: the one blocker with an unambiguous remedy. The sibling shell-safety
 * reasons need a case-by-case judgement and stay reason-only.
 */
const ARGV_ARRAY_BLOCK_DETAIL =
  "Manual conversion required: an array `command:` has no safe v3 `run:` string. Rewrite it by hand as " +
  "`run:` (string) plus `shell:` — see docs/migration/v0.9.1-to-v0.9.2.md for the full v2 to v4 field mapping.";

// ── shared helpers ────────────────────────────────────────────────────────────

function hash(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function base(input: TaskToV4FileInput): Omit<TaskToV4OutcomeBase, "reason"> {
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

function blocked(input: TaskToV4FileInput, reason: string, detail?: string): TaskToV4Blocked {
  return Object.freeze({ status: "blocked" as const, ...base(input), reason, ...(detail ? { detail } : {}) });
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must use a plain or null prototype`);
  }
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

/**
 * Bounded-YAML raw-record reader shared by every version and every
 * generation (v2 grammar, real v3, and the v3-shape record a v2 file
 * builds): reading the RAW decoded record — rather than a typed parser —
 * keeps every field's original value bytes (a duration string, a bare
 * millisecond integer, an env value's exact type) intact for verbatim
 * re-emission; a typed parse would normalize several of these away (C-N1).
 * Which grammar applies to the result is entirely up to the caller, decided
 * after `data.version` is known.
 */
function parseRawTaskYaml(input: TaskToV4FileInput): { data: Record<string, unknown>; source: string } {
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
    throw new Error(`invalid YAML: ${causeMessage(cause)}`);
  }
  const [parseError] = document.errors;
  if (parseError) throw new Error(`invalid YAML: ${parseError.message.split("\n")[0]}`);
  const [parseWarning] = document.warnings;
  if (parseWarning) throw new Error(`unsupported YAML construct: ${parseWarning.message}`);
  assertBoundedTaskYamlDocument(document, {
    filePath: input.filePath,
    sourceLabel: "task migration source",
    lineCounter,
  });
  return { data: plainRecord(document.toJS({ maxAliasCount: 0 }), "task YAML"), source };
}

type ScheduleEntry = Readonly<{ cron: string }>;

/** Convert one already-validated v3 raw record (real or v2-derived) to final task source v4 bytes. */
function planV3DataToV4(input: TaskToV4FileInput, data: Record<string, unknown>): TaskToV4FileOutcome {
  const unknownTop = Object.keys(data).filter((key) => !V3_TOP_LEVEL_KEYS.has(key));
  if (unknownTop.length > 0) {
    return blocked(input, "invalid-v3-task", `unknown v3 field(s): ${unknownTop.join(", ")}`);
  }

  const hasUses = Object.hasOwn(data, "uses");
  const hasRun = Object.hasOwn(data, "run");
  if (hasUses === hasRun) {
    return blocked(input, "invalid-v3-task", "requires exactly one executable selector: uses or run");
  }

  let akm: Record<string, unknown> | undefined;
  if (Object.hasOwn(data, "akm")) {
    try {
      akm = plainRecord(data.akm, "akm");
    } catch (cause) {
      return blocked(input, "invalid-v3-task", causeMessage(cause));
    }
    const unknownAkm = Object.keys(akm).filter((key) => !V3_AKM_KEYS.has(key));
    if (unknownAkm.length > 0) {
      return blocked(input, "unrecognized-akm-member", `akm has unknown field(s): ${unknownAkm.join(", ")}`);
    }
    if (Object.hasOwn(akm, "enabled") && typeof akm.enabled !== "boolean") {
      return blocked(input, "invalid-v3-task", "akm.enabled must be a boolean");
    }
    if (Object.hasOwn(akm, "schedule") && typeof akm.schedule !== "string") {
      return blocked(input, "invalid-v3-task", "akm.schedule must be a string");
    }
  }

  const hasOn = Object.hasOwn(data, "on");
  let onRecord: Record<string, unknown> | undefined;
  if (hasOn) {
    try {
      onRecord = plainRecord(data.on, "on");
    } catch (cause) {
      return blocked(input, "invalid-v3-task", causeMessage(cause));
    }
    // Mirrors the frozen v3 reader's own `parseOn` gates exactly
    // (task-source-v3-frozen.ts:395-427): an empty `on: {}` declares no
    // trigger at all, and `on.workflow_dispatch` accepts only null or an
    // empty mapping (inputs are unsupported in v3). The frozen parser
    // rejects both shapes outright, so this migrator must too — translating
    // a document the v3 oracle would refuse to parse into runnable v4 bytes
    // would launder invalid input into a valid, schedule-less task.
    if (Object.keys(onRecord).length === 0) {
      return blocked(input, "invalid-v3-task", "on must declare schedule and/or workflow_dispatch.");
    }
    const unknownOn = Object.keys(onRecord).filter((key) => !V3_ON_KEYS.has(key));
    if (unknownOn.length > 0) {
      return blocked(input, "invalid-v3-task", `on has unknown field(s): ${unknownOn.join(", ")}`);
    }
    if (Object.hasOwn(onRecord, "workflow_dispatch") && onRecord.workflow_dispatch !== null) {
      let dispatchMapping: Record<string, unknown>;
      try {
        dispatchMapping = plainRecord(onRecord.workflow_dispatch, "on.workflow_dispatch");
      } catch (cause) {
        return blocked(input, "invalid-v3-task", causeMessage(cause));
      }
      if (Object.keys(dispatchMapping).length > 0) {
        return blocked(
          input,
          "invalid-v3-task",
          "on.workflow_dispatch must be null or an empty mapping; inputs are unsupported.",
        );
      }
    }
  }

  const hasAkmSchedule = akm !== undefined && Object.hasOwn(akm, "schedule");
  if (hasAkmSchedule && hasOn) {
    return blocked(
      input,
      "ambiguous-scheduling-source",
      "declares both akm.schedule and on:; task v3 requires exactly one scheduling source and the migrator will not guess which one wins.",
    );
  }
  if (!hasAkmSchedule && !hasOn) {
    return blocked(input, "invalid-v3-task", "requires exactly one scheduling source: akm.schedule or on.");
  }

  const hasWith = Object.hasOwn(data, "with");
  let usesTarget: TaskV3UsesTarget | undefined;
  if (hasUses) {
    let usesValue: string;
    try {
      usesValue = exactString(data.uses, "uses", true);
    } catch (cause) {
      return blocked(input, "invalid-v3-task", causeMessage(cause));
    }
    try {
      usesTarget = classifyTaskV3Uses(usesValue);
    } catch (cause) {
      return blocked(input, "invalid-v3-task", causeMessage(cause));
    }
    if (usesTarget.kind === "github-action") {
      return blocked(
        input,
        "github-action-target-removed",
        `"${usesValue}" is a github-action target; the github-action uses: variant was removed in task source v4. Use commands/, scripts/, workflows/, or akm/command instead.`,
      );
    }
    if (hasWith && usesTarget.kind !== "builtin-command") {
      return blocked(
        input,
        "with-on-non-command-target",
        `a with: block on "${usesValue}" (a non-akm/command target) has no task source v4 equivalent; task-call inputs are declared and bound separately.`,
      );
    }
  } else if (hasWith) {
    return blocked(input, "invalid-v3-task", "with is legal only with uses");
  }

  if (!input.writable || input.onDiskWritable === false) {
    return blocked(
      input,
      "read-only-source",
      !input.writable ? "the owning source is not writable" : "the source file or publication directory is read-only",
    );
  }

  let scheduleField: string | ScheduleEntry[] | undefined;
  // Several independent translation facts can need reporting on the SAME
  // file (a manual-only trigger AND a dropped output schema, say), so
  // notices accumulate and are joined into the single `notice` string the
  // outcome carries.
  const notices: string[] = [];

  if (hasAkmSchedule) {
    const cron = (akm as Record<string, unknown>).schedule as string;
    scheduleField = cron;
  } else {
    const rawSchedule = onRecord !== undefined && Object.hasOwn(onRecord, "schedule") ? onRecord.schedule : undefined;
    if (rawSchedule !== undefined) {
      if (!Array.isArray(rawSchedule) || rawSchedule.length === 0) {
        return blocked(input, "invalid-v3-task", "on.schedule must be a non-empty list of {cron} records");
      }
      const crons: string[] = [];
      for (const entry of rawSchedule) {
        let record: Record<string, unknown>;
        try {
          record = plainRecord(entry, "on.schedule[]");
        } catch (cause) {
          return blocked(input, "invalid-v3-task", causeMessage(cause));
        }
        const keys = Object.keys(record);
        if (keys.length !== 1 || keys[0] !== "cron" || typeof record.cron !== "string" || record.cron.length === 0) {
          return blocked(input, "invalid-v3-task", "each on.schedule entry must be exactly {cron: <non-empty string>}");
        }
        crons.push(record.cron);
      }
      scheduleField = crons.map((cron): ScheduleEntry => ({ cron }));
    } else {
      notices.push(
        "schedule: is absent from the migrated document — the source's only trigger was on.workflow_dispatch (manual dispatch); task source v4 tasks are always runnable manually via `akm task run`, so no schedule: entry was emitted.",
      );
    }
  }

  const out: Record<string, unknown> = { version: 4 };
  if (Object.hasOwn(data, "name")) out.name = data.name;
  if (hasUses) out.uses = data.uses;
  else out.run = data.run;
  if (Object.hasOwn(data, "shell")) out.shell = data.shell;
  if (hasWith) out.with = data.with;
  if (Object.hasOwn(data, "env")) out.env = data.env;
  if (Object.hasOwn(data, "working-directory")) out["working-directory"] = data["working-directory"];
  if (scheduleField !== undefined) out.schedule = scheduleField;
  if (akm) {
    for (const key of AKM_HOIST_KEYS) {
      if (Object.hasOwn(akm, key)) out[key] = akm[key];
    }
    // v3's `akm.outputSchema: null` means "no schema" (accepted verbatim by
    // the frozen v3 reader, task-source-v3-frozen.ts:256-258); v4's
    // `output:` has no null form (parseOutputSchema always requires a
    // mapping). Omitting the key is the faithful v4 equivalent of an
    // explicit v3 null — emitting `output: null` would fail the real
    // parseTaskSourceV4 validation below and block the whole file.
    if (Object.hasOwn(akm, "outputSchema") && akm.outputSchema !== null) {
      // v4 accepts `output:` ONLY on a command target — `uses: commands/<ref>`
      // or `uses: akm/command` (src/tasks/source/task-source-v4.ts's
      // `targetConsumesOutputSchema`). v3 enforced no such rule: the frozen v3
      // reader accepts `akm.outputSchema` on ANY target kind
      // (task-source-v3-frozen.ts:256-263), and on `run:`/`uses: scripts/`/
      // `uses: workflows/` it was equally inert there — nothing ever consumed
      // it. Hoisting it unconditionally would therefore emit bytes the real
      // parseTaskSourceV4 below rejects, blocking a valid, previously-runnable
      // v3 file from `akm migrate apply`
      // (scripts/akm-migrate/migrate/task-files.ts). Dropping an
      // already-inert field and SAYING SO is the faithful translation, and
      // keeps spec row B-66 / §5.3's `changed` guarantee intact.
      if (usesTarget !== undefined && (usesTarget.kind === "command" || usesTarget.kind === "builtin-command")) {
        out.output = akm.outputSchema;
      } else {
        const targetLabel = usesTarget === undefined ? "a run: target" : `the "${usesTarget.ref}" target`;
        notices.push(
          `akm.outputSchema was dropped rather than hoisted to output: — task source v4 accepts output: only with a command target (uses: commands/<ref> or uses: akm/command), and ${targetLabel} never consumed the schema in v3 either, so nothing enforceable was lost.`,
        );
      }
    }
  }

  const afterYaml = stringifyYaml(out);
  const after = Buffer.from(afterYaml, "utf8");
  try {
    parseTaskSourceV4({
      yaml: afterYaml,
      filePath: input.filePath,
      ...(input.containmentRoot ? { workspaceRoot: input.containmentRoot } : {}),
    });
  } catch (cause) {
    return blocked(input, "generated-v4-validation-failed", causeMessage(cause));
  }

  const notice = notices.join(" ");
  return Object.freeze({
    status: "changed" as const,
    ...base(input),
    reason: "task-converted" as const,
    after,
    afterHash: hash(after),
    ...(notice ? { notice } : {}),
  });
}

// ── v2 → v3-shape record ───────────────────────────────────────────────────

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

/**
 * Convert one already-normalized legacy record to a v3-shape record, in
 * memory — never written to disk, never reported as its own outcome. Returns
 * a blocked reason string in place of the record when the v2 document has no
 * safe v4 representation.
 */
function migratedObject(data: Record<string, unknown>): Record<string, unknown> | string {
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

/**
 * v2 straight to v4: build the v3-shape record in memory, validate it
 * through the REAL typed v3 parser exactly as the prior v2-to-v3 generation
 * did (the same safety net, now inline), then hoist it to v4 through the
 * same `planV3DataToV4` every real v3 file goes through. `before`/
 * `beforeHash` on the result are always the original v2 bytes (`base(input)`,
 * computed from the untouched `input`).
 */
function planV2DataToV4(input: TaskToV4FileInput, data: Record<string, unknown>): TaskToV4FileOutcome {
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
    return blocked(input, "invalid-v2-task", causeMessage(cause));
  }
  let migrated: Record<string, unknown> | string;
  try {
    migrated = migratedObject(data);
  } catch (cause) {
    return blocked(input, "invalid-v2-task", causeMessage(cause));
  }
  if (isReason(migrated)) {
    const detail = migrated === "argv-array-has-no-portable-shell-string" ? ARGV_ARRAY_BLOCK_DETAIL : undefined;
    return blocked(input, migrated, detail);
  }

  const v3Yaml = stringifyYaml(migrated);
  try {
    parseTaskV3Yaml({
      yaml: v3Yaml,
      filePath: input.filePath,
      ...(input.containmentRoot ? { workspaceRoot: input.containmentRoot } : {}),
    });
  } catch (cause) {
    return blocked(input, "generated-v3-validation-failed", causeMessage(cause));
  }

  let v3Data: Record<string, unknown>;
  try {
    ({ data: v3Data } = parseRawTaskYaml({ ...input, bytes: Buffer.from(v3Yaml, "utf8") }));
  } catch (cause) {
    return blocked(input, "invalid-task-yaml", causeMessage(cause));
  }
  const v4Outcome = planV3DataToV4(input, v3Data);
  return v4Outcome.status === "changed" ? { ...v4Outcome, reason: "task-converted" } : v4Outcome;
}

// ── v4 (cleanup only) ───────────────────────────────────────────────────────

/** A v4 document: strip 0.9.15's retired per-schedule `enabled`, if present; otherwise already current. */
function planV4Cleanup(input: TaskToV4FileInput, source: string): TaskToV4FileOutcome {
  const document = parseDocument(source, { uniqueKeys: true });
  const schedule = document.get("schedule", true);
  let removed = false;
  if (isSeq(schedule)) {
    for (const entry of schedule.items) {
      if (!isMap(entry) || !entry.has("enabled")) continue;
      entry.delete("enabled");
      removed = true;
    }
  }
  if (removed) {
    if (!input.writable || input.onDiskWritable === false) {
      return blocked(
        input,
        "read-only-source",
        !input.writable ? "the owning source is not writable" : "the source file or publication directory is read-only",
      );
    }
    const after = Buffer.from(document.toString(), "utf8");
    try {
      parseTaskSourceV4({
        yaml: after.toString("utf8"),
        filePath: input.filePath,
        ...(input.containmentRoot ? { workspaceRoot: input.containmentRoot } : {}),
      });
    } catch (cause) {
      return blocked(input, "generated-v4-validation-failed", causeMessage(cause));
    }
    return Object.freeze({
      status: "changed" as const,
      ...base(input),
      reason: "source-enablement-removed" as const,
      after,
      afterHash: hash(after),
      notice: "Removed source-owned schedule enablement; scheduler activation is now host-local config.",
    });
  }
  try {
    parseTaskSourceV4({
      yaml: source,
      filePath: input.filePath,
      ...(input.containmentRoot ? { workspaceRoot: input.containmentRoot } : {}),
    });
    return Object.freeze({ status: "skipped" as const, ...base(input), reason: "already-v4" as const });
  } catch (cause) {
    return blocked(input, "invalid-v4-task", causeMessage(cause));
  }
}

// ── dispatcher ───────────────────────────────────────────────────────────────

/** Plan exactly one source file — v2, v3, or v4 — straight to v4, without touching disk. */
export function planTaskToV4File(input: TaskToV4FileInput): TaskToV4FileOutcome {
  let data: Record<string, unknown>;
  let source: string;
  try {
    ({ data, source } = parseRawTaskYaml(input));
  } catch (cause) {
    return blocked(input, "invalid-task-yaml", causeMessage(cause));
  }

  if (data.version === 4) {
    return planV4Cleanup(input, source);
  }

  if (data.version === 3) {
    try {
      parseTaskV3Yaml({
        yaml: source,
        filePath: input.filePath,
        ...(input.containmentRoot ? { workspaceRoot: input.containmentRoot } : {}),
      });
    } catch (cause) {
      return blocked(input, "invalid-v3-task", causeMessage(cause));
    }
    return planV3DataToV4(input, data);
  }

  if (data.version === 2) {
    return planV2DataToV4(input, data);
  }

  return blocked(input, "unsupported-task-version", `expected version 2, 3, or 4, got ${String(data.version)}`);
}

function generationFor(files: readonly TaskToV4FileOutcome[]): string {
  const digest = crypto.createHash("sha256");
  digest.update("akm-task-to-v4-plan-v1\0");
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
    if (file.status === "changed" && file.notice) digest.update(file.notice);
    digest.update("\0");
  }
  return digest.digest("hex");
}

/** Build/fingerprint a plan from already-derived immutable outcomes. */
export function taskToV4PlanFromOutcomes(outcomes: readonly TaskToV4FileOutcome[]): TaskToV4MigrationPlan {
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
