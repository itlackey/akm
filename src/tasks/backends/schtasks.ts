/**
 * schtasks.exe backend for `akm tasks` (Windows default).
 *
 * Each task is registered under the `\akm\` Task Scheduler folder so the
 * backend never touches user-managed tasks. The full task definition is
 * sent through `schtasks /Create /TN \akm\<id> /XML <path>` so we can
 * express triggers/principals/actions without quoting hell.
 *
 * Tests inject a fake exec + filesystem.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError } from "../../core/errors";
import { getTaskLogDir } from "../../core/paths";
import { resolveAkmInvocation } from "../resolveAkmBin";
import { parseSchedule, type SchtasksTrigger, translateToSchtasks } from "../schedule";
import type { TaskDocument } from "../schema";
import type { InstalledTaskRef, TaskBackend } from "./index";

export interface SchtasksExec {
  run(args: string[]): { status: number; stdout: string; stderr: string };
}

export interface SchtasksFs {
  writeFile(file: string, content: string): void;
  removeFile(file: string): void;
  tmpdir(): string;
}

export interface SchtasksBackendOptions {
  exec?: SchtasksExec;
  fs?: SchtasksFs;
  /** Override the akm invocation argv. */
  akmArgv?: string[];
  /** Override the absolute log directory. */
  logDir?: string;
  /** Folder prefix for task names. Default `\akm\`. */
  folderPrefix?: string;
}

export const DEFAULT_FOLDER_PREFIX = "\\akm\\";

export function SCHTASKS_BACKEND(options: SchtasksBackendOptions = {}): TaskBackend {
  const exec = options.exec ?? defaultSchtasksExec();
  const fsLike = options.fs ?? defaultSchtasksFs();
  const akmArgv = options.akmArgv ?? resolveAkmInvocation().argv;
  const logDir = options.logDir ?? getTaskLogDir();
  const folder = options.folderPrefix ?? DEFAULT_FOLDER_PREFIX;
  const taskName = (id: string) => `${folder}${id}`;

  return {
    name: "schtasks",
    install(task: TaskDocument) {
      const xml = buildSchtasksXml(task, akmArgv, logDir);
      const tmpFile = path.join(fsLike.tmpdir(), `akm-task-${task.id}-${Date.now()}.xml`);
      fsLike.writeFile(tmpFile, xml);
      try {
        // /F forces overwrite if a task with the same name exists.
        const r = exec.run(["schtasks", "/Create", "/TN", taskName(task.id), "/XML", tmpFile, "/F"]);
        if (r.status !== 0) {
          throw new ConfigError(
            `schtasks /Create failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
            "INVALID_CONFIG_FILE",
          );
        }
        if (!task.enabled) {
          const dis = exec.run(["schtasks", "/Change", "/TN", taskName(task.id), "/DISABLE"]);
          if (dis.status !== 0) {
            throw new ConfigError(
              `schtasks /Change /DISABLE failed: ${dis.stderr || dis.stdout || "no output"}.`,
              "INVALID_CONFIG_FILE",
            );
          }
        }
      } finally {
        fsLike.removeFile(tmpFile);
      }
    },
    uninstall(id: string) {
      const r = exec.run(["schtasks", "/Delete", "/TN", taskName(id), "/F"]);
      if (r.status !== 0 && !/cannot find/i.test(r.stderr ?? "")) {
        throw new ConfigError(
          `schtasks /Delete failed: ${r.stderr || r.stdout || "no output"}.`,
          "INVALID_CONFIG_FILE",
        );
      }
    },
    setEnabled(id: string, enabled: boolean) {
      const flag = enabled ? "/ENABLE" : "/DISABLE";
      const r = exec.run(["schtasks", "/Change", "/TN", taskName(id), flag]);
      if (r.status !== 0) {
        throw new ConfigError(
          `schtasks /Change ${flag} failed: ${r.stderr || r.stdout || "no output"}.`,
          "INVALID_CONFIG_FILE",
        );
      }
    },
    list(): InstalledTaskRef[] {
      const r = exec.run(["schtasks", "/Query", "/FO", "CSV", "/NH"]);
      if (r.status !== 0) return [];
      const ids: string[] = [];
      for (const line of (r.stdout ?? "").split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)",/);
        if (!m) continue;
        const name = m[1];
        if (name.startsWith(folder)) {
          ids.push(name.slice(folder.length));
        }
      }
      return ids.map((id) => ({ id }));
    },
  };
}

// ── XML builder (exported for tests) ────────────────────────────────────────

export function buildSchtasksXml(task: TaskDocument, akmArgv: string[], logDir: string): string {
  const spec = parseSchedule(task.schedule, "schtasks");
  const trigger = translateToSchtasks(spec);
  const command = akmArgv[0];
  const args = [...akmArgv.slice(1), "tasks", "run", task.id].map((a) => quoteArg(a)).join(" ");
  const triggerXml = renderSchtasksTrigger(trigger);
  const logPath = path.join(logDir, `${task.id}.log`);

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>akm scheduled task: ${escapeXml(task.id)}</Description>
    <URI>\\akm\\${escapeXml(task.id)}</URI>
  </RegistrationInfo>
  <Triggers>
${triggerXml}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <Enabled>${task.enabled ? "true" : "false"}</Enabled>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(command)}</Command>
      <Arguments>${escapeXml(args)}</Arguments>
      <WorkingDirectory>${escapeXml(logDir)}</WorkingDirectory>
    </Exec>
  </Actions>
  <!-- Log target (informational only; schtasks doesn't redirect): ${escapeXml(logPath)} -->
</Task>
`;
}

function renderSchtasksTrigger(trigger: SchtasksTrigger): string {
  const startBoundary = "2025-01-01T00:00:00";
  switch (trigger.kind) {
    case "minute":
      return `    <TimeTrigger>
      <Repetition>
        <Interval>PT${trigger.everyMinutes}M</Interval>
      </Repetition>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>`;
    case "hour":
      return `    <TimeTrigger>
      <Repetition>
        <Interval>PT${trigger.everyHours}H</Interval>
      </Repetition>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>`;
    case "daily":
      return `    <CalendarTrigger>
      <StartBoundary>${pad(startBoundary, trigger.atHour, trigger.atMinute)}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>`;
    case "weekly": {
      const dayMap = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const days = trigger.daysOfWeek.map((d) => `        <${dayMap[d]} />`).join("\n");
      return `    <CalendarTrigger>
      <StartBoundary>${pad(startBoundary, trigger.atHour, trigger.atMinute)}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByWeek>
        <DaysOfWeek>
${days}
        </DaysOfWeek>
        <WeeksInterval>1</WeeksInterval>
      </ScheduleByWeek>
    </CalendarTrigger>`;
    }
  }
}

function pad(base: string, hour: number, minute: number): string {
  // Replace HH:MM in `2025-01-01T00:00:00` with the configured time.
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return base.replace(/T\d\d:\d\d:\d\d$/, `T${hh}:${mm}:00`);
}

function quoteArg(s: string): string {
  if (/^[A-Za-z0-9_\-./@:%=+,\\]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function defaultSchtasksExec(): SchtasksExec {
  return {
    run(args: string[]) {
      const [bin, ...rest] = args;
      const r = spawnSync(bin, rest, { encoding: "utf8" });
      return {
        status: r.status ?? 1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      };
    },
  };
}

function defaultSchtasksFs(): SchtasksFs {
  return {
    writeFile(file, content) {
      fs.writeFileSync(file, content, { encoding: "utf8" });
    },
    removeFile(file) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    },
    tmpdir() {
      return os.tmpdir();
    },
  };
}
