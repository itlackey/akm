// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the `initIndexer()` composition root (audit M1/M2,
 * `docs/technical/code-health-brittleness-audit.md`).
 *
 * `initIndexer()` replaces the two ad-hoc lazy `builtinsPromise` gates that
 * previously lived in `walk/file-context.ts` and `passes/metadata-contributors.ts`.
 * These tests prove that a single call wires the built-in renderer set AND the
 * metadata contributors and that the call is idempotent. (Recognition is no
 * longer registry-driven — the chunk-3 cutover moved it to the akm adapter's
 * synchronous `recognizeMatch()`, so init no longer registers matchers.)
 */

import { describe, expect, test } from "bun:test";

import { initIndexer } from "../../../src/indexer/init";
import { getMetadataContributors } from "../../../src/indexer/passes/metadata-contributors";
import { getAllRenderers, getRenderer } from "../../../src/indexer/walk/file-context";

describe("initIndexer composition root", () => {
  test("registers BOTH builtin sets after init (renderers + metadata contributors)", async () => {
    await initIndexer();

    // Renderer set: the 12 built-in renderers must be present.
    const renderers = await getAllRenderers();
    expect(renderers.length).toBeGreaterThanOrEqual(12);
    // Spot-check a representative renderer from each registration source.
    expect(await getRenderer("skill-md")).toBeDefined();
    expect(await getRenderer("workflow-md")).toBeDefined();

    // Metadata-contributor set: renderer-owned + the workflow contributor.
    const contributors = await getMetadataContributors();
    const names = contributors.map((c) => c.name);
    expect(names).toContain("toc-metadata");
    expect(names).toContain("workflow-document-metadata");
  });

  test("is idempotent: repeated calls do not duplicate registrations", async () => {
    await initIndexer();
    const renderersAfterFirst = (await getAllRenderers()).length;
    const contributorsAfterFirst = (await getMetadataContributors()).length;

    // Call several more times, including concurrently.
    await initIndexer();
    await Promise.all([initIndexer(), initIndexer(), initIndexer()]);

    expect((await getAllRenderers()).length).toBe(renderersAfterFirst);
    expect((await getMetadataContributors()).length).toBe(contributorsAfterFirst);
  });

  test("returns the same shared promise (single registration run)", async () => {
    const a = initIndexer();
    const b = initIndexer();
    expect(a).toBe(b);
    await Promise.all([a, b]);
  });
});
