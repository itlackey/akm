import { describe, expect, test } from "bun:test";
import { CLI_DOC_PATH, extractSection, readDoc } from "./spec-helpers";

describe("issue #315 docs contract — knowledge authority over memories", () => {
  test("cli docs describe knowledge as outranking memory and derived memory when evidence is comparable", () => {
    const cli = readDoc(CLI_DOC_PATH);
    const section = extractSection(cli, "## Improvement Flow (0.8.0+)");

    expect(section).not.toBe("");
    expect(section).toMatch(/higher-authority\s+destination/i);
    expect(section).toMatch(/prefers\s+`knowledge`\s+over\s+`memory`\s+hits/i);
    expect(section).toMatch(/including\s+inferred\s+`\.derived`\s+memories/i);
  });
});
