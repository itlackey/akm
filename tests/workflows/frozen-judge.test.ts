// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { frozenSummaryJudge } from "../../src/workflows/exec/frozen-judge";
import type { UnitDispatchRequest } from "../../src/workflows/exec/native-executor";
import type { WorkflowPlanGraph } from "../../src/workflows/ir/schema";

const OWNER = { runId: "11111111-1111-4111-8111-111111111111", stepId: "review" };

function agentPlan(overrides?: Partial<{ envPassthrough: string[] }>): WorkflowPlanGraph {
  return {
    irVersion: 3,
    title: "judge",
    execution: {
      maxConcurrency: 1,
      engines: {
        reviewer: {
          name: "reviewer",
          kind: "agent",
          runnerKind: "agent",
          platform: "codex",
          bin: "codex",
          args: [],
          workspace: null,
          envPassthrough: overrides?.envPassthrough ?? [],
          commandBuilder: "codex",
          fallbackLlmEngine: null,
        },
      },
    },
    steps: [],
  } satisfies WorkflowPlanGraph;
}

describe("frozen workflow judge", () => {
  test("dispatches an agent judge from its frozen snapshot with separated prompts", async () => {
    const invocation = { engine: "reviewer", model: "exact-model", timeoutMs: 1234 };
    let request: UnitDispatchRequest | undefined;
    const judge = frozenSummaryJudge(
      agentPlan(),
      invocation,
      undefined,
      async (input) => {
        request = input;
        return { ok: true, text: '{"complete":true,"missing":[]}' };
      },
      OWNER,
    );

    expect(await judge?.({ system: "judge system", user: "judge user" })).toContain('"complete":true');
    expect(request).toMatchObject({
      prompt: "judge user",
      systemPrompt: "judge system",
      invocation,
      timeoutMs: 1234,
      engine: { kind: "agent", platform: "codex" },
    });
  });

  test("the dispatch carries the REAL run/step identity, never a synthetic 'gate'", async () => {
    let request: UnitDispatchRequest | undefined;
    const judge = frozenSummaryJudge(
      agentPlan(),
      { engine: "reviewer", model: null, timeoutMs: null },
      undefined,
      async (input) => {
        request = input;
        return { ok: true, text: '{"complete":true,"missing":[]}' };
      },
      OWNER,
    );

    // Journaling caller supplies the exact gate-row identity for this loop.
    await judge?.(
      { system: "s", user: "u" },
      { runId: OWNER.runId, stepId: "review", nodeId: "review.gate", unitId: "review.gate:l3" },
    );
    expect(request).toMatchObject({
      runId: OWNER.runId,
      stepId: "review",
      nodeId: "review.gate",
      unitId: "review.gate:l3",
    });
  });

  test("without a per-call identity the dispatch still names the owning run/step", async () => {
    let request: UnitDispatchRequest | undefined;
    const judge = frozenSummaryJudge(
      agentPlan(),
      { engine: "reviewer", model: null, timeoutMs: null },
      undefined,
      async (input) => {
        request = input;
        return { ok: true, text: '{"complete":true,"missing":[]}' };
      },
      OWNER,
    );

    await judge?.({ system: "s", user: "u" });
    expect(request).toMatchObject({
      runId: OWNER.runId,
      stepId: "review",
      nodeId: "review.gate",
      unitId: "review.gate",
    });
    // The pre-fix synthetic identity is gone entirely.
    expect(request?.runId).not.toBe("gate");
  });

  test("a judge echoing a passthrough secret is redacted before it can be journaled", async () => {
    const name = "WORKFLOW_JUDGE_TEST_TOKEN";
    const secret = "s3cr3t-judge-token-value";
    const previous = process.env[name];
    process.env[name] = secret;
    try {
      let request: UnitDispatchRequest | undefined;
      const judge = frozenSummaryJudge(
        agentPlan({ envPassthrough: [name] }),
        { engine: "reviewer", model: null, timeoutMs: null },
        undefined,
        async (input) => {
          request = input;
          return { ok: true, text: `{"complete":false,"missing":["x"],"feedback":"saw ${secret} in the artifact"}` };
        },
        OWNER,
      );

      const raw = await judge?.({ system: "s", user: "u" });
      expect(raw).not.toContain(secret);
      expect(raw).toContain("[REDACTED]");
      // The dispatch itself declares the value, so the runner-side scrub sees it too.
      expect(request?.sensitiveValues).toContain(secret);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  test("a failed dispatch's error is redacted and still surfaced to the fail-closed validator", async () => {
    const name = "WORKFLOW_JUDGE_TEST_TOKEN";
    const secret = "s3cr3t-judge-token-value";
    const previous = process.env[name];
    process.env[name] = secret;
    try {
      const judge = frozenSummaryJudge(
        agentPlan({ envPassthrough: [name] }),
        { engine: "reviewer", model: null, timeoutMs: null },
        undefined,
        async () => ({ ok: false, text: "", error: `auth failed for ${secret}` }),
        OWNER,
      );
      await expect(judge?.({ system: "system", user: "user" })).rejects.toThrow(/auth failed for \[REDACTED\]/);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  test("surfaces a failed agent dispatch to the fail-closed validator", async () => {
    const invocation = { engine: "reviewer", model: null, timeoutMs: null };
    const plan = {
      irVersion: 3,
      title: "judge",
      execution: {
        maxConcurrency: 1,
        engines: {
          reviewer: {
            name: "reviewer",
            kind: "agent",
            runnerKind: "sdk",
            platform: "opencode-sdk",
            bin: "opencode",
            args: [],
            workspace: null,
            envPassthrough: [],
            commandBuilder: "opencode-sdk",
            fallbackLlmEngine: null,
          },
        },
      },
      steps: [],
    } satisfies WorkflowPlanGraph;
    const judge = frozenSummaryJudge(
      plan,
      invocation,
      undefined,
      async () => ({
        ok: false,
        text: "",
        error: "agent unavailable",
      }),
      OWNER,
    );

    await expect(judge?.({ system: "system", user: "user" })).rejects.toThrow("agent unavailable");
  });

  test("the judge dispatch declares NO env bindings (gate judges have no env surface)", async () => {
    let request: UnitDispatchRequest | undefined;
    const judge = frozenSummaryJudge(
      agentPlan(),
      { engine: "reviewer", model: null, timeoutMs: null },
      undefined,
      async (input) => {
        request = input;
        return { ok: true, text: '{"complete":true,"missing":[]}' };
      },
      OWNER,
    );
    await judge?.({ system: "s", user: "u" });
    expect(request?.env).toBeUndefined();
  });
});
