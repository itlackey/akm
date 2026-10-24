// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Single-parse argv normalization.
 *
 * This module normalizes argv into one typed {@link ParsedInvocation} object,
 * minted ONCE by `src/cli.ts` at startup, so every downstream reader (repeated
 * flags, `--`-passthrough tails such as `env run` / `secret run`,
 * first-occurrence flag values) shares one parse instead of re-scanning the
 * raw `process.argv` array.
 *
 * Deliberately import-free: this module must never join an import cycle
 * (cycle ratchet), so it depends on nothing but global `process` — no
 * `output/context`, no `core/errors`. The flag-parsing primitives below are
 * intentionally small, self-contained implementations of the same algorithms
 * as `output/context.ts`'s `parseFlagValue`/`hasBooleanFlag`.
 * `getAllFlagValuesFrom` stops at a literal `--` separator instead of
 * scanning past it, so a repeatable flag's value placed after `--` (meant to
 * end flag parsing) is not read as a real flag occurrence. See that
 * function's docstring.
 *
 * Singleton + fallback semantics (the design decision this module encodes):
 *  - `setParsedInvocation(argv)` is called exactly once, by `src/cli.ts`, in
 *    its startup block before any command handler can run. It
 *    snapshots that argv into an immutable {@link ParsedInvocation} that
 *    every subsequent `getParsedInvocation()` call returns unchanged for the
 *    rest of the process lifetime — "normalize argv exactly once at entry".
 *  - `getParsedInvocation()` is the ONLY way leaf command modules read
 *    invocation state. When the singleton was never set — the common case
 *    for unit tests that call command logic directly, and for
 *    `tests/_helpers/cli.ts`'s in-process CLI harness, which drives citty's
 *    `runCommand` WITHOUT running `src/cli.ts`'s `import.meta.main` startup
 *    block (see that file's docstring) — it falls back to parsing the
 *    CURRENT `process.argv` fresh, on every call, uncached. That harness
 *    mutates `process.argv` itself per invocation and restores it in
 *    `finally`, and many suites issue several back-to-back in-process runs
 *    per test; caching the fallback parse would leak one run's flags into
 *    the next. So "lazily parses process.argv once" means "once PER CALL",
 *    not "once for the life of the process" — the fallback is intentionally
 *    request-scoped. Production code never touches the
 *    fallback path: the real entry point sets the singleton before any
 *    command handler can run.
 *  - `_resetParsedInvocationForTests()` clears an explicitly-set singleton
 *    (symmetry with `resetOutputMode`/`resetConfigCache` in
 *    `tests/_helpers/cli.ts`); no suite currently needs it because the
 *    startup block that calls `setParsedInvocation` never runs under
 *    `bun test`, but it exists so a test that DOES call
 *    `setParsedInvocation` directly can clean up after itself.
 *
 * Also hosts three argv scanners:
 *  - `parseAllFlagValues` — repeated-flag collection (`--tag foo --tag bar`),
 *    re-exported from `cli/shared.ts`.
 *  - `findCittyTopLevelCommand`/`findCittyTopLevelCommandIndex` — re-exported
 *    from `cli/parse-args.ts`.
 *  - `resolveHelpMigrateVersionArg` — the `akm help migrate <version>`
 *    positional/flag disambiguation guard.
 */

// ── Repeated-flag / `--`-passthrough primitives ─────────────────────────────

function getFlagValueFrom(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break;
    if (arg === flag) return argv[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

function hasFlagIn(argv: readonly string[], flag: string): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === flag || arg === `${flag}=true`) return true;
  }
  return false;
}

/**
 * Collect every `--flag value` / `--flag=value` occurrence, stopping at a
 * literal `--` separator. `--` conventionally ends flag parsing —
 * everything after it is positional/passthrough, never a flag akm should
 * interpret. A token like `--tag leaked:yes` placed AFTER `--` (e.g.
 * `akm feedback <ref> --positive -- --tag leaked:yes`) is therefore not
 * picked up as a `--tag` value, so argv content past the boundary cannot leak
 * into structured output.
 */
function getAllFlagValuesFrom(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break;
    if (arg === flag && i + 1 < argv.length) {
      values.push(argv[i + 1] as string);
      // Skip the value index so `--tag --tag` (literal `--tag` value)
      // does not double-count the second `--tag` as a separate flag occurrence.
      i++;
    } else if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1));
    }
  }
  return values;
}

/**
 * Tokens after a literal `--` marker in argv, or `[]` when there is no `--`
 * OR nothing follows it. Callers that throw a "Missing command" UsageError
 * when there is nothing to pass through check `passthroughArgs().length === 0`
 * (equivalent to `dashIndex < 0 || dashIndex === argv.length - 1`).
 */
function passthroughArgsFrom(argv: readonly string[]): string[] {
  const dashIndex = argv.indexOf("--");
  if (dashIndex < 0 || dashIndex === argv.length - 1) return [];
  return argv.slice(dashIndex + 1);
}

// ── ParsedInvocation ─────────────────────────────────────────────────────────

export interface ParsedInvocation {
  /** Full argv snapshot at parse time (runtime + script path + user args). */
  readonly argv: readonly string[];
  /** `argv.slice(2)` — user-supplied tokens only, no runtime/script path. */
  readonly userArgs: readonly string[];
  /** First occurrence of `--flag value` or `--flag=value` (undefined if absent). */
  getFlagValue(flag: string): string | undefined;
  /** True when `--flag` or `--flag=true` appears anywhere in argv. */
  hasFlag(flag: string): boolean;
  /** Every occurrence of a repeatable `--flag value` / `--flag=value` pair, in order. */
  getAllFlagValues(flag: string): string[];
  /** Tokens after a literal `--` marker, or `[]` when absent / nothing follows. */
  passthroughArgs(): string[];
}

function createParsedInvocation(argv: readonly string[]): ParsedInvocation {
  const snapshot: readonly string[] = Object.freeze([...argv]);
  const userArgs: readonly string[] = Object.freeze(snapshot.slice(2));
  return {
    argv: snapshot,
    userArgs,
    getFlagValue: (flag) => getFlagValueFrom(snapshot, flag),
    hasFlag: (flag) => hasFlagIn(snapshot, flag),
    getAllFlagValues: (flag) => getAllFlagValuesFrom(snapshot, flag),
    passthroughArgs: () => passthroughArgsFrom(snapshot),
  };
}

let _invocation: ParsedInvocation | undefined;

/**
 * Mint the process-wide {@link ParsedInvocation} singleton. Called exactly
 * once, by `src/cli.ts`, at startup — "normalize argv exactly once at entry".
 */
export function setParsedInvocation(argv: readonly string[]): ParsedInvocation {
  _invocation = createParsedInvocation(argv);
  return _invocation;
}

/**
 * Read the process-wide {@link ParsedInvocation}. Returns the singleton set
 * by `setParsedInvocation` when one exists; otherwise falls back to parsing
 * the CURRENT `process.argv` fresh (uncached — see the module docstring for
 * why caching the fallback would be wrong). The fallback is what every
 * leaf-command unit test and `tests/_helpers/cli.ts`'s in-process harness
 * exercise; production CLI runs always hit the singleton.
 */
export function getParsedInvocation(): ParsedInvocation {
  if (_invocation) return _invocation;
  return createParsedInvocation(process.argv);
}

/** Test-only: clear an explicitly-set singleton. Symmetry with resetOutputMode/resetConfigCache. */
export function _resetParsedInvocationForTests(): void {
  _invocation = undefined;
}

// ── parseAllFlagValues ──────────────────────────────────────────────────────

/**
 * Collect all occurrences of a repeatable flag from the current invocation's
 * argv. Citty's StringArgDef only exposes the last value when a flag is
 * repeated, so for repeatable CLI args (like `--tag foo --tag bar`) callers
 * read argv directly via this helper. Supports both `--flag value` and
 * `--flag=value` forms.
 */
export function parseAllFlagValues(flag: string): string[] {
  return getParsedInvocation().getAllFlagValues(flag);
}

// ── findCittyTopLevelCommand(Index) ─────────────────────────────────────────

export interface CittyArgDefinitionForScan {
  readonly type?: string;
  readonly alias?: string | readonly string[];
}

export type CittyArgsDefinitionForScan = Record<string, CittyArgDefinitionForScan>;

/** citty compares `foo-bar` and `fooBar` as the same arg name. */
export function cittyComparableName(name: string): string {
  return name.replace(/[-_]+([a-zA-Z0-9])/g, (_match, char: string) => char.toUpperCase());
}

export function toAliasArray(alias: CittyArgDefinitionForScan["alias"]): readonly string[] {
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
    const arg = rawArgs[i]!;
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

// ── resolveHelpMigrateVersionArg ────────────────────────────────────────────

/**
 * Guard against citty consuming a global flag value as the `help migrate`
 * version positional (mirrors `resolveRememberContentArg` /
 * `wasFormatValueConsumedAsName` in the read/sources leaf modules).
 *
 * When the user runs `akm help migrate --format json` without a version
 * argument, citty may assign `"json"` to the `version` positional. This
 * detects that case and returns `undefined` so the caller surfaces the
 * "missing version" UsageError instead of treating a flag value as a version.
 */
export function resolveHelpMigrateVersionArg(version: string | undefined): string | undefined {
  if (version === undefined) return undefined;

  const invocation = getParsedInvocation();

  const parsedFormat = invocation.getFlagValue("--format");
  if (
    parsedFormat !== undefined &&
    version === parsedFormat &&
    wasHelpMigrateFlagValueConsumedAsVersion(version, parsedFormat, "--format")
  ) {
    return undefined;
  }

  const parsedDetail = invocation.getFlagValue("--detail");
  if (
    parsedDetail !== undefined &&
    version === parsedDetail &&
    wasHelpMigrateFlagValueConsumedAsVersion(version, parsedDetail, "--detail")
  ) {
    return undefined;
  }

  return version;
}

function wasHelpMigrateFlagValueConsumedAsVersion(
  version: string,
  flagValue: string,
  flagName: "--format" | "--detail",
): boolean {
  const argv = getParsedInvocation().userArgs;
  const helpIndex = argv.indexOf("help");
  const tokens = helpIndex >= 0 ? argv.slice(helpIndex + 1) : argv;
  const migrateIndex = tokens.indexOf("migrate");
  const relevant = migrateIndex >= 0 ? tokens.slice(migrateIndex + 1) : tokens;

  let flagIndex = -1;
  for (let i = 0; i < relevant.length; i += 1) {
    const token = relevant[i];
    if (token === flagName || token === `${flagName}=${flagValue}`) {
      flagIndex = i;
      break;
    }
  }

  if (flagIndex === -1) return false;
  if (relevant.slice(0, flagIndex).includes(version)) return false;
  return relevant[flagIndex] === flagName ? relevant[flagIndex + 1] === version : true;
}
