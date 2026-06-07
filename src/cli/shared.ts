// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared CLI utilities extracted from `src/cli.ts` so that individual
 * command modules can import them without a circular dependency.
 *
 * Exported: output, runWithJsonErrors, parseAllFlagValues, emitJsonError
 */

import { type ArgsDef, type CommandContext, type CommandDef, defineCommand } from "citty";
import { stringify as yamlStringify } from "yaml";
import { assertNever } from "../core/assert";
import { AkmError } from "../core/errors";
import { getOutputMode, type OutputMode } from "../output/context";
import { shapeForCommand } from "../output/shapes";
import { formatPlain, outputJsonl } from "../output/text";

// ── Exit codes ───────────────────────────────────────────────────────────────
/**
 * Canonical process exit-code table for the akm CLI. Single source of truth —
 * referenced by `classifyExitCode` here and re-imported by `src/cli.ts` so the
 * health-warn / general-failure paths stay in sync.
 *
 *   0  success
 *   1  general / not-found
 *   2  usage error
 *   4  health warn (health command only)
 *  70  internal / unclassified (sysexits EX_SOFTWARE — akm threw unexpectedly)
 *  78  config error
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  GENERAL: 1,
  USAGE: 2,
  HEALTH_WARN: 4,
  // sysexits.h EX_SOFTWARE. Distinct from GENERAL(1) so scripts can tell an
  // expected "not found" outcome from akm itself throwing an unexpected error.
  INTERNAL: 70,
  CONFIG: 78,
} as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Map a thrown value to a process exit code.
 *
 * Known, classified errors (instances of `AkmError`) are dispatched through an
 * exhaustive switch on the `kind` discriminant — `assertNever` makes a missing
 * case a compile-time error, so adding a new error class can't silently inherit
 * the wrong code. Anything that is NOT an `AkmError` is treated as a genuinely
 * unexpected internal failure and maps to INTERNAL(70) rather than GENERAL(1),
 * so callers can distinguish "akm threw" from a normal not-found outcome.
 */
function classifyExitCode(error: unknown): number {
  if (!(error instanceof AkmError)) return EXIT_CODES.INTERNAL;
  switch (error.kind) {
    case "usage":
      return EXIT_CODES.USAGE;
    case "config":
      return EXIT_CODES.CONFIG;
    case "not-found":
      return EXIT_CODES.GENERAL;
    default:
      return assertNever(error.kind, "classifyExitCode");
  }
}

function extractHint(error: unknown): string | undefined {
  if (error instanceof Error && "hint" in error && typeof (error as { hint: unknown }).hint === "function") {
    return (error as { hint: () => string | undefined }).hint();
  }
  return undefined;
}

/**
 * Serialize an error to the standard JSON envelope and exit.
 * Used in both the startup try/catch and `runWithJsonErrors`.
 */
export function emitJsonError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const hint = extractHint(error);
  const exitCode = classifyExitCode(error);
  // Classified akm errors carry a stable machine-readable `code`; unexpected
  // internal errors have none.
  const code = error instanceof AkmError ? error.code : undefined;
  console.error(JSON.stringify({ ok: false, error: message, ...(code ? { code } : {}), hint }, null, 2));
  process.exit(exitCode);
}

/**
 * Run an async function and route any thrown error through the standard JSON
 * error envelope so users never see a raw stack trace.
 */
export async function runWithJsonErrors(fn: (() => void) | (() => Promise<void>)): Promise<void> {
  try {
    await fn();
  } catch (error: unknown) {
    emitJsonError(error);
  }
}

/**
 * A citty command whose `run` body is the plain command logic — any thrown
 * error is routed through the standard JSON envelope automatically. This is the
 * inverse of hand-writing `run() { return runWithJsonErrors(() => { ... }); }`
 * at every site (123 such sites at WS6 baseline).
 */
export type JsonCommandDef<T extends ArgsDef = ArgsDef> = Omit<CommandDef<T>, "run"> & {
  /** Command body. Throw to emit the JSON error envelope + mapped exit code. */
  run?: (context: CommandContext<T>) => void | Promise<void>;
};

/**
 * Define a citty command whose `run` body is automatically wrapped in
 * `runWithJsonErrors`, so the handler emits a byte-identical JSON error
 * envelope (stdout/stderr/exit-code) on throw without the boilerplate. A
 * command without a `run` (a pure subcommand group) is passed through
 * unchanged.
 */
export function defineJsonCommand<const T extends ArgsDef = ArgsDef>(def: JsonCommandDef<T>): CommandDef<T> {
  const { run, ...rest } = def;
  if (!run) return defineCommand({ ...rest } as CommandDef<T>);
  return defineCommand({
    ...rest,
    run: (context: CommandContext<T>) => runWithJsonErrors(() => run(context)),
  } as CommandDef<T>);
}

/**
 * Render a command result according to the active output mode (json/jsonl/yaml/text).
 */
export function output(command: string, result: unknown): void {
  const mode: OutputMode = getOutputMode();
  const shaped = shapeForCommand(command, result, mode.detail, mode.shape);

  if (mode.format === "jsonl") {
    outputJsonl(command, shaped);
    return;
  }

  switch (mode.format) {
    case "json":
      console.log(JSON.stringify(shaped, null, 2));
      return;
    case "yaml":
      console.log(yamlStringify(shaped));
      return;
    case "text": {
      const plain = formatPlain(command, shaped, mode.detail);
      console.log(plain ?? JSON.stringify(shaped, null, 2));
      return;
    }
    case "md":
      // `--format md` is currently only consumed by `akm health` for the
      // per-run / window-compare table renderings. Commands that don't
      // implement an md renderer fall back to the JSON envelope so
      // pipelines never get an empty stdout.
      console.log(JSON.stringify(shaped, null, 2));
      return;
  }
}

/**
 * Collect all occurrences of a repeatable flag from process.argv.
 * Citty's StringArgDef only exposes the last value when a flag is repeated,
 * so for repeatable CLI args (like `--tag foo --tag bar`) we read argv directly.
 * Supports both `--flag value` and `--flag=value` forms.
 */
export function parseAllFlagValues(flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === flag && i + 1 < process.argv.length) {
      values.push(process.argv[i + 1] as string);
      // BUG-M4: skip the value index so `--tag --tag` (literal `--tag`
      // value) does not double-count the second `--tag` as a separate
      // flag occurrence.
      i++;
    } else if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1));
    }
  }
  return values;
}
