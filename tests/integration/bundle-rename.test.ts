// INTEGRATION TEST — opens a real index.db (via akmIndex) and a real
// state.db (via openStateDatabase, directly, for seeding and assertions) to
// verify akm bundle rename's bulk rewrites across both databases plus the
// lockfile and config.

/**
 * D6 — `akm bundle rename <old> <new>`: moves the config bundles key,
 * defaultBundle/defaultWriteTarget, scheduler.enabled[].ref, the lockfile
 * entry, and the index/state rows this tool persisted under the old bundle
 * prefix; leaves bundle CONTENT refs alone and reports them; `--dry-run`
 * writes nothing; `show <new>//…` resolves while `show <old>//…` does not.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Proposal } from "../../src/commands/proposal/proposal-types";
import { akmShowUnified as akmShow } from "../../src/commands/read/show";
import { renameBundle } from "../../src/core/bundle-rename";
import { loadConfig, saveConfig } from "../../src/core/config/config";
import { NotFoundError, UsageError } from "../../src/core/errors";
import { openStateDatabase } from "../../src/core/state-db";
import { akmIndex } from "../../src/indexer/indexer";
import { readLockfile, upsertLockEntry } from "../../src/integrations/lockfile";
import { closeDatabase } from "../../src/storage/repositories/index-connection";
import { upsertProposal } from "../../src/storage/repositories/proposals-repository";
import { upsertTaskHistory } from "../../src/storage/repositories/task-history-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

function writeKnowledgeAsset(stashDir: string, name: string, content: string): void {
  const dir = path.join(stashDir, "knowledge");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), content);
}

async function seedBundleWithOneEntry(): Promise<void> {
  writeKnowledgeAsset(storage.stashDir, "hello", "---\ndescription: hello doc\n---\n\n# Hello\n");
  saveConfig({
    semanticSearchMode: "off",
    bundles: { original: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } } },
    defaultBundle: "original",
    defaultWriteTarget: "original",
  });
  await akmIndex({ stashDir: storage.stashDir });
}

function makeProposal(id: string, ref: string, targetSource: string): Proposal {
  const now = new Date().toISOString();
  return {
    id,
    ref,
    status: "pending",
    source: "manual",
    createdAt: now,
    updatedAt: now,
    payload: { content: `content for ${ref}` },
    changes: [{ path: `${ref}.md`, after: `content for ${ref}`, op: "create" }],
    proposedTarget: { source: targetSource, root: storage.stashDir },
  } as unknown as Proposal;
}

describe("akm bundle rename — validation", () => {
  test("rejects an unconfigured bundle", async () => {
    saveConfig({ semanticSearchMode: "off" });
    await expect(renameBundle("nope", "also-nope")).rejects.toThrow(NotFoundError);
  });

  test("rejects an illegal new name", async () => {
    await seedBundleWithOneEntry();
    await expect(renameBundle("original", "bad.name")).rejects.toThrow(UsageError);
    await expect(renameBundle("original", "bad.name")).rejects.toThrow(/not a legal bundle name/);
  });

  test("rejects a new name already taken by a different bundle", async () => {
    await seedBundleWithOneEntry();
    const config = loadConfig();
    saveConfig({ ...config, bundles: { ...config.bundles, taken: { path: "/tmp/other" } } });
    await expect(renameBundle("original", "taken")).rejects.toThrow(/already exists/);
  });
});

describe("akm bundle rename — dry-run", () => {
  test("reports the plan and writes nothing", async () => {
    await seedBundleWithOneEntry();
    const configBefore = fs.readFileSync(path.join(storage.configDir, "akm", "config.json"), "utf8");

    const plan = await renameBundle("original", "renamed", { dryRun: true });

    expect(plan.applied).toBe(false);
    expect(plan.index.entries).toBe(1);
    expect(fs.readFileSync(path.join(storage.configDir, "akm", "config.json"), "utf8")).toBe(configBefore);
    expect(Object.keys(loadConfig().bundles ?? {})).toEqual(["original"]);

    // show still resolves the OLD ref — nothing moved.
    const shown = await akmShow({ ref: "original//knowledge/hello" });
    expect(shown.ref).toBe("knowledge/hello");
  });
});

describe("akm bundle rename — applied", () => {
  test("moves config, index, lock, scheduler refs, and state rows; leaves and reports content refs", async () => {
    await seedBundleWithOneEntry();

    // A file in the bundle that still spells the ref out in prose, so the
    // rename must report it without touching it.
    writeKnowledgeAsset(
      storage.stashDir,
      "cross-ref",
      "---\ndescription: cross ref doc\n---\n\nSee `original//knowledge/hello` for details.\n",
    );
    await akmIndex({ stashDir: storage.stashDir });

    // A lock entry (as a managed install would carry).
    await upsertLockEntry({ id: "original", source: "git", ref: "https://example.test/repo.git" });

    // A scheduler grant naming the bundle.
    const configWithScheduler = loadConfig();
    saveConfig({
      ...configWithScheduler,
      scheduler: {
        enabled: [{ kind: "task", ref: "original//tasks/foo", sourceId: `sha256:${"0".repeat(64)}` }],
      },
    });

    // A pending proposal whose ref and proposedTarget.source name the bundle.
    const stateDb = openStateDatabase();
    try {
      upsertProposal(stateDb, makeProposal("p1", "original//knowledge/new-thing", "original"), storage.stashDir);
      upsertTaskHistory(stateDb, {
        task_id: "wf-run",
        status: "completed",
        started_at: "2026-01-01T00:00:00.000Z",
        completed_at: "2026-01-01T00:01:00.000Z",
        failed_at: null,
        log_path: null,
        target_kind: "workflow",
        target_ref: "original//workflows/foo",
        metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 60_000, detail: null }),
      });
    } finally {
      closeDatabase(stateDb);
    }

    const result = await renameBundle("original", "renamed");

    expect(result.applied).toBe(true);
    expect(result.index.entries).toBe(2);
    expect(result.config.defaultBundleChanges).toBe(true);
    expect(result.config.defaultWriteTargetChanges).toBe(true);
    expect(result.config.schedulerRefs).toEqual(["original//tasks/foo"]);
    expect(result.lock.present).toBe(true);
    expect(result.state.proposalRefs).toBe(1);
    expect(result.state.taskHistoryRefs).toBe(1);
    expect(result.contentRefs.some((f) => f.endsWith("cross-ref.md"))).toBe(true);

    // Config: bundle key, defaultBundle, defaultWriteTarget, scheduler ref.
    const configAfter = loadConfig();
    expect(Object.keys(configAfter.bundles ?? {})).toEqual(["renamed"]);
    expect(configAfter.defaultBundle).toBe("renamed");
    expect(configAfter.defaultWriteTarget).toBe("renamed");
    expect(configAfter.scheduler?.enabled?.[0]?.ref).toBe("renamed//tasks/foo");

    // Lockfile.
    expect(readLockfile().map((e) => e.id)).toEqual(["renamed"]);

    // Index: old ref gone, new ref resolves.
    await expect(akmShow({ ref: "renamed//knowledge/hello" })).resolves.toMatchObject({ ref: "knowledge/hello" });
    await expect(akmShow({ ref: "original//knowledge/hello" })).rejects.toThrow(NotFoundError);

    // Content itself was NOT rewritten — the cross-ref file still says "original//".
    const crossRefContent = fs.readFileSync(path.join(storage.stashDir, "knowledge", "cross-ref.md"), "utf8");
    expect(crossRefContent).toContain("original//knowledge/hello");

    // State.db rows.
    const readDb = openStateDatabase();
    try {
      const proposalRow = readDb.prepare("SELECT ref, metadata_json FROM proposals WHERE id = ?").get("p1") as {
        ref: string;
        metadata_json: string;
      };
      expect(proposalRow.ref).toBe("renamed//knowledge/new-thing");
      expect(JSON.parse(proposalRow.metadata_json).proposedTarget.source).toBe("renamed");

      const taskRow = readDb.prepare("SELECT target_ref FROM task_history WHERE task_id = ?").get("wf-run") as {
        target_ref: string;
      };
      expect(taskRow.target_ref).toBe("renamed//workflows/foo");
    } finally {
      closeDatabase(readDb);
    }
  });

  test("a bundle with no lock entry, no scheduler grants, and no state rows renames cleanly", async () => {
    await seedBundleWithOneEntry();

    const result = await renameBundle("original", "renamed");

    expect(result.applied).toBe(true);
    expect(result.lock.present).toBe(false);
    expect(result.config.schedulerRefs).toEqual([]);
    expect(result.state.proposalRefs).toBe(0);
    expect(result.state.proposalTargets).toBe(0);
    expect(result.state.taskHistoryRefs).toBe(0);
    expect(readLockfile()).toEqual([]);
  });
});
