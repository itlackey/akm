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

  test("still rejects range syntax", () => {
    expect(() => parseSchedule("0-30 * * * *", "cron")).toThrow(UsageError);
  });
});

describe("translateToCron", () => {
  test("emits the cron expression verbatim", () => {
    expect(translateToCron(parseSchedule("0 9 * * *", "cron"))).toBe("0 9 * * *");
  });
});

describe("translateToLaunchd", () => {
  test("*/15 minutes -> StartInterval", () => {
    const t = translateToLaunchd(parseSchedule("*/15 * * * *", "launchd"));
    expect(t.intervalSeconds).toBe(15 * 60);
  });

  test("0 */2 * * * -> StartInterval (hourly step)", () => {
    const t = translateToLaunchd(parseSchedule("0 */2 * * *", "launchd"));
    expect(t.intervalSeconds).toBe(2 * 3600);
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

  test("rejects comma list — launchd has no single multi-trigger primitive", () => {
    expect(() => translateToLaunchd(parseSchedule("7,37 * * * *", "launchd"))).toThrow(UsageError);
  });
});

describe("translateToSchtasks", () => {
  test("*/30 minutes -> minute trigger", () => {
    const t = translateToSchtasks(parseSchedule("*/30 * * * *", "schtasks"));
    expect(t).toEqual({ kind: "minute", everyMinutes: 30 });
  });

  test("0 */3 * * * -> hour trigger", () => {
    const t = translateToSchtasks(parseSchedule("0 */3 * * *", "schtasks"));
    expect(t).toEqual({ kind: "hour", everyHours: 3 });
  });

  test("M H * * * -> daily", () => {
    const t = translateToSchtasks(parseSchedule("15 9 * * *", "schtasks"));
    expect(t).toEqual({ kind: "daily", atHour: 9, atMinute: 15 });
  });

  test("M H * * D -> weekly", () => {
    const t = translateToSchtasks(parseSchedule("0 8 * * 1", "schtasks"));
    expect(t).toEqual({ kind: "weekly", atHour: 8, atMinute: 0, daysOfWeek: [1] });
  });

  test("rejects unsupported combinations", () => {
    expect(() => parseSchedule("0 0 1 * *", "schtasks")).toThrow(UsageError);
  });
});
