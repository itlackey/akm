// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * schtasks.exe backend for `akm task` (Windows default).
 *
 * Each task is registered under the `\akm\` Task Scheduler folder so the
 * backend never touches user-managed tasks. The full task definition is
 * sent through `schtasks /Create /TN \akm\<id> /XML <path> /F` so we can
 * express triggers/principals/actions without quoting hell.
 *
 * Platform notes:
 *   • `LogonType=InteractiveToken` means the task runs in the context of
 *     the registering user only when they are logged in — there is no
 *     stored password and the task will not fire at the lock screen.
 *   • `<Principal>` records the current user SID; it is part of the
 *     fingerprint in `<Source>`, so a sync run by another user re-registers
 *     the task under that user.
 *   • `<DisallowStartIfOnBatteries>false</…>` and `<StopIfGoingOnBatteries>
 *     false</…>` allow the task to run on battery.
 *   • `MultipleInstancesPolicy=IgnoreNew` makes overlapping triggers safe.
 *   • `/Query /FO CSV /NH` (without `/V`) outputs three columns:
 *     `TaskName,Next Run Time,Status` — so the regex anchors on the task
 *     name as the leading quoted field.
 *   • Task Scheduler runs a task with the account's own environment, so
 *     PATH is not carried anywhere; the descriptor holds directories only.
 *
 * Tests inject a fake exec + filesystem.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import schtasksTemplate from "../../assets/backends/schtasks-template.xml" with { type: "text" };
import { ConfigError } from "../../core/errors";
import { getTaskLogDir } from "../../core/paths";
import { resolveAkmInvocation } from "../resolve-akm-bin";
import { parseSchedule, type SchtasksTrigger, translateToSchtasks } from "../schedule";
import { type SchedulerBinding, schedulerBindingNativeId, schedulerLogicalBindingId } from "../scheduler-binding";
import {
  buildScheduledBindingInvocation,
  type ParsedScheduledBindingInvocation,
  parseScheduledBindingArgv,
  resolveScheduledTaskContext,
  type ScheduledTaskContext,
  schedulerContextDescriptor,
  schedulerContextPath,
} from "../scheduler-invocation";
import {
  type BackendExec,
  escapeXml,
  type NodeFs,
  nodeExec,
  nodeFs,
  normalizeXmlForUtf16File,
  runOrThrow,
} from "./exec-utils";
import type { InstalledSchedulerBinding, SchedulerBackend } from "./types";

export type SchtasksExec = BackendExec;

export type SchtasksFs = NodeFs & {
  removeFile(file: string): void;
  tmpdir(): string;
};

export interface SchtasksBackendOptions {
  exec?: SchtasksExec;
  fs?: SchtasksFs;
  /** Override the akm invocation argv. */
  akmArgv?: string[];
  /** Override the absolute log directory. */
  logDir?: string;
  /** Folder prefix for task names. Default `\akm\`. */
  folderPrefix?: string;
  /** Override the resolved non-secret AKM directory context. */
  scheduledContext?: ScheduledTaskContext;
  /** Override the current Windows user SID (tests). */
  userSid?: string;
}

export const DEFAULT_FOLDER_PREFIX = "\\akm\\";
const SIGNATURE_PREFIX = "akm:v1:";

export function SCHTASKS_BACKEND(options: SchtasksBackendOptions = {}): SchedulerBackend {
  const exec = options.exec ?? nodeExec();
  const fsLike = options.fs ?? defaultSchtasksFs();
  const akmArgv = options.akmArgv ?? resolveAkmInvocation().argv;
  const logDir = options.logDir ?? getTaskLogDir();
  const folder = options.folderPrefix ?? DEFAULT_FOLDER_PREFIX;
  const scheduledContext = options.scheduledContext ?? resolveScheduledTaskContext();
  const defaultContextPath = schedulerContextPath(schedulerContextDescriptor(scheduledContext));
  const userSid = options.userSid ?? resolveCurrentUserSid(exec);
  const taskName = (nativeId: string) => `${folder}${nativeId}`;
  const xmlFor = (task: SchedulerBinding, opts?: { binding?: readonly string[]; contextPath?: string }) =>
    buildSchtasksXml(task, akmArgv, logDir, {
      folderPrefix: folder,
      contextPath: opts?.contextPath ?? defaultContextPath,
      userSid,
      binding: [...(opts?.binding ?? akmArgv)],
    });
  const queryXml = (nativeId: string) =>
    runOrThrow(exec, ["schtasks", "/Query", "/TN", taskName(nativeId), "/XML"], {
      message: (result) =>
        `schtasks /Query /XML for "${taskName(nativeId)}" failed (exit ${result.status}): ${result.stderr || result.stdout || "no output"}.`,
    }).stdout;

  return {
    name: "schtasks",
    install(task, opts) {
      const xml = normalizeXmlForUtf16File(xmlFor(task, opts));
      const nativeId = schedulerBindingNativeId(task);
      fsLike.ensureDir(logDir);
      const tmpFile = path.join(fsLike.tmpdir(), `akm-task-${nativeId}-${Date.now()}.xml`);
      fsLike.writeFile(tmpFile, xml);
      try {
        // /F forces overwrite if a task with the same name exists.
        runOrThrow(exec, ["schtasks", "/Create", "/TN", taskName(nativeId), "/XML", tmpFile, "/F"], {
          message: (r) => `schtasks /Create failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
        });
        if (!task.enabled) {
          runOrThrow(exec, ["schtasks", "/Change", "/TN", taskName(nativeId), "/DISABLE"], {
            message: (r) => `schtasks /Change /DISABLE failed: ${r.stderr || r.stdout || "no output"}.`,
          });
        }
      } finally {
        fsLike.removeFile(tmpFile);
      }
    },
    uninstall(nativeId) {
      runOrThrow(exec, ["schtasks", "/Delete", "/TN", taskName(nativeId), "/F"], {
        isOk: (r) => r.status === 0 || isMissingTaskResult(r),
        message: (r) => `schtasks /Delete failed: ${r.stderr || r.stdout || "no output"}.`,
      });
    },
    setEnabled(nativeId, enabled) {
      const flag = enabled ? "/ENABLE" : "/DISABLE";
      runOrThrow(exec, ["schtasks", "/Change", "/TN", taskName(nativeId), flag], {
        message: (r) => `schtasks /Change ${flag} failed: ${r.stderr || r.stdout || "no output"}.`,
      });
    },
    list() {
      const listing = runOrThrow(exec, ["schtasks", "/Query", "/FO", "CSV", "/NH"], {
        message: (result) =>
          `schtasks /Query failed (exit ${result.status}): ${result.stderr || result.stdout || "no output"}.`,
      });
      const rows: InstalledSchedulerBinding[] = [];
      for (const line of (listing.stdout ?? "").split(/\r?\n/)) {
        const name = line.match(/^"([^"]+)",/)?.[1];
        if (!name?.startsWith(folder)) continue;
        const nativeId = name.slice(folder.length);
        const xml = queryXml(nativeId);
        const parsed = extractSchtasksInvocation(xml);
        if (!parsed) continue;
        rows.push({
          id: schedulerLogicalBindingId(nativeId, parsed.invocation),
          nativeId,
          enabled: taskXmlEnabled(xml),
          signature: taskXmlSignature(xml),
          ...(parsed.target !== undefined ? { target: parsed.target } : {}),
          binding: parsed.binding,
          contextPath: parsed.contextPath,
          invocation: parsed.invocation,
        });
      }
      return rows;
    },
    expectedSignature(task, opts) {
      return taskXmlSignature(xmlFor(task, opts));
    },
  };
}

/** The `--bundle <bundle>` token of an installed Task Scheduler definition; undefined for the primary form. */
export function extractSchtasksTarget(xml: string): string | undefined {
  return extractSchtasksInvocation(xml)?.target;
}

export function extractSchtasksInvocation(xml: string): ParsedScheduledBindingInvocation | undefined {
  const argsElement = xml.match(/<(?:[\w.-]+:)?Arguments>([\s\S]*?)<\/(?:[\w.-]+:)?Arguments>/i);
  if (!argsElement) return undefined;
  const commandLine = decodeXml(argsElement[1]!);
  const invocationStart = findPowerShellInvocationOperator(commandLine);
  if (invocationStart === undefined) return undefined;
  return parseScheduledBindingArgv(parsePowerShellSingleQuotedArgs(commandLine, invocationStart + 1));
}

function findPowerShellInvocationOperator(script: string): number | undefined {
  let inSingleQuote = false;
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index];
    if (char === "'") {
      if (inSingleQuote && script[index + 1] === "'") index += 1;
      else inSingleQuote = !inSingleQuote;
      continue;
    }
    if (!inSingleQuote && char === "&" && /\s/.test(script[index + 1] ?? "")) return index;
  }
  return undefined;
}

function parsePowerShellSingleQuotedArgs(script: string, start: number): string[] {
  const argv: string[] = [];
  let index = start;
  while (index < script.length) {
    while (/\s/.test(script[index] ?? "")) index += 1;
    if (script[index] === ";" || script[index] === '"' || index >= script.length) break;
    if (script[index] !== "'") return [];
    index += 1;
    let value = "";
    let closed = false;
    while (index < script.length) {
      const char = script[index];
      if (char !== "'") {
        value += char;
        index += 1;
        continue;
      }
      if (script[index + 1] === "'") {
        value += "'";
        index += 2;
        continue;
      }
      index += 1;
      closed = true;
      break;
    }
    if (!closed) return [];
    argv.push(value);
  }
  return argv;
}

// ── XML builder (exported for tests) ────────────────────────────────────────

export interface BuildSchtasksXmlOptions {
  /** Task folder prefix (e.g. `\\akm\\`). Used to build the <URI>. */
  folderPrefix?: string;
  /** Override the clock used to find the next StartBoundary (tests). */
  now?: () => Date;
  /** Immutable runtime context descriptor loaded by the launcher. */
  contextPath: string;
  /** Bootstrap argv. Defaults to the positional akmArgv. */
  binding?: string[];
  /** Current Windows user SID embedded in the principal. */
  userSid: string;
}

export function buildSchtasksXml(
  task: SchedulerBinding,
  akmArgv: string[],
  logDir: string,
  options: BuildSchtasksXmlOptions,
): string {
  const folder = options.folderPrefix ?? DEFAULT_FOLDER_PREFIX;
  const now = options.now ? options.now() : new Date();
  const trigger = translateToSchtasks(parseSchedule(task.cron, "schtasks"));
  const invocation = buildScheduledBindingInvocation(options.binding ?? akmArgv, options.contextPath, task.invocation);
  const script = `& ${invocation.argv.map((arg) => quotePowerShell(arg)).join(" ")}; exit $LASTEXITCODE`;
  const command = "powershell.exe";
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script].map(quoteArg).join(" ");
  const nativeId = schedulerBindingNativeId(task);
  const logPath = path.join(logDir, `${nativeId}.log`);
  // The boundary changes on reinstall, and enabled state can change via
  // /Change. Keep both outside the stored definition fingerprint so no-op
  // sync stays stable.
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ folder, id: nativeId, trigger, command, args, logPath, userSid: options.userSid }))
    .digest("hex");

  return schtasksTemplate
    .replaceAll("{{TASK_ID}}", escapeXml(nativeId))
    .replaceAll("{{FOLDER}}", escapeXml(folder))
    .replace("{{SIGNATURE}}", `${SIGNATURE_PREFIX}${fingerprint}`)
    .replace("{{TRIGGER_XML}}", renderSchtasksTrigger(trigger, now))
    .replace('<Principal id="Author">', `<Principal id="Author">\n      <UserId>${escapeXml(options.userSid)}</UserId>`)
    .replace("{{ENABLED}}", task.enabled ? "true" : "false")
    .replace("{{COMMAND}}", escapeXml(command))
    .replace("{{ARGS}}", escapeXml(args))
    .replace("{{LOG_PATH}}", escapeXml(logPath));
}

interface NativeDailyTrigger {
  kind: "daily";
  atHour: number;
  atMinute: number;
  repeatEveryMinutes?: number;
}

interface NativeWeeklyTrigger {
  kind: "weekly";
  atHour: number;
  atMinute: number;
  daysOfWeek: number[];
}

interface NativeMonthlyTrigger {
  kind: "monthly";
  atHour: number;
  atMinute: number;
  daysOfMonth: number[];
  months: number[];
}

type NativeSchtasksTrigger = NativeDailyTrigger | NativeWeeklyTrigger | NativeMonthlyTrigger;

function renderSchtasksTrigger(trigger: SchtasksTrigger, now: Date): string {
  return expandNativeTriggers(trigger)
    .map((native) => renderNativeTrigger(native, formatStartBoundary(nextStartBoundary(native, now))))
    .join("\n");
}

function expandNativeTriggers(trigger: SchtasksTrigger): NativeSchtasksTrigger[] {
  switch (trigger.kind) {
    case "minute":
      return [{ kind: "daily", atHour: 0, atMinute: 0, repeatEveryMinutes: trigger.everyMinutes }];
    case "minuteValues":
      return trigger.minutes.map((atMinute) => ({ kind: "daily", atHour: 0, atMinute, repeatEveryMinutes: 60 }));
    case "hour":
      return [{ kind: "daily", atHour: 0, atMinute: trigger.atMinute, repeatEveryMinutes: trigger.everyHours * 60 }];
    case "hourValues":
      return trigger.hours.map((atHour) => ({ kind: "daily", atHour, atMinute: trigger.atMinute }));
    case "daily":
      return [{ kind: "daily", atHour: trigger.atHour, atMinute: trigger.atMinute }];
    case "weekly":
      return [trigger];
    case "monthly":
      return [trigger];
  }
}

function renderNativeTrigger(trigger: NativeSchtasksTrigger, startBoundary: string): string {
  if (trigger.kind === "daily") {
    const repetition =
      trigger.repeatEveryMinutes === undefined
        ? ""
        : `      <Repetition>
        <Interval>${formatMinuteDuration(trigger.repeatEveryMinutes)}</Interval>
        <Duration>${formatMinuteDuration(24 * 60 - trigger.repeatEveryMinutes)}</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
`;
    return `    <CalendarTrigger>
${repetition}      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>`;
  }

  if (trigger.kind === "weekly") {
    const dayMap = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const days = trigger.daysOfWeek.map((d) => `        <${dayMap[d]} />`).join("\n");
    return `    <CalendarTrigger>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByWeek>
        <DaysOfWeek>
${days}
        </DaysOfWeek>
        <WeeksInterval>1</WeeksInterval>
      </ScheduleByWeek>
    </CalendarTrigger>`;
  }

  const monthMap = [
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
  ];
  const days = trigger.daysOfMonth.map((d) => `          <Day>${d}</Day>`).join("\n");
  const months = trigger.months.map((m) => `        <${monthMap[m - 1]} />`).join("\n");
  return `    <CalendarTrigger>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByMonth>
        <DaysOfMonth>
${days}
        </DaysOfMonth>
        <Months>
${months}
        </Months>
      </ScheduleByMonth>
    </CalendarTrigger>`;
}

function formatMinuteDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `PT${hours > 0 ? `${hours}H` : ""}${remainingMinutes > 0 ? `${remainingMinutes}M` : ""}`;
}

function nextStartBoundary(trigger: NativeSchtasksTrigger, now: Date): Date {
  const boundary = new Date(now.getTime());
  switch (trigger.kind) {
    case "daily":
      boundary.setHours(trigger.atHour, trigger.atMinute, 0, 0);
      if (trigger.repeatEveryMinutes !== undefined) {
        while (boundary.getTime() <= now.getTime()) {
          boundary.setMinutes(boundary.getMinutes() + trigger.repeatEveryMinutes);
        }
      } else if (boundary.getTime() <= now.getTime()) {
        boundary.setDate(boundary.getDate() + 1);
      }
      return boundary;
    case "weekly":
      boundary.setHours(trigger.atHour, trigger.atMinute, 0, 0);
      while (!trigger.daysOfWeek.includes(boundary.getDay()) || boundary.getTime() <= now.getTime()) {
        boundary.setDate(boundary.getDate() + 1);
        boundary.setHours(trigger.atHour, trigger.atMinute, 0, 0);
      }
      return boundary;
    case "monthly": {
      boundary.setHours(trigger.atHour, trigger.atMinute, 0, 0);
      const daysOfMonth = new Set(trigger.daysOfMonth);
      const months = new Set(trigger.months);
      for (let guard = 0; guard < 4000; guard++) {
        if (
          daysOfMonth.has(boundary.getDate()) &&
          months.has(boundary.getMonth() + 1) &&
          boundary.getTime() > now.getTime()
        ) {
          break;
        }
        boundary.setDate(boundary.getDate() + 1);
        boundary.setHours(trigger.atHour, trigger.atMinute, 0, 0);
      }
      return boundary;
    }
  }
}

function formatStartBoundary(d: Date): string {
  // Local-time ISO-8601 (no zone suffix) — Task Scheduler interprets a bare
  // boundary in the registering user's timezone, which matches what a user
  // typing "0 9 * * *" means ("9am local").
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function quoteArg(s: string): string {
  if (/^[A-Za-z0-9_\-./@:%=+,\\]+$/.test(s)) return s;
  // CommandLineToArgvW requires backslashes before quotes (including the
  // closing quote) to be doubled so they survive as literal backslashes.
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isMissingTaskResult(result: { stdout: string; stderr: string }): boolean {
  return /cannot find|not found/i.test(`${result.stderr ?? ""}\n${result.stdout ?? ""}`);
}

// ── Installed-definition signature ──────────────────────────────────────────
//
// Task Scheduler rewrites a registered definition (schema defaults filled in,
// StartBoundary moved on), so a row is compared by the fingerprint akm stamps
// into `<Source>` — everything it renders except the enabled state — plus the
// enabled state `/Change` toggles. A task edited in Task Scheduler that keeps
// that fingerprint is left as it is.

function taskXmlSignature(xml: string): string {
  const source = xml.match(/<(?:[\w.-]+:)?Source>([^<]*)<\//i)?.[1]?.trim() ?? "";
  return `${decodeXml(source)}|enabled=${taskXmlEnabled(xml)}`;
}

function taskXmlEnabled(xml: string): boolean {
  const settings = xml.match(/<(?:[\w.-]+:)?Settings>([\s\S]*?)<\/(?:[\w.-]+:)?Settings>/i)?.[1] ?? "";
  const value = settings.match(/<(?:[\w.-]+:)?Enabled>\s*([^<]*?)\s*<\//i)?.[1]?.toLowerCase();
  return value !== "false" && value !== "0";
}

function decodeXml(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos);/gi, (entity, decimal, hex) => {
    if (decimal !== undefined) return String.fromCodePoint(Number(decimal));
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
    switch (entity.toLowerCase()) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      default:
        return entity;
    }
  });
}

function resolveCurrentUserSid(exec: SchtasksExec): string {
  const result = runOrThrow(exec, ["whoami", "/user", "/fo", "csv", "/nh"], {
    message: (r) => `whoami /user failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
  });
  const match = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/\bS-\d+(?:-\d+){2,}\b/i);
  if (!match) throw new ConfigError("whoami /user returned no Windows user SID.", "INVALID_CONFIG_FILE");
  return `S${match[0].slice(1)}`;
}

function defaultSchtasksFs(): SchtasksFs {
  return {
    ...nodeFs(),
    writeFile(file, content) {
      fs.writeFileSync(file, `﻿${content}`, { encoding: "utf16le" });
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
