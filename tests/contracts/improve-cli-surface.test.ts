import { describe, expect, test } from "bun:test";
import { CLI_DOC_PATH, extractSection, IMPROVE_AUTOSYNC_PATH, readDoc } from "./contract-helpers";

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

  test("treats the CLI reference as current authority and the v1 plan as archived", () => {
    expect(cli).toMatch(/This page is authoritative for\s*(?:>\s*)?the current CLI/);
    expect(cli).toContain("docs/archive/v1-architecture-spec.md");
    expect(cli).toMatch(/is not a live CLI contract/);
    expect(cli).not.toContain("§9.4");
  });

  test("documents auto-sync under the current improve strategy config path", () => {
    const autosync = readDoc(IMPROVE_AUTOSYNC_PATH);
    expect(autosync).toContain("improve.strategies.<name>.sync.enabled");
    expect(autosync).not.toContain("profiles.improve.<name>.sync.enabled");
    expect(autosync).not.toContain("resolveImproveProfile");
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
