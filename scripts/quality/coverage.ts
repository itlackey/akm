// quality:coverage — line and function coverage of src/ from one `bun test --coverage` run of the whole suite.
import fs from "node:fs";
import path from "node:path";
import { die, finish, round, run, target, walk } from "./lib";

const { dir, out } = target("coverage", process.argv.slice(2));
const lcovPath = path.join(out, "lcov.info");
const files = walk(dir, (p) => p.startsWith("tests/") && p.endsWith(".test.ts") && !p.startsWith("tests/fixtures/"))
  .map((p) => p.replace(/^\//, ""))
  .sort();
const home = path.join(out, "runtime-home");
fs.mkdirSync(home, { recursive: true });

// One process, so the lcov file is complete without merging. HOME is a scratch dir, as in scripts/test-unit.sh.
const started = Date.now();
const r = run(
  ["bun", "test", "--timeout=120000", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${out}`, ...files],
  dir,
  { HOME: home },
);
const wall = Math.round((Date.now() - started) / 1000);
const output = `${r.out}\n${r.err}`;
fs.writeFileSync(path.join(out, "test-output.txt"), output);
fs.rmSync(home, { recursive: true, force: true });
if (!fs.existsSync(lcovPath)) die(r);
// The last match, as scripts/test-unit.sh takes it: an earlier one can be a test title.
const last = (re: RegExp) => Number([...output.matchAll(re)].at(-1)?.[1] ?? 0);
const failed = last(/(\d+) fail/g);
const passed = last(/(\d+) pass/g);

type Cov = { lf: number; lh: number; fnf: number; fnh: number };
const perFile = new Map<string, Cov>();
let cur: Cov | undefined;
for (const line of fs.readFileSync(lcovPath, "utf8").split("\n")) {
  if (line.startsWith("SF:")) {
    const f = path.relative(dir, path.resolve(dir, line.slice(3)));
    cur = { lf: 0, lh: 0, fnf: 0, fnh: 0 };
    if (f.startsWith("src/")) perFile.set(f, cur);
    else cur = undefined;
  } else if (cur) {
    const [k, v] = [line.slice(0, line.indexOf(":")), Number(line.slice(line.indexOf(":") + 1))];
    if (k === "LF") cur.lf = v;
    else if (k === "LH") cur.lh = v;
    else if (k === "FNF") cur.fnf = v;
    else if (k === "FNH") cur.fnh = v;
  }
}

// bun lists only files loaded by the test process. A src file with runtime code that no test loads is added at 0%;
// its line count is the non-blank lines of its transpiled output (an estimate; no function count). A file that
// transpiles to nothing (types only) has no runtime code and is skipped, because bun erases it from every import.
const loaded = perFile.size;
const transpiler = new Bun.Transpiler({ loader: "ts" });
for (const f of walk(dir, (p) => p.startsWith("src/") && p.endsWith(".ts") && !p.endsWith(".d.ts"))) {
  const rel = f.replace(/^\//, "");
  if (perFile.has(rel)) continue;
  const lines = transpiler
    .transformSync(fs.readFileSync(path.join(dir, rel), "utf8"))
    .split("\n")
    .filter((l) => l.trim() !== "" && !/^\s*(\/\/|\/?\*)/.test(l)).length;
  if (lines > 0) perFile.set(rel, { lf: lines, lh: 0, fnf: 0, fnh: 0 });
}
const sum = (k: keyof Cov) => [...perFile.values()].reduce((a, c) => a + c[k], 0);
const lf = sum("lf");
const lh = sum("lh");
const fnf = sum("fnf");
const fnh = sum("fnh");
const pct = (a: number, b: number) => (b === 0 ? 0 : round((a / b) * 100, 1));

const perFileJson = Object.fromEntries(
  [...perFile].sort().map(([f, c]) => [f, { lines: `${c.lh}/${c.lf}`, functions: `${c.fnh}/${c.fnf}` }]),
);
fs.writeFileSync(
  path.join(out, "coverage.json"),
  JSON.stringify(
    { total: { lines: pct(lh, lf), functions: pct(fnh, fnf), lf, lh, fnf, fnh }, files: perFileJson },
    null,
    2,
  ),
);

const summary = [
  `coverage (bun test --coverage, src/): lines ${pct(lh, lf)}% (${lh}/${lf}), functions ${pct(fnh, fnf)}% (${fnh}/${fnf})`,
  `${passed} pass / ${failed} fail across ${files.length} test files in ${wall}s; ${perFile.size - loaded} src files with runtime code that no test loads counted at 0%`,
  "Means: a LOWER BOUND on how much of src/ the tests run. Only code run inside the test process is counted; code reached only by tests that spawn the CLI is not.",
  "Does not mean: tested behaviour. A hit line is not an asserted line; bun marks a one-line function as hit when it is only declared, there is no branch data, and the unloaded files use an estimated line count and no function count.",
].join("\n");

finish(out, summary, {
  lines_pct: pct(lh, lf),
  functions_pct: pct(fnh, fnf),
  lines_hit: lh,
  lines_total: lf,
  test_failures: failed,
});
