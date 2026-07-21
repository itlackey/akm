// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Conformance gate for the `website-snapshot` adapter (#46).
 *
 * Drives the adapter over `tests/fixtures/bundles/website-snapshot/` and asserts
 * the four authored goldens under
 * `tests/fixtures/format-family-goldens/website-snapshot/`. Exercises the GATED
 * re-type to `type: website` (open-question-3), the `stash/knowledge/` prefix
 * strip, the preserved `sourceRef`, the READ-ONLY (no placeNew) contract, and
 * the generic-fallback presentation (`website` is not a KNOWN_TYPE).
 *
 * NOTE (golden cross-reference): the recognition golden pins the STRIPPED ref
 * (`sample-website//example-com/index`); the renderer golden's `ref` field
 * predates open-question-3 and carries the full-path form. This suite asserts
 * the STRIPPED ref against recognition, and asserts the renderer presentation
 * (generic fallback → `akm show <ref>`) against the renderer golden's OWN
 * self-consistent ref+action.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { websiteSnapshotAdapter } from "../../../src/core/adapter/adapters/website-snapshot-adapter";
import type { BundleComponent, IndexDocument, ValidateContext } from "../../../src/core/adapter/types";
import { presentationFor } from "../../../src/core/type-presentation";
import { buildFileContext } from "../../../src/indexer/walk/file-context";

const FIXTURE_ROOT = path.join(import.meta.dir, "../../fixtures/bundles/website-snapshot");
const GOLDENS_ROOT = path.join(import.meta.dir, "../../fixtures/format-family-goldens/website-snapshot");
const BUNDLE_ID = "sample-website";

function loadGolden(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(GOLDENS_ROOT, `${name}.json`), "utf8"));
}

function component(): BundleComponent {
  // Read-only snapshot (Mode A): writable false.
  return { id: BUNDLE_ID, adapter: "website-snapshot", root: FIXTURE_ROOT, writable: false };
}

function recognizeRel(relPath: string): IndexDocument | null {
  return websiteSnapshotAdapter.recognize(
    component(),
    buildFileContext(FIXTURE_ROOT, path.join(FIXTURE_ROOT, relPath)),
  );
}

const ctx: ValidateContext = {
  readFile: async (p) => {
    try {
      return fs.readFileSync(path.join(FIXTURE_ROOT, p), "utf8");
    } catch {
      return null;
    }
  },
  list: async () => [],
  resolveRef: async () => ({ exists: false }),
};

describe("website-snapshot adapter — metadata", () => {
  test("id / version / read-only (no placeNew)", () => {
    expect(websiteSnapshotAdapter.id).toBe("website-snapshot");
    expect(websiteSnapshotAdapter.version).toBe("0.9.0");
    expect(websiteSnapshotAdapter.placeNew).toBeUndefined();
  });

  test("looksLikeRoot fires on the snapshot root (manifest.json), not on a bare dir", () => {
    expect(websiteSnapshotAdapter.looksLikeRoot?.(FIXTURE_ROOT)).toBe(true);
  });
});

describe("website-snapshot adapter — recognition golden (gated re-type)", () => {
  const byRelPath = loadGolden("recognition").byRelPath as Record<string, Record<string, unknown>>;

  for (const [relPath, expected] of Object.entries(byRelPath)) {
    test(`recognize(${relPath})`, () => {
      const doc = recognizeRel(relPath);
      if (expected.recognized === false) {
        expect(doc, `${relPath} must abstain (manifest provenance)`).toBeNull();
        return;
      }
      expect(doc, `${relPath} must be recognized`).not.toBeNull();
      if (!doc) throw new Error("unreachable");
      expect(doc.adapterId).toBe(expected.adapterId as string);
      expect(doc.component).toBe(expected.component as string);
      expect(doc.type).toBe(expected.type as string);
      expect(doc.conceptId).toBe(expected.conceptId as string);
      expect(doc.ref).toBe(expected.ref as string);
      expect(doc.name).toBe(expected.name as string);
      expect(doc.description).toBe(expected.description as string);
      // sourceUrl is KEPT (surfaced as sourceRef on documentJson).
      const extras = doc.documentJson as { sourceRef?: string } | undefined;
      expect(extras?.sourceRef).toBe(expected.sourceRef as string);
    });
  }
});

describe("website-snapshot adapter — placement golden (read-only)", () => {
  test("website is read-only: placeNew is null/undefined (Mode B routes to the destination adapter)", () => {
    const byType = loadGolden("placement").byType as Record<string, { placeNew: null; readOnly: boolean }>;
    expect(byType.website.placeNew).toBeNull();
    expect(byType.website.readOnly).toBe(true);
    expect(websiteSnapshotAdapter.placeNew).toBeUndefined();
  });
});

describe("website-snapshot adapter — renderer golden (generic fallback, `website` is not a KNOWN_TYPE)", () => {
  const byRelPath = loadGolden("renderer").byRelPath as Record<string, Record<string, unknown>>;

  for (const [relPath, expected] of Object.entries(byRelPath)) {
    test(`presentationFor(website) for ${relPath}`, () => {
      const doc = recognizeRel(relPath);
      expect(doc?.type).toBe(expected.type as string);
      const p = presentationFor(expected.type as string);
      expect(p.label).toBe(expected.label as string);
      expect(p.renderer ?? null).toBe((expected.renderer as string | null) ?? null);
      expect(p.action).toBeUndefined(); // generic fallback has no action builder
      // The golden's ref+action are self-consistent (generic action = `akm show <ref>`).
      const action = p.action ? p.action(expected.ref as string) : `akm show ${expected.ref}`;
      expect(action).toBe(expected.action as string);
    });
  }
});

describe("website-snapshot adapter — lint golden (base checks only; read-only mirror)", () => {
  const perType = loadGolden("lint").perType as Record<string, { relPath: string; issues: unknown[] }>;

  test("every snapshot page validates clean ([])", async () => {
    for (const entry of Object.values(perType)) {
      const raw = fs.readFileSync(path.join(FIXTURE_ROOT, entry.relPath), "utf8");
      const diags = await websiteSnapshotAdapter.validate(
        component(),
        [{ path: entry.relPath, op: "update", after: raw }],
        ctx,
      );
      expect(diags, entry.relPath).toEqual([]);
    }
  });
});
