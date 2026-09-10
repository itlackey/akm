// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #882 follow-up regression: fixing the memory `.derived`-twin duality (a
 * base memory ref that has both `<name>.md` and `<name>.derived.md` must
 * resolve to the PLAIN file with no throw) must NOT extend the same
 * "silently pick the declared winner" treatment to env's `.env`/`default.env`
 * duality — those are two independently-authored files that happen to
 * collide on one ref (`assetPathCandidatesForName`'s own doc comment states
 * an ordered winner only for memory's twin, never for env's alias), so both
 * existing together must keep throwing a physical-owner collision.
 *
 * A first pass at the #882 fix regressed exactly this: it attached a
 * declared-preference `priority` to EVERY multi-candidate akm-adapter
 * placement type, env included. That turned a loud, correct collision into a
 * confusing "not found" — the resolver silently picked `.env` as the sole
 * owner, but the index had only indexed (and could only find an entry id
 * for) `default.env`, so `show`'s downstream id lookup came up empty and
 * `NotFoundError` fired instead of `AdapterConceptCollisionError`. This test
 * exercises the FULL `akm index --full` → `akm show` path (not just the
 * resolver in isolation) specifically because that id-lookup mismatch only
 * shows up once the index is involved — a resolver-only assertion would not
 * have caught it. See tests/core/adapter/adapter-concept-owner.test.ts for
 * the resolver-level pin of the same case (both modes, "akm" adapter).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { showLocal } from "../../src/commands/read/show";
import { resetConfigCache } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { AdapterConceptCollisionError } from "../../src/indexer/lookup/adapter-concept-owner";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ semanticSearchMode: "off" });
  resetConfigCache();
});

afterEach(() => storage.cleanup());

function write(relativePath: string, content: string): string {
  const target = path.join(storage.stashDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

describe("env/default duality (.env vs default.env) is a genuine collision, not a #882 declared preference", () => {
  test("akm show env/default with BOTH .env and default.env present throws a physical-owner collision, not a false 'not found'", async () => {
    write("env/.env", "TOKEN=dot_form\n");
    write("env/default.env", "TOKEN=named_form\n");

    await akmIndex({ stashDir: storage.stashDir, full: true });

    let caught: unknown;
    try {
      await showLocal({ ref: "env/default" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdapterConceptCollisionError);
    expect((caught as Error).message).toMatch(/multiple physical owners/i);
    expect((caught as { code?: string }).code).toBe("RESOURCE_ALREADY_EXISTS");
  });

  test("akm show env/default with only ONE spelling present still resolves normally (no regression to single-file lookup)", async () => {
    const dotEnv = write("env/.env", "TOKEN=only_dot_form\n");

    await akmIndex({ stashDir: storage.stashDir, full: true });

    const result = await showLocal({ ref: "env/default" });
    expect(result.path).toBe(dotEnv);
  });
});
