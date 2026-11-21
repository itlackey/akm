// quality:mutation — StrykerJS mutation score for named src files, using their named tests.
//   bun scripts/quality/mutation.ts --mutate src/core/time.ts[,src/x.ts] --tests tests/core/time.test.ts[,...]
// Every mutant reruns the whole test command, so a full-repo run takes hours: both lists are required.
// Run it under a memory cap, e.g. `systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=0 bun run quality:mutation -- ...`.
import fs from "node:fs";
import path from "node:path";
import { finish, flag, pins, round, run, target } from "./lib";

const argv = process.argv.slice(2);
const mutate = flag(argv, "mutate")?.split(",").filter(Boolean) ?? [];
const tests = flag(argv, "tests")?.split(",").filter(Boolean) ?? [];
if (mutate.length === 0 || tests.length === 0) {
  console.error(
    "usage: quality:mutation -- --mutate <src files, comma separated> --tests <test files, comma separated>",
  );
  process.exit(2);
}
const { dir, out } = target("mutation", argv);

const configPath = path.join(out, "stryker.config.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    testRunner: "command",
    commandRunner: { command: `bun test --timeout=120000 ${tests.join(" ")}` },
    mutate,
    coverageAnalysis: "off",
    reporters: ["json"],
    jsonReporter: { fileName: path.join(out, "mutation.json") },
    tempDirName: path.join(out, ".stryker-tmp"),
    cleanTempDir: true,
    concurrency: 2,
    ignorePatterns: ["reports"],
  }),
);
// NODE_PATH makes bunx's Stryker find the repo's own TypeScript 5 (TypeScript 7 breaks it).
const r = run(["bunx", "--bun", pins.stryker, "run", configPath], dir, { NODE_PATH: "node_modules" });
const reportPath = path.join(out, "mutation.json");
if (!fs.existsSync(reportPath)) {
  console.error(r.err || r.out);
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
  files: Record<string, { mutants: { status: string }[] }>;
};
const counts = new Map<string, number>();
for (const f of Object.values(report.files))
  for (const m of f.mutants) counts.set(m.status, (counts.get(m.status) ?? 0) + 1);
const n = (s: string) => counts.get(s) ?? 0;
const killed = n("Killed") + n("Timeout");
const valid = killed + n("Survived") + n("NoCoverage");
const score = valid === 0 ? 0 : (killed / valid) * 100;

const summary = [
  `mutation (stryker 10.1.1, command runner): ${mutate.join(", ")} against ${tests.join(", ")}`,
  `score ${round(score, 1)}%: ${killed} killed (${n("Timeout")} by timeout), ${n("Survived")} survived, ${n("NoCoverage")} no coverage, ${n("RuntimeError") + n("CompileError")} errors`,
  "Means: the share of small code changes (mutants) in those files that the named tests notice.",
  "Does not mean: the score for the whole repo, or for code the named tests only reach through other files. A mutant reached only by a test that spawns the CLI with a replaced env is not seen, so the score is a lower bound.",
].join("\n");

finish(out, summary, { score_pct: round(score, 1), killed, survived: n("Survived"), no_coverage: n("NoCoverage") });
