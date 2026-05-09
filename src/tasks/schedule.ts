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
 * The shared subset is `*`, single integers, `*\/N`, plus the `@hourly /
 * @daily / @weekly / @monthly` aliases. Patterns outside that — multi-value
 * lists, ranges, step values other than `*\/N`, day-of-month AND
 * day-of-week combinations — are rejected with a {@link UsageError}.
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
 */
export type ScheduleField = { kind: "star" } | { kind: "value"; value: number } | { kind: "step"; step: number };

const ALIAS_TO_CRON: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

const FIELD_LIMITS = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 6 },
} as const;

const SUPPORTED_HINT =
  "Supported subset: `*`, single integers (`5`), and step-on-star (`*/N`). " +
  "Aliases: `@hourly`, `@daily`, `@weekly`, `@monthly`. " +
  "Lists, ranges, and named days/months are not supported.";

export function parseSchedule(input: string, backend: ScheduleBackend): ScheduleSpec {
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
  if (lower in ALIAS_TO_CRON) return ALIAS_TO_CRON[lower];
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
    minute: parseField(m, "minute", FIELD_LIMITS.minute, original),
    hour: parseField(h, "hour", FIELD_LIMITS.hour, original),
    dom: parseField(dom, "day-of-month", FIELD_LIMITS.dom, original),
    month: parseField(mon, "month", FIELD_LIMITS.month, original),
    dow: parseField(dow, "day-of-week", FIELD_LIMITS.dow, original),
  };
}

function parseField(raw: string, name: string, limit: { min: number; max: number }, original: string): ScheduleField {
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
 * Build the inner XML for the `Triggers` of a launchd plist's
 * `StartCalendarInterval` array, OR a single `StartInterval` integer when the
 * schedule is a single `*\/N` minute step (the simpler launchd primitive).
 */
export interface LaunchdTrigger {
  /** Use `<integer>N</integer>` under `<key>StartInterval</key>`. */
  intervalSeconds?: number;
  /** Use `<dict>…</dict>` under `<key>StartCalendarInterval</key>`. */
  calendar?: LaunchdCalendar;
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

  // `*/N` minute (everything else `*`) → StartInterval = N*60 seconds.
  if (
    f.minute.kind === "step" &&
    f.hour.kind === "star" &&
    f.dom.kind === "star" &&
    f.month.kind === "star" &&
    f.dow.kind === "star"
  ) {
    return { intervalSeconds: f.minute.step * 60 };
  }

  // `*/N` hour → StartInterval = N*3600.
  if (
    f.minute.kind === "value" &&
    f.minute.value === 0 &&
    f.hour.kind === "step" &&
    f.dom.kind === "star" &&
    f.month.kind === "star" &&
    f.dow.kind === "star"
  ) {
    return { intervalSeconds: f.hour.step * 3600 };
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
  // field is `*` the schedule has no anchor and we'd need a StartInterval
  // instead — treat this as "every minute".
  if (Object.keys(calendar).length === 0) {
    return { intervalSeconds: 60 };
  }
  return { calendar };
}

function rejectStepInsideCalendar(field: ScheduleField, name: string, spec: ScheduleSpec): void {
  if (field.kind === "step") {
    throw new UsageError(
      `Schedule "${spec.raw}" uses step (${name} = */N) in a position macOS launchd cannot express. ${SUPPORTED_HINT}`,
      "INVALID_FLAG_VALUE",
      "Either restrict the step to the minute or hour field only, or rewrite the schedule with concrete values.",
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
  | { kind: "hour"; everyHours: number }
  | { kind: "daily"; atHour: number; atMinute: number }
  | { kind: "weekly"; atHour: number; atMinute: number; daysOfWeek: number[] };

export function translateToSchtasks(spec: ScheduleSpec): SchtasksTrigger {
  const f = spec.fields;

  // `*/N` minute → MINUTE, every N.
  if (
    f.minute.kind === "step" &&
    f.hour.kind === "star" &&
    f.dom.kind === "star" &&
    f.month.kind === "star" &&
    f.dow.kind === "star"
  ) {
    return { kind: "minute", everyMinutes: f.minute.step };
  }

  // `0 */N * * *` → HOURLY, every N.
  if (
    f.minute.kind === "value" &&
    f.minute.value === 0 &&
    f.hour.kind === "step" &&
    f.dom.kind === "star" &&
    f.month.kind === "star" &&
    f.dow.kind === "star"
  ) {
    return { kind: "hour", everyHours: f.hour.step };
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

  // `M H * * D` → WEEKLY at H:M on day D.
  if (
    f.minute.kind === "value" &&
    f.hour.kind === "value" &&
    f.dom.kind === "star" &&
    f.month.kind === "star" &&
    f.dow.kind === "value"
  ) {
    return {
      kind: "weekly",
      atHour: f.hour.value,
      atMinute: f.minute.value,
      daysOfWeek: [f.dow.value],
    };
  }

  throw new UsageError(
    `Schedule "${spec.raw}" cannot be expressed as a Windows Task Scheduler trigger. ${SUPPORTED_HINT}`,
    "INVALID_FLAG_VALUE",
    "Use one of: */N minutes, every N hours (0 */N * * *), daily at HH:MM, or weekly on a single weekday.",
  );
}

/** Human-readable summary used by `tasks doctor`. */
export const SCHEDULE_SUPPORTED_SUBSET_HINT = SUPPORTED_HINT;
