// Shared helpers for the on-demand quality scripts (see docs/architecture/testing/testing-workflow.md).
// Every script measures a source tree: `--dir <tree>` (default: the repo these scripts live in) and
// writes its reports to `--out <dir>` (default: reports/quality/<tool> in that repo).
import fs from "node:fs";
import path from "node:path";

export const repoRoot = path.resolve(import.meta.dir, "..", "..");

// Exact tool pins. Tools run through bunx so nothing lands in package.json or the lockfile.
export const pins = {
  fta: "fta-cli@3.1.0",
  jscpd: "jscpd@5.4.3",
  knip: "knip@6.47.0",
  stryker: "@stryker-mutator/core@10.1.1",
};

export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Resolve the measured tree and a fresh report directory for one tool. */
export function target(tool: string, argv: string[]): { dir: string; out: string } {
  const dir = path.resolve(flag(argv, "dir") ?? repoRoot);
  const out = path.resolve(flag(argv, "out") ?? path.join(repoRoot, "reports", "quality", tool));
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  return { dir, out };
}

export function run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout?.toString() ?? "", err: r.stderr?.toString() ?? "" };
}

/** Print both streams of a failed tool run (some tools put the reason on stdout) and exit. */
export function die(r: { out: string; err: string }): never {
  console.error(`${r.out}\n${r.err}`.trim().slice(-4000));
  process.exit(1);
}

/** Write summary.txt and metrics.json (flat numbers the compare script diffs), and echo the summary. */
export function finish(out: string, summary: string, metrics: Record<string, number | string>): void {
  fs.writeFileSync(path.join(out, "summary.txt"), `${summary}\n`);
  fs.writeFileSync(path.join(out, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(summary);
}

export function walk(root: string, keep: (rel: string) => boolean): string[] {
  const found: string[] = [];
  const visit = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) visit(r);
      else if (keep(r)) found.push(r);
    }
  };
  visit("");
  return found;
}

export const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
