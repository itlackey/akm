// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Meta-test for the X4 repository-owns-SQL boundary guard
 * (`scripts/lint-repository-sql.ts`).
 *
 * Pins two things together: (1) the live `src/` tree is clean — registry and
 * workflow-runtime never reach into DB internals — so the ratchet baseline is 0;
 * and (2) the guard actually fires on the inversions it is meant to prevent
 * (direct DB-owner import + direct database open), so it can never silently
 * degrade into a no-op.
 */

import { describe, expect, test } from "bun:test";
import { lintContent, lintRepositorySql } from "../../scripts/lint-repository-sql";

describe("lint-repository-sql (X4 boundary ratchet)", () => {
  test("the live src tree has zero repository-boundary violations", () => {
    const violations = lintRepositorySql();
    if (violations.length > 0) {
      throw new Error(
        `repository-boundary violations:\n${violations.map((v) => `${v.file}:${v.line} [${v.ruleId}]`).join("\n")}`,
      );
    }
    expect(violations.length).toBe(0);
  });

  test("flags a direct DB-owner import in a guarded subsystem", () => {
    const v = lintContent(
      "src/registry/providers/example.ts",
      'import { openExistingDatabase } from "../../../indexer/db/db";',
    );
    expect(v.map((x) => x.ruleId)).toContain("db-owner-import");
  });

  test("flags a direct state-db import in workflow runtime", () => {
    const v = lintContent("src/workflows/runtime/example.ts", 'import { withStateDb } from "../../../core/state-db";');
    expect(v.map((x) => x.ruleId)).toContain("db-owner-import");
  });

  test("flags a direct database open in a guarded subsystem", () => {
    const v = lintContent("src/registry/providers/example.ts", "const db = openIndexDatabase();");
    expect(v.map((x) => x.ruleId)).toContain("db-open-call");
  });

  test("does NOT flag the same patterns outside guarded subsystems", () => {
    // Command/indexer modules legitimately open index.db — only registry +
    // workflow-runtime are guarded.
    const cmd = lintContent("src/commands/improve/preparation.ts", "const db = openExistingDatabase();");
    expect(cmd.length).toBe(0);
  });

  test("does NOT flag prose mentioning the names in comments/strings", () => {
    const v = lintContent(
      "src/registry/providers/example.ts",
      "// registry must not call openExistingDatabase or import indexer/db directly\nconst note = 'openIndexDatabase';",
    );
    expect(v.length).toBe(0);
  });
});
