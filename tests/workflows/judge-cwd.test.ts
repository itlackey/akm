// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError, UsageError } from "../../src/core/errors";
import { resolveJudgeCwd } from "../../src/workflows/exec/frozen-judge";
import * as workflowAssetLoader from "../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";
import { freezeWorkflow } from "../_helpers/workflow";

/**
 * `resolveJudgeCwd` finds the root of the run's bundle when the gate judge is built. A bundle that does not
 * resolve is a typed `AkmError` (it classifies by kind, not as an internal failure) that names the workflow ref.
 */

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => {
  storage.cleanup();
});

const GATED = `---
type: workflow
steps:
  - id: work
---

## work

Do it.

### gate

- it is done
`;

const frozenJudge = freezeWorkflow(GATED).steps[0]!.gate.frozenJudge;

describe("resolveJudgeCwd", () => {
  test("a bundle-qualified ref whose bundle is not installed is a UsageError WORKFLOW_SOURCE_INVALID naming the ref", () => {
    let thrown: unknown;
    try {
      resolveJudgeCwd(frozenJudge, "gone//workflows/demo");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    expect((thrown as UsageError).code).toBe("WORKFLOW_SOURCE_INVALID");
    expect((thrown as UsageError).message).toBe(
      'workflow gone//workflows/demo does not resolve to a bundle (Bundle "gone" was not found among configured sources.)',
    );
  });

  test("an unqualified ref that resolves to no asset is a NotFoundError naming the ref", () => {
    let thrown: unknown;
    try {
      resolveJudgeCwd(frozenJudge, "workflows/missing");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotFoundError);
    const message = (thrown as NotFoundError).message;
    expect(message.startsWith("workflow workflows/missing does not resolve to a bundle (")).toBe(true);
    // The message is built once: the original cause is nested, never prefixed a second time.
    expect(message.split("does not resolve to a bundle").length).toBe(2);
  });

  test("the loader exports one bundle-root resolver, resolveRunBundleRoot", () => {
    expect(Object.keys(workflowAssetLoader).filter((name) => /BundleRoot$/.test(name))).toEqual([
      "resolveRunBundleRoot",
    ]);
  });

  test("a step with no frozen judge needs no root", () => {
    expect(resolveJudgeCwd(null, "gone//workflows/demo")).toBeUndefined();
  });
});
