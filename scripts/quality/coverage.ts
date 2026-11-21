// quality:coverage — line and function coverage of src/ from one `bun test --coverage` run of the whole suite.
import fs from "node:fs";
import path from "node:path";
import { finish, round, run, target, walk } from "./lib";

const { dir, out } = target("coverage", process.argv.slice(2));
const files = walk(dir, (p) => p.startsWith("tests/") && p.endsWith(".test.ts") && !p.startsWith("tests/fixtures/"))
  .map((p) => p.replace(/^\//, ""))
  .sort();
const home = path.join(out, "runtime-home");
fs.mkdirSync(home, { recursive: true });

// One process, so the lcov file is complete without merging. HOME is a scratch dir, as in scripts/test-unit.sh.
const started = Date.now();
const r = run(
  [
    "bun",
    "test",
    "--timeout=120000",
    "--coverage",
    "--coverage-reporter=lcov",
    `--coverage-dir=${out}`,
    ...files,
  ],
  dir,
  { HOME: home },
);
const wall = Math.round((Date.now() - started) / 1000);
fs.writeFileSync(path.join(out, "test-output.txt"), `${r.out}\n${r.err}`);
fs.rmSync(home, { recursive: true, force: true });
const lcovPath = path.join(out, "lcov.info");
if (!fs.existsSync(lcovPath)) {
  console.error(r.err.slice(-2000));
  process.exit(1);
}
const failed = Number(/(\d+) fail/.exec(r.err)?.[1] ?? 0);
const passed = Number(/(\d+) pass/.exec(r.err)?.[1] ?? 0);

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

// bun lists only files loaded by the test process. Every other src file is added at 0%, counting its
// non-blank, non-comment lines as the executable lines (an estimate; functions are not counted for them).
const loaded = perFile.size;
for (const f of walk(dir, (p) => p.startsWith("src/") && p.endsWith(".ts") && !p.endsWith(".d.ts"))) {
  const rel = f.replace(/^\//, "");
  if (perFile.has(rel)) continue;
  const lines = fs
    .readFileSync(path.join(dir, rel), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "" && !/^\s*(\/\/|\/?\*)/.test(l)).length;
  perFile.set(rel, { lf: lines, lh: 0, fnf: 0, fnh: 0 });
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
  JSON.stringify({ total: { lines: pct(lh, lf), functions: pct(fnh, fnf), lf, lh, fnf, fnh }, files: perFileJson }, null, 2),
);

const summary = [
  `coverage (bun test --coverage, src/): lines ${pct(lh, lf)}% (${lh}/${lf}), functions ${pct(fnh, fnf)}% (${fnh}/${fnf})`,
  `${passed} pass / ${failed} fail across ${files.length} test files in ${wall}s; ${perFile.size - loaded} src files never loaded by a test counted at 0%`,
  "Means: a LOWER BOUND on how much of src/ the tests run. Only code run inside the test process is counted; code reached only by a test that spawns the CLI (about 80 test files) is not.",
  "Does not mean: tested behaviour. A hit line is not an asserted line; bun marks a one-line function as hit when it is only declared, there is no branch data, and the 0% files use an estimated line count and no function count.",
].join("\n");

finish(out, summary, {
  lines_pct: pct(lh, lf),
  functions_pct: pct(fnh, fnf),
  lines_hit: lh,
  lines_total: lf,
  test_failures: failed,
});
