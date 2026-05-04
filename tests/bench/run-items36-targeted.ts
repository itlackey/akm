/**
 * Items 3-6 targeted bench — tasks most directly affected by fixture stash
 * content additions and skill frontmatter strip (commit 92196c7).
 * Usage: bun run tests/bench/run-items36-targeted.ts
 */
import fs from "node:fs";
import path from "node:path";
import { loadTask } from "./corpus";
import { loadOpencodeProviders } from "./opencode-config";
import { runUtility } from "./runner";

const TARGET_TASKS = [
  // item 4: env_file section moved to top of compose-conventions.md
  "docker-homelab/env-from-file",
  // item 3: az-storage-lifecycle knowledge added to az-cli stash
  "workflow-compliance/repeated-fail-storage-lifecycle-a",
  // item 5: memory assets (compound-tag-filter, null-value-trap)
  "az-cli/query-by-tag",
  // item 5: memory asset (healthcheck-test-cmd)
  "inkwell/add-healthcheck-train",
  // item 6: skill frontmatter strip — previously low-scoring tasks
  "docker-homelab/restart-policy",
  "docker-homelab/redis-healthcheck",
  "docker-homelab/named-volume",
  "az-cli/storage-account-create",
  "inkwell/configure-scaling",
];

const tasks = TARGET_TASKS.map(loadTask);
const LOCAL = path.resolve(__dirname, "..", "fixtures", "bench", "opencode-providers.local.json");
const DEFAULT = path.resolve(__dirname, "..", "fixtures", "bench", "opencode-providers.json");
const providers = loadOpencodeProviders(fs.existsSync(LOCAL) ? LOCAL : DEFAULT);

process.stderr.write(`Items 3-6 targeted bench: ${tasks.length} tasks × 3 seeds\nModel: ${providers.defaultModel}\n\n`);

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

// Wave G baselines from 2026-05-03 targeted run
const BASELINE: Record<string, number> = {
  "docker-homelab/env-from-file": 0.0,
  "workflow-compliance/repeated-fail-storage-lifecycle-a": 0.0,
  "az-cli/query-by-tag": 0.4,
  "inkwell/add-healthcheck-train": 0.67,
  "docker-homelab/restart-policy": 0.33,
  "docker-homelab/redis-healthcheck": 0.33,
  "docker-homelab/named-volume": 0.33,
  "az-cli/storage-account-create": 1.0,
  "inkwell/configure-scaling": 0.6,
};

process.stderr.write(`\n=== RESULTS vs Wave G BASELINE ===\n`);
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
