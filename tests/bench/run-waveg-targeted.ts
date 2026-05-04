/**
 * Wave G targeted bench — 9 previously-failing tasks, 3 seeds.
 * Usage: bun run tests/bench/run-waveg-targeted.ts
 */
import fs from "node:fs";
import path from "node:path";
import { loadTask } from "./corpus";
import { loadOpencodeProviders } from "./opencode-config";
import { runUtility } from "./runner";

const TARGET_TASKS = [
  "inkwell/configure-scaling",
  "inkwell/add-healthcheck-train",
  "inkwell/full-config",
  "az-cli/storage-account-create",
  "docker-homelab/bridge-network",
  "docker-homelab/compose-version-upgrade",
  "docker-homelab/env-from-file",
  "workflow-compliance/feedback-trap-az-tag-list",
  "workflow-compliance/repeated-fail-storage-lifecycle-a",
];

const tasks = TARGET_TASKS.map((id) => loadTask(id));
const LOCAL = path.resolve(__dirname, "..", "fixtures", "bench", "opencode-providers.local.json");
const DEFAULT = path.resolve(__dirname, "..", "fixtures", "bench", "opencode-providers.json");
const providers = loadOpencodeProviders(fs.existsSync(LOCAL) ? LOCAL : DEFAULT);

process.stderr.write(`Wave G targeted bench: ${tasks.length} tasks × 3 seeds\nModel: ${providers.defaultModel}\n\n`);

const report = await runUtility({
  tasks,
  arms: ["akm"],
  model: providers.defaultModel!,
  seedsPerArm: 3,
  budgetTokens: 25000,
  budgetWallMs: 360000,
  parallel: 3,
  opencodeProviders: providers,
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const BASELINE: Record<string, number> = {
  "inkwell/configure-scaling": 0.6,
  "inkwell/add-healthcheck-train": 0.4,
  "inkwell/full-config": 0.0,
  "az-cli/storage-account-create": 0.4,
  "docker-homelab/bridge-network": 0.2,
  "docker-homelab/compose-version-upgrade": 0.4,
  "docker-homelab/env-from-file": 0.0,
  "workflow-compliance/feedback-trap-az-tag-list": 0.2,
  "workflow-compliance/repeated-fail-storage-lifecycle-a": 0.0,
};

process.stderr.write(`\n=== RESULTS vs 2026-05-03 BASELINE ===\n`);
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
