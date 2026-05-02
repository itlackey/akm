import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmHistory } from "../../src/commands/history";
import { saveConfig } from "../../src/core/config";
import { appendEvent } from "../../src/core/events";
import { getDbPath } from "../../src/core/paths";
import { closeDatabase, openDatabase } from "../../src/indexer/db";
import { akmIndex } from "../../src/indexer/indexer";
import { ensureUsageEventsSchema, insertUsageEvent } from "../../src/indexer/usage-events";

const CLI = path.join(__dirname, "..", "..", "src", "cli.ts");

const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function parseJsonOutput(result: { stdout: string; stderr: string }): Record<string, unknown> {
  const payload = result.stdout.trim() || result.stderr.trim();
  return JSON.parse(payload) as Record<string, unknown>;
}

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-history-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-history-config-");
});

afterEach(() => {
  if (savedEnv.AKM_STASH_DIR === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedEnv.AKM_STASH_DIR;
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("akmHistory programmatic API", () => {
  test("returns an empty entry list when no events have been recorded", async () => {
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      const result = await akmHistory({ db });
      expect(result.schemaVersion).toBe(1);
      expect(result.totalCount).toBe(0);
      expect(result.entries).toEqual([]);
      expect(result.ref).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("returns stash-wide history in chronological order when no ref is provided", async () => {
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      insertUsageEvent(db, { event_type: "search", query: "deploy" });
      insertUsageEvent(db, { event_type: "show", entry_ref: "memory:alpha", entry_id: 1 });
      insertUsageEvent(db, {
        event_type: "feedback",
        entry_ref: "memory:alpha",
        entry_id: 1,
        signal: "positive",
      });

      const result = await akmHistory({ db });
      expect(result.totalCount).toBe(3);
      expect(result.entries.map((entry) => entry.eventType)).toEqual(["search", "show", "feedback"]);
      // Each entry has the canonical fields the renderer projects.
      expect(result.entries[0]).toMatchObject({ eventType: "search", query: "deploy" });
      expect(result.entries[1]).toMatchObject({ eventType: "show", ref: "memory:alpha" });
      expect(result.entries[2]).toMatchObject({ eventType: "feedback", ref: "memory:alpha", signal: "positive" });
    } finally {
      closeDatabase(db);
    }
  });

  test("filters per-asset history when --ref is provided", async () => {
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      insertUsageEvent(db, { event_type: "show", entry_ref: "memory:alpha", entry_id: 1 });
      insertUsageEvent(db, { event_type: "show", entry_ref: "memory:beta", entry_id: 2 });
      insertUsageEvent(db, {
        event_type: "feedback",
        entry_ref: "memory:alpha",
        entry_id: 1,
        signal: "negative",
      });

      const result = await akmHistory({ db, ref: "memory:alpha" });
      expect(result.ref).toBe("memory:alpha");
      expect(result.totalCount).toBe(2);
      expect(result.entries.every((entry) => entry.ref === "memory:alpha")).toBe(true);
      expect(result.entries.map((entry) => entry.eventType)).toEqual(["show", "feedback"]);
    } finally {
      closeDatabase(db);
    }
  });

  test("rejects malformed refs with a UsageError", async () => {
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      await expect(akmHistory({ db, ref: "" })).rejects.toThrow();
      await expect(akmHistory({ db, ref: "not-a-ref" })).rejects.toThrow();
    } finally {
      closeDatabase(db);
    }
  });

  test("filters by --since when provided", async () => {
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      // Manually insert rows with explicit timestamps so the test is
      // deterministic regardless of clock skew.
      db.prepare("INSERT INTO usage_events (event_type, entry_ref, entry_id, created_at) VALUES (?, ?, ?, ?)").run(
        "show",
        "memory:alpha",
        1,
        "2025-01-01 00:00:00",
      );
      db.prepare("INSERT INTO usage_events (event_type, entry_ref, entry_id, created_at) VALUES (?, ?, ?, ?)").run(
        "show",
        "memory:alpha",
        1,
        "2026-04-01 00:00:00",
      );

      const result = await akmHistory({ db, since: "2026-01-01T00:00:00Z" });
      expect(result.totalCount).toBe(1);
      expect(result.entries[0]?.createdAt).toBe("2026-04-01 00:00:00");
    } finally {
      closeDatabase(db);
    }
  });

  test("rejects malformed --since values", async () => {
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      await expect(akmHistory({ db, since: "definitely-not-a-date" })).rejects.toThrow();
    } finally {
      closeDatabase(db);
    }
  });
});

describe("akm history CLI", () => {
  test("emits a JSON envelope matching the existing CLI conventions", async () => {
    const stashDir = makeTempDir("akm-history-stash-");
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearchMode: "off" });

    writeFile(path.join(stashDir, "memories", "alpha.md"), "---\ndescription: alpha memory\n---\nAlpha.\n");
    await akmIndex({ stashDir, full: true });

    // Generate a feedback event so history has something to surface.
    const feedback = runCli(["feedback", "memory:alpha", "--positive", "--format=json"]);
    expect(feedback.status).toBe(0);

    // Per-asset history.
    const perAsset = runCli(["history", "--ref", "memory:alpha", "--format=json"]);
    expect(perAsset.status).toBe(0);
    const perAssetJson = parseJsonOutput(perAsset);
    expect(perAssetJson.ref).toBe("memory:alpha");
    expect(typeof perAssetJson.totalCount).toBe("number");
    expect(Array.isArray(perAssetJson.entries)).toBe(true);
    const entries = perAssetJson.entries as Array<Record<string, unknown>>;
    expect(entries.some((entry) => entry.eventType === "feedback" && entry.ref === "memory:alpha")).toBe(true);

    // Stash-wide history.
    const stashWide = runCli(["history", "--format=json"]);
    expect(stashWide.status).toBe(0);
    const stashWideJson = parseJsonOutput(stashWide);
    expect(stashWideJson.ref).toBeUndefined();
    expect(typeof stashWideJson.totalCount).toBe("number");
    expect((stashWideJson.totalCount as number) >= 1).toBe(true);

    // Confirm the database actually contains the feedback row we created.
    const db = openDatabase(getDbPath());
    try {
      const events = db
        .prepare("SELECT entry_ref, event_type FROM usage_events WHERE event_type = 'feedback'")
        .all() as Array<{ entry_ref: string; event_type: string }>;
      expect(events.find((event) => event.entry_ref === "memory:alpha")).toBeDefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("renders a human-friendly text report when --format=text", async () => {
    const stashDir = makeTempDir("akm-history-text-stash-");
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearchMode: "off" });

    writeFile(path.join(stashDir, "memories", "alpha.md"), "---\ndescription: alpha memory\n---\nAlpha.\n");
    await akmIndex({ stashDir, full: true });
    const feedback = runCli(["feedback", "memory:alpha", "--positive", "--format=json"]);
    expect(feedback.status).toBe(0);

    const text = runCli(["history", "--ref", "memory:alpha", "--format=text"]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("memory:alpha");
    expect(text.stdout).toContain("[feedback]");
    expect(text.stdout).toContain("signal: positive");
  });

  test("rejects an invalid ref via the JSON error envelope", () => {
    const result = runCli(["history", "--ref", "not-a-valid-ref", "--format=json"]);
    expect(result.status).not.toBe(0);
    const parsed = parseJsonOutput(result);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
  });
});

describe("akmHistory --include-proposals", () => {
  test("sources field is ['usage_events'] by default", async () => {
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      const result = await akmHistory({ db });
      expect(result.sources).toEqual(["usage_events"]);
    } finally {
      closeDatabase(db);
    }
  });

  test("sources field includes events.jsonl when includeProposals is true", async () => {
    const eventsFile = path.join(makeTempDir("akm-history-events-"), "events.jsonl");
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      const result = await akmHistory({
        db,
        includeProposals: true,
        eventsCtx: { filePath: eventsFile },
      });
      expect(result.sources).toEqual(["usage_events", "events.jsonl"]);
    } finally {
      closeDatabase(db);
    }
  });

  test("proposal accept event (promoted) appears in history with --include-proposals", async () => {
    const eventsFile = path.join(makeTempDir("akm-history-proposal-"), "events.jsonl");
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      // Simulate `akm proposal accept` emitting a promoted event.
      appendEvent(
        {
          eventType: "promoted",
          ref: "skill:deploy",
          metadata: { proposalId: "prop-001", source: "reflect", assetPath: "/stash/skills/deploy.md" },
        },
        { filePath: eventsFile },
      );

      const result = await akmHistory({
        db,
        includeProposals: true,
        eventsCtx: { filePath: eventsFile },
      });

      expect(result.totalCount).toBe(1);
      const promoted = result.entries.find((e) => e.eventType === "promoted");
      expect(promoted).toBeDefined();
      expect(promoted?.ref).toBe("skill:deploy");
      expect(promoted?.eventType).toBe("promoted");
      // Metadata from the proposal should be accessible.
      expect((promoted?.metadata as Record<string, unknown>)?.proposalId).toBe("prop-001");
    } finally {
      closeDatabase(db);
    }
  });

  test("proposal reject event (rejected) appears in history with --include-proposals", async () => {
    const eventsFile = path.join(makeTempDir("akm-history-reject-"), "events.jsonl");
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      appendEvent(
        {
          eventType: "rejected",
          ref: "memory:old-draft",
          metadata: { proposalId: "prop-002", source: "reflect", reason: "outdated" },
        },
        { filePath: eventsFile },
      );

      const result = await akmHistory({
        db,
        includeProposals: true,
        eventsCtx: { filePath: eventsFile },
      });

      expect(result.totalCount).toBe(1);
      const rejected = result.entries.find((e) => e.eventType === "rejected");
      expect(rejected).toBeDefined();
      expect(rejected?.ref).toBe("memory:old-draft");
      expect((rejected?.metadata as Record<string, unknown>)?.reason).toBe("outdated");
    } finally {
      closeDatabase(db);
    }
  });

  test("non-proposal events in events.jsonl are excluded even with --include-proposals", async () => {
    const eventsFile = path.join(makeTempDir("akm-history-filter-"), "events.jsonl");
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      // These event types should NOT appear in history even with --include-proposals.
      appendEvent({ eventType: "add", ref: "skill:deploy" }, { filePath: eventsFile });
      appendEvent({ eventType: "reflect_invoked", ref: "memory:alpha" }, { filePath: eventsFile });
      // Only this one should appear.
      appendEvent(
        { eventType: "promoted", ref: "skill:deploy", metadata: { proposalId: "p1", source: "reflect" } },
        { filePath: eventsFile },
      );

      const result = await akmHistory({
        db,
        includeProposals: true,
        eventsCtx: { filePath: eventsFile },
      });

      expect(result.entries.every((e) => e.eventType === "promoted" || e.eventType === "rejected")).toBe(true);
      expect(result.entries.length).toBe(1);
      expect(result.entries[0]?.eventType).toBe("promoted");
    } finally {
      closeDatabase(db);
    }
  });

  test("usage events and proposal events are merged chronologically", async () => {
    const eventsFile = path.join(makeTempDir("akm-history-merge-"), "events.jsonl");
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      // Insert usage events with explicit timestamps (early, then late).
      db.prepare("INSERT INTO usage_events (event_type, entry_ref, entry_id, created_at) VALUES (?, ?, ?, ?)").run(
        "show",
        "skill:deploy",
        1,
        "2026-01-01 10:00:00",
      );
      db.prepare("INSERT INTO usage_events (event_type, entry_ref, entry_id, created_at) VALUES (?, ?, ?, ?)").run(
        "feedback",
        "skill:deploy",
        1,
        "2026-01-03 12:00:00",
      );
      // Append a proposal event between the two usage events.
      appendEvent(
        { eventType: "promoted", ref: "skill:deploy", metadata: { proposalId: "p3", source: "reflect" } },
        {
          filePath: eventsFile,
          now: () => new Date("2026-01-02T09:00:00Z").getTime(),
        },
      );

      const result = await akmHistory({
        db,
        includeProposals: true,
        eventsCtx: { filePath: eventsFile },
      });

      expect(result.totalCount).toBe(3);
      const types = result.entries.map((e) => e.eventType);
      // Chronological: show (Jan 1), promoted (Jan 2), feedback (Jan 3)
      expect(types).toEqual(["show", "promoted", "feedback"]);
    } finally {
      closeDatabase(db);
    }
  });

  test("--include-proposals ref filter shows only matching ref events", async () => {
    const eventsFile = path.join(makeTempDir("akm-history-ref-filter-"), "events.jsonl");
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      // Two proposal events for different refs.
      appendEvent(
        { eventType: "promoted", ref: "skill:deploy", metadata: { proposalId: "p1", source: "reflect" } },
        { filePath: eventsFile },
      );
      appendEvent(
        { eventType: "rejected", ref: "memory:draft", metadata: { proposalId: "p2", source: "reflect" } },
        { filePath: eventsFile },
      );

      const result = await akmHistory({
        db,
        ref: "skill:deploy",
        includeProposals: true,
        eventsCtx: { filePath: eventsFile },
      });

      // Only the promoted event for skill:deploy should appear.
      expect(result.ref).toBe("skill:deploy");
      expect(result.entries.every((e) => e.ref === "skill:deploy")).toBe(true);
      const promoted = result.entries.find((e) => e.eventType === "promoted");
      expect(promoted).toBeDefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("akm history --include-proposals CLI flag surfaces proposal lifecycle events", async () => {
    const stashDir = makeTempDir("akm-history-cli-proposals-");
    process.env.AKM_STASH_DIR = stashDir;
    const cacheDir = makeTempDir("akm-history-cli-cache-");
    process.env.XDG_CACHE_HOME = cacheDir;
    saveConfig({ semanticSearchMode: "off" });

    writeFile(path.join(stashDir, "memories", "alpha.md"), "---\ndescription: alpha memory\n---\nAlpha.\n");
    await akmIndex({ stashDir, full: true });

    // We can't easily run a full accept without a real proposal, so instead
    // write a promoted event directly to events.jsonl to verify the CLI flag.
    const eventsFile = path.join(cacheDir, "akm", "events.jsonl");
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    const promoted = {
      schemaVersion: 1,
      ts: new Date().toISOString(),
      eventType: "promoted",
      ref: "memory:alpha",
      metadata: { proposalId: "p-cli-test", source: "reflect", assetPath: "memories/alpha.md" },
    };
    fs.appendFileSync(eventsFile, `${JSON.stringify(promoted)}\n`);

    const result = runCli(["history", "--include-proposals", "--ref", "memory:alpha", "--format=json"]);
    expect(result.status).toBe(0);
    const parsed = parseJsonOutput(result);
    const entries = parsed.entries as Array<Record<string, unknown>>;
    expect(Array.isArray(entries)).toBe(true);
    // The promoted event should appear.
    const promotedEntry = entries.find((e) => e.eventType === "promoted");
    expect(promotedEntry).toBeDefined();
    expect(promotedEntry?.ref).toBe("memory:alpha");
    // Sources should include events.jsonl.
    expect(Array.isArray(parsed.sources)).toBe(true);
    expect((parsed.sources as string[]).includes("events.jsonl")).toBe(true);

    // Verify text output also shows the proposal event.
    const text = runCli(["history", "--include-proposals", "--ref", "memory:alpha", "--format=text"]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("[promoted]");
    expect(text.stdout).toContain("events.jsonl");
  });
});
