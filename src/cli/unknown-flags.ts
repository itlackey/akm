// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reject flags the resolved command does not declare.
 *
 * citty (0.2.x) parses argv with `node:util`'s parseArgs in non-strict mode
 * (`strict: false`), so an undeclared flag is collected into the parsed object
 * and silently ignored by the handler. Nothing
 * downstream noticed, so `akm lint --fail-on-flaged` (one transposed letter in
 * the flag STABILITY.md documents as a CI contract) parsed fine, exited 0, and
 * the gate it was meant to enforce never fired. Same for `--limt 3`, `--jsn`,
 * and every other typo — the command ran with the default instead, and the user
 * had no signal.
 *
 * This walks the same subcommand path citty resolves (via the shared scan
 * helpers in `./invocation`), unions the arg definitions declared along it,
 * and fails a flag that matches nothing. The union (rather than the leaf's
 * args alone) is deliberate: parent-level flags may legally appear before the
 * subcommand token, and a false positive here would reject a VALID invocation
 * — much worse than the silence it replaces. In the same spirit, everything
 * after a literal `--` is passthrough, a declared value flag's value is never
 * scanned as a flag, `--no-<name>` resolves against `<name>`, and a bare `-`
 * (stdin convention) and negative numbers are left alone. A subcommand invoked
 * by a `meta.name` alias rather than its key takes the stand-down path (no
 * validation) — conservative by design.
 */

import { UsageError } from "../core/errors";
import {
  type CittyArgsDefinitionForScan,
  cittyComparableName,
  findCittyTopLevelCommandIndex,
  toAliasArray,
} from "./invocation";
import { retiredFlagHint } from "./retired-commands";

/** The structural subset of a citty command this module reads. */
export interface FlagScanCommand {
  readonly args?: Record<string, { readonly type?: string; readonly alias?: string | readonly string[] }>;
  readonly subCommands?: Record<string, FlagScanCommand> | undefined;
}

/** Flags citty implements itself, which no command declares. */
const IMPLICIT_FLAGS = ["help", "h", "version", "v"];

/**
 * Retired flags whose commands still diagnose them THEMSELVES, with a message
 * that names the replacement ("`--scope` was removed, use `--filter`",
 * "`--source` was renamed to `--generator`"). A generic "unknown flag" would
 * preempt the better diagnosis, so these are passed through — but ONLY on the
 * command path that owns the diagnostic, keyed by the resolved path. On every
 * other command the same spelling is a genuine typo and still fails fast
 * A retired flag is rejected everywhere else, where silently dropping it could
 * run a real mutation.
 *
 * Shrink-only: when a command drops its bespoke diagnostic, drop the entry and
 * the generic error takes over.
 */
const SELF_DIAGNOSED_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries({
    show: ["akmView", "scope"], // removed view grammar; --scope points at --filter
    index: ["enrich", "re-enrich"], // removed index-time enrichment flags
    "proposal accept": ["source"], // renamed to --generator
    "proposal reject": ["source"], // renamed to --generator
    "proposal drain": ["profile"], // retired, points at --strategy
    search: ["source"], // renamed to --from
    curate: ["source"], // renamed to --from
    "task list": ["source"], // renamed to --from (alias of `search --type task`, #951)
    remember: ["target"], // renamed to --bundle
    clone: ["target"], // renamed to --bundle
    improve: ["auto-accept", "target"], // retired in 0.9.0 / renamed to --bundle
    "task add": ["target"], // renamed to --bundle
    "task run": ["target"], // renamed to --bundle
    "task history": ["target"], // renamed to --bundle
    "task sync": ["target"], // renamed to --bundle
  }).map(([path, flags]) => [path, new Set(flags.map(cittyComparableName))]),
);

interface KnownArgs {
  /** Every accepted flag spelling, in comparable form. */
  readonly names: ReadonlySet<string>;
  /** Comparable names of flags that consume the following token as a value. */
  readonly valueFlags: ReadonlySet<string>;
  /** Comparable names of boolean flags — the only ones `--no-` may negate. */
  readonly booleanFlags: ReadonlySet<string>;
  /** Human-readable spellings, for the did-you-mean suggestion. */
  readonly displayNames: readonly string[];
  /** Resolved command path tokens (e.g. ["proposal", "accept"]). */
  readonly path: readonly string[];
  /**
   * False when the command path did not fully resolve — an unknown command
   * token, or a group with no subcommand given. citty's own UNKNOWN_COMMAND /
   * "no command specified" is the better error in both cases, so flag
   * validation stands down rather than reporting a flag error for what is
   * really a command error.
   */
  readonly resolved: boolean;
}

/**
 * Union the arg definitions declared along the resolved command path. The
 * subcommand walk delegates to {@link findCittyTopLevelCommandIndex} — the
 * same scan `src/cli.ts` resolves commands with — so both agree on which
 * token is the subcommand name.
 */
function collectKnownArgs(root: FlagScanCommand, rawArgs: readonly string[]): KnownArgs {
  const names = new Set<string>(IMPLICIT_FLAGS.map(cittyComparableName));
  const valueFlags = new Set<string>();
  const booleanFlags = new Set<string>();
  const displayNames: string[] = [];
  const path: string[] = [];

  let cmd: FlagScanCommand = root;
  let args: readonly string[] = rawArgs;
  for (;;) {
    for (const [key, def] of Object.entries(cmd.args ?? {})) {
      // Positionals are not flags; including them would accept `--<positional>`.
      if (def.type === "positional") continue;
      const comparable = cittyComparableName(key);
      // Shared args (GLOBAL_OUTPUT_ARGS) recur at every level; suggest each once.
      if (!names.has(comparable)) {
        names.add(comparable);
        displayNames.push(`--${key}`);
      }
      if (def.type === "string" || def.type === "enum") valueFlags.add(comparable);
      if (def.type === "boolean") booleanFlags.add(comparable);
      for (const alias of toAliasArray(def.alias)) {
        names.add(cittyComparableName(alias));
        if (def.type === "string" || def.type === "enum") valueFlags.add(cittyComparableName(alias));
        if (def.type === "boolean") booleanFlags.add(cittyComparableName(alias));
      }
    }

    const subCommands = cmd.subCommands;
    if (!subCommands || Object.keys(subCommands).length === 0) break;
    const idx = findCittyTopLevelCommandIndex(args, (cmd.args ?? {}) as CittyArgsDefinitionForScan);
    const token = idx >= 0 ? args[idx] : undefined;
    // A group with no subcommand token: citty reports "no command specified".
    if (token === undefined) return { names, valueFlags, booleanFlags, displayNames, path, resolved: false };
    const sub = subCommands[token];
    // An unrecognized token: citty reports the unknown command, which is the
    // real problem — its flags are beside the point.
    if (!sub) return { names, valueFlags, booleanFlags, displayNames, path, resolved: false };
    path.push(token);
    cmd = sub;
    args = args.slice(idx + 1);
  }

  return { names, valueFlags, booleanFlags, displayNames, path, resolved: true };
}

/** Single-row-at-a-time edit-distance DP (inputs are short flag/command names). */
function editDistance(a: string, b: string): number {
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Closest candidate within `threshold` edit distance, or undefined when
 * nothing is close enough to be worth suggesting. Shared by the unknown-flag
 * and unknown-command (src/cli.ts) did-you-mean paths, which pick different
 * thresholds.
 */
export function closestMatch(attempted: string, candidates: readonly string[], threshold: number): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(attempted, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best !== undefined && bestDistance <= threshold ? best : undefined;
}

/**
 * The one unknown-flag rejection, shared by the short- and long-flag scans so
 * the user-facing error contract cannot drift between them. No explicit hint
 * when there is no suggestion — UNKNOWN_FLAG's canned hint (core/errors.ts)
 * already says to run the command with --help.
 *
 * @param shown      The flag as the user typed it (dashes, no `=value`).
 * @param attempted  The spelling to edit-distance against `--long` candidates.
 */
function throwUnknownFlag(shown: string, attempted: string, known: KnownArgs): never {
  // Flags the 0.9 overhaul removed outright get their retirement note, not a
  // did-you-mean — same reasoning as `retiredCommandHint` in src/cli.ts:
  // edit distance can point at an unrelated survivor rather than the real
  // replacement procedure (e.g. `index --background` is closer to no other
  // `index` flag than it is to any useful suggestion).
  const retired = retiredFlagHint(known.path, attempted);
  if (retired) {
    throw new UsageError(`Unknown flag "${shown}".`, "UNKNOWN_FLAG", retired);
  }
  const threshold = Math.max(2, Math.ceil(attempted.length / 3));
  const suggestion = closestMatch(attempted, known.displayNames, threshold);
  throw new UsageError(
    `Unknown flag "${shown}".`,
    "UNKNOWN_FLAG",
    suggestion
      ? `Did you mean \`${suggestion}\`? Run the command with \`--help\` to see its accepted flags.`
      : undefined,
  );
}

/**
 * Throw a {@link UsageError} naming the first flag the resolved command does
 * not declare. Returns silently when every flag is known.
 */
export function assertKnownFlags(root: FlagScanCommand, rawArgs: readonly string[]): void {
  const passthroughAt = rawArgs.indexOf("--");
  const ownArgs = passthroughAt === -1 ? rawArgs : rawArgs.slice(0, passthroughAt);
  const known = collectKnownArgs(root, rawArgs);
  if (!known.resolved) return;
  // `workflow run`, `task run`, and `task explain` each own one deliberately
  // dynamic namespace: long options become exact-name parameter/input flags
  // and are checked against the frozen plan / task source's own contract
  // before this gate would otherwise reject them (spec
  // docs/plans/specs/p2a-task-source-v4.md §5.1 — task run's
  // UNKNOWN_FLAG/INPUT_BINDING_INVALID must be raised from INSIDE the command
  // body, where runWithJsonErrors renders the JSON envelope, not from this
  // generic pre-dispatch gate; docs/plans/specs/p2b-input-bindings.md §4.5,
  // B-55 — `task explain` reuses the identical `parseTaskInputFlags`
  // scanner, so it needs the identical exemption).
  const dynamicNamedFlagCommands = new Set(["workflow run", "task run", "task explain"]);
  const dynamicWorkflowParams = dynamicNamedFlagCommands.has(known.path.join(" "));
  const selfDiagnosed = SELF_DIAGNOSED_FLAGS.get(known.path.join(" "));

  for (let i = 0; i < ownArgs.length; i += 1) {
    const token = ownArgs[i] as string;
    // Not a flag: positional, a bare `-` (stdin), or a negative number.
    if (!token.startsWith("-") || token === "-" || /^-\d/.test(token)) continue;

    // Node's util.parseArgs, which citty delegates to, treats one-dash tokens
    // as bundled short flags. Boolean aliases may be combined (`-qy`), while a
    // string alias consumes the remainder (`-mhello`) or the following token.
    // It never treats `-auto-fix` as the long `auto-fix` option.
    if (!token.startsWith("--")) {
      const shortFlags = token.slice(1);
      for (let offset = 0; offset < shortFlags.length; offset += 1) {
        const rawName = shortFlags[offset] as string;
        const candidate = cittyComparableName(rawName);
        if (!known.names.has(candidate)) throwUnknownFlag(token, `-${rawName}`, known);
        if (known.valueFlags.has(candidate)) {
          if (offset === shortFlags.length - 1) i += 1;
          break;
        }
      }
      continue;
    }

    const withoutDashes = token.replace(/^-{1,2}/, "");
    const [rawName = ""] = withoutDashes.split("=", 1);
    const hasInlineValue = withoutDashes.includes("=");
    // `--no-foo` is citty's negation of the BOOLEAN `--foo`. Resolving it
    // against a value flag would accept `--no-limit`, which citty's own `--no-`
    // preprocessing force-sets to `limit: false` (no type check, before
    // parseArgs runs) — a boolean reaching a string parser, i.e. an internal
    // error (exit 70) instead of the usage error (exit 2) this is here to give.
    const negated =
      rawName.startsWith("no-") && known.booleanFlags.has(cittyComparableName(rawName.slice(3)))
        ? rawName.slice(3)
        : undefined;

    const candidates = [cittyComparableName(rawName), ...(negated ? [cittyComparableName(negated)] : [])];
    if (selfDiagnosed !== undefined && candidates.some((name) => selfDiagnosed.has(name))) continue;
    if (!candidates.some((name) => known.names.has(name))) {
      // `workflow run` owns one deliberately dynamic namespace: long options
      // become exact-name workflow parameters and are checked against the
      // frozen plan before a run is inserted. Short flags remain strict.
      if (dynamicWorkflowParams) continue;
      throwUnknownFlag(token.split("=")[0] as string, `--${rawName}`, known);
    }

    // Skip a declared value flag's value so `--reason "--x"` is not scanned.
    if (!hasInlineValue && candidates.some((name) => known.valueFlags.has(name))) i += 1;
  }
}
