/**
 * OBSOLETE: superseded by `bun run tests/bench/cli.ts tests/bench/configs/full.json`.
 * Kept for backward compatibility; will be removed in the standalone-bench-repo extraction.
 *
 * Full benchmark run — all tasks, 5 seeds, akm arm only.
 * Usage: bun run tests/bench/run-full-bench.ts
 */
import fs from "node:fs";
import path from "node:path";
import { listTasks } from "./corpus";
import { loadOpencodeProviders } from "./opencode-config";
import { runUtility } from "./runner";

process.stderr.write(
  "[obsolete] run-full-bench.ts → see tests/bench/configs/full.json (`bun run tests/bench/cli.ts tests/bench/configs/full.json`)\n",
);

const tasks = listTasks();
const LOCAL = path.resolve(__dirname, "..", "fixtures", "bench", "opencode-providers.local.json");
const DEFAULT = path.resolve(__dirname, "..", "fixtures", "bench", "opencode-providers.json");
const providers = loadOpencodeProviders(fs.existsSync(LOCAL) ? LOCAL : DEFAULT);

process.stderr.write(`Running ${tasks.length} tasks × 5 seeds (akm only)\nModel: ${providers.defaultModel}\n\n`);

const report = await runUtility({
  tasks,
  arms: ["akm"],
  model: providers.defaultModel!,
  seedsPerArm: 5,
  budgetTokens: 25000,
  budgetWallMs: 360000,
  parallel: 3,
  opencodeProviders: providers,
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const BASELINE: Record<string, number> = {
  "drillbit/backup-policy": 1.0,
  "drillbit/canary-enable": 1.0,
  "inkwell/add-healthcheck": 0.8,
  "inkwell/configure-scaling": 0.8,
  "opencode/select-correct-skill": 1.0,
};

process.stderr.write(`\n=== RESULTS vs BASELINE ===\n`);
for (const t of report.tasks ?? []) {
  const rate = t.akm?.passRate ?? 0;
  const base = BASELINE[t.id] ?? null;
  const bar = "█".repeat(Math.round(rate * 5)) + "░".repeat(5 - Math.round(rate * 5));
  const deltaStr =
    base !== null
      ? (() => {
          const d = rate - base;
          const arrow = d > 0 ? "↑" : d < 0 ? "↓" : "=";
          return d !== 0 ? ` (${arrow}${Math.abs(d * 100).toFixed(0)}pp)` : " (=)";
        })()
      : "";
  process.stderr.write(`${t.id.padEnd(52)} ${(rate * 100).toFixed(0).padStart(3)}%  ${bar}${deltaStr}\n`);
}
process.stderr.write(`\nOverall: ${((report.aggregateAkm?.passRate ?? 0) * 100).toFixed(1)}%\n`);
