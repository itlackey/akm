// Classification: integration clause 1 - opens real index.db and state.db.

/**
 * Search and index timings are persisted: the search summary `usage_events`
 * row carries `totalMs` (plus `rankMs` / `embedMs` when present) and every
 * index run appends one `index_completed` event, so `akm metrics` can report
 * latency after the command output is gone.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../../src/commands/read/search";
import { resetConfigCache } from "../../src/core/config/config";
import { getStateDbPath, openStateDatabase } from "../../src/core/state-db";
import { akmIndex } from "../../src/indexer/indexer";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  fs.writeFileSync(
    path.join(storage.stashDir, "knowledge", "timing-note.md"),
    "---\ndescription: timing note\n---\n\n# timing\n\nBody about timing.\n",
  );
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
  });
  resetConfigCache();
});

afterEach(() => {
  storage.cleanup();
  resetConfigCache();
});

function readStateRows<T>(sql: string, ...params: string[]): T[] {
  const db = openStateDatabase(getStateDbPath());
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

describe("timing persistence", () => {
  test("the search summary usage row records totalMs", async () => {
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const response = await akmSearch({ query: "timing", source: "local" });
    expect(response.hits.length).toBeGreaterThan(0);

    const rows = readStateRows<{ metadata: string }>(
      "SELECT metadata FROM usage_events WHERE event_type = 'search' AND entry_ref IS NULL",
    );
    expect(rows).toHaveLength(1);
    const metadata = JSON.parse(rows[0]!.metadata);
    expect(metadata.resultCount).toBeGreaterThan(0);
    expect(typeof metadata.totalMs).toBe("number");
    expect(metadata.totalMs).toBeGreaterThanOrEqual(0);
  });

  test("an index run appends one index_completed event with its phase timings", async () => {
    const result = await akmIndex({ stashDir: storage.stashDir, full: true });

    const rows = readStateRows<{ metadata_json: string }>(
      "SELECT metadata_json FROM events WHERE event_type = 'index_completed'",
    );
    expect(rows).toHaveLength(1);
    const metadata = JSON.parse(rows[0]!.metadata_json);
    expect(metadata.mode).toBe("full");
    for (const key of ["totalMs", "walkMs", "llmMs", "embedMs", "ftsMs", "finalizeMs"]) {
      expect(typeof metadata[key]).toBe("number");
    }
    expect(metadata.walkMs).toBe(result.timing?.walkMs);
  });
});
