import { describe, expect, test } from "bun:test";
import { CLI_DOC_PATH, extractSection, readDoc } from "./contract-helpers";

describe("issue #315 docs contract — knowledge authority over memories", () => {
  test("cli docs describe knowledge as the higher-authority promotion destination", () => {
    const cli = readDoc(CLI_DOC_PATH);
    const section = extractSection(cli, "## Improvement Flow");

    expect(section).not.toBe("");
    expect(section).toMatch(/higher-authority\s+destination/i);
    // Search ranking is type-blind (reciprocal rank fusion of BM25 and vectors).
    expect(section).not.toMatch(/prefers\s+`knowledge`\s+over\s+`memory`\s+hits/i);
  });
});
