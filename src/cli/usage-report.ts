// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The daily usage report: at most once per surface (`cli`, `desktop`) per UTC day, to the owner's self-hosted
 * Aptabase. Each surface sends one `<surface>_daily` event (what is set up, how big the library is), and the CLI
 * one event per command that ran (`akm task run`) with its counts.
 *
 * What may be sent is decided here and nowhere else. Every prop value is a number. Every event name and prop key is
 * built from akm's own definitions: its command tree, its declared flags and their closed value lists, its harness
 * ids, sources, outcome categories and asset types. A name akm did not define (an asset's input, a custom type or
 * harness) is counted as `other` or `[unknown]`, or left out; it is never spelled. Nothing is read from an argument
 * value, a ref, a path or a bundle. The one identifier is a random install id made for this report, sent as the
 * session id. The fields are listed in docs/reference/data-and-telemetry.md. Every failure is swallowed; the report
 * never changes a command's output or exit code.
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
import { loadConfig } from "../core/config/config";
import { getDbPath } from "../core/paths";
import { isKnownType, KNOWN_TYPES } from "../core/recognition-util";
import { HARNESS_REGISTRY } from "../integrations/harnesses";
import { DETAIL_VALUES, OUTPUT_FORMATS } from "../output/context";
import { openDatabase } from "../storage/database";
import { getEntryCountByType } from "../storage/repositories/index-entries-repository";
import { pkgVersion } from "../version";
import { CLI_USAGE_SOURCES, EXIT_CATEGORIES, openUsage, readUsage, type UsageCommand } from "./usage";

// The Aptabase app key is write-only and public by design (it ships in every Aptabase SDK). The host is fixed:
// no environment variable or config key can redirect it.
const ENDPOINT = "https://reporting.fwdslsh.dev/api/v0/events";
const APP_KEY = "A-SH-4111202318";
const SEND_TIMEOUT_MS = 1500;
const DAY_MS = 86_400_000;
// Aptabase refuses a request with more events, and drops an event that has a longer prop key.
const BATCH_MAX = 25;
const KEY_MAX = 40;

const HARNESS_IDS: ReadonlySet<string> = new Set(HARNESS_REGISTRY.map((harness) => harness.id));
const FAILURE_CATEGORIES: ReadonlySet<string> = new Set([...Object.values(EXIT_CATEGORIES), "cancelled"]);
/** The string flags whose value is named, from akm's own closed lists. Any other value is counted, never named. */
const NAMED_VALUES: Record<string, readonly string[]> = {
  format: OUTPUT_FORMATS,
  detail: DETAIL_VALUES,
  type: [...KNOWN_TYPES, "any"],
};

type Counts = Record<string, number>;
/** Add to a count. A key over Aptabase's limit is left out, since the server would drop the whole event for it. */
function add(counts: Counts, key: string, n: number) {
  if (n && key.length <= KEY_MAX) counts[key] = (counts[key] ?? 0) + n;
}

export type ReportSurface = "cli" | "desktop";

export interface ReportDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  timeoutMs?: number;
}

/** No test run and no CI run reaches the network: `CI`, `bun test` (`NODE_ENV=test`, `BUN_TEST`). */
function underTestOrCi(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CI) || env.NODE_ENV === "test" || env.BUN_TEST === "1";
}

/**
 * Whether the report is on, from the effective config (`extends` layers included): off when any layer sets
 * `usage.report: false` and no nearer layer overrides it. A config that cannot be loaded is "not enabled": akm
 * cannot confirm the person has not opted out, so nothing is sent.
 */
export function usageReportEnabled(): boolean {
  try {
    return loadConfig().usage?.report !== false;
  } catch {
    return false;
  }
}

function day(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function addDays(utcDay: string, days: number): string {
  return day(new Date(Date.parse(`${utcDay}T00:00:00Z`) + days * DAY_MS));
}

/** Set a meta row only forward: a day that is not later than the stored one changes nothing. */
const SET_LATER =
  "INSERT INTO cli_usage_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE cli_usage_meta.value < excluded.value";

/**
 * Take today's attempt for `surface` (`report.<surface>.last_day`): true for exactly one caller per UTC day, across
 * concurrent processes (one atomic upsert). A store created today claims nothing, so a fresh install or sandbox
 * reports from its next UTC day. Returns the last day whose counts the server accepted (`report.<surface>.through`;
 * undefined before the first accepted report) and the install id (`report.install`): a random UUID made on the
 * first claim, for the report alone. It is not the store's `instance` and is derived from nothing on the machine.
 */
function claimDay(surface: ReportSurface, today: string): { through: string | undefined; install: string } | undefined {
  const db = openUsage();
  try {
    const meta = (key: string) =>
      (db.prepare("SELECT value FROM cli_usage_meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
    const started = meta("collectionStart");
    if (started === undefined || started.slice(0, 10) >= today) return undefined;
    const key = `report.${surface}.last_day`;
    const last = meta(key);
    // Already tried today (every command after the first): a read only, no write lock on the shared store.
    if (last !== undefined && last >= today) return undefined;
    if (!db.prepare(SET_LATER).run(key, today).changes) return undefined;
    db.prepare("INSERT OR IGNORE INTO cli_usage_meta(key,value) VALUES ('report.install', ?)").run(randomUUID());
    return { through: meta(`report.${surface}.through`), install: meta("report.install") as string };
  } finally {
    db.close();
  }
}

type SendOutcome = { outcome: "sent" | "rejected" | "failed"; detail: string };

/**
 * Keep what this attempt came to, for `akm doctor metrics usage`, and on an accepted CLI report the last day its
 * counts reach, so the next report starts after it. A failed send leaves that day where it was: the next day's
 * report counts the days this one missed.
 */
function record(surface: ReportSurface, outcome: SendOutcome, through: string | undefined) {
  const db = openUsage();
  try {
    const set = db.prepare(
      "INSERT INTO cli_usage_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    );
    set.run(`report.${surface}.last_outcome`, outcome.outcome);
    set.run(`report.${surface}.last_detail`, outcome.detail);
    if (through !== undefined) db.prepare(SET_LATER).run(`report.${surface}.through`, through);
  } finally {
    db.close();
  }
}

type ArgDefinition = NonNullable<UsageCommand["args"]>[string];

/**
 * A recorded command path as akm defines it: its event name (`akm task run`) and the flags declared along it. A
 * token the command tree does not hold ends the name with `[unknown]`.
 */
function definedCommand(root: UsageCommand, path: readonly string[]) {
  const flags = new Map<string, ArgDefinition>(Object.entries(root.args ?? {}));
  const names = ["akm"];
  let node = root;
  for (const token of path) {
    const next = Object.hasOwn(node.subCommands ?? {}, token) ? node.subCommands?.[token] : undefined;
    if (!next) {
      names.push("[unknown]");
      break;
    }
    names.push(token);
    node = next;
    for (const [name, definition] of Object.entries(node.args ?? {})) flags.set(name, definition);
  }
  return { name: names.join(" "), flags };
}

/**
 * The CLI's counts for the complete UTC days after `through` (the last day the server accepted) up to yesterday,
 * from the durable aggregates: the totals for the daily event, and the counts of each command as it was typed.
 * Before the first accepted report there is nothing to count: `period_days` is 0. Without the command tree
 * (`root`) no command can be checked against it, so only the totals are counted.
 */
function cliCounts(root: UsageCommand | undefined, through: string | undefined, today: string) {
  const since = through === undefined ? today : addDays(through, 1);
  const until = addDays(today, -1);
  const totals: Counts = { period_days: 0, commands: 0, failures: 0 };
  for (const source of [...CLI_USAGE_SOURCES, "terminal"]) totals[`src_${source}`] = 0;
  const commands = new Map<string, Counts>();
  if (since > until) return { totals, commands };
  totals.period_days = (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY_MS + 1;
  for (const row of readUsage({ since, until, aggregatesOnly: true }).aggregates) {
    const dimensions = row.dimensions as {
      command?: string[];
      invokedCommand?: string[];
      source?: string;
      harness?: string;
      terminal?: boolean;
      arguments?: Array<{ name: string; explicit: boolean; value: string | boolean }>;
    };
    const attempts = Number(row.attempts);
    const failures = Number(row.failures);
    const counted: Counts = {};
    // A run of unknown source with a terminal attached is counted apart: most likely a person typing.
    const source = CLI_USAGE_SOURCES.has(dimensions.source ?? "") ? dimensions.source : "unknown";
    add(counted, `src_${source === "unknown" && dimensions.terminal === true ? "terminal" : source}`, attempts);
    if (dimensions.harness)
      add(counted, `h_${HARNESS_IDS.has(dimensions.harness) ? dimensions.harness : "other"}`, attempts);
    add(totals, "commands", attempts);
    add(totals, "failures", failures);
    for (const [key, n] of Object.entries(counted)) add(totals, key, n);
    if (!root) continue;

    const { name, flags } = definedCommand(root, dimensions.invokedCommand ?? dimensions.command ?? []);
    // A flag given twice in one run is one use of it.
    const used = new Set<string>();
    for (const argument of dimensions.arguments ?? []) {
      const definition = flags.get(argument.name);
      if (!argument.explicit || !definition || definition.type === "positional") continue;
      used.add(`flag_${argument.name}`);
      const named = definition.type === "enum" ? definition.options : NAMED_VALUES[argument.name];
      if (typeof argument.value === "string" && named?.includes(argument.value))
        used.add(`flag_${argument.name}_${argument.value}`);
    }
    for (const key of used) add(counted, key, attempts);
    // An outcome is `<category>:<exit code>:<asset type the command resolved, or "unresolved">`.
    for (const [outcome, n] of Object.entries(row.outcomes as Record<string, number>)) {
      const [category = "", , type = "unresolved"] = outcome.split(":");
      if (category !== "success") add(counted, `out_${FAILURE_CATEGORIES.has(category) ? category : "failure"}`, n);
      if (type !== "unresolved") add(counted, `type_${isKnownType(type) ? type : "other"}`, n);
    }
    const props = commands.get(name) ?? { period_days: totals.period_days, count: 0, failures: 0, duration_ms: 0 };
    commands.set(name, props);
    add(props, "count", attempts);
    add(props, "failures", failures);
    add(props, "duration_ms", Number(row.duration_ms));
    for (const [key, n] of Object.entries(counted)) add(props, key, n);
  }
  return { totals, commands };
}

/** What is set up, as counts and 0/1 switches from the effective config: never a name, a path or a URL. */
function setupSnapshot(): Counts {
  const config = loadConfig();
  const bundles = Object.values(config.bundles ?? {}).filter((bundle) => bundle.enabled !== false);
  return {
    bundles: bundles.length,
    bundles_git: bundles.filter((bundle) => bundle.git !== undefined).length,
    bundles_website: bundles.filter((bundle) => bundle.website !== undefined).length,
    bundles_npm: bundles.filter((bundle) => bundle.npm !== undefined).length,
    registries: config.registries?.length ?? 0,
    connections: Object.keys(config.connections ?? {}).length,
    harnesses: Object.keys(config.harnesses ?? {}).length,
    projects: Object.keys(config.projects ?? {}).length,
    tasks_enabled: config.scheduler?.enabled?.length ?? 0,
    semantic_search: config.semanticSearchMode === "auto" ? 1 : 0,
    improve: config.improve?.enabled === false ? 0 : 1,
    exec: config.experimental?.exec === true ? 1 : 0,
  };
}

/** The indexed asset counts, by akm's own types, from the read-only index. Absent when there is none to read. */
function librarySnapshot(): Counts {
  const props: Counts = {};
  try {
    const db = openDatabase(getDbPath(), { readonly: true, create: false });
    try {
      db.exec("PRAGMA busy_timeout=250; PRAGMA query_only=ON;");
      const byType = getEntryCountByType(db);
      props.assets = Object.values(byType).reduce((sum, n) => sum + n, 0);
      // A type outside akm's own set is named by a bundle's adapter or the user: it is counted, never named.
      for (const [type, n] of Object.entries(byType)) {
        const key = isKnownType(type) ? `assets_${type}` : "assets_other";
        props[key] = (props[key] ?? 0) + n;
      }
    } finally {
      db.close();
    }
  } catch {
    // No index, or one that cannot be read: the snapshot omits the asset counts.
  }
  return props;
}

function systemProps(version: string) {
  const platform = process.platform;
  return {
    isDebug: false,
    // Only the language, script and region of the locale, and only the numbers of the OS release: a kernel build
    // can carry a name its builder chose.
    locale: /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?/.exec(Intl.DateTimeFormat().resolvedOptions().locale)?.[0] ?? "",
    osName:
      platform === "linux" ? "Linux" : platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform,
    osVersion: /^\d+(\.\d+){0,2}/.exec(os.release())?.[0] ?? "",
    engineName: process.versions.bun ? "bun" : "node",
    engineVersion: process.versions.bun ?? process.versions.node,
    appVersion: version,
    sdkVersion: `akm@${version}`,
  };
}

/**
 * POST the events, at most 25 a request, all inside one time limit. Aptabase answers a request it refuses with a
 * 4xx, and an App-Key it does not know with a 200 whose body carries `error`: both are rejections. A report over 25
 * events goes in several requests; when only some arrive the report is not accepted, and the next one sends those
 * commands' counts again.
 */
async function send(events: unknown[], deps: ReportDeps): Promise<SendOutcome> {
  const timeoutMs = deps.timeoutMs ?? SEND_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const post = async (batch: unknown[]): Promise<SendOutcome> => {
    try {
      const response = await (deps.fetch ?? fetch)(ENDPOINT, {
        method: "POST",
        headers: { "App-Key": APP_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(batch),
        signal: controller.signal,
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) return { outcome: "rejected", detail: `HTTP ${response.status}: ${text}`.slice(0, 300) };
      let error: unknown;
      try {
        error = (JSON.parse(text) as { error?: unknown } | null)?.error;
      } catch {
        // A 200 with a body that is not JSON carries no error.
      }
      return error ? { outcome: "rejected", detail: String(error).slice(0, 300) } : { outcome: "sent", detail: "" };
    } catch (error) {
      const detail = controller.signal.aborted
        ? `no answer within ${timeoutMs} ms`
        : error instanceof Error
          ? error.message
          : String(error);
      return { outcome: "failed", detail: detail.slice(0, 300) };
    }
  };
  try {
    const batches: unknown[][] = [];
    for (let at = 0; at < events.length; at += BATCH_MAX) batches.push(events.slice(at, at + BATCH_MAX));
    const outcomes = await Promise.all(batches.map(post));
    return outcomes.find((outcome) => outcome.outcome !== "sent") ?? { outcome: "sent", detail: "" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send the surface's daily report when it is due. `commands` is the CLI's command tree: the CLI's per-command events
 * are checked against it, and are not sent without it. Resolves true when the server accepted the report; never
 * throws.
 */
export async function reportUsageIfDue(
  { surface, version = pkgVersion, commands }: { surface: ReportSurface; version?: string; commands?: UsageCommand },
  deps: ReportDeps = {},
): Promise<boolean> {
  try {
    const env = deps.env ?? process.env;
    if (underTestOrCi(env) || !usageReportEnabled()) return false;
    const now = deps.now ?? new Date();
    const today = day(now);
    const claim = claimDay(surface, today);
    if (!claim) return false;
    const cli = surface === "cli" ? cliCounts(commands, claim.through, today) : undefined;
    const system = systemProps(version);
    const event = (eventName: string, props: Counts) => ({
      timestamp: now.toISOString(),
      sessionId: claim.install,
      eventName,
      systemProps: system,
      props,
    });
    const outcome = await send(
      [
        event(`${surface}_daily`, { ...cli?.totals, ...setupSnapshot(), ...librarySnapshot() }),
        ...[...(cli?.commands ?? [])].map(([name, props]) => event(name, props)),
      ],
      deps,
    );
    record(surface, outcome, outcome.outcome === "sent" && cli ? addDays(today, -1) : undefined);
    return outcome.outcome === "sent";
  } catch {
    return false;
  }
}
