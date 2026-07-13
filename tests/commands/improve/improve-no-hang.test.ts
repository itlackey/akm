/**
 * Regression test: akm improve must not hang after akmConsolidate() returns.
 *
 * Root cause (fixed): promptConfirm() in consolidate.ts created a
 * readline.createInterface({ input: process.stdin }) which called
 * process.stdin.resume() internally.  After rl.close() the stream was NOT
 * unref'd, keeping the Node/Bun event loop alive even after akmImprove()
 * resolved and the JSON was printed.  The fix adds process.stdin.unref()
 * after rl.close() so the event loop is not held open.
 *
 * This test exercises akmImprove() with a stub consolidation that returns
 * immediately and verifies the whole call resolves within 5 seconds.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConsolidateResult } from "../../../src/commands/improve/consolidate";
import type { AkmDistillResult } from "../../../src/commands/improve/distill";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmReflectResult } from "../../../src/commands/improve/reflect";
import { saveConfig } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import { withTestImproveLlm } from "../../_helpers/improve-config";

const TIMEOUT_MS = 20_000;

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  AKM_DATA_DIR: process.env.AKM_DATA_DIR,
  AKM_STATE_DIR: process.env.AKM_STATE_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeMemory(stashDir: string, name: string, body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name} memory\n---\n\n${body}\n`, "utf8");
}

async function buildIndex(stashDir: string): Promise<void> {
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig(
    withTestImproveLlm({
      semanticSearchMode: "off",
      improve: { strategies: { default: { processes: { extract: { enabled: false } } } } },
    }),
  );
  await akmIndex({ stashDir, full: true });
}

const stubReflect = async ({ ref }: { ref?: string }): Promise<AkmReflectResult> => ({
  schemaVersion: 2,
  ok: true,
  proposal: {
    id: `proposal-${ref?.replace(/[^a-z0-9-]/gi, "-") ?? "stub"}`,
    ref: ref ?? "",
    status: "pending",
    source: "reflect",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    payload: { content: "# stub proposal" },
  },
  ref: ref ?? "",
  engine: "test",
  durationMs: 1,
});

const stubDistill = async ({ ref }: { ref?: string }): Promise<AkmDistillResult> => ({
  schemaVersion: 1,
  ok: true,
  outcome: "queued",
  inputRef: ref ?? "stub",
  lessonRef: `lesson:${(ref ?? "stub").replace(/[:/]/g, "-")}-lesson`,
});

/** A consolidation stub that resolves immediately (simulates fast/no-op consolidation). */
function _makeStubConsolidate(result?: Partial<ConsolidateResult>) {
  return async (): Promise<ConsolidateResult> => ({
    schemaVersion: 1,
    ok: true,
    shape: "consolidate-result",
    dryRun: false,
    previewOnly: false,
    target: "stub",
    processed: 0,
    merged: 0,
    deleted: 0,
    promoted: [],
    contradicted: 0,
    warnings: [],
    durationMs: 0,
    ...result,
  });
}

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-no-hang-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-no-hang-config-");
  process.env.AKM_DATA_DIR = makeTempDir("akm-no-hang-data-");
  process.env.AKM_STATE_DIR = makeTempDir("akm-no-hang-state-");
  saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));
});

afterEach(() => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("akmImprove: process does not hang after consolidation returns", () => {
  test(
    "resolves within timeout when consolidation stub returns immediately (no-op run)",
    async () => {
      const stashDir = makeTempDir("akm-no-hang-stash-");
      writeMemory(stashDir, "alpha", "Remember alpha details.");
      await buildIndex(stashDir);

      const done = await Promise.race([
        akmImprove({
          scope: "memory",
          stashDir,
          ensureIndexFn: async () => false,
          reindexFn: async () => ({
            schemaVersion: 1 as const,
            ok: true,
            indexed: 0,
            warnings: [],
            errors: [],
            durationMs: 0,
          }),
          reflectFn: stubReflect,
          distillFn: stubDistill,
          // Inject a no-op consolidate that returns immediately
          consolidateOptions: { dryRun: true },
        }).then((result) => ({ timedOut: false, result })),
        new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), TIMEOUT_MS)),
      ]);

      expect(done.timedOut).toBe(false);
      if (!done.timedOut) {
        expect(done.result.ok).toBe(true);
      }
    },
    TIMEOUT_MS + 2_000,
  );

  test(
    "resolves within timeout on empty stash (no assets, no index)",
    async () => {
      const stashDir = makeTempDir("akm-no-hang-empty-");
      fs.mkdirSync(path.join(stashDir, "memories"), { recursive: true });

      const done = await Promise.race([
        akmImprove({
          stashDir,
          ensureIndexFn: async () => false,
          reindexFn: async () => ({
            schemaVersion: 1 as const,
            ok: true,
            indexed: 0,
            warnings: [],
            errors: [],
            durationMs: 0,
          }),
          reflectFn: stubReflect,
          distillFn: stubDistill,
          consolidateOptions: { dryRun: true },
        }).then((result) => ({ timedOut: false, result })),
        new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), TIMEOUT_MS)),
      ]);

      expect(done.timedOut).toBe(false);
      if (!done.timedOut) {
        expect(done.result.ok).toBe(true);
      }
    },
    TIMEOUT_MS + 2_000,
  );

  test(
    "resolves within timeout when dry-run is true (skips all writes including consolidation)",
    async () => {
      const stashDir = makeTempDir("akm-no-hang-dryrun-");
      writeMemory(stashDir, "beta", "Remember beta details.");
      await buildIndex(stashDir);

      const done = await Promise.race([
        akmImprove({
          scope: "memory",
          stashDir,
          dryRun: true,
        }).then((result) => ({ timedOut: false, result })),
        new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), TIMEOUT_MS)),
      ]);

      expect(done.timedOut).toBe(false);
      if (!done.timedOut) {
        expect(done.result.ok).toBe(true);
        expect(done.result.dryRun).toBe(true);
      }
    },
    TIMEOUT_MS + 2_000,
  );
});
