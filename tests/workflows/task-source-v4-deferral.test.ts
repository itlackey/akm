// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P2b Lane A (spec docs/plans/specs/p2b-input-bindings.md §1.7 A-N6, §7
 * F-A4) supersedes p2a's LC-N1/B-24: the peek-and-throw deferral this file
 * used to pin is GONE. `taskDispatch` (`src/workflows/freeze/targets/task.ts`)
 * now routes through `parseTaskSource`, and a workflow step's
 * `uses: tasks/<ref>` targeting a `version: 4` task source COMPOSES —
 * A-N6's own comment records the supersession, and
 * `docs/plans/specs/p2a-task-source-v4.md`'s Review log carries the dated
 * note (F-A4's own close-out obligation).
 *
 * The first test below is REWRITTEN IN PLACE (same path, per F-A4) to assert
 * that composition: the step freezes to a real dispatch, and the step's
 * authored `with:` binds the v4 target's declared `inputs:` (A-N7's
 * `inputBindings`, §3.3).
 *
 * P4 (docs/plans/specs/p4-deletions-closeout.md §7.2, F-A2.31: "FLIP or
 * DELETE — the LC-N1 deferral it pinned was already lifted by P2b; with v3
 * gone its remaining v3 fixtures have no subject. Verify and record.")
 * DELETES the second test (the v3-contrast companion): its whole point was
 * isolating WHICH version LC-N1's now-superseded guard affected, by proving
 * a version: 3 target composed unaffected while a version: 4 one (at the
 * time) did not. With task source v3 acceptance retired from `src`
 * entirely, there is no second version left to contrast against — a
 * version: 3 target no longer "composes unaffected," it fails to parse at
 * all (TASK_SCHEMA_VERSION_UNSUPPORTED, row B-14), which is a claim this
 * file does not own and a different file already pins
 * (tests/tasks/source-v4.test.ts's version router tests).
 *
 * Sandbox/freeze pattern follows tests/workflows/with-rejection.test.ts
 * (withIsolatedAkmStorage + writeWorkflowTestConfig + akmIndex +
 * startWorkflowRun).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import type { FrozenWorkflowTarget } from "../../src/workflows/plan";
import { decodeWorkflowPlan } from "../../src/workflows/runtime/run-plan";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

const STEP_ID = "dispatch";
const TASK_REF = "tasks/nightly-v4";

describe("A-N6/F-A4 — a task source v4 target composes from a workflow step (supersedes p2a's LC-N1/B-24)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    writeWorkflowTestConfig();
    resetConfigCache();
  });

  afterEach(() => {
    resetConfigCache();
    storage.cleanup();
  });

  function write(relative: string, content: string): void {
    const file = path.join(storage.stashDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }

  test("a workflow step uses: tasks/<ref> whose task source is version: 4 composes: the step freezes, and its bindings land", async () => {
    // Unlike the old deferral test, composition now actually resolves the
    // v4 target's OWN uses:, so commands/review needs a real backing file.
    write("commands/review.md", "Review the workflow-composed task source v4 target.\n");
    write(
      "tasks/nightly-v4.yml",
      [
        "version: 4",
        "name: Nightly review",
        "uses: commands/review",
        "inputs:",
        "  scope:",
        "    type: string",
        "    default: changed",
        "",
      ].join("\n"),
    );
    write(
      `workflows/${STEP_ID}.yml`,
      [
        "name: Task source v4 composition",
        "on:",
        "  workflow_dispatch:",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        `      - id: ${STEP_ID}`,
        `        uses: ${TASK_REF}`,
        "        with:",
        "          scope: all",
        "",
      ].join("\n"),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    // The step freezes — no error, unlike the superseded LC-N1 deferral.
    const started = await startWorkflowRun(`workflows/${STEP_ID}`);
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    const root = plan.steps[0]?.root;
    const target: FrozenWorkflowTarget | undefined = root && root.kind !== "map" ? root.frozenTarget : undefined;

    // ...and its bindings land: the authored with.scope literal binds the
    // v4 target's declared "scope" input (A-N7's inputBindings).
    expect(target?.kind).toBe("command");
    expect(target?.inputBindings).toEqual([{ kind: "literal", name: "scope", value: "all" }]);
  });
});
