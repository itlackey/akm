// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Two-tailed monitor pins (meta-review 05, DRIFT-3).
 *
 * The watchdogs previously fired on only one tail: proxy-adequacy alarmed only
 * when corr < −0.3 (a proxy decaying to pure noise passed forever), and the
 * salience Gini check flagged only entrenchment (> 0.35) while a distribution
 * collapsed toward uniform (live value 0.040, below the ~0.1 uniform baseline)
 * rendered as healthy. These tests pin both new tails.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { computeDegradationMetrics } from "../../../../src/commands/health/metrics";
import {
  type AssetOutcomeRow,
  computeProxyAdequacy,
  PROXY_DEAD_MIN_N,
} from "../../../../src/commands/improve/outcome-loop";
import type { Database as AkmDatabase } from "../../../../src/storage/database";

// ── proxy adequacy ───────────────────────────────────────────────────────────

function outcomeRow(ref: string, outcomeScore: number, acceptedCount: number, retrievalCount: number): AssetOutcomeRow {
  return {
    asset_ref: ref,
    last_retrieved_at: 0,
    retrieval_count: retrievalCount,
    expected_retrieval_rate: 0,
    negative_feedback_count: 0,
    accepted_change_count: acceptedCount,
    outcome_score: outcomeScore,
    updated_at: 0,
  };
}

/**
 * Rows with exactly zero correlation between outcome_score and
 * accepted_change_rate: outcome alternates with period 2, rate with period 4,
 * so over any multiple of 4 rows the two are orthogonal.
 */
function uncorrelatedRows(n: number): AssetOutcomeRow[] {
  const rows: AssetOutcomeRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push(outcomeRow(`x:${i}`, i % 2, (i >> 1) % 2, 1));
  }
  return rows;
}

describe("computeProxyAdequacy — two-tailed", () => {
  test("DEAD: |corr| < 0.1 at n ≥ PROXY_DEAD_MIN_N fires isDead", () => {
    const rows = uncorrelatedRows(PROXY_DEAD_MIN_N); // 500 = 125 × 4 → corr exactly 0
    const result = computeProxyAdequacy(rows);
    expect(Math.abs(result.correlation)).toBeLessThan(0.1);
    expect(result.isDead).toBe(true);
    expect(result.isInverted).toBe(false);
  });

  test("below the n threshold, zero correlation is NOT flagged dead (small-sample noise)", () => {
    const rows = uncorrelatedRows(496); // 124 × 4, still corr 0, but n < 500
    const result = computeProxyAdequacy(rows);
    expect(result.isDead).toBe(false);
  });

  test("INVERTED tail still fires and is not confused with dead", () => {
    // Perfect negative correlation: outcome ascends while accepted rate descends.
    const n = 600;
    const rows: AssetOutcomeRow[] = [];
    for (let i = 0; i < n; i++) {
      rows.push(outcomeRow(`x:${i}`, i / n, n - i, n));
    }
    const result = computeProxyAdequacy(rows);
    expect(result.correlation).toBeLessThan(-0.3);
    expect(result.isInverted).toBe(true);
    expect(result.isDead).toBe(false);
  });

  test("a genuinely informative proxy passes both tails", () => {
    const n = 600;
    const rows: AssetOutcomeRow[] = [];
    for (let i = 0; i < n; i++) {
      rows.push(outcomeRow(`x:${i}`, i / n, i, n));
    }
    const result = computeProxyAdequacy(rows);
    expect(result.correlation).toBeGreaterThan(0.3);
    expect(result.isInverted).toBe(false);
    expect(result.isDead).toBe(false);
  });
});

// ── salience Gini ────────────────────────────────────────────────────────────

function salienceDb(retrievalSaliences: number[]): AkmDatabase {
  const db = new Database(":memory:") as unknown as AkmDatabase;
  db.exec(`
    CREATE TABLE asset_salience (
      asset_ref          TEXT    PRIMARY KEY,
      encoding_salience  REAL    NOT NULL DEFAULT 0.5,
      outcome_salience   REAL    NOT NULL DEFAULT 0.0,
      retrieval_salience REAL    NOT NULL DEFAULT 0.0,
      rank_score         REAL    NOT NULL DEFAULT 0.0,
      consecutive_no_ops INTEGER NOT NULL DEFAULT 0,
      updated_at         INTEGER NOT NULL DEFAULT 0
    );
  `);
  const stmt = db.prepare("INSERT INTO asset_salience (asset_ref, retrieval_salience, rank_score) VALUES (?, ?, ?)");
  retrievalSaliences.forEach((v, i) => {
    stmt.run(`x:${i}`, v, v);
  });
  return db;
}

const SINCE = "2026-01-01T00:00:00.000Z";
const UNTIL = "2026-12-31T00:00:00.000Z";

describe("computeDegradationMetrics — Gini two-tailed", () => {
  test("collapsed-toward-uniform distribution (Gini < 0.08) flags uniformity, not entrenchment", () => {
    // Near-identical scores: Gini ≈ 0.005 — the live 2026-07 failure shape.
    const values = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 0.49 : 0.51));
    const db = salienceDb(values);
    const result = computeDegradationMetrics(db, SINCE, UNTIL);
    expect(result?.salienceUniformityFlagged).toBe(true);
    expect(result?.entrenchmentFlagged).toBe(false);
  });

  test("healthy spread (Gini between 0.08 and 0.35) flags neither tail", () => {
    // Alternating 0.25/0.75 → Gini 0.125 under the top-100 formula.
    const values = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 0.25 : 0.75));
    const db = salienceDb(values);
    const result = computeDegradationMetrics(db, SINCE, UNTIL);
    expect(result?.salienceUniformityFlagged).toBe(false);
    expect(result?.entrenchmentFlagged).toBe(false);
  });

  test("entrenched distribution (Gini > 0.35) still flags entrenchment, not uniformity", () => {
    // One dominant asset, nine near-zero → Gini ≈ 0.41.
    const values = [1.0, ...Array.from({ length: 9 }, () => 0.01)];
    const db = salienceDb(values);
    const result = computeDegradationMetrics(db, SINCE, UNTIL);
    expect(result?.entrenchmentFlagged).toBe(true);
    expect(result?.salienceUniformityFlagged).toBe(false);
  });

  test("fewer than 5 salience rows leaves both flags undefined (insufficient data)", () => {
    const db = salienceDb([0.5, 0.5, 0.5]);
    const result = computeDegradationMetrics(db, SINCE, UNTIL);
    expect(result?.entrenchmentFlagged).toBeUndefined();
    expect(result?.salienceUniformityFlagged).toBeUndefined();
  });
});
