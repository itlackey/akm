/**
 * Tests for scripts/migrate-storage.ts versioned migration runner.
 *
 * Exercises the runMigrations() entry point in --dry-run mode against a
 * synthetic XDG layout. We assert that each version reports the expected
 * step results.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MIGRATIONS, type ResolvedPaths, runMigrations } from "../scripts/migrate-storage";

function makeTmpLayout(): { tmp: string; paths: ResolvedPaths } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akm-migrate-test-"));
  const cacheDir = path.join(tmp, "cache");
  const configDir = path.join(tmp, "config");
  const dataDir = path.join(tmp, "data");
  const stateDir = path.join(tmp, "state");
  for (const d of [cacheDir, configDir, dataDir, stateDir]) fs.mkdirSync(d, { recursive: true });
  return {
    tmp,
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

let layout: { tmp: string; paths: ResolvedPaths };

beforeEach(() => {
  layout = makeTmpLayout();
});

afterEach(() => {
  fs.rmSync(layout.tmp, { recursive: true, force: true });
});

describe("migrate-storage versioned runner", () => {
  test("registers 0.7→0.8 and 0.8→0.9 migrations", () => {
    expect(MIGRATIONS.map((m) => m.label)).toEqual(["0.7 → 0.8", "0.8 → 0.9"]);
  });

  test("dry-run on a populated 0.7 layout reports all 0.7→0.8 steps as success or skip", async () => {
    const { paths } = layout;

    // Populate legacy 0.7 sources.
    fs.mkdirSync(path.join(paths.cacheDir, "tasks", "history"), { recursive: true });
    fs.mkdirSync(path.join(paths.cacheDir, "registry-index"), { recursive: true });
    fs.mkdirSync(path.join(paths.cacheDir, "config-backups"), { recursive: true });
    fs.writeFileSync(path.join(paths.cacheDir, "index.db"), "fake");
    fs.writeFileSync(path.join(paths.cacheDir, "workflow.db"), "fake");
    fs.writeFileSync(path.join(paths.cacheDir, "events.jsonl"), '{"a":1}\n');
    const historyLine = `${JSON.stringify({
      id: "t1",
      status: "ok",
      startedAt: "2024-01-01T00:00:00Z",
      finishedAt: "2024-01-01T00:00:05Z",
      durationMs: 5000,
      log: "/tmp/log",
      target: { kind: "workflow", ref: "foo" },
    })}\n`;
    fs.writeFileSync(path.join(paths.cacheDir, "tasks", "history", "2024-01.jsonl"), historyLine);
    fs.writeFileSync(path.join(paths.configDir, "akm.lock"), "lock");
    fs.writeFileSync(path.join(paths.cacheDir, "config-backups", "f.txt"), "b");
    fs.writeFileSync(path.join(paths.cacheDir, "registry-index", "old.json"), "{}");

    const reports = await runMigrations({ dryRun: true, paths });
    expect(reports.length).toBe(2);

    const v07 = reports.find((r) => r.label === "0.7 → 0.8");
    if (!v07) throw new Error("expected 0.7 → 0.8 report");
    expect(v07.ran).toBe(true);

    const stepNames = v07.results.map((r) => r.name);
    expect(stepNames).toContain("index.db");
    expect(stepNames).toContain("workflow.db");
    expect(stepNames).toContain("events.jsonl → state.db");
    expect(stepNames).toContain("tasks/history/");
    expect(stepNames).toContain("akm.lock");
    expect(stepNames).toContain("config-backups/");
    expect(stepNames).toContain("tasks/history/ → state.db");
    expect(stepNames).toContain("registry-index/ (note)");

    // In dry-run mode every reachable step should be "success" (with a
    // [dry-run] prefix) — nothing should fail because no files are mutated.
    const failed = v07.results.filter((r) => r.status === "failed");
    expect(failed).toEqual([]);
  });

  test("0.7→0.8 isNeeded returns false on a clean layout", async () => {
    const reports = await runMigrations({ dryRun: true, paths: layout.paths });
    const v07 = reports.find((r) => r.label === "0.7 → 0.8");
    if (!v07) throw new Error("expected 0.7 → 0.8 report");
    expect(v07.ran).toBe(false);
  });

  test("0.8→0.9 always runs and records a skip when no legacy graph file exists", async () => {
    const reports = await runMigrations({ dryRun: true, paths: layout.paths });
    const v08 = reports.find((r) => r.label === "0.8 → 0.9");
    if (!v08) throw new Error("expected 0.8 → 0.9 report");
    expect(v08.ran).toBe(true);
    expect(v08.results.length).toBe(2);
    const first = v08.results[0];
    if (!first) throw new Error("expected at least one step result");
    expect(first.name).toBe("Graph snapshot import");
    expect(first.status).toBe("skipped");
    expect(first.detail).toContain("no legacy graph file found");
    // The vaults/ → env/ step also runs; with no vaults/ under the (isolated)
    // stash it records a skip.
    const vaultStep = v08.results.find((r) => r.name === "vaults/ → env/");
    if (!vaultStep) throw new Error("expected a vaults/ → env/ step result");
    expect(vaultStep.status).toBe("skipped");
  });

  test("0.8→0.9 detects a graph-snapshot.json and reports the dry-run step", async () => {
    const { paths } = layout;
    // Put a legacy graph snapshot in $CACHE/graph-snapshot.json (one of the
    // conventional candidate paths).
    fs.writeFileSync(
      path.join(paths.cacheDir, "graph-snapshot.json"),
      JSON.stringify({
        schemaVersion: 2,
        generatedAt: "2024-01-01T00:00:00Z",
        stashRoot: "/tmp/stash",
        files: [
          {
            path: "knowledge/a.md",
            type: "knowledge",
            bodyHash: "abc",
            entities: ["E1"],
            relations: [{ from: "E1", to: "E2", type: "related" }],
          },
        ],
      }),
    );

    // No index.db at $DATA — step should report it cannot import.
    const reports = await runMigrations({ dryRun: true, paths });
    const v08 = reports.find((r) => r.label === "0.8 → 0.9");
    if (!v08) throw new Error("expected 0.8 → 0.9 report");
    expect(v08.ran).toBe(true);
    const step = v08.results[0];
    if (!step) throw new Error("expected at least one step result");
    expect(step.name).toBe("Graph snapshot import");
    // In dry-run, the index.db existence check runs first and short-circuits.
    expect(step.status).toBe("skipped");
    expect(step.detail).toContain("index.db not found");

    // Now create an empty index.db file so the existence check passes.
    fs.writeFileSync(paths.indexDbPath, "");
    const reports2 = await runMigrations({ dryRun: true, paths });
    const v08b = reports2.find((r) => r.label === "0.8 → 0.9");
    if (!v08b) throw new Error("expected 0.8 → 0.9 report on second run");
    const step2 = v08b.results[0];
    if (!step2) throw new Error("expected at least one step result on second run");
    expect(step2.status).toBe("success");
    expect(step2.detail).toContain("[dry-run]");
    expect(step2.detail).toContain("graph-snapshot.json");
  });

  describe("vaults/ → env/ migration", () => {
    function writeStashConfig(stashDir: string): void {
      fs.writeFileSync(path.join(layout.paths.configDir, "config.json"), JSON.stringify({ stashDir }), "utf8");
    }

    function vaultStep(reports: Awaited<ReturnType<typeof runMigrations>>) {
      const v08 = reports.find((r) => r.label === "0.8 → 0.9");
      if (!v08) throw new Error("expected 0.8 → 0.9 report");
      const step = v08.results.find((r) => r.name === "vaults/ → env/");
      if (!step) throw new Error("expected a vaults/ → env/ step");
      return step;
    }

    test("copies .env files vaults/ → env/, sets 0600/0700, and writes the .migrated marker", async () => {
      const stashDir = path.join(layout.tmp, "stash");
      fs.mkdirSync(path.join(stashDir, "vaults", "team"), { recursive: true });
      fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "API_KEY=secret\n", { mode: 0o644 });
      fs.writeFileSync(path.join(stashDir, "vaults", "team", "dev.env"), "TOKEN=hidden\n", { mode: 0o644 });
      writeStashConfig(stashDir);

      const step = vaultStep(await runMigrations({ dryRun: false, paths: layout.paths }));
      expect(step.status).toBe("success");

      // Files copied into env/, preserving subdirs.
      expect(fs.readFileSync(path.join(stashDir, "env", "prod.env"), "utf8")).toBe("API_KEY=secret\n");
      expect(fs.readFileSync(path.join(stashDir, "env", "team", "dev.env"), "utf8")).toBe("TOKEN=hidden\n");

      // Permissions tightened despite the 0644 source mode.
      if (process.platform !== "win32") {
        expect(fs.statSync(path.join(stashDir, "env", "prod.env")).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.join(stashDir, "env")).mode & 0o777).toBe(0o700);
      }

      // vaults/ left intact as a frozen copy + marker written.
      expect(fs.existsSync(path.join(stashDir, "vaults", "prod.env"))).toBe(true);
      expect(fs.existsSync(path.join(stashDir, "vaults", ".migrated"))).toBe(true);
    });

    test("is idempotent — a second run skips on the .migrated marker", async () => {
      const stashDir = path.join(layout.tmp, "stash");
      fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
      fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "API_KEY=secret\n");
      writeStashConfig(stashDir);

      expect(vaultStep(await runMigrations({ dryRun: false, paths: layout.paths })).status).toBe("success");
      const second = vaultStep(await runMigrations({ dryRun: false, paths: layout.paths }));
      expect(second.status).toBe("skipped");
      expect(second.detail).toContain(".migrated");
    });

    test("never clobbers an env file the user already authored", async () => {
      const stashDir = path.join(layout.tmp, "stash");
      fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
      fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
      fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "API_KEY=from-vault\n");
      fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "API_KEY=already-here\n");
      writeStashConfig(stashDir);

      expect(vaultStep(await runMigrations({ dryRun: false, paths: layout.paths })).status).toBe("success");
      // The pre-existing env/ file is preserved, not overwritten by vaults/.
      expect(fs.readFileSync(path.join(stashDir, "env", "prod.env"), "utf8")).toBe("API_KEY=already-here\n");
    });

    test("skips a stash whose vaults/ has no .env files (fresh install)", async () => {
      const stashDir = path.join(layout.tmp, "stash");
      fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
      writeStashConfig(stashDir);

      const step = vaultStep(await runMigrations({ dryRun: false, paths: layout.paths }));
      expect(step.status).toBe("skipped");
      expect(fs.existsSync(path.join(stashDir, "vaults", ".migrated"))).toBe(false);
    });
  });
});
