// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared argument-parsing utilities for the AKM CLI entry point.
 *
 * These were extracted from `src/cli.ts` to eliminate repetition and keep the
 * main CLI file focused on command definitions and routing.
 */

import { UsageError } from "../core/errors";
import { warn } from "../core/warn";

// ── Subcommand detection ─────────────────────────────────────────────────────

export interface CittyArgDefinitionForScan {
  readonly type?: string;
  readonly alias?: string | readonly string[];
}

export type CittyArgsDefinitionForScan = Record<string, CittyArgDefinitionForScan>;

function cittyComparableName(name: string): string {
  return name.replace(/[-_]+([a-zA-Z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function toAliasArray(alias: CittyArgDefinitionForScan["alias"]): readonly string[] {
  if (Array.isArray(alias)) return alias;
  return typeof alias === "string" ? [alias] : [];
}

function isCittyValueFlag(flag: string, argsDef: CittyArgsDefinitionForScan): boolean {
  const name = flag.replace(/^-{1,2}/, "");
  const normalized = cittyComparableName(name);
  for (const [key, def] of Object.entries(argsDef)) {
    if (def.type !== "string" && def.type !== "enum") continue;
    if (normalized === cittyComparableName(key)) return true;
    if (toAliasArray(def.alias).includes(name)) return true;
  }
  return false;
}

/**
 * Match citty's top-level subcommand scan (`findSubCommandIndex`).
 *
 * Citty does not assume `rawArgs[0]` is the command: global string flags may
 * appear first and consume the following token. The CLI startup guard uses this
 * to classify the requested command before any command handler can run.
 */
export function findCittyTopLevelCommandIndex(rawArgs: readonly string[], argsDef: CittyArgsDefinitionForScan): number {
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--") return -1;
    if (arg.startsWith("-")) {
      if (!arg.includes("=") && isCittyValueFlag(arg, argsDef)) i += 1;
      continue;
    }
    return i;
  }
  return -1;
}

export function findCittyTopLevelCommand(
  rawArgs: readonly string[],
  argsDef: CittyArgsDefinitionForScan,
): string | undefined {
  const index = findCittyTopLevelCommandIndex(rawArgs, argsDef);
  return index >= 0 ? rawArgs[index] : undefined;
}

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
  const parsed = parseInt(trimmed, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new UsageError(`Invalid ${flagName} value: "${raw}". Must be a positive integer.`, "INVALID_FLAG_VALUE");
  }
  return parsed;
}

/**
 * Parse a non-negative integer flag value (0 is allowed, unlike `parsePositiveIntFlag`).
 *
 * Returns `undefined` when `raw` is `undefined` or empty (flag not supplied).
 * Throws `UsageError` when the raw value is present but not a valid non-negative
 * integer (e.g. contains decimals, letters, or is negative).
 *
 * @param raw       The raw string value (may be undefined).
 * @param flagName  The flag name to include in the error message.
 */
export function parseNonNegativeIntFlag(raw: string | undefined, flagName: string): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) {
    throw new UsageError(`Invalid ${flagName} value: "${raw}". Must be a non-negative integer.`, "INVALID_FLAG_VALUE");
  }
  return parseInt(trimmed, 10);
}

// ── Auto-accept flag parsing (deprecated) ───────────────────────────────────

/**
 * DEPRECATED (0.9.0): `akm improve --auto-accept` is accepted but ignored.
 *
 * The confidence gate the flag configured was deleted in 0.9.0 — proposals
 * now queue for review (`akm proposal` / the drain engine) instead of being
 * auto-promoted by threshold. The flag warns-and-ignores for one minor
 * because installed crontabs embed the old command line; a hard parse error
 * would make scheduled background runs fail invisibly after upgrade. Hard
 * removal in 0.10.
 *
 * - `undefined` (flag absent) → silent no-op.
 * - Any present value (bare flag, `safe`, `false`, a number, garbage) →
 *   one deprecation warning on stderr; never throws.
 */
export function parseAutoAcceptFlag(raw: string | undefined): void {
  if (raw === undefined) return;
  warn(
    "[improve] --auto-accept is deprecated and ignored (the 0.9.0 confidence gate was removed; " +
      "proposals queue for review via `akm proposal` or the drain engine). The flag will be removed in 0.10.",
  );
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
