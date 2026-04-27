/**
 * Lint contract for the `lesson` asset type (v1 spec §13).
 *
 * `description` and `when_to_use` are required, non-empty single-line
 * strings. The lint module produces structured findings; the strict
 * variant (`assertLessonValid`) throws a `UsageError` whose message
 * includes the offending file path and which fields failed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ASSET_SPECS, TYPE_DIRS } from "../src/core/asset-spec";
import { UsageError } from "../src/core/errors";
import { assertLessonValid, lintLessonContent, lintLessonFile } from "../src/core/lesson-lint";

describe("lesson asset type registration (v1 spec §13)", () => {
  test("`lesson` is a built-in asset type with stashDir `lessons`", () => {
    expect(ASSET_SPECS.lesson).toBeDefined();
    expect(TYPE_DIRS.lesson).toBe("lessons");
  });

  test("`lesson` registers a renderer and an action builder", () => {
    expect(ASSET_SPECS.lesson.rendererName).toBe("lesson-md");
    expect(typeof ASSET_SPECS.lesson.actionBuilder).toBe("function");
  });

  test("`lesson` accepts `.md` files only", () => {
    expect(ASSET_SPECS.lesson.isRelevantFile("foo.md")).toBe(true);
    expect(ASSET_SPECS.lesson.isRelevantFile("foo.txt")).toBe(false);
  });
});

describe("lintLessonContent (deterministic, no fs)", () => {
  test("passes when both required fields are present and non-empty", () => {
    const raw = [
      "---",
      "description: Always check the cache before fetching",
      "when_to_use: When the upstream service is rate-limited",
      "---",
      "",
      "Body.",
    ].join("\n");
    const report = lintLessonContent(raw, "/virtual/lesson.md");
    expect(report.findings).toEqual([]);
  });

  test("flags missing description with the offending file path", () => {
    const raw = ["---", "when_to_use: when X", "---", "Body."].join("\n");
    const report = lintLessonContent(raw, "/virtual/no-desc.md");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe("missing-description");
    expect(report.findings[0].field).toBe("description");
    expect(report.findings[0].message).toContain("/virtual/no-desc.md");
    expect(report.findings[0].message).toContain("description");
  });

  test("flags missing when_to_use with the offending file path", () => {
    const raw = ["---", "description: Lesson", "---", "Body."].join("\n");
    const report = lintLessonContent(raw, "/virtual/no-when.md");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe("missing-when_to_use");
    expect(report.findings[0].field).toBe("when_to_use");
    expect(report.findings[0].message).toContain("/virtual/no-when.md");
  });

  test("flags empty (whitespace-only) description and when_to_use", () => {
    const raw = ["---", 'description: "   "', 'when_to_use: ""', "---", ""].join("\n");
    const report = lintLessonContent(raw, "/virtual/empty.md");
    const kinds = report.findings.map((f) => f.kind).sort();
    expect(kinds).toEqual(["empty-description", "empty-when_to_use"]);
  });

  test("flags both fields when both are missing", () => {
    const raw = ["---", "tags: [a]", "---", "Body."].join("\n");
    const report = lintLessonContent(raw, "/virtual/empty.md");
    expect(report.findings).toHaveLength(2);
    const kinds = new Set(report.findings.map((f) => f.kind));
    expect(kinds.has("missing-description")).toBe(true);
    expect(kinds.has("missing-when_to_use")).toBe(true);
  });
});

describe("assertLessonValid + lintLessonFile (filesystem)", () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-lesson-lint-"));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("lintLessonFile reads the file and reports findings", () => {
    const file = path.join(tmpDir, "incomplete.md");
    fs.writeFileSync(file, ["---", "description: hi", "---", "Body."].join("\n"));
    const report = lintLessonFile(file);
    expect(report.path).toBe(file);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe("missing-when_to_use");
  });

  test("assertLessonValid throws UsageError including the offending path", () => {
    const file = path.join(tmpDir, "bad.md");
    fs.writeFileSync(file, ["---", "tags: [x]", "---", "Body."].join("\n"));
    expect(() => assertLessonValid(file)).toThrow(UsageError);
    try {
      assertLessonValid(file);
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const u = err as UsageError;
      expect(u.message).toContain(file);
      expect(u.code).toBe("MISSING_REQUIRED_ARGUMENT");
      expect(u.hint()).toMatch(/§13/);
    }
  });

  test("assertLessonValid returns silently when the lesson is valid", () => {
    const file = path.join(tmpDir, "good.md");
    fs.writeFileSync(
      file,
      ["---", "description: Use the cache", "when_to_use: Rate-limited upstream", "---", "Body."].join("\n"),
    );
    expect(() => assertLessonValid(file)).not.toThrow();
  });
});
