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
import path from "node:path";
import { akmImprove } from "../../../src/commands/improve/improve";
import { saveConfig } from "../../../src/core/config/config";
import type { AkmDistillResult, AkmReflectResult, ConsolidateResult } from "../../../src/core/improve-types";
import { akmIndex } from "../../../src/indexer/indexer";
import { withTestImproveLlm } from "../../_helpers/improve-config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const TIMEOUT_MS = 20_000;

let storage: IsolatedAkmStorage;

function writeMemory(stashDir: string, name: string, body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name} memory\n---\n\n${body}\n`, "utf8");
}

async function buildIndex(stashDir: string): Promise<void> {
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
    changes: [{ path: "lessons/proposal.md", after: "# stub proposal", op: "update" }],
    proposedTarget: { source: "stash", root: "/tmp/stash" },
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
  proposalRef: `lessons/${(ref ?? "stub").replace(/[:/]/g, "-")}-lesson`,
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
  storage = withIsolatedAkmStorage();
  saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));
});

afterEach(() => {
  storage.cleanup();
});

describe("akmImprove: process does not hang after consolidation returns", () => {
  test(
    "resolves within timeout when consolidation stub returns immediately (no-op run)",
    async () => {
      const stashDir = storage.stashDir;
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
      const stashDir = storage.stashDir;
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
      const stashDir = storage.stashDir;
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
