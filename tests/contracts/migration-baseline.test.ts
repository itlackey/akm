import { describe, expect, test } from "bun:test";
import { extractSection, MIGRATION_PATH, readDoc } from "./contract-helpers";

describe("0.8 to 0.9 engine migration contract", () => {
  const doc = readDoc(MIGRATION_PATH);

  test("documents the strict profile-to-engine and profile-to-strategy cutover", () => {
    const section = extractSection(doc, "## Engine And Task Assets");
    expect(section).toContain("`profiles.llm.<name>`");
    expect(section).toContain("`engines.<name>`");
    expect(section).toContain("`defaults.llmEngine`");
    expect(section).toContain("`defaults.engine`");
    expect(section).toContain("`improve.strategies.<name>`");
  });

  test("documents task v2 engine fields and rejects automatic ambiguous translation", () => {
    const section = extractSection(doc, "## Engine And Task Assets");
    expect(section).toContain("version: 2");
    expect(section).toContain("engine: reviewer");
    expect(section).toMatch(/cannot safely infer/i);
    expect(doc).toMatch(/does not translate profile-based configuration/i);
  });
});
