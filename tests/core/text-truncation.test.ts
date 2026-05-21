/**
 * Tests for src/core/text-truncation.ts — the shared truncation-detection
 * helper used by `distill` and `consolidate`. The vocabulary is the union of
 * the two prior command-local sets; behaviour must be at least as strict as
 * either prior implementation.
 */
import { describe, expect, it } from "bun:test";
import { detectTruncatedDescription, TRUNCATION_TRAILING_WORDS } from "../../src/core/text-truncation";

describe("detectTruncatedDescription — shared truncation heuristic", () => {
  it("returns null for complete sentences", () => {
    expect(detectTruncatedDescription("A complete description ending with a period.")).toBeNull();
    expect(detectTruncatedDescription("Short label")).toBeNull();
    expect(detectTruncatedDescription("Ends with a question mark?")).toBeNull();
  });

  it("flags trailing `+` operator (e.g. max-width:100% +)", () => {
    const reason = detectTruncatedDescription("Tables in narrow column containers need max-width:100% +");
    expect(reason).not.toBeNull();
    expect(reason).toContain("trailing punctuation/operator");
  });

  it("flags trailing comma / semicolon / colon", () => {
    expect(detectTruncatedDescription("Before deleting any legacy CSS rule,")).not.toBeNull();
    expect(detectTruncatedDescription("Important to note;")).not.toBeNull();
    expect(detectTruncatedDescription("Tables in narrow column containers need:")).not.toBeNull();
  });

  it("flags ellipsis endings (... and …)", () => {
    expect(detectTruncatedDescription("Continued from...")).not.toBeNull();
    expect(detectTruncatedDescription("Continued from…")).not.toBeNull();
  });

  it("flags common hanging connectors regardless of case", () => {
    expect(detectTruncatedDescription("Steps to take with")).not.toBeNull();
    expect(detectTruncatedDescription("Before deleting any legacy CSS rule, verify shared.css has")).not.toBeNull();
    // case-insensitive lookup
    expect(detectTruncatedDescription("Closes with The")).not.toBeNull();
  });

  it("includes both distill-only and consolidate-only legacy words in the union", () => {
    // Words that were only in distill's prior set:
    for (const w of ["into", "onto", "upon", "via", "per", "than", "do", "does", "did"]) {
      expect(TRUNCATION_TRAILING_WORDS.has(w)).toBe(true);
    }
    // Words that were only in consolidate's prior regex:
    expect(TRUNCATION_TRAILING_WORDS.has("so")).toBe(true);
  });

  it("returns null for empty / whitespace-only input (handled elsewhere)", () => {
    expect(detectTruncatedDescription("")).toBeNull();
    expect(detectTruncatedDescription("   ")).toBeNull();
  });
});
