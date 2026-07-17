// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-2.1 — parity tests for the `wiki` `BundleAdapter`
 * (`src/core/adapter/adapters/wiki-adapter.ts`) against the Chunk 0b
 * goldens (`tests/fixtures/goldens/{recognition,placement,lint}/all-types.json`).
 * See `skill-adapter.test.ts`'s header for the shared byte-for-byte-parity
 * rationale.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { wikiAdapter } from "../../../src/core/adapter/adapters/wiki-adapter";
import type { BundleComponent } from "../../../src/core/adapter/types";
import { buildFileContext } from "../../../src/indexer/walk/file-context";
import { makeFsValidateContext } from "./_helpers/validate-context";

const ALL_TYPES_ROOT = path.resolve(__dirname, "../../fixtures/stashes/all-types");
const WIKIS_ROOT = path.join(ALL_TYPES_ROOT, "wikis");

const RECOGNITION_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/recognition/all-types.json"), "utf8"),
);
const PLACEMENT_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/placement/all-types.json"), "utf8"),
);
const LINT_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/lint/all-types.json"), "utf8"),
);

const WIKI_REL_PATH = "wikis/all-types-space/all-types-wiki.md";

function wikisComponent(): BundleComponent {
  return { id: "wikis", adapter: "wiki", root: WIKIS_ROOT, writable: true };
}

describe("wiki adapter — recognition parity vs recognition/all-types.json", () => {
  test("recognizes wikis/all-types-space/all-types-wiki.md as type wiki", () => {
    const component = wikisComponent();
    const file = buildFileContext(WIKIS_ROOT, path.join(ALL_TYPES_ROOT, WIKI_REL_PATH));
    const doc = wikiAdapter.recognize(component, file);
    expect(doc).not.toBeNull();
    expect(doc?.type).toBe(RECOGNITION_GOLDEN.byRelPath[WIKI_REL_PATH].type);
    expect(doc?.adapterId).toBe("wiki");
    expect(doc?.conceptId).toBe("all-types-space/all-types-wiki");
  });

  // NOTE on methodology, why wiki has no "abstains on every OTHER all-types
  // fixture file" cross-type test (unlike skill-adapter.test.ts /
  // script-adapter.test.ts, which both have one): `scanComponent`
  // (src/core/adapter/scan-component.ts) walks ONE component's root per
  // adapter ("no per-file competition", types.ts's `BundleComponent.id` doc
  // comment) — in production the wiki adapter is only ever handed files
  // rooted AT wikis/, never at an unrelated type's directory, so a file from
  // e.g. skills/ can never reach `wikiAdapter.recognize` at all. Unlike
  // skill (fileName === "SKILL.md", a globally unique marker) and script
  // (a fixed extension set), wiki's root-relative condition ("nested at
  // least one level under the component root") is POSITIONAL, not
  // identity-based — by construction it cannot structurally distinguish "a
  // wiki page" from "any other type's file that also happens to sit one
  // level deep under ITS OWN mount root" (e.g. `skills/<name>/SKILL.md` has
  // the exact same one-level-nested shape). That is not a bug: component
  // MOUNTING (which root gets walked for which adapter) is what enforces
  // isolation for a positional adapter like this one, not `recognize()`
  // itself — exactly what `looks-like-root.test.ts`'s D2-6 conformance gate
  // verifies at the mounting level instead.
  test("a wikis/<page>.md file with no namespace subdirectory is NOT claimed (root-relative translation of matchers.ts:258's idx+1 >= ancestorDirs.length branch)", () => {
    const component = wikisComponent();
    // Simulated: a .md file directly at the wikis/ component root (no
    // "<space>/" segment) — ancestorDirs relative to WIKIS_ROOT is [].
    const file = buildFileContext(WIKIS_ROOT, path.join(WIKIS_ROOT, "bare-page.md"));
    // buildFileContext only derives path-shape fields eagerly (no disk read
    // for this check) — recognize() must abstain purely from the
    // ancestorDirs shape, never reaching file.content().
    expect(wikiAdapter.recognize(component, file)).toBeNull();
  });

  test("a non-.md file nested under the wikis/ component root is NOT claimed", () => {
    const component = wikisComponent();
    const file = buildFileContext(WIKIS_ROOT, path.join(WIKIS_ROOT, "all-types-space", "diagram.png"));
    expect(wikiAdapter.recognize(component, file)).toBeNull();
  });
});

describe("wiki adapter — placement parity vs placement/all-types.json", () => {
  test("placeNew reproduces markdownSpec placement for a namespaced wiki page", () => {
    const golden = PLACEMENT_GOLDEN.byType.wiki;
    expect(golden.stashDir).toBe("wikis");
    const component: BundleComponent = {
      id: "wikis",
      adapter: "wiki",
      root: path.join(ALL_TYPES_ROOT, golden.stashDir),
      writable: true,
    };
    const result = wikiAdapter.placeNew?.(component, golden.name);
    expect(result).toBeDefined();
    const relResult = path
      .relative(ALL_TYPES_ROOT, result as string)
      .split(path.sep)
      .join("/");
    expect(relResult).toBe(golden.assetPath);
  });

  test("placeNew is idempotent for an already-.md-suffixed conceptId (markdownSpec shared edge case)", () => {
    const golden = PLACEMENT_GOLDEN.edgeCases.markdownSpecAlreadySuffixedNameIsIdempotent;
    const component: BundleComponent = { id: "wikis", adapter: "wiki", root: WIKIS_ROOT, writable: true };
    const result = wikiAdapter.placeNew?.(component, "all-types-wiki.md");
    expect(result).toBe(path.join(WIKIS_ROOT, "all-types-wiki.md"));
    // golden.type is "command" (the markdownSpec-family case it happens to be
    // captured under) — confirms the SHARED markdownSpec behavior wiki also
    // implements, not a wiki-specific golden entry.
    expect(golden.type).toBe("command");
  });
});

describe("wiki adapter — validate() parity vs lint/all-types.json perType.wiki (DefaultLinter-equivalent, D2-3)", () => {
  test("validate() returns [] for the lint-clean fixture wiki page (matches perType.wiki.issues, linterUsed: DefaultLinter)", async () => {
    const golden = LINT_GOLDEN.perType.wiki;
    expect(golden.issues).toEqual([]);
    expect(golden.linterUsed).toBe("DefaultLinter");

    const component = wikisComponent();
    const raw = fs.readFileSync(path.join(ALL_TYPES_ROOT, WIKI_REL_PATH), "utf8");
    const ctx = makeFsValidateContext(WIKIS_ROOT);
    const diagnostics = await wikiAdapter.validate(
      component,
      [{ path: "all-types-space/all-types-wiki.md", op: "update", after: raw }],
      ctx,
    );
    expect(diagnostics).toEqual([]);
  });
});
