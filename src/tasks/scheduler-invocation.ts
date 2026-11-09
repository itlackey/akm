// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * How a native scheduler row invokes akm.
 *
 * A row is `<launcher…> task run <id> --bundle <bundle> --scheduled
 * [--<input> <value>…]`, or `<launcher…> workflow run <qualified-ref>`, and it
 * carries its own context: the environment the scheduled process needs,
 * set inline by the row itself (a cron `VAR=value` prefix, a launchd
 * `EnvironmentVariables` entry, a PowerShell `$env:` assignment).
 *
 *   - `AKM_BUNDLE_DIR`: the working stash of the process that ran
 *     `akm task sync`, on every row. The scheduled run uses the same working
 *     stash, `--bundle <name>` finds a stash no config names, and sync
 *     attributes the row to the installation that wrote it (#846).
 *   - `AKM_CONFIG_DIR`, `AKM_DATA_DIR`, `AKM_CACHE_DIR` and `AKM_STATE_DIR`
 *     only when the process that ran `akm task sync` set them explicitly. A
 *     default resolves at fire time exactly as it does for an interactive
 *     command.
 *
 * `PATH` is the scheduler's own: the crontab's `# akm:env` block, the plist's
 * `EnvironmentVariables`.
 *
 * A row written by 0.9.17-alpha.6 or earlier names a `--scheduler-context`
 * descriptor instead. This release neither reads nor lists it: such a row fails
 * when it fires, and `akm task sync` rewrites it from its source.
 */

import path from "node:path";
import { bundleRefToString, parseBundleRef } from "../core/asset/asset-ref";
import { resolveStashDir } from "../core/common";
import { ConfigError } from "../core/errors";
import { INPUT_NAME_PATTERN } from "../execution/input-contract";
import { normaliseTaskConceptId } from "./task-id";

export const SCHEDULED_TASK_CONTEXT_KEYS = [
  "AKM_BUNDLE_DIR",
  "AKM_CONFIG_DIR",
  "AKM_DATA_DIR",
  "AKM_CACHE_DIR",
  "AKM_STATE_DIR",
] as const;

type ScheduledTaskContextKey = (typeof SCHEDULED_TASK_CONTEXT_KEYS)[number];

/** The environment a row sets inline, keyed by {@link SCHEDULED_TASK_CONTEXT_KEYS}. */
export type ScheduledRowEnvironment = Readonly<Partial<Record<ScheduledTaskContextKey, string>>>;

/**
 * Directories a row carries ONLY when the process that ran `task sync` had
 * them set explicitly in its environment. They are never resolved from
 * defaults: a sync run from inside an app whose environment pointed `$STATE`
 * somewhere private (an OpenCode desktop session, 2026-08 → 2026-09) froze
 * that directory into eight cron rows, and the scheduled improve runs then
 * held their locks in a `locks/` directory no interactive command could see.
 */
const EXPLICIT_CONTEXT_KEYS = ["AKM_CONFIG_DIR", "AKM_DATA_DIR", "AKM_CACHE_DIR", "AKM_STATE_DIR"] as const;

/** The AKM directory context of the current process, so nested AKM commands stay in the same installation. */
export function scheduledTaskContextEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SCHEDULED_TASK_CONTEXT_KEYS) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}

/**
 * The environment every row a sync writes sets inline: `AKM_BUNDLE_DIR`,
 * the syncing process's working stash, plus whichever `AKM_*_DIR` overrides
 * it set explicitly. With no working stash to resolve (no default bundle, no
 * `AKM_BUNDLE_DIR`), rows name their bundle by `--bundle` alone.
 */
export function scheduledRowEnvironment(env: NodeJS.ProcessEnv = process.env): ScheduledRowEnvironment {
  const out: Partial<Record<ScheduledTaskContextKey, string>> = {};
  try {
    out.AKM_BUNDLE_DIR = path.resolve(resolveStashDir(env));
  } catch {
    // No working stash: there is no primary bundle to attribute rows to either.
  }
  for (const key of EXPLICIT_CONTEXT_KEYS) {
    const value = env[key]?.trim();
    if (value) out[key] = path.resolve(value);
  }
  return out;
}

/** A row environment's entries, in {@link SCHEDULED_TASK_CONTEXT_KEYS} order. */
export function scheduledRowEnvironmentEntries(environment: ScheduledRowEnvironment | undefined): [string, string][] {
  const entries: [string, string][] = [];
  for (const key of SCHEDULED_TASK_CONTEXT_KEYS) {
    const value = environment?.[key];
    if (value) entries.push([key, value]);
  }
  return entries;
}

/** Keep the {@link SCHEDULED_TASK_CONTEXT_KEYS} a parsed row set; `undefined` when there are none. */
export function scheduledRowEnvironmentFrom(
  variables: Readonly<Record<string, string>>,
): ScheduledRowEnvironment | undefined {
  const out: Partial<Record<ScheduledTaskContextKey, string>> = {};
  for (const key of SCHEDULED_TASK_CONTEXT_KEYS) {
    const value = variables[key];
    if (value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface ParsedScheduledInvocation {
  /** Launcher argv: everything before the public tail. */
  binding: string[];
  /** The public `task run …` / `workflow run …` tail. */
  invocation: string[];
  /** Bundle the tail names: `--bundle <x>`, or a workflow ref's bundle. */
  target?: string;
  /** The row's inline environment (current rows only). */
  environment?: ScheduledRowEnvironment;
}

/** The installed argv: the launcher, then one already-validated public scheduler tail. */
export function buildScheduledInvocation(akmArgv: readonly string[], invocation: readonly string[]): string[] {
  const parsed = parsePublicSchedulerInvocation(invocation);
  if (!parsed) throw invalidSchedulerInvocation();
  return [...akmArgv, ...parsed.invocation];
}

/**
 * Parse an installed row's argv (after any inline environment): the launcher, then the public tail. A row that
 * names `--scheduler-context` (0.9.17-alpha.6 and earlier) is not one: sync rewrites it from its source.
 */
export function parseScheduledInvocationArgv(argv: readonly string[]): ParsedScheduledInvocation | undefined {
  if (argv.includes("--scheduler-context")) return undefined;
  for (let index = 1; index < argv.length - 1; index += 1) {
    if ((argv[index] === "task" || argv[index] === "workflow") && argv[index + 1] === "run") {
      const publicInvocation = parsePublicSchedulerInvocation(argv.slice(index));
      return publicInvocation ? { binding: argv.slice(0, index), ...publicInvocation } : undefined;
    }
  }
  return undefined;
}

/**
 * Parse just the public `task run …` / `workflow run …` tail, the part of a
 * row that names what it runs.
 */
function parsePublicSchedulerInvocation(
  invocation: readonly string[],
): { invocation: string[]; target?: string } | undefined {
  if (invocation[0] === "task" && invocation[1] === "run" && invocation[2]) {
    try {
      if (normaliseTaskConceptId(invocation[2]) !== invocation[2]) return undefined;
    } catch {
      return undefined;
    }
    let index = 3;
    let target: string | undefined;
    if (invocation[index] === "--bundle") {
      target = invocation[index + 1];
      if (!target) return undefined;
      index += 2;
    }
    if (invocation[index] !== "--scheduled") return undefined;
    // Zero or more `--<name> <value>` schedule-supplied input flags may follow
    // `--scheduled` — the same trailing tail `compileTaskSchedulerBindings`
    // compiles from `schedule[i].inputs`. Absent/empty is the earlier,
    // byte-identical shape.
    if (!isValidSchedulerInputFlagTail(invocation.slice(index + 1))) return undefined;
    return { invocation: [...invocation], ...(target !== undefined ? { target } : {}) };
  }
  if (invocation[0] !== "workflow" || invocation[1] !== "run" || invocation.length !== 3) {
    return undefined;
  }
  const ref = invocation[2];
  if (!ref) return undefined;
  try {
    const parsed = parseBundleRef(ref);
    if (!parsed.bundle || parsed.fragment !== undefined || bundleRefToString(parsed) !== ref) return undefined;
    return { invocation: [...invocation], target: parsed.bundle };
  } catch {
    return undefined;
  }
}

/**
 * Validate an OPTIONAL trailing schedule-input flag tail: empty is valid
 * (the earlier shape). Otherwise the tail is a sequence of
 * entries, each EITHER:
 *
 *   - a single inline `--<name>=<value>` token (the ONLY encoding a
 *     dash-leading value's exact text can round-trip through, since `<value>`
 *     here is everything after the first `=`, whatever its leading character);
 *     or
 *   - a `(--<name>, <value>)` pair, where `<value>` is a single non-flag
 *     token (does not start with `-`) — the earlier shape.
 *
 * In both forms `<name>` matches {@link INPUT_NAME_PATTERN} and no name
 * repeats. A bare flag, a repeated name, a flag-shaped value in the pair
 * form, or a malformed token are all refused. This validates SHAPE only;
 * the real materialization against the task's declared contract happens
 * through the same `parseTaskInputFlags` + `materializeInputFlags` path
 * `akm task run --<name>` already uses — `parseTaskInputFlags`
 * accepts both forms natively (its inline-`=` branch never inspects the
 * value's leading character).
 */
function isValidSchedulerInputFlagTail(tail: readonly string[]): boolean {
  if (tail.length === 0) return true;
  const seen = new Set<string>();
  let index = 0;
  while (index < tail.length) {
    const token = tail[index];
    if (!token || !token.startsWith("--")) return false;
    const body = token.slice(2);
    const equalsAt = body.indexOf("=");
    if (equalsAt !== -1) {
      const name = body.slice(0, equalsAt);
      if (!INPUT_NAME_PATTERN.test(name) || seen.has(name)) return false;
      seen.add(name);
      index += 1;
      continue;
    }
    if (!INPUT_NAME_PATTERN.test(body) || seen.has(body)) return false;
    const value = tail[index + 1];
    if (value === undefined || value.startsWith("-")) return false;
    seen.add(body);
    index += 2;
  }
  return true;
}

function invalidSchedulerInvocation(): ConfigError {
  return new ConfigError(
    "Invalid scheduler invocation; expected public " +
      "`task run <id> [--bundle <bundle>] --scheduled [--<input> <value>…]` or `workflow run <qualified-ref>` argv.",
    "INVALID_CONFIG_FILE",
  );
}
