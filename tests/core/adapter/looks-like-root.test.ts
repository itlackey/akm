// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-2.1 — `looksLikeRoot` conformance (D2-6, chunk-2 anchors.md §B.7/§D.2):
 * each adapter's `looksLikeRoot(root)` must fire on its OWN single-adapter
 * golden root and NOT on any sibling adapter's root.
 *
 * No per-adapter root-probe concept existed before this chunk (anchors.md
 * §B.7: the only two prior install-time probes, `detectStashRoot`/
 * `hasExtractedRepo`, are coarse "any of the 14 type dirs" checks with zero
 * per-type distinction) — so there was no golden to reproduce and no
 * existing fixture shaped for this gate (the combined
 * `tests/fixtures/stashes/all-types/` fixture contains every type's
 * directory at once, which would make every adapter's naive
 * `directoryList()`-presence probe fire simultaneously — the OPPOSITE of
 * what "no sibling's" must prove). This suite exercises the 3 new,
 * minimal, single-adapter-only root fixtures this WI adds under
 * `tests/fixtures/stashes/{skill,wiki,script}-only-root/`.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { scriptAdapter } from "../../../src/core/adapter/adapters/script-adapter";
import { skillAdapter } from "../../../src/core/adapter/adapters/skill-adapter";
import { wikiAdapter } from "../../../src/core/adapter/adapters/wiki-adapter";

const STASHES_ROOT = path.resolve(__dirname, "../../fixtures/stashes");
const SKILL_ONLY_ROOT = path.join(STASHES_ROOT, "skill-only-root");
const WIKI_ONLY_ROOT = path.join(STASHES_ROOT, "wiki-only-root");
const SCRIPT_ONLY_ROOT = path.join(STASHES_ROOT, "script-only-root");

const ADAPTERS = [skillAdapter, wikiAdapter, scriptAdapter] as const;
const GOLDEN_ROOTS: Record<string, string> = {
  skill: SKILL_ONLY_ROOT,
  wiki: WIKI_ONLY_ROOT,
  script: SCRIPT_ONLY_ROOT,
};

describe("looksLikeRoot — fires on its own golden root, not on any sibling's (D2-6)", () => {
  for (const ownerId of Object.keys(GOLDEN_ROOTS)) {
    test(`${ownerId}-only-root: exactly the ${ownerId} adapter's looksLikeRoot fires`, () => {
      const root = GOLDEN_ROOTS[ownerId];
      const firing = ADAPTERS.filter((a) => a.looksLikeRoot?.(root) === true).map((a) => a.id);
      expect(firing).toEqual([ownerId]);
    });
  }

  test("a nonexistent root: no adapter's looksLikeRoot fires", () => {
    const root = path.join(STASHES_ROOT, "definitely-does-not-exist-akm-wi-2-1");
    for (const adapter of ADAPTERS) {
      expect(adapter.looksLikeRoot?.(root)).toBe(false);
    }
  });

  test("the combined all-types fixture is deliberately the WRONG shape for this gate: all 3 fire at once (documents why single-adapter roots were needed, anchors.md §D.2)", () => {
    const allTypesRoot = path.join(STASHES_ROOT, "all-types");
    const firing = ADAPTERS.filter((a) => a.looksLikeRoot?.(allTypesRoot) === true).map((a) => a.id);
    expect(firing.sort()).toEqual(["script", "skill", "wiki"]);
  });
});
