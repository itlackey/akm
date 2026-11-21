// quality:compare — the static measures (and, with --coverage, test coverage) for two committed trees.
//   bun scripts/quality/compare.ts <base> [<head>=HEAD] [--coverage]
// Both refs are exported with `git archive`, so uncommitted files never count and nothing is registered in git.
// Both sides are measured with the tool configs and pins of the checkout that runs this script.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot, round, run, walk } from "./lib";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const withCoverage = process.argv.includes("--coverage");
const [base, head = "HEAD"] = args;
if (!base) {
  console.error("usage: quality:compare -- <base> [<head>=HEAD] [--coverage]");
  process.exit(2);
}

const outRoot = path.join(repoRoot, "reports", "quality", "compare");
fs.rmSync(outRoot, { recursive: true, force: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "akm-quality-compare-"));

function exportTree(ref: string, name: string): string {
  const dest = path.join(work, name);
  fs.mkdirSync(dest, { recursive: true });
  const r = Bun.spawnSync(["sh", "-c", `git archive "$1" | tar -x -C "$2"`, "sh", ref, dest], {
    cwd: repoRoot,
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    console.error(`cannot export ${ref}: ${r.stderr.toString()}`);
    process.exit(1);
  }
  return dest;
}

function lineCount(dir: string, prefix: string): { files: number; lines: number } {
  const files = walk(dir, (p) => p.replace(/^\//, "").startsWith(prefix) && /\.ts$/.test(p));
  let lines = 0;
  for (const f of files) lines += fs.readFileSync(path.join(dir, f), "utf8").split("\n").length;
  return { files: files.length, lines };
}

type Metrics = Record<string, number | string>;

function measure(side: string, ref: string): Metrics {
  const dir = exportTree(ref, side);
  const all: Metrics = {};
  const tools = ["complexity", "duplication", "dead-code", ...(withCoverage ? ["coverage"] : [])];
  if (withCoverage) {
    const i = run(["bun", "install", "--frozen-lockfile"], dir);
    if (i.code !== 0) console.error(`${side}: bun install failed: ${i.err.slice(-500)}`);
  }
  const src = lineCount(dir, "src/");
  const tests = lineCount(dir, "tests/");
  all["src files"] = src.files;
  all["src lines"] = src.lines;
  all["tests files"] = tests.files;
  all["tests lines"] = tests.lines;
  for (const tool of tools) {
    const out = path.join(outRoot, side, tool);
    console.error(`${side}: ${tool}...`);
    const r = run(["bun", path.join(import.meta.dir, `${tool}.ts`), "--dir", dir, "--out", out], repoRoot);
    const mp = path.join(out, "metrics.json");
    if (r.code !== 0 || !fs.existsSync(mp)) {
      console.error(`${side}: ${tool} failed: ${(r.err || r.out).slice(-500)}`);
      continue;
    }
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(mp, "utf8")) as Metrics)) all[`${tool}: ${k}`] = v;
  }
  return all;
}

try {
  const a = measure("base", base);
  const b = measure("head", head);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const rows = keys.map((k) => {
    const x = a[k];
    const y = b[k];
    const delta = typeof x === "number" && typeof y === "number" ? round(y - x) : "";
    return { measure: k, base: x ?? "-", head: y ?? "-", delta };
  });
  const w = Math.max(...rows.map((r) => r.measure.length));
  const lines = [
    `quality compare: base ${base} -> head ${head}${withCoverage ? " (with coverage)" : ""}`,
    `${"measure".padEnd(w)}  ${"base".padStart(10)}  ${"head".padStart(10)}  ${"delta".padStart(9)}`,
    ...rows.map(
      (r) =>
        `${r.measure.padEnd(w)}  ${String(r.base).padStart(10)}  ${String(r.head).padStart(10)}  ${String(r.delta).padStart(9)}`,
    ),
    "Deltas are head minus base. Lower is better for complexity, duplication and dead code; higher for coverage.",
    "Same caveats as each tool's own summary: coverage is a lower bound, and splitting files lowers FTA and duplication without removing logic.",
  ];
  fs.mkdirSync(outRoot, { recursive: true });
  fs.writeFileSync(path.join(outRoot, "summary.txt"), `${lines.join("\n")}\n`);
  fs.writeFileSync(path.join(outRoot, "compare.json"), `${JSON.stringify({ base, head, rows }, null, 2)}\n`);
  console.log(lines.join("\n"));
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
