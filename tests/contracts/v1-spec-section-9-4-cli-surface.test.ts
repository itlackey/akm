import { describe, expect, test } from "bun:test";
import { CLI_DOC_PATH, extractSection, readDoc } from "./spec-helpers";

// Pins the current documented improvement command surface.

const IMPROVEMENT_COMMANDS = ["agent", "improve", "propose", "proposal"] as const;

describe("current improvement CLI documentation contract", () => {
  const cli = readDoc(CLI_DOC_PATH);

  test("documents each active improvement command family", () => {
    const section = extractSection(cli, "## Improvement Flow (0.8.0+)");
    expect(section).not.toBe("");
    for (const cmd of IMPROVEMENT_COMMANDS) {
      expect(section).toContain(`### ${cmd}`);
    }
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
