// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import type { ConnectionRunner, HarnessRunner } from "../../src/integrations/agent/runner";
import { collectWorkflowDispatchSensitiveValues, redactUnitOutcome } from "../../src/workflows/exec/dispatch-redaction";
import type { UnitOutcome } from "../../src/workflows/exec/step-work";
import { withEnv } from "../_helpers/sandbox";

describe("redactUnitOutcome number leaves", () => {
  test("redacts a numeric secret in the parsed result and no other number", () => {
    const outcome = redactUnitOutcome<UnitOutcome>(
      { unitId: "u", ok: true, result: { n: 4242, other: 42, nested: [4242] } },
      ["4242"],
    );
    expect(outcome.result).toEqual({ n: "[REDACTED]", other: 42, nested: ["[REDACTED]"] });
  });

  test("keeps tokens a number when a sensitive value equals it", () => {
    const outcome = redactUnitOutcome<UnitOutcome>({ unitId: "u", ok: true, tokens: 1200, result: { n: 1200 } }, [
      "1200",
    ]);
    expect(outcome.tokens).toBe(1200);
    expect(outcome.result).toEqual({ n: "[REDACTED]" });
  });
});

describe("collectWorkflowDispatchSensitiveValues", () => {
  const harness: HarnessRunner = {
    kind: "harness",
    name: "claude",
    platform: "claude",
    bin: "claude",
    args: [],
    timeoutMs: null,
  };
  const connection: ConnectionRunner = {
    kind: "connection",
    name: "lab",
    endpoint: "http://127.0.0.1:1/v1",
    model: "m",
    request: {},
    apiKey: "$DISPATCH_REDACTION_KEY",
    timeoutMs: null,
  };

  test("a connection's key is read from this process's environment, and a credential-named variable the child inherits counts for every unit, a shell command's included", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "the-users-own-key", DISPATCH_REDACTION_KEY: "connection-secret" }, () => {
      expect(collectWorkflowDispatchSensitiveValues({ runner: connection })).toContain("connection-secret");
      expect(collectWorkflowDispatchSensitiveValues({ runner: harness })).toContain("the-users-own-key");
      expect(collectWorkflowDispatchSensitiveValues({})).toContain("the-users-own-key");
    });
  });

  test("the values the unit's environment bindings substituted are included", () => {
    expect(collectWorkflowDispatchSensitiveValues({ sensitiveValues: ["bound-secret"] })).toContain("bound-secret");
  });
});
