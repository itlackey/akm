import { describe, expect, test } from "bun:test";
import { improveCommand } from "../../src/commands/improve/improve-cli";
import { CLI_DOC_PATH, extractSection, readDoc } from "./contract-helpers";

// Pins the current documented improvement command surface.

const IMPROVEMENT_COMMANDS = ["agent", "improve", "proposal"] as const;

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

  test("agent and proposal new select named engines while improve selects a strategy", () => {
    expect(extractSection(cli, "### agent")).toContain("--engine <name>");
    expect(extractSection(cli, "#### proposal new")).toContain("`--engine`");
    expect(extractSection(cli, "### improve")).toContain("`--strategy <name>`");
    expect(extractSection(cli, "### agent")).not.toContain("profiles.agent");
  });

  test("improve documents --require-engines and the skippedProcesses result field (#957)", () => {
    const section = extractSection(cli, "### improve");
    expect(section).toContain("--require-engines");
    expect(section).toContain("skippedProcesses");
  });

  test("improve registers --plan as a zero-logic --dry-run alias and documents plan.processes (#947)", () => {
    const args = improveCommand.args as Record<string, { type?: string; default?: unknown }>;
    expect(args.plan).toMatchObject({ type: "boolean", default: false });

    const section = extractSection(cli, "### improve");
    expect(section).toContain("--plan");
    expect(section).toContain("plan.processes");
  });

  test("improve registers --show-prompt and documents it as a lock/index/engine-free prompt preview (#952)", () => {
    const args = improveCommand.args as Record<string, { type?: string; default?: unknown }>;
    expect(args["show-prompt"]).toMatchObject({ type: "boolean", default: false });

    const section = extractSection(cli, "### improve");
    expect(section).toContain("--show-prompt");
  });

  test("improve registers --run/--since and documents the report scope + usageReport field (#944)", () => {
    const args = improveCommand.args as Record<string, { type?: string }>;
    expect(args.run).toMatchObject({ type: "string" });
    expect(args.since).toMatchObject({ type: "string" });

    const section = extractSection(cli, "### improve");
    expect(section).toContain("improve report");
    expect(section).toContain("--run <id>");
    expect(section).toContain("--since <window>");
    expect(section).toContain("usageReport");
    expect(section).toContain("byProcessEngineModel");
    expect(section).toContain("noCalls");
  });

  test("proposal documents the complete current lifecycle grammar", () => {
    const section = extractSection(cli, "### proposal");
    for (const verb of ["extract", "new", "list", "show", "diff", "accept", "reject", "revert"]) {
      expect(section).toContain(`proposal ${verb}`);
    }
  });
});
