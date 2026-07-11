import { describe, expect, test } from "bun:test";
import { CONFIG_DOC_PATH, extractSection, readDoc, SPEC_PATH } from "./spec-helpers";

// Pins v1 spec §12 — Agent CLI integration (Planned for v1).

const BUILT_IN_PROFILES = ["opencode", "claude", "codex", "gemini", "aider"];

const SPAWN_FAILURE_REASONS = ["timeout", "spawn_failed", "non_zero_exit", "parse_error"];

describe("v1 spec §12 — agent CLI integration", () => {
  const spec = readDoc(SPEC_PATH);
  const section = extractSection(spec, "## 12. Agent CLI integration");

  test("§12 exists and is marked shipped", () => {
    expect(section).not.toBe("");
    expect(section).toContain("(shipped)");
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

  test("§12.4 declares improve write only to the proposal queue", () => {
    expect(section).toMatch(/writes\s*\*\*only\*\*\s*to the proposal queue/i);
  });

  test("§12 stops before §13 (helper boundary check)", () => {
    // Defensive: extractSection() returns to EOF if no sibling stop
    // heading exists. Pin the section terminus so a missing §13 heading
    // (or a renamed one) trips this test instead of silently spilling
    // §13+§14 content into the §12 assertions above.
    expect(section).not.toContain("## 13.");
    expect(section).not.toContain("## 14.");
  });
});

describe("v1 spec §12 — configuration.md mirrors agent engines", () => {
  const config = readDoc(CONFIG_DOC_PATH);
  const block = extractSection(config, "## Engines");

  test("configuration.md has the engine section", () => {
    expect(block).not.toBe("");
    expect(block).toContain("`engines`");
  });

  test("configuration.md declares LLM and agent engine kinds", () => {
    expect(block).toContain("`llm`");
    expect(block).toContain("`agent`");
    expect(block).toContain("opencode-sdk");
  });

  test("configuration.md documents the platform field for agent engines", () => {
    expect(block).toMatch(/platform/i);
    expect(block).toMatch(/agent engine/i);
  });
});
