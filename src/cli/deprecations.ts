// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One stderr line per process when a command or flag that STABILITY.md marks
 * Deprecated is used and its replacement exists in this build. Stdout, JSON and
 * exit codes are unchanged, and `--quiet` silences it (it goes through `warnOnce`).
 * A row names its replacement when one exists in this build; a removal with no
 * replacement prints a `note` saying so. A deprecation whose replacement is planned
 * but not yet built has no row here.
 *
 * Not printed for akm's own invocations: the scheduler's `task run --scheduled`
 * and commands run by a task, improve or audit (their `AKM_EVENT_SOURCE`).
 */

import { type ArgsDef, parseArgs } from "citty";
import { deprecationNoticesSuppressed } from "../core/config/deprecated-keys";
import { warnOnce } from "../core/warn";
import { getParsedInvocation, type ParsedInvocation } from "./invocation";

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
  /** Replaces the default "no replacement flag" tail when there is no `use`. */
  note?: string;
}

/** Workflows are removed in 0.11 with nothing to switch to in 0.10 (akm#1096). */
const WORKFLOWS_NOTE = "workflows go in 0.11, and tasks take over their ordered steps";

/** A flag that is accepted so old scripts keep running, and does nothing. */
const NO_EFFECT = "the flag has no effect and can be dropped";

// First match wins, so commands come before flags.
const DEPRECATIONS: readonly Deprecation[] = [
  { path: ["health"], use: "`akm doctor`" },
  { path: ["metrics"], use: "`akm doctor metrics`" },
  { path: ["info"], use: "`akm doctor info`" },
  { path: ["log"], use: "`akm doctor log`" },
  { path: ["judge"], use: "`akm doctor judge`" },
  { path: ["improve", "judge"], use: "`akm doctor judge`" },
  { path: ["task", "history"], needsRef: true, use: "`akm doctor log --task <id>`" },
  { path: ["task", "history"], flag: "--id", use: "`akm doctor log --task <id>`" },
  {
    path: ["task", "history"],
    note: "the cross-task form has no replacement; `akm doctor metrics` gives per-task totals",
  },
  { path: ["improve", "report"], use: "`akm doctor metrics improve`" },
  { path: ["search"], flag: "--by-usage", use: "`akm doctor metrics assets`" },
  ...["run", "plan", "status", "list", "create", "resume", "abandon"].map((sub) => ({
    path: ["workflow", sub],
    note: WORKFLOWS_NOTE,
  })),
  { path: ["agent"], needsRef: true, use: "`akm run <ref>`" },
  { path: ["command", "run"], use: "`akm run <ref>`" },
  { path: ["command"], needsRef: true, use: "`akm run <ref>`" },
  { path: ["task", "run"], use: "`akm run <qualified-task-ref>`" },
  { path: ["task", "sync"], use: "`akm doctor scheduler sync`" },
  { path: ["task", "prune"], use: "`akm doctor scheduler sync --prune`" },
  { path: ["task", "doctor"], use: "`akm doctor`" },
  { path: ["task", "explain"], use: "`akm doctor explain <ref>`" },
  { path: ["task", "add"], flag: "--rebind", use: "`akm doctor scheduler sync --rebind`" },
  { path: ["task", "add"], use: "`akm import <file> --type task`" },
  { path: ["clone"], use: "`akm import <ref> --asset-ref`" },
  { path: ["improve"], flag: "--show-prompt", use: "`akm doctor prompt`" },
  { path: ["curate"], flag: "--pack", use: "`--max-tokens`" },
  { path: ["search"], flag: "--include-proposed", use: "`--include quality=proposed`" },
  { path: ["search"], flag: "--include-sessions", use: "`--include type=session`" },
  { path: ["show"], flag: "--detail", value: "brief", use: "`--outline`" },
  { path: ["show"], flag: "--context", value: "lead", use: "`--lead`" },
  { path: ["show"], flag: "--max-chars", use: "`--max-tokens`" },
  { path: ["lint"], flag: "--auto-fix", use: "`--fix`" },
  { path: ["migrate", "apply"], flag: "--dry-run", use: "`akm migrate status`" },
  {
    path: ["hints"],
    flag: "--detail",
    value: "full",
    use: "`akm hints` (the short guide), `akm help <command>` and the CLI reference",
  },
  ...["search", "show", "curate"].map((command) => ({
    path: [command],
    flag: "--detail",
    value: "agent",
    use: "`--detail normal`",
  })),
  { path: ["bundle", "update"], flag: "--yes", note: NO_EFFECT },
  { path: ["bundle", "update"], flag: "-y", note: NO_EFFECT },
  {
    path: ["registry", "add"],
    flag: "--options",
    note: "its value is stored in config but nothing reads it, so it can be dropped",
  },
  ...[
    ["bundle", "add"],
    ["bundle", "update"],
    ["env", "run"],
  ].map((path) => ({
    path,
    flag: "--allow-dangerous-env-keys",
    note: NO_EFFECT,
  })),
  {
    path: ["improve"],
    flag: "--require-feedback-signal",
    use: "a strategy with `processes.proactiveMaintenance.enabled: false`, selected with `--strategy`",
  },
  { path: ["proposal", "extract"], flag: "--type", use: "`--sessions`" },
  { path: ["remember"], flag: "--auto" },
  { path: ["remember"], flag: "--enrich" },
  { path: ["remember"], flag: "--show-similar" },
  { path: ["upgrade"], flag: "--next", use: "`--channel`" },
  { path: ["proposal", "reject"], flag: "--yes", note: "reject no longer asks for confirmation" },
  { path: ["proposal", "reject"], flag: "-y", note: "reject no longer asks for confirmation" },
  { path: [], flag: "--timeout-ms", use: "`--timeout`" },
  { path: [], flag: "--output", note: "redirect stdout instead (`akm <command> > file`)" },
  { path: [], flag: "--format", value: "yaml", use: "`--format json` (or `--format text`)" },
];

/** Deprecated variables: one notice each when set and in effect for this command. */
const DEPRECATED_ENV: readonly {
  name: string;
  active: (value: string, commandPath: readonly string[], invocation: ParsedInvocation) => boolean;
  use: string;
}[] = [
  {
    name: "AKM_UPGRADE_SKIP_CHECKSUM",
    active: (v, p) => v === "1" && p[0] === "upgrade",
    use: "use `akm upgrade --skip-checksum`",
  },
  { name: "AKM_SQLITE_JOURNAL_MODE", active: (v) => v.trim() !== "", use: "it has no replacement" },
  { name: "AKM_VERBOSE", active: (v) => v.trim() !== "", use: "use `--verbose`" },
  { name: "AKM_DEBUG", active: (v) => v === "1", use: "use `--verbose`" },
  {
    // Read only when a search includes the registries.
    name: "AKM_REGISTRY_URL",
    active: (v, p, i) =>
      v.trim() !== "" && p[0] === "search" && ["registry", "all"].includes(i.getFlagValue("--from") ?? ""),
    use: "use config `registries` (`akm registry add`)",
  },
  {
    name: "AKM_BUNDLE_DIR",
    // Every command that reads the config or a bundle resolves it; the text-only surfaces do not.
    active: (v, p) => v.trim() !== "" && p.length > 0 && !["help", "hints", "completions"].includes(p[0] as string),
    use: "register the bundle (`akm bundle add`) and set `defaultBundle`",
  },
];

export function warnDeprecatedUse(
  commandPath: readonly string[],
  invocation: ParsedInvocation,
  leafArgs: ArgsDef | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (deprecationNoticesSuppressed((flag) => invocation.hasFlag(flag), env)) return;
  for (const row of DEPRECATED_ENV) {
    const value = env[row.name];
    if (value !== undefined && row.active(value, commandPath, invocation)) {
      warnOnce(
        `deprecated-env:${row.name}`,
        `[deprecated] ${row.name} is deprecated and is removed in 0.11: ${row.use}. See STABILITY.md.`,
      );
    }
  }
  const positionals = positionalsOf(invocation, leafArgs);
  // An unknown subcommand (`akm log tail`) is a usage error, not a use of the command.
  if (positionals.length > commandPath.length && !Object.values(leafArgs ?? {}).some((a) => a.type === "positional")) {
    return;
  }
  const joined = commandPath.join(" ");
  const hit = DEPRECATIONS.find((row) => {
    if (row.path.length > 0 && row.path.join(" ") !== joined) return false;
    if (row.flag !== undefined) {
      const present = invocation.hasFlag(row.flag) || invocation.getFlagValue(row.flag) !== undefined;
      if (row.value === undefined ? !present : invocation.getFlagValue(row.flag) !== row.value) {
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
      : `[deprecated] ${what} is deprecated and is removed in 0.11${hit.note ? `: ${hit.note}` : ", with no replacement flag"}. See STABILITY.md.`,
  );
}

/**
 * The workflow notice for a workflow that only resolution reveals: `akm run` of a workflow ref or run id,
 * and a task with `uses: workflows/…`. Same rules as `warnDeprecatedUse`: one line per process, silenced
 * by `--quiet`, and not printed for scheduled or internal runs.
 */
export function warnWorkflowUse(what: string, env: NodeJS.ProcessEnv = process.env): void {
  if (deprecationNoticesSuppressed((flag) => getParsedInvocation().hasFlag(flag), env)) return;
  warnOnce(
    "deprecated-use",
    `[deprecated] ${what} is deprecated and is removed in 0.11: ${WORKFLOWS_NOTE}. See STABILITY.md.`,
  );
}

function positionalsOf(invocation: ParsedInvocation, leafArgs: ArgsDef | undefined): string[] {
  try {
    return parseArgs([...invocation.userArgs], leafArgs ?? {})._.map(String);
  } catch {
    return [];
  }
}
