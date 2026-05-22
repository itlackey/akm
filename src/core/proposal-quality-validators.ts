/**
 * Shared content-quality validators consumed by the improve pipeline
 * (`distill`, `consolidate`, `reflect`) and by the `proposal accept` gate.
 *
 * ## Reflect size gate — calibrated blended formula (2026-05-22)
 *
 * ### Distribution baseline (n=844 reflect-eligible stash assets)
 *
 *   min=1  p10=371  p25=778  p50=1508  p75=5456  p90=11721  p99=43463  max=298010 bytes
 *   Buckets: <500=135 (16%), 500–2000=340 (40%), 2000–8000=222 (26%), >8000=147 (17%)
 *
 * ### Problem with the original fixed-ratio gate
 *
 *   - Small sources (~420 bytes, 16th pct): the 200% expansion ceiling fires at
 *     only 840 bytes proposed — one good paragraph.  Hair-trigger for a terse
 *     reference note.
 *   - Large sources (~7KB, 75th pct): 200% ceiling = 14KB; reasonable, but a hard
 *     cap prevents runaway expansion from LLM hallucinations.
 *
 * ### Blended-bound formula
 *
 *   Shrinkage floor (accept if proposed >= lower):
 *     lower = max(REFLECT_SHRINK_RATIO_MIN * sourceLen, REFLECT_ABSOLUTE_FLOOR_BYTES)
 *     → For tiny sources (sourceLen < 300), the absolute floor dominates so a
 *       genuinely tightened note still passes.
 *     → For large sources (>1KB), the ratio floor dominates (50% of 7KB = 3.5KB).
 *
 *   Expansion ceiling (accept if proposed <= upper):
 *     upper = max(REFLECT_EXPAND_RATIO_MAX * sourceLen, REFLECT_ABSOLUTE_CEILING_BYTES)
 *     …but always capped at REFLECT_ABSOLUTE_MAX_BYTES.
 *     → For small sources (≤778 bytes, p25), the absolute ceiling (2000 bytes)
 *       dominates — one substantive paragraph is always acceptable.
 *     → For medium/large sources (>1KB), the ratio ceiling dominates.
 *     → Any proposal exceeding 25000 bytes is always rejected regardless of ratio.
 *
 * ### Constant calibration rationale
 *
 *   REFLECT_ABSOLUTE_FLOOR_BYTES = 150
 *     Half of p10 (371) ≈ 185; we set 150 so even very aggressive condensation
 *     of a seed note is allowed down to roughly a two-sentence summary.
 *
 *   REFLECT_ABSOLUTE_CEILING_BYTES = 2000
 *     Slightly above p50 (1508). A small source (420 bytes) should be allowed to
 *     grow to a full reference note (~2KB) without tripping the gate.
 *
 *   REFLECT_ABSOLUTE_MAX_BYTES = 25000
 *     Below p99 (43463). Catches genuine LLM runaway (whole-chapter insertions)
 *     without blocking legitimate large rewrites of large sources.
 *
 *   REFLECT_EXPAND_RATIO_MAX = 2.0, REFLECT_SHRINK_RATIO_MIN = 0.5 (unchanged)
 *     Ratio bounds remain the same; the absolute overrides handle the edge cases.
 */

// ── Reflect-size guard ───────────────────────────────────────────────────────

/** Ratio lower-bound: proposed body must be at least this fraction of source. */
export const REFLECT_SHRINK_RATIO_MIN = 0.5;
/** Ratio upper-bound: proposed body must not exceed this fraction of source. */
export const REFLECT_EXPAND_RATIO_MAX = 2.0;

/**
 * Below this byte count, ratio checks are too noisy — skip them entirely.
 * Unchanged from the original gate.
 */
export const REFLECT_SIZE_GUARD_MIN_BYTES = 200;

/**
 * Absolute shrinkage floor (bytes).  Even if `ratio * sourceLen` is lower, a
 * proposed body of at least this many bytes is always accepted on the shrinkage
 * side.  Protects against false positives when the source is small (<300 bytes).
 */
export const REFLECT_ABSOLUTE_FLOOR_BYTES = 150;

/**
 * Absolute expansion ceiling (bytes).  Even if `ratio * sourceLen` is lower, a
 * proposed body up to this many bytes is always accepted on the expansion side.
 * Protects against false positives when the source is small (≤778 bytes, p25).
 */
export const REFLECT_ABSOLUTE_CEILING_BYTES = 2000;

/**
 * Hard expansion cap (bytes).  Regardless of ratio, a proposed body exceeding
 * this limit is always rejected.  Guards against runaway LLM hallucinations on
 * large sources.
 */
export const REFLECT_ABSOLUTE_MAX_BYTES = 25000;

/** Outcome of {@link checkReflectSize}: ok, or a rejection envelope. */
export type ReflectSizeOutcome =
  | { ok: true }
  | { ok: false; code: "EXCESSIVE_SHRINKAGE" | "EXCESSIVE_EXPANSION"; ratio: number };

/**
 * Calibrated size check: compare proposed body length against source body
 * length using a blended-bound formula.
 *
 * **Shrinkage** — accept if:
 *   `proposedLen >= max(REFLECT_SHRINK_RATIO_MIN * sourceLen, REFLECT_ABSOLUTE_FLOOR_BYTES)`
 *
 * **Expansion** — accept if:
 *   `proposedLen <= min(max(REFLECT_EXPAND_RATIO_MAX * sourceLen, REFLECT_ABSOLUTE_CEILING_BYTES), REFLECT_ABSOLUTE_MAX_BYTES)`
 *
 * Returns `{ ok: true }` when:
 *   - `sourceBody` is absent or `undefined`
 *   - source body is shorter than {@link REFLECT_SIZE_GUARD_MIN_BYTES}
 *   - the proposed length is within the blended bounds
 */
export function checkReflectSize(sourceBody: string | undefined, proposedBody: string): ReflectSizeOutcome {
  if (typeof sourceBody !== "string") return { ok: true };
  const sourceLen = sourceBody.trim().length;
  if (sourceLen < REFLECT_SIZE_GUARD_MIN_BYTES) return { ok: true };
  const proposedLen = proposedBody.trim().length;
  const ratio = proposedLen / sourceLen;

  // Shrinkage check: lower bound = max(ratio floor, absolute floor)
  const shrinkFloor = Math.max(REFLECT_SHRINK_RATIO_MIN * sourceLen, REFLECT_ABSOLUTE_FLOOR_BYTES);
  if (proposedLen < shrinkFloor) {
    return { ok: false, code: "EXCESSIVE_SHRINKAGE", ratio };
  }

  // Expansion check: upper bound = min(max(ratio ceiling, absolute ceiling), hard cap)
  const expandCeiling = Math.min(
    Math.max(REFLECT_EXPAND_RATIO_MAX * sourceLen, REFLECT_ABSOLUTE_CEILING_BYTES),
    REFLECT_ABSOLUTE_MAX_BYTES,
  );
  if (proposedLen > expandCeiling) {
    return { ok: false, code: "EXCESSIVE_EXPANSION", ratio };
  }

  return { ok: true };
}
