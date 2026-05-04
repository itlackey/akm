/**
 * Quick 5-task × 2-seed run for Nemotron Nano evaluation.
 * Usage: bun run tests/bench/run-nano-quick.ts
 */
import fs from "node:fs";
import path from "node:path";
import { loadTask } from "./corpus";
import { loadOpencodeProviders } from "./opencode-config";
import { runUtility } from "./runner";

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

process.stderr.write(`Running ${tasks.length} tasks × 2 seeds\nModel: ${providers.defaultModel}\n\n`);

const report = await runUtility({
  tasks,
  arms: ["akm"],
  model: providers.defaultModel!,
  seedsPerArm: 2,
  budgetTokens: 25000,
  budgetWallMs: 360000,
  parallel: 2,
  opencodeProviders: providers,
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

for (const t of report.tasks ?? []) {
  const rate = t.akm?.passRate ?? 0;
  const bar = "█".repeat(Math.round(rate * 5)) + "░".repeat(5 - Math.round(rate * 5));
  process.stderr.write(`${t.id.padEnd(48)} ${(rate * 100).toFixed(0).padStart(3)}%  ${bar}\n`);
}
process.stderr.write(`\nOverall: ${((report.aggregateAkm?.passRate ?? 0) * 100).toFixed(1)}%\n`);
