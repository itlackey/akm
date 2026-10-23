// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #1238 — a workflow plan frozen by 0.9.x journals the runner's credential as
 * `secret://<name>`. `decodeFrozenRunnerSpec` reads it as the `${ref}` that
 * replaced it, so a resumed run does not send the literal as its bearer token.
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

describe("decodeFrozenRunnerSpec reads the retired secret:// credential (#1238)", () => {
  test("an llm runner's bare name becomes a secrets ref", () => {
    expect(llmRef("secret://openai")).toBe("${secrets/openai}");
  });

  test("an llm runner's full-ref form keeps its ref", () => {
    expect(llmRef("secret://team//secrets/openai")).toBe("${team//secrets/openai}");
  });

  test("an sdk runner's fallback credential is lifted the same way", () => {
    const runner = decodeFrozenRunnerSpec({
      kind: "sdk",
      engine: "e",
      profile,
      fallbackConnection: connection,
      fallbackApiKeySecretRef: "secret://openai",
    });
    if (runner.kind !== "sdk") throw new Error("expected sdk");
    expect(runner.fallbackApiKeySecretRef).toBe("${secrets/openai}");
  });

  test("a runner already holding a ${ref} is unchanged", () => {
    expect(llmRef("${secrets/openai}")).toBe("${secrets/openai}");
  });
});
