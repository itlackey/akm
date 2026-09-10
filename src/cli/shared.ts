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
import { AkmError, UsageError } from "../core/errors";
import { getOutputMode, type OutputMode } from "../output/context";
import { renderGenericHtml, renderGenericMarkdown, renderGenericText } from "../output/generic-render";
import { deliverRendered } from "../output/html-render";
import { getHtmlRendererHandler, getMdRendererHandler } from "../output/render-registry";
import { shapeForCommand } from "../output/shapes";
import { formatPlain, outputJsonl } from "../output/text";
import { parseAllFlagValues } from "./invocation";
import { hasSubcommand } from "./parse-args";

export { parseAllFlagValues };

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
 *  75  transient (sysexits EX_TEMPFAIL — retry shortly; another akm process
 *      holds a lock or is writing state.db right now, not a bad command line)
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
  // sysexits.h EX_TEMPFAIL (#948 addendum). Distinct from USAGE(2): a
  // scheduler or cron wrapper classifies 2 as "fix the command line", but a
  // TransientError means "try again in a few seconds" — a different retry
  // contract callers can branch on.
  TEMPFAIL: 75,
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
    case "transient":
      return EXIT_CODES.TEMPFAIL;
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
 * Serialize an error to the standard JSON envelope and record the mapped
 * exit code. Used in both the startup try/catch and `runWithJsonErrors`.
 *
 * R-067: this used to call `process.exit(exitCode)` directly, which
 * terminates the process synchronously and skips every pending `finally`
 * block up the call stack — including `src/cli.ts`'s own
 * `disposeDispatchResources()` cleanup and citty's per-command `cleanup`
 * hooks. `process.exitCode = exitCode; return;` is equivalent for every
 * caller here: Node/Bun exits with that code once the event loop drains
 * naturally, but cleanup on the way there still runs.
 * `src/commands/improve/extract-cli.ts` already uses this exact pattern for
 * its own non-throw failure signal.
 *
 * Because this no longer throws or exits, it no longer terminates control
 * flow on its own — every call site MUST treat it like a normal return and
 * stop doing further work itself (an explicit `return;` right after the
 * call, same as any other caller of a fallible function). `runWithJsonErrors`
 * below satisfies this for free (this call is its catch block's last
 * statement); `src/cli.ts`'s three direct call sites add the `return;`
 * explicitly.
 */
export function emitJsonError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const hint = extractHint(error);
  const exitCode = classifyExitCode(error);
  // Classified akm errors carry a stable machine-readable `code`; unexpected
  // internal errors have none.
  const code = error instanceof AkmError ? error.code : undefined;
  console.error(JSON.stringify({ ok: false, error: message, ...(code ? { code } : {}), hint }, null, 2));
  process.exitCode = exitCode;
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
 * The global output flags, redeclared on every leaf command.
 *
 * citty parses each command level against only that command's own args, so a
 * flag declared on the root command is UNKNOWN at the leaf — and an unknown
 * flag does not consume its space-separated value, which then falls through as
 * a positional. `akm sync --format json` once synced a bundle named "json",
 * and `akm env unset env:x KEY --format json` once tried to unset a key named
 * "json"; both grew bespoke argv-inspection workarounds. Declaring the flags
 * at the leaf lets the parser consume the value, which is the root-cause fix.
 *
 * These declarations exist for PARSING only. The output mode is still read
 * exactly once, from the invocation singleton at startup — no command body may
 * read these args (that is the same one-parse rule `cli/invocation.ts`
 * documents).
 *
 * These are also the canonical descriptions for the root command's own args
 * (`main.args` in src/cli.ts) — the root spreads this same object rather than
 * redeclaring the text, so root help and leaf help can never drift apart.
 * `format`/`detail` need per-site `default` overrides (root has one, leaves
 * don't — see the one-parse rule above), so those two keys get shallow
 * overrides at the root; the description text itself is never duplicated.
 */
export const GLOBAL_OUTPUT_ARGS = {
  format: { type: "string", description: "Output format: json|jsonl|yaml|text|md|html (global flag)" },
  detail: {
    type: "string",
    description: "Detail level (verbosity): brief|normal|full (global flag).",
  },
  // R-050(c): single-sourced with the root command's own `--shape` help
  // (`main.args.shape` in src/cli.ts, which spreads this object) so the
  // caveat is visible from every leaf's own `--help`, not only the top-level
  // one. `summary` outside `show` falls back to `agent` with a warning
  // (shapeForCommand in src/output/shapes.ts) — `--shape` is a global flag,
  // so a script that passes it to a mixed batch of commands still works.
  shape: {
    type: "string",
    description:
      "Output projection: human|agent|summary (global flag). 'agent' trims to agent-essential fields; " +
      "'summary' only has a dedicated projection on 'akm show' — elsewhere it falls back to 'agent' with a " +
      "warning. Default: human.",
  },
  output: {
    type: "string",
    description: "Write rendered output to a file instead of stdout (all formats except jsonl) (global flag)",
  },
  // S11: surfaced at every leaf (not just the root) so `akm <command> --help`
  // documents them too — they already apply globally, parsed from raw argv
  // by `applyEarlyStderrFlags` in src/cli.ts before citty ever sees them, so
  // declaring them here is documentation, not new parsing behavior. A
  // command with its own same-named arg (e.g. `env path --quiet`) wins the
  // merge in `defineJsonCommand` as usual.
  quiet: {
    type: "boolean",
    alias: "q",
    description:
      "Suppress non-essential stderr output (banners, spinners, progress info) (global flag). " +
      "Safety-critical output is never suppressed: errors and destructive-action confirmation prompts " +
      "always appear regardless of --quiet.",
    default: false,
  },
  verbose: {
    type: "boolean",
    description: "Print per-spec diagnostics to stderr (global flag; also honours AKM_VERBOSE env var).",
    default: false,
  },
} as const satisfies ArgsDef;

/**
 * Define a citty command whose `run` body is automatically wrapped in
 * `runWithJsonErrors`, so the handler emits a byte-identical JSON error
 * envelope (stdout/stderr/exit-code) on throw without the boilerplate. A
 * command without a `run` (a pure subcommand group) is passed through
 * unchanged.
 *
 * Every command defined here also accepts the {@link GLOBAL_OUTPUT_ARGS} so
 * their values are parsed rather than mis-captured as positionals; a command
 * declaring its own arg of the same name wins (e.g. `env path` has its own
 * `quiet`).
 */
export function defineJsonCommand<const T extends ArgsDef = ArgsDef>(def: JsonCommandDef<T>): CommandDef<T> {
  const { run, ...rest } = def;
  const withGlobals = { ...rest, args: { ...GLOBAL_OUTPUT_ARGS, ...rest.args } };
  if (!run) return defineCommand(withGlobals as CommandDef<T>);
  return defineCommand({
    ...withGlobals,
    run: (context: CommandContext<T>) => runWithJsonErrors(() => run(context)),
  } as CommandDef<T>);
}

/**
 * Canonical bare-group behavior (0.9.0 breaking change, owner ruling 12).
 *
 * Before 0.9.0 the twelve `akm <group>` command groups did three different
 * things when invoked with no subcommand: some printed help and exited 1,
 * some ran an implicit default action and exited 0 (e.g. bare `akm graph`
 * silently rendering `graph summary`), and one already raised a structured
 * usage error and exited 2. None of that is discoverable from the exit code
 * alone, and a script that greps stdout for a specific default action broke
 * silently the moment someone reordered subcommands.
 *
 * The canonical choice, applied uniformly: a bare group invocation is a
 * USAGE ERROR — exit 2, the same structured JSON envelope every other usage
 * mistake in this CLI produces (not citty's raw help banner, and not a
 * silent default action). This matches STABILITY.md's documented exit-code
 * table (2 = usage) and the exit code the CLI already used for "unknown
 * command" / "missing required argument" as of the companion 0.9.0 fix.
 *
 * `defaultRun` is now OPTIONAL for exactly this reason: omitting it opts a
 * group into the shared, canonical error below. Passing an explicit
 * `defaultRun` is a deliberate opt-out and should not be added to new groups
 * without a documented reason — see CHANGELOG for the migration note.
 */
function bareGroupUsageError<T extends ArgsDef>(meta: CommandDef<T>["meta"], subcommandSet: Set<string>): never {
  const name =
    typeof meta === "object" && meta !== null && "name" in meta && typeof (meta as { name?: unknown }).name === "string"
      ? (meta as { name: string }).name
      : undefined;
  const usage = name ? `\`akm ${name}\`` : "This command";
  const subcommands = [...subcommandSet].sort().join(", ");
  throw new UsageError(
    `${usage} requires a subcommand. Available: ${subcommands}.`,
    "MISSING_REQUIRED_ARGUMENT",
    `Run \`akm ${name ?? "<command>"} --help\` to see usage for each subcommand.`,
  );
}

/**
 * Define a citty subcommand-group command (env, secret, proposal, tasks, wiki,
 * …) that shares one wiring shape: a `subCommands` map, a routing set
 * DERIVED from that map's keys (so the set can never silently desync from the
 * registered subcommands), and a default body that fires ONLY for the bare
 * group invocation — citty still runs the group body after dispatching a
 * subcommand, so the shared guard short-circuits when `args._[0]` names a
 * registered subcommand.
 *
 * The `defaultRun` body is wrapped in `runWithJsonErrors`, so it emits a
 * byte-identical JSON error envelope on throw — exactly the per-site
 * `run() { return runWithJsonErrors(() => { if (hasSubcommand(...)) return; … }); }`
 * boilerplate this replaces.
 */
export function defineGroupCommand<const T extends ArgsDef = ArgsDef>(def: {
  meta: CommandDef<T>["meta"];
  args?: T;
  // Mirrors citty's own `SubCommandsDef` (Record<string, CommandDef<any>>): the
  // subcommands carry heterogeneous per-command arg shapes, and citty's
  // `CommandDef` is invariant in its arg type, so a narrower element type would
  // reject every concrete subcommand. Same precedent as `src/commands/completions.ts`.
  // biome-ignore lint/suspicious/noExplicitAny: citty command tree uses dynamic shapes
  subCommands: Record<string, CommandDef<any>>;
  /** Omit for the canonical bare-group behavior (see {@link bareGroupUsageError}). */
  defaultRun?: (context: CommandContext<T>) => void | Promise<void>;
}): CommandDef<T> {
  const subcommandSet = new Set(Object.keys(def.subCommands));
  const defaultRun = def.defaultRun ?? (() => bareGroupUsageError<T>(def.meta, subcommandSet));
  return defineCommand({
    meta: def.meta,
    ...(def.args ? { args: def.args } : {}),
    subCommands: def.subCommands,
    run: (context: CommandContext<T>) =>
      runWithJsonErrors(() => {
        if (hasSubcommand(context.args, subcommandSet)) return;
        return defaultRun(context);
      }),
  } as CommandDef<T>);
}

/**
 * Render a command result according to the active output mode
 * (json/jsonl/yaml/text/md/html). When `--output <path>` is set, the rendered
 * document is written to that file instead of stdout (jsonl excepted — it is
 * a line-streaming protocol and always goes to stdout).
 */
/**
 * Emit a result whose success is graded by an exit code. `ok` on the envelope
 * and `process.exitCode` are set from the same value here, so the two cannot
 * disagree (#918); `exitCode` undefined or 0 means success.
 */
export function outputWithExitCode(command: string, result: object, exitCode: number | undefined): void {
  const failed = exitCode !== undefined && exitCode !== EXIT_CODES.SUCCESS;
  output(command, { ...result, ok: !failed });
  if (failed) process.exitCode = exitCode;
}

export function output(command: string, result: unknown): void {
  const mode: OutputMode = getOutputMode();
  const shaped = shapeForCommand(command, result, mode.detail, mode.shape);

  if (mode.format === "jsonl") {
    outputJsonl(command, shaped);
    return;
  }

  switch (mode.format) {
    case "json":
      deliverRendered(JSON.stringify(shaped, null, 2), mode.outputPath);
      return;
    case "yaml":
      deliverRendered(yamlStringify(shaped), mode.outputPath);
      return;
    case "text": {
      // D7 — registry first, generic rendering of the shaped envelope second.
      // Mirrors the md/html fallback immediately below: a command with no
      // registered text formatter used to fall through to
      // `JSON.stringify(shaped, null, 2)`, i.e. silently hand back JSON while
      // claiming `--format text` — the same "wrong format wearing the right
      // flag" bug D7 already closed for md/html. `renderGenericText` (a
      // DISTINCT function from `renderGenericMarkdown` — see its doc comment
      // in src/output/generic-render.ts for why reusing the md renderer here
      // was itself a version of the same bug) renders flat `key=value` text
      // matching the house style already established by registered text
      // formatters like `config list`.
      const plain = formatPlain(command, shaped, mode.detail);
      deliverRendered(plain ?? renderGenericText(command, shaped), mode.outputPath);
      return;
    }
    case "md": {
      // D7 — registry first, generic rendering of the shaped envelope second.
      // No command emits JSON under `--format md` any more: silently handing
      // back the wrong format was the worst of the three behaviours this
      // replaced.
      const rendered = getMdRendererHandler(command)?.(shaped, mode.detail);
      deliverRendered(rendered ?? renderGenericMarkdown(command, shaped), mode.outputPath);
      return;
    }
    case "html": {
      const rendered = getHtmlRendererHandler(command)?.(shaped, mode.detail);
      deliverRendered(rendered ?? renderGenericHtml(command, shaped), mode.outputPath);
      return;
    }
  }
}

// parseAllFlagValues moved to ./invocation (chunk-9 WI-9.9 argv-normalization
// fold); re-exported above so every existing importer of this module is
// unaffected.
