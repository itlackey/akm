// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EXIT_CODES } from "../../../src/cli/shared";
import { akmHealth } from "../../../src/commands/health";
import { runConnectionsAndHarnessesCheck } from "../../../src/commands/health/connections-and-harnesses-check";
import type { AkmHealthResult, HealthCheckResult } from "../../../src/commands/health/types";
import { STASH_GITIGNORE_TRACK_SECRETS_MARKER } from "../../../src/commands/sources/stash-skeleton";
import { resetConfigCache } from "../../../src/core/config/config";
import { STATE_BASELINE_IDS, STATE_MIGRATIONS } from "../../../src/core/state/migrations";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import { probeLlmEndpoint } from "../../../src/llm/client";
import { _setLocalPipelineLoaderForTests } from "../../../src/llm/embedder";
import { LocalRuntimeUnavailableError } from "../../../src/llm/embedders/local";
import { openDatabase } from "../../../src/storage/database";
import { runMigrations } from "../../../src/storage/sqlite-migrations";
import { runCliCapture } from "../../_helpers/cli";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  useBundleConfig,
  withIsolatedAkmStorage,
  withMockedFetch,
  writeSandboxConfig,
} from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

/**
 * The user's `scripts/akm-health-discord.ts` cron job runs
 * `akm --format json -q health --window-compare=1h` and reaches into the
 * result by hand (`h.status`, `h.advisories[].evidence`,
 * `h.metrics.stuckActiveRuns`, `h.windows[].improve.coverage.distinctRefs`,
 * `h.windows[].metrics.llmUsage.{calls,totalTokens,totalDurationMs}`) — it is
 * not part of this package and has no type-level coupling to
 * `AkmHealthResult`, so a health simplification pass can silently drop a
 * field it reads without any compiler catching it. This test is a runtime
 * pin of that JSON shape, independent of any one health-check's behavior.
 */

describe("akm health --window-compare=1h JSON shape (akm-health-discord.ts contract)", () => {
  test("carries every field the Discord script reads", async () => {
    const storage: IsolatedAkmStorage = withIsolatedAkmStorage();
    try {
      const result = await akmHealth({ windowCompare: "1h" });

      // h.status
      expect(["pass", "warn", "fail"]).toContain(result.status);

      // h.advisories[] — { name, status, message, evidence? }
      expect(Array.isArray(result.advisories)).toBe(true);
      for (const advisory of result.advisories) {
        expect(typeof advisory.name).toBe("string");
        expect(typeof advisory.status).toBe("string");
        expect(typeof advisory.message).toBe("string");
      }

      // h.metrics.stuckActiveRuns
      expect(typeof result.metrics.stuckActiveRuns).toBe("number");

      // h.windows[] — current/prior, each carrying improve.coverage.distinctRefs
      // and metrics.llmUsage.{calls,totalTokens,totalDurationMs}.
      expect(Array.isArray(result.windows)).toBe(true);
      const windowNames = (result.windows ?? []).map((w) => w.name);
      expect(windowNames).toContain("current");
      expect(windowNames).toContain("prior");
      for (const window of result.windows ?? []) {
        expect(typeof window.improve.coverage.distinctRefs).toBe("number");
        expect(typeof window.metrics.llmUsage.calls).toBe("number");
        expect(typeof window.metrics.llmUsage.totalTokens).toBe("number");
        expect(typeof window.metrics.llmUsage.totalDurationMs).toBe("number");
      }
    } finally {
      storage.cleanup();
    }
  });

  test("carries the auto-accept-validation advisory evidence shape the script reads", async () => {
    const storage: IsolatedAkmStorage = withIsolatedAkmStorage();
    try {
      const result = await akmHealth({ windowCompare: "1h" });
      const autoAccept = result.advisories.find((a) => a.name === "auto-accept-validation");
      // Always registered (advisory channel, unconditional) — the script reads
      // `a.evidence?.promoted` / `a.evidence?.validationFailed` off it.
      expect(autoAccept).toBeDefined();
      expect(typeof autoAccept?.evidence?.promoted).toBe("number");
      expect(typeof autoAccept?.evidence?.validationFailed).toBe("number");
    } finally {
      storage.cleanup();
    }
  });
});

describe("health-state-db-migrations", () => {
  /**
   * The `state-db-migrations` hard check. Every state.db open applies pending
   * migrations, health's own open included, so a pending migration is not a
   * failure to report: the check passes and names what health's open applied. A
   * state.db below the 0.9.32 floor is the one refusal: health reports it as a
   * failing check naming what is pending, and the command never exits 78.
   */

  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    resetConfigCache();
  });

  afterEach(() => {
    resetConfigCache();
    storage.cleanup();
  });

  /** A state.db whose ledger stops one short of the 0.9.32 floor. */
  function seedBelowFloor(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const seeded = openDatabase(file);
    seeded.exec(
      "CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
    );
    for (const id of STATE_BASELINE_IDS.slice(0, -1))
      seeded.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(id);
    seeded.close();
  }

  function findHardCheck(result: Awaited<ReturnType<typeof akmHealth>>, name: string) {
    const found = result.hardChecks.find((check) => check.name === name);
    if (!found) throw new Error(`expected a hard check named ${name}`);
    return found;
  }

  test("health's own open of a state.db that does not exist yet applies the whole ledger and reports it", async () => {
    const result = await akmHealth();

    const check = findHardCheck(result, "state-db-migrations");
    expect(check.status).toBe("pass");
    const applied = check.evidence?.applied as string[];
    expect(applied[0]).toBe(STATE_MIGRATIONS[0]?.id);
    expect(applied.at(-1)).toBe(STATE_MIGRATIONS.at(-1)?.id);
    expect(check.evidence?.pending).toEqual([]);
  });

  test("a state.db below the floor is a failing check in the report, not a crash, and is left as it was", async () => {
    const file = getStateDbPath();
    seedBelowFloor(file);

    const { code, stdout } = await runCliCapture(["health", "--format", "json"]);
    expect(code).not.toBe(EXIT_CODES.CONFIG);

    const parsed = JSON.parse(stdout) as { hardChecks?: Array<{ name: string; status: string }> };
    expect(parsed.hardChecks?.find((c) => c.name === "state-db-migrations")?.status).toBe("fail");
    const db = openDatabase(file, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count).toBe(
      STATE_BASELINE_IDS.length - 1,
    );
    db.close();
  });

  test("a current, freshly-created state.db reports pass with no pending migrations", async () => {
    openStateDatabase(getStateDbPath()).close();

    const result = await akmHealth();
    const check = findHardCheck(result, "state-db-migrations");
    expect(check.status).toBe("pass");
    expect(check.evidence?.pending).toEqual([]);
  });

  test.each([
    ["garbage", (file: string) => fs.writeFileSync(file, "garbage garbage garbage\n")],
    ["zero-filled", (file: string) => fs.writeFileSync(file, Buffer.alloc(8192))],
    [
      "truncated",
      (file: string) => {
        const db = openDatabase(file);
        runMigrations(db, STATE_MIGRATIONS);
        db.close();
        fs.truncateSync(file, Math.floor(fs.statSync(file).size / 2));
      },
    ],
  ])("a %s state.db is one failing state-db-readable finding naming the file, with the recovery hint, exit 1", async (_kind, damage) => {
    const file = getStateDbPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    damage(file);

    const result = await akmHealth();
    expect(result.status).toBe("fail");
    expect(result.hardChecks.map((check) => check.name)).toEqual(["state-db-readable"]);
    expect(result.hardChecks[0]?.message).toContain(`state.db at ${file} is damaged`);
    expect(result.hardChecks[0]?.message).toContain(".recover");

    const { code } = await runCliCapture(["health", "--format", "json"]);
    expect(code).toBe(EXIT_CODES.GENERAL);
  });
});

/**
 * #1291 end-to-end: `akm health` checks every configured git-backed bundle for
 * tracked env/secret files with a remote, not just the working stash, and each
 * bundle's own `.gitignore` marker acknowledges its intentional tracking.
 *
 * Integration: spawns real `git` (no network: the remote is never contacted).
 */

function git(dir: string, args: string[]): void {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
}

/** A git bundle with one tracked synthetic secret and a never-contacted remote. */
function exposedBundle(dir: string, gitignore?: string): void {
  fs.mkdirSync(path.join(dir, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "secrets", "example.key"), "");
  if (gitignore !== undefined) fs.writeFileSync(path.join(dir, ".gitignore"), gitignore);
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["add", "-A"]);
  git(dir, [
    "-c",
    "user.name=akm-test",
    "-c",
    "user.email=akm@test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "x",
  ]);
  git(dir, ["remote", "add", "origin", "https://example.org/team/knowledge.git"]);
}

describe("stash-git-exposure across bundles (#1291)", () => {
  test("warns for each exposed bundle and skips one whose .gitignore acknowledges tracking", async () => {
    const storage = withIsolatedAkmStorage();
    const team = makeSandboxDir("akm-exposure-team");
    const acknowledged = makeSandboxDir("akm-exposure-private");
    try {
      exposedBundle(storage.stashDir);
      exposedBundle(team.dir);
      exposedBundle(acknowledged.dir, `${STASH_GITIGNORE_TRACK_SECRETS_MARKER}\n`);
      writeSandboxConfig({
        semanticSearchMode: "off",
        defaultBundle: "stash",
        bundles: {
          stash: { path: storage.stashDir },
          team: { path: team.dir },
          acknowledged: { path: acknowledged.dir },
        },
      });

      const result = await akmHealth({ since: "7d" });
      const roots = result.advisories
        .filter((check) => check.name === "stash-git-exposure")
        .map((check) => fs.realpathSync((check.evidence as { bundleRoot: string }).bundleRoot))
        .sort();
      expect(roots).toEqual([fs.realpathSync(storage.stashDir), fs.realpathSync(team.dir)].sort());
    } finally {
      acknowledged.cleanup();
      team.cleanup();
      storage.cleanup();
    }
  }, 60_000);

  test("an unreadable working stash skips the advisory without failing the report", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      useBundleConfig(path.join(storage.stashDir, "does-not-exist"));
      writeSandboxConfig({ semanticSearchMode: "off" });
      const result = await akmHealth({ since: "7d" });
      expect(result.advisories.some((check) => check.name === "stash-git-exposure")).toBe(false);
    } finally {
      storage.cleanup();
    }
  });
});

describe("health-semantic-search", () => {
  /**
   * End to end: `akm index` records its semantic-search state in index.db, `akm
   * health`'s `semantic-search` check reads it (no model, no request).
   */

  // Each case runs the real indexer and the health DB round-trip probe.
  setDefaultTimeout(30_000);

  let storage: IsolatedAkmStorage | undefined;

  afterEach(() => {
    storage?.cleanup();
    storage = undefined;
  });

  async function indexAndCheck(
    config: Record<string, unknown>,
    env?: Record<string, string>,
  ): Promise<{ result: AkmHealthResult; check: HealthCheckResult | undefined }> {
    storage = withIsolatedAkmStorage(env);
    writeSandboxConfig({
      ...config,
      defaultBundle: "fixture",
      bundles: { fixture: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } } },
    });
    for (const name of ["alpha", "beta"]) {
      const file = path.join(storage.stashDir, "knowledge", `${name}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `---\ndescription: ${name} note\n---\n# ${name}\n`);
    }
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const result = await akmHealth({ since: "24h" });
    return { result, check: result.hardChecks.find((c) => c.name === "semantic-search") };
  }

  describe("semantic-search health check, end to end", () => {
    test("a ready index passes", async () => {
      const { check } = await indexAndCheck({ semanticSearchMode: "auto" }, { AKM_EMBED_DETERMINISTIC: "1" });

      expect(check?.status).toBe("pass");
      expect(check?.message).toBe("Semantic search ready (2/2 embeddings).");
      expect(check?.evidence).toMatchObject({
        status: "ready-js",
        provider: "local",
        entryCount: 2,
        embeddingCount: 2,
      });
    });

    test("a native library that does not load fails as unavailable", async () => {
      overrideSeam(_setLocalPipelineLoaderForTests, async () => {
        throw new LocalRuntimeUnavailableError("libonnxruntime.so.1: failed to map segment from shared object", "load");
      });
      const { result, check } = await indexAndCheck({ semanticSearchMode: "auto" });

      expect(check?.status).toBe("fail");
      expect(check?.evidence).toMatchObject({
        status: "unavailable",
        unavailable: "load",
        entryCount: 2,
        embeddingCount: 0,
      });
      expect(check?.message).toContain("failed to map segment from shared object");
      expect(result.status).toBe("fail");
    });

    test("a platform with no native library warns", async () => {
      overrideSeam(_setLocalPipelineLoaderForTests, async () => {
        throw new LocalRuntimeUnavailableError("no native library is available for this platform", "platform");
      });
      const { result, check } = await indexAndCheck({ semanticSearchMode: "auto" });

      expect(check?.status).toBe("warn");
      expect(check?.evidence).toMatchObject({ status: "unavailable", unavailable: "platform" });
      expect(check?.message).toContain("unavailable on this platform");
      expect(check?.message).toContain("akm setup --embedding off");
      expect(result.status).toBe("warn");
    });

    test("an unreachable embedding endpoint fails as blocked, with the recorded reason", async () => {
      const { check } = await indexAndCheck({
        semanticSearchMode: "auto",
        embedding: { endpoint: "http://127.0.0.1:9/v1", model: "m" },
      });

      expect(check?.status).toBe("fail");
      expect(check?.evidence).toMatchObject({ status: "blocked", provider: "remote" });
      expect(check?.message).toContain("Semantic search was blocked at the last index");
    });

    test("semantic search off passes", async () => {
      const { check } = await indexAndCheck({ semanticSearchMode: "off" });

      expect(check?.status).toBe("pass");
    });
  });
});

describe("health-connections-and-harnesses", () => {
  /**
   * The `connections-and-harnesses` table as `akm health` and `akm info` emit it: the same rows in
   * the JSON of both, and the text rendering. `akm info` contacts nothing.
   */

  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    writeSandboxConfig({
      connections: {
        default: {
          endpoint: "http://localhost:11434/v1",
          models: { fast: "small", balanced: "mid", reasoning: "big" },
        },
      },
    });
  });

  afterEach(() => storage.cleanup());

  type Row = Record<string, unknown>;
  const targetRowsOf = async (since = "7d"): Promise<Row[]> => {
    const result = await akmHealth({ since });
    return (
      (result.hardChecks.find((check) => check.name === "connections-and-harnesses")?.evidence?.rows as Row[]) ?? []
    );
  };

  describe("the connections-and-harnesses table in akm health", () => {
    test("its rows carry exactly the documented fields", async () => {
      const rows = await targetRowsOf();
      expect(rows[0]).toEqual({
        type: "connection",
        name: "default",
        default: true,
        endpoint: "http://localhost:11434/v1",
        key: "none",
      });
      expect(rows.slice(1).map((row) => Object.keys(row).sort())).toEqual(
        rows.slice(1).map(() => ["kind", "model", "process", "target", "type"]),
      );
      expect(rows.find((row) => row.process === "improve")).toEqual({
        type: "process",
        process: "improve",
        kind: "connection",
        target: "default",
        model: "small",
      });
    });

    test("the text format always shows the table, brief or not", async () => {
      const { stdout } = await runCliCapture(["health", "--no-probe", "--format", "text"]);
      expect(stdout).toContain(
        "connections-and-harnesses  [pass, deterministic, high]  1 connection and 0 harnesses, all ready.",
      );
      expect(stdout).toContain("connections:");
      expect(stdout).toContain("improve    connection default  small");
    });
  });

  describe("the connections-and-harnesses table in akm info", () => {
    test("is the same rows, with nothing contacted", async () => {
      let fetchCalls = 0;
      const { stdout } = await withMockedFetch(
        () => runCliCapture(["info", "--format", "json"]),
        () => {
          fetchCalls += 1;
          return new Response("no", { status: 500 });
        },
      );
      expect(fetchCalls).toBe(0);
      const rows = (JSON.parse(stdout) as { connectionsAndHarnesses: Row[] }).connectionsAndHarnesses;
      expect(rows[0]).toEqual({
        type: "connection",
        name: "default",
        default: true,
        endpoint: "http://localhost:11434/v1",
        key: "none",
      });
      expect(rows).toEqual(await targetRowsOf());
    });

    test("the text format prints the three tables", async () => {
      const { stdout } = await runCliCapture(["info", "--format", "text"]);
      expect(stdout).toContain("connections:");
      expect(stdout).toContain("work:");
      expect(stdout).toContain("agents     connection default  mid");
    });
  });

  describe("the connections-and-harnesses check over HTTP", () => {
    test("a loopback endpoint that answers is reachable; a closed port is not, and says why", async () => {
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ data: [] }) });
      const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
      const closedPort = closed.port;
      closed.stop(true);
      try {
        const result = await runConnectionsAndHarnessesCheck({
          loadConfig: () => ({
            semanticSearchMode: "off",
            connections: {
              up: { endpoint: `http://127.0.0.1:${server.port}/v1`, models: { fast: "m" } },
              down: { endpoint: `http://127.0.0.1:${closedPort}/v1`, models: { fast: "m" } },
            },
          }),
          probeReachable: probeLlmEndpoint,
        });
        const rows = result.evidence?.rows as Row[];
        expect(rows.find((row) => row.name === "up")).toMatchObject({ reachable: true });
        expect(rows.find((row) => row.name === "down")).toMatchObject({ reachable: false });
        expect(result.status).toBe("warn");
        expect(result.message).toContain('connection "down" is not reachable');
      } finally {
        server.stop(true);
      }
    });
  });
});
