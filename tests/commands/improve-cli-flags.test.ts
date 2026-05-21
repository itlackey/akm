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

describe("improve CLI cooldown flags", () => {
  test("rejects negative reflect cooldown days", () => {
    const result = runCli(["improve", "--reflect-cooldown-days", "-1", "--dry-run"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("--reflect-cooldown-days");
    expect(parsed.error).toContain("non-negative integer");
  });

  test("rejects negative distill cooldown days", () => {
    const result = runCli(["improve", "--distill-cooldown-days", "-1", "--dry-run"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("--distill-cooldown-days");
    expect(parsed.error).toContain("non-negative integer");
  });

  test("rejects negative consolidate cooldown days", () => {
    const result = runCli(["improve", "--consolidate-cooldown-days", "-1", "--dry-run"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("--consolidate-cooldown-days");
    expect(parsed.error).toContain("non-negative integer");
  });

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

  test("--ignore-cooldown takes precedence over explicit cooldown values", () => {
    const stash = makeStashDir();
    const result = runCli(
      [
        "improve",
        "--dry-run",
        "--ignore-cooldown",
        "--reflect-cooldown-days",
        "-1",
        "--distill-cooldown-days",
        "-1",
        "--consolidate-cooldown-days",
        "-1",
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
