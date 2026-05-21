/**
 * Tests for the 0.8.0+ default behaviour of `akm improve`:
 *   - Full result JSON is written to `<stash>/.akm/runs/<run-id>/improve-result.json`
 *   - Stdout is empty in default mode — the existing `[improve] ...` log
 *     lines on stderr remain the canonical console UX.
 *   - `--json-to-stdout` restores the prior behaviour (full JSON on stdout,
 *     no file written).
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmImproveResult } from "../../src/commands/improve";
import {
  buildImproveRunId,
  relativeImproveResultPath,
  writeImproveResultFile,
} from "../../src/commands/improve-result-file";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-improve-rtf-stash-");
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts", "memories", "lessons"]) {
    fs.mkdirSync(path.join(stash, sub), { recursive: true });
  }
  return stash;
}

function runCli(args: string[], stashDir: string): { status: number; stdout: string; stderr: string } {
  const xdgCache = makeTempDir("akm-improve-rtf-cache-");
  const xdgConfig = makeTempDir("akm-improve-rtf-config-");
  const xdgData = makeTempDir("akm-improve-rtf-data-");
  const xdgState = makeTempDir("akm-improve-rtf-state-");
  const cliPath = path.join(path.resolve(import.meta.dir, "..", ".."), "src", "cli.ts");
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 60_000,
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
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildImproveRunId", () => {
  test("returns a unique id across consecutive calls", () => {
    const a = buildImproveRunId();
    const b = buildImproveRunId();
    expect(a).not.toEqual(b);
    // Format sanity: ISO-style timestamp with -<8 hex>
    expect(a).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/);
  });
});

describe("relativeImproveResultPath", () => {
  test("returns a stash-relative path (not absolute)", () => {
    const rel = relativeImproveResultPath("test-run");
    expect(path.isAbsolute(rel)).toBe(false);
    expect(rel).toBe(path.join(".akm", "runs", "test-run", "improve-result.json"));
  });
});

describe("writeImproveResultFile", () => {
  test("creates the runs directory and writes the result JSON atomically", () => {
    const stash = makeStashDir();
    const runId = "test-run-write";
    const result: AkmImproveResult = {
      schemaVersion: 1,
      ok: true,
      scope: { mode: "all" },
      dryRun: false,
      memorySummary: { eligible: 1, derived: 0 },
      plannedRefs: [],
    };
    const rel = writeImproveResultFile(stash, runId, result);
    expect(rel).toBe(path.join(".akm", "runs", runId, "improve-result.json"));
    const abs = path.join(stash, rel);
    expect(fs.existsSync(abs)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(abs, "utf8")) as AkmImproveResult;
    expect(parsed.ok).toBe(true);
    expect(parsed.scope.mode).toBe("all");
  });
});

describe("akm improve CLI: result-to-file default + --json-to-stdout escape hatch", () => {
  let stashDir: string;
  beforeEach(() => {
    stashDir = makeStashDir();
  });

  test("default mode writes full JSON to <stash>/.akm/runs/<run-id>/improve-result.json and emits NOTHING on stdout", () => {
    // Use --dry-run so the run completes quickly without LLM calls.
    const result = runCli(["improve", "--dry-run"], stashDir);
    expect(result.status).toBe(0);

    // Stdout is empty — no JSON summary, no envelope, no "result written to" hint.
    expect(result.stdout).toBe("");

    // The result file landed under <stash>/.akm/runs/<run-id>/ with the full body.
    const runsDir = path.join(stashDir, ".akm", "runs");
    expect(fs.existsSync(runsDir)).toBe(true);
    const runIds = fs.readdirSync(runsDir);
    expect(runIds.length).toBe(1);
    const absPath = path.join(runsDir, runIds[0], "improve-result.json");
    expect(fs.existsSync(absPath)).toBe(true);

    const full = JSON.parse(fs.readFileSync(absPath, "utf8")) as Record<string, unknown>;
    expect(full.ok).toBe(true);
    expect(full.dryRun).toBe(true);
    expect(full.memorySummary).toBeDefined();
    expect(full.plannedRefs).toBeDefined();

    // No "improve result written to" hint on stderr — the existing [improve]
    // log lines from improve.ts are the canonical console UX.
    expect(result.stderr).not.toContain("improve result written to");
  });

  test("--json-to-stdout restores prior behaviour: full JSON on stdout, no file written", () => {
    const result = runCli(["improve", "--dry-run", "--json-to-stdout"], stashDir);
    expect(result.status).toBe(0);

    // Stdout has the full result body.
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.memorySummary).toBeDefined();
    expect(parsed.plannedRefs).toBeDefined();
    // No envelope-only fields in legacy mode.
    expect(parsed.runId).toBeUndefined();
    expect(parsed.resultPath).toBeUndefined();
    expect(parsed.summary).toBeUndefined();

    // No file under .akm/runs/.
    const runsDir = path.join(stashDir, ".akm", "runs");
    if (fs.existsSync(runsDir)) {
      const entries = fs.readdirSync(runsDir);
      expect(entries.length).toBe(0);
    }

    // Stderr should NOT contain the "improve result written to" hint.
    expect(result.stderr).not.toContain("improve result written to");
  });

  test("two consecutive default-mode runs produce distinct run ids and distinct result files", () => {
    const a = runCli(["improve", "--dry-run"], stashDir);
    expect(a.status).toBe(0);
    expect(a.stdout).toBe("");

    const b = runCli(["improve", "--dry-run"], stashDir);
    expect(b.status).toBe(0);
    expect(b.stdout).toBe("");

    const runsDir = path.join(stashDir, ".akm", "runs");
    const runIds = fs.readdirSync(runsDir);
    expect(runIds.length).toBe(2);
    expect(runIds[0]).not.toEqual(runIds[1]);
    for (const id of runIds) {
      expect(fs.existsSync(path.join(runsDir, id, "improve-result.json"))).toBe(true);
    }
  });
});
