// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An agent engine on any platform may set the inference fields. What its
 * platform does not translate is reported as a lowering notice at dispatch, as
 * for an asset's or a caller's inference, not refused at load.
 */

import { expect, test } from "bun:test";
import { validateConfigShape } from "../src/core/config/config-schema";
import { VALID_HARNESS_IDS } from "../src/integrations/harnesses/ids";

const INFERENCE = {
  temperature: 0.2,
  maxTokens: 4096,
  contextLength: 120000,
  enableThinking: false,
  reasoningEffort: "high",
} as const;

test.each([...VALID_HARNESS_IDS])("%s: an agent engine may set every inference field", (platform) => {
  const result = validateConfigShape({
    configVersion: "0.9.0",
    engines: { e: { kind: "agent", platform, ...INFERENCE } },
  });

  expect(result.ok).toBe(true);
});

// These describe a connection or a wire format, which no agent platform has.
test.each([
  "provider",
  "endpoint",
  "apiKey",
  "apiKeyFile",
  "concurrency",
  "extraParams",
])("%s is still not valid on an agent engine", (key) => {
  const result = validateConfigShape({
    configVersion: "0.9.0",
    engines: { e: { kind: "agent", platform: "opencode", [key]: "x" } },
  });

  expect(result.ok ? [] : result.errors).toEqual([
    { path: `engines.e.${key}`, message: `${key} is not valid on an agent engine` },
  ]);
});
