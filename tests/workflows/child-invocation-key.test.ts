// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3a Lane A TESTS — `computeChildInvocationKey` (spec
 * docs/plans/specs/p3a-plan-v5-child-freeze.md §3.4, rows A-17…A-19). Named
 * in §7's "new suites this phase adds" table as its own file.
 *
 * TEST-REVIEW FOLLOW-UP (round 3, finding 2): these tests originally lived
 * inside `tests/workflows/hash-v6.test.ts`, combined with the `hashVersion`
 * 6 tests (A-11…A-16) because both bumps ride in Lane A's one commit. That
 * combination was itself the bug: a static top-level import of
 * `src/workflows/exec/child-invocation.ts` (which does not exist on disk
 * until Implement) block-fails module loading for the ENTIRE file — Bun
 * never registers a single `describe`/`test` — so `hash-v6.test.ts`'s own
 * A-11 (unit hash preimage) and A-12 (gate hash) tests produced no
 * `hashVersion` 6 RED signal at all; they failed only as collateral damage
 * of "cannot find module", indistinguishable from every other kind of
 * red-phase breakage. Splitting `computeChildInvocationKey`'s tests into
 * THIS standalone file fixes that: every test below is about
 * `child-invocation.ts` itself, so a whole-file block failure hides nothing
 * else the way it did inside the combined file — this is the same
 * "isolate the not-yet-existing import so its RED reason doesn't leak into
 * unrelated tests" convention `tests/tasks/source-v4.test.ts` and
 * `tests/execution/input-contract.test.ts` already established, applied a
 * second time at file granularity instead of within one file.
 *
 * RED phase: `src/workflows/exec/child-invocation.ts` does not exist on
 * disk yet, so it is imported as a NAMESPACE behind exactly one
 * directly-preceding `@ts-expect-error` pin — TypeScript reports one TS2307
 * "Cannot find module" here, every name it introduces is typed `any` for
 * the rest of THIS file, and Bun's module loader fails to load this file at
 * test-run time before any `describe`/`test` registers. That is the
 * intended RED signal for every test below. Implement removes the one
 * directive the moment `child-invocation.ts` exists.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as ChildInvocationModule from "../../src/workflows/exec/child-invocation";
import { canonicalJson } from "../../src/workflows/ir/plan-hash";

const { computeChildInvocationKey } = ChildInvocationModule;

// ── A-17…A-19: computeChildInvocationKey ────────────────────────────────────

describe("computeChildInvocationKey (§3.4, A-17…A-19)", () => {
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
