// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmCurate } from "../../src/commands/read/curate";
import { akmSearch } from "../../src/commands/read/search";
import { akmShowUnified } from "../../src/commands/read/show";
import { resetConfigCache, saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { openStateDatabase } from "../../src/core/state-db";
import { akmIndex } from "../../src/indexer/indexer";
import { openExistingDatabase } from "../../src/storage/repositories/index-connection";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

interface UsageRow {
  event_type: string;
  query: string | null;
  entry_ref: string | null;
  metadata: string | null;
  source: string;
}

let storage: IsolatedAkmStorage;
let teamDir = "";

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  teamDir = path.join(storage.root, "team");
  fs.mkdirSync(path.join(teamDir, "memories"), { recursive: true });
  resetConfigCache();
  saveConfig({
    semanticSearchMode: "off",
    bundles: {
      stash: { path: storage.stashDir },
      team: { path: teamDir },
    },
    defaultBundle: "stash",
    registries: [],
  });
  writeIndexFixture();
  await akmIndex({ stashDir: storage.stashDir, full: true });
  const state = openStateDatabase();
  state.prepare("DELETE FROM usage_events").run();
  state.close();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

function writeAsset(
  root: string,
  typeDir: "memories" | "knowledge",
  name: string,
  frontmatter: string,
  body: string,
): string {
  const filePath = path.join(root, typeDir, `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n\n${body}\n`);
  return filePath;
}

function writeIndexFixture(): void {
  writeAsset(storage.stashDir, "memories", "parent", "description: surface-parent-needle", "Primary parent body.");
  writeAsset(
    storage.stashDir,
    "memories",
    "parent.derived",
    "inferred: true\nsource: memories/parent\ndescription: direct-child-needle",
    "Primary derived body.",
  );
  writeAsset(
    storage.stashDir,
    "knowledge",
    "plain-target",
    "description: plainneedle operational guide",
    "Plain target body.",
  );
  writeAsset(teamDir, "memories", "parent", "description: team-parent-needle", "Team parent body.");
  writeAsset(
    teamDir,
    "memories",
    "parent.derived",
    "inferred: true\nsource: memories/parent\ndescription: team-parent-derived-needle",
    "Team derived body.",
  );
  writeAsset(teamDir, "memories", "team-only", "description: team-surface-needle", "Team-only parent body.");
  writeAsset(
    teamDir,
    "memories",
    "team-only.derived",
    "inferred: true\nsource: memories/team-only\ndescription: team-direct-child-needle",
    "Team-only derived body.",
  );
}

function usageRows(): UsageRow[] {
  const db = openStateDatabase();
  try {
    return db
      .prepare("SELECT event_type, query, entry_ref, metadata, source FROM usage_events ORDER BY id")
      .all() as UsageRow[];
  } finally {
    db.close();
  }
}

function metadataFor(query: string, ref: string): Record<string, unknown> | undefined {
  const row = usageRows().find((candidate) => candidate.query === query && candidate.entry_ref === ref);
  return row?.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined;
}

function clearUsageRows(): void {
  const db = openStateDatabase();
  db.prepare("DELETE FROM usage_events").run();
  db.close();
}

describe("downstream value attribution", () => {
  test("persists MI direct and parent-surface exposure without adding attribution to search result payloads", async () => {
    const direct = await akmSearch({ query: "direct-child-needle", limit: 10 });
    const surface = await akmSearch({ query: "surface-parent-needle", limit: 10 });

    expect(metadataFor("direct-child-needle", "stash//memories/parent.derived")).toEqual({
      downstreamAttribution: {
        version: 1,
        control: false,
        memoryInference: { exposure: "direct", childRef: "stash//memories/parent.derived" },
      },
    });
    expect(metadataFor("surface-parent-needle", "stash//memories/parent")).toEqual({
      downstreamAttribution: {
        version: 1,
        control: false,
        memoryInference: { exposure: "surface", childRef: "stash//memories/parent.derived" },
      },
    });
    expect(JSON.stringify({ direct, surface })).not.toContain("downstreamAttribution");
  });

  test("an asset outside memory-inference exposure records control usage metadata", async () => {
    const plain = await akmSearch({ query: "plainneedle", limit: 10 });
    expect(plain.hits.map((hit) => ("ref" in hit ? hit.ref : undefined))).toContain("knowledge/plain-target");
    expect(metadataFor("plainneedle", "stash//knowledge/plain-target")).toEqual({
      downstreamAttribution: { version: 1, control: true },
    });
  });

  test("brief search output does not attribute stripped derived surface content", async () => {
    clearUsageRows();
    const result = await runCliCapture(["search", "surface-parent-needle", "--detail", "brief", "--format", "json"]);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as { hits: Array<Record<string, unknown>> };
    expect(output.hits.find((hit) => hit.name === "parent")?.description).toBeUndefined();
    expect(metadataFor("surface-parent-needle", "stash//memories/parent")).toEqual({
      downstreamAttribution: { version: 1, control: true },
    });
  });

  test("remember --show-similar does not attribute MI surface content omitted from its ref/title projection", async () => {
    clearUsageRows();
    const result = await runCliCapture([
      "remember",
      "surface-parent-needle",
      "--name",
      "remember-projection",
      "--show-similar",
      "--format",
      "json",
    ]);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as { similar?: Array<Record<string, unknown>> };
    const parent = output.similar?.find((item) => item.title === "parent");
    expect(parent).toEqual({ ref: "memories/parent", title: "parent" });
    expect(metadataFor("surface-parent-needle", "stash//memories/parent")).toEqual({
      downstreamAttribution: { version: 1, control: true },
    });
  });

  test("source-qualifies indexed children and preserves duplicate concepts in each bundle", async () => {
    const index = openExistingDatabase(getDbPath());
    const indexedRefs = (
      index.prepare("SELECT item_ref FROM entries WHERE item_ref IS NOT NULL ORDER BY item_ref").all() as Array<{
        item_ref: string;
      }>
    ).map((row) => row.item_ref);
    index.close();
    expect(indexedRefs).toContain("stash//memories/parent");
    expect(indexedRefs).toContain("team//memories/parent");
    expect(indexedRefs).toContain("team//memories/parent.derived");
    expect(indexedRefs).toContain("team//memories/team-only");
    expect(indexedRefs).toContain("team//memories/team-only.derived");
    const result = await akmSearch({ query: "team surface needle", source: "team", limit: 10 });
    const teamHit = result.hits.find((hit) => hit.type !== "registry" && hit.name === "team-only" && "ref" in hit);
    expect(teamHit && "ref" in teamHit ? teamHit.ref : undefined).toBe("team//memories/team-only");
    expect(
      usageRows()
        .filter((row) => row.query === "team surface needle")
        .map((row) => row.entry_ref),
    ).toContain("team//memories/team-only");

    expect(metadataFor("team surface needle", "team//memories/team-only")).toEqual({
      downstreamAttribution: {
        version: 1,
        control: false,
        memoryInference: { exposure: "surface", childRef: "team//memories/team-only.derived" },
      },
    });
    const shown = await akmShowUnified({ ref: "team//memories/team-only.derived", skipLogging: true });
    expect(shown.origin).toBe("team");
    expect(shown.path).toBe(path.join(teamDir, "memories", "team-only.derived.md"));
  });

  test("direct show attributes an inferred child", async () => {
    await akmShowUnified({ ref: "stash//memories/parent.derived" });
    const row = usageRows().find(
      (candidate) => candidate.event_type === "show" && candidate.entry_ref === "stash//memories/parent.derived",
    );

    expect(row?.metadata ? JSON.parse(row.metadata) : undefined).toEqual({
      downstreamAttribution: {
        version: 1,
        control: false,
        memoryInference: { exposure: "direct", childRef: "stash//memories/parent.derived" },
      },
    });
  });

  test("final curate selection retains attribution and audit source without a nested show row", async () => {
    const searchResponse = await akmSearch({
      query: "direct-child-needle",
      limit: 10,
      skipLogging: true,
      eventSource: "audit",
    });
    await akmCurate({ query: "direct-child-needle", limit: 1, searchResponse, eventSource: "audit" });

    const rows = usageRows();
    const selected = rows.filter((row) => row.event_type === "curate" && row.entry_ref !== null);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.source).toBe("audit");
    expect(selected[0]?.metadata ? JSON.parse(selected[0].metadata) : undefined).toMatchObject({
      downstreamAttribution: {
        memoryInference: { exposure: "direct", childRef: "stash//memories/parent.derived" },
      },
    });
    expect(rows.filter((row) => row.event_type === "show")).toHaveLength(0);
    expect(rows.filter((row) => row.source === "user")).toHaveLength(0);
  });

  test("curate drops MI surface attribution when an internal path replaces the derived description", async () => {
    const searchResponse = await akmSearch({ query: "surface-parent-needle", limit: 10, skipLogging: true });
    const parentHit = searchResponse.hits.find((hit) => hit.type === "memory" && hit.name === "parent");
    expect(parentHit?.description).toBe("direct-child-needle");
    if (parentHit) parentHit.description = "internal replacement";

    const curated = await akmCurate({ query: "surface-parent-needle", limit: 1, searchResponse });
    expect(curated.items[0]?.description).toBe("internal replacement");
    const row = usageRows().find((candidate) => candidate.event_type === "curate" && candidate.entry_ref !== null);
    expect(row?.metadata ? JSON.parse(row.metadata) : undefined).toEqual({
      downstreamAttribution: { version: 1, control: true },
    });
  });
});
