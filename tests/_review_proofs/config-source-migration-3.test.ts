// Proof for CANDIDATE: "sources-only 0.8 config migrates to bundles with
// defaultBundle undefined -> runtime cannot resolve a primary stash".
//
// We verify BOTH the mechanical claim (defaultBundle undefined, config still
// validates) AND the runtime consequence in resolveStashDir, then judge whether
// this is a migration-introduced DEFECT or faithful, guarded behavior.

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { validateConfigShape } from "../../src/core/config/config-schema";
import { resolveStashDir } from "../../src/core/common";
import { ConfigError } from "../../src/core/errors";
import { getConfigPath, getDefaultStashDir } from "../../src/core/paths";
import { migrateConfigSourcesToBundles } from "../../src/migrate/legacy/config-source-migration";
import { sandboxHome, sandboxXdgConfigHome, type Cleanup } from "../_helpers/sandbox";

let cleanup: Cleanup;
let savedStashDir: string | undefined;

beforeEach(() => {
  const home = sandboxHome();
  const cfg = sandboxXdgConfigHome(home.cleanup);
  cleanup = cfg.cleanup;
  // resolveStashDir short-circuits on AKM_STASH_DIR; remove it so we exercise
  // the config -> platform-default fallback chain the candidate targets.
  savedStashDir = process.env.AKM_STASH_DIR;
  delete process.env.AKM_STASH_DIR;
});

afterEach(() => {
  if (savedStashDir === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedStashDir;
  cleanup();
});

// The candidate's exact trigger: sources-only, no stashDir, no primary:true.
const SOURCES_ONLY = {
  configVersion: "0.9.0",
  sources: [{ type: "filesystem", path: "/a", name: "a" }],
} as const;

function writeConfig(obj: Record<string, unknown>): void {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

test("MECHANICAL: migration leaves defaultBundle undefined and still validates", () => {
  const migrated = migrateConfigSourcesToBundles({ ...SOURCES_ONLY });

  // The candidate's mechanical claims — both hold:
  expect(migrated.defaultBundle).toBeUndefined();
  expect(migrated.bundles).toEqual({ a: { path: "/a" } });
  // No configured source is dropped (candidate concedes this).
  expect(migrated.sources).toBeUndefined();

  const result = validateConfigShape(migrated);
  expect(result.ok).toBe(true); // migration "succeeds" — no schema error.
});

test("RUNTIME (implicit primary present): resolveStashDir still resolves the primary — NO wedge", () => {
  const migrated = migrateConfigSourcesToBundles({ ...SOURCES_ONLY });
  writeConfig(migrated as Record<string, unknown>);

  // A working 0.8.x install with this config had its primary stash at the
  // platform default (~/akm) because no stashDir was ever set. Recreate it.
  const platformDefault = getDefaultStashDir();
  expect(platformDefault).toBe(path.join(process.env.HOME as string, "akm"));
  fs.mkdirSync(platformDefault, { recursive: true });

  // Post-migration, resolveStashDir falls through bundles(no defaultBundle) to
  // the SAME platform default 0.8.x used. The primary stash is preserved.
  const resolved = resolveStashDir();
  expect(resolved).toBe(platformDefault);
});

test("RUNTIME (implicit primary absent): resolveStashDir throws the SAME recoverable error 0.8.x threw", () => {
  const migrated = migrateConfigSourcesToBundles({ ...SOURCES_ONLY });
  writeConfig(migrated as Record<string, unknown>);

  // No ~/akm on disk => same state a sources-only 0.8.x install had if it never
  // created a local stash. resolveStashDir throws a graceful, recoverable
  // ConfigError with the "akm init" hint — NOT a silent corruption, NOT an
  // unrecoverable migration wedge, and IDENTICAL to pre-migration behavior.
  let thrown: unknown;
  try {
    resolveStashDir();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as ConfigError).code).toBe("STASH_DIR_NOT_FOUND");
  expect((thrown as Error).message).toContain("akm init");
});
