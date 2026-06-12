// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { CHECKIN_STALL_MS, evaluateCheckin } from "../../src/workflows/runtime/checkin";

describe("evaluateCheckin (#506 — file-signal check-in, no background thread)", () => {
  const base = "2026-01-01T00:00:00.000Z";
  const baseMs = Date.parse(base);

  test("returns null for a non-active run even when long idle", () => {
    expect(
      evaluateCheckin({ status: "completed", updatedAt: base, checkinArmedAt: base }, baseMs + CHECKIN_STALL_MS * 10),
    ).toBeNull();
  });

  test("returns null when never armed", () => {
    expect(
      evaluateCheckin({ status: "active", updatedAt: base, checkinArmedAt: null }, baseMs + CHECKIN_STALL_MS * 10),
    ).toBeNull();
  });

  test("returns null while inside the stall window (healthy progressing run)", () => {
    expect(
      evaluateCheckin({ status: "active", updatedAt: base, checkinArmedAt: base }, baseMs + CHECKIN_STALL_MS - 1),
    ).toBeNull();
  });

  test("emits a strong continue directive once the stall window is exceeded", () => {
    const directive = evaluateCheckin(
      {
        status: "active",
        updatedAt: base,
        checkinArmedAt: base,
        agentHarness: "claude-code",
        agentSessionId: "sess-1",
      },
      baseMs + CHECKIN_STALL_MS + 5_000,
    );
    expect(directive).not.toBeNull();
    expect(directive?.signal).toBe("continue");
    expect(directive?.directive).toContain("CONTINUE");
    expect(directive?.agentHarness).toBe("claude-code");
    expect(directive?.agentSessionId).toBe("sess-1");
    expect(directive?.idleMs).toBe(CHECKIN_STALL_MS + 5_000);
  });

  test("uses the later of updatedAt and armedAt as the idle anchor", () => {
    // updatedAt is fresh (run progressed) even though armedAt is old → not stalled.
    const fresh = "2026-01-01T00:10:00.000Z";
    expect(
      evaluateCheckin(
        { status: "active", updatedAt: fresh, checkinArmedAt: base },
        Date.parse(fresh) + CHECKIN_STALL_MS - 1,
      ),
    ).toBeNull();
  });
});
