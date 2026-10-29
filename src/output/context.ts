// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Process-level output mode singleton.
 *
 * Output mode (format + detail, and the agent projection `--detail agent`
 * selects) is parsed once at startup from
 * `process.argv` and the persisted user config. All subsequent `output()`
 * calls read from this in-memory singleton instead of re-scanning argv and
 * re-loading config on every call.
 *
 * Initialized from `cli.ts` before `runCli` dispatches the command (`cli.ts`
 * drives citty's `runCommand` directly rather than `runMain` — see the
 * top-level driver comment there).
 */

import { UsageError } from "../core/errors";

export type OutputFormat = "json" | "yaml" | "text" | "jsonl" | "md" | "html";
/** Verbosity axis. */
export type DetailLevel = "brief" | "normal" | "full";
/**
 * Output projection. `human` is the default; `--detail agent` selects `agent`
 * (the token-lean action view, honoured by search/curate/show).
 */
export type ShapeMode = "human" | "agent";

export interface OutputMode {
  format: OutputFormat;
  detail: DetailLevel;
  shape: ShapeMode;
  /**
   * Destination file for rendered output (`--output <path>`). When set,
   * `output()` writes the rendered document to this path instead of stdout.
   */
  outputPath?: string;
}

export interface OutputDefaults {
  format?: OutputFormat | "json" | "yaml" | "text";
  detail?: DetailLevel | "brief" | "normal" | "full";
}

const OUTPUT_FORMATS: OutputFormat[] = ["json", "yaml", "text", "jsonl", "md", "html"];
/** What `--detail` accepts: a verbosity level, or `agent` for the agent projection. */
export type DetailValue = DetailLevel | "agent";
const DETAIL_VALUES: DetailValue[] = ["brief", "normal", "full", "agent"];

function parseOutputFormat(value: string | undefined): OutputFormat | undefined {
  if (!value) return undefined;
  if ((OUTPUT_FORMATS as string[]).includes(value)) return value as OutputFormat;
  throw new UsageError(
    `Invalid value for --format: ${value}. Expected one of: ${OUTPUT_FORMATS.join("|")}`,
    "INVALID_FORMAT_VALUE",
  );
}

export function parseDetailLevel(value: string | undefined): DetailValue | undefined {
  if (!value) return undefined;
  if ((DETAIL_VALUES as string[]).includes(value)) return value as DetailValue;
  throw new UsageError(
    `Invalid value for --detail: ${value}. Expected one of: ${DETAIL_VALUES.join("|")}`,
    "INVALID_DETAIL_VALUE",
  );
}

export function parseFlagValue(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break;
    if (arg === flag) return argv[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

export function hasBooleanFlag(argv: string[], flag: string): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === flag || arg === `${flag}=true`) return true;
  }
  return false;
}

/**
 * Read a hyphenated arg out of citty's parsed `args` object.
 *
 * Verified live: citty DOES auto-camelise a DECLARED hyphenated arg — for
 * `"max-pages": { type: "string" }` in a command's `args`, citty's parsed
 * object answers both `args["max-pages"]` and `args.maxPages` (a `Proxy`
 * falls back through `camelCase`/`kebabCase`, and `--no-<flag>` negation is
 * handled the same way for booleans). What citty's own TS types do NOT give
 * callers is a statically-typed handle on that mapping, and command handlers
 * here type `args` as `unknown` at the boundary — so every read site still
 * needs a cast. This helper encapsulates that cast; it exists for typing
 * convenience, not to work around a citty parsing limitation.
 */
export function getHyphenatedArg<T = string>(args: unknown, key: string): T | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return value === undefined ? undefined : (value as T);
}

/** Boolean variant of {@link getHyphenatedArg} for `--<flag>` switches. */
export function getHyphenatedBoolean(args: unknown, key: string): boolean {
  return Boolean(getHyphenatedArg(args, key));
}

/**
 * Resolve output mode from a synthetic argv array and config defaults.
 * Pure function — no IO. Suitable for unit tests.
 */
export function resolveOutputMode(argv: string[], defaults: OutputDefaults | undefined = {}): OutputMode {
  const format =
    parseOutputFormat(parseFlagValue(argv, "--format")) ?? (defaults?.format as OutputFormat | undefined) ?? "json";

  // `--detail agent` selects the agent projection; the verbosity then stays at
  // the configured default (the projection ignores it).
  const parsedDetail = parseDetailLevel(parseFlagValue(argv, "--detail"));
  const shape: ShapeMode = parsedDetail === "agent" ? "agent" : "human";
  const detail =
    (parsedDetail === "agent" ? undefined : parsedDetail) ?? (defaults?.detail as DetailLevel | undefined) ?? "brief";
  const outputPath = parseFlagValue(argv, "--output");

  return { format, detail, shape, ...(outputPath ? { outputPath } : {}) };
}

let _mode: OutputMode | undefined;

/**
 * Initialize the process-level output mode. Must be called once at startup
 * before any code calls `getOutputMode()`. Subsequent calls overwrite.
 */
export function initOutputMode(argv: string[], defaults: OutputDefaults | undefined = {}): OutputMode {
  _mode = resolveOutputMode(argv, defaults);
  return _mode;
}

/**
 * Read the process-level output mode. Throws if `initOutputMode()` was not
 * called first — that is a programmer error, not a runtime condition.
 */
export function getOutputMode(): OutputMode {
  if (!_mode) {
    throw new Error("OutputMode not initialized. Call initOutputMode() before getOutputMode().");
  }
  return _mode;
}

/**
 * Reset the singleton. Test-only utility.
 */
export function resetOutputMode(): void {
  _mode = undefined;
}
