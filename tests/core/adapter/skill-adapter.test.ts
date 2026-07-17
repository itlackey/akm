// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-2.1 — parity tests for the `skill` `BundleAdapter`
 * (`src/core/adapter/adapters/skill-adapter.ts`) against the Chunk 0b
 * goldens (`tests/fixtures/goldens/{recognition,placement,lint}/all-types.json`).
 * Byte-for-byte parity is the gate (chunk-2 brief trap #1): the goldens are
 * read directly off disk (not re-derived) so this suite fails if the
 * adapter's output ever drifts from the frozen, sha256-pinned oracle.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { skillAdapter } from "../../../src/core/adapter/adapters/skill-adapter";
import type { BundleComponent } from "../../../src/core/adapter/types";
import { buildFileContext } from "../../../src/indexer/walk/file-context";
import { walkStashFlat } from "../../../src/indexer/walk/walker";
import { makeFsValidateContext } from "./_helpers/validate-context";

const ALL_TYPES_ROOT = path.resolve(__dirname, "../../fixtures/stashes/all-types");
const SKILLS_ROOT = path.join(ALL_TYPES_ROOT, "skills");

const RECOGNITION_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/recognition/all-types.json"), "utf8"),
);
const PLACEMENT_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/placement/all-types.json"), "utf8"),
);
const LINT_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/lint/all-types.json"), "utf8"),
);

const SKILL_REL_PATH = "skills/all-types-skill/SKILL.md";

function skillsComponent(): BundleComponent {
  return { id: "skills", adapter: "skill", root: SKILLS_ROOT, writable: true };
}

describe("skill adapter — recognition parity vs recognition/all-types.json", () => {
  test(
    "recognizes skills/all-types-skill/SKILL.md as type skill (golden: " +
      RECOGNITION_GOLDEN.byRelPath[SKILL_REL_PATH].type +
      ")",
    () => {
      const component = skillsComponent();
      const file = buildFileContext(SKILLS_ROOT, path.join(ALL_TYPES_ROOT, SKILL_REL_PATH));
      const doc = skillAdapter.recognize(component, file);
      expect(doc).not.toBeNull();
      expect(doc?.type).toBe(RECOGNITION_GOLDEN.byRelPath[SKILL_REL_PATH].type);
      expect(doc?.adapterId).toBe("skill");
      expect(doc?.conceptId).toBe("all-types-skill");
      expect(doc?.path).toBe(path.join(ALL_TYPES_ROOT, SKILL_REL_PATH));
    },
  );

  test("abstains (returns null) on every other all-types fixture file", () => {
    const component = skillsComponent();
    const files = walkStashFlat(ALL_TYPES_ROOT).filter(
      (f) => f.relPath !== SKILL_REL_PATH && f.relPath !== "MANIFEST.json",
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      // recognize() is defined purely over FileContext shape fields
      // (fileName/ext/parentDir/ancestorDirs), which are relative-to-root —
      // rebuild a FileContext rooted at SKILLS_ROOT is meaningless for
      // non-skill files, so instead confirm the raw file (rooted at its own
      // stash) still abstains: skill's isSkillFile() predicate never fires
      // on a file that isn't named SKILL.md / under a skills/ parent.
      const doc = skillAdapter.recognize(component, file);
      expect(doc, `expected skill adapter to abstain on ${file.relPath}`).toBeNull();
    }
  });
});

describe("skill adapter — placement parity vs placement/all-types.json", () => {
  test("placeNew reproduces the dir-entry SKILL.md placement", () => {
    const golden = PLACEMENT_GOLDEN.byType.skill;
    expect(golden.stashDir).toBe("skills");
    const component: BundleComponent = {
      id: "skills",
      adapter: "skill",
      root: path.join(ALL_TYPES_ROOT, golden.stashDir),
      writable: true,
    };
    const result = skillAdapter.placeNew?.(component, golden.name);
    expect(result).toBeDefined();
    const relResult = path
      .relative(ALL_TYPES_ROOT, result as string)
      .split(path.sep)
      .join("/");
    expect(relResult).toBe(golden.assetPath);
  });
});

describe("skill adapter — validate() parity vs lint/all-types.json perType.skill", () => {
  test("validate() returns [] for the lint-clean fixture SKILL.md (matches perType.skill.issues + lintDirectoryIssues)", async () => {
    const golden = LINT_GOLDEN.perType.skill;
    expect(golden.issues).toEqual([]);
    expect(golden.lintDirectoryIssues).toEqual([]);

    const component = skillsComponent();
    const raw = fs.readFileSync(path.join(ALL_TYPES_ROOT, SKILL_REL_PATH), "utf8");
    const ctx = makeFsValidateContext(SKILLS_ROOT);
    const diagnostics = await skillAdapter.validate(
      component,
      [{ path: "all-types-skill/SKILL.md", op: "update", after: raw }],
      ctx,
    );
    expect(diagnostics).toEqual([]);
  });

  test("validate() flags missing-skill-md when a skill directory's SKILL.md is absent", async () => {
    const component = skillsComponent();
    const ctx = makeFsValidateContext(SKILLS_ROOT);
    // A change to a file inside a skill directory that has no SKILL.md on
    // disk (readFile("no-skill-md/SKILL.md") resolves to null under
    // SKILLS_ROOT — there is no such directory in the fixture).
    const diagnostics = await skillAdapter.validate(
      component,
      [{ path: "no-skill-md/notes.md", op: "update", after: "# notes\n" }],
      ctx,
    );
    expect(diagnostics).toEqual([
      { file: "no-skill-md", issue: "missing-skill-md", detail: "no SKILL.md in no-skill-md/", fixed: false },
    ]);
  });
});
