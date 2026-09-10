// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #800 — `improve --dry-run` reports the effective execution plan.
 *
 * These tests deliberately exercise the public `akmImprove` boundary. A dry
 * run must use the same selectors as a live run, while stopping before every
 * lock, journal, database writer, proposal writer, asset writer, and LLM seam.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { computeSafeChunkSize } from "../../../../src/commands/improve/consolidate/chunking";
import { akmImprove } from "../../../../src/commands/improve/improve";
import type { ImproveProcessName } from "../../../../src/commands/improve/improve-strategies";
import { upsertAssetSalience } from "../../../../src/commands/improve/salience";
import type { AkmConfig } from "../../../../src/core/config/config";
import { saveConfig } from "../../../../src/core/config/config";
import { appendEvent, readEvents } from "../../../../src/core/events";
import { decodeImproveResult } from "../../../../src/core/improve-result";
import type { AkmDistillResult, AkmReflectResult, ImproveEligibleRef } from "../../../../src/core/improve-types";
import { getDbPath, getStashLocksDir } from "../../../../src/core/paths";
import { getStateDbPath, openStateDatabase } from "../../../../src/core/state-db";
import { _setWarnSinkForTests } from "../../../../src/core/warn";
import { akmIndex } from "../../../../src/indexer/indexer";
import { OpenCodeProvider } from "../../../../src/integrations/harnesses/opencode/session-log";
import type { SessionLogHarness } from "../../../../src/integrations/session-logs/types";
import { CANONICAL_INDEX_DB_VERSION } from "../../../../src/storage/repositories/index-entry-schema";
import { writeSkill } from "../../../_helpers/assets";
import { withImproveAutonomy, withTestImproveLlm } from "../../../_helpers/improve-config";
import { type Cleanup, withEnv, withIsolatedAkmStorage, withMockedFetch } from "../../../_helpers/sandbox";

const cleanups: Cleanup[] = [];

afterEach(() => {
  _setWarnSinkForTests();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function isolatedStorage(): ReturnType<typeof withIsolatedAkmStorage> {
  const storage = withIsolatedAkmStorage();
  cleanups.push(storage.cleanup);
  return storage;
}

function plannerConfig(args?: {
  proactive?: Record<string, unknown>;
  consolidate?: Record<string, unknown>;
  extract?: Record<string, unknown>;
  triage?: Record<string, unknown>;
  reflect?: Record<string, unknown>;
}): AkmConfig {
  return withTestImproveLlm({
    semanticSearchMode: "off",
    improve: {
      strategies: {
        default: {
          processes: {
            reflect: { enabled: true, limit: 4, ...(args?.reflect ?? {}) },
            distill: { enabled: false },
            consolidate: { enabled: false, ...(args?.consolidate ?? {}) },
            memoryInference: { enabled: false },
            graphExtraction: { enabled: false },
            extract: { enabled: false, ...(args?.extract ?? {}) },
            validation: { enabled: false },
            triage: { enabled: false, applyMode: "queue", ...(args?.triage ?? {}) },
            proactiveMaintenance: { enabled: false, ...(args?.proactive ?? {}) },
          },
        },
      },
    },
  } as AkmConfig);
}

async function indexSkills(stashDir: string, count: number, config: AkmConfig): Promise<void> {
  for (let i = 0; i < count; i++) writeSkill(stashDir, `skill-${i}`, `Skill ${i} body.`);
  saveConfig(config);
  await akmIndex({ stashDir, full: true });
}

function writeMemory(stashDir: string, name: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\nMemory ${name}.\n`, "utf8");
}

function seedReplayRank(ref: string, rankScore: number, encodingSource?: "content" | "type-stub"): void {
  const db = openStateDatabase();
  try {
    upsertAssetSalience(db, `stash//${ref}`, {
      encoding: 0.5,
      outcome: 0,
      retrieval: 0,
      rankScore,
      ...(encodingSource ? { encodingSource } : {}),
    });
  } finally {
    db.close();
  }
}

function seedRankRows(rows: ReadonlyArray<{ ref: string; rankScore: number }>): void {
  const db = openStateDatabase();
  try {
    db.exec("BEGIN");
    for (const row of rows) {
      upsertAssetSalience(db, row.ref, {
        encoding: row.rankScore,
        outcome: 0,
        retrieval: 0,
        rankScore: row.rankScore,
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function snapshotTree(root: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!fs.existsSync(root)) return result;
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        result.set(`${relative}/`, "directory");
        visit(absolute);
      } else if (entry.isFile()) {
        const bytes = fs.readFileSync(absolute);
        result.set(relative, `${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`);
      }
    }
  };
  visit(root);
  return result;
}

const okReflect = (ref: string): AkmReflectResult => ({
  schemaVersion: 2,
  ok: true,
  proposal: {
    id: `p-${ref.replace(/[^a-z0-9]/gi, "-")}`,
    ref,
    status: "pending",
    source: "reflect",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    payload: { content: "# proposal" },
    changes: [{ path: "lessons/proposal.md", after: "# proposal", op: "update" }],
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
  proposalRef: `lessons/${ref.replaceAll("/", "-")}`,
});

describe("#800 effective dry-run planner", () => {
  test("missing index produces an explicit empty read-only snapshot without creating storage", async () => {
    const storage = isolatedStorage();
    const config = plannerConfig();
    writeSkill(storage.stashDir, "unindexed", "This asset intentionally has no index row.");
    saveConfig(config);
    const before = snapshotTree(storage.root);
    const ensureIndexFn = mock(async () => {
      throw new Error("dry-run invoked index creation");
    });

    const result = await akmImprove({
      scope: "skill",
      stashDir: storage.stashDir,
      config,
      dryRun: true,
      ensureIndexFn,
    });

    expect(result.plan?.snapshot).toEqual({
      status: "missing",
      reason: "index.db is missing; dry-run uses an empty snapshot and does not create it",
    });
    expect(result.plan?.candidates).toEqual({ rawInScope: 0, selected: 0, effective: 0 });
    expect(result.plannedRefs).toEqual([]);
    expect(ensureIndexFn).not.toHaveBeenCalled();
    expect(fs.existsSync(getDbPath())).toBe(false);
    expect(snapshotTree(storage.root)).toEqual(before);
  });

  test("legacy index schema degrades to an empty incompatible snapshot instead of rejecting", async () => {
    const storage = isolatedStorage();
    const config = plannerConfig();
    writeSkill(storage.stashDir, "unindexed", "This asset intentionally has no current index row.");
    saveConfig(config);
    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacyDb = new Database(dbPath);
    legacyDb.exec("CREATE TABLE legacy_entries (id INTEGER PRIMARY KEY, value TEXT)");
    legacyDb.exec("INSERT INTO legacy_entries(value) VALUES ('preserve-me')");
    legacyDb.close();
    const before = snapshotTree(storage.root);

    const result = await akmImprove({ scope: "skill", stashDir: storage.stashDir, config, dryRun: true });

    expect(result.plan?.snapshot).toEqual({
      status: "incompatible",
      reason:
        "index.db is incompatible; Run `akm index` to rebuild the derived index from the currently materialized sources. " +
        "Dry-run uses an empty snapshot and does not migrate it.",
    });
    expect(result.plannedRefs).toEqual([]);
    expect(snapshotTree(storage.root)).toEqual(before);
  });

  test("held WAL legacy index degrades to an empty incompatible snapshot without changing main, WAL, or SHM bytes", async () => {
    const storage = isolatedStorage();
    const config = plannerConfig();
    writeSkill(storage.stashDir, "unindexed", "This asset intentionally has no current index row.");
    saveConfig(config);
    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacyDb = new Database(dbPath);
    try {
      legacyDb.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      legacyDb.exec("CREATE TABLE legacy_entries (id INTEGER PRIMARY KEY, value TEXT)");
      legacyDb.exec("INSERT INTO legacy_entries(value) VALUES ('preserve-held-wal')");
      expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
      expect(fs.existsSync(`${dbPath}-shm`)).toBe(true);
      const before = snapshotTree(storage.root);

      const result = await akmImprove({ scope: "skill", stashDir: storage.stashDir, config, dryRun: true });

      expect(result.plan?.snapshot).toEqual({
        status: "incompatible",
        reason:
          "index.db is incompatible; Run `akm index` to rebuild the derived index from the currently materialized sources. " +
          "Dry-run uses an empty snapshot and does not migrate it.",
      });
      expect(result.plannedRefs).toEqual([]);
      expect(snapshotTree(storage.root)).toEqual(before);
    } finally {
      legacyDb.close();
    }
  });

  test("newer index generation keeps its upgrade action in the empty dry-run snapshot", async () => {
    const storage = isolatedStorage();
    const config = plannerConfig();
    await indexSkills(storage.stashDir, 1, config);
    const dbPath = getDbPath();
    const newerDb = new Database(dbPath);
    try {
      newerDb
        .prepare("UPDATE index_meta SET value = ? WHERE key = 'version'")
        .run(String(CANONICAL_INDEX_DB_VERSION + 1));
    } finally {
      newerDb.close();
    }

    const result = await akmImprove({ scope: "skill", stashDir: storage.stashDir, config, dryRun: true });

    expect(result.plan?.snapshot).toEqual({
      status: "incompatible",
      reason:
        "index.db is incompatible; Upgrade akm to a version that understands this index generation. " +
        "Dry-run uses an empty snapshot and does not migrate it.",
    });
    expect(result.plannedRefs).toEqual([]);
  });

  test("held WAL current index stays byte-identical across every dry planning read", async () => {
    const storage = isolatedStorage();
    const config = plannerConfig({ proactive: { enabled: true, dueDays: 0, maxPerRun: 1 } });
    await indexSkills(storage.stashDir, 2, config);
    const dbPath = getDbPath();
    const writer = new Database(dbPath);
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      writer.exec("CREATE TABLE held_probe (id INTEGER PRIMARY KEY, value TEXT)");
      writer.exec("INSERT INTO held_probe(value) VALUES ('preserve-current-index')");
      expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
      expect(fs.existsSync(`${dbPath}-shm`)).toBe(true);
      const before = snapshotTree(storage.root);

      const result = await akmImprove({ scope: "skill", stashDir: storage.stashDir, config, dryRun: true });

      expect(result.plan?.snapshot.status).toBe("ready");
      expect(result.plan?.candidates.rawInScope).toBe(2);
      expect(result.plannedRefs).toHaveLength(1);
      expect(snapshotTree(storage.root)).toEqual(before);
    } finally {
      writer.close();
    }
  });

  test("held WAL legacy state is treated as empty without changing main, WAL, or SHM bytes", async () => {
    const storage = isolatedStorage();
    const config = plannerConfig({ proactive: { enabled: true, dueDays: 0, maxPerRun: 1 } });
    await indexSkills(storage.stashDir, 1, config);
    const statePath = getStateDbPath();
    for (const suffix of ["", "-wal", "-shm"] as const) fs.rmSync(`${statePath}${suffix}`, { force: true });
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const legacyState = new Database(statePath);
    try {
      legacyState.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      legacyState.exec("CREATE TABLE old_only (id INTEGER PRIMARY KEY, value TEXT)");
      legacyState.exec("INSERT INTO old_only(value) VALUES ('preserve-held-state')");
      expect(fs.existsSync(`${statePath}-wal`)).toBe(true);
      expect(fs.existsSync(`${statePath}-shm`)).toBe(true);
      const before = snapshotTree(storage.root);

      const result = await akmImprove({ scope: "skill", stashDir: storage.stashDir, config, dryRun: true });

      expect(result.ok).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(snapshotTree(storage.root)).toEqual(before);
    } finally {
      legacyState.close();
    }
  });

  test("clean legacy state with no events table is read-compatible and remains byte-identical", async () => {
    const storage = isolatedStorage();
    const config = plannerConfig();
    await indexSkills(storage.stashDir, 1, config);
    const statePath = getStateDbPath();
    for (const suffix of ["", "-wal", "-shm"] as const) fs.rmSync(`${statePath}${suffix}`, { force: true });
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const legacyState = new Database(statePath);
    legacyState.exec("CREATE TABLE old_only (id INTEGER PRIMARY KEY, value TEXT)");
    legacyState.exec("INSERT INTO old_only(value) VALUES ('preserve-legacy-state')");
    legacyState.close();
    const before = snapshotTree(storage.root);

    const result = await akmImprove({ scope: "skill", stashDir: storage.stashDir, config, dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(snapshotTree(storage.root)).toEqual(before);
  });

  test("reports raw candidates separately from the post-selector, post-limit refs", async () => {
    const { stashDir } = isolatedStorage();
    const config = plannerConfig({ proactive: { enabled: true, dueDays: 0, maxPerRun: 3 } });
    await indexSkills(stashDir, 5, config);

    const result = await akmImprove({ scope: "skill", stashDir, config, dryRun: true, limit: 2 });

    expect(result.plannedRefs).toHaveLength(2);
    expect(result.plan).toMatchObject({
      mode: "estimate",
      dispatch: false,
      candidates: {
        rawInScope: 5,
        effective: 2,
      },
      limits: {
        configured: { cli: 2, reflect: 4 },
        effective: 2,
        additiveReplayAllowance: 0,
        totalCeiling: 2,
      },
    });
    expect(result.plan?.effectiveRefs).toHaveLength(2);
    expect(result.plan?.effectiveRefs.every((entry) => entry.lane === "proactive")).toBe(true);
    expect(result.plan?.gates.some((gate) => gate.name === "limit" && gate.removed === 1)).toBe(true);
    expect(decodeImproveResult(JSON.stringify(result)).envelope.plannedRefs).toEqual(result.plannedRefs);
  });

  test("plan.processes reports resolved engine/model per process, honors a --strategy override, and counts eligibleRefs (#947)", async () => {
    const { stashDir } = isolatedStorage();
    const config = withImproveAutonomy(
      withTestImproveLlm({
        semanticSearchMode: "off",
        engines: {
          "consolidate-engine-a": {
            kind: "llm",
            endpoint: "http://127.0.0.1:1/v1/chat/completions",
            model: "model-a",
          },
          "consolidate-engine-b": {
            kind: "llm",
            endpoint: "http://127.0.0.1:1/v1/chat/completions",
            model: "model-b",
          },
        },
        improve: {
          strategies: {
            default: {
              processes: {
                reflect: { enabled: true, limit: 4 },
                distill: { enabled: false },
                consolidate: { enabled: true, engine: "consolidate-engine-a" },
                memoryInference: { enabled: false },
                graphExtraction: { enabled: false },
                extract: { enabled: false },
                validation: { enabled: false },
                triage: { enabled: false },
                proactiveMaintenance: { enabled: false },
              },
            },
            alt: { processes: { consolidate: { engine: "consolidate-engine-b" } } },
          },
        },
      } as AkmConfig),
    );
    await indexSkills(stashDir, 3, config);

    const defaultRun = await akmImprove({ scope: "skill", stashDir, config, dryRun: true });
    const altRun = await akmImprove({ scope: "skill", stashDir, config, dryRun: true, strategy: "alt" });

    // Acceptance criterion (#947): changing processes.consolidate.engine and
    // re-planning shows the new engine, and neither plan dispatches anything.
    const consolidateDefault = defaultRun.plan?.processes.find((row) => row.process === "consolidate");
    const consolidateAlt = altRun.plan?.processes.find((row) => row.process === "consolidate");
    expect(consolidateDefault).toMatchObject({ enabled: true, engine: "consolidate-engine-a", model: "model-a" });
    expect(consolidateAlt).toMatchObject({ enabled: true, engine: "consolidate-engine-b", model: "model-b" });
    expect(defaultRun.plan?.dispatch).toBe(false);
    expect(altRun.plan?.dispatch).toBe(false);
    expect(defaultRun.plan?.mode).toBe("estimate");

    const reflectRow = defaultRun.plan?.processes.find((row) => row.process === "reflect");
    expect(reflectRow).toMatchObject({ enabled: true, engine: "test-improve-llm", model: "test-model" });
    expect(Array.isArray(reflectRow?.notices)).toBe(true);
    expect(reflectRow?.eligibleRefs).toBe(defaultRun.plan?.effectiveRefs.length);

    const distillRow = defaultRun.plan?.processes.find((row) => row.process === "distill");
    expect(distillRow?.enabled).toBe(false);
    expect(distillRow?.eligibleRefs).toBe(0);

    // One row per IMPROVE_PROCESS_ENGINE_CAPABILITIES name — no row lost or duplicated.
    const expectedProcesses: ImproveProcessName[] = [
      "reflect",
      "distill",
      "consolidate",
      "memoryInference",
      "graphExtraction",
      "extract",
      "validation",
      "triage",
      "proactiveMaintenance",
    ];
    expect(defaultRun.plan?.processes.map((row) => row.process).sort()).toEqual(expectedProcesses.sort());
  });

  test("proactive dry-run reports due population, selected refs, and differs from default", async () => {
    const { stashDir } = isolatedStorage();
    const proactiveConfig = plannerConfig({ proactive: { enabled: true, dueDays: 0, maxPerRun: 2 } });
    await indexSkills(stashDir, 4, proactiveConfig);

    const baseline = await akmImprove({
      scope: "skill",
      stashDir,
      config: plannerConfig(),
      dryRun: true,
    });
    const proactive = await akmImprove({ scope: "skill", stashDir, config: proactiveConfig, dryRun: true });

    expect(baseline.plan?.candidates.rawInScope).toBe(4);
    expect(baseline.plannedRefs).toEqual([]);
    expect(proactive.plan?.candidates.rawInScope).toBe(4);
    expect(proactive.plannedRefs).toHaveLength(2);
    expect(proactive.proactiveMaintenance).toEqual({
      dueTotal: 4,
      neverReflected: 4,
      selected: 2,
      selectedRefs: proactive.plannedRefs.map((entry) => entry.ref),
    });
    expect(proactive.plan?.proactive).toMatchObject({
      configured: { dueDays: 0, maxPerRun: 2 },
      effective: { dueDays: 0, maxPerRun: 2 },
      candidatePool: 4,
      dueTotal: 4,
      neverReflected: 4,
      selected: 2,
    });
  });

  test("dry and live execution expose identical effective refs when observed inputs are unchanged", async () => {
    const { stashDir } = isolatedStorage();
    const config = plannerConfig({ proactive: { enabled: true, dueDays: 0, maxPerRun: 4 } });
    await indexSkills(stashDir, 6, config);

    const dry = await akmImprove({ scope: "skill", stashDir, config, dryRun: true, limit: 3 });
    const live = await akmImprove({
      scope: "skill",
      stashDir,
      config,
      limit: 3,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(dry.plannedRefs).toEqual(live.plannedRefs);
    expect(dry.plan?.effectiveRefs).toEqual(live.plan?.effectiveRefs);
    const terminalSignalSkips = live.distillSkipped?.byReason["no new signal since last proposal"] ?? 0;
    expect(live.plan?.gates.find((gate) => gate.name === "signal")?.removed).toBe(terminalSignalSkips);
    const effectiveRefs = new Set(live.plannedRefs.map((entry) => entry.ref));
    expect(
      live.distillSkipped?.samples.some(
        (sample) => effectiveRefs.has(sample.ref) && sample.reason === "no new signal since last proposal",
      ) ?? false,
    ).toBe(false);
    const noSignalEvents = readEvents({ type: "improve_skipped" }).events.filter(
      (event) => event.metadata?.reason === "no_new_signal",
    );
    expect(noSignalEvents).toHaveLength(1);
    expect(noSignalEvents[0]?.metadata?.count).toBe(terminalSignalSkips);
  });

  test("live high-salience fallback is not double-reported as a terminal no-signal skip", async () => {
    const { stashDir } = isolatedStorage();
    const config = plannerConfig();
    config.improve = {
      ...config.improve,
      salience: { salienceThreshold: 0.1, replayBudget: 0 },
    };
    await indexSkills(stashDir, 1, config);
    seedReplayRank("skills/skill-0", 0.99, "content");

    const result = await akmImprove({
      scope: "skill",
      stashDir,
      config,
      ensureIndexFn: async () => false,
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
    });

    expect(result.plannedRefs.map((entry) => [entry.ref, entry.eligibilitySource])).toEqual([
      ["skills/skill-0", "high-salience"],
    ]);
    expect(result.plan?.gates.find((gate) => gate.name === "signal")?.removed).toBe(0);
    expect(result.distillSkipped?.byReason["no new signal since last proposal"] ?? 0).toBe(0);
    expect(
      readEvents({ type: "improve_skipped" }).events.filter((event) => event.metadata?.reason === "no_new_signal"),
    ).toEqual([]);
  });

  test("replay intersects the current skill plan and preserves the matching entry in dry and live envelopes", async () => {
    const { stashDir } = isolatedStorage();
    const config = plannerConfig();
    config.improve = {
      ...config.improve,
      // Higher-ranked stale and wrong-type rows must not consume this sole slot.
      salience: { salienceThreshold: 1, replayBudget: 1 },
    };
    const skillRef = "skills/replay-match";
    const skillPath = path.join(stashDir, "skills", "replay-match", "SKILL.md");
    writeSkill(stashDir, "replay-match", "The only replay candidate in the current skill plan.");
    writeMemory(stashDir, "out-of-scope");
    saveConfig(config);
    await akmIndex({ stashDir, full: true });
    seedReplayRank("skills/stale", 0.99);
    seedReplayRank("memories/out-of-scope", 0.95);
    seedReplayRank(skillRef, 0.9);

    const commonOptions = {
      scope: "skill",
      stashDir,
      config,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }: { ref?: string }) =>
        ({
          schemaVersion: 2,
          ok: false,
          reason: "no_change",
          error: "stable",
          ref: ref ?? "",
          engine: "test",
          exitCode: 0,
        }) satisfies AkmReflectResult,
    };
    const dry = await akmImprove({ ...commonOptions, dryRun: true });
    const live = await akmImprove(commonOptions);
    const expected = {
      ref: skillRef,
      reason: "scope-type",
      filePath: skillPath,
      itemRef: `stash//${skillRef}`,
      eligibilitySource: "replay",
    } satisfies ImproveEligibleRef;

    expect(dry.plannedRefs).toEqual([expected]);
    expect(live.plannedRefs).toEqual([expected]);
    expect(dry.plan?.effectiveRefs).toEqual([{ ref: skillRef, lane: "replay", reason: "scope-type" }]);
    expect(live.plan?.effectiveRefs).toEqual(dry.plan?.effectiveRefs);
    for (const result of [dry, live]) {
      expect(result.plan?.candidates).toEqual({ rawInScope: 1, selected: 1, effective: 1 });
      expect(Object.fromEntries(result.plan?.gates.map((gate) => [gate.name, gate.removed]) ?? [])).toEqual({
        profile: 0,
        cleanup: 0,
        validation: 0,
        signal: 0,
        disk: 0,
        limit: 0,
      });
      expect(decodeImproveResult(JSON.stringify(result)).envelope.plannedRefs).toEqual([expected]);
    }
  });

  test("live replay bypass never also reports the selected ref as a terminal no-signal skip", async () => {
    const { stashDir } = isolatedStorage();
    const config = plannerConfig();
    config.improve = {
      ...config.improve,
      salience: { salienceThreshold: 1, replayBudget: 1 },
    };
    const skillRef = "skills/replay-after-stale-feedback";
    writeSkill(stashDir, "replay-after-stale-feedback", "A stale-feedback skill selected by bounded replay.");
    saveConfig(config);
    await akmIndex({ stashDir, full: true });
    const now = Date.now();
    appendEvent(
      { eventType: "feedback", ref: `stash//${skillRef}`, metadata: { signal: "positive" } },
      { now: () => now - 1_000 },
    );
    appendEvent({ eventType: "reflect_invoked", ref: `stash//${skillRef}` }, { now: () => now });
    seedReplayRank(skillRef, 0.99);
    const infoLines: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "info") infoLines.push(args.map(String).join(" "));
    });

    const result = await akmImprove({
      scope: "skill",
      stashDir,
      config,
      ensureIndexFn: async () => false,
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
    });

    expect(result.plannedRefs.map((entry) => [entry.ref, entry.eligibilitySource])).toEqual([[skillRef, "replay"]]);
    expect(result.plan?.gates.find((gate) => gate.name === "signal")?.removed).toBe(0);
    expect(result.distillSkipped?.byReason["no new signal since last proposal"] ?? 0).toBe(0);
    expect(
      result.distillSkipped?.samples.some(
        (sample) => sample.ref === skillRef && sample.reason === "no new signal since last proposal",
      ) ?? false,
    ).toBe(false);
    expect(
      readEvents({ type: "improve_skipped" }).events.filter((event) => event.metadata?.reason === "no_new_signal"),
    ).toEqual([]);
    expect(infoLines.some((line) => line.includes("blocked by reflect signal-delta"))).toBe(false);
    expect(readEvents({ type: "improve_replay_selected" }).events.at(-1)?.metadata?.count).toBe(1);
  });

  test("feedback-only mode suppresses proactive, high-salience, and replay selectors in dry and live plans", async () => {
    const { stashDir } = isolatedStorage();
    const config = plannerConfig({ proactive: { enabled: true, dueDays: 0, maxPerRun: 1 } });
    config.improve = {
      ...config.improve,
      salience: { salienceThreshold: 0.1, replayBudget: 1 },
    };
    await indexSkills(stashDir, 1, config);
    // This one quiet ref qualifies for proactive, high-salience, and replay;
    // feedback-only must suppress the selector family rather than merely
    // deleting its winners from the final array.
    seedReplayRank("skills/skill-0", 0.99, "content");
    const reflectFn = mock(async ({ ref }: { ref?: string }) => okReflect(ref ?? ""));
    const commonOptions = {
      scope: "skill",
      stashDir,
      config,
      requireFeedbackSignal: true,
      ensureIndexFn: async () => false,
      reflectFn,
    };

    const dry = await akmImprove({ ...commonOptions, dryRun: true });
    const infoLines: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "info") infoLines.push(args.map(String).join(" "));
    });
    const live = await akmImprove(commonOptions);

    for (const result of [dry, live]) {
      expect(result.plannedRefs).toEqual([]);
      expect(result.proactiveMaintenance).toBeUndefined();
      expect(result.plan?.proactive).toBeUndefined();
      expect(result.plan?.candidates).toEqual({ rawInScope: 1, selected: 0, effective: 0 });
      expect(Object.fromEntries(result.plan?.gates.map((gate) => [gate.name, gate.removed]) ?? [])).toEqual({
        profile: 0,
        cleanup: 0,
        validation: 0,
        signal: 1,
        disk: 0,
        limit: 0,
      });
      expect(decodeImproveResult(JSON.stringify(result)).envelope.plannedRefs).toEqual([]);
    }
    expect(reflectFn).not.toHaveBeenCalled();
    expect(readEvents({ type: "proactive_selected" }).events).toEqual([]);
    expect(readEvents({ type: "improve_replay_selected" }).events).toEqual([]);
    expect(live.distillSkipped?.byReason["no new signal since last proposal"]).toBe(1);
    expect(live.distillSkipped?.samples).toEqual([
      { ref: "skills/skill-0", reason: "no new signal since last proposal" },
    ]);
    const noSignalEvents = readEvents({ type: "improve_skipped" }).events.filter(
      (event) => event.metadata?.reason === "no_new_signal",
    );
    expect(noSignalEvents).toHaveLength(1);
    expect(noSignalEvents[0]?.metadata?.count).toBe(1);
    expect(infoLines.filter((line) => line.includes("blocked by reflect signal-delta"))).toHaveLength(1);
  });

  test("stash-wide forgetting state cannot escape a type-scoped current plan in dry or live accounting", async () => {
    const { stashDir } = isolatedStorage();
    const config = plannerConfig({ proactive: { enabled: true, dueDays: 0, maxPerRun: 600 } });
    saveConfig(config);
    const plannedRefs: ImproveEligibleRef[] = [];
    const storedRows: Array<{ ref: string; rankScore: number }> = [{ ref: "stash//memories/outside", rankScore: 0.01 }];
    for (let index = 0; index < 501; index += 1) {
      const name = `forgetting-scope-${String(index).padStart(3, "0")}`;
      const filePath = path.join(stashDir, "skills", name, "SKILL.md");
      writeSkill(stashDir, name, `Current-plan skill ${index}.`);
      plannedRefs.push({
        ref: `skills/${name}`,
        itemRef: `stash//skills/${name}`,
        reason: "scope-type",
        filePath,
      });
      storedRows.push({ ref: `stash//skills/${name}`, rankScore: 0 });
    }
    writeMemory(stashDir, "outside");
    seedRankRows(storedRows);
    const reflectFn = mock(async () => {
      throw new Error("--limit 0 dispatched a ref");
    });
    const commonOptions = {
      scope: "skill",
      stashDir,
      config,
      limit: 0,
      ensureIndexFn: async () => false,
      collectEligibleRefsFn: (async () => ({
        plannedRefs: plannedRefs.map((entry) => ({ ...entry })),
        memorySummary: { eligible: 0, derived: 0 },
        strategyFilteredRefs: [],
      })) as never,
      reflectFn,
    };

    const dry = await akmImprove({ ...commonOptions, dryRun: true });
    const live = await akmImprove(commonOptions);

    for (const result of [dry, live]) {
      expect(result.plan?.candidates).toEqual({ rawInScope: 501, selected: 501, effective: 0 });
      expect(result.plan?.gates.find((gate) => gate.name === "signal")?.removed).toBe(0);
      expect(result.plan?.gates.find((gate) => gate.name === "limit")?.removed).toBe(501);
      expect(result.plannedRefs).toEqual([]);
      expect(decodeImproveResult(JSON.stringify(result)).envelope.plannedRefs).toEqual([]);
    }
    expect(reflectFn).not.toHaveBeenCalled();
  });

  test("a current-plan forgetting candidate is admitted with its exact file and item provenance", async () => {
    const { stashDir } = isolatedStorage();
    const config = plannerConfig({ proactive: { enabled: true, dueDays: 0, maxPerRun: 501 } });
    saveConfig(config);
    const plannedRefs: ImproveEligibleRef[] = [];
    const storedRows: Array<{ ref: string; rankScore: number }> = [];
    for (let index = 0; index < 501; index += 1) {
      const name = `forgetting-active-${String(index).padStart(3, "0")}`;
      const filePath = path.join(stashDir, "skills", name, "SKILL.md");
      writeSkill(stashDir, name, `Active skill ${index}.`);
      plannedRefs.push({
        ref: `skills/${name}`,
        itemRef: `stash//skills/${name}`,
        reason: "scope-type",
        filePath,
      });
      storedRows.push({ ref: `stash//skills/${name}`, rankScore: 0 });
    }
    const quietName = "zz-forgetting-current";
    const quietPath = path.join(stashDir, "skills", quietName, "SKILL.md");
    writeSkill(stashDir, quietName, "A quiet current-plan skill.");
    const quiet = {
      ref: `skills/${quietName}`,
      itemRef: `stash//skills/${quietName}`,
      reason: "scope-type" as const,
      filePath: quietPath,
    };
    plannedRefs.push(quiet);
    storedRows.unshift({ ref: quiet.itemRef, rankScore: 0.01 });
    seedRankRows(storedRows);

    const commonOptions = {
      scope: "skill",
      stashDir,
      config,
      limit: 600,
      ensureIndexFn: async () => false,
      collectEligibleRefsFn: (async () => ({
        plannedRefs: plannedRefs.map((entry) => ({ ...entry })),
        memorySummary: { eligible: 0, derived: 0 },
        strategyFilteredRefs: [],
      })) as never,
    };
    const dry = await akmImprove({ ...commonOptions, dryRun: true });
    const live = await akmImprove({
      ...commonOptions,
      reflectFn: async ({ ref }: { ref?: string }) => ({
        schemaVersion: 2,
        ok: false,
        reason: "no_change",
        error: "stable",
        ref: ref ?? "",
        engine: "test",
        exitCode: 0,
      }),
    });

    for (const result of [dry, live]) {
      const admitted = result.plannedRefs.find((entry) => entry.ref === quiet.ref);
      expect(admitted).toEqual({ ...quiet, eligibilitySource: "forgetting-safety" });
      expect(result.plan?.effectiveRefs.find((entry) => entry.ref === quiet.ref)?.lane).toBe("forgetting-safety");
      expect(result.plan?.candidates).toEqual({ rawInScope: 502, selected: 502, effective: 502 });
      expect(decodeImproveResult(JSON.stringify(result)).envelope.plannedRefs).toEqual(result.plannedRefs);
    }
    expect(live.distillSkipped?.byReason["no new signal since last proposal"] ?? 0).toBe(0);
    expect(
      readEvents({ type: "improve_skipped" }).events.filter((event) => event.metadata?.reason === "no_new_signal"),
    ).toEqual([]);
  });

  test("a current-plan forgetting candidate deleted after validation is charged to the disk gate", async () => {
    const { stashDir } = isolatedStorage();
    const config = plannerConfig({ proactive: { enabled: true, dueDays: 0, maxPerRun: 501 } });
    saveConfig(config);
    const plannedRefs: ImproveEligibleRef[] = [];
    const storedRows: Array<{ ref: string; rankScore: number }> = [];
    for (let index = 0; index < 501; index += 1) {
      const name = `forgetting-disk-${String(index).padStart(3, "0")}`;
      const filePath = path.join(stashDir, "skills", name, "SKILL.md");
      writeSkill(stashDir, name, `Disk control skill ${index}.`);
      plannedRefs.push({
        ref: `skills/${name}`,
        itemRef: `stash//skills/${name}`,
        reason: "scope-type",
        filePath,
      });
      storedRows.push({ ref: `stash//skills/${name}`, rankScore: 0 });
    }
    const quietName = "zz-forgetting-disk-race";
    const quietPath = path.join(stashDir, "skills", quietName, "SKILL.md");
    writeSkill(stashDir, quietName, "Deleted after structural validation.");
    let filePathReads = 0;
    const quiet: ImproveEligibleRef = {
      ref: `skills/${quietName}`,
      itemRef: `stash//skills/${quietName}`,
      reason: "scope-type",
      get filePath() {
        filePathReads += 1;
        if (filePathReads >= 4) fs.rmSync(quietPath, { force: true });
        return quietPath;
      },
    };
    plannedRefs.push(quiet);
    storedRows.unshift({ ref: quiet.itemRef!, rankScore: 0.01 });
    seedRankRows(storedRows);

    const result = await akmImprove({
      scope: "skill",
      stashDir,
      config,
      dryRun: true,
      limit: 0,
      collectEligibleRefsFn: (async () => ({
        plannedRefs,
        memorySummary: { eligible: 0, derived: 0 },
        strategyFilteredRefs: [],
      })) as never,
    });

    expect(result.plan?.candidates).toEqual({ rawInScope: 502, selected: 501, effective: 0 });
    expect(result.plan?.gates.find((gate) => gate.name === "signal")?.removed).toBe(0);
    expect(result.plan?.gates.find((gate) => gate.name === "disk")?.removed).toBe(1);
    expect(result.plan?.gates.find((gate) => gate.name === "limit")?.removed).toBe(501);
    expect(decodeImproveResult(JSON.stringify(result)).envelope.plannedRefs).toEqual([]);
  });

  test("replay cannot re-admit a ref removed by structural validation", async () => {
    const { stashDir } = isolatedStorage();
    const config = plannerConfig();
    config.improve = {
      ...config.improve,
      salience: { salienceThreshold: 1, replayBudget: 1 },
    };
    const lessonPath = path.join(stashDir, "lessons", "broken.md");
    fs.mkdirSync(path.dirname(lessonPath), { recursive: true });
    fs.writeFileSync(lessonPath, "---\nwhen_to_use: Testing replay validation\n---\n\nBody.\n", "utf8");
    saveConfig(config);
    await akmIndex({ stashDir, full: true });
    seedReplayRank("lessons/broken", 0.99);
    const reflectFn = mock(async ({ ref }: { ref?: string }) => okReflect(ref ?? ""));
    const commonOptions = {
      scope: "lesson",
      stashDir,
      config,
      ensureIndexFn: async () => false,
      reflectFn,
    };

    const dry = await akmImprove({ ...commonOptions, dryRun: true });
    const live = await akmImprove(commonOptions);

    for (const result of [dry, live]) {
      expect(result.plannedRefs).toEqual([]);
      expect(result.plan?.candidates).toEqual({ rawInScope: 1, selected: 0, effective: 0 });
      expect(result.plan?.gates.find((gate) => gate.name === "validation")).toEqual({
        name: "validation",
        removed: 1,
        reason: "structural validation failures",
      });
      expect(decodeImproveResult(JSON.stringify(result)).envelope.plannedRefs).toEqual([]);
    }
    expect(reflectFn).not.toHaveBeenCalled();
  });

  test("replay cannot re-admit a cleanup-pruned noncanonical derived memory in dry or live plans", async () => {
    const { stashDir } = isolatedStorage();
    const config = withImproveAutonomy(plannerConfig());
    config.improve = {
      ...config.improve,
      salience: { salienceThreshold: 1, replayBudget: 1 },
    };
    const memoryPath = path.join(stashDir, "memories", "obsolete-copy.md");
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
    fs.writeFileSync(
      memoryPath,
      [
        "---",
        "description: Obsolete noncanonical derived memory",
        "inferred: true",
        "source: memories/original",
        "obsolete: true",
        "---",
        "",
        "Old body.",
        "",
      ].join("\n"),
      "utf8",
    );
    saveConfig(config);
    await akmIndex({ stashDir, full: true });
    seedReplayRank("memories/obsolete-copy", 0.99);
    const reflectFn = mock(async ({ ref }: { ref?: string }) => okReflect(ref ?? ""));
    const commonOptions = {
      scope: "memory",
      stashDir,
      config,
      ensureIndexFn: async () => false,
      reflectFn,
    };

    const dry = await akmImprove({ ...commonOptions, dryRun: true });
    const live = await akmImprove(commonOptions);

    for (const result of [dry, live]) {
      expect(result.plannedRefs).toEqual([]);
      expect(result.plan?.candidates).toEqual({ rawInScope: 1, selected: 0, effective: 0 });
      expect(result.plan?.gates.find((gate) => gate.name === "cleanup")?.removed).toBe(1);
      expect(result.plan?.gates.find((gate) => gate.name === "disk")?.removed).toBe(0);
      expect(decodeImproveResult(JSON.stringify(result)).envelope.plannedRefs).toEqual([]);
    }
    expect(dry.plan?.gates.find((gate) => gate.name === "cleanup")?.reason).toBe("would be archived by memory cleanup");
    expect(live.plan?.gates.find((gate) => gate.name === "cleanup")?.reason).toBe("archived by memory cleanup");
    expect(reflectFn).not.toHaveBeenCalled();
  });

  test("dry and live cleanup prune the same ref-scoped derived memory before the disk gate", async () => {
    const { stashDir } = isolatedStorage();
    const config = withImproveAutonomy(plannerConfig());
    const derivedPath = path.join(stashDir, "memories", "deploy-copy.derived.md");
    fs.mkdirSync(path.dirname(derivedPath), { recursive: true });
    fs.writeFileSync(
      derivedPath,
      [
        "---",
        "description: Obsolete deployment copy",
        "inferred: true",
        "source: memories/deploy",
        "obsolete: true",
        "---",
        "",
        "Use the retired deployment path.",
        "",
      ].join("\n"),
      "utf8",
    );
    saveConfig(config);
    await akmIndex({ stashDir, full: true });

    const scope = "memories/deploy-copy.derived";
    const dry = await akmImprove({ scope, stashDir, config, dryRun: true });
    const live = await akmImprove({ scope, stashDir, config });

    expect(dry.plannedRefs).toEqual([]);
    expect(live.plannedRefs).toEqual(dry.plannedRefs);
    expect(live.plan?.effectiveRefs).toEqual(dry.plan?.effectiveRefs);
    expect(dry.plan?.gates.find((gate) => gate.name === "cleanup")).toEqual({
      name: "cleanup",
      removed: 1,
      reason: "would be archived by memory cleanup",
    });
    expect(live.plan?.gates.find((gate) => gate.name === "cleanup")).toEqual({
      name: "cleanup",
      removed: 1,
      reason: "archived by memory cleanup",
    });
    expect(dry.plan?.gates.find((gate) => gate.name === "disk")?.removed).toBe(0);
    expect(live.plan?.gates.find((gate) => gate.name === "disk")?.removed).toBe(0);
    expect(live.memoryCleanup?.archived).toHaveLength(1);
    expect(fs.existsSync(derivedPath)).toBe(false);
  });

  test("consolidation preview reports the real pool, gates, and chunk estimate without dispatch", async () => {
    const { stashDir } = isolatedStorage();
    const config = plannerConfig({
      consolidate: { enabled: true, minPoolSize: 3, limit: 4, maxChunkSize: 2 },
    });
    for (let i = 0; i < 5; i++) writeMemory(stashDir, `memory-${i}`);
    saveConfig(config);
    await akmIndex({ stashDir, full: true });

    let modelCalls = 0;
    const result = await withMockedFetch(
      () => akmImprove({ scope: "memory", stashDir, config, dryRun: true }),
      async () => {
        modelCalls += 1;
        throw new Error("dry-run dispatched an LLM request");
      },
    );

    expect(modelCalls).toBe(0);
    expect(result.plan?.consolidation).toMatchObject({
      configured: { enabled: true, minPoolSize: 3, limit: 4, maxChunkSize: 2 },
      effective: { enabled: true, minPoolSize: 3, limit: 4, chunkSize: 2 },
      poolSize: 5,
      candidatePoolSize: 4,
      gates: {
        profile: { passed: true },
        minimumPool: { passed: true },
        delta: { passed: true },
      },
      wouldRun: true,
      estimatedChunks: 2,
    });
    expect(result.plan?.stages.find((stage) => stage.name === "consolidation")).toMatchObject({
      wouldRun: true,
    });
  });

  // #800/#957 — once the shared "planner" engine's credential is unavailable,
  // the enabled "consolidate" override loses its runner (folded into
  // `engineUnavailable`), which used to trip the "no improve process can run"
  // guard even on a dry run that never dispatches (#958). `--dry-run`/`--plan`
  // now passes `allowAllDisabled` so the guard returns the plan instead of
  // throwing, and the credential-unavailable process carries its structurally
  // resolved engine/model/contextLength on its `engineUnavailable` entry so
  // this preview can still show them without ever materializing the
  // credential. "reflect" is disabled here so exactly one process
  // (consolidate) is unavailable.
  test("consolidation preview reads frozen context length without materializing a required credential", async () => {
    const { stashDir } = isolatedStorage();
    const credentialName = "AKM_800_CONSOLIDATION_PLAN_KEY";
    const config = plannerConfig({
      reflect: { enabled: false },
      consolidate: { enabled: true, minPoolSize: 2, maxChunkSize: 50 },
    });
    config.engines = {
      planner: {
        kind: "llm",
        endpoint: "https://example.test/v1/chat/completions",
        model: "planner",
        contextLength: 8_000,
        apiKey: `$${credentialName}`,
      },
    };
    config.defaults = { ...config.defaults, llmEngine: "planner" };
    config.index = { enrichment: { enabled: false } };
    for (let i = 0; i < 3; i++) writeMemory(stashDir, `credential-free-${i}`);
    saveConfig(config);
    await akmIndex({ stashDir, full: true });
    let networkCalls = 0;

    const result = await withEnv({ [credentialName]: undefined }, () =>
      withMockedFetch(
        () => akmImprove({ scope: "memory", stashDir, config, dryRun: true }),
        async () => {
          networkCalls += 1;
          throw new Error("consolidation preview dispatched a network request");
        },
      ),
    );

    expect(networkCalls).toBe(0);
    // The credential is unavailable, so this dry run now reports consolidate
    // as skipped rather than reporting it as runnable.
    expect(result.plan?.consolidation.wouldRun).toBe(false);
    expect(result.skippedProcesses).toHaveLength(1);
    expect(result.skippedProcesses?.[0]?.process).toBe("consolidate");
    expect(result.skippedProcesses?.[0]?.reason).toContain(`$${credentialName}`);
    // The preview still reads the resolved context length without
    // materializing the credential.
    expect(result.plan?.consolidation.effective.chunkSize).toBe(computeSafeChunkSize(8_000, 500, 50));
    const consolidateRow = result.plan?.processes.find((row) => row.process === "consolidate");
    expect(consolidateRow).toMatchObject({
      process: "consolidate",
      enabled: false,
      engine: "planner",
      model: "planner",
    });
    expect(consolidateRow?.unavailable).toBeDefined();
    expect(decodeImproveResult(JSON.stringify(result)).envelope.plannedRefs).toEqual(result.plannedRefs);
  });

  test("extract preview evaluates the same min-new-sessions gate without dispatch", async () => {
    const { stashDir } = isolatedStorage();
    const config = plannerConfig({ extract: { enabled: true, minNewSessions: 3 } });
    await indexSkills(stashDir, 1, config);
    let readCalls = 0;
    const harness: SessionLogHarness = {
      name: "fake",
      isAvailable: () => true,
      listSessions: () => [
        {
          harness: "fake",
          sessionId: "new-session",
          filePath: "/dev/null/new-session",
          endedAt: Date.now(),
        },
      ],
      readSession: () => {
        readCalls += 1;
        throw new Error("dry-run dispatched extraction");
      },
    };
    const dataRoot = process.env.AKM_DATA_DIR ?? path.join(stashDir, ".missing-data");
    const beforeData = snapshotTree(dataRoot);

    const result = await akmImprove({
      scope: "skill",
      stashDir,
      config,
      dryRun: true,
      extractHarnesses: [harness],
    });

    expect(readCalls).toBe(0);
    expect(snapshotTree(dataRoot)).toEqual(beforeData);
    expect(result.plan?.stages.find((stage) => stage.name === "extract")).toEqual({
      name: "extract",
      wouldRun: false,
      reason: "1 new sessions is below minNewSessions 3",
    });
  });

  test("real OpenCode held-WAL discovery leaves its live main, WAL, and SHM byte-identical", async () => {
    const storage = isolatedStorage();
    const config = plannerConfig({ extract: { enabled: true, minNewSessions: 1, defaultSince: "7d" } });
    await indexSkills(storage.stashDir, 1, config);

    const opencodeDir = path.join(storage.root, "opencode");
    const dbPath = path.join(opencodeDir, "opencode.db");
    fs.mkdirSync(opencodeDir, { recursive: true });
    const writer = new Database(dbPath);
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      writer.exec(`
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          title TEXT,
          directory TEXT,
          time_created INTEGER,
          time_updated INTEGER
        );
      `);
      const now = Date.now();
      writer
        .prepare("INSERT INTO session(id, title, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?)")
        .run("held-session", "Held WAL session", storage.stashDir, now - 1_000, now);
      expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
      expect(fs.existsSync(`${dbPath}-shm`)).toBe(true);
      const before = snapshotTree(opencodeDir);
      const provider = new OpenCodeProvider();
      const harness: SessionLogHarness = {
        name: provider.name,
        isAvailable: () => true,
        listSessions: (input) => provider.listSessions({ ...input, location: opencodeDir }),
        readSession: (ref) => provider.readSession(ref),
      };

      const result = await akmImprove({
        scope: "skill",
        stashDir: storage.stashDir,
        config,
        dryRun: true,
        extractHarnesses: [harness],
      });

      expect(result.plan?.stages.find((stage) => stage.name === "extract")).toEqual({
        name: "extract",
        wouldRun: true,
        reason: "1 new sessions satisfies minNewSessions 1",
      });
      expect(snapshotTree(opencodeDir)).toEqual(before);
    } finally {
      writer.close();
    }
  });

  test("dry planning with existing state performs no writes, locks, events, proposals, assets, or LLM calls", async () => {
    const storage = isolatedStorage();
    const { stashDir } = storage;
    const config = plannerConfig({
      proactive: { enabled: true, dueDays: 0, maxPerRun: 2 },
      triage: { enabled: true, applyMode: "promote", maxAcceptsPerRun: 7, maxDiffLines: 20 },
    });
    await indexSkills(stashDir, 3, config);
    appendEvent({ eventType: "feedback", ref: "skills/skill-0", metadata: { signal: "positive" } });

    const roots = {
      stash: stashDir,
      config: path.dirname(process.env.AKM_CONFIG_DIR ?? path.join(stashDir, ".missing-config")),
      data: process.env.AKM_DATA_DIR ?? path.join(stashDir, ".missing-data"),
      state: process.env.AKM_STATE_DIR ?? path.join(stashDir, ".missing-state"),
      cache: process.env.AKM_CACHE_DIR ?? path.join(stashDir, ".missing-cache"),
    };
    const before = Object.fromEntries(Object.entries(roots).map(([name, root]) => [name, snapshotTree(root)]));
    const reflectFn = mock(async () => {
      throw new Error("dry-run invoked reflect");
    });
    const drainProposalsFn = mock(async () => {
      throw new Error("dry-run invoked proposal triage");
    });
    let modelCalls = 0;

    const result = await withMockedFetch(
      () =>
        akmImprove({
          scope: "skill",
          stashDir,
          config,
          dryRun: true,
          reflectFn,
          drainProposalsFn,
          ensureIndexFn: mock(async () => {
            throw new Error("dry-run invoked index writer");
          }),
        }),
      async () => {
        modelCalls += 1;
        throw new Error("dry-run dispatched an LLM request");
      },
    );

    expect(result.plan).toMatchObject({
      mode: "estimate",
      dispatch: false,
      triage: {
        enabled: true,
        configuredMode: "promote",
        mode: "queue",
        maxAcceptsPerRun: 7,
        maxDiffLines: 20,
      },
    });
    expect(reflectFn).not.toHaveBeenCalled();
    expect(drainProposalsFn).not.toHaveBeenCalled();
    expect(modelCalls).toBe(0);
    expect(fs.existsSync(path.join(getStashLocksDir(stashDir), "improve.lock"))).toBe(false);
    for (const [name, root] of Object.entries(roots)) {
      expect(snapshotTree(root), `${name} changed during dry planning`).toEqual(before[name]!);
    }
  });
});
