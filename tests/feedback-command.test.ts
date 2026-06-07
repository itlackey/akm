import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../src/commands/read/search";
import { saveConfig } from "../src/core/config";
import { getDbPath } from "../src/core/paths";
import { closeDatabase, openDatabase } from "../src/indexer/db";
import { akmIndex } from "../src/indexer/indexer";
import type { SourceSearchHit } from "../src/sources/types";
import { runCliCapture } from "./_helpers/cli";
import { type Cleanup, sandboxStashDir, sandboxXdgCacheHome, sandboxXdgConfigHome } from "./_helpers/sandbox";

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

let stashDir = "";
let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  stashDir = stashResult.dir;
  envCleanup = stashResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
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

    const memoryResult = await runCli(["feedback", "memory:deployment-notes", "--positive", "--format=json"]);
    expect(memoryResult.status).toBe(0);
    expect(parseJsonOutput(memoryResult)).toMatchObject({
      ok: true,
      ref: "memory:deployment-notes",
      signal: "positive",
    });

    const envResult = await runCli(["feedback", "env:prod", "--positive", "--format=json"]);
    expect(envResult.status).toBe(0);
    expect(parseJsonOutput(envResult)).toMatchObject({
      ok: true,
      ref: "env:prod",
      signal: "positive",
    });
    expect(envResult.stdout).not.toContain("super-secret-value");

    const db = openDatabase(getDbPath());
    try {
      const events = db
        .prepare(
          "SELECT entry_ref, entry_id, signal FROM usage_events WHERE event_type = 'feedback' ORDER BY entry_ref ASC",
        )
        .all() as Array<{ entry_ref: string; entry_id: number | null; signal: string }>;
      expect(events).toHaveLength(2);
      expect(events[0]?.entry_ref).toBe("env:prod");
      expect(events[0]?.entry_id).toEqual(expect.any(Number));
      expect(events[0]?.signal).toBe("positive");
      expect(events[1]?.entry_ref).toBe("memory:deployment-notes");
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

    const result = await runCli(["feedback", "command:complete-github-issue", "--positive", "--format=json"]);
    expect(result.status).toBe(0);
    expect(parseJsonOutput(result)).toMatchObject({
      ok: true,
      ref: "command:complete-github-issue",
      signal: "positive",
    });
  });

  test("rejects refs that are validly formatted but not in the current index", async () => {
    writeFile(path.join(stashDir, "memories", "known.md"), "---\ndescription: known memory\n---\nKnown.\n");
    await buildIndex();

    const result = await runCli(["feedback", "memory:missing", "--positive", "--format=json"]);
    expect(result.status).not.toBe(0);
    const output = parseJsonOutput(result);
    expect(output.ok).toBe(false);
    expect(output.error).toContain("memory:missing");
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
      "memory:deployment-notes",
      "--positive",
      "--reason",
      "saved me 30 minutes",
      "--format=json",
    ]);
    expect(result.status).toBe(0);
    const parsed = parseJsonOutput(result);
    expect(parsed).toMatchObject({
      ok: true,
      ref: "memory:deployment-notes",
      signal: "positive",
      reason: "saved me 30 minutes",
    });

    // Read events.jsonl directly and verify the note was persisted in metadata.
    const { readEvents } = await import("../src/core/events");
    const { events } = readEvents({ type: "feedback", ref: "memory:deployment-notes" });
    expect(events.length).toBeGreaterThan(0);
    const md = (events.at(-1)?.metadata ?? {}) as Record<string, unknown>;
    expect(md.reason).toBe("saved me 30 minutes");
    expect(md.signal).toBe("positive");
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
    expect(beforeMemories.slice(0, 2).map((hit) => hit.ref)).toEqual(["memory:alpha", "memory:omega"]);
    expect(beforeMemories[0]?.score).toBe(beforeMemories[1]?.score);

    const feedback = await runCli(["feedback", "memory:omega", "--positive", "--format=json"]);
    expect(feedback.status).toBe(0);

    await buildIndex();

    const after = await akmSearch({ query: "shared deployment incident", source: "local" });
    const afterMemories = after.hits.filter(isLocalHit).filter((hit) => hit.type === "memory");
    expect(afterMemories[0]?.ref).toBe("memory:omega");
    expect(afterMemories[0]?.whyMatched).toContain("usage history boost");
  });
});
