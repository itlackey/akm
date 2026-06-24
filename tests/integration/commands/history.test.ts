import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmHistory } from "../../../src/commands/sources/history";
import { saveConfig } from "../../../src/core/config/config";
import { appendEvent } from "../../../src/core/events";
import { getDbPath } from "../../../src/core/paths";
import { closeDatabase, openDatabase } from "../../../src/indexer/db/db";
import { akmIndex } from "../../../src/indexer/indexer";
import { ensureUsageEventsSchema, insertUsageEvent } from "../../../src/indexer/usage/usage-events";
import { runCliCapture } from "../../_helpers/cli";
import { type Cleanup, makeSandboxDir, type SandboxedDir, sandboxStashDir } from "../../_helpers/sandbox";

// Migrated from per-test spawnSync("bun", [CLI, ...]) to the in-process harness
// (tests/_helpers/cli.ts). The pure akmHistory tests use openDatabase(":memory:")
// and are untouched. The CLI tests seed a stash (memories + akmIndex + feedback
// events) in-process, then read it back through the in-process CLI — both share
// the same sandboxed XDG dirs from the preload (tests/_preload.ts). Per-test
// stash isolation uses the allowlisted sandboxStashDir helper; extra event
// state.db dirs use makeSandboxDir, so the test-isolation lint stays satisfied.

const disposers: Array<{ cleanup: Cleanup }> = [];
let stashCleanup: Cleanup = () => {};

function makeTempDir(_prefix: string): string {
  const d: SandboxedDir = makeSandboxDir("akm-history-");
  disposers.push(d);
  return d.dir;
}

function sandboxStash(): string {
  const stash = sandboxStashDir();
  stashCleanup = stash.cleanup;
  return stash.dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

function parseJsonOutput(result: { stdout: string; stderr: string }): Record<string, unknown> {
  const payload = result.stdout.trim() || result.stderr.trim();
  return JSON.parse(payload) as Record<string, unknown>;
}

afterEach(() => {
  stashCleanup();
  stashCleanup = () => {};
  for (const d of disposers.splice(0)) d.cleanup();
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
    const stashDir = sandboxStash();
    saveConfig({ semanticSearchMode: "off" });

    writeFile(path.join(stashDir, "memories", "alpha.md"), "---\ndescription: alpha memory\n---\nAlpha.\n");
    await akmIndex({ stashDir, full: true });

    // Generate a feedback event so history has something to surface.
    const feedback = await runCli(["feedback", "memory:alpha", "--positive", "--format=json"]);
    expect(feedback.status).toBe(0);

    // Per-asset history.
    const perAsset = await runCli(["history", "--ref", "memory:alpha", "--format=json"]);
    expect(perAsset.status).toBe(0);
    const perAssetJson = parseJsonOutput(perAsset);
    expect(perAssetJson.ref).toBe("memory:alpha");
    expect(typeof perAssetJson.totalCount).toBe("number");
    expect(Array.isArray(perAssetJson.entries)).toBe(true);
    const entries = perAssetJson.entries as Array<Record<string, unknown>>;
    expect(entries.some((entry) => entry.eventType === "feedback" && entry.ref === "memory:alpha")).toBe(true);

    // Stash-wide history.
    const stashWide = await runCli(["history", "--format=json"]);
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
    const stashDir = sandboxStash();
    saveConfig({ semanticSearchMode: "off" });

    writeFile(path.join(stashDir, "memories", "alpha.md"), "---\ndescription: alpha memory\n---\nAlpha.\n");
    await akmIndex({ stashDir, full: true });
    const feedback = await runCli(["feedback", "memory:alpha", "--positive", "--format=json"]);
    expect(feedback.status).toBe(0);

    const text = await runCli(["history", "--ref", "memory:alpha", "--format=text"]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("memory:alpha");
    expect(text.stdout).toContain("[feedback]");
    expect(text.stdout).toContain("signal: positive");
  });

  test("rejects an invalid ref via the JSON error envelope", async () => {
    const result = await runCli(["history", "--ref", "not-a-valid-ref", "--format=json"]);
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

  test("sources field includes state.db when includeProposals is true", async () => {
    const dbFile = path.join(makeTempDir("akm-history-events-"), "state.db");
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      const result = await akmHistory({
        db,
        includeProposals: true,
        eventsCtx: { dbPath: dbFile },
      });
      expect(result.sources).toEqual(["usage_events", "state.db"]);
    } finally {
      closeDatabase(db);
    }
  });

  test("proposal accept event (promoted) appears in history with --include-proposals", async () => {
    const stateDbPath = path.join(makeTempDir("akm-history-proposal-"), "state.db");
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
        { dbPath: stateDbPath },
      );

      const result = await akmHistory({
        db,
        includeProposals: true,
        eventsCtx: { dbPath: stateDbPath },
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
    const stateDbPath = path.join(makeTempDir("akm-history-reject-"), "state.db");
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      appendEvent(
        {
          eventType: "rejected",
          ref: "memory:old-draft",
          metadata: { proposalId: "prop-002", source: "reflect", reason: "outdated" },
        },
        { dbPath: stateDbPath },
      );

      const result = await akmHistory({
        db,
        includeProposals: true,
        eventsCtx: { dbPath: stateDbPath },
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

  test("non-proposal events in state.db are excluded even with --include-proposals", async () => {
    const stateDbPath = path.join(makeTempDir("akm-history-filter-"), "state.db");
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      // These event types should NOT appear in history even with --include-proposals.
      appendEvent({ eventType: "add", ref: "skill:deploy" }, { dbPath: stateDbPath });
      appendEvent({ eventType: "reflect_invoked", ref: "memory:alpha" }, { dbPath: stateDbPath });
      // Only this one should appear.
      appendEvent(
        { eventType: "promoted", ref: "skill:deploy", metadata: { proposalId: "p1", source: "reflect" } },
        { dbPath: stateDbPath },
      );

      const result = await akmHistory({
        db,
        includeProposals: true,
        eventsCtx: { dbPath: stateDbPath },
      });

      expect(result.entries.every((e) => e.eventType === "promoted" || e.eventType === "rejected")).toBe(true);
      expect(result.entries.length).toBe(1);
      expect(result.entries[0]?.eventType).toBe("promoted");
    } finally {
      closeDatabase(db);
    }
  });

  test("usage events and proposal events are merged chronologically", async () => {
    const stateDbPath = path.join(makeTempDir("akm-history-merge-"), "state.db");
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
          dbPath: stateDbPath,
          now: () => new Date("2026-01-02T09:00:00Z").getTime(),
        },
      );

      const result = await akmHistory({
        db,
        includeProposals: true,
        eventsCtx: { dbPath: stateDbPath },
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
    const stateDbPath = path.join(makeTempDir("akm-history-ref-filter-"), "state.db");
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      // Two proposal events for different refs.
      appendEvent(
        { eventType: "promoted", ref: "skill:deploy", metadata: { proposalId: "p1", source: "reflect" } },
        { dbPath: stateDbPath },
      );
      appendEvent(
        { eventType: "rejected", ref: "memory:draft", metadata: { proposalId: "p2", source: "reflect" } },
        { dbPath: stateDbPath },
      );

      const result = await akmHistory({
        db,
        ref: "skill:deploy",
        includeProposals: true,
        eventsCtx: { dbPath: stateDbPath },
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
    const stashDir = sandboxStash();
    saveConfig({ semanticSearchMode: "off" });

    writeFile(path.join(stashDir, "memories", "alpha.md"), "---\ndescription: alpha memory\n---\nAlpha.\n");
    await akmIndex({ stashDir, full: true });

    // Write a promoted event to state.db (events now live in SQLite, not events.jsonl).
    appendEvent({
      eventType: "promoted",
      ref: "memory:alpha",
      metadata: { proposalId: "p-cli-test", source: "reflect", assetPath: "memories/alpha.md" },
    });

    const result = await runCli(["history", "--include-proposals", "--ref", "memory:alpha", "--format=json"]);
    expect(result.status).toBe(0);
    const parsed = parseJsonOutput(result);
    const entries = parsed.entries as Array<Record<string, unknown>>;
    expect(Array.isArray(entries)).toBe(true);
    // The promoted event should appear.
    const promotedEntry = entries.find((e) => e.eventType === "promoted");
    expect(promotedEntry).toBeDefined();
    expect(promotedEntry?.ref).toBe("memory:alpha");
    // Sources should include state.db (Phase 3: events moved from events.jsonl to state.db).
    expect(Array.isArray(parsed.sources)).toBe(true);
    expect((parsed.sources as string[]).includes("state.db")).toBe(true);

    // Verify text output also shows the proposal event.
    const text = await runCli(["history", "--include-proposals", "--ref", "memory:alpha", "--format=text"]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("[promoted]");
    expect(text.stdout).toContain("state.db");
  });
});

describe("akmHistory --source filter", () => {
  test("returns all events when source filter is not provided", async () => {
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      insertUsageEvent(db, { event_type: "search", query: "deploy", source: "user" });
      insertUsageEvent(db, { event_type: "search", query: "deploy", source: "improve" });

      const result = await akmHistory({ db });
      expect(result.totalCount).toBe(2);
    } finally {
      closeDatabase(db);
    }
  });

  test("filters to only user events when source=user", async () => {
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      insertUsageEvent(db, { event_type: "search", query: "user query", source: "user" });
      insertUsageEvent(db, { event_type: "search", query: "improve query", source: "improve" });

      const result = await akmHistory({ db, source: "user" });
      expect(result.totalCount).toBe(1);
      expect(result.entries[0]?.query).toBe("user query");
    } finally {
      closeDatabase(db);
    }
  });

  test("filters to only improve events when source=improve", async () => {
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      insertUsageEvent(db, { event_type: "search", query: "user query", source: "user" });
      insertUsageEvent(db, { event_type: "search", query: "improve query", source: "improve" });

      const result = await akmHistory({ db, source: "improve" });
      expect(result.totalCount).toBe(1);
      expect(result.entries[0]?.query).toBe("improve query");
    } finally {
      closeDatabase(db);
    }
  });

  test("source field is present in history entries", async () => {
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      insertUsageEvent(db, { event_type: "show", entry_ref: "memory:alpha", entry_id: 1, source: "improve" });

      const result = await akmHistory({ db });
      expect(result.entries[0]?.source).toBe("improve");
    } finally {
      closeDatabase(db);
    }
  });

  test("source defaults to user when not specified in insert", async () => {
    const db = openDatabase(":memory:");
    try {
      ensureUsageEventsSchema(db);
      insertUsageEvent(db, { event_type: "show", entry_ref: "memory:alpha", entry_id: 1 });

      const result = await akmHistory({ db });
      expect(result.entries[0]?.source).toBe("user");
    } finally {
      closeDatabase(db);
    }
  });
});

describe("akm history --generator CLI flag", () => {
  test("filters by generator via CLI", async () => {
    const stashDir = sandboxStash();
    saveConfig({ semanticSearchMode: "off" });

    writeFile(path.join(stashDir, "memories", "alpha.md"), "---\ndescription: alpha memory\n---\nAlpha.\n");
    await akmIndex({ stashDir, full: true });

    // Generate a user feedback event.
    const feedback = await runCli(["feedback", "memory:alpha", "--positive", "--format=json"]);
    expect(feedback.status).toBe(0);

    // Insert an improve event directly.
    const db = openDatabase(getDbPath());
    try {
      ensureUsageEventsSchema(db);
      insertUsageEvent(db, { event_type: "search", query: "improve search", source: "improve" });
    } finally {
      closeDatabase(db);
    }

    // Filter to user events only.
    const userOnly = await runCli(["history", "--generator", "user", "--format=json"]);
    expect(userOnly.status).toBe(0);
    const userJson = parseJsonOutput(userOnly);
    const userEntries = userJson.entries as Array<Record<string, unknown>>;
    expect(userEntries.every((e) => e.source === "user")).toBe(true);

    // Filter to improve events only.
    const improveOnly = await runCli(["history", "--generator", "improve", "--format=json"]);
    expect(improveOnly.status).toBe(0);
    const improveJson = parseJsonOutput(improveOnly);
    const improveEntries = improveJson.entries as Array<Record<string, unknown>>;
    expect(improveEntries.every((e) => e.source === "improve")).toBe(true);
  });

  test("rejects invalid generator value", async () => {
    const result = await runCli(["history", "--generator", "invalid", "--format=json"]);
    expect(result.status).not.toBe(0);
    const parsed = parseJsonOutput(result);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error).toContain("--generator");
  });
});
