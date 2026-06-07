// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit coverage for `renderSyncCommitMessage` — the `{token}` expansion used to
 * build the end-of-run stash-sync commit message. The function is pure (the
 * clock is injected) so these assertions are deterministic.
 */

import { describe, expect, test } from "bun:test";
import { renderSyncCommitMessage } from "../../../src/commands/improve/improve";

// 2026-06-02 21:30:45 UTC
const NOW = Date.UTC(2026, 5, 2, 21, 30, 45);

function fakeResult(
  overrides: Partial<{
    scope: { mode: string; value?: string };
    plannedRefs: unknown[];
    gateAutoAcceptedCount?: number;
    triage?: { promoted: number; rejected: number; deferred: number; skippedByCap: number };
    runId?: string;
  }> = {},
) {
  return {
    scope: { mode: "all" as const },
    plannedRefs: [],
    ...overrides,
  };
}

describe("renderSyncCommitMessage", () => {
  test("expands time tokens from the injected clock (UTC)", () => {
    const out = renderSyncCommitMessage("{date} {time} | {timestamp}", fakeResult(), NOW);
    expect(out).toBe("2026-06-02 21:30:45 | 2026-06-02 21:30:45");
  });

  test("expands scope/refs/accepted from the result", () => {
    const out = renderSyncCommitMessage(
      "akm improve: {accepted} accepted, {refs} refs [{scope}]",
      fakeResult({ scope: { mode: "type", value: "memory" }, plannedRefs: [1, 2, 3], gateAutoAcceptedCount: 7 }),
      NOW,
    );
    expect(out).toBe("akm improve: 7 accepted, 3 refs [memory]");
  });

  test("scope falls back to mode when no value is set", () => {
    expect(renderSyncCommitMessage("{scope}", fakeResult({ scope: { mode: "all" } }), NOW)).toBe("all");
  });

  test("accepted defaults to 0 when gateAutoAcceptedCount is absent", () => {
    expect(renderSyncCommitMessage("{accepted}", fakeResult(), NOW)).toBe("0");
  });

  test("unknown tokens pass through verbatim (forward-compatible)", () => {
    expect(renderSyncCommitMessage("a {nope} b {alsoNope} c", fakeResult(), NOW)).toBe("a {nope} b {alsoNope} c");
  });

  test("triage + runId tokens render from the result when triage ran and a runId is present", () => {
    const out = renderSyncCommitMessage(
      "akm improve {runId}: +{triage_promoted} triaged, -{triage_rejected}, {accepted} accepted @ {timestamp}",
      fakeResult({
        gateAutoAcceptedCount: 4,
        triage: { promoted: 5, rejected: 2, deferred: 1, skippedByCap: 0 },
        runId: "run-abc123",
      }),
      NOW,
    );
    expect(out).toBe("akm improve run-abc123: +5 triaged, -2, 4 accepted @ 2026-06-02 21:30:45");
  });

  test("triage tokens default to 0 when the result has no triage field (triage did not run)", () => {
    expect(renderSyncCommitMessage("{triage_promoted}/{triage_rejected}", fakeResult(), NOW)).toBe("0/0");
  });

  test("runId renders the empty string when the result has no runId", () => {
    expect(renderSyncCommitMessage("[{runId}]", fakeResult(), NOW)).toBe("[]");
  });

  test("runId renders the run's id when present", () => {
    expect(renderSyncCommitMessage("{runId}", fakeResult({ runId: "run-xyz" }), NOW)).toBe("run-xyz");
  });

  test("a template with no tokens (the default) renders unchanged", () => {
    expect(renderSyncCommitMessage("akm improve auto-sync", fakeResult(), NOW)).toBe("akm improve auto-sync");
  });
});
