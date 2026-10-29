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
 * AKM_BUNDLE_DIR cleared), mirroring the env the old subprocess runner set.
 *
 * Exit-code note: an unknown command (citty's "Unknown command", R-032,
 * commit 96ff2fe; pinned at tests/integration/cli-errors.test.ts:383-389)
 * exits 2 with a machine-readable `{ ok: false, code: "UNKNOWN_COMMAND" }`
 * envelope on stderr — verified live via the in-process harness.
 */
async function runCli(
  args: string[],
  options?: { env?: Record<string, string | undefined> },
): Promise<{ stdout: string; stderr: string; status: number }> {
  const result = await withEnv(
    {
      AKM_BUNDLE_DIR: undefined,
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
    const result = await runCli(["distill", "skills/foo"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "UNKNOWN_COMMAND" });
    expect(`${result.stdout}\n${result.stderr}`).toContain("Unknown command");
    expect(`${result.stdout}\n${result.stderr}`).toContain("distill");
  });

  test("legacy distill flags do not restore the removed command", async () => {
    const result = await runCli(
      ["distill", "skills/foo", "--exclude-feedback-from", "skills/bar", "--source-run", "run-abc-123"],
      {
        env: { AKM_DISTILL_EXCLUDE_FEEDBACK_FROM: "memories/baz" },
      },
    );
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "UNKNOWN_COMMAND" });
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
import { listProposals } from "../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

function happyStash(storage: IsolatedAkmStorage): string {
  const stash = storage.stashDir;
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

let happyStorage: IsolatedAkmStorage;

beforeEachHappy(() => {
  happyStorage = withIsolatedAkmStorage();
});

afterEachHappy(() => {
  happyStorage.cleanup();
});

describeHappy("akm distill happy-path (#284 CRIT 3)", () => {
  testHappy("LLM stub returns valid lesson → outcome=queued, proposal in queue", async () => {
    const stash = happyStash(happyStorage);
    const config: AkmConfig = {
      configVersion: "0.9.0",
      bundles: { stash: { path: stash, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
      connections: {
        default: {
          endpoint: "http://localhost:11434/v1/chat/completions",
          models: { fast: "test-model" },
        },
      },
      improve: {
        strategy: "test",
        strategies: { test: { processes: { distill: { enabled: true, qualityGate: { enabled: false } } } } },
      },
    } as unknown as AkmConfig;
    const result = await akmDistill({
      ref: "skills/deploy",
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
    const stash = happyStash(happyStorage);
    const config: AkmConfig = {
      configVersion: "0.9.0",
      bundles: { stash: { path: stash, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
      connections: {
        default: {
          endpoint: "http://localhost:11434/v1/chat/completions",
          models: { fast: "test-model" },
        },
      },
      improve: {
        strategy: "test",
        strategies: { test: { processes: { distill: { enabled: true, qualityGate: { enabled: false } } } } },
      },
    } as unknown as AkmConfig;
    const result = await akmDistill({
      ref: "skills/deploy",
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
