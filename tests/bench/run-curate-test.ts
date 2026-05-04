/**
 * Test akm curate as first command on configure-scaling.
 * Usage: bun run tests/bench/run-curate-test.ts
 */
import fs from "node:fs";
import path from "node:path";
import { loadTask } from "./corpus";
import { loadOpencodeProviders } from "./opencode-config";
import { runUtility } from "./runner";

const tasks = [loadTask("inkwell/configure-scaling")];
const LOCAL = path.resolve(__dirname, "..", "fixtures", "bench", "opencode-providers.local.json");
const DEFAULT = path.resolve(__dirname, "..", "fixtures", "bench", "opencode-providers.json");
const providers = loadOpencodeProviders(fs.existsSync(LOCAL) ? LOCAL : DEFAULT);

process.stderr.write(`Running configure-scaling × 5 seeds (curate as first cmd)\nModel: ${providers.defaultModel}\n\n`);

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
const t = report.tasks?.[0];
const rate = t?.akm?.passRate ?? 0;
process.stderr.write(`\nconfigure-scaling: ${(rate * 100).toFixed(0)}% (baseline 80%)\n`);
