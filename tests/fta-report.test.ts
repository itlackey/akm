import { describe, expect, test } from "bun:test";
import { scoreRises } from "../scripts/fta-report";

describe("scoreRises", () => {
  test("a rise fails and names the file with both scores", () => {
    const rises = scoreRises([{ file_name: "a.ts", fta_score: 50 }], [{ file_name: "a.ts", fta_score: 50.5 }]);
    expect(rises).toEqual([{ file: "src/a.ts", base: 50, now: 50.5 }]);
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
});
