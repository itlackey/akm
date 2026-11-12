// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One stderr line per process when a command or flag that STABILITY.md marks
 * Deprecated is used and its replacement exists in this build. Stdout, JSON and
 * exit codes are unchanged, and `--quiet` silences it (it goes through `warnOnce`).
 * A deprecation whose replacement is not built yet has no row here.
 *
 * Not printed for akm's own invocations: the scheduler's `task run --scheduled`
 * and commands run by a task, improve or audit (their `AKM_EVENT_SOURCE`).
 */

import { type ArgsDef, parseArgs } from "citty";
import { warnOnce } from "../core/warn";
import type { ParsedInvocation } from "./invocation";

interface Deprecation {
  /** The resolved command path; empty matches every command. */
  path: readonly string[];
  /** Narrow to one flag, and for `value` that flag's value. */
  flag?: string;
  value?: string;
  /** Needs at least one positional ref (a no-ref form has no replacement). */
  needsRef?: boolean;
  /** What to use instead; absent when the flag is removed in 0.11 with no replacement. */
  use?: string;
}

// First match wins, so commands come before flags.
const DEPRECATIONS: readonly Deprecation[] = [
  { path: ["health"], use: "`akm doctor`" },
  { path: ["metrics"], use: "`akm doctor metrics`" },
  { path: ["info"], use: "`akm doctor info`" },
  { path: ["log"], use: "`akm doctor log`" },
  { path: ["judge"], use: "`akm doctor judge`" },
  { path: ["improve", "judge"], use: "`akm doctor judge`" },
  { path: ["task", "history"], use: "`akm doctor log --task <id>`" },
  { path: ["improve", "report"], use: "`akm doctor metrics improve`" },
  { path: ["search"], flag: "--by-usage", use: "`akm doctor metrics assets`" },
  { path: ["workflow", "run"], use: "`akm run <ref>`" },
  { path: ["agent"], needsRef: true, use: "`akm run <ref>`" },
  { path: ["command", "run"], use: "`akm run <ref>`" },
  { path: ["command"], needsRef: true, use: "`akm run <ref>`" },
  { path: ["task", "run"], use: "`akm run <qualified-task-ref>`" },
  { path: ["task", "sync"], use: "`akm doctor scheduler sync`" },
  { path: ["task", "doctor"], use: "`akm doctor`" },
  { path: ["task", "explain"], use: "`akm doctor explain <ref>`" },
  { path: ["workflow", "plan"], use: "`akm doctor explain <ref>`" },
  { path: ["task", "add"], use: "`akm import <file> --type task`" },
  { path: ["clone"], use: "`akm import <ref> --asset-ref`" },
  { path: ["improve"], flag: "--show-prompt", use: "`akm doctor prompt`" },
  { path: ["curate"], flag: "--pack", use: "`--max-tokens`" },
  { path: ["search"], flag: "--include-proposed", use: "`--include quality=proposed`" },
  { path: ["search"], flag: "--include-sessions", use: "`--include type=session`" },
  { path: ["show"], flag: "--detail", value: "brief", use: "`--outline`" },
  { path: ["show"], flag: "--context", value: "lead", use: "`--lead`" },
  {
    path: ["improve"],
    flag: "--require-feedback-signal",
    use: "a strategy with `processes.proactiveMaintenance.enabled: false`, selected with `--strategy`",
  },
  { path: ["proposal", "extract"], flag: "--type", use: "`--sessions`" },
  { path: ["remember"], flag: "--auto" },
  { path: ["remember"], flag: "--enrich" },
  { path: ["remember"], flag: "--show-similar" },
];

const INTERNAL_SOURCES = new Set(["task", "improve", "audit"]);

export function warnDeprecatedUse(
  commandPath: readonly string[],
  invocation: ParsedInvocation,
  leafArgs: ArgsDef | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (INTERNAL_SOURCES.has(env.AKM_EVENT_SOURCE ?? "")) return;
  if (invocation.hasFlag("--help") || invocation.hasFlag("-h") || invocation.hasFlag("--scheduled")) return;
  const positionals = positionalsOf(invocation, leafArgs);
  // An unknown subcommand (`akm log tail`) is a usage error, not a use of the command.
  if (positionals.length > commandPath.length && !Object.values(leafArgs ?? {}).some((a) => a.type === "positional")) {
    return;
  }
  const joined = commandPath.join(" ");
  const hit = DEPRECATIONS.find((row) => {
    if (row.path.length > 0 && row.path.join(" ") !== joined) return false;
    if (row.flag !== undefined) {
      if (row.value === undefined ? !invocation.hasFlag(row.flag) : invocation.getFlagValue(row.flag) !== row.value) {
        return false;
      }
    }
    return !row.needsRef || positionals.length > commandPath.length;
  });
  if (!hit) return;
  const what = hit.flag ? `${hit.flag}${hit.value ? ` ${hit.value}` : ""}` : `akm ${joined}`;
  warnOnce(
    "deprecated-use",
    hit.use
      ? `[deprecated] ${what} is deprecated and is removed in 0.11: use ${hit.use}. See STABILITY.md.`
      : `[deprecated] ${what} is deprecated and is removed in 0.11, with no replacement flag. See STABILITY.md.`,
  );
}

function positionalsOf(invocation: ParsedInvocation, leafArgs: ArgsDef | undefined): string[] {
  try {
    return parseArgs([...invocation.userArgs], leafArgs ?? {})._.map(String);
  } catch {
    return [];
  }
}
