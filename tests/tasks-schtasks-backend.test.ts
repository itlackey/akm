import { describe, expect, test } from "bun:test";
import { decodeCommandOutput, escapeXml } from "../src/tasks/backends/exec-utils";
import type { SchtasksExec, SchtasksFs } from "../src/tasks/backends/schtasks";
import { buildSchtasksXml, extractSchtasksTarget, SCHTASKS_BACKEND } from "../src/tasks/backends/schtasks";
import type { InstalledSchedulerBinding } from "../src/tasks/backends/types";
import type { SchedulerBinding } from "../src/tasks/scheduler-binding";
import {
  type ScheduledTaskContext,
  schedulerContextDescriptor,
  schedulerContextPath,
} from "../src/tasks/scheduler-invocation";
import {
  type SchedulerBackendContractDriver,
  schedulerBackendConformance,
} from "./_helpers/scheduler-backend-conformance";

const SCHEDULED_CONTEXT: ScheduledTaskContext = {
  AKM_BUNDLE_DIR: "C:\\Users\\Akm User\\O'Brien & notes",
  AKM_CONFIG_DIR: "C:\\Users\\Akm User\\config",
  AKM_DATA_DIR: "C:\\Users\\Akm User\\data",
  AKM_CACHE_DIR: "C:\\Users\\Akm User\\cache",
  AKM_STATE_DIR: "C:\\Users\\Akm User\\state",
};
const USER_SID = "S-1-5-21-1000-2000-3000-1001";

const xmlOptions = <T extends Record<string, unknown>>(options?: T) => ({
  ...options,
  contextPath: schedulerContextPath(schedulerContextDescriptor(SCHEDULED_CONTEXT)),
  userSid: USER_SID,
});

function makeTask(schedule: string, id = "ping", enabled = true): SchedulerBinding {
  return {
    id,
    logicalSource: { kind: "task", ref: `stash//tasks/${id}` },
    cron: schedule,
    source: "akm.schedule",
    ordinal: 0,
    enabled,
    invocation: ["task", "run", id, "--scheduled"],
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

function descriptorlessTargetXml(): string {
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
    expect(xml).not.toContain("$env:AKM_BUNDLE_DIR=");
    expect(xml).toContain("&apos;--scheduler-context&apos;");
    expect(xml).toContain("&apos;task&apos; &apos;run&apos; &apos;ping&apos; &apos;--scheduled&apos;");
    expect(xml).not.toContain("AKM_LLM_API_KEY");
    expect(xml).toContain("<Enabled>true</Enabled>");
    expect(xml).not.toContain("<WorkingDirectory>");
  });

  test("renders a qualified workflow binding without task-only arguments", () => {
    const workflow: SchedulerBinding = {
      ...makeTask("0 9 * * *", "wf-1234"),
      logicalSource: { kind: "workflow", ref: "team//workflows/release" },
      source: "workflows/release.yml:on.schedule[0]",
      invocation: ["workflow", "run", "team//workflows/release"],
    };
    const xml = buildSchtasksXml(workflow, ["C:/akm.exe"], "C:/log", xmlOptions());
    expect(xml).toContain("&apos;workflow&apos;");
    expect(xml).toContain("&apos;team//workflows/release&apos;");
    expect(xml).not.toContain("&apos;--scheduled&apos;");
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

  test("hour range-step renders every selected daily boundary", () => {
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

  test("weekdays at 9am (a day-of-week range) -> one CalendarTrigger naming every weekday", () => {
    const xml = buildSchtasksXml(makeTask("0 9 * * 1-5"), ["C:/akm.exe"], "C:/log", xmlOptions());
    expect(xml).toContain("<ScheduleByWeek>");
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
      expect(xml).toContain(`<${day} />`);
    }
    expect(xml).not.toContain("<Sunday />");
    expect(xml).not.toContain("<Saturday />");
    expect(xml).toContain("T09:00:00");
  });

  test("@monthly -> CalendarTrigger ScheduleByMonth on day 1 of every month", () => {
    const xml = buildSchtasksXml(makeTask("@monthly"), ["C:/akm.exe"], "C:/log", xmlOptions());
    expect(xml).toContain("<ScheduleByMonth>");
    expect(xml).toContain("<Day>1</Day>");
    for (const month of [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ]) {
      expect(xml).toContain(`<${month} />`);
    }
    expect(xml).toContain("T00:00:00");
  });

  test("@yearly -> CalendarTrigger ScheduleByMonth restricted to January", () => {
    const xml = buildSchtasksXml(makeTask("@yearly"), ["C:/akm.exe"], "C:/log", xmlOptions());
    expect(xml).toContain("<ScheduleByMonth>");
    expect(xml).toContain("<Day>1</Day>");
    expect(xml).toContain("<January />");
    expect(xml).not.toContain("<February />");
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
    expect(xml).toContain("&apos;task&apos; &apos;run&apos; &apos;ping--nightly&apos; &apos;--scheduled&apos;");
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

describe("schtasks bundle attribution", () => {
  test("parses --bundle from the current descriptor-bearing invocation", () => {
    const task = makeTask("0 9 * * *");
    const targeted: SchedulerBinding = {
      ...task,
      logicalSource: { kind: "task", ref: "work//tasks/ping" },
      invocation: ["task", "run", "ping", "--bundle", "work", "--scheduled"],
    };
    const xml = buildSchtasksXml(targeted, ["C:\\Program Files\\O'Brien & Sons\\akm.exe"], "C:/log", xmlOptions());
    expect(extractSchtasksTarget(xml)).toBe("work");
  });

  // 0.9 scheduler ABI respelling (S6): an installed entry whose invocation no
  // longer parses is an orphan of its marker id, not a hard failure —
  // `list()` omits it so `akmTasksSync` treats the id as "not present" and
  // reinstalls it from the task file.
  test("omits a descriptor-less installed entry", () => {
    const xml = descriptorlessTargetXml();
    const backend = SCHTASKS_BACKEND({
      exec: {
        run(args) {
          if (args.includes("/FO")) return { status: 0, stdout: '"\\akm\\ping","N/A","Ready"\r\n', stderr: "" };
          if (args.includes("/XML")) return { status: 0, stdout: xml, stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      akmArgv: ["C:/current/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(extractSchtasksTarget(xml)).toBeUndefined();
    expect(backend.list()).toEqual([]);
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

  const listSync = (backend: ReturnType<typeof SCHTASKS_BACKEND>): InstalledSchedulerBinding[] =>
    backend.list() as InstalledSchedulerBinding[];

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
        nativeId: "ping",
        enabled: true,
        signature: backend.expectedSignature?.(task),
        binding: ["C:/akm.exe"],
        contextPath: expect.any(String),
        invocation: task.invocation,
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

  test("a row is compared by akm's own Source fingerprint: a missing or different one is drift", () => {
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

    expect(listSync(backendFor(installedXml))[0]!.signature).toBe(expected);
    expect(listSync(backendFor(installedXml.replace(/\s*<Source>[^<]+<\/Source>/, "")))[0]!.signature).not.toBe(
      expected,
    );
    expect(
      listSync(
        backendFor(installedXml.replace(/<Source>[^<]+<\/Source>/, `<Source>akm:v1:${"0".repeat(64)}</Source>`)),
      )[0]!.signature,
    ).not.toBe(expected);
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

  test("expected signature changes when the schedule changes", () => {
    const task = makeTask("*/5 * * * *");
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(""),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(backend.expectedSignature?.(task)).not.toBe(backend.expectedSignature?.({ ...task, cron: "0 */3 * * *" }));
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
    expect(execCalls).toEqual([]);
    expect(fsCalls).toEqual([]);
  });
});

/** An in-memory Task Scheduler: task name → XML, plus the temp files `/Create /XML` reads. */
function fakeTaskScheduler(scheduledContext: ScheduledTaskContext = SCHEDULED_CONTEXT) {
  const files = new Map<string, string>();
  const tasks = new Map<string, string>();
  const calls: string[][] = [];
  const ok = { status: 0, stdout: "", stderr: "" };
  const missing = { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
  let failCreate = false;
  const fs: SchtasksFs = {
    writeFile: (file, content) => void files.set(file, content),
    removeFile: (file) => void files.delete(file),
    tmpdir: () => "C:/tmp",
    ensureDir() {},
  };
  const exec: SchtasksExec = {
    run(args) {
      calls.push(args);
      const operation = args[1]?.toLowerCase();
      const name = args[args.indexOf("/TN") + 1] ?? "";
      if (operation === "/query" && args.includes("/XML")) {
        const xml = tasks.get(name);
        return xml === undefined ? missing : { status: 0, stdout: xml, stderr: "" };
      }
      if (operation === "/query") {
        return {
          status: 0,
          stdout: [...tasks.keys()].map((task) => `"${task}","N/A","Ready"`).join("\r\n"),
          stderr: "",
        };
      }
      if (operation === "/create") {
        if (failCreate) {
          failCreate = false;
          return { status: 1, stdout: "", stderr: "injected create failure" };
        }
        tasks.set(name, files.get(args[args.indexOf("/XML") + 1] ?? "") ?? "");
        return ok;
      }
      if (operation === "/change") {
        const xml = tasks.get(name);
        if (xml === undefined) return missing;
        const enabled = args.includes("/ENABLE");
        tasks.set(name, xml.replace(/(<Settings>[\s\S]*?<Enabled>)(?:true|false)(<\/Enabled>)/, `$1${enabled}$2`));
        return ok;
      }
      if (operation === "/delete") return tasks.delete(name) ? ok : missing;
      throw new Error(`unexpected command: ${JSON.stringify(args)}`);
    },
  };
  return {
    backend: SCHTASKS_BACKEND({
      exec,
      fs,
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext,
      userSid: USER_SID,
    }),
    calls,
    files,
    tasks,
    failNextCreate() {
      failCreate = true;
    },
  };
}

function schtasksContractDriver(scheduledContext = SCHEDULED_CONTEXT): SchedulerBackendContractDriver {
  const scheduler = fakeTaskScheduler(scheduledContext);
  const sorted = (map: Map<string, string>) => [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
  return {
    backend: scheduler.backend,
    captureState: () => ({ tasks: sorted(scheduler.tasks), files: sorted(scheduler.files) }),
    rowText: (nativeId) => scheduler.tasks.get(`\\akm\\${nativeId}`),
    addForeignRow() {
      scheduler.tasks.set(
        "\\Backup\\nightly",
        "<Task><Actions><Exec><Command>backup.exe</Command></Exec></Actions></Task>",
      );
      return () => scheduler.tasks.get("\\Backup\\nightly");
    },
  };
}

schedulerBackendConformance({
  name: "schtasks",
  scheduledContext: SCHEDULED_CONTEXT,
  movedContext: { ...SCHEDULED_CONTEXT, AKM_STATE_DIR: "C:\\Users\\Akm User\\moved-state" },
  create: schtasksContractDriver,
});

describe("schtasks backend install", () => {
  test("registers the XML through /Create /XML <temp> /F and removes the temp file", () => {
    const scheduler = fakeTaskScheduler();

    scheduler.backend.install(makeTask("0 9 * * *"));

    const create = scheduler.calls.find((call) => call[1] === "/Create");
    expect(create).toEqual(["schtasks", "/Create", "/TN", "\\akm\\ping", "/XML", expect.any(String), "/F"]);
    expect(scheduler.tasks.get("\\akm\\ping")).toContain('encoding="UTF-16"');
    expect(scheduler.files.size).toBe(0);
  });

  test("a failed /Create is reported and leaves no temp file behind", () => {
    const scheduler = fakeTaskScheduler();
    scheduler.failNextCreate();

    expect(() => scheduler.backend.install(makeTask("0 9 * * *"))).toThrow("injected create failure");
    expect(scheduler.tasks.size).toBe(0);
    expect(scheduler.files.size).toBe(0);
  });

  test("uses a portable native name while preserving a nested logical invocation", () => {
    const scheduler = fakeTaskScheduler();
    const nested = {
      ...makeTask("0 9 * * *", "sub/deep/nightly"),
      logicalSource: { kind: "task" as const, ref: "team//sub/deep/nightly" },
      invocation: ["task", "run", "sub/deep/nightly", "--bundle", "team", "--scheduled"],
    };

    scheduler.backend.install(nested);

    const [taskName] = [...scheduler.tasks.keys()];
    expect(taskName?.slice("\\akm\\".length)).not.toContain("/");
    expect(scheduler.tasks.get(taskName ?? "")).toContain("&apos;sub/deep/nightly&apos;");
    expect(scheduler.backend.list()).toEqual([expect.objectContaining({ id: "sub/deep/nightly", target: "team" })]);
  });
});
