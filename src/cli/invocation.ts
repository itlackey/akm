// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Single-parse argv normalization (plan §10.7, chunk-9 WI-9.9).
 *
 * Before this module, ~46 `process.argv` read sites were scattered across
 * `src/**` (32 outside `src/cli.ts`), each re-scanning the raw argv array for
 * repeated flags (`parseAllFlagValues`), `--`-passthrough tails (`env run`,
 * `secret run`), or first-occurrence flag values (`parseFlagValue`) — plus a
 * startup MUTATION of the global `process.argv` at `cli.ts:644`. This module
 * normalizes argv into one typed {@link ParsedInvocation} object, minted ONCE
 * by `src/cli.ts` right after its `normalizeShowArgv` rewrite, so every
 * downstream reader shares one parse instead of re-scanning the raw array.
 *
 * Deliberately import-free: this module must never join an import cycle
 * (cycle ratchet, plan §10.7 / chunk-9 D.3), so it depends on nothing but
 * global `process` — no `output/context`, no `core/errors`. The flag-parsing
 * primitives below are intentionally small, self-contained re-implementations
 * of the same algorithms `output/context.ts`'s `parseFlagValue`/
 * `hasBooleanFlag` and (the now-retired) `cli/shared.ts` `parseAllFlagValues`
 * used, kept byte-identical so every converted call site is behavior-
 * preserving.
 *
 * Singleton + fallback semantics (the design decision this module encodes):
 *  - `setParsedInvocation(argv)` is called exactly once, by `src/cli.ts`,
 *    immediately after `process.argv = normalizeShowArgv(process.argv)`. It
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
 *    request-scoped, mirroring how every pre-WI-9.9 leaf site read
 *    `process.argv` fresh at call time. Production code never touches the
 *    fallback path: the real entry point sets the singleton before any
 *    command handler can run.
 *  - `_resetParsedInvocationForTests()` clears an explicitly-set singleton
 *    (symmetry with `resetOutputMode`/`resetConfigCache` in
 *    `tests/_helpers/cli.ts`); no suite currently needs it because the
 *    startup block that calls `setParsedInvocation` never runs under
 *    `bun test`, but it exists so a test that DOES call
 *    `setParsedInvocation` directly can clean up after itself.
 *
 * Also folds three argv re-scanners that pre-dated this module (plan §10.7):
 *  - `parseAllFlagValues` (moved from `cli/shared.ts`) — repeated-flag
 *    collection (`--tag foo --tag bar`), re-exported from `cli/shared.ts` so
 *    every existing importer (feedback-cli, observability-cli, remember-cli,
 *    search-cli, stash-cli, cli.ts) is unaffected.
 *  - `findCittyTopLevelCommand`/`findCittyTopLevelCommandIndex` (moved from
 *    `cli/parse-args.ts`, which had zero internal imports for this cluster) —
 *    re-exported from `cli/parse-args.ts` for `tests/tasks-embedded.test.ts`
 *    and `commands/read/show.ts`.
 *  - `resolveHelpMigrateVersionArg` (moved from `cli.ts`, where it was
 *    private) — the `akm help migrate <version>` positional/flag
 *    disambiguation guard.
 */

// ── Repeated-flag / `--`-passthrough primitives (byte-identical to the
// pre-WI-9.9 per-site implementations they replace) ─────────────────────────

function getFlagValueFrom(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === flag) return argv[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

function hasFlagIn(argv: readonly string[], flag: string): boolean {
  return argv.some((arg) => arg === flag || arg === `${flag}=true`);
}

function getAllFlagValuesFrom(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === flag && i + 1 < argv.length) {
      values.push(argv[i + 1] as string);
      // BUG-M4: skip the value index so `--tag --tag` (literal `--tag` value)
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
 * OR nothing follows it. Callers that previously threw a "Missing command"
 * UsageError on `dashIndex < 0 || dashIndex === argv.length - 1` now check
 * `passthroughArgs().length === 0` — the two conditions are equivalent.
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
 * once, by `src/cli.ts`, right after `normalizeShowArgv` — "normalize argv
 * exactly once at entry" (plan §10.7).
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

// ── Folded re-scanner #1: parseAllFlagValues (moved from cli/shared.ts) ─────

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

// ── Folded re-scanner #2: findCittyTopLevelCommand(Index) (moved from
// cli/parse-args.ts, which had zero internal imports for this cluster) ──────

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

// ── Folded re-scanner #3: resolveHelpMigrateVersionArg (moved from cli.ts,
// where it was a private, unexported function) ──────────────────────────────

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
