// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Prints an FTA (Fast TypeScript Analyzer) complexity report of `src/` as Markdown: the score spread, the files per
 * assessment, and the 20 highest-scoring files. CI appends it to the job summary.
 *
 * With a base ref (`--base <ref>`, or `origin/$GITHUB_BASE_REF` on a pull request) it is also a gate: it scores the
 * base's `src/` and exits 1 when any file's score is higher than at the base. A file new since the base is not
 * compared. Nothing is checked in: the base is scored each run. Without a base it only reports.
 *
 * Usage:  bun scripts/fta-report.ts [--base origin/release/<version>]
 */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface FtaFile {
  file_name: string;
  cyclo: number;
  line_count: number;
  fta_score: number;
  assessment: string;
}

interface Rise {
  file: string;
  base: number;
  now: number;
}

/** Files whose score is higher than at the base; a file with no base score is skipped. */
export function scoreRises(
  base: Pick<FtaFile, "file_name" | "fta_score">[],
  current: Pick<FtaFile, "file_name" | "fta_score">[],
): Rise[] {
  const baseScores = new Map(base.map((f) => [f.file_name, f.fta_score]));
  const rises: Rise[] = [];
  for (const f of current) {
    const before = baseScores.get(f.file_name);
    if (before !== undefined && f.fta_score > before)
      rises.push({ file: `src/${f.file_name}`, base: before, now: f.fta_score });
  }
  return rises;
}

function fta(cwd: string): FtaFile[] {
  const run = Bun.spawnSync(["fta", "src", "--json", "--score-cap", "100000"], { cwd, stderr: "inherit" });
  if (run.exitCode !== 0) {
    console.error(`fta exited ${run.exitCode} in ${cwd}.`);
    process.exit(1);
  }
  return JSON.parse(run.stdout.toString()) as FtaFile[];
}

function ftaAtRef(ref: string): FtaFile[] {
  const dir = mkdtempSync(join(tmpdir(), "akm-fta-base-"));
  try {
    const tar = join(dir, "src.tar");
    for (const cmd of [
      ["git", "archive", "--format=tar", `--output=${tar}`, ref, "src"],
      ["tar", "-xf", tar, "-C", dir],
    ]) {
      const r = Bun.spawnSync(cmd, { stderr: "inherit" });
      if (r.exitCode !== 0) {
        console.error(`${cmd.join(" ")} exited ${r.exitCode}.`);
        process.exit(1);
      }
    }
    return fta(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(): void {
  const flag = process.argv.indexOf("--base");
  const baseRef =
    flag >= 0
      ? process.argv[flag + 1]
      : process.env.GITHUB_BASE_REF
        ? `origin/${process.env.GITHUB_BASE_REF}`
        : undefined;
  if (flag >= 0 && !baseRef) {
    console.error("--base needs a ref.");
    process.exit(1);
  }
  const files = fta(".").sort((a, b) => b.fta_score - a.fta_score);
  const scores = files.map((f) => f.fta_score).sort((a, b) => a - b);
  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  const p90 = scores[Math.floor(scores.length * 0.9)] ?? 0;
  const byAssessment = new Map<string, number>();
  for (const f of files) byAssessment.set(f.assessment, (byAssessment.get(f.assessment) ?? 0) + 1);

  const lines = [
    "## Complexity (FTA)",
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

  const rises = baseRef ? scoreRises(ftaAtRef(baseRef), files) : [];
  if (rises.length === 0) return;
  const failure = [
    `## Complexity gate failed: ${rises.length} file${rises.length === 1 ? "" : "s"} scored higher than at \`${baseRef}\``,
    "",
    "| File | Base score | New score |",
    "| --- | ---: | ---: |",
    ...rises.map((r) => `| \`${r.file}\` | ${r.base.toFixed(1)} | ${r.now.toFixed(1)} |`),
    "",
  ].join("\n");
  console.error(failure);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${failure}\n`);
  process.exit(1);
}

if (import.meta.main) main();
