import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../../src/core/paths";
import { closeDatabase, openDatabase } from "../../src/indexer/db/db";
import { runCliCapture } from "../_helpers/cli";
import { type Cleanup, sandboxStashDir } from "../_helpers/sandbox";

// Migrated from per-test spawnSync("bun", [cliPath, ...]) to the in-process
// harness (tests/_helpers/cli.ts). The preload (tests/_preload.ts) sandboxes
// HOME / XDG dirs / AKM_STASH_DIR per test; makeStashDir() re-sandboxes the
// stash via the allowlisted helper and adds the `.akm` subdir these graph tests
// write into. Index-DB seeding now runs in-process against the same sandboxed
// XDG_DATA_HOME the CLI resolves (no env-swap needed), so the empty getDbPath()
// database is shared between the seeder and the in-process verb.

let stashCleanup: Cleanup = () => {};

function makeStashDir(): string {
  // Re-sandbox the stash for this test and add the `.akm` subdir the graph
  // tests write into (sandboxStashDir creates the asset subdirs but not .akm).
  const stash = sandboxStashDir();
  stashCleanup = stash.cleanup;
  fs.mkdirSync(path.join(stash.dir, ".akm"), { recursive: true });
  return stash.dir;
}

async function runCli(args: string[], _stashDir: string): Promise<{ status: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

/** Initialize an empty index DB at the sandboxed `getDbPath()` location. */
function seedEmptyIndexDb(): void {
  const db = openDatabase(getDbPath());
  closeDatabase(db);
}

afterEach(() => {
  stashCleanup();
  stashCleanup = () => {};
});

describe("graph CLI negative paths", () => {
  test("export rejects invalid --format value", async () => {
    const stash = makeStashDir();
    const outPath = path.join(stash, "graph-export.json");
    const result = await runCli(["graph", "export", "--out", outPath, "--format", "yaml"], stash);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("--format");
  });

  test("export requires --out", async () => {
    const stash = makeStashDir();
    const result = await runCli(["graph", "export"], stash);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("MISSING_REQUIRED_ARGUMENT");
    expect(parsed.error).toContain("requires --out");
  });

  test("summary fails when graph artifact is missing", async () => {
    const stash = makeStashDir();
    seedEmptyIndexDb();
    const result = await runCli(["graph", "summary"], stash);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Graph data not found");
  });

  test("summary ignores graph.json when no SQLite graph data exists", async () => {
    const stash = makeStashDir();
    fs.writeFileSync(path.join(stash, ".akm", "graph.json"), "not-json\n", "utf8");
    seedEmptyIndexDb();
    const result = await runCli(["graph", "summary"], stash);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Graph data not found");
  });

  test("summary ignores invalid graph.json schema when no SQLite graph data exists", async () => {
    const stash = makeStashDir();
    fs.writeFileSync(
      path.join(stash, ".akm", "graph.json"),
      `${JSON.stringify({ schemaVersion: 999, generatedAt: "2026-01-01T00:00:00.000Z", stashRoot: stash, files: [] })}\n`,
      "utf8",
    );
    seedEmptyIndexDb();
    const result = await runCli(["graph", "summary"], stash);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Graph data not found");
  });

  test("entities rejects non-positive --limit", async () => {
    const stash = makeStashDir();
    const result = await runCli(["graph", "entities", "--limit", "0"], stash);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("Invalid --limit value");
  });
});
