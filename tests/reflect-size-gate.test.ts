/**
 * Unit tests for {@link checkReflectSize} — the calibrated blended-bound
 * size gate introduced in 2026-05-22.
 *
 * Tests are organised by scenario:
 *   A. Guard bypass conditions (absent / tiny source)
 *   B. Original in-band cases that must still pass
 *   C. Original out-of-band rejections that must still be caught
 *   D. Small source + expansion (blended ceiling — new behaviour)
 *   E. Large source + shrinkage (ratio floor dominates — unchanged)
 *   F. Large source + expansion to hard cap
 *   G. Absolute floor protects small shrinkage on tiny-ish sources
 */

import { describe, expect, test } from "bun:test";
import {
  checkReflectSize,
  REFLECT_ABSOLUTE_CEILING_BYTES,
  REFLECT_ABSOLUTE_FLOOR_BYTES,
  REFLECT_ABSOLUTE_MAX_BYTES,
  REFLECT_EXPAND_RATIO_MAX,
  REFLECT_SHRINK_RATIO_MIN,
  REFLECT_SIZE_GUARD_MIN_BYTES,
} from "../src/core/proposal-quality-validators";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a string of exactly `n` bytes (ASCII 'x' × n). */
function body(n: number): string {
  return "x".repeat(n);
}

// ── A. Guard bypass ──────────────────────────────────────────────────────────

describe("checkReflectSize — guard bypass", () => {
  test("undefined source → ok:true (no source to compare)", () => {
    expect(checkReflectSize(undefined, body(10000))).toEqual({ ok: true });
  });

  test("empty string source → ok:true (below REFLECT_SIZE_GUARD_MIN_BYTES)", () => {
    expect(checkReflectSize("", body(10000))).toEqual({ ok: true });
  });

  test(`source body < ${REFLECT_SIZE_GUARD_MIN_BYTES} bytes → ok:true (gate skipped)`, () => {
    // Source has 100 bytes — below the 200-byte minimum for the gate.
    expect(checkReflectSize(body(100), body(1000))).toEqual({ ok: true });
  });

  test(`source body exactly ${REFLECT_SIZE_GUARD_MIN_BYTES - 1} bytes → ok:true`, () => {
    expect(checkReflectSize(body(REFLECT_SIZE_GUARD_MIN_BYTES - 1), body(REFLECT_SIZE_GUARD_MIN_BYTES * 10))).toEqual({
      ok: true,
    });
  });

  test(`source body exactly ${REFLECT_SIZE_GUARD_MIN_BYTES} bytes → gate active`, () => {
    // 10% of 200 = 20 bytes → catastrophic shrinkage; gate must fire.
    const result = checkReflectSize(body(REFLECT_SIZE_GUARD_MIN_BYTES), body(20));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("EXCESSIVE_SHRINKAGE");
  });
});

// ── B. In-band — must still pass ─────────────────────────────────────────────

describe("checkReflectSize — in-band ratio changes (should pass)", () => {
  test("ratio = 1.0 (unchanged body) → ok:true", () => {
    const src = body(1000);
    expect(checkReflectSize(src, src)).toEqual({ ok: true });
  });

  test("ratio = 0.8 (20% reduction) → ok:true", () => {
    expect(checkReflectSize(body(1000), body(800))).toEqual({ ok: true });
  });

  test("ratio = 1.2 (20% growth) → ok:true", () => {
    expect(checkReflectSize(body(1000), body(1200))).toEqual({ ok: true });
  });

  test("ratio = 1.9 (just under 200%) on a 1 KB source → ok:true", () => {
    expect(checkReflectSize(body(1000), body(1900))).toEqual({ ok: true });
  });

  test("ratio = 0.51 (just above 50%) on a 1 KB source → ok:true", () => {
    expect(checkReflectSize(body(1000), body(510))).toEqual({ ok: true });
  });
});

// ── C. Out-of-band — original rejections that must still fire ────────────────

describe("checkReflectSize — original out-of-band rejections (must still fire)", () => {
  test("catastrophic shrinkage (3 lines vs 200 lines, ~10%) → EXCESSIVE_SHRINKAGE", () => {
    // ~7KB source body, proposed ~10% = ~700 bytes → well below 50% floor.
    const sourceLen = 7000;
    const proposedLen = 700; // ≈ 10%
    const result = checkReflectSize(body(sourceLen), body(proposedLen));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("EXCESSIVE_SHRINKAGE");
    expect(result.ratio).toBeCloseTo(proposedLen / sourceLen, 3);
  });

  test("tripled body (300%) on large source → EXCESSIVE_EXPANSION", () => {
    // Source 3000 bytes, proposed 9000 = 300%.
    // ratio ceiling = max(2*3000=6000, 2000) = 6000; 9000 > 6000 → rejected.
    const result = checkReflectSize(body(3000), body(9000));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("EXCESSIVE_EXPANSION");
  });
});

// ── D. Small source + expansion (new blended behaviour) ─────────────────────

describe("checkReflectSize — small source expansion (blended ceiling)", () => {
  // Reference case: ~420-byte CSS pin (the motivating example from the spec).
  const SMALL_SOURCE_LEN = 420;

  test("small source (420 bytes), proposed at 239% (≈1004 bytes) → ok:true under blended ceiling", () => {
    // Old gate: 200% of 420 = 840 bytes ceiling → would have REJECTED at 1004.
    // New gate: max(2*420=840, 2000) = 2000 → ACCEPTS up to 2000 bytes.
    const proposedLen = Math.round(SMALL_SOURCE_LEN * 2.39); // 1004
    expect(proposedLen).toBeLessThanOrEqual(REFLECT_ABSOLUTE_CEILING_BYTES);
    const result = checkReflectSize(body(SMALL_SOURCE_LEN), body(proposedLen));
    expect(result.ok).toBe(true);
  });

  test("small source (420 bytes), proposed at exactly REFLECT_ABSOLUTE_CEILING_BYTES → ok:true", () => {
    const result = checkReflectSize(body(SMALL_SOURCE_LEN), body(REFLECT_ABSOLUTE_CEILING_BYTES));
    expect(result.ok).toBe(true);
  });

  test("small source (420 bytes), proposed 1 byte above REFLECT_ABSOLUTE_CEILING_BYTES → EXCESSIVE_EXPANSION", () => {
    // ceiling = max(2*420=840, 2000) = 2000; proposed = 2001 → reject.
    const result = checkReflectSize(body(SMALL_SOURCE_LEN), body(REFLECT_ABSOLUTE_CEILING_BYTES + 1));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("EXCESSIVE_EXPANSION");
  });

  test("p25 source (778 bytes), proposed at 200% (1556 bytes) → ok:true (ratio ceiling = max(1556, 2000)=2000)", () => {
    // max(2*778=1556, 2000) = 2000; 1556 < 2000 → accepted.
    const result = checkReflectSize(body(778), body(1556));
    expect(result.ok).toBe(true);
  });

  test("p25 source (778 bytes), proposed at 2001 bytes → EXCESSIVE_EXPANSION", () => {
    // max(2*778=1556, 2000) = 2000; 2001 > 2000 → rejected.
    const result = checkReflectSize(body(778), body(2001));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("EXCESSIVE_EXPANSION");
  });

  test("medium source (1100 bytes), proposed at 200% (2200 bytes) → ok:true (ratio ceiling 2200 > absolute 2000)", () => {
    // max(2*1100=2200, 2000) = 2200; 2200 <= 2200 → accepted.
    const result = checkReflectSize(body(1100), body(2200));
    expect(result.ok).toBe(true);
  });

  test("medium source (1100 bytes), proposed at 2201 bytes → EXCESSIVE_EXPANSION", () => {
    // max(2*1100=2200, 2000) = 2200; 2201 > 2200 → rejected.
    const result = checkReflectSize(body(1100), body(2201));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("EXCESSIVE_EXPANSION");
  });
});

// ── E. Large source shrinkage (ratio floor dominates) ────────────────────────

describe("checkReflectSize — large source shrinkage (ratio floor)", () => {
  // p90 source ~11.7KB
  const LARGE_SOURCE_LEN = 11721;

  test("large source (11.7KB), proposed at exactly 50% → ok:true (boundary)", () => {
    const proposed = Math.round(LARGE_SOURCE_LEN * REFLECT_SHRINK_RATIO_MIN);
    const result = checkReflectSize(body(LARGE_SOURCE_LEN), body(proposed));
    expect(result.ok).toBe(true);
  });

  test("large source (11.7KB), proposed at 49% → EXCESSIVE_SHRINKAGE (ratio floor dominates)", () => {
    // 50% of 11721 = 5860; absolute floor = 150; max(5860, 150) = 5860.
    // Proposed = 49% of 11721 = 5743 < 5860 → rejected.
    const proposed = Math.round(LARGE_SOURCE_LEN * 0.49);
    expect(proposed).toBeGreaterThan(REFLECT_ABSOLUTE_FLOOR_BYTES);
    const result = checkReflectSize(body(LARGE_SOURCE_LEN), body(proposed));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("EXCESSIVE_SHRINKAGE");
  });

  test("large source (7KB), 10% shrinkage (like FINAL_REVIEW case) → EXCESSIVE_SHRINKAGE", () => {
    // Mirrors the known-bad case: knowledge:projects/rlm/v0.0.0/FINAL_REVIEW
    const sourceLen = 7000;
    const proposedLen = Math.round(sourceLen * 0.1);
    const result = checkReflectSize(body(sourceLen), body(proposedLen));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("EXCESSIVE_SHRINKAGE");
  });
});

// ── F. Large source + expansion to hard cap ──────────────────────────────────

describe("checkReflectSize — hard cap (REFLECT_ABSOLUTE_MAX_BYTES)", () => {
  test("large source (30KB), proposed at 150% (45KB) → EXCESSIVE_EXPANSION (exceeds hard cap of 25KB)", () => {
    // Source 30000 bytes, ratio ceiling = max(2*30000=60000, 2000) = 60000.
    // But hard cap = 25000; min(60000, 25000) = 25000.
    // Proposed 45000 > 25000 → rejected even though ratio < 2x.
    const sourceLen = 30000;
    const proposedLen = Math.round(sourceLen * 1.5); // 45000
    expect(proposedLen).toBeGreaterThan(REFLECT_ABSOLUTE_MAX_BYTES);
    const result = checkReflectSize(body(sourceLen), body(proposedLen));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("EXCESSIVE_EXPANSION");
  });

  test("large source (14KB), proposed at exactly 25000 bytes (below 2x) → ok:true", () => {
    // Source 14000 bytes, ratio ceiling = max(2*14000=28000, 2000) = 28000.
    // min(28000, 25000) = 25000.  Proposed = 25000 → accepted.
    const result = checkReflectSize(body(14000), body(REFLECT_ABSOLUTE_MAX_BYTES));
    expect(result.ok).toBe(true);
  });

  test("large source (14KB), proposed at 25001 bytes → EXCESSIVE_EXPANSION (hard cap)", () => {
    const result = checkReflectSize(body(14000), body(REFLECT_ABSOLUTE_MAX_BYTES + 1));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("EXCESSIVE_EXPANSION");
  });

  test("source at p99 (43KB), proposed at 50KB → EXCESSIVE_EXPANSION (hard cap)", () => {
    // ratio 50000/43463 ≈ 1.15 (< 2x) but 50000 > 25000 hard cap → rejected.
    const result = checkReflectSize(body(43463), body(50000));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("EXCESSIVE_EXPANSION");
  });
});

// ── G. Absolute floor protects small shrinkage ───────────────────────────────

describe("checkReflectSize — absolute floor (REFLECT_ABSOLUTE_FLOOR_BYTES)", () => {
  test("source 250 bytes, proposed at 140 bytes → EXCESSIVE_SHRINKAGE (absolute floor=150 dominates)", () => {
    // 50% of 250 = 125; max(125, 150) = 150; proposed 140 < 150 → rejected.
    const result = checkReflectSize(body(250), body(140));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("EXCESSIVE_SHRINKAGE");
  });

  test("source 250 bytes, proposed at exactly REFLECT_ABSOLUTE_FLOOR_BYTES → ok:true", () => {
    // 50% of 250 = 125; max(125, 150) = 150; proposed = 150 → accepted.
    const result = checkReflectSize(body(250), body(REFLECT_ABSOLUTE_FLOOR_BYTES));
    expect(result.ok).toBe(true);
  });

  test("source 250 bytes, proposed at 151 bytes → ok:true (above absolute floor)", () => {
    const result = checkReflectSize(body(250), body(151));
    expect(result.ok).toBe(true);
  });

  test("source 400 bytes, proposed at 150 bytes → EXCESSIVE_SHRINKAGE (50% floor=200 > absolute floor=150)", () => {
    // 50% of 400 = 200; max(200, 150) = 200; proposed 150 < 200 → rejected.
    const result = checkReflectSize(body(400), body(150));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("EXCESSIVE_SHRINKAGE");
  });

  test("source 400 bytes, proposed at exactly 200 bytes → ok:true (ratio floor dominates)", () => {
    const result = checkReflectSize(body(400), body(200));
    expect(result.ok).toBe(true);
  });
});

// ── H. Exported constant sanity ──────────────────────────────────────────────

describe("checkReflectSize — exported constant sanity", () => {
  test("REFLECT_SHRINK_RATIO_MIN is 0.5", () => {
    expect(REFLECT_SHRINK_RATIO_MIN).toBe(0.5);
  });

  test("REFLECT_EXPAND_RATIO_MAX is 2.0", () => {
    expect(REFLECT_EXPAND_RATIO_MAX).toBe(2.0);
  });

  test("REFLECT_SIZE_GUARD_MIN_BYTES is 200", () => {
    expect(REFLECT_SIZE_GUARD_MIN_BYTES).toBe(200);
  });

  test("REFLECT_ABSOLUTE_FLOOR_BYTES is 150", () => {
    expect(REFLECT_ABSOLUTE_FLOOR_BYTES).toBe(150);
  });

  test("REFLECT_ABSOLUTE_CEILING_BYTES is 2000", () => {
    expect(REFLECT_ABSOLUTE_CEILING_BYTES).toBe(2000);
  });

  test("REFLECT_ABSOLUTE_MAX_BYTES is 25000", () => {
    expect(REFLECT_ABSOLUTE_MAX_BYTES).toBe(25000);
  });
});
