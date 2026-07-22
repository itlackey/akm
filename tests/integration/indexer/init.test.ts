// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the `initIndexer()` composition root (findings M1/M2 of the
 * 2026-06 code-health brittleness audit).
 *
 * `initIndexer()` replaces the ad-hoc lazy `builtinsPromise` gate that
 * previously lived in `walk/file-context.ts`. These tests prove that a single
 * call wires the built-in renderer set and that the call is idempotent.
 * (Recognition and index-time metadata are no longer registry-driven — the
 * chunk-3 cutover moved recognition to the akm adapter's synchronous
 * `recognizeMatch()`, and the metadata fold lives inline in the adapter's
 * `recognize`, so init only registers renderers.)
 */

import { describe, expect, test } from "bun:test";

import { initIndexer } from "../../../src/indexer/init";
import { getAllRenderers, getRenderer } from "../../../src/indexer/walk/file-context";

describe("initIndexer composition root", () => {
  test("registers the builtin renderer set after init", async () => {
    await initIndexer();

    // Renderer set: the 12 built-in renderers must be present.
    const renderers = await getAllRenderers();
    expect(renderers.length).toBeGreaterThanOrEqual(12);
    // Spot-check a representative renderer from each registration source.
    expect(await getRenderer("skill-md")).toBeDefined();
    expect(await getRenderer("workflow-md")).toBeDefined();
  });

  test("is idempotent: repeated calls do not duplicate registrations", async () => {
    await initIndexer();
    const renderersAfterFirst = (await getAllRenderers()).length;

    // Call several more times, including concurrently.
    await initIndexer();
    await Promise.all([initIndexer(), initIndexer(), initIndexer()]);

    expect((await getAllRenderers()).length).toBe(renderersAfterFirst);
  });

  test("returns the same shared promise (single registration run)", async () => {
    const a = initIndexer();
    const b = initIndexer();
    expect(a).toBe(b);
    await Promise.all([a, b]);
  });
});
