import { describe, expect, test } from "bun:test";
import { CONFIG_DOC_PATH, extractSection, readDoc, SPEC_PATH } from "./spec-helpers";

// Pins v1 spec §14 — `llm.features.*` (Planned for v1).
//
// The five locked feature keys cannot be renamed after v1.0. New keys may
// be added; these five must not move.

const LOCKED_FEATURE_KEYS = [
  "curate_rerank",
  "tag_dedup",
  "memory_consolidation",
  "feedback_distillation",
  "embedding_fallback_score",
  "memory_inference",
  "graph_extraction",
];

describe("v1 spec §14 — llm.features.*", () => {
  const spec = readDoc(SPEC_PATH);
  const section = extractSection(spec, "## 14. `llm.features.*`");

  test("§14 exists and is marked Planned for v1", () => {
    expect(section).not.toBe("");
    expect(section).toContain("Planned for v1");
  });

  test("§14.1 declares every locked feature key", () => {
    for (const k of LOCKED_FEATURE_KEYS) {
      expect(section).toContain(`\`${k}\``);
    }
  });

  test("§14.1 declares all defaults are false", () => {
    expect(section).toMatch(/defaults are\s*`false`|all defaults are\s*`false`|defaults\s*`false`/i);
  });

  test("§14.2 defines mandatory failure-mode rules", () => {
    expect(section).toMatch(/check the feature flag before/i);
    expect(section).toMatch(/hard timeout/i);
    expect(section).toMatch(/never\s*\*\*\s*mutate state on failure/i);
  });

  test("§14.4 codifies the statelessness invariant", () => {
    expect(section).toMatch(/holds no state across calls/i);
    expect(section).toMatch(/no streaming sessions/i);
  });

  test("§14.5 routes distill output through the proposal queue", () => {
    const flat = section.replace(/\s+/g, " ");
    expect(flat).toMatch(/`lesson` \*\*proposal\*\*/i);
    expect(section).toContain("distill_invoked");
  });

  test("§14 documents orthogonality between llm.features.* and index.<pass>.llm", () => {
    expect(section).toMatch(/orthogonal/i);
    expect(section).toMatch(/llm\.features\.<key>/);
    expect(section).toMatch(/index\.<pass>\.llm/);
  });

  test("§14 stops before §15 (helper boundary check)", () => {
    // Defensive: extractSection() returns to EOF if no sibling stop
    // heading exists. Pin the section terminus so a missing §15 heading
    // (or a renamed one) trips this test instead of silently spilling
    // §15+ content into the §14 assertions above.
    expect(section).not.toContain("## 15.");
    expect(section).not.toContain("## Appendix");
  });
});

describe("v1 spec §14 — configuration.md mirrors the feature gates", () => {
  const config = readDoc(CONFIG_DOC_PATH);
  const block = extractSection(config, "## Planned for v1 — `llm.features.*` map");

  test("configuration.md has the llm.features section", () => {
    expect(block).not.toBe("");
  });

  test("configuration.md lists every locked feature key", () => {
    for (const k of LOCKED_FEATURE_KEYS) {
      expect(block).toContain(k);
    }
  });

  test("configuration.md says unknown llm.features keys are warn-and-ignore", () => {
    expect(block).toMatch(/Unknown keys.*warn-and-ignore/i);
  });
});
