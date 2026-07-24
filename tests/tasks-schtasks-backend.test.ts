import { describe, expect, test } from "bun:test";
import { akmTasksSync } from "../src/commands/tasks/tasks";
import type { InstalledTaskRef } from "../src/tasks/backends";
import { decodeCommandOutput, escapeXml } from "../src/tasks/backends/exec-utils";
import type { SchtasksExec, SchtasksFs } from "../src/tasks/backends/schtasks";
import { buildSchtasksXml, extractSchtasksTarget, SCHTASKS_BACKEND } from "../src/tasks/backends/schtasks";
import {
  type ScheduledTaskContext,
  schedulerContextDescriptor,
  schedulerContextPath,
} from "../src/tasks/scheduler-invocation";
import type { TaskDocument } from "../src/tasks/schema";
import { withIsolatedAkmStorage } from "./_helpers/sandbox";

const SCHEDULED_CONTEXT: ScheduledTaskContext = {
  AKM_STASH_DIR: "C:\\Users\\Akm User\\O'Brien & notes",
  AKM_CONFIG_DIR: "C:\\Users\\Akm User\\config",
  AKM_DATA_DIR: "C:\\Users\\Akm User\\data",
  AKM_CACHE_DIR: "C:\\Users\\Akm User\\cache",
  AKM_STATE_DIR: "C:\\Users\\Akm User\\state",
};
const USER_SID = "S-1-5-21-1000-2000-3000-1001";

const xmlOptions = <T extends Record<string, unknown>>(options?: T) => ({
  ...options,
  contextPath: schedulerContextPath(schedulerContextDescriptor(SCHEDULED_CONTEXT, process.env.PATH ?? "")),
  userSid: USER_SID,
});

function makeTask(schedule: string, id = "ping", enabled = true): TaskDocument {
  return {
    version: 2,
    schemaVersion: 2,
    id,
    schedule,
    enabled,
    target: { kind: "workflow", ref: "workflows/noop", params: {} },
    source: { path: `/stash/tasks/${id}.yml` },
  };
}

function localDate(year: number, month: number, day: number, hour: number, minute: number, second: number): Date {
  return new Date(year, month - 1, day, hour, minute, second);
}

function startBoundary(xml: string): string {
  const match = xml.match(/<StartBoundary>([^<]+)<\/StartBoundary>/);
  if (!match) throw new Error("missing StartBoundary");
  return match[1]!;
}

function startBoundaries(xml: string): string[] {
  return [...xml.matchAll(/<StartBoundary>([^<]+)<\/StartBoundary>/g)].map((match) => match[1]!);
}

function sourceSignature(xml: string): string {
  const match = xml.match(/<Source>([^<]+)<\/Source>/);
  if (!match) throw new Error("missing Source signature");
  return match[1]!;
}

function legacyTargetXml(): string {
  const task = makeTask("0 9 * * *");
  const binding = "C:\\Program Files\\O'Brien & Sons\\akm.exe";
  const powershellEnv = "$" + "env:";
  const script = [
    `${powershellEnv}AKM_DATA_DIR='C:\\Data & O''Brien'`,
    `${powershellEnv}PATH='C:\\Tools & More'`,
    `& '${binding.replaceAll("'", "''")}' 'tasks' 'run' 'ping' '--target' 'work' '--scheduled'`,
    "exit $LASTEXITCODE",
  ].join("; ");
  const argumentsValue = `-NoLogo -NoProfile -NonInteractive -Command "${script}"`;
  return buildSchtasksXml(task, [binding], "C:/log", xmlOptions()).replace(
    /<Arguments>[\s\S]*?<\/Arguments>/,
    `<Arguments>${escapeXml(argumentsValue)}</Arguments>`,
  );
}

describe("buildSchtasksXml", () => {
  test("common-divisor minute steps reset daily without losing wall-clock phase", () => {
    const xml = buildSchtasksXml(makeTask("*/5 * * * *"), ["C:/akm/akm.exe"], "C:/log", xmlOptions());
    expect(xml).toContain("<CalendarTrigger>");
    expect(xml).toContain("<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>");
    expect(xml).toContain("<Interval>PT5M</Interval>");
    expect(xml).toContain("<Duration>PT23H55M</Duration>");
    expect(xml).not.toContain("<Duration>P1D</Duration>");
    expect(xml).not.toContain("<TimeTrigger>");
    expect(xml).toContain("<URI>\\akm\\ping</URI>");
    expect(xml).toContain(`<UserId>${USER_SID}</UserId>`);
    expect(xml).toContain("<Command>powershell.exe</Command>");
    expect(xml).not.toContain("$env:AKM_STASH_DIR=");
    expect(xml).toContain("&apos;--scheduler-context&apos;");
    expect(xml).toContain("&apos;tasks&apos; &apos;run&apos; &apos;ping&apos; &apos;--scheduled&apos;");
    expect(xml).not.toContain("AKM_LLM_API_KEY");
    expect(xml).toContain("<Enabled>true</Enabled>");
    expect(xml).not.toContain("<WorkingDirectory>");
  });

  test("non-divisor minute steps reset on every hour indefinitely", () => {
    const xml = buildSchtasksXml(
      makeTask("*/7 * * * *"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({ now: () => localDate(2026, 7, 13, 10, 2, 37) }),
    );

    expect(xml.match(/<CalendarTrigger>/g)).toHaveLength(9);
    expect(xml.match(/<Interval>PT1H<\/Interval>/g)).toHaveLength(9);
    expect(xml.match(/<Duration>PT23H<\/Duration>/g)).toHaveLength(9);
    expect(startBoundaries(xml).map((boundary) => boundary.slice(11))).toEqual([
      "11:00:00",
      "10:07:00",
      "10:14:00",
      "10:21:00",
      "10:28:00",
      "10:35:00",
      "10:42:00",
      "10:49:00",
      "10:56:00",
    ]);
  });

  test("fixed-minute hourly schedules repeat at that minute and reset daily", () => {
    const xml = buildSchtasksXml(
      makeTask("17 * * * *"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({ now: () => localDate(2026, 7, 13, 10, 2, 37) }),
    );

    expect(startBoundary(xml)).toBe("2026-07-13T10:17:00");
    expect(xml).toContain("<Interval>PT1H</Interval>");
    expect(xml).toContain("<Duration>PT23H</Duration>");
    expect(xml).toContain("<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>");
  });

  test("non-divisor hour steps reset at midnight instead of drifting on later days", () => {
    const xml = buildSchtasksXml(
      makeTask("0 */5 * * *"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({ now: () => localDate(2026, 7, 13, 10, 2, 37) }),
    );

    expect(xml.match(/<CalendarTrigger>/g)).toHaveLength(5);
    expect(xml).not.toContain("<Repetition>");
    expect(startBoundaries(xml).map((boundary) => boundary.slice(11))).toEqual([
      "00:00:00",
      "05:00:00",
      "10:00:00",
      "15:00:00",
      "20:00:00",
    ]);
  });

  test("persisted hour range-step renders every selected daily boundary", () => {
    const xml = buildSchtasksXml(
      makeTask("0 2-22/4 * * *"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({ now: () => localDate(2026, 7, 13, 10, 2, 37) }),
    );

    expect(xml.match(/<CalendarTrigger>/g)).toHaveLength(6);
    expect(startBoundaries(xml).map((boundary) => boundary.slice(11))).toEqual([
      "02:00:00",
      "06:00:00",
      "10:00:00",
      "14:00:00",
      "18:00:00",
      "22:00:00",
    ]);
  });

  test("daily at 09:30 -> CalendarTrigger ScheduleByDay", () => {
    const xml = buildSchtasksXml(makeTask("30 9 * * *"), ["C:/akm.exe"], "C:/log", xmlOptions());
    expect(xml).toContain("<CalendarTrigger>");
    expect(xml).toContain("<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>");
    expect(xml).toContain("T09:30:00");
  });

  test("weekly on Wed -> CalendarTrigger Wednesday", () => {
    const xml = buildSchtasksXml(makeTask("0 8 * * 3"), ["C:/akm.exe"], "C:/log", xmlOptions());
    expect(xml).toContain("<Wednesday />");
    expect(xml).toContain("T08:00:00");
  });

  test("disabled task encodes Enabled=false", () => {
    const t = makeTask("*/5 * * * *");
    const xml = buildSchtasksXml({ ...t, enabled: false }, ["C:/akm.exe"], "C:/log", xmlOptions());
    expect(xml).toContain("<Enabled>false</Enabled>");
  });

  test("valid double-hyphen IDs cannot create invalid XML comments", () => {
    const xml = buildSchtasksXml(
      makeTask("*/5 * * * *", "ping--nightly"),
      ["C:/Program Files/akm&tools/akm.exe", "C:\\bundle path\\cli.js"],
      "C:/logs&archive",
      xmlOptions(),
    );

    expect(xml).not.toContain("<!--");
    expect(xml).toContain("<Description>akm scheduled task: ping--nightly</Description>");
    expect(xml).toContain("<Command>powershell.exe</Command>");
    expect(xml).toContain("C:/Program Files/akm&amp;tools/akm.exe");
    expect(xml).toContain("C:\\bundle path\\cli.js");
    expect(xml).toContain("&apos;tasks&apos; &apos;run&apos; &apos;ping--nightly&apos; &apos;--scheduled&apos;");
    expect(xml).toContain("C:/logs&amp;archive/ping--nightly.log");
  });

  test("PowerShell quoting preserves a trailing backslash in an invocation argument", () => {
    const xml = buildSchtasksXml(makeTask("*/5 * * * *"), ["C:/akm.exe", "C:\\bundle path\\"], "C:/log", xmlOptions());

    expect(xml).toContain(String.raw`&apos;C:\bundle path\&apos;`);
  });

  test("minute repetition starts at the next matching cron minute", () => {
    const xml = buildSchtasksXml(
      makeTask("*/5 * * * *"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 10, 2, 37),
      }),
    );

    expect(startBoundary(xml)).toBe("2026-07-13T10:05:00");
  });

  test("hour repetition starts at the next matching cron hour", () => {
    const xml = buildSchtasksXml(
      makeTask("0 */3 * * *"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 10, 2, 37),
      }),
    );

    expect(startBoundary(xml)).toBe("2026-07-13T12:00:00");
    expect(xml).toContain("<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>");
    expect(xml).toContain("<Duration>PT21H</Duration>");
  });

  test("shipped hourly schedule starts at the next top of the hour", () => {
    const xml = buildSchtasksXml(
      makeTask("0 * * * *"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 10, 2, 37),
      }),
    );

    expect(startBoundary(xml)).toBe("2026-07-13T11:00:00");
  });

  test("daily trigger advances to tomorrow when today's boundary passed", () => {
    const xml = buildSchtasksXml(
      makeTask("30 9 * * *"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 10, 2, 37),
      }),
    );

    expect(startBoundary(xml)).toBe("2026-07-14T09:30:00");
  });

  test("weekly trigger starts on the next configured weekday", () => {
    const xml = buildSchtasksXml(
      makeTask("0 8 * * 3"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 10, 2, 37),
      }),
    );

    expect(startBoundary(xml)).toBe("2026-07-15T08:00:00");
  });

  test("definition signature is stable across installation times", () => {
    const task = makeTask("*/5 * * * *");
    const morning = buildSchtasksXml(
      task,
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 10, 2, 37),
      }),
    );
    const evening = buildSchtasksXml(
      task,
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 18, 44, 12),
      }),
    );

    expect(sourceSignature(morning)).toMatch(/^akm:v1:[0-9a-f]{64}$/);
    expect(sourceSignature(evening)).toBe(sourceSignature(morning));
  });

  test("UTF-16LE schtasks query output is decoded without retaining its BOM", () => {
    const xml = '<?xml version="1.0" encoding="UTF-16"?>\r\n<Task />\r\n';
    const output = Buffer.from(`\ufeff${xml}`, "utf16le");

    expect(decodeCommandOutput(output)).toBe(xml);
  });
});

describe("legacy schtasks bundle attribution", () => {
  test("parses --target after environment values containing ampersands and apostrophes", () => {
    expect(extractSchtasksTarget(legacyTargetXml())).toBe("work");
  });

  test("primary sync cannot remove the foreign legacy entry", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const xml = legacyTargetXml();
      const calls: string[][] = [];
      const backend = SCHTASKS_BACKEND({
        exec: {
          run(args) {
            calls.push(args);
            if (args.includes("/FO")) {
              return { status: 0, stdout: '"\\akm\\ping","N/A","Ready"\r\n', stderr: "" };
            }
            if (args.includes("/XML")) return { status: 0, stdout: xml, stderr: "" };
            return { status: 0, stdout: "", stderr: "" };
          },
        },
        akmArgv: ["C:/current/akm.exe"],
        logDir: "C:/log",
        scheduledContext: SCHEDULED_CONTEXT,
        userSid: USER_SID,
      });

      const result = await akmTasksSync({ backend });

      expect(result.removed).toEqual([]);
      expect(calls.some((args) => args.includes("/Delete"))).toBe(false);
    } finally {
      storage.cleanup();
    }
  });
});

describe("schtasks backend signatures", () => {
  function queryExec(installedXml: string): SchtasksExec & { calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      run(args: string[]) {
        calls.push(args);
        if (args.join("\0") === ["schtasks", "/Query", "/FO", "CSV", "/NH"].join("\0")) {
          return { status: 0, stdout: '"\\akm\\ping","7/13/2026 10:05:00 AM","Ready"\r\n', stderr: "" };
        }
        if (args.join("\0") === ["schtasks", "/Query", "/TN", "\\akm\\ping", "/XML"].join("\0")) {
          return { status: 0, stdout: installedXml, stderr: "" };
        }
        throw new Error(`unexpected command: ${JSON.stringify(args)}`);
      },
    };
  }

  const listSync = (backend: ReturnType<typeof SCHTASKS_BACKEND>): InstalledTaskRef[] =>
    backend.list() as InstalledTaskRef[];

  test("list returns the installed signature expected for an unchanged task", () => {
    const task = makeTask("*/5 * * * *");
    const installedXml = buildSchtasksXml(
      task,
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 10, 2, 37),
      }),
    );
    const exec = queryExec(installedXml);
    const backend = SCHTASKS_BACKEND({
      exec,
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(listSync(backend)).toEqual([
      {
        id: "ping",
        signature: backend.expectedSignature?.(task),
        binding: ["C:/akm.exe"],
        contextPath: expect.any(String),
      },
    ]);
    expect(exec.calls).toEqual([
      ["schtasks", "/Query", "/FO", "CSV", "/NH"],
      ["schtasks", "/Query", "/TN", "\\akm\\ping", "/XML"],
    ]);
  });

  test("installed and expected signatures include enabled state", () => {
    const disabled = makeTask("*/5 * * * *", "ping", false);
    const installedXml = buildSchtasksXml(
      disabled,
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 10, 2, 37),
      }),
    );
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(installedXml),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    const installed = listSync(backend)[0]!.signature;
    expect(installed).toBe(backend.expectedSignature?.(disabled));
    expect(installed).not.toBe(backend.expectedSignature?.({ ...disabled, enabled: true }));
  });

  test("installed signatures do not trust a forged Source claim", () => {
    const task = makeTask("*/5 * * * *");
    const installedXml = buildSchtasksXml(task, ["C:/akm.exe"], "C:/log", xmlOptions()).replace(
      /<Source>[^<]+<\/Source>/,
      `<Source>akm:v1:${"0".repeat(64)}</Source>`,
    );
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(installedXml),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(listSync(backend)[0]!.signature).toBe(backend.expectedSignature?.(task));
  });

  test("installed signatures are available without a Source claim", () => {
    const task = makeTask("*/5 * * * *");
    const installedXml = buildSchtasksXml(task, ["C:/akm.exe"], "C:/log", xmlOptions()).replace(
      /\s*<Source>[^<]+<\/Source>/,
      "",
    );
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(installedXml),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(listSync(backend)[0]!.signature).toBe(backend.expectedSignature?.(task));
  });

  test("queried XML namespace prefixes and formatting do not change the signature", () => {
    const task = makeTask("*/5 * * * *");
    const installedXml = buildSchtasksXml(task, ["C:/akm.exe"], "C:/log", xmlOptions())
      .replace(/<(\/?)([A-Z][A-Za-z]*)(?=[\s/>])/g, "<$1ts:$2")
      .replace("<ts:Task ", '<ts:Task xmlns:ts="http://schemas.microsoft.com/windows/2004/02/mit/task" ')
      .replaceAll("\n", "\r\n\r\n");
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(installedXml),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(listSync(backend)[0]!.signature).toBe(backend.expectedSignature?.(task));
  });

  test("native materialized schema defaults do not create false drift", () => {
    const task = makeTask("*/5 * * * *");
    const installedXml = buildSchtasksXml(task, ["C:/akm.exe"], "C:/log", xmlOptions())
      .replace("      <RunLevel>LeastPrivilege</RunLevel>\n", "")
      .replace("      <Enabled>true</Enabled>\n      <ScheduleByDay>", "      <ScheduleByDay>")
      .replace(
        "  <Settings>",
        `  <Settings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>true</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <Hidden>false</Hidden>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT72H</ExecutionTimeLimit>
    <Priority>7</Priority>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>`,
      );
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(installedXml),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(listSync(backend)[0]!.signature).toBe(backend.expectedSignature?.(task));
  });

  test("installed signatures detect principal UserId drift", () => {
    const task = makeTask("*/5 * * * *");
    const installedXml = buildSchtasksXml(task, ["C:/akm.exe"], "C:/log", xmlOptions()).replace(
      `<UserId>${USER_SID}</UserId>`,
      "<UserId>S-1-5-21-9999-8888-7777-1002</UserId>",
    );
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(installedXml),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(listSync(backend)[0]!.signature).not.toBe(backend.expectedSignature?.(task));
  });

  test("installed signatures detect action, trigger, settings, and principal drift despite an unchanged Source", () => {
    const task = makeTask("*/5 * * * *");
    const installedXml = buildSchtasksXml(task, ["C:/akm.exe"], "C:/log", xmlOptions());
    const backendFor = (xml: string) =>
      SCHTASKS_BACKEND({
        exec: queryExec(xml),
        akmArgv: ["C:/akm.exe"],
        logDir: "C:/log",
        scheduledContext: SCHEDULED_CONTEXT,
        userSid: USER_SID,
      });
    const expected = backendFor(installedXml).expectedSignature?.(task);

    expect(listSync(backendFor(installedXml.replace("&apos;ping&apos;", "&apos;other&apos;")))[0]!.signature).not.toBe(
      expected,
    );
    expect(
      listSync(backendFor(installedXml.replace("<Interval>PT5M</Interval>", "<Interval>PT10M</Interval>")))[0]!
        .signature,
    ).not.toBe(expected);
    expect(
      listSync(
        backendFor(
          installedXml.replace(
            "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
            "<MultipleInstancesPolicy>Queue</MultipleInstancesPolicy>",
          ),
        ),
      )[0]!.signature,
    ).not.toBe(expected);
    expect(
      listSync(
        backendFor(
          installedXml.replace("<RunLevel>LeastPrivilege</RunLevel>", "<RunLevel>HighestAvailable</RunLevel>"),
        ),
      )[0]!.signature,
    ).not.toBe(expected);
  });

  test("changing a materialized settings default remains detectable drift", () => {
    const task = makeTask("*/5 * * * *");
    const installedXml = buildSchtasksXml(task, ["C:/akm.exe"], "C:/log", xmlOptions()).replace(
      "  <Settings>",
      "  <Settings>\n    <AllowStartOnDemand>false</AllowStartOnDemand>",
    );
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(installedXml),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(listSync(backend)[0]!.signature).not.toBe(backend.expectedSignature?.(task));
  });

  test("signature canonicalization ignores only the dynamic boundary cycle", () => {
    const task = makeTask("17 * * * *");
    const installedXml = buildSchtasksXml(
      task,
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({ now: () => localDate(2026, 7, 13, 10, 2, 37) }),
    )
      .replace(/\s*<Source>[^<]+<\/Source>/, "")
      .replace("2026-07-13T10:17:00", "2031-11-04T22:17:00");
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(installedXml),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(listSync(backend)[0]!.signature).toBe(backend.expectedSignature?.(task));

    const wrongPhase = installedXml.replace("2031-11-04T22:17:00", "2031-11-04T22:18:00");
    const wrongBackend = SCHTASKS_BACKEND({
      exec: queryExec(wrongPhase),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });
    expect(listSync(wrongBackend)[0]!.signature).not.toBe(wrongBackend.expectedSignature?.(task));
  });

  test("expected signature changes when the schedule changes", () => {
    const task = makeTask("*/5 * * * *");
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(""),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(backend.expectedSignature?.(task)).not.toBe(
      backend.expectedSignature?.({ ...task, schedule: "0 */3 * * *" }),
    );
  });

  test("expected signature changes when the resolved AKM context changes", () => {
    const original = SCHTASKS_BACKEND({
      exec: queryExec(""),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });
    const moved = SCHTASKS_BACKEND({
      exec: queryExec(""),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: { ...SCHEDULED_CONTEXT, AKM_DATA_DIR: "D:\\akm moved data" },
      userSid: USER_SID,
    });
    const task = makeTask("*/5 * * * *");

    expect(original.expectedSignature?.(task)).not.toBe(moved.expectedSignature?.(task));
  });

  test("a failed bulk query is surfaced instead of being treated as an empty scheduler", () => {
    const backend = SCHTASKS_BACKEND({
      exec: {
        run: () => ({ status: 5, stdout: "", stderr: "ERROR: Access is denied." }),
      },
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(() => backend.list()).toThrow("schtasks /Query failed (exit 5): ERROR: Access is denied");
  });

  test("a failed per-task XML query is surfaced instead of being treated as drift", () => {
    const backend = SCHTASKS_BACKEND({
      exec: {
        run(args) {
          if (args.includes("/XML")) return { status: 5, stdout: "", stderr: "ERROR: Access is denied." };
          return { status: 0, stdout: '"\\akm\\ping","N/A","Ready"\r\n', stderr: "" };
        },
      },
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(() => backend.list()).toThrow('schtasks /Query /XML for "\\akm\\ping" failed (exit 5)');
  });

  test("resolves the current user SID through the exec seam when one is not injected", () => {
    const calls: string[][] = [];
    const resolved = SCHTASKS_BACKEND({
      exec: {
        run(args) {
          calls.push(args);
          if (args.join("\0") === ["whoami", "/user", "/fo", "csv", "/nh"].join("\0")) {
            return { status: 0, stdout: `"DESKTOP\\user","${USER_SID}"\r\n`, stderr: "" };
          }
          throw new Error(`unexpected command: ${JSON.stringify(args)}`);
        },
      },
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
    });
    const injected = SCHTASKS_BACKEND({
      exec: queryExec(""),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(resolved.expectedSignature?.(makeTask("0 9 * * *"))).toBe(
      injected.expectedSignature?.(makeTask("0 9 * * *")),
    );
    expect(calls).toEqual([["whoami", "/user", "/fo", "csv", "/nh"]]);
  });
});

describe("schtasks backend install validation", () => {
  test("rejects excessive trigger expansion before filesystem or schtasks work", () => {
    const execCalls: string[][] = [];
    const fsCalls: string[] = [];
    const exec: SchtasksExec = {
      run(args) {
        execCalls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const fs: SchtasksFs = {
      writeFile(file) {
        fsCalls.push(`write:${file}`);
      },
      removeFile(file) {
        fsCalls.push(`remove:${file}`);
      },
      tmpdir() {
        fsCalls.push("tmpdir");
        return "C:/tmp";
      },
      ensureDir(dir) {
        fsCalls.push(`ensure:${dir}`);
      },
    };
    const backend = SCHTASKS_BACKEND({
      exec,
      fs,
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(() => backend.install(makeTask("1-59/1 * * * *"))).toThrow(
      "requires 59 native triggers; Windows Task Scheduler allows at most 48",
    );
    expect(execCalls).toEqual([]);
    expect(fsCalls).toEqual([]);
  });

  test("log-directory creation failure aborts before XML or scheduler mutation", () => {
    const execCalls: string[][] = [];
    const fsCalls: string[] = [];
    const backend = SCHTASKS_BACKEND({
      exec: {
        run(args) {
          execCalls.push(args);
          return { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
        },
      },
      fs: {
        ensureDir() {
          throw new Error("injected log directory failure");
        },
        writeFile(file) {
          fsCalls.push(`write:${file}`);
        },
        removeFile(file) {
          fsCalls.push(`remove:${file}`);
        },
        tmpdir() {
          fsCalls.push("tmpdir");
          return "C:/tmp";
        },
      },
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(() => backend.install(makeTask("0 9 * * *"))).toThrow("injected log directory failure");
    expect(execCalls).toEqual([["schtasks", "/Query", "/TN", "\\akm\\ping", "/XML"]]);
    expect(fsCalls).toEqual([]);
  });
});

describe("schtasks backend transactional install", () => {
  function transactionBackend() {
    const files = new Map<string, string>();
    let installedXml: string | undefined;
    let queriedXml: string | undefined;
    let enabled = true;
    let failNextOperation: "create" | "disable" | undefined;
    const calls: string[][] = [];
    const fs: SchtasksFs = {
      writeFile(file, content) {
        files.set(file, content);
      },
      removeFile(file) {
        files.delete(file);
      },
      tmpdir: () => "C:/tmp",
      ensureDir() {},
    };
    const exec: SchtasksExec = {
      run(args) {
        calls.push(args);
        const operation = args[1]?.toLowerCase();
        if (operation === "/query" && args.includes("/XML")) {
          return installedXml === undefined
            ? { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }
            : { status: 0, stdout: queriedXml ?? installedXml, stderr: "" };
        }
        if (operation === "/create") {
          const xmlPath = args[args.indexOf("/XML") + 1];
          installedXml = files.get(xmlPath!);
          enabled = installedXml?.match(/<Settings>[\s\S]*?<Enabled>(true|false)<\/Enabled>/)?.[1] !== "false";
          if (failNextOperation === "create") {
            failNextOperation = undefined;
            return { status: 1, stdout: "", stderr: "injected create failure" };
          }
          return { status: 0, stdout: "", stderr: "" };
        }
        if (operation === "/change") {
          enabled = args.includes("/ENABLE");
          if (installedXml !== undefined) {
            installedXml = installedXml.replace(
              /(<Settings>[\s\S]*?<Enabled>)(?:true|false)(<\/Enabled>)/,
              `$1${enabled}$2`,
            );
          }
          if (args.includes("/DISABLE") && failNextOperation === "disable") {
            failNextOperation = undefined;
            return { status: 1, stdout: "", stderr: "injected disable failure" };
          }
          return { status: 0, stdout: "", stderr: "" };
        }
        if (operation === "/delete") {
          installedXml = undefined;
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected command: ${JSON.stringify(args)}`);
      },
    };
    return {
      backend: SCHTASKS_BACKEND({
        exec,
        fs,
        akmArgv: ["C:/akm.exe"],
        logDir: "C:/log",
        scheduledContext: SCHEDULED_CONTEXT,
        userSid: USER_SID,
      }),
      calls,
      installedXml: () => installedXml,
      enabled: () => enabled,
      setQueriedXml(xml: string) {
        queriedXml = xml;
      },
      failNext(operation: "create" | "disable") {
        failNextOperation = operation;
      },
    };
  }

  test("restores prior queried XML and disabled state when /Create /F fails after replacing it", () => {
    const transaction = transactionBackend();
    transaction.backend.install(makeTask("0 9 * * *", "ping", false));
    const priorXml = transaction.installedXml();
    transaction.failNext("create");

    expect(() => transaction.backend.install(makeTask("30 10 * * *", "ping", true))).toThrow("injected create failure");

    expect(transaction.installedXml()).toBe(priorXml);
    expect(transaction.enabled()).toBe(false);
  });

  test("restores prior queried XML and enabled state when post-create disable fails", () => {
    const transaction = transactionBackend();
    transaction.backend.install(makeTask("0 9 * * *", "ping", true));
    const priorXml = transaction.installedXml();
    transaction.failNext("disable");

    expect(() => transaction.backend.install(makeTask("30 10 * * *", "ping", false))).toThrow(
      "injected disable failure",
    );

    expect(transaction.installedXml()).toBe(priorXml);
    expect(transaction.enabled()).toBe(true);
  });

  test("rollback rewrites a queried UTF-8 declaration to match the UTF-16 temp file", () => {
    const transaction = transactionBackend();
    transaction.backend.install(makeTask("0 9 * * *", "ping", true));
    const priorXml = transaction.installedXml();
    if (!priorXml) throw new Error("missing installed XML");
    transaction.setQueriedXml(priorXml.replace('encoding="UTF-16"', 'encoding="UTF-8"'));
    transaction.failNext("create");

    expect(() => transaction.backend.install(makeTask("30 10 * * *", "ping", true))).toThrow("injected create failure");

    expect(transaction.installedXml()).toBe(priorXml);
    expect(transaction.installedXml()).toContain('encoding="UTF-16"');
    expect(transaction.installedXml()).not.toContain('encoding="UTF-8"');
  });
});
