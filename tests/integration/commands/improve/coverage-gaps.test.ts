// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm improve` reports zero-result searches as coverage gaps. The summary
 * search event lives in state.db's `usage_events` (query column, resultCount
 * in metadata). Opens a real state.db and index.db (integration per ORG-03).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { akmImprove } from "../../../../src/commands/improve/improve";
import { type AkmConfig, saveConfig } from "../../../../src/core/config/config";
import { openStateDatabase } from "../../../../src/core/state-db";
import { akmIndex } from "../../../../src/indexer/indexer";
import { insertUsageEvent } from "../../../../src/indexer/usage/usage-events";
import { withTestImproveLlm } from "../../../_helpers/improve-config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

test("a zero-result search in state.db is reported as a coverage gap", async () => {
  const stash = storage.stashDir;
  const config = withTestImproveLlm({
    semanticSearchMode: "off",
    bundles: { stash: { path: stash, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
  } as AkmConfig);
  saveConfig(config);
  await akmIndex({ stashDir: stash, full: true });

  const db = openStateDatabase();
  try {
    // The summary row `logSearchEvent` writes: no entry_ref, resultCount in metadata.
    insertUsageEvent(db, {
      event_type: "search",
      query: "kubernetes ingress",
      metadata: JSON.stringify({ resultCount: 0 }),
    });
    insertUsageEvent(db, { event_type: "search", query: "found it", metadata: JSON.stringify({ resultCount: 1 }) });
  } finally {
    db.close();
  }

  const result = await akmImprove({
    scope: "skill",
    stashDir: stash,
    config,
    ensureIndexFn: async () => false,
  });

  expect(result.coverageGaps).toEqual(["kubernetes ingress"]);
});
