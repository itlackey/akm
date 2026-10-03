// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An agent engine takes no connection or inference of its own: inference for
 * opencode belongs in opencode's own config, and an improve process's `llm`
 * overlay carries it into model work.
 */

import { expect, test } from "bun:test";
import { validateConfigShape } from "../src/core/config/config-schema";

test.each([
  "provider",
  "endpoint",
  "apiKey",
  "apiKeyFile",
  "concurrency",
  "extraParams",
  "temperature",
  "maxTokens",
  "contextLength",
  "enableThinking",
  "reasoningEffort",
])("%s is not valid on an agent engine", (key) => {
  const result = validateConfigShape({
    configVersion: "0.9.0",
    engines: { e: { kind: "agent", platform: "opencode", [key]: "x" } },
  });

  expect(result.ok ? [] : result.errors).toEqual([
    { path: `engines.e.${key}`, message: `${key} is not valid on an agent engine` },
  ]);
});
