// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #554 — extract `minNewSessions` gate.
 *
 * The extract pass skips entirely (zero LLM calls, zero writes) when the number
 * of NEW (unseen, in-window) candidate sessions is below
 * `processes.extract.minNewSessions`. The skip is emitted as an
 * `improve_skipped` event with `reason: "below_min_new_sessions"` (reusing the
 * #551/#553 emission path), which the health command's dynamic skip-reason
 * aggregation surfaces. `minNewSessions: 0` (the in-code default) disables the
 * guard, preserving the existing always-run behaviour for every profile that
 * does not opt in (only `frequent` does, with 3).
 *
 * These tests use an injected fake candidate-counter + fake harness so the
 * gate boundary is exercised deterministically without touching real session
 * logs or making any LLM call.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmHealth } from "../../../src/commands/health";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../src/core/config";
import { saveConfig } from "../../../src/core/config";
import { readEvents } from "../../../src/core/events";
import type { SessionLogHarness, SessionSummary } from "../../../src/integrations/session-logs/types";
import { type Cleanup, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const TIMEOUT_MS = 20_000;

let cleanup: Cleanup = () => {};
let stashDir = "";

/**
 * Minimal fake harness. `listSessions` returns `count` in-window sessions; the
 * extract pass should NEVER reach `readSession` in these tests (it either skips
 * before the loop, or the akmExtract call is intercepted by the count gate /
 * fails harmlessly with no LLM). We make readSession throw to prove the gate
 * preempts any real extraction work.
 */
function fakeHarness(count: number): SessionLogHarness {
  const sessions: SessionSummary[] = Array.from({ length: count }, (_, i) => ({
    harness: "fake",
    sessionId: `sess-${i}`,
    filePath: `/dev/null/sess-${i}`,
    endedAt: Date.now(),
  }));
  return {
    name: "fake",
    isAvailable: () => true,
    readEvents: () => [],
    listSessions: () => sessions,
    readSession: () => {
      throw new Error("readSession must not be called — extract should have been gated/skipped");
    },
  };
}

/** Config enabling extract with a specific minNewSessions threshold. */
function configWithMinNewSessions(minNewSessions: number | undefined): AkmConfig {
  return {
    semanticSearchMode: "off",
    profiles: {
      improve: {
        default: {
          processes: {
            // Disable consolidate so its #553 guard never interferes; extract on.
            consolidate: { enabled: false },
            extract: minNewSessions === undefined ? { enabled: true } : { enabled: true, minNewSessions },
          },
        },
      },
    },
  } as unknown as AkmConfig;
}

/**
 * Drive an improve(memory) run with no LLM connection configured. `newCount`
 * is the injected number of new candidate sessions the gate sees.
 */
async function runImprove(config: AkmConfig, newCount: number): Promise<void> {
  await akmImprove({
    scope: "memory",
    config,
    stashDir,
    minRetrievalCount: 0,
    ensureIndexFn: async () => false,
    reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
    // #554 seams: a fake harness (so availableHarnesses.length > 0) and a fake
    // candidate counter returning the desired new-session count.
    extractHarnesses: [fakeHarness(newCount)],
    extractCandidateCountFn: () => newCount,
  });
}

function belowMinNewSessionsEvents() {
  return readEvents({ type: "improve_skipped", ref: "memory:_extract" }).events.filter(
    (e) => e.metadata?.reason === "below_min_new_sessions",
  );
}

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  cleanup = storage.cleanup;
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  stashDir = "";
});

describe("#554 extract minNewSessions gate", () => {
  test(
    "new sessions BELOW minNewSessions → skip + below_min_new_sessions event + ZERO extract work",
    async () => {
      // 1 new session < minNewSessions 3 → skip. readSession throws if reached,
      // so a passing test proves the extract loop never ran.
      await runImprove(configWithMinNewSessions(3), 1);

      const skips = belowMinNewSessionsEvents();
      expect(skips.length).toBe(1);
      expect(skips[0]?.metadata?.newSessions).toBe(1);
      expect(skips[0]?.metadata?.minNewSessions).toBe(3);
    },
    TIMEOUT_MS,
  );

  test(
    "new sessions AT/ABOVE minNewSessions → guard does NOT skip (no below_min_new_sessions event)",
    async () => {
      // 3 new sessions >= minNewSessions 3 → guard inert. The extract loop runs;
      // akmExtract with no LLM configured throws per-harness and is caught as a
      // warning (no readSession reached because processSession resolves the LLM
      // first). Crucially: NO below_min_new_sessions event.
      await runImprove(configWithMinNewSessions(3), 3);

      expect(belowMinNewSessionsEvents().length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "minNewSessions: 0 disables the guard → never skips even with zero new sessions",
    async () => {
      await runImprove(configWithMinNewSessions(0), 0);
      expect(belowMinNewSessionsEvents().length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "unset minNewSessions defaults to 0 (disabled) → existing always-run behaviour preserved",
    async () => {
      // No minNewSessions key at all; in-code default is 0 → guard never engages
      // even though there are zero new candidate sessions.
      await runImprove(configWithMinNewSessions(undefined), 0);
      expect(belowMinNewSessionsEvents().length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "health surfaces below_min_new_sessions in improve skip-reason aggregation",
    async () => {
      await runImprove(configWithMinNewSessions(3), 1);
      expect(belowMinNewSessionsEvents().length).toBe(1);

      const health = akmHealth({ since: "30d" });
      expect(health.improve?.skipReasons?.below_min_new_sessions).toBe(1);
    },
    TIMEOUT_MS,
  );
});
