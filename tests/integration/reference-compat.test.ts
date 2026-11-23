// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reference compatibility: what a user could do before the adapter refactor, they can still do, with the same result.
 *
 * Users write refs in their assets, config and stored state (`knowledge/guide.md`, `main//knowledge/guide`,
 * `${secrets/api-token}` in an env file, a task's `uses:`, a workflow step, `supersededBy`, proposals, the improve
 * ledger, scheduler rows, ...) and must never have to edit them. `tests/fixtures/reference-compat/` is a home with
 * three bundles and a `state.db` holding every spelling in use; `expected.json` is what the pre-refactor commit
 * `1f2e58c9` printed for each command of `harness.ts`, recorded by `scripts/record-reference-compat.ts`. This test
 * runs the same commands on the working tree and compares.
 *
 * A difference passes only when `tests/fixtures/reference-compat/differences.json` has an entry for exactly that
 * case, path, recorded value and new value, and the entry names a row of the design's approved-changes register
 * (§0.2) that the owner approved (`APPROVED_ROWS` in `compare.ts`). A difference no approved row covers fails here,
 * by case, naming both values. THIS TEST IS EXPECTED TO FAIL while the branch holds such a difference: it is how the
 * unapproved change is found, and it is not weakened, skipped or allow-listed to pass. Resolve a failure by
 * reverting the change, or by registering it as approved and adding its row.
 *
 * `tests/integration/previous-release-corpus.test.ts` is the per-format upgrade guard; this one is cross-cutting.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir } from "../_helpers/sandbox";
import {
  approvedBy,
  type DifferenceNode,
  differences,
  type RegisteredDifference,
  rowsApproved,
} from "../fixtures/reference-compat/compare";
import { buildSandbox, type CorpusResult, FIXTURE_DIR, runCorpus } from "../fixtures/reference-compat/harness";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const expectedFile = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "expected.json"), "utf8")) as {
  recordedFrom: string;
  results: Record<string, CorpusResult>;
};
const registry = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "differences.json"), "utf8"),
) as RegisteredDifference[];
const stateSql = fs.readFileSync(path.join(FIXTURE_DIR, "state.sql"), "utf8");

let actual: Record<string, CorpusResult> = {};
let nodes: DifferenceNode[] = [];

const show = (v: unknown) => {
  const text = JSON.stringify(v);
  if (text === undefined) return "<absent>";
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
};
const describeNode = (n: DifferenceNode) =>
  `  ${n.case} :: ${n.path || "<whole result>"}\n    recorded: ${show(n.base)}\n    now:      ${show(n.current)}`;

beforeAll(() => {
  const sandbox = makeSandboxDir("akm-rc");
  try {
    actual = runCorpus(buildSandbox(path.join(sandbox.dir, "run"), repoRoot, stateSql));
  } finally {
    sandbox.cleanup();
  }
  nodes = differences(expectedFile.results, actual);
}, 900_000);

describe(`references written before the adapter refactor resolve to the same assets (recorded from ${expectedFile.recordedFrom.slice(0, 8)})`, () => {
  for (const id of Object.keys(expectedFile.results)) {
    test(id, () => {
      const unapproved = nodes.filter((n) => n.case === id && !approvedBy(n, registry));
      if (unapproved.length > 0) {
        throw new Error(
          `${unapproved.length} difference(s) from ${expectedFile.recordedFrom.slice(0, 8)} that no approved §0.2 row covers:\n${unapproved.map(describeNode).join("\n")}`,
        );
      }
    });
  }

  test("every command of the corpus ran, and none is new", () => {
    expect(Object.keys(actual).filter((id) => !(id in expectedFile.results))).toEqual([]);
  });

  test("every registered difference still occurs", () => {
    const stale = registry.filter(
      (e) => !nodes.some((n) => n.case === e.case && n.path === e.path && approvedBy(n, [e])),
    );
    expect(stale.map((e) => `${e.case} :: ${e.path} (${e.row})`)).toEqual([]);
  });

  test("every registered difference names an approved register row and says why it applies", () => {
    expect(
      registry
        .filter((e) => !rowsApproved(e.row) || e.note.trim().length === 0)
        .map((e) => `${e.case} :: ${e.path} (${e.row})`),
    ).toEqual([]);
  });

  test("the register has one entry per difference", () => {
    const keys = registry.map((e) => `${e.case}\0${e.path}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i).map((k) => k.replace("\0", " :: "))).toEqual([]);
  });
});
