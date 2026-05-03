/**
 * Targeted retest of failing/partial tasks after stash improvements.
 * Usage: bun run tests/bench/run-failing-tasks.ts
 */
import fs from "node:fs";
import path from "node:path";
import { loadTask } from "./corpus";
import { loadOpencodeProviders } from "./opencode-config";
import { runUtility } from "./runner";

const TASK_IDS = [
  "inkwell/full-config",
  "inkwell/workflow-configure-scaling",
  "opencode/select-correct-skill",
  "inkwell/configure-scaling",
  "inkwell/set-rate-limit",
  "inkwell/new-service",
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
const BASELINE: Record<string, number> = {
  "inkwell/full-config": 0,
  "inkwell/workflow-configure-scaling": 0,
  "opencode/select-correct-skill": 0,
  "inkwell/configure-scaling": 0.6,
  "inkwell/set-rate-limit": 0.6,
  "inkwell/new-service": 0.4,
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
