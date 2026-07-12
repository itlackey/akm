// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import { akmImprove } from "../../../src/commands/improve/improve";
import { readEvents } from "../../../src/core/events";
import { sandboxStashDir, sandboxXdgDataHome, withEnv } from "../../_helpers/sandbox";

test("improve failure events redact materialized engine credentials", async () => {
  const sentinel = "IMPROVE-EVENT-SECRET";
  const data = sandboxXdgDataHome();
  const stash = sandboxStashDir(data.cleanup);
  try {
    await expect(
      withEnv({ IMPROVE_TEST_API_KEY: sentinel }, () =>
        akmImprove({
          stashDir: stash.dir,
          config: {
            configVersion: "0.9.0",
            semanticSearchMode: "off",
            engines: {
              default: {
                kind: "llm",
                endpoint: "https://example.test/v1/chat/completions",
                model: "test",
                apiKey: "$IMPROVE_TEST_API_KEY",
              },
            },
            defaults: { llmEngine: "default", improveStrategy: "redaction-test" },
            improve: {
              strategies: {
                "redaction-test": {
                  processes: {
                    reflect: { enabled: false },
                    distill: { enabled: false },
                    consolidate: { enabled: false },
                    memoryInference: { enabled: false },
                    graphExtraction: { enabled: false },
                    extract: { enabled: false },
                    triage: { enabled: false },
                  },
                },
              },
            },
          },
          ensureIndexFn: async () => undefined,
          collectEligibleRefsFn: (async () => ({
            plannedRefs: [],
            memorySummary: { eligible: 0, derived: 0 },
            strategyFilteredRefs: [],
          })) as never,
          runImprovePreparationStageFn: (async () => {
            throw new Error(`provider echoed ${sentinel}`);
          }) as never,
        }),
      ),
    ).rejects.toThrow("provider echoed");

    const failed = readEvents({ type: "improve_failed" }).events;
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed)).not.toContain(sentinel);
    expect(JSON.stringify(failed)).toContain("[REDACTED]");
  } finally {
    stash.cleanup();
  }
});
