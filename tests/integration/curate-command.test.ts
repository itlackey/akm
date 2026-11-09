import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { BRIEF_DESCRIPTION_LIMIT } from "../../src/output/shapes/helpers";
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
// dirs (cache/config/data) plus AKM_BUNDLE_DIR via the allowlisted withEnv
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
      AKM_BUNDLE_DIR: stashDir,
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

  test("returns curated JSON with refs", async () => {
    const stashDir = makeStash();
    const output = await runCli(stashDir, ["curate", "release deploy", "--format=json"]);
    const json = JSON.parse(output) as { query: string; results: Array<Record<string, unknown>>; summary: string };

    expect(json.query).toBe("release deploy");
    expect(json.summary).toContain("Selected");
    expect(json.results.length).toBeGreaterThanOrEqual(2);
    expect(new Set(json.results.map((item) => item.type)).size).toBeGreaterThanOrEqual(2);

    for (const item of json.results) {
      if (item.source === "local") {
        expect(typeof item.ref).toBe("string");
        expect(item).not.toHaveProperty("followUp");
        expect(item.reason).toBeUndefined(); // only historical items carry a reason (#1482)
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
    const json = JSON.parse(output) as { results: Array<Record<string, unknown>> };

    expect(json.results.map((item) => String(item.ref).split("//").at(-1)).sort()).toEqual([
      "commands/release",
      "commands/release-notes",
    ]);
  });

  test("text output includes direct refs", async () => {
    const stashDir = makeStash();
    const output = await runCli(stashDir, ["curate", "release deploy", "--format=text"]);

    expect(output).toContain('Curated results for "release deploy"');
    expect(output).toContain("[command]");
    expect(output).toContain("commands/release");
    expect(output).not.toContain("show: akm show");
  });

  test("returns a tip when no curated results are found", async () => {
    const stashDir = makeTempDir("akm-curate-empty-stash-");
    const output = await runCli(stashDir, ["curate", "totally unmatched request", "--format=json"]);
    const json = JSON.parse(output) as { results: Array<Record<string, unknown>>; tip?: string; summary: string };

    expect(json.results).toEqual([]);
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
      expect(rows[0]!.query).toBe("release");
      const meta = JSON.parse(rows[0]!.metadata);
      expect(meta.itemCount).toBeGreaterThan(0);
      expect(Array.isArray(meta.itemRefs)).toBe(true);
    } finally {
      db.close();
    }
  });

  // ── WS2: --detail / --shape are now effective on curate ─────────────────────
  test("--detail full projects description on stash items; brief caps it", async () => {
    const stashDir = makeStash();
    const brief = JSON.parse(await runCli(stashDir, ["curate", "release", "--format=json"])) as {
      results: Array<Record<string, unknown>>;
    };
    const full = JSON.parse(await runCli(stashDir, ["curate", "release", "--format=json", "--detail=full"])) as {
      results: Array<Record<string, unknown>>;
    };
    const briefStash = brief.results.find((i) => i.source === "local");
    const fullStash = full.results.find((i) => i.source === "local");
    expect(briefStash).toBeDefined();
    expect(fullStash).toBeDefined();
    // brief carries a short capped description; full carries the whole thing.
    expect(String(briefStash?.description).length).toBeLessThanOrEqual(BRIEF_DESCRIPTION_LIMIT);
    expect(briefStash).not.toHaveProperty("followUp");
  });

  test("--detail normal trims results to the field set an agent needs", async () => {
    const stashDir = makeStash();
    const output = await runCli(stashDir, ["curate", "release", "--format=json", "--detail=normal"]);
    const json = JSON.parse(output) as { results: Array<Record<string, unknown>> };
    const stashItem = json.results.find((i) => i.source === "local");
    expect(stashItem).toBeDefined();
    // normal never carries the heavyweight `preview` field.
    expect(stashItem).not.toHaveProperty("preview");
    expect(stashItem).toHaveProperty("ref");
    expect(path.isAbsolute(String(stashItem?.path))).toBe(true);
    expect(stashItem).toHaveProperty("editable", true);
    expect(stashItem).not.toHaveProperty("editHint");
    expect(stashItem).not.toHaveProperty("followUp");
  });

  test("a stopword-padded prompt still finds docker results", async () => {
    const stashDir = makeRankingBaselineStash();
    const output = await runCli(stashDir, ["curate", "the docker", "--format=json", "--detail=full"]);
    const json = JSON.parse(output) as { results: Array<Record<string, unknown>> };

    expect(json.results.length).toBeGreaterThan(0);
    expect(json.results.every((item) => String(item.ref).includes("docker"))).toBe(true);
  });

  test("docker deploy no longer surfaces release-manager filler", async () => {
    const stashDir = makeRankingBaselineStash();
    const output = await runCli(stashDir, ["curate", "docker deploy", "--format=json", "--detail=full"]);
    const json = JSON.parse(output) as { results: Array<Record<string, unknown>> };

    expect(json.results.some((item) => String(item.ref).endsWith("//commands/release-manager"))).toBe(false);
  });

  describe("--pack", () => {
    test("--format=json returns a bare array of {ref, tokens, content}", async () => {
      const stashDir = makeStash();
      const output = await runCli(stashDir, ["curate", "release deploy", "--format=json", "--pack", "4000"]);
      const items = JSON.parse(output) as Array<Record<string, unknown>>;

      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(typeof item.ref).toBe("string");
        expect(typeof item.tokens).toBe("number");
        expect(typeof item.content).toBe("string");
        // Only the fields {ref, tokens, content} — no leftover curated-item fields.
        expect(Object.keys(item).sort()).toEqual(["content", "ref", "tokens"]);
      }
    });

    test("default text output concatenates content under ## <ref> headers", async () => {
      const stashDir = makeStash();
      const output = await runCli(stashDir, ["curate", "release deploy", "--format=text", "--pack", "4000"]);

      expect(output).toContain("## commands/release");
      expect(output).toContain("npm version {{version}}");
    });

    test("small budget drops low-ranked hits rather than truncating them", async () => {
      const stashDir = makeStash();
      const full = JSON.parse(
        await runCli(stashDir, ["curate", "release deploy", "--format=json", "--pack", "100000"]),
      ) as Array<{ ref: string; tokens: number }>;
      expect(full.length).toBeGreaterThan(1);

      // A budget smaller than the total but big enough for at least the top
      // hit keeps a strict prefix of the full-budget ranked list.
      const totalTokens = full.reduce((sum, item) => sum + item.tokens, 0);
      const tightBudget = full[0]!.tokens + 1;
      const tight = JSON.parse(
        await runCli(stashDir, ["curate", "release deploy", "--format=json", "--pack", String(tightBudget)]),
      ) as Array<{ ref: string; tokens: number }>;

      expect(tightBudget).toBeLessThan(totalTokens);
      expect(tight.map((item) => item.ref)).toEqual(full.slice(0, tight.length).map((item) => item.ref));
      expect(tight.length).toBeLessThan(full.length);
    });
  });
});
