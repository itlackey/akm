// quality:duplication — copy/paste blocks in src/ (jscpd, TypeScript only).
import fs from "node:fs";
import path from "node:path";
import { finish, pins, round, run, target } from "./lib";

const { dir, out } = target("duplication", process.argv.slice(2));
// --format typescript: without it md, json and sql files count too.
const r = run(
  ["bunx", pins.jscpd, "src", "--format", "typescript", "-r", "json", "-o", out, "--no-colors"],
  dir,
);
const reportPath = path.join(out, "jscpd-report.json");
if (!fs.existsSync(reportPath)) {
  console.error(r.err || r.out);
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
  statistics: { total: { clones: number; duplicatedLines: number; lines: number; percentage: number; sources: number } };
};
const t = report.statistics.total;

const summary = [
  `duplication (jscpd 5.4.3, src/ TypeScript): ${t.sources} files, ${t.lines} lines`,
  `${t.clones} clones, ${t.duplicatedLines} duplicated lines (${round(t.percentage)}%)`,
  "Means: blocks above jscpd's default minimum size that appear again verbatim in src/.",
  "Does not mean: all repetition. Renamed or reshaped copies are not found, and merging copies into one shared file can move the number little or not at all.",
].join("\n");

finish(out, summary, {
  files: t.sources,
  clones: t.clones,
  duplicated_lines: t.duplicatedLines,
  duplicated_pct: round(t.percentage),
});
