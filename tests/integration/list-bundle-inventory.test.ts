// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { main } from "../../src/cli";
import { akmListSources } from "../../src/commands/sources/installed-stashes";
import { resetConfigCache } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import type { IndexDocument } from "../../src/indexer/passes/metadata";
import { writeLockfile } from "../../src/integrations/lockfile";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import type { EntryProvenance } from "../../src/storage/repositories/index-entry-types";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
});

afterEach(() => {
  storage.cleanup();
  resetConfigCache();
});

function indexItem(bundleId: string, type: string, conceptId: string): void {
  const provenance: EntryProvenance = {
    itemRef: `${bundleId}//${conceptId}`,
    bundleId,
    componentId: bundleId,
    conceptId,
    adapterId: "akm",
  };
  const entry: IndexDocument = { type, name: conceptId.split("/").slice(1).join("/"), tags: [] };
  const db = openIndexDatabase(getDbPath());
  try {
    upsertEntry(db, `${storage.stashDir}/${conceptId}`, entry, provenance);
  } finally {
    closeDatabase(db);
  }
}

async function configureInventory(): Promise<void> {
  writeSandboxConfig({
    bundles: {
      primary: {
        path: storage.stashDir,
        writable: true,
        components: { main: { root: ".", adapter: "akm", writable: true } },
      },
      catalog: {
        git: "https://example.test/catalog.git",
        registryId: "github:example/catalog",
        components: { docs: { root: "content", adapter: "akm" } },
      },
    },
    defaultBundle: "primary",
  });
  await writeLockfile([
    {
      id: "catalog",
      source: "git",
      ref: "git:https://example.test/catalog.git",
      resolvedVersion: "1.2.3",
      resolvedRevision: "abc123",
      integrity: "sha256-deadbeef",
      localRoot: storage.cacheDir,
      manifestDigest: "sha256-feedface",
      adapterIds: ["akm"],
      installedAt: "2026-07-20T00:00:00.000Z",
    },
  ]);
  indexItem("primary", "skill", "skills/review");
  indexItem("catalog", "knowledge", "knowledge/api");
  indexItem("catalog", "knowledge", "knowledge/cli");
  resetConfigCache();
}

describe("akm list bundle inventory", () => {
  // 0.9 CLI overhaul (S7): `akm bundle` is now the canonical group housing
  // `create`/`add`/`list`/`show`/`remove`/`update` (src/commands/sources/
  // bundle-cli.ts) — the guard that used to pin its ABSENCE here predates the
  // overhaul and is obsolete; see tests/integration/commands/bundle-cli-
  // envelope.test.ts for the group's own envelope coverage.
  test("the bundle command namespace is registered exactly once", () => {
    expect(typeof (main.subCommands as Record<string, unknown>).bundle).toBe("object");
  });

  test("joins desired config, lock state, components, and indexed counts", async () => {
    await configureInventory();

    const result = await akmListSources({ stashDir: storage.stashDir });
    expect(result.defaultBundle).toBe("primary");
    expect(result.totalSources).toBe(2);

    const byName = new Map(result.sources.map((source) => [source.name, source]));
    expect(byName.get("primary")).toMatchObject({
      kind: "filesystem",
      default: true,
      source: { kind: "path", locator: storage.stashDir },
      components: [{ name: "main", root: ".", adapter: "akm", writable: true }],
      lock: null,
      itemCount: 1,
      byType: { skill: 1 },
    });
    expect(byName.get("catalog")).toMatchObject({
      kind: "git",
      default: false,
      source: { kind: "git", locator: "https://example.test/catalog.git" },
      registryId: "github:example/catalog",
      components: [{ name: "docs", root: "content", adapter: "akm" }],
      lock: {
        source: "git",
        ref: "git:https://example.test/catalog.git",
        resolvedVersion: "1.2.3",
        resolvedRevision: "abc123",
        integrity: "sha256-deadbeef",
        localRoot: storage.cacheDir,
        manifestDigest: "sha256-feedface",
        adapterIds: ["akm"],
        installedAt: "2026-07-20T00:00:00.000Z",
      },
      itemCount: 2,
      byType: { knowledge: 2 },
    });
  });

  test("filters by current provider kinds", async () => {
    await configureInventory();
    const result = await akmListSources({ stashDir: storage.stashDir, kind: ["git"] });
    expect(result.sources.map((source) => source.name)).toEqual(["catalog"]);
  });

  test("the CLI emits the enriched list shape", async () => {
    await configureInventory();
    const result = await runCliCapture(["bundle", "list", "--format", "json"]);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.shape).toBe("list");
    expect(output.defaultBundle).toBe("primary");
    expect(output.sources[0]).toHaveProperty("itemCount");
    expect(output.sources[0]).toHaveProperty("lock");
  });

  // #908/#909: `akm bundle list` must disclose, per component, the EFFECTIVE
  // adapter and whether it came from auto-detection — before this, an
  // auto-detected adapter was invisible (no "adapter" field at all when no
  // component was configured), which is how a mixed-layout bundle's silent
  // shadowing (#908) and an invalid adapter's silent fallback (#909) both
  // escaped notice on the one command an operator would check first.
  test("bundle list reports the effective adapter + detected per component", async () => {
    const agentSkillsFixture = path.resolve(import.meta.dir, "..", "fixtures", "bundles", "agent-skills");
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: {
        primary: {
          path: storage.stashDir,
          writable: true,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
        // No `components` at all — the implicit single component every
        // bundle gets; its adapter is auto-detected, never persisted here.
        auto: { path: agentSkillsFixture },
      },
      defaultBundle: "primary",
    });
    resetConfigCache();

    const result = await akmListSources({ stashDir: storage.stashDir });
    const byName = new Map(result.sources.map((source) => [source.name, source]));

    // RED on old code: `components` carried no `adapter`/`detected` field at
    // all for an explicitly-configured component, and was an EMPTY array for
    // one with no configured component (nothing to auto-detect through).
    expect(byName.get("primary")?.components).toEqual([
      { name: "main", root: ".", adapter: "akm", detected: false, writable: true },
    ]);
    expect(byName.get("auto")?.components).toEqual([{ name: "main", adapter: "agent-skills", detected: true }]);
  });
});
