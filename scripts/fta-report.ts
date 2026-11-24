// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Prints an FTA (Fast TypeScript Analyzer) complexity report of `src/` as Markdown: the score spread, the files per
 * assessment, and the 20 highest-scoring files. CI appends it to the job summary. It only reports: no score fails it.
 *
 * Usage:  bun scripts/fta-report.ts
 */
import { appendFileSync } from "node:fs";

interface FtaFile {
  file_name: string;
  cyclo: number;
  line_count: number;
  fta_score: number;
  assessment: string;
}

const run = Bun.spawnSync(["fta", "src", "--json", "--score-cap", "100000"], { stderr: "inherit" });
if (run.exitCode !== 0) {
  console.error(`fta exited ${run.exitCode}; no complexity report.`);
  process.exit(0);
}
const files = (JSON.parse(run.stdout.toString()) as FtaFile[]).sort((a, b) => b.fta_score - a.fta_score);
const scores = files.map((f) => f.fta_score).sort((a, b) => a - b);
const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
const p90 = scores[Math.floor(scores.length * 0.9)] ?? 0;
const byAssessment = new Map<string, number>();
for (const f of files) byAssessment.set(f.assessment, (byAssessment.get(f.assessment) ?? 0) + 1);

const lines = [
  "## Complexity (FTA, report only)",
  "",
  `${files.length} files in \`src/\`. FTA score mean ${mean.toFixed(1)}, p90 ${p90.toFixed(1)}, max ${(scores.at(-1) ?? 0).toFixed(1)}.`,
  "",
  "| Assessment | Files |",
  "| --- | ---: |",
  ...[...byAssessment].map(([assessment, count]) => `| ${assessment} | ${count} |`),
  "",
  "| File | FTA score | Cyclomatic | Lines |",
  "| --- | ---: | ---: | ---: |",
  ...files
    .slice(0, 20)
    .map((f) => `| \`src/${f.file_name}\` | ${f.fta_score.toFixed(1)} | ${f.cyclo} | ${f.line_count} |`),
  "",
];
const report = lines.join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
