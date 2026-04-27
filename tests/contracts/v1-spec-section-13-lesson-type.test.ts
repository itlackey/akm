import { describe, expect, test } from "bun:test";
import { extractSection, readDoc, SPEC_PATH } from "./spec-helpers";

// Pins v1 spec §13 — Lesson asset type (Planned for v1).

describe("v1 spec §13 — lesson asset type", () => {
  const spec = readDoc(SPEC_PATH);
  const section = extractSection(spec, "## 13. Lesson asset type");

  test("§13 exists and is marked Planned for v1", () => {
    expect(section).not.toBe("");
    expect(section).toContain("Planned for v1");
  });

  test("§13.1 declares `description` and `when_to_use` are required", () => {
    expect(section).toMatch(/description:\s*required/);
    expect(section).toMatch(/when_to_use:\s*required/);
  });

  test("§13.2 stores lessons under `lessons/`", () => {
    expect(section).toContain("`lessons/<name>.md`");
  });

  test("§13.3 routes distill output through the proposal queue", () => {
    expect(section).toMatch(/akm distill/);
    expect(section).toMatch(/akm proposal accept/);
  });
});
