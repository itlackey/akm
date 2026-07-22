import { describe, expect, test } from "bun:test";
import { CLI_DOC_PATH, extractSection, readDoc } from "./contract-helpers";

// Pins the current documented improvement command surface.

const IMPROVEMENT_COMMANDS = ["agent", "improve", "propose", "proposal"] as const;

describe("current improvement CLI documentation contract", () => {
  const cli = readDoc(CLI_DOC_PATH);

  test("documents each active improvement command family", () => {
    const section = extractSection(cli, "## Improvement Flow");
    expect(section).not.toBe("");
    for (const cmd of IMPROVEMENT_COMMANDS) {
      expect(section).toContain(`### ${cmd}`);
    }
  });

  test("treats the CLI reference as current authority with no archived-spec framing", () => {
    expect(cli).toMatch(/This page is authoritative for\s*(?:>\s*)?the current CLI/);
    expect(cli).not.toContain("docs/archive/");
    expect(cli).not.toContain("§9.4");
  });

  test("agent and propose select named engines while improve selects a strategy", () => {
    expect(extractSection(cli, "### agent")).toContain("--engine <name>");
    expect(extractSection(cli, "### propose")).toContain("`--engine`");
    expect(extractSection(cli, "### improve")).toContain("`--strategy <name>`");
    expect(extractSection(cli, "### agent")).not.toContain("profiles.agent");
  });

  test("proposal documents the complete current lifecycle grammar", () => {
    const section = extractSection(cli, "### proposal");
    for (const verb of ["list", "show", "diff", "accept", "reject", "revert"]) {
      expect(section).toContain(`proposal ${verb}`);
    }
  });
});
