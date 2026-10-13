// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { placementTypes } from "../core/asset/asset-placement";

// biome-ignore lint/suspicious/noExplicitAny: citty command tree uses dynamic shapes
type AnyCmd = Record<string, any>;

// ── Known flag values ────────────────────────────────────────────────────────

/**
 * A completion rule for one flag, optionally scoped to a set of exact
 * command paths (the same `"<root> <subcommand...>"` shape `walkCommandTree`
 * produces below, e.g. `"akm search"`, `"akm curate"`). Most flags
 * (`--format`, `--detail`, `--type`, `--shell`) mean the same
 * thing on every command that declares them, so they're declared with no
 * `paths` (global — the rule applies wherever the flag appears).
 *
 * `--from` does NOT: it's a closed `local|registry|all` enum on
 * `search`/`curate` (src/commands/read/search-cli.ts, renamed from `--source`
 * in the 0.9 CLI overhaul, S8), but a free-form existing-file path on
 * `workflow create` (src/commands/workflow-cli.ts). `FLAG_VALUES` is a flat
 * `Record` keyed by flag NAME ONLY, so without scoping `akm workflow create
 * --from <TAB>` would wrongly suggest `local registry all` — search's enum,
 * tagged onto every occurrence of the flag name regardless of which command
 * it belonged to (R-052a). Scoping the rule to `paths` keeps the suggestion
 * where it's actually correct; every other command path with that flag gets
 * no suggestion (falls through to bash's default filename completion)
 * rather than an incorrect one.
 */
interface FlagValueRule {
  /** Exact command paths this rule applies to. Omit for every path with no more specific rule for this flag. */
  paths?: string[];
  values: string[] | (() => string[]);
}

const FLAG_VALUES: Record<string, FlagValueRule[]> = {
  "--format": [{ values: ["json", "jsonl", "yaml", "text", "md", "html"] }],
  "--detail": [{ values: ["brief", "normal", "full", "agent"] }],
  "--type": [{ values: () => [...placementTypes(), "any"] }],
  "--shell": [{ values: ["bash"] }],
  "--from": [{ paths: ["akm search", "akm curate"], values: ["local", "registry", "all"] }],
};

function resolveRuleValues(rule: FlagValueRule): string[] {
  return typeof rule.values === "function" ? rule.values() : rule.values;
}

/**
 * Build the `${prev}`-case body for one flag. When the flag has no
 * path-scoped rules, every command shares one value set (unchanged from
 * before R-052a). When it does (currently only `--from`), nest a
 * `${cmd_path}` match inside the flag's case so the suggestion depends on
 * which command is being completed — with a `*)` fallback to any
 * unscoped/global rule declared alongside the scoped ones, or no suggestion
 * at all when every rule for that flag is scoped.
 */
function buildFlagValueCaseBody(rules: FlagValueRule[]): string {
  const scoped = rules.filter((rule) => rule.paths && rule.paths.length > 0);
  const global = rules.find((rule) => !rule.paths || rule.paths.length === 0);

  if (scoped.length === 0) {
    return `      COMPREPLY=( $(compgen -W "${resolveRuleValues(global as FlagValueRule).join(" ")}" -- "\${cur}") )`;
  }

  const branches = scoped
    .map(
      (rule) =>
        `        ${(rule.paths as string[]).map((p) => `"${p}"`).join("|")})
          COMPREPLY=( $(compgen -W "${resolveRuleValues(rule).join(" ")}" -- "\${cur}") )
          ;;`,
    )
    .join("\n");
  const fallback = global
    ? `        *)
          COMPREPLY=( $(compgen -W "${resolveRuleValues(global).join(" ")}" -- "\${cur}") )
          ;;`
    : "";
  return `      case "\${cmd_path}" in
${branches}
${fallback}
      esac`;
}

// ── Command tree walker ──────────────────────────────────────────────────────

interface CommandInfo {
  path: string; // e.g. "registry search"
  subcommands: string[];
  flags: string[];
  valueFlags: string[];
}

function walkCommandTree(cmd: AnyCmd, parentPath = ""): CommandInfo[] {
  const name = cmd.meta?.name ?? "";
  const currentPath = parentPath ? `${parentPath} ${name}` : name;
  const result: CommandInfo[] = [];

  // `meta.hidden` (e.g. `migrate`, S11) is excluded from completion the same
  // way citty's own `renderUsage` excludes it from a rendered COMMANDS list —
  // a hidden command still runs, it just isn't suggested.
  const visibleSubEntries = Object.entries((cmd.subCommands ?? {}) as Record<string, AnyCmd>).filter(
    ([, sub]) => !sub.meta?.hidden,
  );
  const subcommands = visibleSubEntries.map(([key]) => key);
  const flags: string[] = [];
  const valueFlags: string[] = [];

  if (cmd.args) {
    for (const [flagName, arg] of Object.entries(cmd.args as Record<string, AnyCmd>)) {
      if (arg.type === "positional") continue;
      flags.push(`--${flagName}`);
      if (arg.type === "boolean" && arg.default === true) flags.push(`--no-${flagName}`);
      if (arg.type !== "boolean") valueFlags.push(`--${flagName}`);
    }
  }

  result.push({ path: currentPath, subcommands, flags, valueFlags });

  for (const [, sub] of visibleSubEntries) {
    result.push(...walkCommandTree(sub, currentPath));
  }

  return result;
}

// ── Bash completion script generator ─────────────────────────────────────────

export function generateBashCompletions(cmd: AnyCmd): string {
  const commands = walkCommandTree(cmd);
  const rootName = cmd.meta?.name ?? "akm";

  // Collect global flags from root command
  const rootInfo = commands.find((c) => c.path === rootName);
  const globalFlags = rootInfo?.flags ?? [];
  const valueFlags = [...new Set(commands.flatMap((info) => info.valueFlags))];

  // Build the case blocks for subcommand completion
  const caseBlocks: string[] = [];

  for (const info of commands) {
    const allFlags = [...new Set([...info.flags, ...globalFlags])];

    if (info.subcommands.length > 0 || allFlags.length > 0) {
      const matchPath = info.path;
      const subcmdStr = info.subcommands.join(" ");
      const flagStr = allFlags.join(" ");

      caseBlocks.push(`      "${matchPath}")
        if [[ "\${cur}" == -* ]]; then
          COMPREPLY=( $(compgen -W "${flagStr}" -- "\${cur}") )
        else
          COMPREPLY=( $(compgen -W "${subcmdStr}" -- "\${cur}") )
        fi
        return 0
        ;;`);
    }
  }

  // Build flag-value completion cases
  const valueCases: string[] = [];
  for (const [flag, rules] of Object.entries(FLAG_VALUES)) {
    valueCases.push(`    ${flag})
${buildFlagValueCaseBody(rules)}
      return 0
      ;;`);
  }

  const script = `#!/bin/bash
# Bash completion for ${rootName}
# Generated by ${rootName} completions

_${rootName}() {
  local cur prev words cword
  if type _init_completion &>/dev/null; then
    _init_completion || return
  else
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    words=("\${COMP_WORDS[@]}")
    cword=\${COMP_CWORD}
  fi

  # Build the command path from recognized subcommand transitions only. Positional
  # arguments and option values cannot extend the path, so completion remains
  # command-aware after either one.
  local cmd_path="${rootName}"
  local skip_value=0
  for (( i=1; i < cword; i++ )); do
    if (( skip_value )); then
      skip_value=0
      continue
    fi
    case "\${words[i]}" in
      --) break ;;
      --*=*) continue ;;
      ${valueFlags.join("|")}) skip_value=1; continue ;;
      -*) continue ;;
      *)
        case "\${cmd_path}:\${words[i]}" in
${commands
  .filter((info) => info.subcommands.length > 0)
  .flatMap((info) =>
    info.subcommands.map(
      (subcommand) => `          "${info.path}:${subcommand}") cmd_path="${info.path} ${subcommand}" ;;`,
    ),
  )
  .join("\n")}
        esac
        ;;
    esac
  done

  # Complete flag values
  case "\${prev}" in
${valueCases.join("\n")}
  esac

  # Complete based on current command path
  case "\${cmd_path}" in
${caseBlocks.join("\n")}
  esac

  return 0
}

complete -F _${rootName} ${rootName}
`;

  return script;
}

// ── Install ──────────────────────────────────────────────────────────────────

export function installBashCompletions(script: string): string {
  const dest = resolveInstallPath();
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dest, script, "utf8");
  return dest;
}

function resolveInstallPath(): string {
  const xdgData = process.env.XDG_DATA_HOME?.trim();
  if (xdgData) {
    return path.join(xdgData, "bash-completion", "completions", "akm");
  }

  const home = os.homedir();

  // Default XDG location
  const defaultXdg = path.join(home, ".local", "share", "bash-completion", "completions", "akm");
  const defaultXdgDir = path.dirname(defaultXdg);
  if (isDir(defaultXdgDir) || isDir(path.dirname(defaultXdgDir))) {
    return defaultXdg;
  }

  // Fallback
  return path.join(home, ".bash_completion.d", "akm");
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
