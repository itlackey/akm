// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #986 — improve reworks only what retrieval returns, plus new material no
 * improve stage has processed. Opens a real state.db and index.db
 * (integration per the ORG-03 rule).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { inspectConsolidationPool } from "../../../../src/commands/improve/consolidate";
import { akmImprove } from "../../../../src/commands/improve/improve";
import { loadRetrievalScope } from "../../../../src/commands/improve/retrieval-scope";
import { type AkmConfig, saveConfig } from "../../../../src/core/config/config";
import type { AkmDistillResult, AkmReflectResult } from "../../../../src/core/improve-types";
import { getStateDbPath, openStateDatabase } from "../../../../src/core/state-db";
import { akmIndex } from "../../../../src/indexer/indexer";
import { recordImproveLedger } from "../../../../src/storage/repositories/improve-ledger-repository";
import { writeSkill } from "../../../_helpers/assets";
import { withImproveAutonomy, withTestImproveLlm } from "../../../_helpers/improve-config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

const DAY_MS = 86_400_000;

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function recordUsage(eventType: string, entryRef: string, source = "user", atMs = Date.now()): void {
  const db = openStateDatabase();
  try {
    db.prepare("INSERT INTO usage_events (event_type, entry_ref, source, created_at) VALUES (?, ?, ?, ?)").run(
      eventType,
      entryRef,
      source,
      sqliteTime(atMs),
    );
  } finally {
    db.close();
  }
}

function recordAttempt(
  stashDir: string,
  ref: string,
  source: string,
  outcome: "accepted" | "judged_no_action" | "proposed",
  atMs: number,
): void {
  const db = openStateDatabase();
  try {
    recordImproveLedger(db, { stashDir, ref, source, outcome, at: new Date(atMs).toISOString() });
  } finally {
    db.close();
  }
}

function recordProposal(stashDir: string, ref: string, source: string): void {
  const db = openStateDatabase();
  try {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO proposals (id, stash_dir, ref, status, source, created_at, updated_at) VALUES (?, ?, ?, 'accepted', ?, ?, ?)",
    ).run(`p-${source}-${ref}`, stashDir, ref, source, now, now);
  } finally {
    db.close();
  }
}

function writeMemory(stashDir: string, name: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\n${name} body.\n`, "utf8");
}

describe("loadRetrievalScope", () => {
  test("reads user retrieval and feedback inside the window, and what improve already processed", () => {
    const stash = storage.stashDir;
    recordUsage("search", "stash//knowledge/searched");
    recordUsage("curate", "stash//knowledge/curated");
    recordUsage("show", "stash//knowledge/shown");
    recordUsage("feedback", "stash//knowledge/rated");
    recordUsage("search", "stash//memories/parent.derived");
    recordUsage("search", "stash//knowledge/by-task", "task");
    recordUsage("show", "stash//knowledge/by-improve", "improve");
    recordUsage("search", "stash//knowledge/stale", "user", Date.now() - 100 * DAY_MS);
    recordAttempt(stash, "stash//knowledge/reflected", "reflect", "accepted", Date.now());
    recordAttempt(stash, "memories/judged", "consolidate", "judged_no_action", Date.now());
    recordAttempt(stash, "stash//memories/captured", "extract", "proposed", Date.now());
    recordProposal(stash, "stash//knowledge/promoted", "consolidate");
    recordProposal(stash, "stash//memories/extracted", "extract");

    const scope = loadRetrievalScope({}, stash);

    expect([...(scope?.used ?? [])].sort()).toEqual([
      "knowledge/curated",
      "knowledge/rated",
      "knowledge/searched",
      "knowledge/shown",
      "memories/parent",
      "memories/parent.derived",
    ]);
    expect([...(scope?.processed ?? [])].sort()).toEqual([
      "knowledge/promoted",
      "knowledge/reflected",
      "memories/judged",
    ]);
  });

  test("a consolidate-pair ledger row does not mark its ref processed (Blocker 1, second review round)", () => {
    const stash = storage.stashDir;
    // The pair pass judges material against its NEIGHBOURS, not on its own
    // merits — its own attempt is not usage evidence the fallback lanes or
    // promotion retries should be starved by, unlike every other source.
    recordAttempt(stash, "memories/paired-proposed", "consolidate-pair", "proposed", Date.now());
    recordAttempt(stash, "memories/paired-no-action", "consolidate-pair", "judged_no_action", Date.now());
    recordAttempt(stash, "memories/reflected", "reflect", "accepted", Date.now());

    const scope = loadRetrievalScope({}, stash);

    expect([...(scope?.processed ?? [])].sort()).toEqual(["memories/reflected"]);
  });

  test("a read-only load with no state.db yet reads an empty history and creates nothing", () => {
    expect(fs.existsSync(getStateDbPath())).toBe(false);
    const scope = loadRetrievalScope({ readOnly: true }, storage.stashDir);
    expect(scope?.used.size).toBe(0);
    expect(scope?.processed.size).toBe(0);
    expect(fs.existsSync(getStateDbPath())).toBe(false);
  });
});

const okReflect = (ref: string): AkmReflectResult => ({
  schemaVersion: 2,
  ok: true,
  proposal: {
    id: `p-${ref.replace(/[^a-z0-9]/gi, "-")}`,
    ref,
    status: "pending",
    source: "reflect",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    payload: { content: "# proposal" },
    changes: [{ path: "skills/proposal/SKILL.md", after: "# proposal", op: "update" }],
    proposedTarget: { source: "stash", root: "/tmp/stash" },
  },
  ref,
  engine: "test",
  durationMs: 1,
});

const okDistill = (ref: string): AkmDistillResult => ({
  schemaVersion: 1,
  ok: true,
  outcome: "queued",
  inputRef: ref,
  proposalRef: `lessons/${ref.replace(/[:/]/g, "-")}-lesson`,
});

const noopIndexFns = {
  ensureIndexFn: async () => false,
  reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
};

function proactiveConfig(stashDir: string): AkmConfig {
  return withTestImproveLlm({
    semanticSearchMode: "off",
    bundles: { stash: { path: stashDir, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
    improve: {
      strategies: {
        default: {
          processes: {
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            graphExtraction: { enabled: false },
            extract: { enabled: false },
            proactiveMaintenance: { enabled: true, dueDays: 30, maxPerRun: 10 },
          },
        },
      },
    },
  } as AkmConfig);
}

describe("fallback lanes pick only from the retrieval scope", () => {
  test("proactive maintenance skips an asset improve processed that retrieval never returned", async () => {
    const stash = storage.stashDir;
    writeSkill(stash, "read", "Read by agents.");
    writeSkill(stash, "unread", "Nobody searches for this.");
    writeSkill(stash, "fresh", "Just captured.");
    const config = proactiveConfig(stash);
    saveConfig(config);
    await akmIndex({ stashDir: stash, full: true });
    // Both reflected 40 days ago, so both are due again for maintenance.
    recordAttempt(stash, "stash//skills/read", "reflect", "accepted", Date.now() - 40 * DAY_MS);
    recordAttempt(stash, "stash//skills/unread", "reflect", "accepted", Date.now() - 40 * DAY_MS);
    recordUsage("show", "stash//skills/read");

    const reflected: string[] = [];
    const result = await akmImprove({
      scope: "skill",
      stashDir: stash,
      config,
      ...noopIndexFns,
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected.sort()).toEqual(["skills/fresh", "skills/read"]);
    expect(result.plan?.gates.find((gate) => gate.name === "retrieval")?.removed).toBe(1);
    expect(result.proactiveMaintenance?.dueTotal).toBe(2);
  });

  test("a dry run reports the same retrieval gate without writing", async () => {
    const stash = storage.stashDir;
    writeSkill(stash, "unread", "Nobody searches for this.");
    const config = proactiveConfig(stash);
    saveConfig(config);
    await akmIndex({ stashDir: stash, full: true });
    recordAttempt(stash, "stash//skills/unread", "reflect", "accepted", Date.now() - 40 * DAY_MS);

    const result = await akmImprove({ scope: "skill", stashDir: stash, config, dryRun: true, ...noopIndexFns });

    expect(result.plan?.gates.find((gate) => gate.name === "retrieval")).toMatchObject({ removed: 1 });
    expect(result.plannedRefs).toEqual([]);
  });

  test("an explicit --scope ref is reworked whether or not retrieval returned it", async () => {
    const stash = storage.stashDir;
    writeSkill(stash, "unread", "Nobody searches for this.");
    const config = proactiveConfig(stash);
    saveConfig(config);
    await akmIndex({ stashDir: stash, full: true });
    recordAttempt(stash, "stash//skills/unread", "reflect", "accepted", Date.now() - 40 * DAY_MS);

    const reflected: string[] = [];
    await akmImprove({
      scope: "skills/unread",
      stashDir: stash,
      config,
      ...noopIndexFns,
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).toEqual(["skills/unread"]);
  });
});

describe("the consolidation pool is the retrieval scope", () => {
  test("a judged memory comes back only when retrieval returned it or its derived facts", async () => {
    const stash = storage.stashDir;
    for (const name of ["unread-judged", "read-judged", "derived-hit", "fresh"]) writeMemory(stash, name);
    const config = withImproveAutonomy(
      withTestImproveLlm({
        semanticSearchMode: "off",
        bundles: { stash: { path: stash, writable: true } },
        defaultBundle: "stash",
        defaultWriteTarget: "stash",
      }),
    );
    saveConfig(config);
    await akmIndex({ stashDir: stash, full: true });
    // Judged ten days ago: past the seven-day revisit window.
    for (const name of ["unread-judged", "read-judged", "derived-hit"]) {
      recordAttempt(stash, `memories/${name}`, "consolidate", "judged_no_action", Date.now() - 10 * DAY_MS);
    }
    recordUsage("search", "stash//memories/read-judged");
    recordUsage("curate", "stash//memories/derived-hit.derived");

    const pool = inspectConsolidationPool(
      {
        config,
        writeTarget: {
          selector: "stash",
          source: { kind: "filesystem", name: "stash", path: stash },
          config: { type: "filesystem", name: "stash", path: stash, writable: true },
        },
      },
      stash,
      [],
    );

    expect(pool.memories.map((memory) => memory.name).sort()).toEqual(["derived-hit", "fresh", "read-judged"]);
    expect(pool.outsideRetrievalScope).toBe(1);
    expect(pool.poolSize).toBe(4);
  });
});
