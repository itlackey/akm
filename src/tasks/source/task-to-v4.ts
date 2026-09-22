// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure, byte-producing task-v3 to task-source-v4 migration planner (spec
 * docs/plans/specs/p2b-input-bindings.md §1.3, §1.7 C-N1, §5). Mirrors
 * `task-to-v3.ts`'s fail-closed ladder exactly: the INPUT side is read as a
 * raw record by a vendored bounded-YAML reader (never the typed
 * `parseTaskV3Yaml`, which would normalize away exactly the value bytes this
 * migrator must preserve — a duration string like "5m", or a bare numeric
 * `timeout`, would be converted to milliseconds by the real parser). The
 * OUTPUT side is validated through the REAL `parseTaskSourceV4` before a
 * "changed" outcome is ever handed back (C-N1, B-71).
 *
 * `inputs:` is never invented — the migrator translates structure, not
 * intent (spec §5.3).
 */

import crypto from "node:crypto";
import path from "node:path";
import { isMap, isSeq, LineCounter, parseDocument, stringify as stringifyYaml } from "yaml";
import { assertBoundedTaskYamlDocument } from "./bounded-document";
import { classifyTaskV3Uses, type TaskV3UsesTarget } from "./task-source-v3-frozen";
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
  /**
   * `pending-v2-to-v3-migration` (spec docs/plans/specs/p4-deletions-closeout.md
   * §3.2.5): generation 2 (v3 -> task source v4) has nothing to do to a file
   * that is still v2 — that is generation 1's domain, not a "this file is
   * malformed" signal. Reported as skipped, not blocked, so a combined
   * `akm migrate status`/`apply` run does not misreport a v2 file mid-pipeline
   * as needing manual review; it becomes reachable by this generation once
   * generation 1 converts it to v3.
   */
  readonly reason: "already-v4" | "pending-v2-to-v3-migration";
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

/**
 * Vendored raw-record reader (mirrors `task-to-v3.ts`'s `parseLegacyTaskYaml`
 * exactly). Reading the RAW decoded record — rather than the typed
 * `parseTaskV3Yaml` — keeps every field's original value bytes (a duration
 * string, a bare millisecond integer, an env value's exact type) intact for
 * verbatim re-emission; a typed v3 parse would normalize several of these
 * away (C-N1).
 */
function parseV3RawYaml(input: TaskToV4FileInput): { data: Record<string, unknown>; source: string } {
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
    sourceLabel: "task v3 migration source",
    lineCounter,
  });
  return { data: plainRecord(document.toJS({ maxAliasCount: 0 }), "task YAML"), source };
}

type ScheduleEntry = Readonly<{ cron: string }>;

/** Convert one already-validated v3 raw record to final task source v4 bytes. */
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
      // v3 file — and one blocked file aborts the whole plan
      // (`applyTaskToV4MigrationPlan`, ./task-files-to-v4.ts). Dropping an
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

/** Plan exactly one source file without touching disk. */
export function planTaskToV4File(input: TaskToV4FileInput): TaskToV4FileOutcome {
  let data: Record<string, unknown>;
  let source: string;
  try {
    ({ data, source } = parseV3RawYaml(input));
  } catch (cause) {
    return blocked(input, "invalid-task-yaml", causeMessage(cause));
  }

  if (data.version === 4) {
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
          !input.writable
            ? "the owning source is not writable"
            : "the source file or publication directory is read-only",
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

  // Not this generation's document to validate — v2 grammar is entirely
  // generation 1's domain (task-to-v3.ts). Reported skipped, not blocked
  // (see TaskToV4Skipped's own header).
  if (data.version === 2) {
    return Object.freeze({
      status: "skipped" as const,
      ...base(input),
      reason: "pending-v2-to-v3-migration" as const,
    });
  }

  if (data.version !== 3) {
    return blocked(input, "unsupported-task-version", `expected version 2, 3, or 4, got ${String(data.version)}`);
  }

  return planV3DataToV4(input, data);
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

/** Plan a complete, stable file set. Input order cannot change the result. */
export function planTaskToV4Migration(inputs: readonly TaskToV4FileInput[]): TaskToV4MigrationPlan {
  const sorted = [...inputs].sort((left, right) =>
    left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0,
  );
  let previous: TaskToV4FileInput | undefined;
  for (const current of sorted) {
    if (previous && path.resolve(previous.filePath) === path.resolve(current.filePath)) {
      throw new Error(`duplicate task migration file path: ${current.filePath}`);
    }
    previous = current;
  }
  return taskToV4PlanFromOutcomes(sorted.map(planTaskToV4File));
}
