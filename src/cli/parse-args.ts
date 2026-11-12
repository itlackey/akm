// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared argument-parsing utilities for the AKM CLI entry point.
 *
 * These were extracted from `src/cli.ts` to eliminate repetition and keep the
 * main CLI file focused on command definitions and routing.
 */

import type { StashEntryScope } from "../core/adapter/types";
import { UsageError } from "../core/errors";
import type { ResolvedProject } from "../core/projects";

// findCittyTopLevelCommand(Index) + CittyArg(s)DefinitionForScan moved to
// ./invocation (chunk-9 WI-9.9 argv-normalization fold — that cluster had no
// internal imports, so it relocated cleanly); re-exported here so existing
// importers (tests/tasks-core.test.ts, commands/read/show.ts) are unaffected.
export {
  type CittyArgDefinitionForScan,
  type CittyArgsDefinitionForScan,
  findCittyTopLevelCommand,
  findCittyTopLevelCommandIndex,
} from "./invocation";

/**
 * Return true when `args._[0]` is a member of `validSet`.
 *
 * Citty exposes unknown subcommands as `args._[0]` (the first positional).
 * Several top-level commands (config, vault, wiki, workflow, tasks) need to
 * detect whether a recognised subcommand was supplied so they can show a help
 * banner rather than an unhelpful "unknown command" error.
 *
 * @param args     Parsed citty argument object (must have an `_` array).
 * @param validSet The set of recognised subcommand names for this command.
 */
export function hasSubcommand(args: Record<string, unknown>, validSet: Set<string>): boolean {
  const command = Array.isArray(args._) ? args._[0] : undefined;
  return typeof command === "string" && validSet.has(command);
}

// ── Numeric flag parsing ─────────────────────────────────────────────────────

/**
 * Parse a `--limit`-style flag value into a positive integer.
 *
 * Returns `undefined` when `raw` is `undefined` or empty (flag not supplied).
 * Throws `UsageError` when the raw value is present but not a valid positive
 * integer so the caller gets a structured, machine-readable error response.
 *
 * @param raw       The raw string value from citty (may be undefined).
 * @param flagName  The flag name to include in the error message (e.g. `"--limit"`).
 */
export function parsePositiveIntFlag(raw: string | undefined, flagName = "--limit"): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Strict digits: parseInt stops at the first non-digit, so "10x" silently
  // became 10, "3.5" became 3, and "5 apples" became 5 — accepted rather than
  // rejected as invalid.
  if (!/^\d+$/.test(trimmed)) {
    throw new UsageError(`Invalid ${flagName} value: "${raw}". Must be a positive integer.`, "INVALID_FLAG_VALUE");
  }
  const parsed = parseInt(trimmed, 10);
  if (parsed <= 0) {
    throw new UsageError(`Invalid ${flagName} value: "${raw}". Must be a positive integer.`, "INVALID_FLAG_VALUE");
  }
  return parsed;
}

/**
/**
 * Parse an integer flag value: digits only (so `3x`, `3.5` and `-1` are
 * rejected, not truncated), within `minimum` and the optional `maximum`.
 * Returns `undefined` when the flag was not supplied.
 */
export function parseIntegerFlag(
  raw: string | undefined,
  name: string,
  minimum: number,
  maximum?: number,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || value < minimum || (maximum !== undefined && value > maximum)) {
    const range = maximum === undefined ? `at least ${minimum}` : `from ${minimum} through ${maximum}`;
    throw new UsageError(`${name} must be an integer ${range}, got "${raw}".`, "INVALID_FLAG_VALUE");
  }
  return value;
}

/**
 * The one `--timeout` grammar: bare N is milliseconds, or N with `ms`, `s`, `m`,
 * `h` or `d`. Private to `--timeout` flags; asset `timeout:` fields and
 * `--since`/`--expires` keep the shared duration grammar in core/time.
 */
const TIMEOUT_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse one `--timeout` value to positive milliseconds, or throw a usage error. */
export function parseTimeoutValue(raw: string, flagName = "--timeout"): number {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(raw.trim());
  const parsed = match ? Number(match[1]) * (TIMEOUT_UNITS[match[2] ?? "ms"] as number) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UsageError(
      `Invalid ${flagName} value: "${raw}". Expected a positive number: bare N is milliseconds, or N with ms, s, m, h or d (30s, 2m, 1h, 7d).`,
      "INVALID_FLAG_VALUE",
    );
  }
  return parsed;
}

/** The `--timeout` flag as milliseconds, or `undefined` when it was not supplied. */
export function parseTimeoutFlag(timeout: string | undefined): number | undefined {
  return timeout === undefined ? undefined : parseTimeoutValue(timeout);
}

// ── String flag parsing ──────────────────────────────────────────────────────

/**
 * Extract a string value from a parsed citty argument object by key.
 *
 * Returns the trimmed string when present and non-empty, or `undefined`
 * otherwise. Eliminates the repeated
 * `typeof args.X === "string" && args.X.trim() ? args.X.trim() : undefined`
 * pattern throughout the CLI command handlers.
 *
 * @param args  The citty argument object (typed as unknown for flexibility).
 * @param key   The argument key to look up.
 */
export function getStringArg(args: unknown, key: string): string | undefined {
  const val = (args as Record<string, unknown>)[key];
  if (typeof val !== "string") return undefined;
  const trimmed = val.trim();
  return trimmed || undefined;
}

/** `--project`: the configured project to use instead of the one the working directory selects (`none`: no project). */
export const PROJECT_ARG = {
  project: {
    type: "string",
    description: "Configured project to use instead of the one the working directory selects (`none`: no project)",
  },
} as const;

/** The scope flags `remember` takes, for the proposal commands that stamp a scope on what they queue. */
export const SCOPE_ARGS = {
  user: { type: "string", description: "Scope the proposal to a user id (persisted as `scope_user` frontmatter)" },
  agent: { type: "string", description: "Scope the proposal to an agent id (persisted as `scope_agent` frontmatter)" },
  run: { type: "string", description: "Scope the proposal to a run id (persisted as `scope_run` frontmatter)" },
  channel: {
    type: "string",
    description: "Scope the proposal to a channel name (persisted as `scope_channel` frontmatter)",
  },
} as const;

/** The scope the {@link SCOPE_ARGS} flags name, each absent one filled from the project's `write`; empty when none is given. */
export function scopeFromArgs(args: unknown, project?: ResolvedProject): StashEntryScope {
  const scope: StashEntryScope = {};
  for (const key of ["user", "agent", "run", "channel"] as const) {
    const value = getStringArg(args, key) ?? (key === "run" ? undefined : project?.write[key]);
    if (value) scope[key] = value;
  }
  return scope;
}
