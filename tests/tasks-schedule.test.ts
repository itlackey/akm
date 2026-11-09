import { describe, expect, test } from "bun:test";
import { UsageError } from "../src/core/errors";
import { parseSchedule, scheduleMatchesMinute } from "../src/tasks/schedule";

describe("parseSchedule", () => {
  test("expands aliases", () => {
    expect(parseSchedule("@daily").cron).toBe("0 0 * * *");
    expect(parseSchedule("@hourly").cron).toBe("0 * * * *");
    expect(parseSchedule("@weekly").cron).toBe("0 0 * * 0");
    expect(parseSchedule("@monthly").cron).toBe("0 0 1 * *");
  });

  test("accepts plain cron", () => {
    const spec = parseSchedule("*/15 * * * *");
    expect(spec.fields.minute.kind).toBe("step");
    if (spec.fields.minute.kind === "step") expect(spec.fields.minute.step).toBe(15);
    expect(spec.fields.hour.kind).toBe("star");
  });

  test("accepts a range-step schedule", () => {
    const spec = parseSchedule("0 2-22/4 * * *");
    expect(spec.fields.hour).toEqual({ kind: "rangeStep", start: 2, end: 22, step: 4 });
  });

  test("rejects too-many fields", () => {
    expect(() => parseSchedule("0 0 0 0 0 0")).toThrow(UsageError);
  });

  test("rejects out-of-range value", () => {
    expect(() => parseSchedule("0 25 * * *")).toThrow(UsageError);
  });

  test("accepts comma list in any field", () => {
    // 2026-05-27: list support added so `7,37 * * * *` (twice/hour) works.
    const spec = parseSchedule("7,37 * * * *");
    expect(spec.fields.minute).toEqual({ kind: "list", values: [7, 37] });
    expect(spec.fields.hour).toEqual({ kind: "star" });
  });

  test("dedupes and sorts list values into ascending order", () => {
    const spec = parseSchedule("37,7,7 * * * *");
    expect(spec.fields.minute).toEqual({ kind: "list", values: [7, 37] });
  });

  test("rejects out-of-range list element", () => {
    expect(() => parseSchedule("7,99 * * * *")).toThrow(UsageError);
  });

  // The cron backend was rejecting plain ranges even
  // though it emits the expression to a real crontab verbatim, and vixie/cronie
  // accept "0-30" natively. A plain range is a `rangeStep` with `step: 1` so
  // it reuses the exact same downstream handling a stepped range already has.
  test("accepts plain range syntax, representing it as a step-1 range-step", () => {
    const spec = parseSchedule("0-30 * * * *");
    expect(spec.fields.minute).toEqual({ kind: "rangeStep", start: 0, end: 30, step: 1 });
  });

  test("rejects a plain range outside the field's bounds", () => {
    expect(() => parseSchedule("0 9 * * 1-9")).toThrow(UsageError);
  });

  test("weekdays at 9am is accepted verbatim on cron", () => {
    const spec = parseSchedule("0 9 * * 1-5");
    expect(spec.fields.dow).toEqual({ kind: "rangeStep", start: 1, end: 5, step: 1 });
  });

  test("accepts three-letter day-of-week and month names, case-insensitively", () => {
    expect(parseSchedule("0 9 * * mon").fields.dow).toEqual({ kind: "value", value: 1 });
    expect(parseSchedule("0 9 * * SUN").fields.dow).toEqual({ kind: "value", value: 0 });
    expect(parseSchedule("0 0 1 JAN *").fields.month).toEqual({ kind: "value", value: 1 });
  });

  test("accepts a name range (MON-FRI) the same way as its numeric equivalent", () => {
    expect(parseSchedule("0 9 * * MON-FRI").fields.dow).toEqual(parseSchedule("0 9 * * 1-5").fields.dow);
  });

  test("accepts a comma list of names", () => {
    expect(parseSchedule("0 9 * * mon,wed,fri").fields.dow).toEqual({ kind: "list", values: [1, 3, 5] });
  });

  test("expands @yearly / @annually to the same 5-field cron as vixie-cron", () => {
    expect(parseSchedule("@yearly").cron).toBe("0 0 1 1 *");
    expect(parseSchedule("@annually").cron).toBe("0 0 1 1 *");
  });

  test("@reboot is not a schedule: dispatch runs on the clock, not at boot", () => {
    expect(() => parseSchedule("@reboot")).toThrow(UsageError);
  });

  test("one grammar everywhere: a day-of-month and day-of-week together, and a minute list, are accepted", () => {
    expect(() => parseSchedule("0 9 1 * 1")).not.toThrow();
    expect(() => parseSchedule("7,37 * * * *")).not.toThrow();
    expect(() => parseSchedule("1-59/1 * * * *")).not.toThrow();
  });
});

/** A local wall-clock minute. */
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0);
const matches = (schedule: string, when: Date) => scheduleMatchesMinute(parseSchedule(schedule).fields, when);

describe("scheduleMatchesMinute", () => {
  test("a fixed time matches only that minute", () => {
    expect(matches("30 9 * * *", at(2026, 11, 9, 9, 30))).toBe(true);
    expect(matches("30 9 * * *", at(2026, 11, 9, 9, 31))).toBe(false);
    expect(matches("30 9 * * *", at(2026, 11, 9, 10, 30))).toBe(false);
  });

  test("* * * * * matches every minute", () => {
    expect(matches("* * * * *", at(2026, 11, 9, 3, 17))).toBe(true);
  });

  test("*/15 anchors at the field minimum", () => {
    for (const minute of [0, 15, 30, 45]) expect(matches("*/15 * * * *", at(2026, 11, 9, 1, minute))).toBe(true);
    expect(matches("*/15 * * * *", at(2026, 11, 9, 1, 14))).toBe(false);
    // day-of-month is 1-based: */2 is the odd days.
    expect(matches("0 0 */2 * *", at(2026, 11, 9, 0, 0))).toBe(true);
    expect(matches("0 0 */2 * *", at(2026, 11, 10, 0, 0))).toBe(false);
  });

  test("a range-step starts at the range start", () => {
    for (const hour of [2, 6, 10, 14, 18, 22]) expect(matches("0 2-22/4 * * *", at(2026, 11, 9, hour, 0))).toBe(true);
    expect(matches("0 2-22/4 * * *", at(2026, 11, 9, 4, 0))).toBe(false);
    expect(matches("0 2-22/4 * * *", at(2026, 11, 9, 23, 0))).toBe(false);
  });

  test("a comma list matches each of its values", () => {
    expect(matches("7,37 * * * *", at(2026, 11, 9, 5, 7))).toBe(true);
    expect(matches("7,37 * * * *", at(2026, 11, 9, 5, 37))).toBe(true);
    expect(matches("7,37 * * * *", at(2026, 11, 9, 5, 8))).toBe(false);
  });

  test("weekdays: 2026-11-09 is a Monday, 2026-11-08 a Sunday", () => {
    expect(matches("0 9 * * 1-5", at(2026, 11, 9, 9, 0))).toBe(true);
    expect(matches("0 9 * * MON-FRI", at(2026, 11, 8, 9, 0))).toBe(false);
    expect(matches("0 3 * * 0", at(2026, 11, 8, 3, 0))).toBe(true);
  });

  test("month restricts", () => {
    expect(matches("0 0 1 1 *", at(2027, 1, 1, 0, 0))).toBe(true);
    expect(matches("0 0 1 1 *", at(2026, 11, 1, 0, 0))).toBe(false);
  });

  test("day-of-month and day-of-week both restricted means either, as in vixie-cron", () => {
    // 1st of the month OR a Monday.
    expect(matches("0 9 1 * 1", at(2026, 11, 1, 9, 0))).toBe(true); // Sunday the 1st
    expect(matches("0 9 1 * 1", at(2026, 11, 9, 9, 0))).toBe(true); // Monday the 9th
    expect(matches("0 9 1 * 1", at(2026, 11, 10, 9, 0))).toBe(false); // Tuesday the 10th
  });

  test("a field starting with * combines with AND, as in vixie-cron", () => {
    // every second day AND a Monday
    expect(matches("0 9 */2 * 1", at(2026, 11, 9, 9, 0))).toBe(true); // Monday, odd day
    expect(matches("0 9 */2 * 1", at(2026, 11, 16, 9, 0))).toBe(false); // Monday, even day
  });

  test("aliases", () => {
    expect(matches("@daily", at(2026, 11, 9, 0, 0))).toBe(true);
    expect(matches("@hourly", at(2026, 11, 9, 14, 0))).toBe(true);
    expect(matches("@hourly", at(2026, 11, 9, 14, 1))).toBe(false);
    expect(matches("@weekly", at(2026, 11, 8, 0, 0))).toBe(true);
    expect(matches("@monthly", at(2026, 12, 1, 0, 0))).toBe(true);
  });
});
