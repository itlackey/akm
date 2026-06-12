import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  backupDataDir,
  isBackupDisabled,
  listBackups,
  measureDataDirSize,
  resolveRetention,
} from "../../src/indexer/db/db-backup";

// ── Temp directory management ────────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function tmpDir(label = "db-backup"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDataDir(label = "data"): string {
  const root = tmpDir(label);
  fs.writeFileSync(path.join(root, "index.db"), "fake-index-db-bytes");
  fs.writeFileSync(path.join(root, "workflow.db"), "fake-workflow-db");
  fs.writeFileSync(path.join(root, "state.db"), "fake-state-db");
  return root;
}

function freshEnv(): NodeJS.ProcessEnv {
  // Strip backup-related vars so each test starts from a clean baseline,
  // regardless of what the running shell sets.
  return { ...process.env, AKM_DB_BACKUP: undefined, AKM_DB_BACKUP_RETAIN: undefined };
}

beforeEach(() => {
  // Belt-and-braces: tests pass `env` explicitly to backupDataDir() so the
  // helper does not read process.env directly. Strip the env vars anyway so
  // that any future call path that forgets to inject `env` falls back to a
  // clean process.env state, and a test that sets one of these vars for its
  // own scope cannot leak into the next test.
  delete process.env.AKM_DB_BACKUP;
  delete process.env.AKM_DB_BACKUP_RETAIN;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("backupDataDir", () => {
  test("creates a timestamped backup directory with copies of all .db files", () => {
    const dataDir = makeDataDir();
    const result = backupDataDir({
      dataDir,
      sourceVersion: 16,
      targetVersion: 17,
      env: freshEnv(),
    });

    expect(result).not.toBeNull();
    if (!result) throw new Error("expected backupDataDir to return a result");
    expect(result.path.startsWith(path.join(dataDir, "backups"))).toBe(true);
    expect(result.name).toContain("pre-v17");
    expect(result.sourceVersion).toBe(16);
    expect(result.targetVersion).toBe(17);

    // Files should be copied 1:1.
    expect(fs.readFileSync(path.join(result.path, "index.db"), "utf8")).toBe("fake-index-db-bytes");
    expect(fs.existsSync(path.join(result.path, "workflow.db"))).toBe(true);
    expect(fs.existsSync(path.join(result.path, "state.db"))).toBe(true);

    // sizeBytes is the source size, not the destination size (avoids
    // recursing into our own freshly-written backup).
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  test("writes a backup.meta.json sidecar with sourceVersion, targetVersion, createdAt", () => {
    const dataDir = makeDataDir();
    const result = backupDataDir({
      dataDir,
      sourceVersion: 16,
      targetVersion: 17,
      env: freshEnv(),
    });

    expect(result).not.toBeNull();
    if (!result) throw new Error("expected backupDataDir to return a result");
    const metaPath = path.join(result.path, "backup.meta.json");
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    expect(meta.sourceVersion).toBe(16);
    expect(meta.targetVersion).toBe(17);
    expect(typeof meta.createdAt).toBe("string");
    expect(meta.schemaVersion).toBe(1);
  });

  test("does not recurse into the backups/ subdirectory", () => {
    const dataDir = makeDataDir();
    // Pre-seed an old backup so the second backup would copy it if we weren't
    // skipping the backups dir.
    const firstRun = backupDataDir({ dataDir, sourceVersion: 16, targetVersion: 17, env: freshEnv() });
    expect(firstRun).not.toBeNull();
    if (!firstRun) throw new Error("expected first backupDataDir to return a result");
    fs.writeFileSync(path.join(firstRun.path, "marker.txt"), "noise");

    // Run again with a different stamp.
    const secondRun = backupDataDir({
      dataDir,
      sourceVersion: 16,
      targetVersion: 17,
      env: freshEnv(),
      now: () => new Date("2099-01-01T00:00:00Z"),
    });
    expect(secondRun).not.toBeNull();
    if (!secondRun) throw new Error("expected second backupDataDir to return a result");
    expect(fs.existsSync(path.join(secondRun.path, "backups"))).toBe(false);
  });

  test("honors AKM_DB_BACKUP=0 opt-out and returns null without writing", () => {
    const dataDir = makeDataDir();
    const result = backupDataDir({
      dataDir,
      sourceVersion: 16,
      targetVersion: 17,
      env: { ...freshEnv(), AKM_DB_BACKUP: "0" },
    });
    expect(result).toBeNull();
    expect(fs.existsSync(path.join(dataDir, "backups"))).toBe(false);
  });

  test("disk-space check skips the backup when free space is insufficient", () => {
    const dataDir = makeDataDir();
    // Stub fs.statfsSync to claim there's only a single byte free, which is
    // well under 1.1× the source size.
    const original = (fs as unknown as { statfsSync?: unknown }).statfsSync;
    (fs as unknown as { statfsSync: unknown }).statfsSync = () => ({ bavail: 1n, bsize: 1n });

    try {
      const result = backupDataDir({
        dataDir,
        sourceVersion: 16,
        targetVersion: 17,
        env: freshEnv(),
      });
      expect(result).toBeNull();
      // The backups dir may have been created (we mkdir before checking
      // free space) but no actual snapshot directory should exist inside.
      if (fs.existsSync(path.join(dataDir, "backups"))) {
        const entries = fs.readdirSync(path.join(dataDir, "backups"), { withFileTypes: true });
        const snapshotDirs = entries.filter((e) => e.isDirectory());
        expect(snapshotDirs.length).toBe(0);
      }
    } finally {
      if (original === undefined) {
        delete (fs as unknown as { statfsSync?: unknown }).statfsSync;
      } else {
        (fs as unknown as { statfsSync: unknown }).statfsSync = original;
      }
    }
  });

  test("retention: keeps only the N newest backups when AKM_DB_BACKUP_RETAIN=N", () => {
    const dataDir = makeDataDir();
    const env = { ...freshEnv(), AKM_DB_BACKUP_RETAIN: "3" };
    // resolveRetention reads env directly inside pruneOldBackups, so we also
    // set it on process.env for that read path.
    process.env.AKM_DB_BACKUP_RETAIN = "3";

    try {
      // Create 6 backups, each with a distinct timestamp so listBackups can
      // sort them deterministically.
      for (let i = 0; i < 6; i += 1) {
        const stampDate = new Date(Date.UTC(2030, 0, 1 + i, 0, 0, 0));
        const result = backupDataDir({
          dataDir,
          sourceVersion: 16,
          targetVersion: 17,
          env,
          now: () => stampDate,
        });
        expect(result).not.toBeNull();
      }

      const remaining = listBackups(dataDir);
      expect(remaining.length).toBe(3);
      // The remaining backups should be the 3 newest (2030-01-04, 05, 06).
      const names = remaining.map((b) => b.name).sort();
      // newest first sort means the listed order is descending; sort for stable check
      expect(names.some((n) => n.includes("2030-01-06"))).toBe(true);
      expect(names.some((n) => n.includes("2030-01-05"))).toBe(true);
      expect(names.some((n) => n.includes("2030-01-04"))).toBe(true);
      expect(names.some((n) => n.includes("2030-01-01"))).toBe(false);
    } finally {
      delete process.env.AKM_DB_BACKUP_RETAIN;
    }
  });

  test("returns null when the data directory does not exist (fresh install)", () => {
    const ghost = path.join(tmpDir("ghost"), "nonexistent");
    const result = backupDataDir({
      dataDir: ghost,
      sourceVersion: 16,
      targetVersion: 17,
      env: freshEnv(),
    });
    expect(result).toBeNull();
  });

  test("returns null when the data directory is empty (only contains backups/)", () => {
    const dataDir = tmpDir("empty");
    fs.mkdirSync(path.join(dataDir, "backups"), { recursive: true });
    // Some stale prior backup inside — but the dir itself is otherwise empty
    // (no live files to snapshot).
    const result = backupDataDir({
      dataDir,
      sourceVersion: 16,
      targetVersion: 17,
      env: freshEnv(),
    });
    expect(result).toBeNull();
  });

  test("disambiguates colliding backup directory names", () => {
    const dataDir = makeDataDir();
    const fixedNow = () => new Date("2027-06-15T12:00:00Z");

    const first = backupDataDir({
      dataDir,
      sourceVersion: 16,
      targetVersion: 17,
      env: freshEnv(),
      now: fixedNow,
    });
    const second = backupDataDir({
      dataDir,
      sourceVersion: 16,
      targetVersion: 17,
      env: freshEnv(),
      now: fixedNow,
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.path).not.toBe(second?.path);
  });

  test("skips akm.lock and akm.lock.lck in the copy", () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, "akm.lock"), "live-lock-pid");
    fs.writeFileSync(path.join(dataDir, "akm.lock.lck"), "sentinel");

    const result = backupDataDir({
      dataDir,
      sourceVersion: 16,
      targetVersion: 17,
      env: freshEnv(),
    });
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected backupDataDir to return a result");
    expect(fs.existsSync(path.join(result.path, "akm.lock"))).toBe(false);
    expect(fs.existsSync(path.join(result.path, "akm.lock.lck"))).toBe(false);
  });
});

describe("listBackups", () => {
  test("returns an empty array when no backups exist", () => {
    const dataDir = makeDataDir();
    expect(listBackups(dataDir)).toEqual([]);
  });

  test("returns the JSON shape contract: path, name, createdAt, sizeBytes, sourceVersion", () => {
    const dataDir = makeDataDir();
    const created = backupDataDir({
      dataDir,
      sourceVersion: 16,
      targetVersion: 17,
      env: freshEnv(),
    });
    expect(created).not.toBeNull();

    const listed = listBackups(dataDir);
    expect(listed.length).toBe(1);
    const entry = listed[0];
    if (entry === undefined) throw new Error("expected at least one backup entry");
    expect(typeof entry.path).toBe("string");
    expect(typeof entry.name).toBe("string");
    expect(typeof entry.createdAt).toBe("string");
    expect(typeof entry.sizeBytes).toBe("number");
    expect(entry.sourceVersion).toBe(16);
  });

  test("sorts newest first by createdAt", () => {
    const dataDir = makeDataDir();
    const env = freshEnv();
    backupDataDir({
      dataDir,
      sourceVersion: 16,
      targetVersion: 17,
      env,
      now: () => new Date("2025-01-01T00:00:00Z"),
    });
    backupDataDir({
      dataDir,
      sourceVersion: 16,
      targetVersion: 17,
      env,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const listed = listBackups(dataDir);
    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(listed[0]?.createdAt > listed[1]?.createdAt).toBe(true);
  });
});

describe("helpers", () => {
  test("isBackupDisabled honors common falsy strings", () => {
    expect(isBackupDisabled({})).toBe(false);
    expect(isBackupDisabled({ AKM_DB_BACKUP: "" })).toBe(false);
    expect(isBackupDisabled({ AKM_DB_BACKUP: "1" })).toBe(false);
    expect(isBackupDisabled({ AKM_DB_BACKUP: "0" })).toBe(true);
    expect(isBackupDisabled({ AKM_DB_BACKUP: "false" })).toBe(true);
    expect(isBackupDisabled({ AKM_DB_BACKUP: "OFF" })).toBe(true);
    expect(isBackupDisabled({ AKM_DB_BACKUP: "no" })).toBe(true);
  });

  test("resolveRetention defaults to 5 and respects valid overrides", () => {
    expect(resolveRetention({})).toBe(5);
    expect(resolveRetention({ AKM_DB_BACKUP_RETAIN: "10" })).toBe(10);
    expect(resolveRetention({ AKM_DB_BACKUP_RETAIN: "1" })).toBe(1);
  });

  test("resolveRetention falls back on invalid values", () => {
    expect(resolveRetention({ AKM_DB_BACKUP_RETAIN: "abc" })).toBe(5);
    expect(resolveRetention({ AKM_DB_BACKUP_RETAIN: "0" })).toBe(5);
    expect(resolveRetention({ AKM_DB_BACKUP_RETAIN: "-1" })).toBe(5);
  });

  test("measureDataDirSize skips the backups subdir", () => {
    const dataDir = makeDataDir();
    const baseline = measureDataDirSize(dataDir);
    // Write a fat file inside backups/ that should NOT be counted.
    fs.mkdirSync(path.join(dataDir, "backups", "noise"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "backups", "noise", "big"), "x".repeat(10_000));
    const after = measureDataDirSize(dataDir);
    expect(after).toBe(baseline);
  });
});
