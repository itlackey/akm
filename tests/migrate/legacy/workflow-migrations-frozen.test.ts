// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Chunk-8 WI-8.1 — the frozen `{ id, checksum }` copy of the workflow.db
 * ledger (`src/migrate/legacy/workflow-migrations-frozen.ts`, plan §3.3
 * item 1 / §8.2).
 *
 * Two groups, mirroring `legacy-layout.test.ts`'s conventions:
 *
 *   1. **Self-containment** — the frozen module's raw source imports NOTHING
 *      from `src/workflows/` (it must survive that directory's WI-8.3
 *      deletion); its only `src/` import is the shared-engine TYPE.
 *   2. **Faithfulness** — the frozen literals EQUAL the live
 *      `WORKFLOW_MIGRATIONS` array's computed checksums, id-for-id in order.
 *      WI-8.3 NOTE: when `src/workflows/db.ts` is deleted, this group is
 *      rewritten to pin the frozen literals alone (count, id shape, hex
 *      shape) — the live cross-check dies with the live array.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { WORKFLOW_MIGRATIONS_CHECKSUMS } from "../../../src/migrate/legacy/workflow-migrations-frozen";
import { migrationChecksum } from "../../../src/storage/engines/sqlite-migrations";
import { WORKFLOW_MIGRATIONS } from "../../../src/workflows/db";

const FROZEN_PATH = path.resolve(__dirname, "../../../src/migrate/legacy/workflow-migrations-frozen.ts");

describe("workflow-migrations-frozen — self-containment", () => {
  test("imports nothing from src/workflows/ and only the engine type from src/", () => {
    const source = fs.readFileSync(FROZEN_PATH, "utf8");
    const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    for (const line of importLines) {
      expect(line).not.toMatch(/workflows\//);
    }
    // The single allowed src/ dependency: the shared-engine SealedMigration TYPE.
    const relativeImports = importLines.filter((line) => /from\s+"\.\.?\//.test(line));
    expect(relativeImports.length).toBe(1);
    expect(relativeImports[0]).toMatch(/^import type .*sqlite-migrations/);
  });
});

describe("workflow-migrations-frozen — faithfulness to the live ledger", () => {
  test("frozen ids+checksums equal the live WORKFLOW_MIGRATIONS computed checksums, in order", () => {
    const live = WORKFLOW_MIGRATIONS.map((m) => ({ id: m.id, checksum: migrationChecksum(m) }));
    expect(WORKFLOW_MIGRATIONS_CHECKSUMS.map((e) => ({ id: e.id, checksum: e.checksum }))).toEqual(live);
  });

  test("exactly the 10 pre-cutover ids, 001 through 010, unique and ordered", () => {
    const ids = WORKFLOW_MIGRATIONS_CHECKSUMS.map((e) => e.id);
    expect(ids.length).toBe(10);
    expect(new Set(ids).size).toBe(10);
    expect(ids[0]).toBe("001-add-scope-key");
    expect(ids[9]).toBe("010-ir-v3-engine");
    for (const [index, id] of ids.entries()) {
      expect(id.startsWith(String(index + 1).padStart(3, "0"))).toBe(true);
    }
  });

  test("every checksum is a 64-char lowercase sha256 hex literal", () => {
    for (const entry of WORKFLOW_MIGRATIONS_CHECKSUMS) {
      expect(entry.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
