/**
 * `distill` remains an internal/programmatic primitive, but the public CLI
 * command was removed in the 0.8.0 hard-break redesign.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCliCapture } from "../../_helpers/cli";
import { withEnv } from "../../_helpers/sandbox";

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

/**
 * Drive the CLI in-process with fresh sandboxed HOME/XDG dirs (and
 * AKM_STASH_DIR cleared), mirroring the env the old subprocess runner set.
 *
 * Exit-code note: the real entry point exits 1 on citty's "Unknown command",
 * but in the in-process harness the escaped error is classified via
 * classifyExitCode → 70 (internal). The tests therefore assert only that the
 * exit code is non-zero; the "Unknown command" message lands on captured
 * stderr either way.
 */
async function runCli(
  args: string[],
  options?: { env?: Record<string, string | undefined> },
): Promise<{ stdout: string; stderr: string; status: number }> {
  const result = await withEnv(
    {
      AKM_STASH_DIR: undefined,
      HOME: makeTempDir("akm-distill-cli-home-"),
      XDG_CACHE_HOME: makeTempDir("akm-distill-cli-cache-"),
      XDG_CONFIG_HOME: makeTempDir("akm-distill-cli-config-"),
      XDG_DATA_HOME: makeTempDir("akm-distill-cli-data-"),
      XDG_STATE_HOME: makeTempDir("akm-distill-cli-state-"),
      ...options?.env,
    },
    () => runCliCapture(args),
  );
  return { stdout: result.stdout, stderr: result.stderr, status: result.code };
}

describe("akm distill CLI removal (0.8.0 hard break)", () => {
  test("legacy distill command is rejected as unknown", async () => {
    const result = await runCli(["distill", "skill:foo"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Unknown command");
    expect(`${result.stdout}\n${result.stderr}`).toContain("distill");
  });

  test("legacy distill flags do not restore the removed command", async () => {
    const result = await runCli(
      ["distill", "skill:foo", "--exclude-feedback-from", "skill:bar", "--source-run", "run-abc-123"],
      {
        env: { AKM_DISTILL_EXCLUDE_FEEDBACK_FROM: "memory:baz" },
      },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Unknown command");
    expect(`${result.stdout}\n${result.stderr}`).toContain("distill");
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
import { akmDistill } from "../../../src/commands/improve/distill";
import { listProposals } from "../../../src/commands/proposal/validators/proposals";
import type { AkmConfig } from "../../../src/core/config/config";

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
  process.env.XDG_DATA_HOME = happyTempDir("akm-distill-happy-data-");
  process.env.XDG_STATE_HOME = happyTempDir("akm-distill-happy-state-");
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
      profiles: {
        llm: { default: { endpoint: "http://localhost:11434/v1/chat/completions", model: "test-model" } },
        improve: { default: { processes: { distill: { enabled: true } } } },
      },
      defaults: { llm: "default" },
    } as unknown as AkmConfig;
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
      profiles: {
        llm: { default: { endpoint: "http://localhost:11434/v1/chat/completions", model: "test-model" } },
        improve: { default: { processes: { distill: { enabled: true } } } },
      },
      defaults: { llm: "default" },
    } as unknown as AkmConfig;
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
