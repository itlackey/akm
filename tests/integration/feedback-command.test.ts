import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../../src/commands/read/search";
import { loadConfig, saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { akmIndex } from "../../src/indexer/indexer";
import { resolveSourceEntries } from "../../src/indexer/search/search-source";
import type { SourceSearchHit } from "../../src/sources/types";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

// Migrated from spawnSync("bun", [CLI, ...]) to the shared in-process harness
// (tests/_helpers/cli.ts). beforeEach already sandboxes AKM_STASH_DIR and the
// XDG dirs on process.env via the allowlisted sandbox helpers; the harness
// re-reads config from that env per call, so feedback events land in the same
// sandboxed stash/DB the test then asserts on. `feedback` is not
// process.cwd()-dependent.

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { stdout, stderr, code } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

function parseJsonOutput(result: { stdout: string; stderr: string }): Record<string, unknown> {
  const payload = result.stdout.trim() || result.stderr.trim();
  return JSON.parse(payload) as Record<string, unknown>;
}

function isLocalHit(hit: { type: string }): hit is SourceSearchHit {
  return hit.type !== "registry";
}

// Full composite isolation (incl. XDG_DATA_HOME): this file asserts EXACT
// usage_events row counts against getDbPath(), so it must own its index.db.
// The previous 3-helper chain left the data dir on the process-shared suite
// sandbox, where any shard-mate's feedback events leaked into the assertions
// (the leak surfaced whenever adding a test file reshuffled bun's shards).
let storage: IsolatedAkmStorage;
let stashDir = "";

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
});

afterEach(() => {
  storage.cleanup();
  stashDir = "";
});

async function buildIndex(): Promise<void> {
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

describe("akm feedback", () => {
  test("accepts indexed memory and env refs without surfacing env values", async () => {
    writeFile(
      path.join(stashDir, "memories", "deployment-notes.md"),
      "---\ndescription: deployment memory\n---\nRemember the VPN before deploy.\n",
    );
    writeFile(path.join(stashDir, "env", "prod.env"), "API_KEY=super-secret-value\nREGION=us-east-1\n");

    await buildIndex();

    const memoryResult = await runCli(["feedback", "memories/deployment-notes", "--positive", "--format=json"]);
    expect(memoryResult.status).toBe(0);
    expect(parseJsonOutput(memoryResult)).toMatchObject({
      ok: true,
      ref: "memories/deployment-notes",
      signal: "positive",
    });

    const envResult = await runCli(["feedback", "env/prod", "--positive", "--format=json"]);
    expect(envResult.status).toBe(0);
    expect(parseJsonOutput(envResult)).toMatchObject({
      ok: true,
      ref: "env/prod",
      signal: "positive",
    });
    expect(envResult.stdout).not.toContain("super-secret-value");

    const db = openIndexDatabase(getDbPath());
    try {
      const events = db
        .prepare(
          "SELECT entry_ref, entry_id, signal FROM usage_events WHERE event_type = 'feedback' ORDER BY entry_ref ASC",
        )
        .all() as Array<{ entry_ref: string; entry_id: number | null; signal: string }>;
      expect(events).toHaveLength(2);
      // F4c: usage_events.entry_ref is now the resolved entry's fully-qualified
      // item_ref (`<bundle>//<conceptId>`), not the legacy `origin//type:name`.
      expect(events[0]?.entry_ref).toBe("stash//env/prod");
      expect(events[0]?.entry_id).toEqual(expect.any(Number));
      expect(events[0]?.signal).toBe("positive");
      expect(events[1]?.entry_ref).toBe("stash//memories/deployment-notes");
      expect(events[1]?.entry_id).toEqual(expect.any(Number));
      expect(events[1]?.signal).toBe("positive");
    } finally {
      closeDatabase(db);
    }
  });

  test("accepts markdown command refs without requiring the .md suffix", async () => {
    writeFile(
      path.join(stashDir, "commands", "complete-github-issue.md"),
      "---\ndescription: command asset\n---\nDispatch the workflow.\n",
    );

    await buildIndex();

    const result = await runCli(["feedback", "commands/complete-github-issue", "--positive", "--format=json"]);
    expect(result).toMatchObject({ status: 0 });
    expect(parseJsonOutput(result)).toMatchObject({
      ok: true,
      ref: "commands/complete-github-issue",
      signal: "positive",
    });
  });

  test("rejects refs that are validly formatted but not in the current index", async () => {
    writeFile(path.join(stashDir, "memories", "known.md"), "---\ndescription: known memory\n---\nKnown.\n");
    await buildIndex();

    const result = await runCli(["feedback", "memories/missing", "--positive", "--format=json"]);
    expect(result.status).not.toBe(0);
    const output = parseJsonOutput(result);
    expect(output.ok).toBe(false);
    expect(output.error).toContain("memories/missing");
    expect(output.error).toContain("not in the index");
  });

  // ── #284 GAP-HIGH 8: feedback --reason metadata round-trip ──────────────
  test("feedback --reason threads metadata into events.jsonl", async () => {
    writeFile(
      path.join(stashDir, "memories", "deployment-notes.md"),
      "---\ndescription: deployment memory\n---\nRemember the VPN before deploy.\n",
    );
    await buildIndex();

    const result = await runCli([
      "feedback",
      "memories/deployment-notes",
      "--positive",
      "--reason",
      "saved me 30 minutes",
      "--format=json",
    ]);
    expect(result.status).toBe(0);
    const parsed = parseJsonOutput(result);
    expect(parsed).toMatchObject({
      ok: true,
      ref: "memories/deployment-notes",
      signal: "positive",
      reason: "saved me 30 minutes",
    });

    // Read events.jsonl directly and verify the note was persisted in metadata.
    const { readEvents } = await import("../../src/core/events");
    const { events } = readEvents({ type: "feedback", ref: "stash//memory:deployment-notes" });
    expect(events.length).toBeGreaterThan(0);
    const md = (events.at(-1)?.metadata ?? {}) as Record<string, unknown>;
    expect(md.reason).toBe("saved me 30 minutes");
    expect(md.signal).toBe("positive");
  });

  test("origin-qualified feedback binds duplicate refs to the selected source row", async () => {
    const teamDir = path.join(storage.root, "team-stash");
    writeFile(path.join(stashDir, "memories", "shared.md"), "---\ndescription: primary copy\n---\nPrimary.\n");
    writeFile(path.join(teamDir, "memories", "shared.md"), "---\ndescription: team copy\n---\nTeam.\n");
    saveConfig({
      semanticSearchMode: "off",
      stashDir,
      sources: [
        { type: "filesystem", name: "stash", path: stashDir, primary: true, writable: true },
        { type: "filesystem", name: "team", path: teamDir, writable: true },
      ],
      defaultWriteTarget: "stash",
    });
    expect(resolveSourceEntries(undefined, loadConfig()).map((source) => source.path)).toContain(teamDir);
    await akmIndex({ stashDir, full: true });
    expect(await runCli(["feedback", "stash//memories/shared", "--positive", "--format=json"])).toMatchObject({
      status: 0,
    });
    // Re-prioritize the second source. The index intentionally keeps one winner
    // for a duplicate bare ref, while durable feedback must retain both origins.
    await akmIndex({ stashDir: teamDir, full: true });
    expect(await runCli(["feedback", "team//memories/shared", "--positive", "--format=json"])).toMatchObject({
      status: 0,
    });

    const db = openIndexDatabase(getDbPath());
    try {
      const refs = db
        .prepare("SELECT entry_ref FROM usage_events WHERE event_type = 'feedback' ORDER BY entry_ref")
        .all() as Array<{ entry_ref: string }>;
      // F4c: durable feedback keys are the resolved entries' item_refs, one per
      // origin — the cross-origin distinction is preserved, never collapsed.
      expect(refs.map((row) => row.entry_ref)).toEqual(["stash//memories/shared", "team//memories/shared"]);
    } finally {
      closeDatabase(db);
    }
  });

  test("positive feedback affects subsequent ranking after re-indexing", async () => {
    writeFile(
      path.join(stashDir, "memories", "alpha.md"),
      "---\ndescription: shared deployment incident memory\n---\nUse the same deployment incident checklist.\n",
    );
    writeFile(
      path.join(stashDir, "memories", "omega.md"),
      "---\ndescription: shared deployment incident memory\n---\nUse the same deployment incident checklist.\n",
    );

    await buildIndex();

    const before = await akmSearch({ query: "shared deployment incident", source: "local" });
    const beforeMemories = before.hits.filter(isLocalHit).filter((hit) => hit.type === "memory");
    expect(beforeMemories.slice(0, 2).map((hit) => hit.ref)).toEqual(["memories/alpha", "memories/omega"]);
    expect(beforeMemories[0]?.score).toBe(beforeMemories[1]?.score);

    const feedback = await runCli(["feedback", "memories/omega", "--positive", "--format=json"]);
    expect(feedback.status).toBe(0);

    await buildIndex();

    const after = await akmSearch({ query: "shared deployment incident", source: "local" });
    const afterMemories = after.hits.filter(isLocalHit).filter((hit) => hit.type === "memory");
    expect(afterMemories[0]?.ref).toBe("memories/omega");
    expect(afterMemories[0]?.whyMatched).toContain("usage history boost");
  });

  test("feedback on an unindexed asset fails fast with a clear error instead of triggering a slow reindex", async () => {
    writeFile(path.join(stashDir, "memories", "alpha.md"), "---\ndescription: alpha memory\n---\nAlpha body.\n");
    await buildIndex();

    // beta.md exists on disk but was NOT indexed — feedback must fail quickly
    // rather than triggering a blocking inline reindex (which was causing 3+ min
    // runtimes). The user should run `akm index` to pick up new assets first.
    writeFile(path.join(stashDir, "memories", "beta.md"), "---\ndescription: beta memory\n---\nBeta body.\n");

    const result = await runCli(["feedback", "memories/beta", "--positive", "--format=json"]);
    expect(result.status).toBe(2); // UsageError exit code
    const parsed = parseJsonOutput(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error ?? parsed.message ?? "").toMatch(/not in the index/i);
  });
});
