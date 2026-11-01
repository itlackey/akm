// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The low-data and long-content datasets keep the sizes plan 11.2 names. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openStateDatabase } from "../../src/core/state-db";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { LONG_NAME, LONG_QUERY } from "./constants";
import { seedLongContent, seedLowData } from "./seed";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

function count(sql: string): number {
  const db = openStateDatabase();
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe("visual dataset variants", () => {
  test("low data is six searches on one day", () => {
    seedLowData(storage.stashDir);
    expect(count("SELECT COUNT(*) AS n FROM usage_events WHERE event_type = 'search'")).toBe(6);
    expect(count("SELECT COUNT(DISTINCT date(created_at)) AS n FROM usage_events")).toBe(1);
  });

  test("long content has an 80-char ref, a 120-char query, a 6-digit count", () => {
    seedLongContent(storage.stashDir);
    expect(`stash//knowledge/${LONG_NAME}`).toHaveLength(80);
    expect(LONG_QUERY).toHaveLength(120);
    expect(count("SELECT COUNT(*) AS n FROM usage_events")).toBeGreaterThanOrEqual(100_000);
    expect(count(`SELECT COUNT(*) AS n FROM usage_events WHERE query = '${LONG_QUERY}'`)).toBeGreaterThan(0);
  });
});
