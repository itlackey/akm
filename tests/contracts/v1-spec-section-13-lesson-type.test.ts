import { describe, expect, test } from "bun:test";
import { ASSET_SPECS, TYPE_DIRS } from "../../src/core/asset/asset-spec";
import { lintLessonContent } from "../../src/core/lesson-lint";

describe("current lesson asset contract", () => {
  test("`lesson` is registered as a well-known asset type at runtime", () => {
    expect(ASSET_SPECS.lesson).toBeDefined();
    expect(TYPE_DIRS.lesson).toBe("lessons");
  });

  test("lesson lint requires description and when_to_use frontmatter", () => {
    expect(lintLessonContent("# Body\n", "lesson:test").findings.map((finding) => finding.kind)).toEqual([
      "missing-description",
      "missing-when_to_use",
    ]);
    expect(
      lintLessonContent(
        "---\ndescription: Prefer bounded retries\nwhen_to_use: When a remote call can fail transiently\n---\n\nUse backoff.\n",
        "lesson:test",
      ).findings,
    ).toEqual([]);
  });
});
