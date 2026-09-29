// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression coverage for the usage/event query-redaction privacy fix: the
 * Claude Code hook curates every user prompt, so a credential pasted into a
 * prompt flows straight into `akm search`/`akm curate` as the query text. A
 * scan of mined queries found 22 credential-like values (`PASSWORD=…`,
 * `TOKEN=…`, `SECRET=…`) stored verbatim in `state.db`.
 *
 * This drives the real CLI end to end (a real state.db, a real index.db —
 * hence `tests/integration/`, per AGENTS.md's ORG-03/04/05/06 rule) and
 * confirms the redacted form, not the raw secret, lands in BOTH persistence
 * points named in the bug report: `usage_events.query` and the `events`
 * table's `metadata_json` (read back via `readEvents`), for both `search` and
 * `curate`. See `src/core/redaction.ts` (`redactCredentialPatterns`) and its
 * call sites in `logSearchEvent` (`src/commands/read/search.ts`) and
 * `logCurateEvent` (`src/commands/read/curate.ts`).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { readEvents } from "../../src/core/events";
import { openStateDatabase } from "../../src/core/state-db";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  fs.writeFileSync(
    path.join(storage.stashDir, "knowledge", "deploy.md"),
    "---\ndescription: Deployment guide\n---\n\nDeploy safely.\n",
  );
});

afterEach(() => storage.cleanup());

/** Every non-null `query` value recorded for `eventType` in `usage_events`. */
function usageEventQueries(eventType: string): string[] {
  const state = openStateDatabase();
  try {
    const rows = state
      .prepare("SELECT query FROM usage_events WHERE event_type = ? AND query IS NOT NULL ORDER BY id")
      .all(eventType) as Array<{ query: string }>;
    return rows.map((row) => row.query);
  } finally {
    state.close();
  }
}

test("a search query carrying a pasted credential is redacted before it reaches state.db", async () => {
  expect((await runCliCapture(["index", "--full"])).code).toBe(0);

  const secretQuery = "deploy notes PASSWORD=hunter2Secret TOKEN=abc123XYZtoken please review";
  const result = await runCliCapture(["search", secretQuery, "--format=json"]);
  expect(result.code).toBe(0);

  const queries = usageEventQueries("search");
  expect(queries.length).toBeGreaterThan(0);
  for (const query of queries) {
    expect(query).not.toContain("hunter2Secret");
    expect(query).not.toContain("abc123XYZtoken");
    expect(query).toContain("PASSWORD=[REDACTED]");
    expect(query).toContain("TOKEN=[REDACTED]");
  }

  const searchEvents = readEvents({ type: "search" }).events;
  const metaQueries = searchEvents.map((event) => event.metadata?.query as string | undefined).filter(Boolean);
  expect(metaQueries.length).toBeGreaterThan(0);
  for (const metaQuery of metaQueries) {
    expect(metaQuery).not.toContain("hunter2Secret");
    expect(metaQuery).not.toContain("abc123XYZtoken");
    expect(metaQuery).toContain("PASSWORD=[REDACTED]");
    expect(metaQuery).toContain("TOKEN=[REDACTED]");
  }
});

test("a curate query carrying a pasted credential is redacted before it reaches state.db", async () => {
  expect((await runCliCapture(["index", "--full"])).code).toBe(0);

  const secretQuery = "onboarding SECRET=topSecretValue99 for the new service";
  const result = await runCliCapture(["curate", secretQuery, "--format=json"]);
  expect(result.code).toBe(0);

  const queries = usageEventQueries("curate");
  expect(queries.length).toBeGreaterThan(0);
  for (const query of queries) {
    expect(query).not.toContain("topSecretValue99");
    expect(query).toContain("SECRET=[REDACTED]");
  }

  const curateEvents = readEvents({ type: "curate" }).events;
  const metaQueries = curateEvents.map((event) => event.metadata?.query as string | undefined).filter(Boolean);
  expect(metaQueries.length).toBeGreaterThan(0);
  for (const metaQuery of metaQueries) {
    expect(metaQuery).not.toContain("topSecretValue99");
    expect(metaQuery).toContain("SECRET=[REDACTED]");
  }
});
