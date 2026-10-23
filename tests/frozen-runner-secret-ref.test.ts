// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #1238 — a workflow plan frozen by 0.9.x journals the runner's credential as
 * `secret://<name>`. `decodeFrozenRunnerSpec` keeps it as stored (the unit input
 * hash and the child invocation key cover the runner, so a resumed run must hash
 * as it did before the upgrade); the credential is read as the `${ref}` that
 * replaced it where it is resolved
 * (`tests/integration/engine-resolution-secret-store.test.ts`).
 * Pure in-memory logic (no db/network/spawn).
 */

import { describe, expect, test } from "bun:test";
import { decodeFrozenRunnerSpec } from "../src/integrations/agent/runner";

const connection = { endpoint: "https://example.test/v1/chat/completions", model: "m" };
const profile = { name: "opencode", bin: "opencode" };

function llmRef(ref: string) {
  const runner = decodeFrozenRunnerSpec({ kind: "llm", engine: "e", connection, apiKeySecretRef: ref });
  if (runner.kind !== "llm") throw new Error("expected llm");
  return runner.apiKeySecretRef;
}

describe("decodeFrozenRunnerSpec keeps the retired secret:// credential as stored (#1238)", () => {
  test("an llm runner's secret:// credential is not rewritten", () => {
    expect(llmRef("secret://openai")).toBe("secret://openai");
    expect(llmRef("secret://team//secrets/openai")).toBe("secret://team//secrets/openai");
  });

  test("an sdk runner's fallback credential is not rewritten either", () => {
    const runner = decodeFrozenRunnerSpec({
      kind: "sdk",
      engine: "e",
      profile,
      fallbackConnection: connection,
      fallbackApiKeySecretRef: "secret://openai",
    });
    if (runner.kind !== "sdk") throw new Error("expected sdk");
    expect(runner.fallbackApiKeySecretRef).toBe("secret://openai");
  });

  test("a runner already holding a ${ref} is unchanged", () => {
    expect(llmRef("${secrets/openai}")).toBe("${secrets/openai}");
  });
});
