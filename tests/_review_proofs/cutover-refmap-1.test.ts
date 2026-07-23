// Proof for CANDIDATE: "First-wins bare-key mapping mis-attributes bare durable
// refs across bundles when a bundle path does not path.resolve-match its stored
// stash_dir" (src/migrate/legacy/three-db-cutover.ts addIndexEntryMappings /
// setMapping first-wins).
//
// Scenario is a REALISTIC multi-source 0.8.x install:
//   - "alpha" = the workspace-primary FILESYSTEM stash (matched, primary).
//   - "bravo" = an INSTALLED (git/npm) bundle. Its migrated 0.9 config entry
//     carries a git/npm LOCATOR, NOT a `path`, so cutoverStashRootsFromConfig
//     EXCLUDES it from stashRoots (config-migrate.ts:1743). Its index entries
//     therefore have stash_dir that path.resolve-matches NO configured root, so
//     addIndexEntryMappings takes the `matched===undefined -> isPrimary=true`
//     fallback and ALSO claims the bare `skill:review` key.
//
// Both bundles hold skill:review; a durable BARE ref `skill:review` exists in
// `events`. Because setMapping is first-wins over raw rowid order, whichever
// entry row has the lower rowid wins the bare key. When the non-primary bravo
// row precedes the primary alpha row (reachable after an incremental re-index /
// delete+re-add of the primary asset), the bare durable ref is re-homed to the
// WRONG bundle.

import { Database as BunDb } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDbPath, getStateDbPathInDataDir } from "../../src/core/paths";
import {
  buildCutoverRefMap,
  type CutoverStashRoot,
  rekeyStateDbCore,
} from "../../src/migrate/legacy/three-db-cutover";
import { openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";
import {
  type Cleanup,
  sandboxHome,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

let cleanup: Cleanup | undefined;

beforeEach(() => {
  const home = sandboxHome();
  const config = sandboxXdgConfigHome(home.cleanup);
  const cache = sandboxXdgCacheHome(config.cleanup);
  cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

test("bare durable ref is mis-attributed to the wrong bundle (first-wins over rowid)", () => {
  // ── The primary filesystem stash: a real directory the config root resolves to.
  const alphaPath = path.join(process.env.HOME!, "stash-alpha");
  fs.mkdirSync(alphaPath, { recursive: true });
  const ALPHA_ITEM_REF = "alpha//skills/review";

  // ── The installed (git/npm) bundle's materialized cache root. NO configured
  //    filesystem root will path.resolve-match this — mirrors an installed bundle
  //    whose migrated config entry has a git/npm locator, not a `path`.
  const bravoCacheRoot = path.join(process.env.HOME!, ".cache", "akm", "installed", "bravo");
  fs.mkdirSync(bravoCacheRoot, { recursive: true });
  const BRAVO_ITEM_REF = "bravo//skills/review";

  // ── Seed the last-good index.db. BOTH bundles hold `skill:review`. Insert the
  //    non-primary bravo row FIRST so it has the lower rowid (reachable whenever
  //    the primary asset was re-indexed / deleted+re-added after the install).
  const idxPath = getDbPath();
  fs.mkdirSync(path.dirname(idxPath), { recursive: true });
  const idx = new BunDb(idxPath);
  idx.exec(
    `CREATE TABLE entries (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       entry_key TEXT NOT NULL,
       item_ref  TEXT,
       entry_type TEXT NOT NULL,
       stash_dir TEXT NOT NULL
     );`,
  );
  const ins = idx.prepare("INSERT INTO entries (entry_key, item_ref, entry_type, stash_dir) VALUES (?, ?, ?, ?)");
  ins.run("skill:review", BRAVO_ITEM_REF, "skill", bravoCacheRoot); // rowid 1 (non-primary, unmatched)
  ins.run("skill:review", ALPHA_ITEM_REF, "skill", alphaPath); //      rowid 2 (primary, matched)
  idx.close();

  // ── stashRoots exactly as cutoverStashRootsFromConfig would build them: ONLY
  //    the filesystem primary. The installed bravo bundle (git/npm locator, no
  //    `path`) is not present.
  const stashRoots: CutoverStashRoot[] = [{ path: alphaPath, registryId: "alpha", primary: true }];

  const mapOutputPath = path.join(process.env.HOME!, "refmap.json");
  const map = buildCutoverRefMap({ oldIndexDbPath: idxPath, stashRoots, mapOutputPath });

  // 0.8.x semantics: a BARE ref searched all sources primary-first, so it
  // resolved to the PRIMARY (alpha) when the primary holds the asset. The
  // correct re-key target for the bare key is therefore alpha//skills/review.
  const bareTarget = map.get("skill:review");

  // DEFECT: the bare key is claimed by bravo (lower rowid) instead of the primary.
  expect(bareTarget).toBe(BRAVO_ITEM_REF); // the WRONG bundle
  expect(bareTarget).not.toBe(ALPHA_ITEM_REF); // NOT the workspace-primary

  // ── Concrete data harm: a durable `events` row keyed by the bare ref is now
  //    re-homed onto the wrong bundle's asset.
  const stateDb = openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING);
  try {
    stateDb
      .prepare("INSERT INTO events (event_type, ts, ref, metadata_json) VALUES (?, ?, ?, ?)")
      .run("feedback", "2026-01-01T00:00:00Z", "skill:review", "{}");
    stateDb.transaction(() => {
      rekeyStateDbCore(stateDb, map);
    })();
    const row = stateDb.prepare("SELECT ref FROM events LIMIT 1").get() as { ref: string };
    expect(row.ref).toBe(BRAVO_ITEM_REF); // curated durable event re-homed to WRONG bundle
    expect(row.ref).not.toBe(ALPHA_ITEM_REF);
  } finally {
    stateDb.close();
  }
});
