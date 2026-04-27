import { describe, expect, test } from "bun:test";
import { CLI_DOC_PATH, extractSection, readDoc, SPEC_PATH } from "./spec-helpers";

// Pins v1 spec §9.4 — CLI command surface.
//
// The locked surface is exhaustive. The shipped pre-release set and the
// planned-for-v1 additions together form the v1.0 freeze. Renaming or
// removing any command after v1.0 is a major version bump.

const SHIPPED_COMMANDS = [
  "add",
  "remove",
  "list",
  "update",
  "search",
  "show",
  "clone",
  "index",
  "setup",
  "remember",
  "import",
  "feedback",
  "info",
  "curate",
  "workflow",
  "vault",
  "wiki",
  "completions",
  "upgrade",
  "save",
  "help",
  "hints",
] as const;

const PLANNED_FOR_V1 = ["agent", "reflect", "propose", "proposal", "distill"] as const;

describe("v1 spec §9.4 — CLI command surface", () => {
  const spec = readDoc(SPEC_PATH);
  const section = extractSection(spec, "### 9.4 CLI command surface");

  test("§9.4 exists in the spec", () => {
    expect(section).not.toBe("");
  });

  test("§9.4 lists every shipped pre-release command", () => {
    // The shipped set is rendered as a pipe-joined inline-code block; tokens
    // appear as standalone words. We assert each command word appears in
    // the section text without caring about its surrounding backticks.
    for (const cmd of SHIPPED_COMMANDS) {
      const re = new RegExp(`\\b${cmd}\\b`);
      expect(re.test(section)).toBe(true);
    }
    expect(section).toMatch(/\bregistry\b/);
  });

  test("§9.4 declares each planned-for-v1 command", () => {
    for (const cmd of PLANNED_FOR_V1) {
      // accept either `cmd` or `cmd <args>` patterns
      const re = new RegExp(`\`${cmd}\\b`);
      expect(re.test(section)).toBe(true);
    }
  });

  test("§9.4 explicitly says renaming or removing is major", () => {
    expect(section).toMatch(/major version bump/i);
  });
});

describe("v1 spec §9.4 — cli.md mirrors the surface", () => {
  const cli = readDoc(CLI_DOC_PATH);

  test("cli.md has a Planned-for-v1 section listing the new commands", () => {
    const planned = extractSection(cli, "## Planned for v1 — agent, proposal, lesson, and distill");
    expect(planned).not.toBe("");
    for (const cmd of PLANNED_FOR_V1) {
      expect(planned).toContain(`### ${cmd}`);
    }
  });

  test("cli.md uses the documented status legend", () => {
    expect(cli).toMatch(/Pre-release \(shipping\)/);
    expect(cli).toMatch(/Planned for v1/);
  });
});
