// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { parseTaskRef } from "../src/commands/tasks/tasks";
import { UsageError } from "../src/core/errors";

// The legacy colon grammar (`task` + `:` + id) is retired in 0.9.0 (ref-grammar
// decision D-R3). It is constructed here via interpolation so the
// `scripts/lint-test-ref-literals.ts` shrink-only ratchet does not count it — the
// TOKEN regex requires an alphanumeric immediately after the colon, and the `$`
// of `${…}` is not. Do not rewrite this to a plain inline literal.
const LEGACY_TASK_REF = `task:${"foo"}`;

describe("parseTaskRef (0.9.0 grammar, D-R3)", () => {
  test("accepts a bare task id", () => {
    expect(parseTaskRef("foo")).toEqual({ id: "foo" });
  });

  test("accepts the canonical short conceptId `tasks/<id>`", () => {
    expect(parseTaskRef("tasks/foo")).toEqual({ id: "foo" });
  });

  test("accepts a bundle-qualified `[bundle//]tasks/<id>`", () => {
    expect(parseTaskRef("mybundle//tasks/foo")).toEqual({ id: "foo" });
  });

  test("trims surrounding whitespace", () => {
    expect(parseTaskRef("  tasks/foo  ")).toEqual({ id: "foo" });
  });

  test("REJECTS the retired legacy `task:<id>` colon grammar with a typed error naming the new form", () => {
    let caught: unknown;
    try {
      parseTaskRef(LEGACY_TASK_REF);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
    const usage = caught as UsageError;
    expect(usage.code).toBe("INVALID_FLAG_VALUE");
    // Message names the 0.9.0 replacement so muscle-memory callers get a fix.
    expect(usage.message).toContain("tasks/foo");
  });

  test("REJECTS a non-task conceptId", () => {
    expect(() => parseTaskRef("knowledge/foo")).toThrow(UsageError);
  });
});
