// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { resolveImproveStrategy } from "../src/commands/improve/improve-strategies";
import { ConfigError } from "../src/core/errors";

describe("resolveImproveStrategy", () => {
  test("deep-merges the default baseline, selected built-in, and user strategy", () => {
    const selected = resolveImproveStrategy("quick", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      improve: {
        strategies: {
          quick: {
            processes: { reflect: { enabled: false, allowedTypes: ["memory"] } },
          },
        },
      },
    });

    expect(selected.name).toBe("quick");
    expect(selected.config.processes?.reflect).toMatchObject({ enabled: false, allowedTypes: ["memory"] });
    expect(selected.config.processes?.distill).toBeDefined();
  });

  test("uses defaults.improveStrategy before the built-in default", () => {
    const selected = resolveImproveStrategy(undefined, {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      defaults: { improveStrategy: "quick" },
    });
    expect(selected.name).toBe("quick");
  });

  test("rejects an unknown strategy instead of silently falling back", () => {
    expect(() =>
      resolveImproveStrategy("does-not-exist", { configVersion: "0.9.0", semanticSearchMode: "auto" }),
    ).toThrow(ConfigError);
  });
});
