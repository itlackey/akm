#!/usr/bin/env bun
/**
 * akm-bench CLI dispatcher.
 *
 * Subcommands:
 *   • `utility`    — paired noakm vs akm utility benchmark (Track A).
 *   • `evolve`     — longitudinal evolution loop (Track B). Stub.
 *   • `compare`    — diff two report JSON files. Stub.
 *   • `attribute`  — per-asset marginal contribution. Stub.
 *
 * #238 wires `utility` to the K-seed runner and §13.3 report renderer. The
 * other three subcommands stay as "not yet implemented" pointers.
 *
 * NOTE: The bench binary is intentionally argv-light. citty is the project's
 * CLI framework but the bench is not part of the public CLI surface, so a
 * hand-rolled parser keeps the dependency graph tight.
 */

import process from "node:process";

import { listTasks } from "./corpus";
import { renderUtilityReport } from "./report";
import { runUtility } from "./runner";

const HELP = `akm-bench — agent-plus-akm evaluation framework

Usage:
  bun run tests/bench/cli.ts <subcommand> [...flags]

Subcommands:
  utility       Track A: paired noakm vs akm utility benchmark.
  evolve        Track B: longitudinal feedback → distill → propose loop.
  compare       Diff two report JSON files (refuses cross-model diffs).
  attribute     Per-asset marginal pass-rate contribution.

utility flags:
  --tasks <slice>          train | eval | all  (default: all)
  --seeds <N>              seeds per arm  (default: 5)
  --budget-tokens <N>      per-run token cap (default: 30000)
  --budget-wall-ms <N>     per-run wallclock cap in ms (default: 120000)
  --json                   suppress the markdown summary on stderr (machine-readable only).
                           Without --json, JSON still goes to stdout and the markdown
                           summary is also written to stderr for human-friendly reads.
  -h, --help               show this message.

Environment:
  BENCH_OPENCODE_MODEL   model id stamped into every RunResult. REQUIRED for utility.

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
  process.stderr.write(`bench ${name}: not yet implemented; see ${issueRef}.\n`);
  process.exit(2);
}

export interface UtilityCliOptions {
  slice: "train" | "eval" | "all";
  json: boolean;
  seedsPerArm: number;
  budgetTokens: number;
  budgetWallMs: number;
  model: string;
  branch?: string;
  commit?: string;
  timestamp?: string;
}

export interface UtilityCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * `utility` subcommand. Walks the corpus, runs K seeds per arm per task,
 * and produces the §13.3 report.
 *
 * Returns rather than mutates process to keep this unit-testable. The
 * `main()` driver below maps the result onto the actual stdout/stderr/exit.
 */
export async function runUtilityCli(options: UtilityCliOptions): Promise<UtilityCliResult> {
  const sliceFilter = options.slice === "all" ? undefined : options.slice;
  const tasks = listTasks(sliceFilter ? { slice: sliceFilter } : {});

  const report = await runUtility({
    tasks,
    arms: ["noakm", "akm"],
    model: options.model,
    seedsPerArm: options.seedsPerArm,
    budgetTokens: options.budgetTokens,
    budgetWallMs: options.budgetWallMs,
    slice: options.slice,
    ...(options.branch !== undefined ? { branch: options.branch } : {}),
    ...(options.commit !== undefined ? { commit: options.commit } : {}),
    ...(options.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
  });

  const { json, markdown } = renderUtilityReport(report);
  const jsonText = `${JSON.stringify(json, null, 2)}\n`;
  const markdownText = `${markdown}\n`;

  // JSON ALWAYS goes to stdout. This is the bench's machine-readable
  // contract (matches `tests/benchmark-suite.ts` and the future `bench
  // compare`/`attribute` subcommands). The `--json` flag means
  // "suppress the human-friendly markdown summary on stderr"; without it,
  // both the JSON envelope (stdout) and the markdown summary (stderr) are
  // emitted so an operator running it interactively gets both views.
  const stdout = jsonText;
  let stderr = options.json ? "" : markdownText;
  stderr += `tasks discovered: ${tasks.length} (slice=${options.slice})\n`;
  if (tasks.length === 0) {
    stderr += "no tasks found — corpus is empty or the slice filter excluded all tasks\n";
  }

  return { exitCode: 0, stdout, stderr };
}

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function parseInt32(text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.bool.has("help") || parsed.subcommand === "" || parsed.subcommand === "help") {
    process.stdout.write(HELP);
    return parsed.subcommand === "" ? 2 : 0;
  }

  switch (parsed.subcommand) {
    case "utility": {
      const sliceRaw = parsed.flags.get("tasks") ?? "all";
      if (sliceRaw !== "train" && sliceRaw !== "eval" && sliceRaw !== "all") {
        process.stderr.write(
          `bench utility: invalid --tasks value "${sliceRaw}"; expected one of: all, train, eval.\n`,
        );
        return 2;
      }
      const slice = sliceRaw as "train" | "eval" | "all";
      const model = getEnv("BENCH_OPENCODE_MODEL");
      if (!model) {
        process.stderr.write("bench utility: BENCH_OPENCODE_MODEL environment variable is required.\n");
        return 2;
      }
      const result = await runUtilityCli({
        slice,
        json: parsed.bool.has("json"),
        seedsPerArm: parseInt32(parsed.flags.get("seeds"), 5),
        budgetTokens: parseInt32(parsed.flags.get("budget-tokens"), 30000),
        budgetWallMs: parseInt32(parsed.flags.get("budget-wall-ms"), 120000),
        model,
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

// Only execute when invoked directly. The exported `runUtilityCli` is callable
// from tests without triggering process.exit.
if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
