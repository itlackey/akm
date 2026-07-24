// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  captureInstallationSnapshot,
  materializeInstallationSnapshot,
  normalizedMaterializedDatabaseFingerprint,
  verifyInstallationSnapshot,
} from "../../scripts/akm-eval/src/sources/installation-snapshot";
import { openStateDatabase } from "../../src/core/state-db";
import type { Database as StorageDatabase } from "../../src/storage/database";
import { openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { makeSandboxDir } from "../_helpers/sandbox";

interface Fixture {
  bundleRoots: Record<string, string>;
  configPath: string;
  dataDir: string;
  databases: StorageDatabase[];
}

function configFor(fixture: Fixture, workspace = path.join(fixture.bundleRoots.personal ?? "", "workspace")) {
  return {
    configVersion: "0.9.0",
    defaultBundle: "personal",
    bundles: {
      personal: { path: fixture.bundleRoots.personal, writable: true },
      team: { git: "https://example.test/team.git" },
    },
    engines: {
      runner: { kind: "agent", platform: "opencode", workspace },
    },
  };
}

function writeConfig(fixture: Fixture, config: unknown = configFor(fixture)): void {
  fs.writeFileSync(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(fixture.configPath, 0o600);
}

function createAkmDatabase(filePath: string, kind: "state" | "index", value: string): StorageDatabase {
  const database = kind === "state" ? openStateDatabase(filePath) : openIndexDatabase(filePath);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  database.exec("CREATE TABLE snapshot_probe (value TEXT)");
  database.prepare("INSERT INTO snapshot_probe (value) VALUES (?)").run(value);
  return database;
}

function createFixture(
  root: string,
  options: { configInsideBundle?: boolean; dataInsideBundle?: boolean } = {},
): Fixture {
  const personal = path.join(root, "personal");
  const team = path.join(root, "team");
  const dataDir = options.dataInsideBundle ? path.join(personal, "source-data") : path.join(root, "source-data");
  const configPath = options.configInsideBundle
    ? path.join(personal, "source-config.jsonc")
    : path.join(root, "source-config.jsonc");
  fs.mkdirSync(path.join(personal, "memories"), { recursive: true });
  fs.mkdirSync(path.join(personal, "workspace"), { recursive: true });
  fs.mkdirSync(path.join(personal, "env"), { recursive: true });
  fs.mkdirSync(path.join(personal, "secrets"), { recursive: true });
  fs.mkdirSync(path.join(personal, ".env.local"), { recursive: true });
  fs.mkdirSync(path.join(team, "skills"), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(personal, "memories", "preference.md"), "frozen preference\n", { mode: 0o600 });
  fs.writeFileSync(path.join(personal, "workspace", "brief.md"), "workspace input\n", { mode: 0o600 });
  fs.writeFileSync(path.join(team, "skills", "review.md"), "review instructions\n", { mode: 0o600 });
  fs.writeFileSync(
    path.join(dataDir, "akm.lock"),
    `${JSON.stringify([{ id: "team", source: "git", ref: "https://private.example.test/team.git", localRoot: team }])}\n`,
  );
  fs.writeFileSync(path.join(dataDir, "logs.db"), "excluded logs\n");
  fs.writeFileSync(path.join(dataDir, "random.json"), "excluded arbitrary data\n");
  fs.mkdirSync(path.join(dataDir, "backups"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "txns"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "locks"), { recursive: true });
  for (const directory of [
    personal,
    path.join(personal, "memories"),
    path.join(personal, "workspace"),
    path.join(personal, "env"),
    path.join(personal, "secrets"),
    path.join(personal, ".env.local"),
    team,
    path.join(team, "skills"),
    dataDir,
  ]) {
    fs.chmodSync(directory, 0o700);
  }

  const fixture: Fixture = { bundleRoots: { personal, team }, configPath, dataDir, databases: [] };
  writeConfig(fixture);
  fixture.databases.push(
    createAkmDatabase(path.join(dataDir, "state.db"), "state", "state-in-wal"),
    createAkmDatabase(path.join(dataDir, "index.db"), "index", "index-in-wal"),
  );
  for (const name of ["state.db", "state.db-wal", "state.db-shm", "index.db", "index.db-wal", "index.db-shm"]) {
    const filePath = path.join(dataDir, name);
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
  }
  return fixture;
}

function capture(fixture: Fixture, destinationDir: string) {
  return captureInstallationSnapshot({
    destinationDir,
    bundleRoots: fixture.bundleRoots,
    defaultBundle: "personal",
    configPath: fixture.configPath,
    dataDir: fixture.dataDir,
    producer: { version: "0.9.0-rc.10", commit: "abc123" },
  });
}

function closeFixture(fixture: Fixture): void {
  for (const database of fixture.databases.splice(0)) database.close();
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalize(record[key])]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stagingEntries(parent: string, destinationName: string): string[] {
  return fs.readdirSync(parent).filter((name) => name.startsWith(`.${destinationName}.staging-`));
}

function rewriteSnapshotConfig(snapshotDir: string, mutate: (config: Record<string, unknown>) => void): void {
  const configPath = path.join(snapshotDir, "config", "config.json");
  const manifestPath = path.join(snapshotDir, "manifest.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  mutate(config);
  const configBytes = Buffer.from(`${JSON.stringify(canonicalize(config), null, 2)}\n`, "utf8");
  fs.writeFileSync(configPath, configBytes);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown> & {
    entries: Array<Record<string, unknown>>;
  };
  const configEntry = manifest.entries.find((entry) => entry.path === "config/config.json");
  if (!configEntry) throw new Error("fixture manifest is missing config entry");
  configEntry.byteSize = configBytes.byteLength;
  configEntry.sha256 = sha256(configBytes);
  configEntry.mtimeMs = fs.statSync(configPath).mtimeMs;
  manifest.configFingerprint = configEntry.sha256;
  const { snapshotFingerprint: _, ...unsigned } = manifest;
  manifest.snapshotFingerprint = sha256(canonicalJson(unsigned));
  fs.writeFileSync(manifestPath, canonicalJson(manifest));
}

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("akm-eval installation snapshots", () => {
  test("captures real AKM WAL databases and materializes private isolated state", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot");
    const fixture = createFixture(sandbox.dir);
    const snapshotDir = path.join(sandbox.dir, "snapshot");
    const destinationRoot = path.join(sandbox.dir, "materialized");
    try {
      const sourceAsset = path.join(fixture.bundleRoots.personal ?? "", "memories", "preference.md");
      const causalMtimeMs = Date.parse("2025-03-04T05:06:07.000Z");
      fs.utimesSync(sourceAsset, causalMtimeMs / 1000, causalMtimeMs / 1000);
      const state = fixture.databases[0];
      state
        ?.prepare(
          `INSERT INTO proposals
           (id, stash_dir, ref, status, source, created_at, updated_at, content, metadata_json)
         VALUES ('snapshot-proposal', ?, 'personal//memories/preference', 'pending', 'reflect',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'content', '{}')`,
        )
        .run(fixture.bundleRoots.personal ?? "");
      state
        ?.prepare(
          `INSERT INTO proposal_fingerprints
           (stash_dir, fingerprint, ref, source, created_at)
         VALUES (?, 'snapshot-fingerprint', 'personal//memories/preference', 'reflect',
                 '2026-01-01T00:00:00.000Z')`,
        )
        .run(fixture.bundleRoots.personal ?? "");
      state
        ?.prepare(
          `INSERT INTO improve_runs
           (id, started_at, stash_dir, dry_run, scope_mode, ok, result_json)
         VALUES ('snapshot-run', '2026-01-01T00:00:00.000Z', ?, 0, 'all', 1, '{}')`,
        )
        .run(fixture.bundleRoots.personal ?? "");
      state
        ?.prepare(
          `INSERT INTO events (event_type, ts, metadata_json)
         VALUES ('promoted', '2026-01-01T00:00:00.000Z', ?)`,
        )
        .run(JSON.stringify({ assetPath: sourceAsset }));
      expect(fs.existsSync(path.join(fixture.dataDir, "state.db-wal"))).toBe(true);
      const manifest = capture(fixture, snapshotDir);

      expect(verifyInstallationSnapshot(snapshotDir)).toEqual(manifest);
      expect(manifest.entries.map((entry) => entry.path)).toEqual(
        [...manifest.entries.map((entry) => entry.path)].sort(),
      );
      expect(manifest.entries.filter((entry) => entry.kind === "data").map((entry) => String(entry.path))).toEqual([
        "data/index.db",
        "data/state.db",
      ]);
      expect(
        manifest.entries.some((entry) => /(?:^|\/)(?:env|secrets)(?:\/|$)|(?:^|\/)\.env(?:\.|$)/.test(entry.path)),
      ).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, "data", "logs.db"))).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, "data", "random.json"))).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, "data", "akm.lock"))).toBe(false);
      const sourceAssetEntry = manifest.entries.find((entry) => entry.path.endsWith("/memories/preference.md"));
      expect(sourceAssetEntry?.mtimeMs).toBe(causalMtimeMs);
      expect(fs.statSync(path.join(snapshotDir, sourceAssetEntry?.path ?? "missing")).mtimeMs).toBe(causalMtimeMs);

      const snapshotConfig = JSON.parse(fs.readFileSync(path.join(snapshotDir, "config", "config.json"), "utf8")) as {
        bundles: Record<string, { path?: string; git?: string; writable?: boolean }>;
      };
      expect(snapshotConfig.bundles.personal).toEqual({
        path: manifest.bundleRoots.personal,
        writable: true,
      });
      expect(snapshotConfig.bundles.team).toEqual({ path: manifest.bundleRoots.team, writable: false });
      expect(JSON.stringify(snapshotConfig)).not.toContain(fixture.bundleRoots.personal);
      expect(JSON.stringify(snapshotConfig)).not.toContain("https://example.test/team.git");

      for (const [databaseName, expectedValue] of [
        ["state.db", "state-in-wal"],
        ["index.db", "index-in-wal"],
      ] as const) {
        const database = new Database(path.join(snapshotDir, "data", databaseName), { readonly: true, create: false });
        try {
          expect(database.query<{ value: string }, []>("SELECT value FROM snapshot_probe").get()?.value).toBe(
            expectedValue,
          );
          expect(database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check).toBe("ok");
        } finally {
          database.close();
        }
      }

      const snapshotState = new Database(path.join(snapshotDir, "data", "state.db"), {
        readonly: true,
        create: false,
      });
      try {
        const canonicalRoot = manifest.bundleRoots.personal;
        expect(snapshotState.query("SELECT stash_dir FROM proposals WHERE id = 'snapshot-proposal'").get()).toEqual({
          stash_dir: canonicalRoot,
        });
        expect(
          snapshotState
            .query("SELECT stash_dir FROM proposal_fingerprints WHERE fingerprint = 'snapshot-fingerprint'")
            .get(),
        ).toEqual({ stash_dir: canonicalRoot });
        expect(snapshotState.query("SELECT stash_dir FROM improve_runs WHERE id = 'snapshot-run'").get()).toEqual({
          stash_dir: canonicalRoot,
        });
        const event = snapshotState.query("SELECT metadata_json FROM events WHERE event_type = 'promoted'").get() as {
          metadata_json: string;
        };
        expect(JSON.parse(event.metadata_json)).toEqual({ assetPath: `${canonicalRoot}/memories/preference.md` });
      } finally {
        snapshotState.close();
      }

      const installation = materializeInstallationSnapshot(snapshotDir, destinationRoot);
      const secondInstallation = materializeInstallationSnapshot(snapshotDir, path.join(sandbox.dir, "material-two"));
      expect(normalizedMaterializedDatabaseFingerprint(installation, manifest)).toBe(
        normalizedMaterializedDatabaseFingerprint(secondInstallation, manifest),
      );
      const materializedConfig = JSON.parse(fs.readFileSync(installation.configPath, "utf8")) as {
        bundles: Record<string, { path?: string; git?: string; writable?: boolean }>;
        engines: Record<string, { workspace?: string }>;
      };
      expect(materializedConfig.bundles.personal).toMatchObject({
        path: installation.bundleRoots.personal,
        writable: true,
      });
      expect(materializedConfig.bundles.team).toMatchObject({ path: installation.bundleRoots.team, writable: false });
      expect(materializedConfig.bundles.team?.git).toBeUndefined();
      expect(materializedConfig.engines.runner?.workspace).toBe(
        path.join(installation.bundleRoots.personal ?? "", "workspace"),
      );
      expect(installation.env.AKM_STASH_DIR).toBe(installation.bundleRoots.personal);
      expect(fs.statSync(path.join(installation.bundleRoots.personal ?? "", "memories", "preference.md")).mtimeMs).toBe(
        causalMtimeMs,
      );
      const materializedState = new Database(path.join(installation.dataDir, "state.db"), {
        readonly: true,
        create: false,
      });
      try {
        const materializedRoot = installation.bundleRoots.personal;
        expect(materializedState.query("SELECT stash_dir FROM proposals WHERE id = 'snapshot-proposal'").get()).toEqual(
          {
            stash_dir: materializedRoot,
          },
        );
        expect(
          materializedState
            .query("SELECT stash_dir FROM proposal_fingerprints WHERE fingerprint = 'snapshot-fingerprint'")
            .get(),
        ).toEqual({ stash_dir: materializedRoot });
        expect(materializedState.query("SELECT stash_dir FROM improve_runs WHERE id = 'snapshot-run'").get()).toEqual({
          stash_dir: materializedRoot,
        });
        const event = materializedState
          .query("SELECT metadata_json FROM events WHERE event_type = 'promoted'")
          .get() as {
          metadata_json: string;
        };
        expect(JSON.parse(event.metadata_json)).toEqual({
          assetPath: path.join(materializedRoot ?? "", "memories", "preference.md"),
        });
      } finally {
        materializedState.close();
      }
      for (const key of [
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "AKM_STASH_DIR",
        "AKM_CONFIG_DIR",
        "AKM_DATA_DIR",
        "AKM_CACHE_DIR",
        "AKM_STATE_DIR",
      ]) {
        expect(path.isAbsolute(installation.env[key] ?? "")).toBe(true);
        expect((installation.env[key] ?? "").startsWith(`${destinationRoot}${path.sep}`)).toBe(true);
      }
      if (process.platform !== "win32") {
        expect(fs.statSync(path.join(snapshotDir, "manifest.json")).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.join(snapshotDir, "bundles")).mode & 0o777).toBe(0o700);
        expect(
          fs.statSync(path.join(installation.bundleRoots.personal ?? "", "memories", "preference.md")).mode & 0o777,
        ).toBe(0o600);
      }
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("rejects changed bytes and non-canonical manifests", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-tamper");
    const fixture = createFixture(sandbox.dir);
    const snapshotDir = path.join(sandbox.dir, "snapshot");
    try {
      const manifest = capture(fixture, snapshotDir);
      const bundleEntry = manifest.entries.find((entry) => entry.kind === "bundle");
      expect(bundleEntry).toBeDefined();
      fs.appendFileSync(path.join(snapshotDir, ...(bundleEntry?.path.split("/") ?? [])), "tampered");
      expect(() => verifyInstallationSnapshot(snapshotDir)).toThrow(/fingerprint mismatch/);

      fs.writeFileSync(
        path.join(snapshotDir, "manifest.json"),
        `${JSON.stringify(JSON.parse(fs.readFileSync(path.join(snapshotDir, "manifest.json"), "utf8")), null, 2)}\n`,
        { mode: 0o600 },
      );
      expect(() => verifyInstallationSnapshot(snapshotDir)).toThrow(/not canonical JSON/);
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("rejects unknown manifest and entry keys even when JSON is canonical", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-strict-manifest");
    const fixture = createFixture(sandbox.dir);
    const snapshotDir = path.join(sandbox.dir, "snapshot");
    try {
      capture(fixture, snapshotDir);
      const manifestPath = path.join(snapshotDir, "manifest.json");
      const original = fs.readFileSync(manifestPath, "utf8");
      const oldSchema = JSON.parse(original) as Record<string, unknown>;
      oldSchema.schemaVersion = 1;
      const { snapshotFingerprint: _oldFingerprint, ...oldUnsigned } = oldSchema;
      oldSchema.snapshotFingerprint = sha256(canonicalJson(oldUnsigned));
      fs.writeFileSync(manifestPath, canonicalJson(oldSchema));
      expect(() => verifyInstallationSnapshot(snapshotDir)).toThrow(/unsupported snapshot manifest schemaVersion/);

      const withUnknownManifestKey = JSON.parse(original) as Record<string, unknown>;
      withUnknownManifestKey.unhashed = "not-covered";
      fs.writeFileSync(manifestPath, canonicalJson(withUnknownManifestKey));
      expect(() => verifyInstallationSnapshot(snapshotDir)).toThrow(/invalid keys.*unhashed/);

      const withUnknownEntryKey = JSON.parse(original) as { entries: Array<Record<string, unknown>> };
      const firstEntry = withUnknownEntryKey.entries[0];
      if (!firstEntry) throw new Error("fixture manifest has no entries");
      firstEntry.unhashed = "not-covered";
      fs.writeFileSync(manifestPath, canonicalJson(withUnknownEntryKey));
      expect(() => verifyInstallationSnapshot(snapshotDir)).toThrow(/manifest entry has invalid keys.*unhashed/);
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("produces the same fingerprint for equivalent config key order", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-reproducible-config");
    const fixture = createFixture(sandbox.dir);
    try {
      const configMtimeMs = Date.parse("2025-04-05T06:07:08.000Z");
      fs.utimesSync(fixture.configPath, configMtimeMs / 1000, configMtimeMs / 1000);
      const first = capture(fixture, path.join(sandbox.dir, "first"));
      const config = configFor(fixture);
      writeConfig(fixture, {
        engines: config.engines,
        bundles: { team: config.bundles.team, personal: config.bundles.personal },
        defaultBundle: config.defaultBundle,
        configVersion: config.configVersion,
      });
      fs.utimesSync(fixture.configPath, configMtimeMs / 1000, configMtimeMs / 1000);
      const second = capture(fixture, path.join(sandbox.dir, "second"));
      expect(second.entries).toEqual(first.entries);
      expect(second.snapshotFingerprint).toBe(first.snapshotFingerprint);
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("opens source databases read-only and leaves their main and WAL bytes unchanged", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-readonly-databases");
    const fixture = createFixture(sandbox.dir);
    const protectedPaths = ["index.db", "index.db-wal", "index.db-shm", "state.db", "state.db-wal", "state.db-shm"]
      .map((name) => path.join(fixture.dataDir, name))
      .filter((filePath) => fs.existsSync(filePath));
    const stablePaths = protectedPaths.filter((filePath) => !filePath.endsWith("-shm"));
    const before = Object.fromEntries(stablePaths.map((filePath) => [filePath, fs.readFileSync(filePath)]));
    try {
      for (const filePath of protectedPaths) fs.chmodSync(filePath, 0o400);
      expect(() => capture(fixture, path.join(sandbox.dir, "snapshot"))).not.toThrow();
      for (const filePath of stablePaths) {
        const expected = before[filePath];
        if (!expected) throw new Error(`missing source fingerprint fixture: ${filePath}`);
        expect(fs.readFileSync(filePath).equals(expected)).toBe(true);
      }
    } finally {
      for (const filePath of protectedPaths) {
        if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
      }
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("accepts current JSONC config and rejects non-current schema", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-jsonc");
    const fixture = createFixture(sandbox.dir);
    try {
      const config = configFor(fixture);
      fs.writeFileSync(
        fixture.configPath,
        `{
          // Current AKM config with comments.
          "configVersion": "0.9.0",
          "defaultBundle": "personal",
          "bundles": ${JSON.stringify(config.bundles)},
          "engines": ${JSON.stringify(config.engines)}
        }\n`,
      );
      expect(() => capture(fixture, path.join(sandbox.dir, "jsonc-snapshot"))).not.toThrow();

      writeConfig(fixture, { ...config, configVersion: "0.8.0" });
      expect(() => capture(fixture, path.join(sandbox.dir, "old-snapshot"))).toThrow(/Unsupported configVersion/);
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("rejects obvious literal config secrets", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-secret-config");
    const fixture = createFixture(sandbox.dir);
    try {
      writeConfig(fixture, { ...configFor(fixture), client_secret: "literal-secret-value" });
      expect(() => capture(fixture, path.join(sandbox.dir, "snapshot"))).toThrow(/obvious literal secret/);
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("fails closed on state paths outside captured bundle roots", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-unmapped-state");
    const fixture = createFixture(sandbox.dir);
    try {
      fixture.databases[0]
        ?.prepare(
          `INSERT INTO proposals
             (id, stash_dir, ref, status, source, created_at, updated_at, content, metadata_json)
           VALUES ('unmapped', ?, 'personal//memories/preference', 'pending', 'reflect',
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'content', '{}')`,
        )
        .run(path.join(sandbox.dir, "not-captured"));

      expect(() => capture(fixture, path.join(sandbox.dir, "snapshot"))).toThrow(/path outside captured bundle roots/);
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("fails closed on secret-bearing bundle material and cleans capture staging", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-secret-material");
    const fixture = createFixture(sandbox.dir);
    const destination = path.join(sandbox.dir, "snapshot");
    try {
      fs.writeFileSync(
        path.join(fixture.bundleRoots.personal ?? "", "env", "prod"),
        "TOKEN=database-visible-secret\n",
        {
          mode: 0o600,
        },
      );
      fixture.databases[0]?.exec("INSERT INTO snapshot_probe (value) VALUES ('database-visible-secret')");
      expect(() => capture(fixture, destination)).toThrow(/secret-bearing bundle material cannot be proven absent/);
      expect(fs.existsSync(destination)).toBe(false);
      expect(stagingEntries(sandbox.dir, "snapshot")).toEqual([]);
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("treats .env-named directories as secret-bearing", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-dotenv-directory");
    const fixture = createFixture(sandbox.dir);
    try {
      fs.writeFileSync(path.join(fixture.bundleRoots.personal ?? "", ".env.local", "token"), "secret\n", {
        mode: 0o600,
      });
      expect(() => capture(fixture, path.join(sandbox.dir, "snapshot"))).toThrow(/secret-bearing bundle material/);
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("rejects hard-linked source files", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-hardlink");
    const fixture = createFixture(sandbox.dir);
    try {
      const outside = path.join(sandbox.dir, "outside-secret");
      fs.writeFileSync(outside, "secret through alias\n", { mode: 0o600 });
      fs.linkSync(outside, path.join(fixture.bundleRoots.personal ?? "", "memories", "linked.md"));
      expect(() => capture(fixture, path.join(sandbox.dir, "snapshot"))).toThrow(/hard links are not allowed/);
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("rejects executable source files instead of changing their behavior", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-executable");
    const fixture = createFixture(sandbox.dir);
    const destination = path.join(sandbox.dir, "snapshot");
    try {
      fs.writeFileSync(path.join(fixture.bundleRoots.personal ?? "", "run.sh"), "#!/bin/sh\n", { mode: 0o700 });
      expect(() => capture(fixture, destination)).toThrow(/executable files are not supported/);
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("rejects empty nested directories instead of silently dropping them", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-empty-directory");
    const fixture = createFixture(sandbox.dir);
    try {
      fs.mkdirSync(path.join(fixture.bundleRoots.personal ?? "", "knowledge", "empty"), {
        recursive: true,
        mode: 0o700,
      });
      fs.chmodSync(path.join(fixture.bundleRoots.personal ?? "", "knowledge"), 0o700);
      expect(() => capture(fixture, path.join(sandbox.dir, "snapshot"))).toThrow(
        /empty bundle directories are not supported/,
      );
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("requires owner-controlled non-writable source trees", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-untrusted-source");
    const fixture = createFixture(sandbox.dir);
    const personal = fixture.bundleRoots.personal ?? "";
    try {
      fs.chmodSync(personal, 0o777);
      expect(() => capture(fixture, path.join(sandbox.dir, "snapshot"))).toThrow(
        /must not be group- or world-writable/,
      );
    } finally {
      fs.chmodSync(personal, 0o700);
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("rejects engine workspaces outside captured bundle roots", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-workspace");
    const fixture = createFixture(sandbox.dir);
    const externalWorkspace = path.join(sandbox.dir, "external-workspace");
    fs.mkdirSync(externalWorkspace);
    try {
      writeConfig(fixture, configFor(fixture, externalWorkspace));
      expect(() => capture(fixture, path.join(sandbox.dir, "snapshot"))).toThrow(
        /workspace is outside captured bundle roots/,
      );
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("rejects config and data roots nested inside bundle roots", () => {
    for (const nested of ["config", "data"] as const) {
      const sandbox = makeSandboxDir(`akm-eval-snapshot-overlapping-${nested}`);
      const fixture = createFixture(sandbox.dir, {
        configInsideBundle: nested === "config",
        dataInsideBundle: nested === "data",
      });
      try {
        expect(() => capture(fixture, path.join(sandbox.dir, "snapshot"))).toThrow(/snapshot sources overlap/);
      } finally {
        closeFixture(fixture);
        sandbox.cleanup();
      }
    }
  });

  test("rejects duplicate or nested bundle roots", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-overlapping-bundles");
    const fixture = createFixture(sandbox.dir);
    try {
      const nestedTeam = path.join(fixture.bundleRoots.personal ?? "", "nested-team");
      fs.mkdirSync(nestedTeam, { mode: 0o700 });
      expect(() =>
        captureInstallationSnapshot({
          destinationDir: path.join(sandbox.dir, "nested-snapshot"),
          bundleRoots: { personal: fixture.bundleRoots.personal ?? "", team: nestedTeam },
          defaultBundle: "personal",
          configPath: fixture.configPath,
          dataDir: fixture.dataDir,
          producer: { version: "0.9.0-rc.10", commit: "abc123" },
        }),
      ).toThrow(/snapshot sources overlap/);
      expect(() =>
        captureInstallationSnapshot({
          destinationDir: path.join(sandbox.dir, "duplicate-snapshot"),
          bundleRoots: {
            personal: fixture.bundleRoots.personal ?? "",
            team: fixture.bundleRoots.personal ?? "",
          },
          defaultBundle: "personal",
          configPath: fixture.configPath,
          dataDir: fixture.dataDir,
          producer: { version: "0.9.0-rc.10", commit: "abc123" },
        }),
      ).toThrow(/snapshot sources overlap/);
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("uses canonical parent paths for overlap rejection", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-overlap");
    const fixture = createFixture(sandbox.dir);
    const alias = path.join(sandbox.dir, "bundle-alias");
    fs.symlinkSync(fixture.bundleRoots.personal ?? "", alias, "dir");
    try {
      expect(() => capture(fixture, path.join(alias, "snapshot"))).toThrow(/destination overlaps a snapshot source/);
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("rejects symlinks at SQLite sidecar paths", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-sidecar");
    const fixture = createFixture(sandbox.dir);
    try {
      fs.symlinkSync(fixture.configPath, path.join(fixture.dataDir, "state.db-journal"));
      expect(() => capture(fixture, path.join(sandbox.dir, "snapshot"))).toThrow(/sidecars must be regular files/);
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("rejects symlinks inside a source tree", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-source-symlink");
    const fixture = createFixture(sandbox.dir);
    try {
      fs.symlinkSync(fixture.configPath, path.join(fixture.bundleRoots.personal ?? "", "memories", "config-link"));
      expect(() => capture(fixture, path.join(sandbox.dir, "snapshot"))).toThrow(/symbolic links are not allowed/);
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("fails closed when SQLite quick_check detects corruption", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-quick-check");
    const fixture = createFixture(sandbox.dir);
    try {
      closeFixture(fixture);
      const statePath = path.join(fixture.dataDir, "state.db");
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${statePath}${suffix}`, { force: true });
      fs.writeFileSync(statePath, "not-a-sqlite-database", { mode: 0o600 });
      const destination = path.join(sandbox.dir, "snapshot");
      expect(() => capture(fixture, destination)).toThrow(/quick_check/);
      expect(fs.existsSync(destination)).toBe(false);
      expect(stagingEntries(sandbox.dir, "snapshot")).toEqual([]);
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("detects same-owner source mutation that bypasses the maintenance barrier", async () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-source-mutation");
    const fixture = createFixture(sandbox.dir);
    const target = path.join(fixture.bundleRoots.personal ?? "", "memories", "preference.md");
    const destination = path.join(sandbox.dir, "snapshot");
    const mutator = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `import fs from "node:fs"; const target=${JSON.stringify(target)}; const end=Date.now()+1000; let i=0; while(Date.now()<end){ fs.writeFileSync(target, String(i++)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1); }`,
      ],
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await Bun.sleep(20);
      expect(() => capture(fixture, destination)).toThrow(/source file changed|bundle source file changed/);
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      mutator.kill();
      await mutator.exited;
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("detects SQLite writes that bypass the maintenance barrier", async () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-database-mutation");
    const fixture = createFixture(sandbox.dir);
    const statePath = path.join(fixture.dataDir, "state.db");
    const destination = path.join(sandbox.dir, "snapshot");
    const mutator = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `import { Database } from "bun:sqlite"; const db=new Database(${JSON.stringify(statePath)}); db.exec("PRAGMA busy_timeout=1000"); const end=Date.now()+1000; let i=0; while(Date.now()<end){ db.query("UPDATE snapshot_probe SET value=?").run(String(i++)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1); } db.close();`,
      ],
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await Bun.sleep(20);
      expect(() => capture(fixture, destination)).toThrow(
        /snapshot file changed|SQLite.*(?:changed|backup failed|locked)/i,
      );
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      mutator.kill();
      await mutator.exited;
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("rejects capture while a known AKM process lock is held", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-lock");
    const fixture = createFixture(sandbox.dir);
    try {
      fs.writeFileSync(path.join(fixture.dataDir, "improve.lock"), JSON.stringify({ pid: process.pid }));
      expect(() => capture(fixture, path.join(sandbox.dir, "snapshot"))).toThrow(/active AKM process lock/);
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });

  test("cleans staging when materialization fails after copying files", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-materialize-cleanup");
    const fixture = createFixture(sandbox.dir);
    const snapshotDir = path.join(sandbox.dir, "snapshot");
    const destination = path.join(sandbox.dir, "materialized");
    try {
      const manifest = capture(fixture, snapshotDir);
      rewriteSnapshotConfig(snapshotDir, (config) => {
        const engines = config.engines as Record<string, Record<string, unknown>>;
        if (!engines.runner) throw new Error("fixture config is missing runner engine");
        engines.runner.workspace = `${manifest.bundleRoots.personal}/memories/preference.md`;
      });
      expect(() => verifyInstallationSnapshot(snapshotDir)).not.toThrow();
      expect(() => materializeInstallationSnapshot(snapshotDir, destination)).toThrow();
      expect(fs.existsSync(destination)).toBe(false);
      expect(stagingEntries(sandbox.dir, "materialized")).toEqual([]);
    } finally {
      closeFixture(fixture);
      sandbox.cleanup();
    }
  });
});

test("installation snapshots fail closed when POSIX private modes are unavailable", () => {
  if (process.platform === "win32") {
    expect(() => verifyInstallationSnapshot("unused")).toThrow(/Windows ACL enforcement is unavailable/);
    return;
  }
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor?.configurable) throw new Error("process.platform must be configurable for this regression test");
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    expect(() => verifyInstallationSnapshot("unused")).toThrow(/Windows ACL enforcement is unavailable/);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});
