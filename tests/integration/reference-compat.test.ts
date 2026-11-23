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
 * Cases that need a fixture or configuration of their own (a loose workflow, a symlink, a bundle with no adapter,
 * stored proposals in several spellings, creating over an existing file, embeddings on, nested bundles) are the
 * `SCENARIOS` of `tests/fixtures/reference-compat/scenarios.ts`, each in a fresh sandbox and recorded as
 * `<scenario> :: <case>`. A difference found by review that no approved row covers yet is listed in `findings.json`:
 * its case still fails and its message begins `OPEN FINDING`.
 *
 * `tests/integration/previous-release-corpus.test.ts` is the per-format upgrade guard; this one is cross-cutting.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir } from "../_helpers/sandbox";
import {
  approvedBy,
  caseCovers,
  type DifferenceNode,
  differences,
  pathCovers,
  type RegisteredDifference,
  rowsApproved,
} from "../fixtures/reference-compat/compare";
import {
  buildSandbox,
  type CorpusResult,
  FIXTURE_DIR,
  runMainCorpus,
  runScenario,
} from "../fixtures/reference-compat/harness";
import { SCENARIOS } from "../fixtures/reference-compat/scenarios";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const expectedFile = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "expected.json"), "utf8")) as {
  recordedFrom: string;
  results: Record<string, CorpusResult>;
};
const registry = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "differences.json"), "utf8"),
) as RegisteredDifference[];
const stateSql = fs.readFileSync(path.join(FIXTURE_DIR, "state.sql"), "utf8");
/** Differences found by review that no approved row covers yet: the case still fails, and its message says why. */
const findings = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "findings.json"), "utf8")) as Array<{
  case: string;
  note: string;
}>;

const actual: Record<string, CorpusResult> = {};
const nodes: DifferenceNode[] = [];
const ids = Object.keys(expectedFile.results);
const scenarioIds = SCENARIOS.map((scenario) => scenario.id);
/** The main corpus: every recorded case no scenario owns. */
const mainIds = ids.filter((id) => !scenarioIds.some((scenario) => id.startsWith(`${scenario} :: `)));

const show = (v: unknown) => {
  const text = JSON.stringify(v);
  if (text === undefined) return "<absent>";
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
};
const describeNode = (n: DifferenceNode) =>
  `  ${n.case} :: ${n.path || "<whole result>"}\n    recorded: ${show(n.base)}\n    now:      ${show(n.current)}`;

/** Take a run's results in, and compare the recorded cases among them (those `ran` names) with the recording. */
function take(results: Record<string, CorpusResult>, ran: string[]): void {
  Object.assign(actual, results);
  const recorded = Object.fromEntries(ran.map((id) => [id, expectedFile.results[id]]));
  const now = Object.fromEntries(Object.entries(results).filter(([id]) => ran.includes(id) || !(id in recorded)));
  nodes.push(...differences(recorded, now));
}

function checkCase(id: string): void {
  test(id, () => {
    const unapproved = nodes.filter((n) => n.case === id && !approvedBy(n, registry));
    if (unapproved.length > 0) {
      const finding = findings.find((f) => caseCovers(f.case, id));
      throw new Error(
        `${finding ? `OPEN FINDING (no approved row covers it): ${finding.note}\n` : ""}${unapproved.length} difference(s) from ${expectedFile.recordedFrom.slice(0, 8)} that no approved §0.2 row covers:\n${unapproved.map(describeNode).join("\n")}`,
      );
    }
  });
}

/** Each part of the corpus runs in a sandbox of its own, so one slow or broken case fails its own part only. */
const withSandbox = <T>(run: (dir: string) => T): T => {
  const sandbox = makeSandboxDir("akm-rc");
  try {
    return run(sandbox.dir);
  } finally {
    sandbox.cleanup();
  }
};

describe(`references written before the adapter refactor resolve to the same assets (recorded from ${expectedFile.recordedFrom.slice(0, 8)})`, () => {
  beforeAll(() => {
    withSandbox((dir) => take(runMainCorpus(buildSandbox(path.join(dir, "run"), repoRoot, stateSql)), mainIds));
  }, 900_000);
  for (const id of mainIds) checkCase(id);
});

for (const scenario of SCENARIOS) {
  const own = ids.filter((id) => id.startsWith(`${scenario.id} :: `));
  describe(`references written before the adapter refactor resolve to the same assets: ${scenario.id}`, () => {
    beforeAll(() => {
      withSandbox((dir) => take(runScenario(buildSandbox(path.join(dir, "run"), repoRoot, stateSql), scenario), own));
    }, 300_000);
    for (const id of own) checkCase(id);
  });
}

describe("the register of differences", () => {
  test("every command of the corpus ran, and none is new", () => {
    expect(ids.filter((id) => !(id in actual))).toEqual([]);
    expect(Object.keys(actual).filter((id) => !(id in expectedFile.results))).toEqual([]);
  });

  test("every registered difference still occurs", () => {
    const stale = registry.filter(
      (e) => !nodes.some((n) => caseCovers(e.case, n.case) && pathCovers(e.path, n.path) && approvedBy(n, [e])),
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
    // A glob entry and a named one must not both cover the same difference.
    const covered = nodes.filter((n) => registry.filter((e) => approvedBy(n, [e]) !== undefined).length > 1);
    expect(covered.map((n) => `${n.case} :: ${n.path}`)).toEqual([]);
  });
});
