// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * In-process curate effectiveness guard, run on every CI pass.
 *
 * Seeds the frozen `curate-golden` corpus, indexes it with the deterministic
 * embedder (so the hybrid FTS+vector path runs reproducibly with no model),
 * runs `akmCurate` for each labeled query, and scores the RANK of the results
 * against hand-labeled judgments. Unlike the recall-only retrieval runner,
 * this catches ordering regressions (the "keyword leapfrog" class).
 *
 * Absolute scores reflect both curate quality AND the deterministic embedder's
 * crude (but fixed) semantics — they are NOT comparable to production. Their
 * value is (a) a reproducible floor that fails on a real ranking regression
 * and (b) a number diffable between akm source versions. See
 * the curate performance-eval methodology (2026-06).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  type CurateCaseMetrics,
  type CurateJudgment,
  scoreCurateCase,
  summarizeCurateMetrics,
} from "../../scripts/akm-eval/src/curate-metrics";
import { akmCurate } from "../../src/commands/read/curate";
import { akmShowUnified } from "../../src/commands/read/show";
import { saveConfig } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { withIsolatedAkmStorage } from "../_helpers/sandbox";

const FIXTURE = path.join(__dirname, "..", "fixtures", "stashes", "curate-golden");

interface JudgmentsFile {
  schemaVersion: number;
  corpus: string;
  queries: CurateJudgment[];
}

function loadJudgments(): JudgmentsFile {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE, "judgments.json"), "utf8")) as JudgmentsFile;
}

/**
 * Seed an isolated, deterministically-embedded, indexed copy of the golden
 * corpus, run `fn`, and always tear the sandbox down. Mirrors the
 * single-test-scoped storage pattern other curate tests use so the per-test
 * env tripwire stays satisfied.
 */
async function withSeededGolden<T>(
  fn: (curate: (q: string, limit: number) => Promise<string[]>) => Promise<T>,
): Promise<T> {
  const storage = withIsolatedAkmStorage({ AKM_EMBED_DETERMINISTIC: "1" });
  try {
    fs.cpSync(FIXTURE, storage.stashDir, { recursive: true });
    // The judgments file is not a stash asset — keep it out of the index.
    fs.rmSync(path.join(storage.stashDir, "judgments.json"), { force: true });
    saveConfig({
      semanticSearchMode: "auto",
      bundles: { stash: { path: storage.stashDir } },
      defaultBundle: "stash",
      registries: [],
    });
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const curate = async (query: string, limit: number): Promise<string[]> => {
      const result = await akmCurate({ query, limit });
      return result.items.map((item) => ("ref" in item ? item.ref : `registry:${item.id}`));
    };
    return await fn(curate);
  } finally {
    storage.cleanup();
  }
}

// Suite-wide floors. Set conservatively BELOW the measured mean so the gate
// fails on a real regression, not on noise. The leapfrog gate is the
// embedder-robust signal and is held to a high bar.
// Baseline (deterministic, exact): meanScore≈0.890, meanNoLeapfrog=1.000.
// Floors sit just below baseline so a real ranking regression trips the gate
// while a benign refactor does not. Fine-grained per-case cross-version drift
// is the bench's job (akm-eval-curate-bench compare); this is the coarse CI
// floor + the strict leapfrog gate (one new leapfrog over 10 cases ⇒ 0.90 < floor).
const MEAN_SCORE_FLOOR = 0.85;
const MEAN_NO_LEAPFROG_FLOOR = 0.95;

describe("curate golden effectiveness", () => {
  test("labels resolve, suite meets floors, and curate is deterministic", async () => {
    const judgments = loadJudgments();
    await withSeededGolden(async (curate) => {
      // (a) Label integrity: every labeled ref must exist in the corpus.
      const allRefs = new Set<string>();
      for (const q of judgments.queries) {
        for (const r of [...q.relevant, ...q.idealOrder, ...q.banned]) allRefs.add(r);
      }
      for (const ref of allRefs) {
        const shown = await akmShowUnified({ ref }).catch(() => undefined);
        expect(shown, `labeled ref not found in corpus: ${ref}`).toBeDefined();
      }

      // (b) Score every query and aggregate.
      const metrics: CurateCaseMetrics[] = [];
      const firstRun = new Map<string, string[]>();
      const rows: string[] = [];
      for (const j of judgments.queries) {
        const refs = await curate(j.query, j.limit);
        firstRun.set(j.id, refs);
        const m = scoreCurateCase(refs, j);
        metrics.push(m);
        rows.push(
          `  ${j.id.padEnd(22)} score=${m.score.toFixed(3)} ndcg=${m.ndcg.toFixed(2)} ` +
            `recall=${m.recall.toFixed(2)} mrr=${m.mrr.toFixed(2)} ` +
            `noLeapfrog=${m.noBannedAboveRequired.toFixed(2)} (${m.bannedLeapfrogCount} leapfrog)`,
        );
      }
      const summary = summarizeCurateMetrics(metrics);
      console.log(
        `\n[curate-golden] mean score=${summary.meanScore.toFixed(3)} ndcg=${summary.meanNdcg.toFixed(3)} ` +
          `recall=${summary.meanRecall.toFixed(3)} mrr=${summary.meanMrr.toFixed(3)} ` +
          `noLeapfrog=${summary.meanNoBannedAboveRequired.toFixed(3)} ` +
          `totalLeapfrog=${summary.totalBannedLeapfrog}\n${rows.join("\n")}`,
      );
      expect(summary.meanScore).toBeGreaterThanOrEqual(MEAN_SCORE_FLOOR);
      expect(summary.meanNoBannedAboveRequired).toBeGreaterThanOrEqual(MEAN_NO_LEAPFROG_FLOOR);

      // (c) Determinism: a second run yields identical ordering.
      for (const j of judgments.queries) {
        const again = await curate(j.query, j.limit);
        expect(again, `non-deterministic curate for ${j.id}`).toEqual(firstRun.get(j.id) ?? []);
      }
    });
  });

  test("the rank metric is sensitive to order (a banned-first order scores worse)", () => {
    const judgments = loadJudgments();
    const j = judgments.queries.find((q) => q.banned.length > 0 && q.relevant.length > 0);
    expect(j, "fixture must contain a query with both relevant and banned refs").toBeDefined();
    if (!j) return;
    const good = [...j.idealOrder, ...j.banned];
    const bad = [...j.banned, ...j.idealOrder];
    expect(scoreCurateCase(bad, j).score).toBeLessThan(scoreCurateCase(good, j).score);
  });
});
