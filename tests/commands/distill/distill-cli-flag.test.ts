/**
 * `distill` remains an internal/programmatic primitive, but the public CLI
 * command was removed in the 0.8.0 hard-break redesign.
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

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function runCli(
  args: string[],
  options?: { env?: Record<string, string | undefined> },
): { stdout: string; stderr: string; status: number } {
  const xdgCache = makeTempDir("akm-distill-cli-cache-");
  const xdgConfig = makeTempDir("akm-distill-cli-config-");
  const xdgData = makeTempDir("akm-distill-cli-data-");
  const xdgState = makeTempDir("akm-distill-cli-state-");
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
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
      ...options?.env,
    },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

describe("akm distill CLI removal (0.8.0 hard break)", () => {
  test("legacy distill command is rejected as unknown", () => {
    const result = runCli(["distill", "skill:foo"]);
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Unknown command");
    expect(`${result.stdout}\n${result.stderr}`).toContain("distill");
  });

  test("legacy distill flags do not restore the removed command", () => {
    const result = runCli(
      ["distill", "skill:foo", "--exclude-feedback-from", "skill:bar", "--source-run", "run-abc-123"],
      {
        env: { AKM_DISTILL_EXCLUDE_FEEDBACK_FROM: "memory:baz" },
      },
    );
    expect(result.status).toBe(1);
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
import type { AkmConfig } from "../../../src/core/config";
import { listProposals } from "../../../src/core/proposals";

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
