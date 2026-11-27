import { describe, expect, test } from "bun:test";
import { UsageError } from "../src/core/errors";
import { parseSchedule, translateToCron, translateToLaunchd, translateToSchtasks } from "../src/tasks/schedule";

describe("parseSchedule", () => {
  test("expands aliases", () => {
    expect(parseSchedule("@daily", "cron").cron).toBe("0 0 * * *");
    expect(parseSchedule("@hourly", "cron").cron).toBe("0 * * * *");
    expect(parseSchedule("@weekly", "cron").cron).toBe("0 0 * * 0");
    expect(parseSchedule("@monthly", "cron").cron).toBe("0 0 1 * *");
  });

  test("accepts plain cron", () => {
    const spec = parseSchedule("*/15 * * * *", "cron");
    expect(spec.fields.minute.kind).toBe("step");
    if (spec.fields.minute.kind === "step") expect(spec.fields.minute.step).toBe(15);
    expect(spec.fields.hour.kind).toBe("star");
  });

  test("accepts a range-step schedule", () => {
    const spec = parseSchedule("0 2-22/4 * * *", "cron");
    expect(spec.fields.hour).toEqual({ kind: "rangeStep", start: 2, end: 22, step: 4 });
    expect(translateToCron(spec)).toBe("0 2-22/4 * * *");
  });

  test("rejects too-many fields", () => {
    expect(() => parseSchedule("0 0 0 0 0 0", "cron")).toThrow(UsageError);
  });

  test("rejects out-of-range value", () => {
    expect(() => parseSchedule("0 25 * * *", "cron")).toThrow(UsageError);
  });

  test("accepts comma list in any field", () => {
    // 2026-05-27: list support added so `7,37 * * * *` (twice/hour) works.
    const spec = parseSchedule("7,37 * * * *", "cron");
    expect(spec.fields.minute).toEqual({ kind: "list", values: [7, 37] });
    expect(spec.fields.hour).toEqual({ kind: "star" });
  });

  test("dedupes and sorts list values into ascending order", () => {
    const spec = parseSchedule("37,7,7 * * * *", "cron");
    expect(spec.fields.minute).toEqual({ kind: "list", values: [7, 37] });
  });

  test("rejects out-of-range list element", () => {
    expect(() => parseSchedule("7,99 * * * *", "cron")).toThrow(UsageError);
  });

  // The cron backend was rejecting plain ranges even
  // though it emits the expression to a real crontab verbatim, and vixie/cronie
  // accept "0-30" natively. A plain range is a `rangeStep` with `step: 1` so
  // it reuses the exact same downstream handling a stepped range already has.
  test("accepts plain range syntax, representing it as a step-1 range-step", () => {
    const spec = parseSchedule("0-30 * * * *", "cron");
    expect(spec.fields.minute).toEqual({ kind: "rangeStep", start: 0, end: 30, step: 1 });
    expect(translateToCron(spec)).toBe("0-30 * * * *");
  });

  test("rejects a plain range outside the field's bounds", () => {
    expect(() => parseSchedule("0 9 * * 1-9", "cron")).toThrow(UsageError);
  });

  test("weekdays at 9am is accepted verbatim on cron", () => {
    const spec = parseSchedule("0 9 * * 1-5", "cron");
    expect(spec.fields.dow).toEqual({ kind: "rangeStep", start: 1, end: 5, step: 1 });
    expect(translateToCron(spec)).toBe("0 9 * * 1-5");
  });

  test("accepts three-letter day-of-week and month names, case-insensitively", () => {
    expect(parseSchedule("0 9 * * mon", "cron").fields.dow).toEqual({ kind: "value", value: 1 });
    expect(parseSchedule("0 9 * * SUN", "cron").fields.dow).toEqual({ kind: "value", value: 0 });
    expect(parseSchedule("0 0 1 JAN *", "cron").fields.month).toEqual({ kind: "value", value: 1 });
  });

  test("accepts a name range (MON-FRI) the same way as its numeric equivalent", () => {
    expect(parseSchedule("0 9 * * MON-FRI", "cron").fields.dow).toEqual(
      parseSchedule("0 9 * * 1-5", "cron").fields.dow,
    );
  });

  test("accepts a comma list of names", () => {
    expect(parseSchedule("0 9 * * mon,wed,fri", "cron").fields.dow).toEqual({ kind: "list", values: [1, 3, 5] });
  });

  test("expands @yearly / @annually to the same 5-field cron as vixie-cron", () => {
    expect(parseSchedule("@yearly", "cron").cron).toBe("0 0 1 1 *");
    expect(parseSchedule("@annually", "cron").cron).toBe("0 0 1 1 *");
  });

  test("passes @reboot through verbatim on the cron backend", () => {
    const spec = parseSchedule("@reboot", "cron");
    expect(spec.cron).toBe("@reboot");
    expect(translateToCron(spec)).toBe("@reboot");
  });

  test("@reboot has no launchd or schtasks equivalent this release expresses", () => {
    expect(() => parseSchedule("@reboot", "launchd")).toThrow(UsageError);
    expect(() => parseSchedule("@reboot", "schtasks")).toThrow(UsageError);
  });
});

describe("translateToCron", () => {
  test("emits the cron expression verbatim", () => {
    expect(translateToCron(parseSchedule("0 9 * * *", "cron"))).toBe("0 9 * * *");
  });
});

describe("translateToLaunchd", () => {
  test("*/15 minutes preserves cron wall-clock boundaries", () => {
    const t = translateToLaunchd(parseSchedule("*/15 * * * *", "launchd"));
    expect(t.calendars).toEqual([{ Minute: 0 }, { Minute: 15 }, { Minute: 30 }, { Minute: 45 }]);
  });

  test("0 */2 * * * preserves even-hour boundaries", () => {
    const t = translateToLaunchd(parseSchedule("0 */2 * * *", "launchd"));
    expect(t.calendars).toEqual(Array.from({ length: 12 }, (_, hour) => ({ Minute: 0, Hour: hour * 2 })));
  });

  test("expands an hour range-step into calendar boundaries", () => {
    const t = translateToLaunchd(parseSchedule("0 2-22/4 * * *", "launchd"));
    expect(t.calendars).toEqual([2, 6, 10, 14, 18, 22].map((Hour) => ({ Minute: 0, Hour })));
  });

  test("daily at 09:30 -> calendar", () => {
    const t = translateToLaunchd(parseSchedule("30 9 * * *", "launchd"));
    expect(t.calendar).toEqual({ Minute: 30, Hour: 9 });
  });

  test("weekly at 08:00 mon -> calendar", () => {
    const t = translateToLaunchd(parseSchedule("0 8 * * 1", "launchd"));
    expect(t.calendar).toEqual({ Minute: 0, Hour: 8, Weekday: 1 });
  });

  test("rejects step in non-minute/hour position", () => {
    // No realistic path produces this from cron syntax we accept; force the shape.
    expect(() => parseSchedule("*/5 */5 * * *", "launchd")).toThrow(UsageError);
  });

  test("rejects a minute comma list — launchd has no single multi-trigger primitive there", () => {
    expect(() => translateToLaunchd(parseSchedule("7,37 * * * *", "launchd"))).toThrow(UsageError);
  });

  // Finding 3: a day-of-week (or month) range/list DOES have a launchd
  // primitive — one calendar dict per named day, the same "calendars" array
  // trick already used for minute/hour steps above.
  test("expands a weekdays-at-9am range into one calendar dict per day", () => {
    const t = translateToLaunchd(parseSchedule("0 9 * * 1-5", "launchd"));
    expect(t.calendars).toEqual([1, 2, 3, 4, 5].map((Weekday) => ({ Minute: 0, Hour: 9, Weekday })));
  });

  test("expands a day-of-week comma list into one calendar dict per named day", () => {
    const t = translateToLaunchd(parseSchedule("0 9 * * 1,3,5", "launchd"));
    expect(t.calendars).toEqual([1, 3, 5].map((Weekday) => ({ Minute: 0, Hour: 9, Weekday })));
  });

  test("expands a month range into one calendar dict per month", () => {
    const t = translateToLaunchd(parseSchedule("0 0 1 1-3 *", "launchd"));
    expect(t.calendars).toEqual([1, 2, 3].map((Month) => ({ Minute: 0, Hour: 0, Day: 1, Month })));
  });

  test("rejects restricted DOM and DOW instead of changing cron OR semantics to AND", () => {
    expect(() => parseSchedule("0 9 1 * 1", "launchd")).toThrow("day-of-month and day-of-week use OR semantics");
    expect(() => parseSchedule("0 9 1 * 1", "schtasks")).toThrow("day-of-month and day-of-week use OR semantics");
  });
});

describe("translateToSchtasks", () => {
  test("*/30 minutes -> minute trigger", () => {
    const t = translateToSchtasks(parseSchedule("*/30 * * * *", "schtasks"));
    expect(t).toEqual({ kind: "minute", everyMinutes: 30 });
  });

  test("non-divisor minute steps expand to hourly wall-clock anchors", () => {
    const t = translateToSchtasks(parseSchedule("*/7 * * * *", "schtasks"));
    expect(t).toEqual({ kind: "minuteValues", minutes: [0, 7, 14, 21, 28, 35, 42, 49, 56] });
  });

  test("minute range-steps expand to hourly wall-clock anchors", () => {
    const t = translateToSchtasks(parseSchedule("5-55/10 * * * *", "schtasks"));
    expect(t).toEqual({ kind: "minuteValues", minutes: [5, 15, 25, 35, 45, 55] });
  });

  test("0 */3 * * * -> hour trigger", () => {
    const t = translateToSchtasks(parseSchedule("0 */3 * * *", "schtasks"));
    expect(t).toEqual({ kind: "hour", everyHours: 3, atMinute: 0 });
  });

  test("non-divisor hour steps expand instead of drifting across midnight", () => {
    const t = translateToSchtasks(parseSchedule("0 */5 * * *", "schtasks"));
    expect(t).toEqual({ kind: "hourValues", hours: [0, 5, 10, 15, 20], atMinute: 0 });
  });

  test("hour range-step expands to exact daily wall-clock anchors", () => {
    const t = translateToSchtasks(parseSchedule("0 2-22/4 * * *", "schtasks"));
    expect(t).toEqual({ kind: "hourValues", hours: [2, 6, 10, 14, 18, 22], atMinute: 0 });
  });

  test("0 * * * * -> hourly trigger", () => {
    const t = translateToSchtasks(parseSchedule("0 * * * *", "schtasks"));
    expect(t).toEqual({ kind: "hour", everyHours: 1, atMinute: 0 });
  });

  test("fixed-minute hourly schedules preserve their minute", () => {
    const t = translateToSchtasks(parseSchedule("17 * * * *", "schtasks"));
    expect(t).toEqual({ kind: "hour", everyHours: 1, atMinute: 17 });
  });

  test("all shipped scheduled defaults are exactly representable", () => {
    for (const schedule of ["0 * * * *", "0 */4 * * *", "0 2 * * *", "0 4 * * *", "0 3 * * 0"]) {
      expect(() => parseSchedule(schedule, "schtasks")).not.toThrow();
    }
  });

  test("M H * * * -> daily", () => {
    const t = translateToSchtasks(parseSchedule("15 9 * * *", "schtasks"));
    expect(t).toEqual({ kind: "daily", atHour: 9, atMinute: 15 });
  });

  test("M H * * D -> weekly", () => {
    const t = translateToSchtasks(parseSchedule("0 8 * * 1", "schtasks"));
    expect(t).toEqual({ kind: "weekly", atHour: 8, atMinute: 0, daysOfWeek: [1] });
  });

  // Finding 3: "weekdays at 9am" is a plain day-of-week range, which Task
  // Scheduler's native <DaysOfWeek> already takes as a set — no native
  // trigger limit applies, unlike the minute/hour list expansions above.
  test("M H * * A-B (a day-of-week range) -> weekly on every day in the range", () => {
    const t = translateToSchtasks(parseSchedule("0 9 * * 1-5", "schtasks"));
    expect(t).toEqual({ kind: "weekly", atHour: 9, atMinute: 0, daysOfWeek: [1, 2, 3, 4, 5] });
  });

  test("M H * * a,b,c (a day-of-week list) -> weekly on exactly those days", () => {
    const t = translateToSchtasks(parseSchedule("0 9 * * 1,3,5", "schtasks"));
    expect(t).toEqual({ kind: "weekly", atHour: 9, atMinute: 0, daysOfWeek: [1, 3, 5] });
  });

  // Finding 3: @monthly ("0 0 1 * *") was advertised as supported but had no
  // schtasks branch at all — it fell straight through to the generic refusal.
  test("M H D * * (@monthly's shape) -> monthly on every month", () => {
    const t = translateToSchtasks(parseSchedule("@monthly", "schtasks"));
    expect(t).toEqual({
      kind: "monthly",
      atHour: 0,
      atMinute: 0,
      daysOfMonth: [1],
      months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    });
  });

  test("M H D m * -> monthly restricted to one month (@yearly's shape)", () => {
    const t = translateToSchtasks(parseSchedule("@yearly", "schtasks"));
    expect(t).toEqual({ kind: "monthly", atHour: 0, atMinute: 0, daysOfMonth: [1], months: [1] });
  });

  test("M H D,D m,m * -> monthly accepts day-of-month and month lists", () => {
    const t = translateToSchtasks(parseSchedule("0 6 1,15 3,9 *", "schtasks"));
    expect(t).toEqual({ kind: "monthly", atHour: 6, atMinute: 0, daysOfMonth: [1, 15], months: [3, 9] });
  });

  test("still rejects a genuinely unexpressable combination (day-of-month AND day-of-week together)", () => {
    expect(() => parseSchedule("0 0 1 * 1", "schtasks")).toThrow(UsageError);
  });

  test("rejects expansions beyond Task Scheduler's native trigger limit", () => {
    expect(() => parseSchedule("1-59/1 * * * *", "schtasks")).toThrow(
      "requires 59 native triggers; Windows Task Scheduler allows at most 48",
    );
  });
});
