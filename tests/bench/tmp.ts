/**
 * Bench tmp-root redirection (#276).
 *
 * Every bench tmp directory — per-(task, arm, seed) workspace, per-task
 * fixture stash, per-fixture evolveStash + preStash, plus the scratch dirs
 * spun up inside unit tests — lives under `${AKM_CACHE_DIR}/bench/`, NOT
 * `os.tmpdir()`.
 *
 * Why: during long bench/workflow runs, orphan tmp dirs from crashed agents
 * accumulate. When they pile up under `/tmp` the OS-level partition fills,
 * which breaks shells, browsers, npm caches, and the rest of the system.
 * Pinning bench tmp to the akm cache dir means a single
 * `rm -rf "$(akm config get cache.dir)/bench"` purges all bench scratch
 * without disturbing anything else.
 *
 * The bench cleanup machinery (`tests/bench/cleanup.ts`) also reaps
 * `${AKM_CACHE_DIR}/bench/*` entries older than 6 hours on the first
 * `registerCleanup` call to catch orphans from prior crashed runs.
 *
 * NOTE: this helper deliberately does NOT import `os.tmpdir()`. The
 * invariant test (`tests/bench/no-os-tmpdir-invariant.test.ts`) asserts
 * zero `os.tmpdir` references across `tests/bench/*.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { getCacheDir } from "../../src/core/paths";

/** Bench-tmp root: `${AKM_CACHE_DIR}/bench/`. Created lazily. */
export function benchTmpRoot(): string {
  const root = path.join(getCacheDir(), "bench");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Create a fresh tmp directory under `benchTmpRoot()`.
 *
 * Drop-in replacement for `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`.
 * The returned absolute path is unique per call.
 */
export function benchMkdtemp(prefix: string): string {
  return fs.mkdtempSync(path.join(benchTmpRoot(), prefix));
}

/** Stable bench-report root under `${AKM_CACHE_DIR}/bench-reports/`. */
export function benchReportRoot(): string {
  const root = path.join(getCacheDir(), "bench-reports");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function slugify(value: string): string {
  const slug = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length > 80 ? slug.slice(0, 80) : slug || "unknown";
}

export interface BenchReportJson {
  track: string;
  timestamp: string;
  branch: string;
  commit: string;
  agent: { model: string } & Record<string, unknown>;
}

export type BenchReportEnvelope = BenchReportJson & Record<string, unknown>;

/** Stable per-run report artifact path under `${AKM_CACHE_DIR}/bench/`. */
export function benchReportPath(report: BenchReportJson): string {
  const filename = [
    "bench-report",
    slugify(report.track),
    slugify(report.branch),
    slugify(report.commit),
    slugify(report.timestamp),
    slugify(report.agent.model),
  ].join("-");
  return path.join(benchReportRoot(), `${filename}.json`);
}

/** Write a full bench report JSON envelope to disk and return its path. */
export function writeBenchReportJson<T extends BenchReportJson>(report: T): string {
  const outPath = benchReportPath(report);
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return outPath;
}

// ── PID file ────────────────────────────────────────────────────────────────

/** Absolute path to the bench PID file: `${AKM_CACHE_DIR}/bench/bench.pid`. */
export function benchPidPath(): string {
  return path.join(benchTmpRoot(), "bench.pid");
}

/**
 * Write `process.pid` to `bench.pid`.
 *
 * If a stale PID file exists and the referenced process is no longer running,
 * it is removed with a warning before writing the new one.
 *
 * Returns a cleanup function that removes the PID file. Call it in a
 * `finally` block so the file is removed on both clean exit and exceptions.
 */
export function writeBenchPid(): () => void {
  const pidPath = benchPidPath();

  // Check for an existing PID file and warn if stale.
  if (fs.existsSync(pidPath)) {
    let existingPid: number | undefined;
    try {
      const raw = fs.readFileSync(pidPath, "utf8").trim();
      existingPid = Number.parseInt(raw, 10);
    } catch {
      // Unreadable — treat as stale.
    }

    if (existingPid !== undefined && Number.isFinite(existingPid) && !isPidRunning(existingPid)) {
      // Stale PID — warn and remove.
      process.stderr.write(`bench: removing stale PID file for PID ${existingPid} (process not running)\n`);
      try {
        fs.rmSync(pidPath, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  try {
    fs.writeFileSync(pidPath, String(process.pid), "utf8");
  } catch {
    /* best-effort — PID file is diagnostic, not critical */
  }

  return () => {
    try {
      // Only remove if it still contains our PID (guard against races).
      const current = fs.readFileSync(pidPath, "utf8").trim();
      if (current === String(process.pid)) {
        fs.rmSync(pidPath, { force: true });
      }
    } catch {
      /* best-effort */
    }
  };
}

/**
 * Read the PID from `bench.pid`. Returns `undefined` when the file does not
 * exist or cannot be parsed.
 */
export function readBenchPid(): number | undefined {
  const pidPath = benchPidPath();
  if (!fs.existsSync(pidPath)) return undefined;
  try {
    const raw = fs.readFileSync(pidPath, "utf8").trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Return `true` when the process with the given PID is running on this host.
 * Uses `process.kill(pid, 0)` — signal 0 is a no-op probe that throws ESRCH
 * when the process does not exist and EPERM when it exists but is owned by
 * another user (in which case it IS running).
 */
export function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we don't have permission to signal it.
    return code === "EPERM";
  }
}
