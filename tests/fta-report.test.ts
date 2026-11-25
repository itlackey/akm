import { describe, expect, test } from "bun:test";
import { overCap, RISE_FLOOR, SCORE_CAP, scoreRises } from "../scripts/fta-report";

describe("scoreRises", () => {
  test("a rise fails and names the file with both scores", () => {
    const rises = scoreRises([{ file_name: "a.ts", fta_score: 80 }], [{ file_name: "a.ts", fta_score: 80.5 }]);
    expect(rises).toEqual([{ file: "src/a.ts", base: 80, now: 80.5 }]);
  });

  test("equal and lower scores pass", () => {
    const base = [
      { file_name: "a.ts", fta_score: 50 },
      { file_name: "b.ts", fta_score: 60 },
    ];
    const now = [
      { file_name: "a.ts", fta_score: 50 },
      { file_name: "b.ts", fta_score: 40 },
    ];
    expect(scoreRises(base, now)).toEqual([]);
  });

  test("a file that is new since the base is not compared", () => {
    expect(scoreRises([], [{ file_name: "new.ts", fta_score: 500 }])).toEqual([]);
  });

  test("a rise that stays at or under the floor passes, and one that crosses it fails", () => {
    expect(scoreRises([{ file_name: "a.ts", fta_score: 50 }], [{ file_name: "a.ts", fta_score: RISE_FLOOR }])).toEqual(
      [],
    );
    expect(scoreRises([{ file_name: "a.ts", fta_score: 70 }], [{ file_name: "a.ts", fta_score: 76 }])).toEqual([
      { file: "src/a.ts", base: 70, now: 76 },
    ]);
  });
});

describe("overCap", () => {
  test("a file over the cap fails, new or not, and one at the cap passes", () => {
    const base = [{ file_name: "b.ts", fta_score: SCORE_CAP + 5 }];
    const now = [
      { file_name: "a.ts", fta_score: SCORE_CAP },
      { file_name: "b.ts", fta_score: SCORE_CAP + 1 },
      { file_name: "c.ts", fta_score: SCORE_CAP + 2 },
    ];
    expect(overCap(base, now)).toEqual([
      { file: "src/b.ts", base: SCORE_CAP + 5, now: SCORE_CAP + 1 },
      { file: "src/c.ts", base: undefined, now: SCORE_CAP + 2 },
    ]);
  });
});
