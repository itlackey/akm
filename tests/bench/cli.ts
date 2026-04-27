#!/usr/bin/env bun
/**
 * akm-bench CLI dispatcher.
 *
 * Subcommands:
 *   • `utility`    — paired noakm vs akm utility benchmark (Track A).
 *   • `evolve`     — longitudinal evolution loop (Track B). Stub in #236.
 *   • `compare`    — diff two report JSON files. Stub in #236.
 *   • `attribute`  — per-asset marginal contribution. Stub in #236.
 *
 * #236 implements `--help` and a thin `utility` skeleton that walks the
 * corpus and produces an empty report. The other three subcommands print a
 * pointer to their tracking issue and exit 2.
 *
 * NOTE: This file is intentionally argv-light. citty is the project's CLI
 * framework but the bench binary is not part of the public CLI surface, so
 * a hand-rolled parser keeps the dependency graph tight.
 */

import process from "node:process";

import { listTasks } from "./corpus";
import type { RunResult } from "./driver";
import { computeOutcomeAggregate, type OutcomeAggregate } from "./metrics";
import { renderJsonReport, renderMarkdownSummary } from "./report";

const HELP = `akm-bench — agent-plus-akm evaluation framework

Usage:
  bun run tests/bench/cli.ts <subcommand> [...flags]

Subcommands:
  utility       Track A: paired noakm vs akm utility benchmark.
  evolve        Track B: longitudinal feedback → distill → propose loop.
  compare       Diff two report JSON files (refuses cross-model diffs).
  attribute     Per-asset marginal pass-rate contribution.

Common flags:
  --tasks <slice>     train | eval | all  (default: eval)
  --json              Emit JSON to stdout; markdown summary to stderr.
  -h, --help          Show this message.

Environment:
  BENCH_OPENCODE_MODEL   model id stamped into every RunResult.

See tests/bench/BENCH.md for the operator guide.
`;

interface ParsedArgs {
  subcommand: string;
  flags: Map<string, string>;
  bool: Set<string>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const bool = new Set<string>();
  const positional: string[] = [];
  const subcommand = argv[0] ?? "";
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      bool.add("help");
      continue;
    }
    if (arg === "--json") {
      bool.add("json");
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          bool.add(arg.slice(2));
        } else {
          flags.set(arg.slice(2), next);
          i += 1;
        }
      }
      continue;
    }
    positional.push(arg);
  }
  return { subcommand, flags, bool, positional };
}

function notImplemented(name: string, issueRef: string): never {
  process.stderr.write(`bench ${name}: not yet implemented in #236; see ${issueRef}.\n`);
  process.exit(2);
}

interface UtilityOptions {
  slice: "train" | "eval" | "all";
  json: boolean;
  model: string;
  branch: string;
  commit: string;
  timestamp: string;
}

/**
 * `utility` subcommand skeleton. #236 walks the corpus and emits an empty
 * report. Real run execution lands in #238 once the corpus has tasks.
 */
export function runUtility(options: UtilityOptions): { exitCode: number; stdout: string; stderr: string } {
  const sliceFilter = options.slice === "all" ? undefined : options.slice;
  const tasks = listTasks(sliceFilter ? { slice: sliceFilter } : {});

  const empty: RunResult[] = [];
  const arms: Record<string, OutcomeAggregate> = {
    noakm: computeOutcomeAggregate(empty),
    akm: computeOutcomeAggregate(empty),
  };

  const reportInput = {
    timestamp: options.timestamp,
    branch: options.branch,
    commit: options.commit,
    model: options.model,
    track: "utility" as const,
    arms,
  };
  const json = renderJsonReport(reportInput);
  const md = renderMarkdownSummary(reportInput);

  let stdout = "";
  let stderr = "";
  if (options.json) {
    stdout = `${json}\n`;
    stderr = `${md}\n`;
  } else {
    stdout = `${md}\n`;
  }
  stderr += `tasks discovered: ${tasks.length} (slice=${options.slice})\n`;
  if (tasks.length === 0) {
    stderr += "no tasks found — corpus is built in #237\n";
  }
  return { exitCode: 0, stdout, stderr };
}

function getEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

function main(argv: string[]): number {
  const parsed = parseArgs(argv);

  if (parsed.bool.has("help") || parsed.subcommand === "" || parsed.subcommand === "help") {
    process.stdout.write(HELP);
    return parsed.subcommand === "" ? 2 : 0;
  }

  switch (parsed.subcommand) {
    case "utility": {
      const sliceRaw = parsed.flags.get("tasks") ?? "eval";
      const slice =
        sliceRaw === "train" || sliceRaw === "eval" || sliceRaw === "all"
          ? (sliceRaw as "train" | "eval" | "all")
          : "eval";
      const result = runUtility({
        slice,
        json: parsed.bool.has("json"),
        model: getEnv("BENCH_OPENCODE_MODEL", "unset"),
        branch: getEnv("BENCH_BRANCH", "unknown"),
        commit: getEnv("BENCH_COMMIT", "unknown"),
        timestamp: new Date().toISOString(),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return result.exitCode;
    }
    case "evolve":
      return notImplemented("evolve", "#239");
    case "compare":
      return notImplemented("compare", "#240");
    case "attribute":
      return notImplemented("attribute", "#243");
    default:
      process.stderr.write(`unknown subcommand: ${parsed.subcommand}\n`);
      process.stderr.write(HELP);
      return 2;
  }
}

// Only execute when invoked directly. The exported `runUtility` is callable
// from tests without triggering process.exit.
if (import.meta.main) {
  const code = main(process.argv.slice(2));
  process.exit(code);
}
