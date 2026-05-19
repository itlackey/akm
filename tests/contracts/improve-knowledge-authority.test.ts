import { describe, expect, test } from "bun:test";
import { CLI_DOC_PATH, extractSection, readDoc, SPEC_PATH } from "./spec-helpers";

describe("issue #315 docs contract — knowledge authority over memories", () => {
  test("v1 architecture spec carries the same knowledge-over-memory rule", () => {
    const spec = readDoc(SPEC_PATH);
    const commands = extractSection(spec, "### 12.4 Commands");

    expect(commands).not.toBe("");
    expect(commands).toMatch(/`knowledge`\s+is\s+the\s+more\s+authoritative\s+destination/i);
    expect(commands).toMatch(/ranks\s+`knowledge`\s+above\s+`memory`\s+hits/i);
    expect(commands).toMatch(/including\s+inferred\s+`\.derived`\s+memories/i);
  });

  test("cli docs describe knowledge as outranking memory and derived memory when evidence is comparable", () => {
    const cli = readDoc(CLI_DOC_PATH);
    const section = extractSection(cli, "## Improvement Flow (0.8.0+)");

    expect(section).not.toBe("");
    expect(section).toMatch(/higher-authority\s+destination/i);
    expect(section).toMatch(/prefers\s+`knowledge`\s+over\s+`memory`\s+hits/i);
    expect(section).toMatch(/including\s+inferred\s+`\.derived`\s+memories/i);
  });
});
