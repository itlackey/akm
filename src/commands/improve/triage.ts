// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #626 — extract session-triage pre-LLM heuristic gate.
 *
 * A pure, deterministic heuristic scorer that decides — BEFORE the extraction
 * LLM call — whether a session carries enough signal to be worth extracting.
 * Zero added LLM cost: it operates ONLY on the already-read `data.events`, with
 * no I/O, no `Date.now`, and no LLM call.
 *
 * The gate is DEFAULT-OFF (see {@link resolveTriageConfig}); with config absent
 * `akmExtract` reproduces today's behaviour byte-for-byte. When enabled it runs
 * AFTER the minContentChars + already-extracted skip checks and BEFORE the
 * extraction prompt / session-asset write.
 *
 * DESIGN-COHERENCE (#615 procedural compilation): a high-action session (dense
 * tool-use / edits / commits) with NO narrative-lesson markers must still PASS.
 * The procedural sub-scores (`toolDensity` + `editCommit`) alone clear the bar
 * so ordered-action data is never dropped before #615 can compile it.
 */

import type { SessionData } from "../../integrations/session-logs/types";

/** Per-process triage config (lives under `processes.extract.triage`). */
export interface TriageConfig {
  enabled?: boolean;
  minScore?: number;
  /**
   * #641 — procedural-aware floor (opt-in, DEFAULT OFF).
   *
   * When `true`, a session PASSES only when:
   *   score >= minScore AND (markers >= 1 OR editCommit >= 0.5)
   *
   * Sessions that clear the score gate via toolDensity + substantiveRatio alone
   * (read-only Q&A with no narrative markers and no file edits) are rejected as
   * low-signal. Sessions with real edit/commit signal or narrative markers always
   * pass (protects #615 procedural compilation sessions).
   *
   * Recommended ON in production; left DEFAULT OFF to preserve byte-identical
   * behaviour for existing users who have not opted in.
   */
  proceduralAwareFloor?: boolean;
}

/**
 * Default minimum total score a session must reach to PASS the gate. Tuned
 * conservatively: a single real narrative-lesson session, or a procedurally
 * dense session, clears it — but pure read-only Q&A does not. Config-overridable
 * via `processes.extract.triage.minScore`.
 */
export const DEFAULT_TRIAGE_MIN_SCORE = 2;

export interface TriageScore {
  pass: boolean;
  score: number;
  subscores: {
    markers: number;
    toolDensity: number;
    editCommit: number;
    substantiveRatio: number;
  };
  reason?: "low_signal";
}

// Decision / outcome / error narrative markers. Case-insensitive, word-bounded.
const MARKER_RE =
  /\b(error|failed|fix(?:ed)?|root cause|turns out|because|decided|instead|gotcha|workaround|regress(?:ed)?|broke|TIL)\b/i;

// Edit / commit / file-write markers in tool event text.
const EDIT_COMMIT_RE = /\b(Edit|Write|MultiEdit|git commit|diff)\b/i;

// A substantive turn is an assistant or tool turn whose text is non-trivial.
const SUBSTANTIVE_MIN_CHARS = 40;

/**
 * Pure heuristic scorer. Operates only on `data.events`. Each sub-signal is
 * normalized to a small bounded contribution; `score` is their sum and
 * `pass = score >= minScore`.
 *
 * Sub-signals:
 *   - markers: presence of decision/outcome/error keywords across event text
 *     (capped, narrative-lesson signal).
 *   - toolDensity: bounded contribution from tool-use events (procedural).
 *   - editCommit: bounded contribution from edit/write/commit events (procedural).
 *   - substantiveRatio: scaled fraction of non-trivial assistant+tool turns,
 *     filtering pure short Q&A.
 *
 * The procedural sub-signals (toolDensity + editCommit) alone can clear
 * DEFAULT_TRIAGE_MIN_SCORE so high-action / no-narrative sessions are KEPT (#615).
 */
/**
 * Optional config for {@link scoreSessionTriage}. All fields are opt-in and
 * default-preserving: omitting this argument reproduces the pre-#641 behaviour.
 */
export interface ScoreSessionTriageOptions {
  /** Enable the #641 procedural-aware floor. DEFAULT OFF. */
  proceduralAwareFloor?: boolean;
}

export function scoreSessionTriage(
  data: SessionData,
  minScore: number,
  options?: ScoreSessionTriageOptions,
): TriageScore {
  const events = data.events;
  const total = events.length;

  // (a) markers — count word-bounded marker hits across all event text, capped.
  let markerHits = 0;
  for (const e of events) {
    if (MARKER_RE.test(e.text)) markerHits += 1;
  }
  // Each marker-bearing event contributes 1 point, capped at 2 (a single real
  // narrative session clears the bar on markers alone).
  const markers = Math.min(markerHits, 2);

  // (b) toolDensity — bounded contribution from tool-use events.
  let toolEvents = 0;
  for (const e of events) {
    if (e.role === "tool") toolEvents += 1;
  }
  // 0.25 per tool event, capped at 1.5.
  const toolDensity = Math.min(toolEvents * 0.25, 1.5);

  // (c) editCommit — bounded contribution from edit/write/commit markers on
  // events (filePath present, or text matching the edit/commit regex).
  let editCommitEvents = 0;
  for (const e of events) {
    if (e.filePath || EDIT_COMMIT_RE.test(e.text)) editCommitEvents += 1;
  }
  // 0.25 per edit/commit event, capped at 1.5. Together with toolDensity a
  // procedurally dense session reaches well above the default threshold.
  const editCommit = Math.min(editCommitEvents * 0.25, 1.5);

  // (d) substantiveRatio — scaled fraction of non-trivial assistant+tool turns.
  let substantive = 0;
  for (const e of events) {
    if ((e.role === "assistant" || e.role === "tool") && e.text.length >= SUBSTANTIVE_MIN_CHARS) {
      substantive += 1;
    }
  }
  const ratio = total > 0 ? substantive / total : 0;
  // Scale to a bounded [0,1] contribution.
  const substantiveRatio = Math.min(ratio, 1);

  const subscores = { markers, toolDensity, editCommit, substantiveRatio };
  const score = markers + toolDensity + editCommit + substantiveRatio;

  // Base gate: score must clear the floor.
  let pass = score >= minScore;

  // #641 procedural-aware floor (opt-in, DEFAULT OFF).
  // When enabled, a session that clears the score gate must ALSO have at least
  // one narrative marker (markers >= 1) OR meaningful edit/commit signal
  // (editCommit >= 0.5). Pure read-only Q&A sessions that pass only via
  // toolDensity + substantiveRatio are rejected as low-signal.
  if (pass && options?.proceduralAwareFloor === true) {
    const hasProceduralSignal = markers >= 1 || editCommit >= 0.5;
    if (!hasProceduralSignal) {
      pass = false;
    }
  }

  return {
    pass,
    score,
    subscores,
    ...(pass ? {} : { reason: "low_signal" as const }),
  };
}

/**
 * Resolve the effective triage config from the extract process config. Mirrors
 * the minContentChars / schemaSimilarity resolution style in akmExtract.
 *
 * Default-off: `enabled` is FALSE unless `triage.enabled === true`. `minScore`
 * defaults to {@link DEFAULT_TRIAGE_MIN_SCORE}.
 */
export function resolveTriageConfig(extractProcess: unknown): {
  enabled: boolean;
  minScore: number;
  proceduralAwareFloor: boolean;
} {
  const triage = (extractProcess as { triage?: TriageConfig } | undefined)?.triage;
  const enabled = triage?.enabled === true;
  const minScore = typeof triage?.minScore === "number" ? triage.minScore : DEFAULT_TRIAGE_MIN_SCORE;
  // #641: default-off — only true when explicitly set to true.
  const proceduralAwareFloor = triage?.proceduralAwareFloor === true;
  return { enabled, minScore, proceduralAwareFloor };
}
