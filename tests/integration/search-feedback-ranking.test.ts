// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Feedback moves search ranking, whatever an asset's search and show history,
 * and the effect is rebuilt from the feedback events by every `akm index`.
 *
 * Integration (AGENTS.md classification): opens a real index.db through
 * `akmIndex` and `akm search`, and a real state.db through `akm feedback`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { openStateDatabase } from "../../src/core/state-db";
import { akmIndex } from "../../src/indexer/indexer";
import {
  closeDatabase,
  openExistingDatabase,
  openIndexDatabase,
} from "../../src/storage/repositories/index-connection";
import { CANONICAL_INDEX_DB_VERSION } from "../../src/storage/repositories/index-entry-schema";
import { getMeta } from "../../src/storage/repositories/index-meta-repository";
import { getUtilityScore } from "../../src/storage/repositories/index-utility-repository";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

const QUERY = "deployment guide";
const NAMES = ["alpha-guide", "beta-guide", "gamma-guide"] as const;

let storage: IsolatedAkmStorage;

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  for (const name of NAMES) {
    const file = path.join(storage.stashDir, "knowledge", `${name}.md`);
    fs.writeFileSync(
      file,
      `---\ndescription: deployment guide ${name}\n---\nThe deployment guide explains how to deploy services safely. Variant ${name}.\n`,
    );
  }
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
  });
  await akmIndex({ stashDir: storage.stashDir, full: true });
});

afterEach(() => storage.cleanup());

/** `name -> score` in result order. */
async function searchScores(): Promise<Array<[string, number]>> {
  const { stdout, code } = await runCliCapture(["search", QUERY, "--format=json", "--detail=normal"]);
  expect(code).toBe(0);
  const hits = JSON.parse(stdout).hits as Array<{ name: string; score: number }>;
  return hits.map((hit) => [hit.name, hit.score]);
}

const names = (scores: Array<[string, number]>) => scores.map(([name]) => name);
const scoreOf = (scores: Array<[string, number]>, name: string) => scores.find(([n]) => n === name)?.[1] as number;

async function feedback(name: string, signal: "--positive" | "--negative"): Promise<void> {
  const args = ["feedback", `knowledge/${name}`, signal, "--format=json"];
  if (signal === "--negative") args.push("--reason", "out of date");
  const { code, stdout } = await runCliCapture(args);
  expect(code).toBe(0);
  expect(JSON.parse(stdout).rankingUpdate).toMatchObject({ applied: true });
}

describe("akm feedback and search ranking", () => {
  test("negative feedback ranks an asset below its neighbour and positive feedback raises it again", async () => {
    const baseline = await searchScores();
    expect(names(baseline)).toEqual([...NAMES]);
    expect(await searchScores()).toEqual(baseline);

    await feedback("alpha-guide", "--negative");
    const afterNegative = await searchScores();
    expect(names(afterNegative)).toEqual(["beta-guide", "alpha-guide", "gamma-guide"]);
    expect(scoreOf(afterNegative, "alpha-guide")).toBeLessThan(scoreOf(baseline, "alpha-guide"));

    await feedback("alpha-guide", "--positive");
    const afterOnePositive = await searchScores();
    expect(scoreOf(afterOnePositive, "alpha-guide")).toBeGreaterThan(scoreOf(afterNegative, "alpha-guide"));

    await feedback("alpha-guide", "--positive");
    const afterTwoPositives = await searchScores();
    expect(names(afterTwoPositives)).toEqual([...NAMES]);
    expect(scoreOf(afterTwoPositives, "alpha-guide")).toBeGreaterThan(scoreOf(afterOnePositive, "alpha-guide"));
  });

  test("assets that received no feedback keep their scores and order", async () => {
    const baseline = await searchScores();
    await feedback("alpha-guide", "--negative");
    const after = await searchScores();
    for (const name of ["beta-guide", "gamma-guide"]) {
      expect(scoreOf(after, name)).toBe(scoreOf(baseline, name));
    }
  });

  test("the adjustment is a few percent of the fused score and never changes whyMatched", async () => {
    const baseline = await searchScores();
    await feedback("alpha-guide", "--negative");
    const ratio = scoreOf(await searchScores(), "alpha-guide") / scoreOf(baseline, "alpha-guide");
    // One negative from the 0.5 midpoint stores utility 0.45: factor 1 + 0.5 * (0.45 - 0.5) = 0.975.
    expect(ratio).toBeCloseTo(0.975, 3);

    const { stdout } = await runCliCapture(["search", QUERY, "--format=json", "--detail=full"]);
    const hit = (JSON.parse(stdout).hits as Array<{ name: string; whyMatched?: string[] }>).find(
      (h) => h.name === "alpha-guide",
    );
    expect(hit?.whyMatched).toEqual(["lexical rank 1"]);
  });

  test("a row the index seeds from search results at utility 0 does not move an asset", async () => {
    const baseline = await searchScores();
    // The searches above logged user events; `akm index` turns them into utility_scores rows.
    await akmIndex({ stashDir: storage.stashDir });
    const db = openExistingDatabase(getDbPath());
    try {
      const seeded = db.prepare("SELECT entry_id FROM utility_scores").all() as Array<{ entry_id: number }>;
      expect(seeded.length).toBe(NAMES.length);
      for (const { entry_id } of seeded) {
        expect(getUtilityScore(db, entry_id)).toMatchObject({ utility: 0, searchCount: 1, showCount: 0 });
      }
    } finally {
      closeDatabase(db);
    }
    expect(await searchScores()).toEqual(baseline);
  });
});

/** Run `akm show` so the asset has a recorded show event. */
async function show(name: string): Promise<void> {
  const { code } = await runCliCapture(["show", `knowledge/${name}`, "--format=json"]);
  expect(code).toBe(0);
}

function utilityRow(name: string) {
  const db = openExistingDatabase(getDbPath());
  try {
    return db
      .prepare(
        `SELECT u.utility, u.search_count, u.show_count, u.feedback_score, u.feedback_count
           FROM utility_scores u JOIN entries e ON e.id = u.entry_id WHERE e.item_ref = ?`,
      )
      .get(`stash//knowledge/${name}`) as
      | {
          utility: number;
          search_count: number;
          show_count: number;
          feedback_score: number | null;
          feedback_count: number;
        }
      | undefined;
  } finally {
    closeDatabase(db);
  }
}

describe("feedback on an asset that has search and show history", () => {
  async function indexWithHistory(): Promise<Array<[string, number]>> {
    const baseline = await searchScores();
    await show("alpha-guide");
    await show("beta-guide");
    await akmIndex({ stashDir: storage.stashDir });
    expect(utilityRow("alpha-guide")).toMatchObject({ search_count: 1, show_count: 1, feedback_count: 0 });
    expect(utilityRow("alpha-guide")?.feedback_score).toBeNull();
    return baseline;
  }

  test("the index leaves scores and order unchanged, then negative feedback ranks the asset lower and positive raises it", async () => {
    const baseline = await indexWithHistory();
    const afterIndex = await searchScores();
    expect(afterIndex).toEqual(baseline);

    await feedback("alpha-guide", "--negative");
    const afterNegative = await searchScores();
    expect(names(afterNegative)).toEqual(["beta-guide", "alpha-guide", "gamma-guide"]);
    expect(scoreOf(afterNegative, "alpha-guide") / scoreOf(baseline, "alpha-guide")).toBeCloseTo(0.975, 3);
    expect(scoreOf(afterNegative, "beta-guide")).toBe(scoreOf(baseline, "beta-guide"));

    await feedback("alpha-guide", "--positive");
    await feedback("alpha-guide", "--positive");
    const afterPositives = await searchScores();
    expect(names(afterPositives)).toEqual([...NAMES]);
    expect(scoreOf(afterPositives, "alpha-guide")).toBeGreaterThan(scoreOf(afterNegative, "alpha-guide"));
  });

  test("the feedback score starts at the midpoint, not from the utility the index derived from searches", async () => {
    await indexWithHistory();
    await feedback("alpha-guide", "--positive");
    const row = utilityRow("alpha-guide");
    expect(row?.feedback_count).toBe(1);
    expect(row?.feedback_score).toBeCloseTo(0.55, 12);
    expect(row?.utility).not.toBeCloseTo(0.55, 3);
  });

  test("the effect survives akm index, a full reindex, and a reset of the stored scores", async () => {
    const baseline = await indexWithHistory();
    await feedback("alpha-guide", "--negative");
    await feedback("gamma-guide", "--positive");
    const adjusted = await searchScores();
    expect(names(adjusted)).toEqual(["gamma-guide", "beta-guide", "alpha-guide"]);

    await akmIndex({ stashDir: storage.stashDir });
    expect(await searchScores()).toEqual(adjusted);

    await akmIndex({ stashDir: storage.stashDir, full: true });
    expect(await searchScores()).toEqual(adjusted);

    // A schema reset: no stored scores at all. The feedback events rebuild them.
    const db = openExistingDatabase(getDbPath());
    try {
      db.exec("DELETE FROM utility_scores");
    } finally {
      closeDatabase(db);
    }
    expect(await searchScores()).toEqual(baseline);
    await akmIndex({ stashDir: storage.stashDir });
    expect(await searchScores()).toEqual(adjusted);
    expect(utilityRow("alpha-guide")).toMatchObject({ feedback_count: 1 });
    expect(utilityRow("alpha-guide")?.feedback_score).toBeCloseTo(0.45, 12);
  });

  test("the feedback history is the source: without the events a reindex clears the effect", async () => {
    const baseline = await indexWithHistory();
    await feedback("alpha-guide", "--negative");
    expect(names(await searchScores())).toEqual(["beta-guide", "alpha-guide", "gamma-guide"]);

    const state = openStateDatabase();
    try {
      state.exec("DELETE FROM usage_events WHERE event_type = 'feedback'");
    } finally {
      state.close();
    }
    await akmIndex({ stashDir: storage.stashDir });
    expect(await searchScores()).toEqual(baseline);
    expect(utilityRow("alpha-guide")).toMatchObject({ feedback_count: 0, feedback_score: null });
  });

  test("an index rebuilt from the events equals the one feedback wrote, signal by signal", async () => {
    await indexWithHistory();
    for (const signal of ["--negative", "--positive", "--positive", "--negative"] as const) {
      await feedback("alpha-guide", signal);
    }
    const written = utilityRow("alpha-guide");
    await akmIndex({ stashDir: storage.stashDir });
    const rebuilt = utilityRow("alpha-guide");
    expect(rebuilt?.feedback_count).toBe(4);
    expect(rebuilt?.feedback_score).toBeCloseTo(written?.feedback_score as number, 12);
  });
});

describe("an index.db created before the feedback columns", () => {
  function dropFeedbackColumns(): void {
    const db = openExistingDatabase(getDbPath());
    try {
      db.exec("ALTER TABLE utility_scores DROP COLUMN feedback_score");
      db.exec("ALTER TABLE utility_scores DROP COLUMN feedback_count");
    } finally {
      closeDatabase(db);
    }
  }

  function columns(): string[] {
    const db = openExistingDatabase(getDbPath());
    try {
      return (db.prepare("PRAGMA table_info(utility_scores)").all() as Array<{ name: string }>).map((c) => c.name);
    } finally {
      closeDatabase(db);
    }
  }

  test("is searched as it is, gets the columns on a writable open, and ranks by feedback after akm index", async () => {
    const baseline = await searchScores();
    await feedback("alpha-guide", "--negative");
    dropFeedbackColumns();
    expect(columns()).not.toContain("feedback_count");

    // A read serves the older table without the columns: no failure, every asset neutral.
    expect(await searchScores()).toEqual(baseline);
    expect(columns()).not.toContain("feedback_count");

    // The layout stamp is unchanged, and the writable opener adds the columns in place.
    const db = openIndexDatabase(getDbPath());
    try {
      expect(getMeta(db, "version")).toBe(String(CANONICAL_INDEX_DB_VERSION));
    } finally {
      closeDatabase(db);
    }
    expect(columns()).toEqual(expect.arrayContaining(["feedback_score", "feedback_count"]));

    // The row kept its place; the next index rebuilds the feedback score from the event.
    await akmIndex({ stashDir: storage.stashDir });
    const afterIndex = await searchScores();
    expect(names(afterIndex)).toEqual(["beta-guide", "alpha-guide", "gamma-guide"]);
    expect(utilityRow("alpha-guide")?.feedback_score).toBeCloseTo(0.45, 12);
  });

  test("akm feedback adds the columns itself, so its effect shows in the very next search", async () => {
    const baseline = await searchScores();
    dropFeedbackColumns();
    await feedback("alpha-guide", "--negative");
    expect(columns()).toEqual(expect.arrayContaining(["feedback_score", "feedback_count"]));
    const after = await searchScores();
    expect(scoreOf(after, "alpha-guide")).toBeLessThan(scoreOf(baseline, "alpha-guide"));
  });
});
