// quality:complexity — FTA (Fast TypeScript Analyzer) score, cyclomatic complexity and Halstead per src/ file.
import fs from "node:fs";
import path from "node:path";
import { finish, pins, round, run, target } from "./lib";

const { dir, out } = target("complexity", process.argv.slice(2));
const r = run(["bunx", pins.fta, "src", "--json"], dir);
if (r.code !== 0) {
  console.error(r.err || r.out);
  process.exit(1);
}
fs.writeFileSync(path.join(out, "fta.json"), r.out);

type Row = { file_name: string; cyclo: number; fta_score: number; assessment: string; line_count: number };
const rows = JSON.parse(r.out) as Row[];
const scores = rows.map((x) => x.fta_score).sort((a, b) => a - b);
const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
const median = scores[Math.floor(scores.length / 2)] ?? 0;
const worst = [...rows].sort((a, b) => b.fta_score - a.fta_score).slice(0, 10);
const byAssessment = new Map<string, number>();
for (const x of rows) byAssessment.set(x.assessment, (byAssessment.get(x.assessment) ?? 0) + 1);
const cyclo = rows.reduce((a, x) => a + x.cyclo, 0);

const summary = [
  `complexity (fta-cli 3.1.0, src/): ${rows.length} files scored`,
  `FTA score: mean ${round(mean)}, median ${round(median)}, max ${round(scores.at(-1) ?? 0)}; total cyclomatic ${cyclo}`,
  `assessments: ${[...byAssessment].map(([k, v]) => `${k} ${v}`).join(", ")}`,
  "worst 10 by FTA score:",
  ...worst.map((x) => `  ${round(x.fta_score, 1)}  cyclo ${x.cyclo}  ${x.line_count} lines  ${x.file_name}`),
  "Means: a per-file size-and-branching score (higher is harder to maintain; fta calls >60 'Needs improvement').",
  "Does not mean: quality. Splitting a file lowers its score without removing any logic, and files under 6 lines are skipped.",
].join("\n");

finish(out, summary, {
  files: rows.length,
  fta_mean: round(mean),
  fta_median: round(median),
  fta_max: round(scores.at(-1) ?? 0),
  needs_improvement: byAssessment.get("Needs improvement") ?? 0,
  cyclomatic_total: cyclo,
});
