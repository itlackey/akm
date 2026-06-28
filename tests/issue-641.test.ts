// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for #641 — triage: procedural-aware floor (opt-in, sequenced last).
 *
 * The feature adds a `proceduralAwareFloor` option to `TriageConfig`. When
 * enabled, a session PASSES if and only if:
 *
 *   score >= minScore AND (markers >= 1 OR editCommit >= 0.5)
 *
 * In other words, a session that hits the score floor but has NO markers AND
 * no meaningful edit/commit signal is treated as low-signal read-only Q&A and
 * FAILS — even if score is high enough on substantiveRatio + toolDensity alone.
 * This protects #615 (procedural sessions with real edits/markers always pass)
 * while catching residual low-signal read-only Q&A.
 *
 * Gate: `proceduralAwareFloor` DEFAULT OFF — default runs are byte-identical to
 * the pre-#641 implementation.
 *
 * All tests are UNIT-tier: pure functions only, no Bun.spawn/Bun.serve,
 * All tests are UNIT-tier: pure functions only, no Bun.spawn/Bun.serve,
 * no timeouts >= 60s. They drive src/commands/improve/triage.ts.
 *
 * Acceptance cases:
 *   1. (floor enabled) low-signal read-only Q&A (score passes, markers=0,
 *      editCommit=0) → pass=false (triaged OUT)
 *   2. (floor enabled) session with markers >= 1 → passes even if editCommit=0
 *   3. (floor enabled) session with editCommit >= 0.5 → passes even if markers=0
 *   4. (floor enabled) session with BOTH markers>=1 AND editCommit>=0.5 → passes
 *   5. Default-preserving guard: floor DISABLED (default) → same session from
 *      case 1 still PASSES (score >= minScore is the only gate)
 *   6. resolveTriageConfig returns proceduralAwareFloor:false when absent
 *   7. resolveTriageConfig returns proceduralAwareFloor:true when set to true
 *   8. TriageConfig type accepts proceduralAwareFloor field (type-level + runtime)
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TRIAGE_MIN_SCORE,
  resolveTriageConfig,
  scoreSessionTriage,
  type TriageConfig,
} from "../src/commands/improve/triage";
import type { SessionData } from "../src/integrations/session-logs/types";

// ── SessionData builders ───────────────────────────────────────────────────────

/**
 * A low-signal read-only Q&A session:
 * - No narrative markers (no "error", "fix", "decided", etc.)
 * - No edit/commit events (no filePath, no Edit/Write/git commit in text)
 * - BUT enough tool activity to push score >= DEFAULT_TRIAGE_MIN_SCORE via
 *   toolDensity + substantiveRatio (score ~2.5 in practice).
 *
 * Scores: markers=0, toolDensity=1.5, editCommit=0, substantiveRatio=1 → 2.5
 *
 * This is the "false positive" scenario #641 targets: the existing triage
 * passes it because score >= minScore; the procedural floor rejects it because
 * markers=0 AND editCommit=0 — the tool calls here are read-only searches,
 * NOT file edits or commits.
 */
function lowSignalReadonlySession(id: string): SessionData {
  const now = Date.now();
  // 6 tool events representing read-only searches (no filePath, no edit text)
  const toolEvents = Array.from({ length: 6 }, (_, i) => ({
    harness: "claude-code" as const,
    text: "Running a search query to find relevant documentation results.",
    ts: now - (12 - i) * 60_000,
    sessionId: id,
    role: "tool" as const,
    filePath: undefined,
  }));
  // 4 long assistant events (each > 40 chars, no markers)
  const assistantEvents = Array.from({ length: 4 }, (_, i) => ({
    harness: "claude-code" as const,
    text: `Here is a detailed explanation of concept number ${i} without any outcome or decision keywords mentioned at all.`,
    ts: now - (6 - i) * 60_000,
    sessionId: id,
    role: "assistant" as const,
    filePath: undefined,
  }));
  return {
    ref: {
      harness: "claude-code",
      sessionId: id,
      filePath: `/tmp/fake/${id}.jsonl`,
      startedAt: now - 3_600_000,
      endedAt: now,
      title: `Read-only Q&A ${id}`,
    },
    events: [...toolEvents, ...assistantEvents],
    inlineRefs: [],
  };
}

/**
 * A session that has at least one narrative marker keyword (markers >= 1)
 * and no edit/commit events (editCommit = 0). Should PASS even when the
 * procedural floor is enabled (markers >= 1 satisfies the OR condition).
 */
function markerOnlySession(id: string): SessionData {
  const now = Date.now();
  return {
    ref: {
      harness: "claude-code",
      sessionId: id,
      filePath: `/tmp/fake/${id}.jsonl`,
      startedAt: now - 3_600_000,
      endedAt: now,
      title: `Marker session ${id}`,
    },
    events: [
      {
        harness: "claude-code",
        // Contains "root cause" — a MARKER_RE match → markers >= 1
        text:
          "We identified the root cause of the deploy failure: missing env var. " +
          "The root cause was clear from the logs. Fixed it immediately and re-deployed.",
        ts: now - 3_000_000,
        sessionId: id,
        role: "assistant" as const,
        filePath: undefined,
      },
      {
        harness: "claude-code",
        text: "What was the outcome? " + "The error was resolved after updating the config.",
        ts: now - 2_000_000,
        sessionId: id,
        role: "assistant" as const,
        filePath: undefined,
      },
    ],
    inlineRefs: [],
  };
}

/**
 * A session that has editCommit >= 0.5 (via filePath present on events)
 * and NO narrative markers. Score is also >= DEFAULT_TRIAGE_MIN_SCORE.
 * Should PASS when floor enabled (editCommit >= 0.5 satisfies the OR condition).
 *
 * Scores: markers=0, toolDensity=1.0, editCommit=1.0, substantiveRatio=0.5 → 2.5
 */
function editOnlySession(id: string): SessionData {
  const now = Date.now();
  // 4 tool events with filePath → each contributes 0.25 to both toolDensity and
  // editCommit. No markers. Text is too short to count as substantive (< 40 chars).
  const toolEdits = Array.from({ length: 4 }, (_, i) => ({
    harness: "claude-code" as const,
    text: "Applied change.",
    ts: now - (8 - i) * 60_000,
    sessionId: id,
    role: "tool" as const,
    filePath: `/repo/src/file${i}.ts`,
  }));
  // 4 long assistant turns (substantive) with NO markers
  const assistantTurns = Array.from({ length: 4 }, (_, i) => ({
    harness: "claude-code" as const,
    text: `This explanation is long enough to count as substantive turn number ${i} in the conversation.`,
    ts: now - (4 - i) * 60_000,
    sessionId: id,
    role: "assistant" as const,
    filePath: undefined,
  }));
  return {
    ref: {
      harness: "claude-code",
      sessionId: id,
      filePath: `/tmp/fake/${id}.jsonl`,
      startedAt: now - 3_600_000,
      endedAt: now,
      title: `Edit session ${id}`,
    },
    events: [...toolEdits, ...assistantTurns],
    inlineRefs: [],
  };
}

/**
 * A session with BOTH markers >= 1 AND editCommit >= 0.5. Should PASS when
 * the floor is enabled (both conditions satisfied).
 */
function markerAndEditSession(id: string): SessionData {
  const now = Date.now();
  return {
    ref: {
      harness: "claude-code",
      sessionId: id,
      filePath: `/tmp/fake/${id}.jsonl`,
      startedAt: now - 3_600_000,
      endedAt: now,
      title: `Marker+edit session ${id}`,
    },
    events: [
      {
        harness: "claude-code",
        text: "TIL: the broken import was caused by a missing index file. Fixed it by adding the re-export.",
        ts: now - 3_000_000,
        sessionId: id,
        role: "assistant" as const,
        filePath: undefined,
      },
      {
        harness: "claude-code",
        text: "Applied the fix.",
        ts: now - 2_000_000,
        sessionId: id,
        role: "tool" as const,
        filePath: "/repo/src/index.ts",
      },
      {
        harness: "claude-code",
        text: "Wrote the test.",
        ts: now - 1_000_000,
        sessionId: id,
        role: "tool" as const,
        filePath: "/repo/tests/index.test.ts",
      },
    ],
    inlineRefs: [],
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Call scoreSessionTriage and apply the procedural-aware floor check on top.
 * This reflects the PLANNED extended behavior of scoreSessionTriage (or a
 * companion function) when proceduralAwareFloor is enabled.
 *
 * #641 may implement this as:
 *   - an additional `proceduralAwareFloor` field in `TriageConfig`, read inside
 *     `scoreSessionTriage`, or
 *   - a second config field on `TriageScore`, or
 *   - a wrapper that calls `scoreSessionTriage` and then applies the floor.
 *
 * The tests are written against `scoreSessionTriage` directly (the most natural
 * seam) — the flag is passed via a third `config` argument, or as an extended
 * `minScore` signature. Until the implementation exists, the tests FAIL because:
 *   - `scoreSessionTriage` has no third `config` argument, OR
 *   - it does not enforce the procedural-aware floor condition.
 *
 * Expected new signature (one of):
 *   scoreSessionTriage(data, minScore, config?: { proceduralAwareFloor?: boolean })
 *   OR
 *   scoreSessionTriage(data, config: { minScore: number; proceduralAwareFloor?: boolean })
 *
 * The tests below use the extended-config form:
 *   scoreSessionTriage(data, minScore, { proceduralAwareFloor: true })
 */
function scoreWithFloor(data: SessionData, minScore: number): ReturnType<typeof scoreSessionTriage> {
  // #641: calling with the third config argument that enables the floor.
  // This call will FAIL (or behave wrong) until the third argument is accepted
  // and the floor logic is implemented.
  return (
    scoreSessionTriage as (
      data: SessionData,
      minScore: number,
      config?: { proceduralAwareFloor?: boolean },
    ) => ReturnType<typeof scoreSessionTriage>
  )(data, minScore, { proceduralAwareFloor: true });
}

function scoreWithoutFloor(data: SessionData, minScore: number): ReturnType<typeof scoreSessionTriage> {
  // Default: no floor. Verifies default-preserving behavior.
  return scoreSessionTriage(data, minScore);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("#641 — procedural-aware floor: enabled path", () => {
  test("1: low-signal read-only session (score passes but no markers, no edits) is TRIAGED OUT when floor enabled", () => {
    // This is the key acceptance case for #641.
    // The session has enough substantive text to pass the raw minScore gate, BUT:
    //   markers = 0 (no narrative/decision keywords)
    //   editCommit = 0 (no file edits, no commit events)
    // With the procedural-aware floor enabled, the session must FAIL (pass=false).
    //
    // Verifies a low-signal read-only session is triaged out when the floor is enabled.
    // and returns pass=true for this session (score >= DEFAULT_TRIAGE_MIN_SCORE).
    const data = lowSignalReadonlySession("low-signal-1");

    // First verify the raw score would pass WITHOUT the floor (confirm fixture is valid):
    const rawScore = scoreWithoutFloor(data, DEFAULT_TRIAGE_MIN_SCORE);
    expect(rawScore.subscores.markers).toBe(0);
    expect(rawScore.subscores.editCommit).toBe(0);
    expect(rawScore.score).toBeGreaterThanOrEqual(DEFAULT_TRIAGE_MIN_SCORE);
    expect(rawScore.pass).toBe(true); // confirms the floor makes a difference

    // Now with floor enabled — must FAIL:
    const result = scoreWithFloor(data, DEFAULT_TRIAGE_MIN_SCORE);
    expect(result.pass).toBe(false); // #641 ASSERTION — FAILS until implemented
    expect(result.reason).toBe("low_signal");
    expect(result.subscores.markers).toBe(0);
    expect(result.subscores.editCommit).toBe(0);
  });

  test("2: session with markers >= 1 (no edits) PASSES when floor enabled", () => {
    // markers >= 1 satisfies the OR condition → pass=true even with floor enabled.
    // Verifies markers >= 1 satisfies the OR condition (the floor accepts it).
    const data = markerOnlySession("marker-only-2");
    const result = scoreWithFloor(data, DEFAULT_TRIAGE_MIN_SCORE);

    expect(result.subscores.markers).toBeGreaterThanOrEqual(1);
    expect(result.pass).toBe(true); // #641 ASSERTION
  });

  test("3: session with editCommit >= 0.5 (no markers) PASSES when floor enabled", () => {
    // editCommit >= 0.5 satisfies the OR condition → pass=true even with floor enabled.
    // Verifies editCommit >= 0.5 satisfies the OR condition (the floor accepts it).
    const data = editOnlySession("edit-only-3");
    const result = scoreWithFloor(data, DEFAULT_TRIAGE_MIN_SCORE);

    expect(result.subscores.editCommit).toBeGreaterThanOrEqual(0.5);
    expect(result.pass).toBe(true); // #641 ASSERTION
  });

  test("4: session with BOTH markers >= 1 AND editCommit >= 0.5 PASSES when floor enabled", () => {
    // Both conditions met — definitively passes the floor.
    // Verifies a session meeting both conditions definitively passes the floor.
    const data = markerAndEditSession("marker-edit-4");
    const result = scoreWithFloor(data, DEFAULT_TRIAGE_MIN_SCORE);

    expect(result.subscores.markers).toBeGreaterThanOrEqual(1);
    expect(result.subscores.editCommit).toBeGreaterThanOrEqual(0.5);
    expect(result.pass).toBe(true); // #641 ASSERTION
  });
});

describe("#641 — procedural-aware floor: default-preserving guard", () => {
  test("5: DEFAULT (floor off) — low-signal session that score-passes still PASSES (byte-identical behavior)", () => {
    // Without the floor flag, the existing gate is score >= minScore only.
    // The low-signal read-only session (markers=0, editCommit=0) MUST still pass
    // because the default behavior is unchanged.
    // This test must be GREEN immediately and must STAY green after implementation.
    const data = lowSignalReadonlySession("low-signal-default-5");
    const result = scoreWithoutFloor(data, DEFAULT_TRIAGE_MIN_SCORE);

    // Default (no floor): same session passes if score >= minScore
    expect(result.pass).toBe(true); // MUST pass — default behavior unchanged
    // Verify no floor artifact in the reason field
    expect(result.reason).toBeUndefined();
  });
});

describe("#641 — resolveTriageConfig: proceduralAwareFloor field", () => {
  test("6: resolveTriageConfig returns proceduralAwareFloor:false when absent", () => {
    // The resolved config must always include proceduralAwareFloor.
    // When the field is not in the user config, it defaults to false (DEFAULT OFF).
    // Verifies resolveTriageConfig defaults proceduralAwareFloor to false when absent.
    const resolved = resolveTriageConfig({ triage: { enabled: true } });
    expect((resolved as { proceduralAwareFloor?: boolean }).proceduralAwareFloor).toBe(false);
  });

  test("7: resolveTriageConfig returns proceduralAwareFloor:true when set", () => {
    // When the user sets proceduralAwareFloor: true, the resolved config must
    // reflect it so the caller (e.g. akmExtract) can gate the behavior.
    // Verifies resolveTriageConfig returns proceduralAwareFloor:true when set.
    const resolved = resolveTriageConfig({
      triage: { enabled: true, proceduralAwareFloor: true } as TriageConfig,
    });
    expect((resolved as { proceduralAwareFloor?: boolean }).proceduralAwareFloor).toBe(true);
  });

  test("8: TriageConfig type accepts proceduralAwareFloor field without TypeScript error", () => {
    // Type-level: assigning a TriageConfig with proceduralAwareFloor must compile.
    // At runtime: the object must be constructable without throwing.
    // FAILS at TYPE-CHECK if proceduralAwareFloor is not in the TriageConfig interface.
    const cfg: TriageConfig = {
      enabled: true,
      minScore: 2,
      proceduralAwareFloor: true, // #641 field — must be in the interface
    };
    expect(cfg.proceduralAwareFloor).toBe(true);
    expect(cfg.enabled).toBe(true);
    expect(cfg.minScore).toBe(2);
  });
});
