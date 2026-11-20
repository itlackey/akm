// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The daily usage report: at most one event per surface (`cli`, `desktop`) per UTC day, to the owner's self-hosted
 * Aptabase. Counts only: no argument value, ref, path, bundle name or instance id is ever read into it. The
 * fields sent are listed in docs/reference/data-and-telemetry.md. Every failure is swallowed; the report never
 * changes a command's output or exit code.
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
import { loadConfig } from "../core/config/config";
import { peekConfigValue } from "../core/config/peek";
import { getDbPath } from "../core/paths";
import { isKnownType } from "../core/recognition-util";
import { openDatabase } from "../storage/database";
import { getEntryCountByType } from "../storage/repositories/index-entries-repository";
import { pkgVersion } from "../version";
import { openUsage, readUsage } from "./usage";

// The Aptabase app key is write-only and public by design (it ships in every Aptabase SDK). The host is fixed:
// no environment variable or config key can redirect it.
const ENDPOINT = "https://reporting.fwdslsh.dev/api/v0/event";
const APP_KEY = "A-SH-4111202318";
const SEND_TIMEOUT_MS = 1500;
const DAY_MS = 86_400_000;

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

/**
 * Take today for `surface`: true for exactly one caller per UTC day, across concurrent processes (one atomic
 * upsert). A store created today claims nothing, so a fresh install or sandbox reports from its next UTC day.
 * Returns the previously reported day (undefined before the first report).
 */
function claimDay(surface: ReportSurface, today: string): { last: string | undefined } | undefined {
  const db = openUsage();
  try {
    const started = (
      db.prepare("SELECT value FROM cli_usage_meta WHERE key='collectionStart'").get() as { value: string } | undefined
    )?.value;
    if (started === undefined || started.slice(0, 10) >= today) return undefined;
    const key = `report.${surface}.last_day`;
    const last = (db.prepare("SELECT value FROM cli_usage_meta WHERE key=?").get(key) as { value: string } | undefined)
      ?.value;
    // Already reported today (every command after the first): a read only, no write lock on the shared store.
    if (last !== undefined && last >= today) return undefined;
    const claimed = db
      .prepare(
        "INSERT INTO cli_usage_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE cli_usage_meta.value < excluded.value",
      )
      .run(key, today).changes;
    return claimed ? { last } : undefined;
  } finally {
    db.close();
  }
}

/**
 * Counts of the complete UTC days from `last` up to yesterday, from the durable aggregates. `last` is the day the
 * previous report was sent, which that report did not count: it counted up to the day before.
 */
function cliCounts(last: string | undefined, today: string): Record<string, number> {
  const since = last ?? today;
  const until = addDays(today, -1);
  const props: Record<string, number> = { period_days: 0, commands: 0, failures: 0 };
  if (since > until) return props;
  props.period_days = (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY_MS + 1;
  const report = readUsage({ since, until, aggregatesOnly: true });
  for (const row of report.aggregates) {
    const dimensions = row.dimensions as { command?: string[]; source?: string };
    const attempts = Number(row.attempts);
    props.commands = (props.commands ?? 0) + attempts;
    props.failures = (props.failures ?? 0) + Number(row.failures);
    if (dimensions.source && ["user", "agent", "task", "improve"].includes(dimensions.source)) {
      const key = `src_${dimensions.source}`;
      props[key] = (props[key] ?? 0) + attempts;
    }
    const name = (dimensions.command?.[0] ?? "").replace(/[^a-z0-9-]/g, "") || "other";
    const key = `cmd_${name}`.slice(0, 40);
    props[key] = (props[key] ?? 0) + attempts;
  }
  for (const key of ["src_user", "src_agent", "src_task", "src_improve"]) props[key] ??= 0;
  return props;
}

/** Enabled bundle count from the config file, and the indexed asset counts (by akm's own types) from the read-only index. Absent when unreadable. */
function librarySnapshot(): Record<string, number> {
  const props: Record<string, number> = {};
  const bundles = peekConfigValue(["bundles"]);
  if (typeof bundles === "object" && bundles !== null) {
    props.bundles = Object.values(bundles).filter((b) => (b as { enabled?: unknown } | null)?.enabled !== false).length;
  }
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
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    osName:
      platform === "linux" ? "Linux" : platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform,
    osVersion: os.release(),
    engineName: process.versions.bun ? "bun" : "node",
    engineVersion: process.versions.bun ?? process.versions.node,
    appVersion: version,
    sdkVersion: `akm@${version}`,
  };
}

/** Send the surface's daily event when it is due. Resolves true when the server accepted it; never throws. */
export async function reportUsageIfDue(
  { surface, version = pkgVersion }: { surface: ReportSurface; version?: string },
  deps: ReportDeps = {},
): Promise<boolean> {
  try {
    const env = deps.env ?? process.env;
    if (underTestOrCi(env) || !usageReportEnabled()) return false;
    const now = deps.now ?? new Date();
    const today = day(now);
    const claim = claimDay(surface, today);
    if (!claim) return false;
    const props = {
      ...(surface === "cli" ? cliCounts(claim.last, today) : {}),
      ...librarySnapshot(),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? SEND_TIMEOUT_MS);
    try {
      const response = await (deps.fetch ?? fetch)(ENDPOINT, {
        method: "POST",
        headers: { "App-Key": APP_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          timestamp: now.toISOString(),
          sessionId: randomUUID(),
          eventName: `${surface}_daily`,
          systemProps: systemProps(version),
          props,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const body = (await response.json().catch(() => ({}))) as { error?: unknown } | null;
      return !body?.error;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
