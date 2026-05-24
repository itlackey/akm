// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * schtasks.exe backend for `akm tasks` (Windows default).
 *
 * Each task is registered under the `\akm\` Task Scheduler folder so the
 * backend never touches user-managed tasks. The full task definition is
 * sent through `schtasks /Create /TN \akm\<id> /XML <path>` so we can
 * express triggers/principals/actions without quoting hell.
 *
 * Platform notes:
 *   • `LogonType=InteractiveToken` means the task runs in the context of
 *     the registering user only when they are logged in — there is no
 *     stored password and the task will not fire at the lock screen.
 *   • `<Principal>` deliberately omits `<UserId>`; per the Task Scheduler
 *     2.0 schema (`principalType.UserId` minOccurs=0) this is valid and
 *     defaults to the registering user.
 *   • `<DisallowStartIfOnBatteries>false</…>` and `<StopIfGoingOnBatteries>
 *     false</…>` allow the task to run on battery — utility tasks would
 *     otherwise be silently skipped on laptops.
 *   • `MultipleInstancesPolicy=IgnoreNew` makes overlapping triggers safe:
 *     while a task is still running, a new fire is dropped rather than
 *     queued or run in parallel.
 *   • `/Query /FO CSV /NH` (without `/V`) outputs three columns:
 *     `TaskName,Next Run Time,Status` — so the regex anchors on the task
 *     name as the leading quoted field. Adding `/V` would shift HostName
 *     into column 0; we deliberately don't.
 *
 * Tests inject a fake exec + filesystem.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError } from "../../core/errors";
import { getTaskLogDir } from "../../core/paths";
import { resolveAkmInvocation } from "../resolveAkmBin";
import { parseSchedule, type SchtasksTrigger, translateToSchtasks } from "../schedule";
import type { TaskDocument } from "../schema";
import { escapeXml, spawnCommand } from "./exec-utils";
import type { InstalledTaskRef, TaskBackend } from "./index";
import schtasksTemplate from "./schtasks-template.xml" with { type: "text" };

export interface SchtasksExec {
  run(args: string[]): { status: number; stdout: string; stderr: string };
}

export interface SchtasksFs {
  writeFile(file: string, content: string): void;
  removeFile(file: string): void;
  tmpdir(): string;
  ensureDir(dir: string): void;
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
      fsLike.ensureDir(logDir);
      const xml = buildSchtasksXml(task, akmArgv, logDir, { folderPrefix: folder });
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

export interface BuildSchtasksXmlOptions {
  /** Task folder prefix (e.g. `\\akm\\`). Used to build the <URI>. */
  folderPrefix?: string;
  /** Override the StartBoundary timestamp (tests). Defaults to install time. */
  now?: () => Date;
}

export function buildSchtasksXml(
  task: TaskDocument,
  akmArgv: string[],
  logDir: string,
  options: BuildSchtasksXmlOptions = {},
): string {
  const folder = options.folderPrefix ?? DEFAULT_FOLDER_PREFIX;
  const now = options.now ? options.now() : new Date();
  const startBoundary = formatStartBoundary(now);
  const spec = parseSchedule(task.schedule, "schtasks");
  const trigger = translateToSchtasks(spec);
  const command = akmArgv[0];
  const args = [...akmArgv.slice(1), "tasks", "run", task.id].map((a) => quoteArg(a)).join(" ");
  const triggerXml = renderSchtasksTrigger(trigger, startBoundary);
  const logPath = path.join(logDir, `${task.id}.log`);

  return schtasksTemplate
    .replaceAll("{{TASK_ID}}", escapeXml(task.id))
    .replaceAll("{{FOLDER}}", escapeXml(folder))
    .replace("{{TRIGGER_XML}}", triggerXml)
    .replace("{{ENABLED}}", task.enabled ? "true" : "false")
    .replace("{{COMMAND}}", escapeXml(command))
    .replace("{{ARGS}}", escapeXml(args))
    .replace("{{LOG_PATH}}", escapeXml(logPath));
}

function renderSchtasksTrigger(trigger: SchtasksTrigger, startBoundary: string): string {
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
  // Rewrite the time component of an ISO-8601 boundary while preserving
  // the date so daily/weekly triggers fire at the configured wall-clock
  // time rather than the install instant.
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return base.replace(/T\d\d:\d\d:\d\d$/, `T${hh}:${mm}:00`);
}

function formatStartBoundary(d: Date): string {
  // Local-time ISO-8601 (no zone suffix) — Task Scheduler interprets a
  // bare boundary in the registering user's timezone, which matches what
  // a user typing "0 9 * * *" intuitively means ("9am local").
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
}

function quoteArg(s: string): string {
  if (/^[A-Za-z0-9_\-./@:%=+,\\]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function defaultSchtasksExec(): SchtasksExec {
  return {
    run(args: string[]) {
      return spawnCommand(args);
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
    ensureDir(dir) {
      fs.mkdirSync(dir, { recursive: true });
    },
    tmpdir() {
      return os.tmpdir();
    },
  };
}
