/**
 * OBSOLETE: superseded by `bun run tests/bench/cli.ts tests/bench/configs/failing-tasks.json`.
 * Kept for backward compatibility; will be removed in the standalone-bench-repo extraction.
 *
 * Targeted retest of failing/partial tasks after stash improvements.
 * Usage: bun run tests/bench/run-failing-tasks.ts
 */
import fs from "node:fs";
import path from "node:path";
import { loadTask } from "./corpus";
import { loadOpencodeProviders } from "./opencode-config";
import { runUtility } from "./runner";

process.stderr.write(
  "[obsolete] run-failing-tasks.ts → see tests/bench/configs/failing-tasks.json (`bun run tests/bench/cli.ts tests/bench/configs/failing-tasks.json`)\n",
);

const TASK_IDS = [
  "drillbit/backup-policy",
  "drillbit/canary-enable",
  "inkwell/add-healthcheck",
  "inkwell/configure-scaling",
  "opencode/select-correct-skill",
];

const tasks = TASK_IDS.map((id) => loadTask(id));
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

const agg = report.aggregateAkm;
process.stderr.write(`\n=== RESULTS vs BASELINE ===\n`);
// Qwen 9B baseline for comparison
const BASELINE: Record<string, number> = {
  "drillbit/backup-policy": 1.0,
  "drillbit/canary-enable": 1.0,
  "inkwell/add-healthcheck": 0.8,
  "inkwell/configure-scaling": 0.8,
  "opencode/select-correct-skill": 1.0,
};
for (const t of report.tasks ?? []) {
  const rate = t.akm?.passRate ?? 0;
  const base = BASELINE[t.id] ?? 0;
  const delta = rate - base;
  const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "=";
  const bar = "█".repeat(Math.round(rate * 5)) + "░".repeat(5 - Math.round(rate * 5));
  const deltaStr = delta !== 0 ? ` (${arrow}${Math.abs(delta * 100).toFixed(0)}pp)` : "";
  process.stderr.write(`${t.id.padEnd(48)} ${(rate * 100).toFixed(0).padStart(3)}%  ${bar}${deltaStr}\n`);
}
process.stderr.write(`\nOverall: ${((agg?.passRate ?? 0) * 100).toFixed(1)}%\n`);
