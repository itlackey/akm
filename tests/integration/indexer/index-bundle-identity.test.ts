// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../../../src/commands/read/search";
import { akmShowUnified } from "../../../src/commands/read/show";
import { resetConfigCache } from "../../../src/core/config/config";
import { getUnresolvedSourcesDir } from "../../../src/core/paths";
import { akmIndex } from "../../../src/indexer/indexer";
import * as websiteProvider from "../../../src/sources/providers/website";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { getAllEntries } from "../../../src/storage/repositories/index-entries-repository";
import {
  type IsolatedAkmStorage,
  makeStashDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let secondary: SandboxedDir;

/** A website provider whose content path cannot be resolved. */
function unresolvableWebsite(entry: { name?: string }): ReturnType<typeof websiteProvider.createWebsiteProvider> {
  return {
    kind: "website",
    name: entry.name ?? "website",
    path: () => {
      throw new Error("fixture path resolution failure");
    },
  } as unknown as ReturnType<typeof websiteProvider.createWebsiteProvider>;
}

function writeSharedConcept(root: string, bundleLabel: string): string {
  const filePath = path.join(root, "knowledge", "shared.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `---\ndescription: crossbundlemarker from ${bundleLabel}\n---\n\n# Shared\n\n${bundleLabel}\n`,
    "utf8",
  );
  return filePath;
}

function writeConcept(root: string, name: string, marker: string): string {
  const filePath = path.join(root, "knowledge", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${marker}\n---\n\n# ${name}\n\n${marker}\n`, "utf8");
  return filePath;
}

function indexedItemRefs(): string[] {
  const db = openExistingDatabase();
  try {
    return getAllEntries(db)
      .map((entry) => `${entry.bundleId}//${entry.conceptId}`)
      .sort();
  } finally {
    closeDatabase(db);
  }
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  secondary = makeStashDir();
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: {
      primary: { path: storage.stashDir, writable: true },
      team: { path: secondary.dir },
    },
    defaultBundle: "primary",
  });
  resetConfigCache();
});

afterEach(() => {
  secondary.cleanup();
  storage.cleanup();
});

describe("full-index bundle identity", () => {
  test("an environment stash remains searchable and showable ahead of a different default bundle", async () => {
    const envPath = writeConcept(storage.stashDir, "env-only", "envprecedencemarker");
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: { configured: { path: secondary.dir } },
      defaultBundle: "configured",
    });
    resetConfigCache();

    await akmIndex({ stashDir: storage.stashDir, full: true });

    const result = await akmSearch({ query: "envprecedencemarker", skipLogging: true });
    const ref = result.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : []))[0];
    expect(ref).toContain("//knowledge/env-only");
    expect((await akmShowUnified({ ref: ref as string, skipLogging: true })).path).toBe(envPath);
  });

  test("keeps the same concept in two bundles searchable and showable by qualified ref", async () => {
    const primaryPath = writeSharedConcept(storage.stashDir, "primary");
    const teamPath = writeSharedConcept(secondary.dir, "team");

    await akmIndex({ stashDir: storage.stashDir, full: true });

    const result = await akmSearch({ query: "crossbundlemarker", skipLogging: true });
    const refs = result.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : [])).sort();
    expect(refs).toEqual(["knowledge/shared", "team//knowledge/shared"]);
    expect(result.warnings).toContain(
      'Multiple bundles provide "knowledge/shared": primary, team. Unqualified refs resolve by configured bundle priority; use a bundle-qualified ref to select explicitly.',
    );

    const primary = await akmShowUnified({ ref: "primary//knowledge/shared", skipLogging: true });
    const team = await akmShowUnified({ ref: "team//knowledge/shared", skipLogging: true });
    expect({ ref: primary.ref, path: primary.path }).toEqual({
      ref: "knowledge/shared",
      path: primaryPath,
    });
    expect({ ref: team.ref, path: team.path }).toEqual({ ref: "team//knowledge/shared", path: teamPath });
  });

  test("an unresolvable configured provider preserves the prior bundle rows", async () => {
    writeSharedConcept(storage.stashDir, "primary");
    writeSharedConcept(secondary.dir, "team");
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const websiteSpy = spyOn(websiteProvider, "createWebsiteProvider").mockImplementation(unresolvableWebsite);
    try {
      writeSandboxConfig({
        semanticSearchMode: "off",
        bundles: {
          primary: { path: storage.stashDir, writable: true },
          team: { website: { url: "https://example.test/team" } },
        },
        defaultBundle: "primary",
      });
      resetConfigCache();

      await akmIndex({ stashDir: storage.stashDir });

      const result = await akmSearch({ query: "crossbundlemarker", skipLogging: true });
      const refs = result.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : [])).sort();
      expect(refs).toEqual(["knowledge/shared", "team//knowledge/shared"]);
    } finally {
      websiteSpy.mockRestore();
    }
  });

  test("a configured source moved to a missing path preserves the prior bundle rows", async () => {
    writeSharedConcept(storage.stashDir, "primary");
    writeSharedConcept(secondary.dir, "team");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const missing = path.join(storage.root, "missing-team");
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: {
        primary: { path: storage.stashDir, writable: true },
        team: { path: missing },
      },
      defaultBundle: "primary",
    });
    resetConfigCache();

    await akmIndex({ stashDir: storage.stashDir });

    const result = await akmSearch({ query: "crossbundlemarker", skipLogging: true });
    const refs = result.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : [])).sort();
    expect(refs).toEqual(["knowledge/shared", "team//knowledge/shared"]);
  });

  test("removing an ancestor source preserves rows owned by a still-configured nested bundle", async () => {
    const ancestor = secondary.dir;
    const nested = path.join(ancestor, ".nested-bundle");
    writeConcept(ancestor, "ancestor-only", "ancestorremovedmarker");
    writeConcept(nested, "nested-only", "nestedretainedmarker");
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: {
        primary: { path: storage.stashDir, writable: true },
        ancestor: { path: ancestor, writable: false },
        nested: { path: nested, writable: false },
      },
      defaultBundle: "primary",
    });
    resetConfigCache();
    await akmIndex({ stashDir: storage.stashDir, full: true });
    expect(indexedItemRefs()).toEqual(["ancestor//knowledge/ancestor-only", "nested//knowledge/nested-only"]);

    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: {
        primary: { path: storage.stashDir, writable: true },
        nested: { path: nested, writable: false },
      },
      defaultBundle: "primary",
    });
    resetConfigCache();
    await akmIndex({ stashDir: storage.stashDir });

    expect(indexedItemRefs()).toEqual(["nested//knowledge/nested-only"]);
  });

  for (const full of [false, true]) {
    test(`an unavailable bundle preserves only itself while healthy bundles reconcile (${full ? "full" : "incremental"})`, async () => {
      writeSharedConcept(storage.stashDir, "primary");
      writeSharedConcept(secondary.dir, "team");
      const removedPath = writeConcept(storage.stashDir, "removed", "removedhealthymarker");
      await akmIndex({ stashDir: storage.stashDir, full: true });

      writeConcept(storage.stashDir, "healthy", "healthyupdatedmarker");
      fs.rmSync(removedPath);
      const fresh = makeStashDir();
      writeConcept(fresh.dir, "new-source", "newhealthysourcemarker");

      const websiteSpy = spyOn(websiteProvider, "createWebsiteProvider").mockImplementation(unresolvableWebsite);
      try {
        writeSandboxConfig({
          semanticSearchMode: "off",
          bundles: {
            primary: { path: storage.stashDir, writable: true },
            team: { website: { url: "https://example.test/team" } },
            fresh: { path: fresh.dir },
          },
          defaultBundle: "primary",
        });
        resetConfigCache();

        await akmIndex({ stashDir: storage.stashDir, ...(full ? { full: true } : {}) });

        const updated = await akmSearch({ query: "healthyupdatedmarker", skipLogging: true });
        expect(
          updated.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : []).map((ref) => ref.split("#", 1)[0])),
        ).toContain("knowledge/healthy");
        const added = await akmSearch({ query: "newhealthysourcemarker", skipLogging: true });
        expect(
          added.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : []).map((ref) => ref.split("#", 1)[0])),
        ).toContain("fresh//knowledge/new-source");
        const preserved = await akmSearch({ query: "crossbundlemarker from team", skipLogging: true });
        expect(
          preserved.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : []).map((ref) => ref.split("#", 1)[0])),
        ).toContain("team//knowledge/shared");
        const removed = await akmSearch({ query: "removedhealthymarker", skipLogging: true });
        expect(
          removed.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : []).map((ref) => ref.split("#", 1)[0])),
        ).not.toContain("knowledge/removed");
      } finally {
        websiteSpy.mockRestore();
        fresh.cleanup();
      }
    });
  }

  test("an incomplete source preserves its snapshot while a healthy source updates", async () => {
    const blockedPath = writeConcept(secondary.dir, "blocked", "blockedsourceoldmarker");
    writeConcept(secondary.dir, "good", "incompletesourceoldmarker");
    const removedPath = writeConcept(secondary.dir, "removed", "incompleteremovedmarker");
    expect(spawnSync("git", ["init"], { cwd: secondary.dir }).status).toBe(0);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    writeConcept(secondary.dir, "good", "incompletesourcenewmarker");
    fs.rmSync(removedPath);
    writeConcept(storage.stashDir, "healthy", "healthywhileincompletemarker");

    // walkStashGit inspects entries with lstatSync so tracked symlinks are not
    // dereferenced; spy on that call to make the source look uninspectable.
    const originalLstatSync = fs.lstatSync;
    const statSpy = spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      if (path.resolve(String(target)) === path.resolve(blockedPath)) throw new Error("simulated stat failure");
      return originalLstatSync(target, options as never);
    }) as typeof fs.lstatSync);
    try {
      await akmIndex({ stashDir: storage.stashDir, full: true });
    } finally {
      statSpy.mockRestore();
    }

    const healthy = await akmSearch({ query: "healthywhileincompletemarker", skipLogging: true });
    expect(healthy.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : []).map((ref) => ref.split("#", 1)[0]))).toContain(
      "knowledge/healthy",
    );
    const old = await akmSearch({ query: "incompletesourceoldmarker", skipLogging: true });
    expect(old.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : []).map((ref) => ref.split("#", 1)[0]))).toContain(
      "team//knowledge/good",
    );
    const notPartiallyUpdated = await akmSearch({ query: "incompletesourcenewmarker", skipLogging: true });
    expect(
      notPartiallyUpdated.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : []).map((ref) => ref.split("#", 1)[0])),
    ).not.toContain("team//knowledge/good");
    const deferredRemoval = await akmSearch({ query: "incompleteremovedmarker", skipLogging: true });
    expect(
      deferredRemoval.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : []).map((ref) => ref.split("#", 1)[0])),
    ).toContain("team//knowledge/removed");

    await akmIndex({ stashDir: storage.stashDir });

    const updated = await akmSearch({ query: "incompletesourcenewmarker", skipLogging: true });
    expect(updated.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : []).map((ref) => ref.split("#", 1)[0]))).toContain(
      "team//knowledge/good",
    );
    const removed = await akmSearch({ query: "incompleteremovedmarker", skipLogging: true });
    expect(
      removed.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : []).map((ref) => ref.split("#", 1)[0])),
    ).not.toContain("team//knowledge/removed");
  });

  test("an escaping default component root is unresolved and never scanned", async () => {
    const bundleRoot = path.join(storage.root, "escaping-bundle");
    fs.mkdirSync(bundleRoot, { recursive: true });
    fs.writeFileSync(
      path.join(storage.root, "outside-secret.md"),
      "---\ntype: knowledge\ndescription: escapedrootscanmarker\n---\n\nOutside bundle content.\n",
      "utf8",
    );
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "escaping",
      bundles: {
        escaping: { path: bundleRoot, components: { main: { root: "..", adapter: "okf" } } },
      },
    });
    resetConfigCache();

    await akmIndex({ stashDir: storage.stashDir, full: true });

    const result = await akmSearch({ query: "escapedrootscanmarker", skipLogging: true });
    expect(result.hits).toEqual([]);
  });

  test("an existing unresolved placeholder cannot wipe the prior source snapshot", async () => {
    const bundleRoot = path.join(storage.root, "escaping-placeholder-bundle");
    fs.mkdirSync(bundleRoot, { recursive: true });
    fs.writeFileSync(
      path.join(bundleRoot, "retained.md"),
      "---\ntype: knowledge\ndescription: unresolvedplaceholderretainedmarker\n---\n\nRetain me.\n",
      "utf8",
    );
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "escaping",
      bundles: {
        escaping: { path: bundleRoot, components: { main: { root: ".", adapter: "okf" } } },
      },
    });
    resetConfigCache();
    await akmIndex({ stashDir: bundleRoot, full: true });

    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "escaping",
      bundles: {
        escaping: { path: bundleRoot, components: { main: { root: "..", adapter: "okf" } } },
      },
    });
    resetConfigCache();
    const unresolvedPath = path.join(getUnresolvedSourcesDir(bundleRoot), "escaping");
    fs.mkdirSync(unresolvedPath, { recursive: true });
    await akmIndex({ stashDir: unresolvedPath, full: true });

    const retained = await akmSearch({ query: "unresolvedplaceholderretainedmarker", skipLogging: true });
    expect(retained.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : []))).toContain("retained");
  });
});
