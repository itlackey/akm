// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Schedule parsing and minute matching.
 *
 * Users always type cron-style expressions, on every OS:
 *
 *   • `m h dom mon dow`   — five-field cron (UNIX minute/hour/dom/mon/dow)
 *   • `@hourly` `@daily` `@weekly` `@monthly` `@yearly`/`@annually` `@midnight`
 *
 * `akm task dispatch` is the only thing the OS scheduler runs; it evaluates
 * every enabled task's expression against the clock with
 * {@link scheduleMatchesMinute}. There is one grammar and no per-OS subset.
 * Day-of-month and day-of-week both restricted means "either", as in vixie-cron.
 */

import { UsageError } from "../core/errors";

/** Parsed shape. */
export interface ScheduleSpec {
  /** Original input as the user typed it (for error messages and storage). */
  raw: string;
  /** Cron-style five-field representation, alias-expanded. */
  cron: string;
  /** Structured fields. */
  fields: ScheduleFields;
}

export interface ScheduleFields {
  minute: ScheduleField;
  hour: ScheduleField;
  dom: ScheduleField; // day of month
  month: ScheduleField;
  dow: ScheduleField; // day of week (0-6, Sunday = 0)
}

/**
 * Parsed value of a single cron field. The supported subset is:
 *
 *   • star          `*`
 *   • single value  `5`
 *   • step on star  `*\/15`
 *   • step on range `2-22/4`
 */
export type ScheduleField =
  | { kind: "star" }
  | { kind: "value"; value: number }
  | { kind: "step"; step: number }
  | { kind: "rangeStep"; start: number; end: number; step: number }
  // Cron-style comma list, e.g. `7,37 * * * *` (twice per hour).
  // `values` is the deduped, ascending list of valid integers within
  // `[limit.min, limit.max]`.
  | { kind: "list"; values: number[] };

const ALIAS_TO_CRON: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

/**
 * Substitute three-letter day-of-week / month names (and name ranges, e.g.
 * `MON-FRI`) with their numeric cron equivalents, case-insensitively, so the
 * existing numeric grammar below (value / range / list) parses the result
 * unchanged. Tokens that are not recognized names pass through untouched —
 * they are numbers already, or genuinely invalid and left for the numeric
 * parsers to reject with their own message.
 */
function substituteNamedTokens(raw: string, fieldName: "month" | "day-of-week"): string {
  const names: readonly string[] = fieldName === "month" ? MONTH_NAMES : DOW_NAMES;
  const offset = fieldName === "month" ? 1 : 0;
  const indexOf = (token: string): number | undefined => {
    const idx = names.indexOf(token.toLowerCase());
    return idx === -1 ? undefined : idx + offset;
  };
  return raw
    .split(",")
    .map((part) => {
      const rangeMatch = part.match(/^([A-Za-z]{3})-([A-Za-z]{3})$/);
      if (rangeMatch) {
        const start = indexOf(rangeMatch[1]!);
        const end = indexOf(rangeMatch[2]!);
        if (start !== undefined && end !== undefined) return `${start}-${end}`;
        return part;
      }
      const single = /^[A-Za-z]{3}$/.test(part) ? indexOf(part) : undefined;
      return single !== undefined ? String(single) : part;
    })
    .join(",");
}

const FIELD_LIMITS = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 6 },
} as const;

export const SCHEDULE_SUPPORTED_SUBSET_HINT =
  "Supported subset: `*`, single integers (`5`), ranges (`A-B`), steps (`*/N`, `A-B/N`), and comma lists " +
  "(`7,37`). Day-of-week and month fields also accept three-letter names and name ranges (`MON`, `MON-FRI`, " +
  "`JAN`). Aliases: `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`/`@annually`.";

export function parseSchedule(input: string): ScheduleSpec {
  const cron = expandAlias(input);
  return { raw: input, cron, fields: parseCronFields(cron, input) };
}

function expandAlias(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new UsageError("Schedule is empty.", "MISSING_REQUIRED_ARGUMENT");
  }
  const lower = trimmed.toLowerCase();
  if (lower in ALIAS_TO_CRON) return ALIAS_TO_CRON[lower]!;
  return trimmed;
}

function parseCronFields(cron: string, original: string): ScheduleFields {
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) {
    throw new UsageError(
      `Invalid schedule "${original}": expected 5 fields, got ${parts.length}. ${SCHEDULE_SUPPORTED_SUBSET_HINT}`,
      "INVALID_FLAG_VALUE",
    );
  }
  const [m, h, dom, mon, dow] = parts;
  return {
    minute: parseField(m!, "minute", FIELD_LIMITS.minute, original),
    hour: parseField(h!, "hour", FIELD_LIMITS.hour, original),
    dom: parseField(dom!, "day-of-month", FIELD_LIMITS.dom, original),
    month: parseField(mon!, "month", FIELD_LIMITS.month, original),
    dow: parseField(dow!, "day-of-week", FIELD_LIMITS.dow, original),
  };
}

function parseField(
  rawInput: string,
  name: "minute" | "hour" | "day-of-month" | "month" | "day-of-week",
  limit: { min: number; max: number },
  original: string,
): ScheduleField {
  const raw = name === "month" || name === "day-of-week" ? substituteNamedTokens(rawInput, name) : rawInput;
  if (raw === "*") return { kind: "star" };

  const stepMatch = raw.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = Number(stepMatch[1]);
    // Step must be ≥1 and ≤ the field's range size, not just `max`. For
    // 1-based fields like day-of-month (1-31) and month (1-12) the previous
    // `max + 1` bound let invalid steps like `*/32` or `*/13` slip through.
    const range = limit.max - limit.min + 1;
    if (!Number.isInteger(step) || step <= 0 || step > range) {
      throw new UsageError(
        `Invalid ${name} step "${raw}" in schedule "${original}". ${SCHEDULE_SUPPORTED_SUBSET_HINT}`,
        "INVALID_FLAG_VALUE",
      );
    }
    return { kind: "step", step };
  }

  const rangeStepMatch = raw.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (rangeStepMatch) {
    const start = Number(rangeStepMatch[1]);
    const end = Number(rangeStepMatch[2]);
    const step = Number(rangeStepMatch[3]);
    if (start < limit.min || end > limit.max || start > end || step <= 0) {
      throw new UsageError(
        `Invalid ${name} range-step "${raw}" in schedule "${original}" (allowed ${limit.min}-${limit.max}).`,
        "INVALID_FLAG_VALUE",
      );
    }
    return { kind: "rangeStep", start, end, step };
  }

  // Plain range, no step: `A-B` (e.g. `1-5` for Mon-Fri, `1-5` for the first
  // five days of the month). Represented as a `rangeStep` with `step: 1` so
  // every downstream consumer (verbatim cron passthrough, launchd/schtasks
  // expansion) reuses the exact same handling a stepped range already gets.
  const rangeMatch = raw.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (start < limit.min || end > limit.max || start > end) {
      throw new UsageError(
        `Invalid ${name} range "${raw}" in schedule "${original}" (allowed ${limit.min}-${limit.max}).`,
        "INVALID_FLAG_VALUE",
      );
    }
    return { kind: "rangeStep", start, end, step: 1 };
  }

  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (value < limit.min || value > limit.max) {
      throw new UsageError(
        `Invalid ${name} value "${raw}" in schedule "${original}" (allowed ${limit.min}-${limit.max}).`,
        "INVALID_FLAG_VALUE",
      );
    }
    return { kind: "value", value };
  }

  // Comma-separated list: `7,37` or `0,15,30,45`. Each element must be an
  // integer within [limit.min, limit.max]. Duplicates and unsorted input
  // are accepted but the parsed form is deduped + ascending so downstream
  // consumers can rely on a canonical shape.
  if (/^\d+(,\d+)+$/.test(raw)) {
    const values = [...new Set(raw.split(",").map((s) => Number(s)))].sort((a, b) => a - b);
    for (const v of values) {
      if (!Number.isInteger(v) || v < limit.min || v > limit.max) {
        throw new UsageError(
          `Invalid ${name} list value "${v}" in schedule "${original}" (allowed ${limit.min}-${limit.max}).`,
          "INVALID_FLAG_VALUE",
        );
      }
    }
    return { kind: "list", values };
  }

  throw new UsageError(
    `Unsupported ${name} expression "${raw}" in schedule "${original}". ${SCHEDULE_SUPPORTED_SUBSET_HINT}`,
    "INVALID_FLAG_VALUE",
  );
}

// ── Minute matching ─────────────────────────────────────────────────────────

function fieldMatches(field: ScheduleField, value: number, min: number): boolean {
  switch (field.kind) {
    case "star":
      return true;
    case "value":
      return field.value === value;
    case "step":
      return (value - min) % field.step === 0;
    case "rangeStep":
      return value >= field.start && value <= field.end && (value - field.start) % field.step === 0;
    case "list":
      return field.values.includes(value);
  }
}

/** Whether a field began with `*` in the source: vixie-cron's rule for when dom and dow combine with AND. */
const startsWithStar = (field: ScheduleField): boolean => field.kind === "star" || field.kind === "step";

/** Whether `fields` fire at the wall-clock minute `at` (local time, whole minute). */
export function scheduleMatchesMinute(fields: ScheduleFields, at: Date): boolean {
  if (!fieldMatches(fields.minute, at.getMinutes(), FIELD_LIMITS.minute.min)) return false;
  if (!fieldMatches(fields.hour, at.getHours(), FIELD_LIMITS.hour.min)) return false;
  if (!fieldMatches(fields.month, at.getMonth() + 1, FIELD_LIMITS.month.min)) return false;
  const domMatch = fieldMatches(fields.dom, at.getDate(), FIELD_LIMITS.dom.min);
  const dowMatch = fieldMatches(fields.dow, at.getDay(), FIELD_LIMITS.dow.min);
  return startsWithStar(fields.dom) || startsWithStar(fields.dow) ? domMatch && dowMatch : domMatch || dowMatch;
}
