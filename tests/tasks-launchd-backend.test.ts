import { describe, expect, test } from "bun:test";
import { buildPlistXml } from "../src/tasks/backends/launchd";
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

describe("buildPlistXml", () => {
  test("step minutes -> StartInterval", () => {
    const xml = buildPlistXml(makeTask("*/15 * * * *"), ["/abs/akm"], "/var/log/akm");
    expect(xml).toContain("<key>Label</key>");
    expect(xml).toContain("<string>com.akm.task.ping</string>");
    expect(xml).toContain("<key>StartInterval</key>");
    expect(xml).toContain("<integer>900</integer>");
    expect(xml).toContain("<string>/abs/akm</string>");
    expect(xml).toContain("<string>tasks</string>");
    expect(xml).toContain("<string>run</string>");
    expect(xml).toContain("<string>ping</string>");
    expect(xml).toContain("<string>/var/log/akm/ping.log</string>");
  });

  test("daily at HH:MM -> StartCalendarInterval", () => {
    const xml = buildPlistXml(makeTask("30 9 * * *"), ["/abs/akm"], "/var/log/akm");
    expect(xml).toContain("<key>StartCalendarInterval</key>");
    expect(xml).toContain("<key>Hour</key><integer>9</integer>");
    expect(xml).toContain("<key>Minute</key><integer>30</integer>");
  });

  test("weekly on Mon -> Weekday=1", () => {
    const xml = buildPlistXml(makeTask("0 8 * * 1"), ["/abs/akm"], "/var/log/akm");
    expect(xml).toContain("<key>Weekday</key><integer>1</integer>");
  });
});
