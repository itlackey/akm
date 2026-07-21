// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Integration tests for #561 session indexing in the extract pass.
 *
 *   1. Session asset round-trips: extract (with an INJECTED fake summary
 *      generator) writes `sessions/<harness>/<id>.md`; `akmIndex` indexes it;
 *      `akmSearch --type session` finds it by summary content.
 *   2. Fail-open / disabled: extract with session indexing disabled — and with
 *      no summary generator able to produce output — writes NO session asset,
 *      i.e. the stash `sessions/` tree is byte-identical (absent) to before.
 *   3. log_path / access frontmatter survives an index rebuild (the durable
 *      correlation key the issue requires).
 *
 * NO real LLM / network: the summary generator and the extract `chat` seam are
 * both injected. The summary generator returns a fixed payload.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmExtract } from "../../src/commands/improve/extract";
import type { SessionSummaryGenerator } from "../../src/commands/improve/session-asset";
import { akmSearch } from "../../src/commands/read/search";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import type { AkmConfig } from "../../src/core/config/config";
import { resetConfigCache, saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { resetGraphBoostCache } from "../../src/indexer/graph/graph-boost";
import { akmIndex } from "../../src/indexer/indexer";
import type {
  SessionData,
  SessionLogHarness,
  SessionRef,
  SessionSummary,
} from "../../src/integrations/session-logs/types";
import { clearEmbeddingCache, resetLocalEmbedder } from "../../src/llm/embedder";
import { openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { getAllEntries } from "../../src/storage/repositories/index-entries-repository";
import { type Cleanup, sandboxStashDir, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";

let stashDir = "";
let envCleanup: Cleanup = () => {};

beforeEach(() => {
  clearEmbeddingCache();
  resetLocalEmbedder();
  resetGraphBoostCache();
  const cache = sandboxXdgCacheHome();
  const cfg = sandboxXdgConfigHome(cache.cleanup);
  const stash = sandboxStashDir(cfg.cleanup);
  stashDir = stash.dir;
  envCleanup = stash.cleanup;
  for (const dir of ["memories", "lessons", "knowledge"]) {
    fs.mkdirSync(path.join(stashDir, dir), { recursive: true });
  }
  // The on-disk config is what akmIndex / akmSearch read (they call loadConfig
  // internally). FTS-only keeps indexing fast + deterministic (no embedder).
  resetConfigCache();
  saveConfig({
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    bundles: { stash: { path: stashDir } },
    defaultBundle: "stash",
    registries: [],
  } as AkmConfig);
  const dbPath = getDbPath();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  stashDir = "";
  clearEmbeddingCache();
  resetLocalEmbedder();
  resetGraphBoostCache();
  resetConfigCache();
});

const SESSION_ID = "ca894f15-aaaa-bbbb-cccc-ddddeeeeffff";
const SUMMARY_TEXT =
  "Investigated Bun and Node compatibility for the runtime boundary abstraction and the bun-sqlite seam.";

function configFor(stash: string, indexSessions?: boolean, extractEnabled = true): AkmConfig {
  return {
    configVersion: "0.9.0",
    // FTS-only keeps the round-trip fast + deterministic (no embedding model
    // download); the summary body is fully searchable via FTS.
    semanticSearchMode: "off",
    bundles: { stash: { path: stash, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
    engines: {
      default: {
        kind: "llm",
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "test-model",
        supportsJsonSchema: true,
      },
    },
    improve: {
      strategies: {
        session: {
          processes: {
            extract: {
              enabled: extractEnabled,
              triage: { enabled: false },
              ...(indexSessions === undefined ? {} : { indexSessions }),
            },
          },
        },
      },
    },
    defaults: { llmEngine: "default", improveStrategy: "session" },
  } as AkmConfig;
}

function makeSession(endedAt: number): SessionData {
  return {
    ref: {
      harness: "claude-code",
      sessionId: SESSION_ID,
      filePath: "/home/u/.claude/projects/-p/ca894f15.jsonl",
      startedAt: endedAt - 3 * 3_600_000,
      endedAt,
      projectHint: "itlackey/akm",
      title: "node compat",
    },
    events: [
      { harness: "claude-code", text: "user: investigate bun sqlite compatibility", role: "user" },
      { harness: "claude-code", text: "agent: designed runtime boundary abstraction", role: "assistant" },
    ],
    inlineRefs: [],
  };
}

function makeHarness(sessions: SessionData[], available = true): SessionLogHarness {
  const summaries: SessionSummary[] = sessions.map((s) => s.ref);
  return {
    name: "claude-code",
    isAvailable: () => available,
    *readEvents() {},
    listSessions: (input?: { sinceMs?: number }) => {
      const since = input?.sinceMs ?? 0;
      return summaries.filter((s) => (s.endedAt ?? 0) >= since);
    },
    readSession: (ref: SessionRef): SessionData => {
      const found = sessions.find((s) => s.ref.sessionId === ref.sessionId);
      if (!found) throw new Error(`session not found: ${ref.sessionId}`);
      return found;
    },
  };
}

const fakeSummaryGenerator: SessionSummaryGenerator = async () => ({
  summary: SUMMARY_TEXT,
  keyTopics: ["src/storage/database.ts", "issue #560", "bun:sqlite"],
  tags: ["node-compat"],
});

const sessionAssetPath = () => path.join(stashDir, "sessions", "claude", `${SESSION_ID}.md`);

describe("#561 session indexing — round-trip", () => {
  test("extract writes a session asset, akmIndex indexes it, search --type session finds it", async () => {
    const now = Date.now();
    const result = await akmExtract({
      type: "claude-code",
      stashDir,
      config: configFor(stashDir, true),
      harnesses: [makeHarness([makeSession(now)])],
      // No memory candidates — proves the session asset is written even with an
      // empty distillation, since the session itself is the searchable artifact.
      chat: async () => JSON.stringify({ candidates: [] }),
      generateSessionSummary: fakeSummaryGenerator,
      skipTracking: true,
    });

    expect(result.ok).toBe(true);
    const session = result.sessions.find((s) => s.sessionId === SESSION_ID);
    expect(session?.sessionAssetRef).toBe(`session:claude/${SESSION_ID}`);
    expect(session?.sessionLogPath).toBe("/home/u/.claude/projects/-p/ca894f15.jsonl");

    // The asset file exists on disk.
    expect(fs.existsSync(sessionAssetPath())).toBe(true);

    // Index it, then search by summary content filtered to type=session.
    await akmIndex({ stashDir, full: true });

    const search = await akmSearch({
      query: "bun node compatibility runtime boundary",
      type: "session",
      source: "stash",
      limit: 10,
    });
    const hit = search.hits.find((h) => h.type === "session");
    expect(hit).toBeDefined();
    // Canonical name is path-derived: sessions/<harness>/<id>.md → claude/<id>.
    expect(hit?.name).toBe(`claude/${SESSION_ID}`);

    // The indexed entry carries the session type.
    const db = openIndexDatabase();
    try {
      const entries = getAllEntries(db).filter((e) => e.entry.type === "session");
      expect(entries.length).toBe(1);
      expect(entries[0].entry.name).toContain("ca894f15");
    } finally {
      db.close();
    }
  });

  test("log_path + access frontmatter survive an index rebuild", async () => {
    const now = Date.now();
    await akmExtract({
      type: "claude-code",
      stashDir,
      config: configFor(stashDir, true),
      harnesses: [makeHarness([makeSession(now)])],
      chat: async () => JSON.stringify({ candidates: [] }),
      generateSessionSummary: fakeSummaryGenerator,
      skipTracking: true,
    });

    // Capture frontmatter, rebuild the index from scratch, re-read frontmatter.
    const before = parseFrontmatter(fs.readFileSync(sessionAssetPath(), "utf8")).data;
    await akmIndex({ stashDir, full: true });
    await akmIndex({ stashDir, full: true }); // rebuild
    const after = parseFrontmatter(fs.readFileSync(sessionAssetPath(), "utf8")).data;

    expect(after.log_path).toBe(before.log_path);
    expect(after.log_path).toBe("/home/u/.claude/projects/-p/ca894f15.jsonl");
    expect(after.access).toBe(before.access);
    expect(after.access).toContain("jq");
  });
});

describe("#561 session indexing — disabled / fail-open is byte-identical (no asset)", () => {
  test("indexSessions:false writes NO session asset", async () => {
    const now = Date.now();
    const result = await akmExtract({
      type: "claude-code",
      stashDir,
      config: configFor(stashDir, /* indexSessions */ false),
      harnesses: [makeHarness([makeSession(now)])],
      chat: async () => JSON.stringify({ candidates: [] }),
      // A generator IS provided, proving the gate (not a missing generator) is
      // what suppresses the write.
      generateSessionSummary: fakeSummaryGenerator,
      skipTracking: true,
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "sessions"))).toBe(false);
    const session = result.sessions.find((s) => s.sessionId === SESSION_ID);
    expect(session?.sessionAssetRef).toBeUndefined();
    expect(session?.sessionLogPath).toBeUndefined();
  });

  test("no summary available (generator returns undefined) writes NO session asset", async () => {
    const now = Date.now();
    const noopGenerator: SessionSummaryGenerator = async () => undefined;
    const result = await akmExtract({
      type: "claude-code",
      stashDir,
      config: configFor(stashDir, true),
      harnesses: [makeHarness([makeSession(now)])],
      chat: async () => JSON.stringify({ candidates: [] }),
      generateSessionSummary: noopGenerator,
      skipTracking: true,
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "sessions"))).toBe(false);
    const session = result.sessions.find((s) => s.sessionId === SESSION_ID);
    expect(session?.sessionAssetRef).toBeUndefined();
  });

  test("session shorter than minSessionDuration is not indexed", async () => {
    const now = Date.now();
    const short = makeSession(now);
    short.ref.startedAt = now - 60_000; // 1 minute session, below the 5-min default
    const result = await akmExtract({
      type: "claude-code",
      stashDir,
      config: configFor(stashDir, true),
      harnesses: [makeHarness([short])],
      chat: async () => JSON.stringify({ candidates: [] }),
      generateSessionSummary: fakeSummaryGenerator,
      skipTracking: true,
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "sessions"))).toBe(false);
  });
});
