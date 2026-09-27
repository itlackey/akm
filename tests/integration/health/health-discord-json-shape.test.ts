// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The user's `scripts/akm-health-discord.ts` cron job runs
 * `akm --format json -q health --window-compare=1h` and reaches into the
 * result by hand (`h.status`, `h.advisories[].evidence`,
 * `h.metrics.stuckActiveRuns`, `h.windows[].improve.coverage.distinctRefs`,
 * `h.windows[].metrics.llmUsage.{calls,totalTokens,totalDurationMs}`) — it is
 * not part of this package and has no type-level coupling to
 * `AkmHealthResult`, so a health simplification pass can silently drop a
 * field it reads without any compiler catching it. This test is a runtime
 * pin of that JSON shape, independent of any one health-check's behavior.
 */

import { describe, expect, test } from "bun:test";
import { akmHealth } from "../../../src/commands/health";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

describe("akm health --window-compare=1h JSON shape (akm-health-discord.ts contract)", () => {
  test("carries every field the Discord script reads", async () => {
    const storage: IsolatedAkmStorage = withIsolatedAkmStorage();
    try {
      const result = await akmHealth({ windowCompare: "1h" });

      // h.status
      expect(["pass", "warn", "fail"]).toContain(result.status);

      // h.advisories[] — { name, status, message, evidence? }
      expect(Array.isArray(result.advisories)).toBe(true);
      for (const advisory of result.advisories) {
        expect(typeof advisory.name).toBe("string");
        expect(typeof advisory.status).toBe("string");
        expect(typeof advisory.message).toBe("string");
      }

      // h.metrics.stuckActiveRuns
      expect(typeof result.metrics.stuckActiveRuns).toBe("number");

      // h.windows[] — current/prior, each carrying improve.coverage.distinctRefs
      // and metrics.llmUsage.{calls,totalTokens,totalDurationMs}.
      expect(Array.isArray(result.windows)).toBe(true);
      const windowNames = (result.windows ?? []).map((w) => w.name);
      expect(windowNames).toContain("current");
      expect(windowNames).toContain("prior");
      for (const window of result.windows ?? []) {
        expect(typeof window.improve.coverage.distinctRefs).toBe("number");
        expect(typeof window.metrics.llmUsage.calls).toBe("number");
        expect(typeof window.metrics.llmUsage.totalTokens).toBe("number");
        expect(typeof window.metrics.llmUsage.totalDurationMs).toBe("number");
      }
    } finally {
      storage.cleanup();
    }
  });

  test("carries the auto-accept-validation advisory evidence shape the script reads", async () => {
    const storage: IsolatedAkmStorage = withIsolatedAkmStorage();
    try {
      const result = await akmHealth({ windowCompare: "1h" });
      const autoAccept = result.advisories.find((a) => a.name === "auto-accept-validation");
      // Always registered (advisory channel, unconditional) — the script reads
      // `a.evidence?.promoted` / `a.evidence?.validationFailed` off it.
      expect(autoAccept).toBeDefined();
      expect(typeof autoAccept?.evidence?.promoted).toBe("number");
      expect(typeof autoAccept?.evidence?.validationFailed).toBe("number");
    } finally {
      storage.cleanup();
    }
  });
});
