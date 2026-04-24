/**
 * Process-level output mode singleton.
 *
 * Output mode (format + detail + forAgent) is parsed once at startup from
 * `process.argv` and the persisted user config. All subsequent `output()`
 * calls read from this in-memory singleton instead of re-scanning argv and
 * re-loading config on every call.
 *
 * Initialized from `cli.ts` before `runMain`.
 */

import { UsageError } from "./errors";

export type OutputFormat = "json" | "yaml" | "text" | "jsonl";
export type DetailLevel = "brief" | "normal" | "full" | "summary" | "agent";

export interface OutputMode {
  format: OutputFormat;
  detail: DetailLevel;
  forAgent: boolean;
}

export interface OutputDefaults {
  format?: OutputFormat | "json" | "yaml" | "text";
  detail?: DetailLevel | "brief" | "normal" | "full" | "agent";
}

export const OUTPUT_FORMATS: OutputFormat[] = ["json", "yaml", "text", "jsonl"];
export const DETAIL_LEVELS: DetailLevel[] = ["brief", "normal", "full", "summary", "agent"];

export function parseOutputFormat(value: string | undefined): OutputFormat | undefined {
  if (!value) return undefined;
  if ((OUTPUT_FORMATS as string[]).includes(value)) return value as OutputFormat;
  throw new UsageError(`Invalid value for --format: ${value}. Expected one of: ${OUTPUT_FORMATS.join("|")}`);
}

export function parseDetailLevel(value: string | undefined): DetailLevel | undefined {
  if (!value) return undefined;
  if ((DETAIL_LEVELS as string[]).includes(value)) return value as DetailLevel;
  throw new UsageError(`Invalid value for --detail: ${value}. Expected one of: ${DETAIL_LEVELS.join("|")}`);
}

export function parseFlagValue(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === flag) return argv[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

export function hasBooleanFlag(argv: string[], flag: string): boolean {
  return argv.some((arg) => arg === flag || arg === `${flag}=true`);
}

/**
 * Read a hyphenated arg out of citty's parsed `args` object.
 *
 * citty does not auto-camelise hyphenated arg keys (see `--max-pages`,
 * `--with-sources` for the existing convention), so command handlers end up
 * casting `args` to a string-indexed record at every read site. This helper
 * encapsulates the cast.
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
  const detail =
    parseDetailLevel(parseFlagValue(argv, "--detail")) ?? (defaults?.detail as DetailLevel | undefined) ?? "brief";
  // `--detail=agent` is the preferred preset. `--for-agent` is kept for one
  // release cycle as an alias so existing scripts and docs keep working.
  const forAgent = detail === "agent" || hasBooleanFlag(argv, "--for-agent");
  return { format, detail, forAgent };
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
