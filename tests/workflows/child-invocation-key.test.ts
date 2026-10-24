// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `computeChildInvocationKey` (rows A-17…A-19 in test names).
 *
 * Kept in its own file, separate from the `hashVersion` 6 tests in
 * tests/workflows/hash-v6.test.ts: every test below is about
 * `src/workflows/exec/child-invocation.ts` itself, so a failure to load that
 * module cannot hide results from unrelated tests.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as ChildInvocationModule from "../../src/workflows/exec/child-invocation";
import { canonicalJson } from "../../src/workflows/ir/plan-hash";

const { computeChildInvocationKey } = ChildInvocationModule;

// ── computeChildInvocationKey (A-17…A-19) ───────────────────────────────────

describe("computeChildInvocationKey", () => {
  const base = { parentRunId: "run-1", parentUnitId: "unit-1", unitInputHash: "d".repeat(64) };

  test("is deterministic: the same three inputs hash identically", () => {
    const first = computeChildInvocationKey(base);
    const second = computeChildInvocationKey({ ...base });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test("matches the exact documented preimage: sha256('akm.workflow.child-invocation\\0v1\\0' + canonicalJson({parentRunId, parentUnitId, unitInputHash}))", () => {
    const input = { parentRunId: "run-42", parentUnitId: "unit-7", unitInputHash: "e".repeat(64) };
    const expected = createHash("sha256")
      .update("akm.workflow.child-invocation\0v1\0")
      .update(
        canonicalJson({
          parentRunId: input.parentRunId,
          parentUnitId: input.parentUnitId,
          unitInputHash: input.unitInputHash,
        }),
      )
      .digest("hex");
    expect(computeChildInvocationKey(input)).toBe(expected);
  });

  test("a changed parentRunId produces a different key", () => {
    expect(computeChildInvocationKey(base)).not.toBe(computeChildInvocationKey({ ...base, parentRunId: "run-2" }));
  });

  test("a changed parentUnitId produces a different key", () => {
    expect(computeChildInvocationKey(base)).not.toBe(computeChildInvocationKey({ ...base, parentUnitId: "unit-2" }));
  });

  test("a changed unitInputHash produces a different key", () => {
    expect(computeChildInvocationKey(base)).not.toBe(
      computeChildInvocationKey({ ...base, unitInputHash: "f".repeat(64) }),
    );
  });

  test("collision-free across a grid of parentRunId/parentUnitId/unitInputHash variations", () => {
    const runIds = ["run-1", "run-2", "run-3"];
    const unitIds = ["unit-a", "unit-b", "unit-c"];
    const hashes = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
    const seen = new Set<string>();
    for (const parentRunId of runIds) {
      for (const parentUnitId of unitIds) {
        for (const unitInputHash of hashes) {
          const key = computeChildInvocationKey({ parentRunId, parentUnitId, unitInputHash });
          expect(key).toMatch(/^[0-9a-f]{64}$/);
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
    }
    expect(seen.size).toBe(runIds.length * unitIds.length * hashes.length);
  });
});
