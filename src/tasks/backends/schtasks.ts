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
 *   • `<Principal>` records the current user SID so sync can detect identity
 *     drift instead of silently accepting a task registered to another user.
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

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import schtasksTemplate from "../../assets/backends/schtasks-template.xml" with { type: "text" };
import { ConfigError } from "../../core/errors";
import { getTaskLogDir } from "../../core/paths";
import { resolveAkmInvocation } from "../resolve-akm-bin";
import { parseSchedule, type SchtasksTrigger, translateToSchtasks } from "../schedule";
import {
  buildScheduledTaskInvocation,
  resolveScheduledTaskContext,
  type ScheduledTaskContext,
} from "../scheduler-invocation";
import type { TaskDocument } from "../schema";
import { escapeXml, nodeExec, nodeFs, normalizeXmlForUtf8File } from "./exec-utils";
import type { InstalledTaskRef, TaskBackend } from "./index";

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
  /** Override the resolved non-secret AKM directory context. */
  scheduledContext?: ScheduledTaskContext;
  /** Override the current Windows user SID (tests). */
  userSid?: string;
}

export const DEFAULT_FOLDER_PREFIX = "\\akm\\";
const SIGNATURE_PREFIX = "akm:v1:";

export function SCHTASKS_BACKEND(options: SchtasksBackendOptions = {}): TaskBackend {
  const exec = options.exec ?? defaultSchtasksExec();
  const fsLike = options.fs ?? defaultSchtasksFs();
  const akmArgv = options.akmArgv ?? resolveAkmInvocation().argv;
  const logDir = options.logDir ?? getTaskLogDir();
  const folder = options.folderPrefix ?? DEFAULT_FOLDER_PREFIX;
  const scheduledContext = options.scheduledContext ?? resolveScheduledTaskContext();
  const userSid = options.userSid ?? resolveCurrentUserSid(exec);
  const taskName = (id: string) => `${folder}${id}`;

  return {
    name: "schtasks",
    install(task: TaskDocument) {
      const xml = normalizeXmlForUtf8File(
        buildSchtasksXml(task, akmArgv, logDir, { folderPrefix: folder, scheduledContext, userSid }),
      );
      const query = exec.run(["schtasks", "/Query", "/TN", taskName(task.id), "/XML"]);
      let previous: { xml: string; enabled: boolean } | undefined;
      if (query.status === 0) {
        const enabled = taskXmlEnabled(query.stdout);
        if (enabled === undefined) {
          throw new ConfigError(
            `schtasks /Query returned an unreadable definition for "${taskName(task.id)}"; refusing to replace it.`,
            "INVALID_CONFIG_FILE",
          );
        }
        previous = { xml: normalizeXmlForUtf8File(query.stdout), enabled };
      } else if (!isMissingTaskResult(query)) {
        throw new ConfigError(
          `schtasks /Query failed (exit ${query.status}): ${query.stderr || query.stdout || "no output"}.`,
          "INVALID_CONFIG_FILE",
        );
      }
      fsLike.ensureDir(logDir);
      const tmpFile = path.join(fsLike.tmpdir(), `akm-task-${task.id}-${Date.now()}.xml`);
      fsLike.writeFile(tmpFile, xml);
      try {
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
        } catch (err) {
          const rollbackErrors: unknown[] = [];
          if (previous === undefined) {
            try {
              const remove = exec.run(["schtasks", "/Delete", "/TN", taskName(task.id), "/F"]);
              if (remove.status !== 0 && !isMissingTaskResult(remove)) {
                rollbackErrors.push(
                  new ConfigError(
                    `schtasks /Delete during rollback failed: ${remove.stderr || remove.stdout || "no output"}.`,
                    "INVALID_CONFIG_FILE",
                  ),
                );
              }
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          } else {
            try {
              fsLike.writeFile(tmpFile, previous.xml);
              const restore = exec.run(["schtasks", "/Create", "/TN", taskName(task.id), "/XML", tmpFile, "/F"]);
              if (restore.status !== 0) {
                throw new ConfigError(
                  `schtasks /Create during rollback failed: ${restore.stderr || restore.stdout || "no output"}.`,
                  "INVALID_CONFIG_FILE",
                );
              }
              const stateFlag = previous.enabled ? "/ENABLE" : "/DISABLE";
              const state = exec.run(["schtasks", "/Change", "/TN", taskName(task.id), stateFlag]);
              if (state.status !== 0) {
                throw new ConfigError(
                  `schtasks /Change ${stateFlag} during rollback failed: ${state.stderr || state.stdout || "no output"}.`,
                  "INVALID_CONFIG_FILE",
                );
              }
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          }
          if (rollbackErrors.length > 0) {
            const message = err instanceof Error ? err.message : String(err);
            throw new AggregateError(
              [err, ...rollbackErrors],
              `${message}; rollback for Task Scheduler task "${task.id}" was incomplete.`,
            );
          }
          throw err;
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
      if (r.status !== 0) {
        throw new ConfigError(
          `schtasks /Query failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
          "INVALID_CONFIG_FILE",
        );
      }
      const ids: string[] = [];
      for (const line of (r.stdout ?? "").split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)",/);
        if (!m) continue;
        const name = m[1];
        if (name.startsWith(folder)) {
          ids.push(name.slice(folder.length));
        }
      }
      return ids.map((id) => {
        const query = exec.run(["schtasks", "/Query", "/TN", taskName(id), "/XML"]);
        if (query.status !== 0) {
          throw new ConfigError(
            `schtasks /Query /XML for "${taskName(id)}" failed (exit ${query.status}): ${query.stderr || query.stdout || "no output"}.`,
            "INVALID_CONFIG_FILE",
          );
        }
        const signature = installedSignature(query.stdout);
        return signature === undefined ? { id } : { id, signature };
      });
    },
    expectedSignature(task: TaskDocument): string {
      const signature = taskXmlSignature(
        buildSchtasksXml(task, akmArgv, logDir, { folderPrefix: folder, scheduledContext, userSid }),
      );
      if (signature === undefined) throw new Error("Failed to fingerprint generated Task Scheduler XML.");
      return signature;
    },
  };
}

// ── XML builder (exported for tests) ────────────────────────────────────────

export interface BuildSchtasksXmlOptions {
  /** Task folder prefix (e.g. `\\akm\\`). Used to build the <URI>. */
  folderPrefix?: string;
  /** Override the clock used to find the next StartBoundary (tests). */
  now?: () => Date;
  /** Resolved non-secret AKM directory context embedded in the invocation. */
  scheduledContext: ScheduledTaskContext;
  /** Current Windows user SID embedded in the principal. */
  userSid: string;
}

interface SchtasksDefinition {
  trigger: SchtasksTrigger;
  command: string;
  args: string;
  logPath: string;
  signature: string;
}

export function buildSchtasksXml(
  task: TaskDocument,
  akmArgv: string[],
  logDir: string,
  options: BuildSchtasksXmlOptions,
): string {
  const folder = options.folderPrefix ?? DEFAULT_FOLDER_PREFIX;
  const now = options.now ? options.now() : new Date();
  const definition = buildSchtasksDefinition(task, akmArgv, logDir, folder, options.scheduledContext, options.userSid);
  const triggerXml = renderSchtasksTrigger(definition.trigger, now);

  return schtasksTemplate
    .replaceAll("{{TASK_ID}}", escapeXml(task.id))
    .replaceAll("{{FOLDER}}", escapeXml(folder))
    .replace("{{SIGNATURE}}", definition.signature)
    .replace("{{TRIGGER_XML}}", triggerXml)
    .replace('<Principal id="Author">', `<Principal id="Author">\n      <UserId>${escapeXml(options.userSid)}</UserId>`)
    .replace("{{ENABLED}}", task.enabled ? "true" : "false")
    .replace("{{COMMAND}}", escapeXml(definition.command))
    .replace("{{ARGS}}", escapeXml(definition.args))
    .replace("{{LOG_PATH}}", escapeXml(definition.logPath));
}

function buildSchtasksDefinition(
  task: TaskDocument,
  akmArgv: string[],
  logDir: string,
  folder: string,
  scheduledContext: ScheduledTaskContext,
  userSid: string,
): SchtasksDefinition {
  const spec = parseSchedule(task.schedule, "schtasks");
  const trigger = translateToSchtasks(spec);
  const invocation = buildScheduledTaskInvocation(akmArgv, task.id, scheduledContext);
  const environment = Object.entries(invocation.environment)
    .map(([key, value]) => `$env:${key}=${quotePowerShell(value)}`)
    .join("; ");
  const invoke = `& ${invocation.argv.map((arg) => quotePowerShell(arg)).join(" ")}`;
  const script = `${environment}; ${invoke}; exit $LASTEXITCODE`;
  const command = "powershell.exe";
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script].map(quoteArg).join(" ");
  const logPath = path.join(logDir, `${task.id}.log`);
  // The boundary changes on reinstall, and enabled state can change via /Change.
  // Keep both outside the stored definition fingerprint so no-op sync stays stable.
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ folder, id: task.id, trigger, command, args, logPath, userSid }))
    .digest("hex");
  return { trigger, command, args, logPath, signature: `${SIGNATURE_PREFIX}${fingerprint}` };
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

type NativeSchtasksTrigger = NativeDailyTrigger | NativeWeeklyTrigger;

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
      return [
        {
          kind: "daily",
          atHour: 0,
          atMinute: trigger.atMinute,
          repeatEveryMinutes: trigger.everyHours * 60,
        },
      ];
    case "hourValues":
      return trigger.hours.map((atHour) => ({ kind: "daily", atHour, atMinute: trigger.atMinute }));
    case "daily":
      return [{ kind: "daily", atHour: trigger.atHour, atMinute: trigger.atMinute }];
    case "weekly":
      return [trigger];
  }
}

function renderNativeTrigger(trigger: NativeSchtasksTrigger, startBoundary: string): string {
  if (trigger.kind === "daily") {
    const repetition =
      trigger.repeatEveryMinutes === undefined
        ? ""
        : `      <Repetition>
        <Interval>${formatRepetitionInterval(trigger.repeatEveryMinutes)}</Interval>
        <Duration>${formatRepetitionDuration(trigger.repeatEveryMinutes)}</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
`;
    return `    <CalendarTrigger>
${repetition}      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>`;
  }

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

function formatRepetitionInterval(minutes: number): string {
  return formatMinuteDuration(minutes);
}

function formatRepetitionDuration(intervalMinutes: number): string {
  return formatMinuteDuration(24 * 60 - intervalMinutes);
}

function formatMinuteDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const hourPart = hours > 0 ? `${hours}H` : "";
  const minutePart = remainingMinutes > 0 ? `${remainingMinutes}M` : "";
  return `PT${hourPart}${minutePart}`;
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
  }
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
  // CommandLineToArgvW requires backslashes before quotes (including the
  // closing quote) to be doubled so they survive as literal backslashes.
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function installedSignature(xml: string): string | undefined {
  return taskXmlSignature(xml);
}

function isMissingTaskResult(result: { stdout: string; stderr: string }): boolean {
  return /cannot find|not found/i.test(`${result.stderr ?? ""}\n${result.stdout ?? ""}`);
}

interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: Array<XmlElement | string>;
}

function taskXmlSignature(xml: string): string | undefined {
  try {
    const document = parseXml(xml);
    const task = findChild(document, "Task");
    const triggers = findChild(task, "Triggers");
    const principals = findChild(task, "Principals");
    const settings = findChild(task, "Settings");
    const actions = findChild(task, "Actions");
    if (!triggers || !principals || !settings || !actions) return undefined;

    normalizeTriggerBoundaries(triggers);
    normalizeNativeDefaults(triggers, settings);
    const enabledElement = findChild(settings, "Enabled");
    const enabledValue = enabledElement ? elementText(enabledElement).toLowerCase() : undefined;
    const enabled = enabledValue === undefined || enabledValue === "true" || enabledValue === "1";
    // Enabled is represented explicitly in the signature suffix. Removing it
    // here also treats an omitted Enabled element as its schema default, true.
    settings.children = settings.children.filter(
      (child) => typeof child === "string" || child.name.toLowerCase() !== "enabled",
    );

    const canonical = [triggers, principals, settings, actions].map(canonicalXmlElement).join("\n");
    const fingerprint = createHash("sha256").update(canonical).digest("hex");
    return signatureWithEnabled(`${SIGNATURE_PREFIX}${fingerprint}`, enabled);
  } catch {
    return undefined;
  }
}

function taskXmlEnabled(xml: string): boolean | undefined {
  try {
    const document = parseXml(xml);
    const settings = findChild(findChild(document, "Task"), "Settings");
    if (!settings) return undefined;
    const enabledElement = findChild(settings, "Enabled");
    if (!enabledElement) return true;
    const enabled = elementText(enabledElement).toLowerCase();
    if (enabled === "true" || enabled === "1") return true;
    if (enabled === "false" || enabled === "0") return false;
    return undefined;
  } catch {
    return undefined;
  }
}

function parseXml(xml: string): XmlElement {
  const document: XmlElement = { name: "#document", attributes: {}, children: [] };
  const stack = [document];
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]+>|[^<]+/g) ?? [];

  for (const token of tokens) {
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("</")) {
      if (stack.length === 1) throw new Error("Unexpected XML closing tag.");
      const closingName = localXmlName(token.slice(2, -1).trim());
      const current = stack.pop();
      if (current?.name !== closingName) throw new Error("Mismatched XML closing tag.");
      continue;
    }
    if (token.startsWith("<")) {
      const selfClosing = /\/\s*>$/.test(token);
      const match = token.match(/^<\s*([^\s/>]+)([\s\S]*?)\/?\s*>$/);
      if (!match) throw new Error("Invalid XML opening tag.");
      const element: XmlElement = {
        name: localXmlName(match[1]),
        attributes: parseXmlAttributes(match[2]),
        children: [],
      };
      stack[stack.length - 1].children.push(element);
      if (!selfClosing) stack.push(element);
      continue;
    }

    const text = decodeXml(token.trim());
    if (text.length > 0) stack[stack.length - 1].children.push(text);
  }

  if (stack.length !== 1) throw new Error("Unclosed XML tag.");
  return document;
}

function parseXmlAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of raw.matchAll(pattern)) {
    const name = localXmlName(match[1]);
    if (match[1] === "xmlns" || match[1].startsWith("xmlns:")) continue;
    attributes[name] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

function localXmlName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
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

function findChild(parent: XmlElement | undefined, name: string): XmlElement | undefined {
  return parent?.children.find(
    (child): child is XmlElement => typeof child !== "string" && child.name.toLowerCase() === name.toLowerCase(),
  );
}

function elementText(element: XmlElement): string {
  return element.children.filter((child): child is string => typeof child === "string").join("");
}

function normalizeTriggerBoundaries(triggers: XmlElement): void {
  for (const trigger of triggers.children) {
    if (typeof trigger === "string") continue;
    const boundary = findChild(trigger, "StartBoundary");
    if (!boundary) continue;
    const time = elementText(boundary).match(/T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?/);
    if (!time) continue;

    const secondsSinceMidnight = Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]);
    const interval = findChild(findChild(trigger, "Repetition"), "Interval");
    const intervalSeconds = interval ? parseIsoDurationSeconds(elementText(interval)) : undefined;
    boundary.children = [
      intervalSeconds === undefined
        ? `dynamic-date;time=${time[1]}:${time[2]}:${time[3]}`
        : `dynamic-cycle;phase-seconds=${secondsSinceMidnight % intervalSeconds}`,
    ];
  }
}

const MATERIALIZED_SETTING_DEFAULTS: Record<string, string> = {
  allowstartondemand: "true",
  allowhardterminate: "true",
  startwhenavailable: "false",
  runonlyifnetworkavailable: "false",
  hidden: "false",
  runonlyifidle: "false",
  waketorun: "false",
  executiontimelimit: "PT72H",
  priority: "7",
  compatibility: "Vista",
  useunifiedschedulingengine: "false",
  disallowstartonremoteappsession: "false",
  volatile: "false",
};

const MATERIALIZED_IDLE_DEFAULTS: Record<string, string> = {
  duration: "PT10M",
  waittimeout: "PT1H",
  stoponidleend: "true",
  restartonidle: "false",
};

function normalizeNativeDefaults(triggers: XmlElement, settings: XmlElement): void {
  settings.children = settings.children.filter((child) => {
    if (typeof child === "string") return true;
    const name = child.name.toLowerCase();
    if (name === "idlesettings") return !containsOnlyDefaults(child, MATERIALIZED_IDLE_DEFAULTS);
    const defaultValue = MATERIALIZED_SETTING_DEFAULTS[name];
    return defaultValue === undefined || elementText(child) !== defaultValue;
  });

  for (const trigger of elementChildren(triggers)) {
    trigger.children = trigger.children.filter((child) => {
      if (typeof child === "string") return true;
      return child.name.toLowerCase() !== "executiontimelimit" || elementText(child) !== "PT72H";
    });
  }
}

function resolveCurrentUserSid(exec: SchtasksExec): string {
  const result = exec.run(["whoami", "/user", "/fo", "csv", "/nh"]);
  if (result.status !== 0) {
    throw new ConfigError(
      `whoami /user failed (exit ${result.status}): ${result.stderr || result.stdout || "no output"}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const match = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/\bS-\d+(?:-\d+){2,}\b/i);
  if (!match) {
    throw new ConfigError("whoami /user returned no Windows user SID.", "INVALID_CONFIG_FILE");
  }
  return `S${match[0].slice(1)}`;
}

function elementChildren(element: XmlElement): XmlElement[] {
  return element.children.filter((child): child is XmlElement => typeof child !== "string");
}

function containsOnlyDefaults(element: XmlElement, defaults: Record<string, string>): boolean {
  const children = elementChildren(element);
  return (
    children.length > 0 &&
    children.length === element.children.length &&
    children.every((child) => defaults[child.name.toLowerCase()] === elementText(child))
  );
}

function parseIsoDurationSeconds(value: string): number | undefined {
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return undefined;
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return seconds > 0 ? seconds : undefined;
}

function canonicalXmlElement(element: XmlElement): string {
  const attributes = Object.entries(element.attributes).sort(([a], [b]) => a.localeCompare(b));
  const children = element.children.map((child) =>
    typeof child === "string" ? ["text", child] : ["element", canonicalXmlElement(child)],
  );
  children.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([element.name, attributes, children]);
}

function signatureWithEnabled(signature: string, enabled: boolean): string {
  return `${signature}|enabled=${enabled ? "true" : "false"}`;
}

function defaultSchtasksExec(): SchtasksExec {
  return nodeExec();
}

function defaultSchtasksFs(): SchtasksFs {
  return {
    ...nodeFs(),
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
