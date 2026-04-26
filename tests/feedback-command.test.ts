import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch } from "../src/commands/search";
import { saveConfig } from "../src/core/config";
import { getDbPath } from "../src/core/paths";
import { closeDatabase, openDatabase } from "../src/indexer/db";
import { akmIndex } from "../src/indexer/indexer";
import type { SourceSearchHit } from "../src/sources/types";

const CLI = path.join(__dirname, "..", "src", "cli.ts");
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

function isLocalHit(hit: { type: string }): hit is SourceSearchHit {
  return hit.type !== "registry";
}

async function buildIndex(stashDir: string): Promise<void> {
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

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

describe("akm feedback", () => {
  test("accepts indexed memory and vault refs without surfacing vault values", async () => {
    const stashDir = makeTempDir("akm-feedback-stash-");
    process.env.XDG_CACHE_HOME = makeTempDir("akm-feedback-cache-");
    process.env.XDG_CONFIG_HOME = makeTempDir("akm-feedback-config-");

    writeFile(
      path.join(stashDir, "memories", "deployment-notes.md"),
      "---\ndescription: deployment memory\n---\nRemember the VPN before deploy.\n",
    );
    writeFile(path.join(stashDir, "vaults", "prod.env"), "API_KEY=super-secret-value\nREGION=us-east-1\n");

    await buildIndex(stashDir);

    const memoryResult = runCli(["feedback", "memory:deployment-notes", "--positive", "--format=json"]);
    expect(memoryResult.status).toBe(0);
    expect(parseJsonOutput(memoryResult)).toMatchObject({
      ok: true,
      ref: "memory:deployment-notes",
      signal: "positive",
    });

    const vaultResult = runCli(["feedback", "vault:prod", "--positive", "--format=json"]);
    expect(vaultResult.status).toBe(0);
    expect(parseJsonOutput(vaultResult)).toMatchObject({
      ok: true,
      ref: "vault:prod",
      signal: "positive",
    });
    expect(vaultResult.stdout).not.toContain("super-secret-value");
    expect(vaultResult.stdout).not.toContain("REGION");

    const db = openDatabase(getDbPath());
    try {
      const events = db
        .prepare(
          "SELECT entry_ref, entry_id, signal FROM usage_events WHERE event_type = 'feedback' ORDER BY entry_ref ASC",
        )
        .all() as Array<{ entry_ref: string; entry_id: number | null; signal: string }>;
      expect(events).toHaveLength(2);
      expect(events[0]?.entry_ref).toBe("memory:deployment-notes");
      expect(events[0]?.entry_id).toEqual(expect.any(Number));
      expect(events[0]?.signal).toBe("positive");
      expect(events[1]?.entry_ref).toBe("vault:prod");
      expect(events[1]?.entry_id).toEqual(expect.any(Number));
      expect(events[1]?.signal).toBe("positive");
    } finally {
      closeDatabase(db);
    }
  });

  test("rejects refs that are validly formatted but not in the current index", async () => {
    const stashDir = makeTempDir("akm-feedback-stash-");
    process.env.XDG_CACHE_HOME = makeTempDir("akm-feedback-cache-");
    process.env.XDG_CONFIG_HOME = makeTempDir("akm-feedback-config-");

    writeFile(path.join(stashDir, "memories", "known.md"), "---\ndescription: known memory\n---\nKnown.\n");
    await buildIndex(stashDir);

    const result = runCli(["feedback", "memory:missing", "--positive", "--format=json"]);
    expect(result.status).not.toBe(0);
    expect(parseJsonOutput(result)).toMatchObject({
      ok: false,
      error: 'Ref "memory:missing" is not in the current index. Run "akm index" and try again.',
    });
  });

  test("positive feedback affects subsequent ranking after re-indexing", async () => {
    const stashDir = makeTempDir("akm-feedback-stash-");
    process.env.XDG_CACHE_HOME = makeTempDir("akm-feedback-cache-");
    process.env.XDG_CONFIG_HOME = makeTempDir("akm-feedback-config-");

    writeFile(
      path.join(stashDir, "memories", "alpha.md"),
      "---\ndescription: shared deployment incident memory\n---\nUse the same deployment incident checklist.\n",
    );
    writeFile(
      path.join(stashDir, "memories", "omega.md"),
      "---\ndescription: shared deployment incident memory\n---\nUse the same deployment incident checklist.\n",
    );

    await buildIndex(stashDir);

    const before = await akmSearch({ query: "shared deployment incident", source: "local" });
    const beforeMemories = before.hits.filter(isLocalHit).filter((hit) => hit.type === "memory");
    expect(beforeMemories.slice(0, 2).map((hit) => hit.ref)).toEqual(["memory:alpha", "memory:omega"]);
    expect(beforeMemories[0]?.score).toBe(beforeMemories[1]?.score);

    const feedback = runCli(["feedback", "memory:omega", "--positive", "--format=json"]);
    expect(feedback.status).toBe(0);

    await buildIndex(stashDir);

    const after = await akmSearch({ query: "shared deployment incident", source: "local" });
    const afterMemories = after.hits.filter(isLocalHit).filter((hit) => hit.type === "memory");
    expect(afterMemories[0]?.ref).toBe("memory:omega");
    expect(afterMemories[0]?.whyMatched).toContain("usage history boost");
  });
});
