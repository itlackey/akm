import { describe, expect, test } from "bun:test";
import { CONFIG_DOC_PATH, extractSection, readDoc, SPEC_PATH } from "./spec-helpers";

// Pins v1 spec §12 — Agent CLI integration (Planned for v1).

const BUILT_IN_PROFILES = ["opencode", "claude", "codex", "gemini", "aider"];

const SPAWN_FAILURE_REASONS = ["timeout", "spawn_failed", "non_zero_exit", "parse_error"];

describe("v1 spec §12 — agent CLI integration", () => {
  const spec = readDoc(SPEC_PATH);
  const section = extractSection(spec, "## 12. Agent CLI integration");

  test("§12 exists and is marked Planned for v1", () => {
    expect(section).not.toBe("");
    expect(section).toContain("Planned for v1");
  });

  test("§12.1 lists every built-in profile", () => {
    for (const p of BUILT_IN_PROFILES) {
      expect(section).toContain(`\`${p}\``);
    }
  });

  test("§12.1 declares the AgentProfile shape", () => {
    expect(section).toMatch(/interface AgentProfile/);
    expect(section).toMatch(/readonly bin: string/);
    expect(section).toMatch(/readonly args: readonly string\[\]/);
    expect(section).toMatch(/captured.*interactive/s);
  });

  test("§12.2 names every spawn-wrapper failure reason", () => {
    for (const r of SPAWN_FAILURE_REASONS) {
      expect(section).toContain(`"${r}"`);
    }
  });

  test("§12.4 declares reflect/propose write only to the proposal queue", () => {
    expect(section).toMatch(/write\s*\*\*only\*\*\s*to the proposal queue/i);
  });
});

describe("v1 spec §12 — configuration.md mirrors the agent block", () => {
  const config = readDoc(CONFIG_DOC_PATH);
  const block = extractSection(config, "## Planned for v1 — `agent.*` block");

  test("configuration.md has the agent block section", () => {
    expect(block).not.toBe("");
  });

  test("configuration.md declares the three top-level agent keys", () => {
    expect(block).toContain("`agent.default`");
    expect(block).toContain("`agent.timeoutMs`");
    expect(block).toContain("`agent.profiles[<name>]`");
  });

  test("configuration.md says missing `agent` block raises ConfigError with hint", () => {
    expect(block).toMatch(/ConfigError/);
    expect(block).toMatch(/hint/i);
  });
});
