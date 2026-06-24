import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
// The two flag-rejection tests were migrated to the in-process harness
// (tests/_helpers/cli.ts): they fail during arg parsing before any DB access,
// so they need no stash and carry no subprocess cost.
//
// HARNESS GAP — KEPT AS A SUBPROCESS: the `improve --dry-run` happy path still
// runs `improve` for real, which opens and writes the state.db (improve_runs).
// In-process, a SQLite write lock on state.db is already held within the test
// process (the suite keeps DB handles open across the run), so the in-process
// improve aborts with "state DB busy/locked after retries" — a genuine
// process-level contention that a fresh subprocess does not have. Until the
// harness grows a way to release/clear all state.db handles before an
// improve-executing call, this test spawns a real `bun src/cli.ts` so it gets a
// clean, uncontended DB. The local helper passes env to spawnSync rather than
// mutating process.env, so it does not affect the in-process tests.
//
// (The runCli import for the in-process tests stays inline below.)
import { runCliCapture } from "../../_helpers/cli";
import { type SandboxedDir, makeStashDir as sandboxMakeStashDir } from "../../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

function makeStashDir(): string {
  const stash = sandboxMakeStashDir();
  disposers.push(stash);
  return stash.dir;
}

async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

/** Subprocess runner for the improve-executing test (see HARNESS GAP above). */
function spawnImprove(args: string[], stashDir: string): { status: number; stdout: string; stderr: string } {
  const data = sandboxMakeStashDir();
  disposers.push(data);
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
      XDG_DATA_HOME: data.dir,
    },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

describe("improve CLI flags (0.8.0)", () => {
  // 0.8.0 deleted --reflect-cooldown-days / --distill-cooldown-days /
  // --consolidate-cooldown-days. The reflect/distill gates now use
  // signal-delta eligibility (see tests/improve-eligibility.test.ts);
  // consolidate uses pool-delta. citty silently ignores unknown flags
  // so we cannot pin rejection here — the flag-rejection tests were
  // dropped along with the flags.

  test("rejects negative min retrieval count", async () => {
    const result = await runCli(["improve", "--min-retrieval-count", "-1", "--dry-run"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("--min-retrieval-count");
    expect(parsed.error).toContain("non-negative integer");
  });

  test("rejects invalid consolidate recovery mode", async () => {
    const result = await runCli(["improve", "--consolidate-recovery", "resume", "--dry-run"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("--consolidate-recovery");
    expect(parsed.error).toContain("abort");
    expect(parsed.error).toContain("clean");
  });

  test("improve dry-run completes successfully (no cooldown flags needed)", () => {
    const stash = makeStashDir();
    const result = spawnImprove(
      [
        "improve",
        "--dry-run",
        // 0.8.0+ default mode writes JSON to a file; use the legacy escape
        // hatch so this assertion can read `ok` from stdout.
        "--json-to-stdout",
      ],
      stash,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });
});
