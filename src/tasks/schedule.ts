// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Cross-platform schedule parsing and translation.
 *
 * Users always type cron-style expressions:
 *
 *   • `m h dom mon dow`   — five-field cron (UNIX minute/hour/dom/mon/dow)
 *   • `@hourly` `@daily` `@weekly` `@monthly`
 *
 * Each {@link ScheduleSpec} can then be translated to:
 *
 *   • a verbatim cron line (Linux backend),
 *   • a launchd plist `<StartCalendarInterval>` / `<StartInterval>` (macOS),
 *   • Task Scheduler XML triggers (Windows).
 *
 * The shared subset is `*`, single integers, `*\/N`, `A-B`, `A-B/N`, comma
 * lists, three-letter day/month names (`MON`, `JAN`) and name ranges
 * (`MON-FRI`), plus the `@hourly / @daily / @weekly / @monthly / @yearly /
 * @annually / @reboot` aliases. Day-of-month AND day-of-week combined in the
 * same expression are rejected with a {@link UsageError} — cron gives that
 * combination OR semantics no other backend can express portably, and it is
 * genuinely ambiguous to a person reading the schedule back.
 *
 * Cron is the most permissive of the three backends; some patterns it
 * accepts (e.g. `@hourly` = `0 * * * *`) have no clean schtasks primitive.
 * Validation runs against the *active* backend, so a task authored on
 * Linux may fail to translate when copied to macOS/Windows. `tasks sync`
 * re-validates against the local backend and surfaces any incompatibility.
 */

import { UsageError } from "../core/errors";

export type ScheduleBackend = "cron" | "launchd" | "schtasks";

/** Parsed shape, before backend translation. */
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
  // 2026-05-27: cron-style comma list, e.g. `7,37 * * * *` (twice per hour).
  // `values` is the deduped, ascending list of valid integers within
  // `[limit.min, limit.max]`. translateToCron emits the field verbatim;
  // launchd / schtasks reject this kind with a clear error (no native
  // multi-trigger primitive on those backends).
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

/**
 * vixie-cron's one true nickname with no 5-field equivalent — it fires once at
 * daemon startup, not on a recurring calendar boundary. Passed straight
 * through, unexpanded, on the cron backend (a real crontab line is just
 * `@reboot <command>`); launchd and schtasks have no "run at boot" trigger in
 * the vocabulary this module targets, so those backends reject it.
 */
const REBOOT_ALIAS = "@reboot";

/** Placeholder fields for the `@reboot` `ScheduleSpec` — never read: cron's translator emits `spec.cron` verbatim, and launchd/schtasks refuse `@reboot` before touching `fields`. */
const REBOOT_FIELDS: ScheduleFields = {
  minute: { kind: "star" },
  hour: { kind: "star" },
  dom: { kind: "star" },
  month: { kind: "star" },
  dow: { kind: "star" },
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

const SUPPORTED_HINT =
  "Supported subset: `*`, single integers (`5`), ranges (`A-B`), steps (`*/N`, `A-B/N`), and comma lists " +
  "(`7,37`). Day-of-week and month fields also accept three-letter names and name ranges (`MON`, `MON-FRI`, " +
  "`JAN`). Aliases: `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`/`@annually`, `@reboot` (cron only).";

export function parseSchedule(input: string, backend: ScheduleBackend): ScheduleSpec {
  const trimmed = input.trim();
  if (trimmed.toLowerCase() === REBOOT_ALIAS) {
    if (backend !== "cron") {
      throw new UsageError(
        `Schedule "${input}" (@reboot, run once at startup) has no ${
          backend === "launchd" ? "macOS launchd" : "Windows Task Scheduler"
        } equivalent this release expresses. Use a cron-backed install, or rewrite the task with a recurring schedule.`,
        "INVALID_FLAG_VALUE",
      );
    }
    return { raw: input, cron: REBOOT_ALIAS, fields: REBOOT_FIELDS };
  }
  const cron = expandAlias(input);
  const fields = parseCronFields(cron, input);
  const spec: ScheduleSpec = { raw: input, cron, fields };
  // Validate translatability for the active backend so the caller does not
  // silently accept expressions that backend cannot run. Note: cron is the
  // most permissive of the three (e.g. `@hourly` is `0 * * * *` which has
  // no clean schtasks primitive), so a task authored on Linux may not be
  // portable to macOS/Windows. `tasks sync` on the destination platform
  // re-runs this with the local backend and will surface any incompatibility.
  if (backend === "launchd") translateToLaunchd(spec);
  if (backend === "schtasks") translateToSchtasks(spec);
  return spec;
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
      `Invalid schedule "${original}": expected 5 fields, got ${parts.length}. ${SUPPORTED_HINT}`,
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
        `Invalid ${name} step "${raw}" in schedule "${original}". ${SUPPORTED_HINT}`,
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
    `Unsupported ${name} expression "${raw}" in schedule "${original}". ${SUPPORTED_HINT}`,
    "INVALID_FLAG_VALUE",
  );
}

// ── Backend translators ─────────────────────────────────────────────────────

/** Verbatim cron line, alias-expanded. */
export function translateToCron(spec: ScheduleSpec): string {
  return spec.cron;
}

/**
 * Build the calendar entries for a launchd plist's `StartCalendarInterval`.
 * Steps are expanded to wall-clock values instead of using `StartInterval`,
 * whose phase is relative to load time rather than cron's clock boundaries.
 */
export interface LaunchdTrigger {
  /** Use `<dict>…</dict>` under `<key>StartCalendarInterval</key>`. */
  calendar?: LaunchdCalendar;
  /** Use `<array>` of dictionaries under `<key>StartCalendarInterval</key>`. */
  calendars?: LaunchdCalendar[];
}

export interface LaunchdCalendar {
  Minute?: number;
  Hour?: number;
  Day?: number; // day of month
  Month?: number;
  Weekday?: number; // 0 = Sunday
}

export function translateToLaunchd(spec: ScheduleSpec): LaunchdTrigger {
  const f = spec.fields;
  rejectDomDowCombination(spec, "macOS launchd");

  // Expand minute steps into clock-minute anchors. StartInterval would drift
  // from cron whenever the agent is loaded away from a matching boundary.
  if (
    (f.minute.kind === "step" || f.minute.kind === "rangeStep") &&
    f.hour.kind === "star" &&
    f.dom.kind === "star" &&
    f.month.kind === "star" &&
    f.dow.kind === "star"
  ) {
    return { calendars: expandFieldValues(f.minute, FIELD_LIMITS.minute).map((Minute) => ({ Minute })) };
  }

  // Likewise, anchor hour steps to the same hours cron selects each day.
  if (
    f.minute.kind === "value" &&
    (f.hour.kind === "step" || f.hour.kind === "rangeStep") &&
    f.dom.kind === "star" &&
    f.month.kind === "star" &&
    f.dow.kind === "star"
  ) {
    return {
      calendars: expandFieldValues(f.hour, FIELD_LIMITS.hour).map((Hour) => ({
        Minute: f.minute.kind === "value" ? f.minute.value : 0,
        Hour,
      })),
    };
  }

  // A day-of-week or month range/list (`1-5` for Mon-Fri, `1,3,5`) has no
  // single-dict launchd primitive either, but — unlike a step — it names a
  // small, closed set of concrete values, so it genuinely IS expressible: one
  // calendar dict per (month, weekday) combination, same trick as the
  // minute/hour step expansion above. Only attempted when the remaining
  // fields are already single values or `*`; anything else (e.g. a minute
  // step combined with a weekday range) falls through to the generic path
  // below, where `rejectStepInsideCalendar` reports the field it actually
  // cannot express.
  const dowValues = expandListLikeField(f.dow, FIELD_LIMITS.dow);
  const monthValues = expandListLikeField(f.month, FIELD_LIMITS.month);
  const remainingFieldsAreSimple =
    (f.minute.kind === "value" || f.minute.kind === "star") &&
    (f.hour.kind === "value" || f.hour.kind === "star") &&
    (f.dom.kind === "value" || f.dom.kind === "star");
  if ((dowValues || monthValues) && remainingFieldsAreSimple) {
    const base: LaunchdCalendar = {};
    if (f.minute.kind === "value") base.Minute = f.minute.value;
    if (f.hour.kind === "value") base.Hour = f.hour.value;
    if (f.dom.kind === "value") base.Day = f.dom.value;
    const months = monthValues ?? (f.month.kind === "value" ? [f.month.value] : [undefined]);
    const weekdays = dowValues ?? (f.dow.kind === "value" ? [f.dow.value] : [undefined]);
    const calendars: LaunchdCalendar[] = [];
    for (const month of months) {
      for (const weekday of weekdays) {
        calendars.push({
          ...base,
          ...(month !== undefined ? { Month: month } : {}),
          ...(weekday !== undefined ? { Weekday: weekday } : {}),
        });
      }
    }
    return { calendars };
  }

  // Otherwise build a calendar dict from concrete values. launchd treats any
  // omitted key as "every value", so a `*` field translates to "no key".
  // Exception: launchd does not support arbitrary step values inside a
  // calendar dict — reject those.
  const calendar: LaunchdCalendar = {};
  rejectStepInsideCalendar(f.minute, "minute", spec);
  rejectStepInsideCalendar(f.hour, "hour", spec);
  rejectStepInsideCalendar(f.dom, "day-of-month", spec);
  rejectStepInsideCalendar(f.month, "month", spec);
  rejectStepInsideCalendar(f.dow, "day-of-week", spec);

  if (f.minute.kind === "value") calendar.Minute = f.minute.value;
  if (f.hour.kind === "value") calendar.Hour = f.hour.value;
  if (f.dom.kind === "value") calendar.Day = f.dom.value;
  if (f.month.kind === "value") calendar.Month = f.month.value;
  if (f.dow.kind === "value") calendar.Weekday = f.dow.value;

  // launchd's CalendarInterval requires at least one specific key. If every
  // Expand every-minute to explicit minute boundaries rather than a
  // load-relative 60-second interval.
  if (Object.keys(calendar).length === 0) {
    return {
      calendars: expandFieldValues({ kind: "step", step: 1 }, FIELD_LIMITS.minute).map((Minute) => ({ Minute })),
    };
  }
  return { calendar };
}

function expandFieldValues(
  field: Extract<ScheduleField, { kind: "step" | "rangeStep" }>,
  limit: { min: number; max: number },
): number[] {
  const start = field.kind === "rangeStep" ? field.start : limit.min;
  const end = field.kind === "rangeStep" ? field.end : limit.max;
  const values: number[] = [];
  for (let value = start; value <= end; value += field.step) values.push(value);
  return values;
}

/** Discrete values named by a `list` or (stepless) `rangeStep` field; `null` for anything else (`*`, `value`, `step`). */
function expandListLikeField(field: ScheduleField, limit: { min: number; max: number }): number[] | null {
  if (field.kind === "list") return field.values;
  if (field.kind === "rangeStep") return expandFieldValues(field, limit);
  return null;
}

function rejectStepInsideCalendar(field: ScheduleField, name: string, spec: ScheduleSpec): void {
  if (field.kind === "step") {
    throw new UsageError(
      `Schedule "${spec.raw}" uses step (${name} = */N) in a position macOS launchd cannot express. ${SUPPORTED_HINT}`,
      "INVALID_FLAG_VALUE",
      "Either restrict the step to the minute or hour field only, or rewrite the schedule with concrete values.",
    );
  }
  if (field.kind === "rangeStep") {
    const shape = field.step === 1 ? "A-B" : "A-B/N";
    throw new UsageError(
      `Schedule "${spec.raw}" uses a range (${name} = ${shape}) in a position macOS launchd cannot express. ${SUPPORTED_HINT}`,
      "INVALID_FLAG_VALUE",
      "Restrict the range to the minute, hour, day-of-week, or month field, or rewrite the schedule with a concrete value.",
    );
  }
  if (field.kind === "list") {
    throw new UsageError(
      `Schedule "${spec.raw}" uses comma list (${name} = a,b,...) which macOS launchd cannot express as a single trigger. ${SUPPORTED_HINT}`,
      "INVALID_FLAG_VALUE",
      "Either install one task per list element, or rewrite the schedule with a step (`*/N`) or single value.",
    );
  }
}

/**
 * Translate to Windows Task Scheduler XML trigger fragment.
 *
 * The shape returned is consumed by `backends/schtasks.ts` to build the full
 * Task Scheduler XML. We deliberately return a simple union rather than a raw
 * XML string so the backend can compose it with the other XML elements
 * (Principal, Actions, Settings).
 */
export type SchtasksTrigger =
  | { kind: "minute"; everyMinutes: number }
  | { kind: "minuteValues"; minutes: number[] }
  | { kind: "hour"; everyHours: number; atMinute: number }
  | { kind: "hourValues"; hours: number[]; atMinute: number }
  | { kind: "daily"; atHour: number; atMinute: number }
  | { kind: "weekly"; atHour: number; atMinute: number; daysOfWeek: number[] }
  | { kind: "monthly"; atHour: number; atMinute: number; daysOfMonth: number[]; months: number[] };

const MAX_SCHTASKS_TRIGGERS = 48;

export function translateToSchtasks(spec: ScheduleSpec): SchtasksTrigger {
  const f = spec.fields;
  rejectDomDowCombination(spec, "Windows Task Scheduler");

  // A repetition interval is cron-equivalent indefinitely only when it divides
  // the field's wall-clock cycle. Other steps must reset at every hour.
  if (
    f.minute.kind === "step" &&
    f.hour.kind === "star" &&
    f.dom.kind === "star" &&
    f.month.kind === "star" &&
    f.dow.kind === "star"
  ) {
    if (60 % f.minute.step !== 0) {
      return minuteValuesTrigger(expandFieldValues(f.minute, FIELD_LIMITS.minute), spec);
    }
    return { kind: "minute", everyMinutes: f.minute.step };
  }

  if (
    f.minute.kind === "rangeStep" &&
    f.hour.kind === "star" &&
    f.dom.kind === "star" &&
    f.month.kind === "star" &&
    f.dow.kind === "star"
  ) {
    if (f.minute.start === FIELD_LIMITS.minute.min && f.minute.end === FIELD_LIMITS.minute.max) {
      if (60 % f.minute.step === 0) return { kind: "minute", everyMinutes: f.minute.step };
    }
    return minuteValuesTrigger(expandFieldValues(f.minute, FIELD_LIMITS.minute), spec);
  }

  // Fixed-minute hour schedules can use one daily-reset repetition only when
  // the interval divides 24 hours. Non-divisors become explicit daily times.
  if (
    f.minute.kind === "value" &&
    f.hour.kind === "step" &&
    f.dom.kind === "star" &&
    f.month.kind === "star" &&
    f.dow.kind === "star"
  ) {
    if (24 % f.hour.step === 0 && f.hour.step < 24) {
      return { kind: "hour", everyHours: f.hour.step, atMinute: f.minute.value };
    }
    return {
      kind: "hourValues",
      hours: expandFieldValues(f.hour, FIELD_LIMITS.hour),
      atMinute: f.minute.value,
    };
  }

  if (
    f.minute.kind === "value" &&
    f.hour.kind === "rangeStep" &&
    f.dom.kind === "star" &&
    f.month.kind === "star" &&
    f.dow.kind === "star"
  ) {
    if (f.hour.start === FIELD_LIMITS.hour.min && f.hour.end === FIELD_LIMITS.hour.max) {
      if (24 % f.hour.step === 0 && f.hour.step < 24) {
        return { kind: "hour", everyHours: f.hour.step, atMinute: f.minute.value };
      }
    }
    return {
      kind: "hourValues",
      hours: expandFieldValues(f.hour, FIELD_LIMITS.hour),
      atMinute: f.minute.value,
    };
  }

  // `M * * * *` includes the shipped top-of-hour task and arbitrary fixed
  // minutes. A daily calendar trigger resets the hourly repetition each day.
  if (
    f.minute.kind === "value" &&
    f.hour.kind === "star" &&
    f.dom.kind === "star" &&
    f.month.kind === "star" &&
    f.dow.kind === "star"
  ) {
    return { kind: "hour", everyHours: 1, atMinute: f.minute.value };
  }

  // `M H * * *` → DAILY at H:M.
  if (
    f.minute.kind === "value" &&
    f.hour.kind === "value" &&
    f.dom.kind === "star" &&
    f.month.kind === "star" &&
    f.dow.kind === "star"
  ) {
    return { kind: "daily", atHour: f.hour.value, atMinute: f.minute.value };
  }

  // `M H * * D` → WEEKLY at H:M on day(s) D — a single day, a plain range
  // (`1-5`, e.g. from `MON-FRI`), or a comma list all name a small closed set
  // of weekdays that Task Scheduler's native `<DaysOfWeek>` already takes as
  // a set, so no expansion into multiple triggers is needed.
  if (
    f.minute.kind === "value" &&
    f.hour.kind === "value" &&
    f.dom.kind === "star" &&
    f.month.kind === "star" &&
    (f.dow.kind === "value" || f.dow.kind === "list" || f.dow.kind === "rangeStep")
  ) {
    const daysOfWeek = f.dow.kind === "value" ? [f.dow.value] : expandListLikeField(f.dow, FIELD_LIMITS.dow)!;
    return {
      kind: "weekly",
      atHour: f.hour.value,
      atMinute: f.minute.value,
      daysOfWeek,
    };
  }

  // `M H D * *` / `M H D m *` → MONTHLY at H:M on day(s)-of-month D, in the
  // given month(s) m (or every month when `m` is `*`). Task Scheduler's
  // `ScheduleByMonth` trigger takes both as native sets, same as `ScheduleByWeek`
  // above.
  if (
    f.minute.kind === "value" &&
    f.hour.kind === "value" &&
    (f.dom.kind === "value" || f.dom.kind === "list") &&
    (f.month.kind === "star" || f.month.kind === "value" || f.month.kind === "list") &&
    f.dow.kind === "star"
  ) {
    const daysOfMonth = f.dom.kind === "value" ? [f.dom.value] : f.dom.values;
    const months =
      f.month.kind === "star"
        ? Array.from({ length: 12 }, (_, i) => i + 1)
        : f.month.kind === "value"
          ? [f.month.value]
          : f.month.values;
    return { kind: "monthly", atHour: f.hour.value, atMinute: f.minute.value, daysOfMonth, months };
  }

  throw new UsageError(
    `Schedule "${spec.raw}" cannot be expressed as a Windows Task Scheduler trigger. ${SUPPORTED_HINT}`,
    "INVALID_FLAG_VALUE",
    "Use one of: minute steps/range-steps, fixed-minute hour steps/range-steps, hourly, daily, weekly on one or more weekdays, or monthly on one or more days-of-month.",
  );
}

function minuteValuesTrigger(minutes: number[], spec: ScheduleSpec): SchtasksTrigger {
  if (minutes.length > MAX_SCHTASKS_TRIGGERS) {
    throw new UsageError(
      `Schedule "${spec.raw}" requires ${minutes.length} native triggers; Windows Task Scheduler allows at most ${MAX_SCHTASKS_TRIGGERS}.`,
      "INVALID_FLAG_VALUE",
      "Use a full-field step whose interval divides 60, or reduce the minute range.",
    );
  }
  return { kind: "minuteValues", minutes };
}

function rejectDomDowCombination(spec: ScheduleSpec, backend: string): void {
  if (spec.fields.dom.kind !== "star" && spec.fields.dow.kind !== "star") {
    throw new UsageError(
      `Schedule "${spec.raw}": day-of-month and day-of-week use OR semantics in cron, which ${backend} cannot express portably.`,
      "INVALID_FLAG_VALUE",
      "Use either day-of-month or day-of-week, but not both.",
    );
  }
}

/** Human-readable summary used by `tasks doctor`. */
export const SCHEDULE_SUPPORTED_SUBSET_HINT = SUPPORTED_HINT;
