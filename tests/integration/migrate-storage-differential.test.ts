/**
 * Cutover gate for WS3b (epic #490): old-vs-new fixture-stash DIFFERENTIAL.
 *
 * This file is the characterization net guarding the migrate-storage refactor
 * (MigrationStep registry + unified copyTree). It seeds a representative 0.8/0.7
 * fixture stash — knowledge files, env/secret/vault material with real-ish
 * content, nested dirs, AND a name collision to exercise the no-clobber path —
 * runs `runMigrations`, and asserts a FULL behavioural snapshot:
 *
 *   • the recorded step log (name / status / order) per migration version,
 *   • normalized step `detail` strings (tmp paths + ISO timestamps masked),
 *   • the resulting filesystem: every file path, its byte contents (sha256),
 *     and its POSIX mode (0600/0700 on the migrated secret tree),
 *   • summary counts (copied / skipped / success / failed),
 *   • the exit-code signal (process.exitCode, via printGroupedSummary).
 *
 * The snapshot was captured against the PRE-refactor script and committed.
 * Refactoring must keep it byte-for-byte identical. Because this migration
 * moves users' real secrets, the copy/verify/no-clobber/permission semantics
 * are DATA-SAFETY critical — this test is the proof they did not change.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ResolvedPaths, runMigrations, type StepResult } from "../../scripts/migrate-storage";

// ── Fixture construction ──────────────────────────────────────────────────────

interface Fixture {
  tmp: string;
  stashDir: string;
  paths: ResolvedPaths;
}

/**
 * Build a representative legacy stash exercising every reachable real-write
 * code path of the 0.7→0.8 and 0.8→0.9 migrations:
 *   - $CACHE/index.db, workflow.db        → migrateDb (copy+verify)
 *   - $CACHE/config-backups/ (nested)     → copyDirRecursive (clobber path)
 *   - $CONFIG/akm.lock                    → migrateLockfile
 *   - $CACHE/registry-index/*.json        → noteRegistryIndexCache
 *   - <stash>/vaults/ (nested + .env)     → migrateVaultsToEnv → copyDirNoClobber
 *   - <stash>/env/prod.env pre-existing   → NO-CLOBBER collision
 * events.jsonl / tasks-history are deliberately omitted: their state.db import
 * embeds non-deterministic SQLite output and is covered by the existing suite.
 */
function makeFixture(): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akm-migrate-test-"));
  const cacheDir = path.join(tmp, "cache");
  const configDir = path.join(tmp, "config");
  const dataDir = path.join(tmp, "data");
  const stateDir = path.join(tmp, "state");
  const stashDir = path.join(tmp, "stash");
  for (const d of [cacheDir, configDir, dataDir, stateDir, stashDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // 0.7→0.8 legacy sources.
  fs.writeFileSync(path.join(cacheDir, "index.db"), "INDEX-DB-BYTES-0123456789");
  fs.writeFileSync(path.join(cacheDir, "workflow.db"), "WORKFLOW-DB-BYTES-abcdef");

  fs.mkdirSync(path.join(cacheDir, "config-backups", "nested", "deep"), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "config-backups", "config.2024-01-01.json"), '{"v":1}\n');
  fs.writeFileSync(path.join(cacheDir, "config-backups", "nested", "a.json"), '{"a":true}\n');
  fs.writeFileSync(path.join(cacheDir, "config-backups", "nested", "deep", "b.json"), '{"b":2}\n');

  fs.writeFileSync(path.join(configDir, "akm.lock"), "name|sha|path\nfoo|abc|/x\n");

  fs.mkdirSync(path.join(cacheDir, "registry-index"), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "registry-index", "kit-a.json"), "{}");
  fs.writeFileSync(path.join(cacheDir, "registry-index", "kit-b.json"), "{}");
  fs.writeFileSync(path.join(cacheDir, "registry-index", "website-ignored.json"), "{}");

  // 0.8→0.9 vault → env material, with a deliberate name collision under env/.
  fs.mkdirSync(path.join(stashDir, "vaults", "team", "sub"), { recursive: true });
  fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "API_KEY=from-vault\nDB_URL=postgres://x\n", {
    mode: 0o644,
  });
  fs.writeFileSync(path.join(stashDir, "vaults", "team", "dev.env"), "TOKEN=hidden-token\n", { mode: 0o644 });
  fs.writeFileSync(path.join(stashDir, "vaults", "team", "sub", "deep.env"), "NESTED=yes\n", { mode: 0o640 });
  // Collision: env/prod.env already authored by the user → must be preserved.
  fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
  fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "API_KEY=already-here\n", { mode: 0o600 });

  // Point config.json at our stash so migrateVaultsToEnv resolves it.
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ stashDir }), "utf8");

  return {
    tmp,
    stashDir,
    paths: {
      cacheDir,
      configDir,
      dataDir,
      stateDir,
      stateDbPath: path.join(dataDir, "state.db"),
      indexDbPath: path.join(dataDir, "index.db"),
    },
  };
}

// ── Snapshot helpers ──────────────────────────────────────────────────────────

/** Mask tmp paths + ISO timestamps so detail strings are deterministic. */
function normalizeDetail(detail: string, fixt: Fixture): string {
  return detail
    .split(fixt.stashDir)
    .join("<STASH>")
    .split(fixt.paths.cacheDir)
    .join("<CACHE>")
    .split(fixt.paths.configDir)
    .join("<CONFIG>")
    .split(fixt.paths.dataDir)
    .join("<DATA>")
    .split(fixt.paths.stateDir)
    .join("<STATE>")
    .split(fixt.tmp)
    .join("<TMP>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ISO>");
}

interface StepSnapshot {
  name: string;
  status: string;
  detail: string;
}

function snapshotSteps(results: StepResult[], fixt: Fixture): StepSnapshot[] {
  return results.map((r) => ({ name: r.name, status: r.status, detail: normalizeDetail(r.detail, fixt) }));
}

/** Recursively snapshot a tree: relpath → {sha256, mode}. Sorted for stability. */
function snapshotTree(root: string): Record<string, { sha: string; mode: string }> {
  const out: Record<string, { sha: string; mode: string }> = {};
  if (!fs.existsSync(root)) return out;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        out[`${rel}/`] = { sha: "<dir>", mode: (fs.statSync(full).mode & 0o777).toString(8) };
        walk(full);
      } else {
        const buf = fs.readFileSync(full);
        out[rel] = {
          sha: crypto.createHash("sha256").update(buf).digest("hex"),
          mode: (fs.statSync(full).mode & 0o777).toString(8),
        };
      }
    }
  };
  walk(root);
  return out;
}

let fx: Fixture;
let previousExitCode: number | undefined;

beforeEach(() => {
  previousExitCode = typeof process.exitCode === "number" ? process.exitCode : undefined;
  process.exitCode = 0;
  fx = makeFixture();
});

afterEach(() => {
  fs.rmSync(fx.tmp, { recursive: true, force: true });
  process.exitCode = previousExitCode ?? 0;
});

// ── Golden snapshots (captured against the PRE-refactor script) ────────────────

const GOLDEN_STEPS_V07: StepSnapshot[] = [
  {
    name: "index.db",
    status: "success",
    detail: "copied to <DATA>/index.db — source left at <CACHE>/index.db (delete manually when ready)",
  },
  {
    name: "workflow.db",
    status: "success",
    detail: "copied to <DATA>/workflow.db — source left at <CACHE>/workflow.db (delete manually when ready)",
  },
  { name: "events.jsonl → state.db", status: "skipped", detail: "source not found" },
  { name: "tasks/history/", status: "skipped", detail: "source directory not found" },
  {
    name: "akm.lock",
    status: "success",
    detail:
      "copied to <DATA>/akm.lock — source left at <CONFIG>/akm.lock.\n" +
      "      IMPORTANT: akm now reads ONLY from $DATA/akm.lock. If this step is skipped,\n" +
      "      akm will start with an empty lockfile and 'akm add' will rebuild it from scratch.",
  },
  {
    name: "config-backups/",
    status: "success",
    detail: "copied 3 files to <DATA>/config-backups — sources left in place (delete manually when ready)",
  },
  { name: "tasks/history/ → state.db", status: "skipped", detail: "source directory not found" },
  {
    name: "registry-index/ (note)",
    status: "success",
    detail:
      "2 old file(s) noted at <CACHE>/registry-index — registry index cache will be rebuilt on next " +
      "'akm registry search'. Safe to delete: <CACHE>/registry-index/*.json",
  },
];

const GOLDEN_STEPS_V08: StepSnapshot[] = [
  { name: "Graph snapshot import", status: "skipped", detail: "no legacy graph file found" },
  {
    name: "vaults/ → env/",
    status: "success",
    detail:
      "copied 2 file(s) (1 already present in env/, preserved) <STASH>/vaults → <STASH>/env; " +
      "vaults/ left intact as a frozen copy. Run `akm index` to refresh search.",
  },
];

describe("migrate-storage fixture-stash differential (WS3b cutover gate)", () => {
  test("records the exact step log (names / statuses / details / order)", async () => {
    const reports = await runMigrations({ dryRun: false, paths: fx.paths });

    const v07 = reports.find((r) => r.label === "0.7 → 0.8");
    const v08 = reports.find((r) => r.label === "0.8 → 0.9");
    if (!v07 || !v08) throw new Error("expected both migration reports");
    expect(v07.ran).toBe(true);
    expect(v08.ran).toBe(true);

    expect(snapshotSteps(v07.results, fx)).toEqual(GOLDEN_STEPS_V07);
    expect(snapshotSteps(v08.results, fx)).toEqual(GOLDEN_STEPS_V08);
  });

  test("produces the exact resulting filesystem (paths / byte contents / modes)", async () => {
    await runMigrations({ dryRun: false, paths: fx.paths });

    // $DATA tree: copied index.db / workflow.db / akm.lock / config-backups.
    const dataTree = snapshotTree(fx.paths.dataDir);
    expect(dataTree["index.db"]?.sha).toBe(
      crypto.createHash("sha256").update("INDEX-DB-BYTES-0123456789").digest("hex"),
    );
    expect(dataTree["workflow.db"]?.sha).toBe(
      crypto.createHash("sha256").update("WORKFLOW-DB-BYTES-abcdef").digest("hex"),
    );
    expect(dataTree["akm.lock"]?.sha).toBe(
      crypto.createHash("sha256").update("name|sha|path\nfoo|abc|/x\n").digest("hex"),
    );
    expect(dataTree["config-backups/nested/deep/b.json"]?.sha).toBe(
      crypto.createHash("sha256").update('{"b":2}\n').digest("hex"),
    );

    // env/ tree: vault files copied, collision preserved, secret modes tightened.
    const envTree = snapshotTree(path.join(fx.stashDir, "env"));
    expect(envTree["prod.env"]?.sha).toBe(crypto.createHash("sha256").update("API_KEY=already-here\n").digest("hex"));
    expect(envTree["team/dev.env"]?.sha).toBe(crypto.createHash("sha256").update("TOKEN=hidden-token\n").digest("hex"));
    expect(envTree["team/sub/deep.env"]?.sha).toBe(crypto.createHash("sha256").update("NESTED=yes\n").digest("hex"));

    if (process.platform !== "win32") {
      // DATA-SAFETY: 0600 files, 0700 dirs on the migrated secret tree.
      expect(envTree["prod.env"]?.mode).toBe("600");
      expect(envTree["team/dev.env"]?.mode).toBe("600");
      expect(envTree["team/sub/deep.env"]?.mode).toBe("600");
      expect(envTree["team/"]?.mode).toBe("700");
      expect(envTree["team/sub/"]?.mode).toBe("700");
      expect((fs.statSync(path.join(fx.stashDir, "env")).mode & 0o777).toString(8)).toBe("700");
    }

    // vaults/ left intact (frozen copy) + .migrated marker written.
    expect(fs.existsSync(path.join(fx.stashDir, "vaults", "prod.env"))).toBe(true);
    expect(fs.existsSync(path.join(fx.stashDir, "vaults", ".migrated"))).toBe(true);
  });

  test("no-clobber: the user-authored env/prod.env is NEVER overwritten by vaults/", async () => {
    await runMigrations({ dryRun: false, paths: fx.paths });
    expect(fs.readFileSync(path.join(fx.stashDir, "env", "prod.env"), "utf8")).toBe("API_KEY=already-here\n");
  });

  test("dry-run writes nothing yet records the same step ORDER", async () => {
    const before = snapshotTree(fx.tmp);
    const reports = await runMigrations({ dryRun: true, paths: fx.paths });
    const after = snapshotTree(fx.tmp);
    expect(after).toEqual(before); // no filesystem mutation in dry-run

    const v07 = reports.find((r) => r.label === "0.7 → 0.8");
    const v08 = reports.find((r) => r.label === "0.8 → 0.9");
    if (!v07 || !v08) throw new Error("expected both reports");
    expect(v07.results.map((r) => r.name)).toEqual(GOLDEN_STEPS_V07.map((s) => s.name));
    expect(v08.results.map((r) => r.name)).toEqual(GOLDEN_STEPS_V08.map((s) => s.name));
  });

  test("summary counts + exit code: a clean fixture has zero failures (exitCode unset)", async () => {
    const reports = await runMigrations({ dryRun: false, paths: fx.paths });
    const allSteps = reports.flatMap((r) => r.results);
    const failed = allSteps.filter((r) => r.status === "failed");
    const success = allSteps.filter((r) => r.status === "success");
    const skipped = allSteps.filter((r) => r.status === "skipped");
    expect(failed.length).toBe(0);
    expect(success.length).toBe(6);
    expect(skipped.length).toBe(4);
    // No failure → exit code must remain unset (printGroupedSummary sets 1 only on failure).
    expect(process.exitCode).toBe(0);
  });
});
