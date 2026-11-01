// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** A show after a search writes a `select` that names the search and its source. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmSearch } from "../../../src/commands/read/search";
import { appendEvent, readEvents } from "../../../src/core/events";
import { recordShowUsage } from "../../../src/indexer/usage/show-usage";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  storage.cleanup();
});

describe("select attribution (G10)", () => {
  test("each logged search gets its own searchId and the event source", async () => {
    await akmSearch({ query: "alpha", eventSource: "task" });
    await akmSearch({ query: "alpha", eventSource: "task" });
    const ids = readEvents({ type: "search" }).events.map((event) => event.metadata);
    expect(ids).toHaveLength(2);
    expect(ids.every((metadata) => metadata?.source === "task")).toBe(true);
    expect(new Set(ids.map((metadata) => metadata?.searchId)).size).toBe(2);
  });

  test("a select carries the searchId and source of the search it followed", () => {
    appendEvent({
      eventType: "search",
      metadata: { query: "deploy", resultRefs: ["main//skills/deploy"], source: "improve", searchId: "sid-1" },
    });
    recordShowUsage("main//skills/deploy", "skill", "deploy");
    const [select] = readEvents({ type: "select" }).events;
    expect(select?.metadata).toMatchObject({ searchId: "sid-1", source: "improve", rankPosition: 0 });
  });

  test("a search written before G10 still yields a select, with no searchId", () => {
    appendEvent({ eventType: "search", metadata: { query: "deploy", resultRefs: ["main//skills/deploy"] } });
    recordShowUsage("main//skills/deploy", "skill", "deploy");
    const [select] = readEvents({ type: "select" }).events;
    expect(select?.metadata?.searchId).toBeUndefined();
    expect(select?.metadata?.rankPosition).toBe(0);
  });
});
