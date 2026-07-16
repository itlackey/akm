// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #591 regression: `collectEligibleRefs` pre-resolves each candidate's on-disk
 * path into `ImproveEligibleRef.filePath` at planning time.
 *
 * Before the fix, the Phase-1 validation pass and the final disk-existence
 * guard each called `findAssetFilePath()` (an async index lookup) in a serial
 * for…await loop over every planned ref — ~510 s of sequential DB lookups on a
 * ~9 000-ref stash before any real work began. With the fix both loops use the
 * pre-resolved path with a synchronous existsSync, falling back to the async
 * lookup only when the pre-resolved file has vanished.
 *
 * These tests pin the contract that makes the fast path possible: every
 * planned ref (scope-all and scope-ref) carries a `filePath` that points at
 * the real asset file, and a stale pre-resolved path still falls back safely.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import type { AkmDistillResult } from "../../../../src/commands/improve/distill";
import { akmImprove } from "../../../../src/commands/improve/improve";
import type { AkmReflectResult } from "../../../../src/commands/improve/reflect";
import { saveConfig } from "../../../../src/core/config/config";
import { appendEvent } from "../../../../src/core/events";
import { akmIndex } from "../../../../src/indexer/indexer";
import { withTestImproveLlm } from "../../../_helpers/improve-config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

function writeLesson(stashDir: string, name: string): string {
  const filePath = path.join(stashDir, "lessons", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `---\ndescription: lesson ${name}\nwhen_to_use: testing ${name}\n---\n\n# ${name}\n`,
    "utf8",
  );
  return filePath;
}

async function indexStash(stashDir: string): Promise<void> {
  saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));
  await akmIndex({ stashDir, full: true });
}

const stubReflect = (ref: string): AkmReflectResult => ({
  schemaVersion: 2,
  ok: true,
  ref,
  engine: "test-agent",
  durationMs: 1,
  proposal: {
    id: `reflect-${ref.replace(/[^a-z0-9]/gi, "-")}`,
    ref,
    status: "pending",
    source: "reflect",
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
    payload: { content: "# stub reflect" },
    changes: [{ path: "", after: "# stub reflect", op: "update" }],
  },
});

const stubDistill = (ref: string): AkmDistillResult => ({
  schemaVersion: 1,
  ok: true,
  outcome: "queued",
  inputRef: ref,
  lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
});

describe("#591: planned refs carry a pre-resolved filePath", () => {
  test("scope-all planning populates filePath from the index for every planned ref", async () => {
    const stash = storage.stashDir;
    const alphaPath = writeLesson(stash, "alpha");
    const betaPath = writeLesson(stash, "beta");
    await indexStash(stash);

    const result = await akmImprove({ stashDir: stash, dryRun: true });

    expect(result.ok).toBe(true);
    const byRef = new Map(result.plannedRefs.map((p) => [p.ref, p]));
    expect(fs.realpathSync(byRef.get("lesson:alpha")?.filePath ?? "")).toBe(fs.realpathSync(alphaPath));
    expect(fs.realpathSync(byRef.get("lesson:beta")?.filePath ?? "")).toBe(fs.realpathSync(betaPath));
    for (const planned of result.plannedRefs) {
      expect(planned.filePath).toBeDefined();
      expect(fs.existsSync(planned.filePath ?? "")).toBe(true);
    }
  });

  test("scope-ref planning populates filePath from the resolver", async () => {
    const stash = storage.stashDir;
    const alphaPath = writeLesson(stash, "alpha");
    await indexStash(stash);

    const result = await akmImprove({ stashDir: stash, scope: "lesson:alpha", dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.plannedRefs).toHaveLength(1);
    expect(result.plannedRefs[0]?.ref).toBe("lesson:alpha");
    expect(fs.realpathSync(result.plannedRefs[0]?.filePath ?? "")).toBe(fs.realpathSync(alphaPath));
  });

  test("a stale pre-resolved filePath still falls back to the async lookup (deletion race)", async () => {
    const stash = storage.stashDir;
    writeLesson(stash, "kept");
    const goneFile = writeLesson(stash, "gone");
    await indexStash(stash);
    // Fresh feedback keeps both refs past the signal-delta gate so they reach
    // the validation pass and the final disk-existence guard.
    appendEvent({ eventType: "feedback", ref: "lesson:kept", metadata: { signal: "positive", note: "fixture" } });
    appendEvent({ eventType: "feedback", ref: "lesson:gone", metadata: { signal: "positive", note: "fixture" } });
    // Delete one asset AFTER indexing: its pre-resolved filePath is now stale,
    // so the disk-existence guard must drop it via the fallback lookup while
    // the intact ref flows through on the fast path.
    fs.rmSync(goneFile);

    const reflected: string[] = [];
    const result = await akmImprove({
      stashDir: stash,
      scope: "lesson",
      ensureIndexFn: async () => undefined,
      reindexFn: async () => undefined,
      reflectFn: async (options) => {
        reflected.push(options.ref ?? "unknown");
        return stubReflect(options.ref ?? "unknown");
      },
      distillFn: async (options) => stubDistill(options.ref),
    });

    expect(result.ok).toBe(true);
    expect(result.plannedRefs.map((p) => p.ref)).toContain("lesson:kept");
    expect(result.plannedRefs.map((p) => p.ref)).not.toContain("lesson:gone");
    expect(reflected).not.toContain("lesson:gone");
  });
});
