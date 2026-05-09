import { describe, expect, test } from "bun:test";
import { buildSchtasksXml } from "../src/tasks/backends/schtasks";
import type { TaskDocument } from "../src/tasks/schema";

function makeTask(schedule: string): TaskDocument {
  return {
    schemaVersion: 1,
    id: "ping",
    schedule,
    enabled: true,
    target: { kind: "workflow", ref: "workflow:noop", params: {} },
    source: { path: "/stash/tasks/ping.md" },
  };
}

describe("buildSchtasksXml", () => {
  test("step minutes -> TimeTrigger PT5M", () => {
    const xml = buildSchtasksXml(makeTask("*/5 * * * *"), ["C:/akm/akm.exe"], "C:/log");
    expect(xml).toContain("<TimeTrigger>");
    expect(xml).toContain("<Interval>PT5M</Interval>");
    expect(xml).toContain("<URI>\\akm\\ping</URI>");
    expect(xml).toContain("<Command>C:/akm/akm.exe</Command>");
    expect(xml).toContain("<Arguments>tasks run ping</Arguments>");
    expect(xml).toContain("<Enabled>true</Enabled>");
    expect(xml).not.toContain("<WorkingDirectory>");
  });

  test("daily at 09:30 -> CalendarTrigger ScheduleByDay", () => {
    const xml = buildSchtasksXml(makeTask("30 9 * * *"), ["C:/akm.exe"], "C:/log");
    expect(xml).toContain("<CalendarTrigger>");
    expect(xml).toContain("<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>");
    expect(xml).toContain("T09:30:00");
  });

  test("weekly on Wed -> CalendarTrigger Wednesday", () => {
    const xml = buildSchtasksXml(makeTask("0 8 * * 3"), ["C:/akm.exe"], "C:/log");
    expect(xml).toContain("<Wednesday />");
    expect(xml).toContain("T08:00:00");
  });

  test("disabled task encodes Enabled=false", () => {
    const t = makeTask("*/5 * * * *");
    const xml = buildSchtasksXml({ ...t, enabled: false }, ["C:/akm.exe"], "C:/log");
    expect(xml).toContain("<Enabled>false</Enabled>");
  });
});
