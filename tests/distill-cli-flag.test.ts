/**
 * Tests for the `akm distill --exclude-feedback-from` CLI flag (#267).
 *
 * The flag and the `AKM_DISTILL_EXCLUDE_FEEDBACK_FROM` env var both feed
 * the same `excludeFeedbackFromRefs` option on `akmDistill`. We exercise
 * the CLI dispatcher as a real subprocess so flag parsing + validation
 * runs end-to-end, including the UsageError → exit 2 contract for invalid
 * refs.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDirs: string[] = [];

function makeTempDir(prefix = "akm-distill-cli-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function runCli(
  args: string[],
  options?: { env?: Record<string, string | undefined> },
): { stdout: string; stderr: string; status: number } {
  const xdgCache = makeTempDir("akm-distill-cli-cache-");
  const xdgConfig = makeTempDir("akm-distill-cli-config-");
  const home = makeTempDir("akm-distill-cli-home-");
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    cwd: repoRoot,
    env: {
      ...process.env,
      AKM_STASH_DIR: undefined,
      HOME: home,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      ...options?.env,
    },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

describe("akm distill --exclude-feedback-from flag (#267)", () => {
  test("invalid ref in --exclude-feedback-from → exits 2 (USAGE)", () => {
    const result = runCli(["distill", "skill:foo", "--exclude-feedback-from", "not-a-ref"]);
    expect(result.status).toBe(2);
    // Error envelope is JSON on stderr.
    expect(result.stderr).toContain("Invalid --exclude-feedback-from ref");
    expect(result.stderr).toContain("not-a-ref");
  });

  test("invalid ref in env var fallback → also exits 2", () => {
    const result = runCli(["distill", "skill:foo"], {
      env: { AKM_DISTILL_EXCLUDE_FEEDBACK_FROM: "this-is-not-a-ref" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid --exclude-feedback-from ref");
  });

  test("multiple invalid refs surface the first failure", () => {
    const result = runCli(["distill", "skill:foo", "--exclude-feedback-from", "skill:ok,bad-ref,memory:also-ok"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("bad-ref");
  });

  test("valid CSV refs parse without flag-parse panic (smoke)", () => {
    // The command will likely fail downstream because no llm config exists
    // and no asset is indexed, but flag parsing must not be the failure
    // mode — assert exit != 2 (anything but USAGE), or accept 0/1.
    const result = runCli(["distill", "skill:foo", "--exclude-feedback-from", "skill:bar,memory:baz"]);
    expect(result.status).not.toBe(2);
  });

  test("env var with valid CSV parses without crash", () => {
    const result = runCli(["distill", "skill:foo"], {
      env: { AKM_DISTILL_EXCLUDE_FEEDBACK_FROM: "skill:a,memory:b" },
    });
    expect(result.status).not.toBe(2);
  });

  test("origin-prefixed refs are accepted", () => {
    const result = runCli(["distill", "skill:foo", "--exclude-feedback-from", "team//skill:bar,npm:pkg//memory:baz"]);
    expect(result.status).not.toBe(2);
  });

  test("empty --exclude-feedback-from value is treated as no exclusion (no parse error)", () => {
    const result = runCli(["distill", "skill:foo", "--exclude-feedback-from", ""]);
    expect(result.status).not.toBe(2);
  });

  test("CLI flag takes precedence over env var (the flag is parsed regardless of env value)", () => {
    // If precedence were wrong, the invalid env var would surface first.
    // With correct precedence, the valid flag wins and no UsageError fires.
    const result = runCli(["distill", "skill:foo", "--exclude-feedback-from", "skill:valid"], {
      env: { AKM_DISTILL_EXCLUDE_FEEDBACK_FROM: "this-would-be-invalid" },
    });
    expect(result.status).not.toBe(2);
  });

  // ── #284 GAP-CRIT 3 backfill ──────────────────────────────────────────────

  test("--source-run flag is accepted by the CLI parser (flag wiring smoke)", () => {
    // No llm config → command exits non-zero (0/1) but must not be a USAGE
    // error — flag parsing for `--source-run` is the only thing under test.
    const result = runCli(["distill", "skill:foo", "--source-run", "run-abc-123"]);
    expect(result.status).not.toBe(2);
    // stderr (if present) should NOT mention --source-run as an unknown flag.
    expect(result.stderr).not.toMatch(/unknown.*--source-run|invalid.*--source-run/i);
  });

  test("AKM_DISTILL_EXCLUDE_FEEDBACK_FROM env-fallback is read when --exclude-feedback-from is omitted", () => {
    // Drives the env-fallback branch in src/cli.ts:
    //   const excludeRaw = excludeFlag ?? excludeEnv;
    // An invalid env value must surface as USAGE (exit 2) → proves the fallback ran.
    const result = runCli(["distill", "skill:foo"], {
      env: { AKM_DISTILL_EXCLUDE_FEEDBACK_FROM: "this-is-not-a-ref" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid --exclude-feedback-from ref");
  });
});

// ── #284 GAP-CRIT 3: distill happy-path via injected chat seam ─────────────
//
// Spawning the real CLI cannot exercise the LLM happy path without a real
// endpoint, so we drive `akmDistill` with the same seams as `tests/distill.test.ts`
// to lock the success contract: outcome=queued, exit=0 (when wrapped via
// runWithJsonErrors in the CLI), proposal materialised in the queue.

import {
  afterEach as afterEachHappy,
  beforeEach as beforeEachHappy,
  describe as describeHappy,
  expect as expectHappy,
  test as testHappy,
} from "bun:test";
import { akmDistill } from "../src/commands/distill";
import type { AkmConfig } from "../src/core/config";
import { listProposals } from "../src/core/proposals";

const happyTempDirs: string[] = [];

function happyTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  happyTempDirs.push(dir);
  return dir;
}

function happyStash(): string {
  const stash = happyTempDir("akm-distill-happy-stash-");
  for (const sub of ["lessons", "skills", "memories"]) {
    fs.mkdirSync(path.join(stash, sub), { recursive: true });
  }
  return stash;
}

const HAPPY_LESSON = `---
description: Prefer ripgrep over grep on large repos
when_to_use: Searching for symbols across a multi-thousand-file repo
---

Use rg.
`;

beforeEachHappy(() => {
  process.env.XDG_CACHE_HOME = happyTempDir("akm-distill-happy-cache-");
  process.env.XDG_CONFIG_HOME = happyTempDir("akm-distill-happy-config-");
});

afterEachHappy(() => {
  for (const dir of happyTempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describeHappy("akm distill happy-path (#284 CRIT 3)", () => {
  testHappy("LLM stub returns valid lesson → outcome=queued, proposal in queue", async () => {
    const stash = happyStash();
    const config: AkmConfig = {
      stashDir: stash,
      sources: [{ type: "filesystem", name: "stash", path: stash, writable: true }],
      defaultWriteTarget: "stash",
      llm: {
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "test-model",
        features: { feedback_distillation: true },
      },
    } as AkmConfig;
    const result = await akmDistill({
      ref: "skill:deploy",
      config,
      stashDir: stash,
      chat: async () => HAPPY_LESSON,
      lookupFn: async () => null,
      readEventsFn: (() => ({ events: [], nextOffset: 0 })) as never,
    });
    expectHappy(result.outcome).toBe("queued");
    expectHappy(typeof result.proposalId).toBe("string");
    expectHappy(listProposals(stash).length).toBe(1);
  });

  testHappy("--source-run sourceRun param threads onto the queued proposal", async () => {
    const stash = happyStash();
    const config: AkmConfig = {
      stashDir: stash,
      sources: [{ type: "filesystem", name: "stash", path: stash, writable: true }],
      defaultWriteTarget: "stash",
      llm: {
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "test-model",
        features: { feedback_distillation: true },
      },
    } as AkmConfig;
    const result = await akmDistill({
      ref: "skill:deploy",
      config,
      stashDir: stash,
      chat: async () => HAPPY_LESSON,
      lookupFn: async () => null,
      readEventsFn: (() => ({ events: [], nextOffset: 0 })) as never,
      sourceRun: "run-abc-123",
    });
    expectHappy(result.outcome).toBe("queued");
    const proposals = listProposals(stash);
    expectHappy(proposals[0]?.sourceRun).toBe("run-abc-123");
  });
});
