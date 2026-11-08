// Integration: search and curate telemetry record usage events from the refs the
// caller holds and open no index connection of their own (#1469).
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmCurate } from "../../src/commands/read/curate";
import { akmSearch } from "../../src/commands/read/search";
import { saveConfig } from "../../src/core/config/config";
import { openStateDatabase } from "../../src/core/state-db";
import { akmIndex } from "../../src/indexer/indexer";
import * as indexConnection from "../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir } },
    defaultBundle: "stash",
    registries: [],
  });
  const file = path.join(storage.stashDir, "knowledge", "quartz.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "---\ndescription: quartz deployment\n---\n\nquartz deployment procedure\n");
  await akmIndex({ stashDir: storage.stashDir, full: true });
});
afterEach(() => storage.cleanup());

function usageRefs(eventType: string): string[] {
  const db = openStateDatabase();
  try {
    return (
      db
        .prepare("SELECT entry_ref FROM usage_events WHERE event_type = ? AND entry_ref IS NOT NULL")
        .all(eventType) as Array<{ entry_ref: string }>
    ).map((row) => row.entry_ref);
  } finally {
    db.close();
  }
}

/** How many index connections `run` opens. */
async function indexOpens(run: () => Promise<unknown>): Promise<number> {
  const spies = (["openExistingDatabase", "openReadonlyExistingDatabase", "openIndexDatabase"] as const).map((name) =>
    spyOn(indexConnection, name),
  );
  try {
    await run();
    return spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

test("search telemetry records the hit's durable ref and opens no index connection beyond the search itself", async () => {
  await akmSearch({ query: "quartz deployment", skipLogging: true }); // warm one-time state
  const quiet = await indexOpens(() => akmSearch({ query: "quartz deployment", skipLogging: true }));
  const logged = await indexOpens(() => akmSearch({ query: "quartz deployment" }));
  expect(quiet).toBeGreaterThan(0);
  expect(logged).toBe(quiet);
  expect(usageRefs("search")).toEqual(["stash//knowledge/quartz"]);
});

test("curate telemetry records the item's durable ref and opens no index connection beyond curation itself", async () => {
  await akmCurate({ query: "quartz deployment", skipLogging: true }); // warm one-time state
  const quiet = await indexOpens(() => akmCurate({ query: "quartz deployment", skipLogging: true }));
  const logged = await indexOpens(() => akmCurate({ query: "quartz deployment" }));
  expect(quiet).toBeGreaterThan(0);
  expect(logged).toBe(quiet);
  expect(usageRefs("curate")).toEqual(["stash//knowledge/quartz"]);
});
