import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-improve-flags-stash-");
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts", "memories", "lessons"]) {
    fs.mkdirSync(path.join(stash, sub), { recursive: true });
  }
  return stash;
}

function runCli(args: string[], stashDir?: string): { status: number; stdout: string; stderr: string } {
  const xdgCache = makeTempDir("akm-improve-flags-cache-");
  const xdgConfig = makeTempDir("akm-improve-flags-config-");
  const xdgData = makeTempDir("akm-improve-flags-data-");
  const xdgState = makeTempDir("akm-improve-flags-state-");
  const cliPath = path.join(path.resolve(import.meta.dir, "..", ".."), "src", "cli.ts");
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
    },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("improve CLI flags (0.8.0)", () => {
  // 0.8.0 deleted --reflect-cooldown-days / --distill-cooldown-days /
  // --consolidate-cooldown-days. The reflect/distill gates now use
  // signal-delta eligibility (see tests/improve-eligibility.test.ts);
  // consolidate uses pool-delta. citty silently ignores unknown flags
  // so we cannot pin rejection here — the flag-rejection tests were
  // dropped along with the flags.

  test("rejects negative min retrieval count", () => {
    const result = runCli(["improve", "--min-retrieval-count", "-1", "--dry-run"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("--min-retrieval-count");
    expect(parsed.error).toContain("non-negative integer");
  });

  test("rejects invalid consolidate recovery mode", () => {
    const result = runCli(["improve", "--consolidate-recovery", "resume", "--dry-run"]);
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
    const result = runCli(
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
