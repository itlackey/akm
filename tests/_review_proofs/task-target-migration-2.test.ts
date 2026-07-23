import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parseAndValidateConfigText } from "../../src/core/config/config";
import type { AkmConfig } from "../../src/core/config/config-types";
import { migrateConfigSourcesToBundles } from "../../src/migrate/legacy/config-source-migration";
import { planTaskTargetRefMigration } from "../../src/migrate/legacy/task-target-ref-migration";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

describe("task-target migration: two bundles at the same real dir", () => {
  let storage: IsolatedAkmStorage;
  let stashRoot: string;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    // A realistic, real on-disk stash the user actually uses.
    stashRoot = path.join(storage.root, "stash-shared");
    fs.mkdirSync(path.join(stashRoot, "tasks"), { recursive: true });
    fs.mkdirSync(path.join(stashRoot, "workflows"), { recursive: true });
  });

  afterEach(() => storage.cleanup());

  test("planTaskTargetRefMigration throws on two bundles resolving to the same root", () => {
    const config = {
      configVersion: "0.9.0",
      bundles: {
        a: { path: stashRoot, writable: true },
        b: { path: stashRoot },
      },
      defaultBundle: "a",
    } as unknown as AkmConfig;

    // The migrator refuses the config outright — before scanning any tasks.
    expect(() => planTaskTargetRefMigration(config)).toThrow(/resolve to the same root/);
  });

  test("the SAME two-same-path-bundle config is accepted by the 0.9 runtime validator", () => {
    // No path-uniqueness constraint in the bundle schema: this loads fine.
    const text = JSON.stringify({
      configVersion: "0.9.0",
      bundles: {
        a: { path: stashRoot, writable: true },
        b: { path: stashRoot },
      },
      defaultBundle: "a",
    });
    const parsed = parseAndValidateConfigText(text);
    // Runtime accepts both bundles pointing at the same directory.
    expect(parsed.bundles?.a?.path).toBe(stashRoot);
    expect(parsed.bundles?.b?.path).toBe(stashRoot);
  });

  test("REACHABILITY: a realistic 0.8.x config (stashDir + a sources[] entry for the same dir) migrates into the rejected two-bundle config", () => {
    // A user who `akm add`-ed the very directory they already use as stashDir.
    const oldShape: Record<string, unknown> = {
      configVersion: "0.9.0",
      stashDir: stashRoot,
      sources: [{ type: "filesystem", path: stashRoot }],
    };

    const migrated = migrateConfigSourcesToBundles(oldShape) as unknown as {
      bundles: Record<string, { path?: string }>;
      defaultBundle?: string;
    };

    // migrateConfigSourcesToBundles produced two DISTINCT bundle keys, both
    // pointing at the same real directory.
    const keys = Object.keys(migrated.bundles);
    expect(keys.length).toBe(2);
    const paths = keys.map((k) => migrated.bundles[k]?.path);
    expect(paths[0]).toBe(paths[1]);

    // Feeding that migrator output (the exact config the apply flow carries into
    // planTaskTargetRefMigration at config-migrate.ts:2125 / buildMigrationPlan)
    // throws — wedging `migrate apply` for a legitimate install.
    expect(() => planTaskTargetRefMigration(migrated as unknown as AkmConfig)).toThrow(
      /resolve to the same root/,
    );
  });
});
