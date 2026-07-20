import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  withEnv,
  writeSandboxConfig,
} from "../_helpers/sandbox";

// Migrated from per-test spawnSync("bun", [CLI, ...]) to the in-process harness
// (tests/_helpers/cli.ts). Each runCli call pins a fresh isolated set of XDG
// dirs (cache/config/data) plus AKM_STASH_DIR via the allowlisted withEnv
// wrapper and resets the config cache before driving the CLI in-process,
// restoring env in finally. The `curate` command auto-indexes into index.db
// (not state.db), so the in-process write does not contend with the suite's
// open state DB.

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/**
 * Drive the CLI in-process against `stashDir` with a fresh isolated set of XDG
 * dirs. Returns the captured stdout plus the data dir (where index.db lands) so
 * callers that inspect the on-disk DB can locate it. Asserts exit 0.
 */
async function runCliWithDataDir(stashDir: string, args: string[]): Promise<{ stdout: string; dataDir: string }> {
  const xdgCache = makeTempDir("akm-curate-cache-");
  const xdgConfig = makeTempDir("akm-curate-config-");
  const xdgData = makeTempDir("akm-curate-data-");
  const res = await withEnv(
    {
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
    },
    async () => {
      resetConfigCache();
      return runCliCapture(args);
    },
  );
  expect(res.code).toBe(0);
  return { stdout: res.stdout.trim(), dataDir: xdgData };
}

async function runCli(stashDir: string, args: string[]): Promise<string> {
  const { stdout } = await runCliWithDataDir(stashDir, args);
  return stdout;
}

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  envCleanup = stashResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("curate command", () => {
  const rankingBaselineFixture = path.join(__dirname, "..", "fixtures", "stashes", "ranking-baseline");

  function makeRankingBaselineStash(): string {
    const stashDir = makeTempDir("akm-curate-ranking-baseline-");
    fs.cpSync(rankingBaselineFixture, stashDir, { recursive: true });
    return stashDir;
  }

  function makeStash(): string {
    const stashDir = makeTempDir("akm-curate-stash-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");
    writeFile(
      path.join(stashDir, "commands", "release.md"),
      "---\ndescription: Release the app\n---\nnpm version {{version}} && git push --follow-tags\n",
    );
    writeFile(
      path.join(stashDir, "skills", "release-review", "SKILL.md"),
      "---\ndescription: Review a release plan\n---\n# Release Review\nCheck rollout, rollback, and validation.\n",
    );
    writeFile(
      path.join(stashDir, "knowledge", "release-guide.md"),
      "# Release Guide\n\nUse this guide to explain the release workflow.\n",
    );
    return stashDir;
  }

  test("returns curated JSON with follow-up commands and previews", async () => {
    const stashDir = makeStash();
    const output = await runCli(stashDir, ["curate", "release deploy", "--format=json"]);
    const json = JSON.parse(output) as { query: string; items: Array<Record<string, unknown>>; summary: string };

    expect(json.query).toBe("release deploy");
    expect(json.summary).toContain("Selected");
    expect(json.items.length).toBeGreaterThanOrEqual(2);
    expect(new Set(json.items.map((item) => item.type)).size).toBeGreaterThanOrEqual(2);

    for (const item of json.items) {
      if (item.source === "stash") {
        expect(typeof item.ref).toBe("string");
        expect(String(item.followUp)).toContain("akm show");
        expect(typeof item.reason).toBe("string");
      }
    }
  });

  test("explicit --type keeps the top hits of the requested type", async () => {
    const stashDir = makeStash();
    writeFile(
      path.join(stashDir, "commands", "release-notes.md"),
      "---\ndescription: Draft release notes\n---\nWrite release notes for {{version}}\n",
    );

    const output = await runCli(stashDir, ["curate", "release", "--type", "command", "--format=json"]);
    const json = JSON.parse(output) as { items: Array<Record<string, unknown>> };

    expect(json.items.map((item) => item.ref)).toEqual(["commands/release", "commands/release-notes"]);
  });

  test("text output includes direct refs and follow-up commands", async () => {
    const stashDir = makeStash();
    const output = await runCli(stashDir, ["curate", "release deploy", "--format=text"]);

    expect(output).toContain('Curated results for "release deploy"');
    expect(output).toContain("[command]");
    expect(output).toContain("ref: commands/release");
    expect(output).toContain("show: akm show commands/release");
  });

  test("returns a tip when no curated results are found", async () => {
    const stashDir = makeTempDir("akm-curate-empty-stash-");
    const output = await runCli(stashDir, ["curate", "totally unmatched request", "--format=json"]);
    const json = JSON.parse(output) as { items: Array<Record<string, unknown>>; tip?: string; summary: string };

    expect(json.items).toEqual([]);
    // Auto-index runs but finds nothing in the empty stash
    expect(json.tip).toContain("Index is empty");
  });

  test("logs a curate event to usage_events", async () => {
    const stashDir = makeStash();
    const { dataDir } = await runCliWithDataDir(stashDir, ["curate", "release", "--format=json"]);

    // Check the database for the curate event. Chunk-8 WI-8.3: usage_events
    // lives in state.db now, not index.db.
    const dbPath = path.join(dataDir, "akm", "state.db");
    expect(fs.existsSync(dbPath)).toBe(true);

    const { Database } = require("bun:sqlite");
    const db = new Database(dbPath);
    try {
      const rows = db
        .prepare("SELECT event_type, query, metadata FROM usage_events WHERE event_type = 'curate'")
        .all() as Array<{ event_type: string; query: string; metadata: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].query).toBe("release");
      const meta = JSON.parse(rows[0].metadata);
      expect(meta.itemCount).toBeGreaterThan(0);
      expect(Array.isArray(meta.itemRefs)).toBe(true);
    } finally {
      db.close();
    }
  });

  // ── WS2: --detail / --shape are now effective on curate ─────────────────────
  test("--detail full projects description on stash items; brief omits it", async () => {
    const stashDir = makeStash();
    const brief = JSON.parse(await runCli(stashDir, ["curate", "release", "--format=json"])) as {
      items: Array<Record<string, unknown>>;
    };
    const full = JSON.parse(await runCli(stashDir, ["curate", "release", "--format=json", "--detail=full"])) as {
      items: Array<Record<string, unknown>>;
    };
    const briefStash = brief.items.find((i) => i.source === "stash");
    const fullStash = full.items.find((i) => i.source === "stash");
    expect(briefStash).toBeDefined();
    expect(fullStash).toBeDefined();
    // brief omits description; full carries it (when the item has one).
    expect(briefStash).not.toHaveProperty("description");
  });

  test("--shape agent trims items to the agent field set", async () => {
    const stashDir = makeStash();
    const output = await runCli(stashDir, ["curate", "release", "--format=json", "--shape=agent"]);
    const json = JSON.parse(output) as { items: Array<Record<string, unknown>> };
    const stashItem = json.items.find((i) => i.source === "stash");
    expect(stashItem).toBeDefined();
    // agent shape never carries the heavyweight `preview` field.
    expect(stashItem).not.toHaveProperty("preview");
    // but keeps the actionable followUp.
    expect(String(stashItem?.followUp)).toContain("akm show");
  });

  test("--shape summary is rejected on curate (only valid on show)", async () => {
    const stashDir = makeStash();
    // Semantic off keeps stderr limited to the error envelope this test
    // parses: with the default ("auto") the local embedder fetches its model
    // from huggingface.co during auto-index, and an offline/blocked fetch
    // prepends an "Embedding generation failed" warning to stderr.
    const xdgConfig = makeTempDir("akm-curate-config-");
    const res = await withEnv(
      {
        AKM_STASH_DIR: stashDir,
        XDG_CACHE_HOME: makeTempDir("akm-curate-cache-"),
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: makeTempDir("akm-curate-data-"),
      },
      async () => {
        writeSandboxConfig({ semanticSearchMode: "off" });
        resetConfigCache();
        return runCliCapture(["curate", "release", "--format=json", "--shape=summary"]);
      },
    );
    expect(res.code).toBe(2);
    // The error envelope is pretty-printed JSON on stderr.
    const parsed = JSON.parse(res.stderr.trim());
    expect(parsed.code).toBe("INVALID_SHAPE_VALUE");
  });

  test("docker homelab collapses family duplicates into one top-level result", async () => {
    const stashDir = makeRankingBaselineStash();
    const output = await runCli(stashDir, ["curate", "docker homelab", "--format=json", "--detail=full"]);
    const json = JSON.parse(output) as { items: Array<Record<string, unknown>> };

    expect(json.items[0]?.ref).toBe("skills/docker-homelab");
    const familyItems = json.items.filter(
      (item) =>
        item.ref === "skills/docker-homelab" ||
        String(item.ref).startsWith("knowledge/skills/docker-homelab/references/"),
    );
    expect(familyItems).toHaveLength(1);
    expect(json.items[0]?.supportRefs).toEqual([
      {
        ref: "knowledge/skills/docker-homelab/references/compose",
        type: "knowledge",
        reason: "Related family asset to inspect next.",
      },
      {
        ref: "knowledge/skills/docker-homelab/references/containers",
        type: "knowledge",
        reason: "Related family asset to inspect next.",
      },
    ]);
  });

  test("weak prompt residue now falls back to docker results", async () => {
    const stashDir = makeRankingBaselineStash();
    const output = await runCli(stashDir, ["curate", "the docker", "--format=json", "--detail=full"]);
    const json = JSON.parse(output) as { items: Array<Record<string, unknown>> };

    expect(json.items.length).toBeGreaterThan(0);
    expect(json.items[0]?.ref).toBe("skills/docker-homelab");
  });

  test("docker deploy no longer surfaces release-manager filler", async () => {
    const stashDir = makeRankingBaselineStash();
    const output = await runCli(stashDir, ["curate", "docker deploy", "--format=json", "--detail=full"]);
    const json = JSON.parse(output) as { items: Array<Record<string, unknown>> };

    expect(json.items.some((item) => item.ref === "commands/release-manager")).toBe(false);
  });
});
