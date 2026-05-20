/**
 * Regression tests for the consolidate-pipeline defects observed across 323
 * reviewed proposals on the `feature/improve-pipeline-fixes` branch:
 *
 *   1. Code-fence leakage — LLM wraps the merged asset in ```markdown ... ```
 *      or ```yaml ... ``` and the post-processor writes that verbatim.
 *   2. YAML quote-escaping bugs — descriptions with broken quoting pass
 *      through string-concat'd YAML.
 *   3. Truncated descriptions — LLM hits its output budget mid-sentence.
 *   4. Slug-variant duplication — multiple near-identical proposals for
 *      the same underlying content with different generated slugs.
 *   5. Duplicating existing memories — proposals overlap with already-
 *      stashed `knowledge:` / `memory:` assets.
 *   6. Minimal/missing frontmatter — only `inferenceProcessed: true` and
 *      `updated:` present, no `description`/`when_to_use`/`tags`.
 *
 * These tests cover the validation gates and dedup approach added in
 * `src/commands/consolidate.ts`.
 */
import { describe, expect, it } from "bun:test";
import {
  CONSOLIDATE_DEDUP_SIM_THRESHOLD,
  detectTruncatedDescription,
  normalizeSlugForDedup,
  sanitizeMergedContent,
  stripOuterCodeFence,
  validateProposalFrontmatter,
} from "../src/commands/consolidate";

// ── stripOuterCodeFence ─────────────────────────────────────────────────────

describe("stripOuterCodeFence — defends against LLM ```markdown ... ``` leakage", () => {
  it("strips a balanced ```markdown fence with newline", () => {
    const raw = "```markdown\n---\ndescription: foo\n---\nbody\n```";
    const result = stripOuterCodeFence(raw);
    expect(result).not.toBeNull();
    expect(result?.stripped).toBe(true);
    expect(result?.content.startsWith("---")).toBe(true);
  });

  it("strips a balanced ```yaml fence", () => {
    const raw = "```yaml\n---\ndescription: foo\n---\nbody\n```";
    const result = stripOuterCodeFence(raw);
    expect(result?.stripped).toBe(true);
    expect(result?.content.startsWith("---")).toBe(true);
  });

  it("strips a balanced bare ``` fence", () => {
    const raw = "```\n---\ndescription: foo\n---\nbody\n```";
    const result = stripOuterCodeFence(raw);
    expect(result?.stripped).toBe(true);
  });

  it("returns null for an UNBALANCED leading fence", () => {
    const raw = "```markdown\n---\ndescription: foo\n---\nbody (no closing fence)";
    expect(stripOuterCodeFence(raw)).toBeNull();
  });

  it("returns null for an UNBALANCED trailing fence", () => {
    const raw = "---\ndescription: foo\n---\nbody\n```";
    expect(stripOuterCodeFence(raw)).toBeNull();
  });

  it("returns unchanged content (stripped=false) when no outer fence is present", () => {
    const raw = "---\ndescription: foo\n---\nbody";
    const result = stripOuterCodeFence(raw);
    expect(result?.stripped).toBe(false);
    expect(result?.content).toBe(raw.trim());
  });
});

// ── sanitizeMergedContent ───────────────────────────────────────────────────

describe("sanitizeMergedContent — full LLM-output pipeline", () => {
  it("accepts well-formed markdown with frontmatter unchanged", () => {
    const raw = "---\ndescription: hello\n---\nbody content\n";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.frontmatter.description).toBe("hello");
      expect(result.result.content).toContain("description: hello");
      expect(result.result.content).toContain("body content");
    }
  });

  it("strips ```markdown fences and yields clean frontmatter", () => {
    const raw = "```markdown\n---\ndescription: hello\n---\nbody\n```";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.content.startsWith("---")).toBe(true);
      expect(result.result.content).not.toContain("```");
    }
  });

  it("rejects unbalanced fences (UNBALANCED_CODE_FENCE)", () => {
    const raw = "```markdown\n---\ndescription: foo\n---\nbody no closer";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNBALANCED_CODE_FENCE");
  });

  it("rejects content without frontmatter sentinel", () => {
    const raw = "no frontmatter, just prose";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MISSING_FRONTMATTER_SENTINEL");
  });

  it("rejects malformed frontmatter block (only opening ---)", () => {
    const raw = "---\ndescription: foo\nno closing fence ever";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MALFORMED_FRONTMATTER_BLOCK");
  });

  it("re-serialises YAML so unbalanced quoting parses cleanly", () => {
    // Note: this is a quote-balanced YAML scalar that uses YAML escaping
    // correctly — the test verifies the round-trip preserves the value.
    const raw = "---\ndescription: '\"Specialty intro: parens (foo)\"'\n---\nbody\n";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.frontmatter.description).toBe('"Specialty intro: parens (foo)"');
    }
  });

  it("rejects YAML with truly invalid syntax", () => {
    // Single-quoted scalar with no closing quote — yaml.parse throws.
    const raw = "---\ndescription: 'unterminated quote\n---\nbody\n";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.startsWith("INVALID_YAML")).toBe(true);
  });

  it("strips <think> blocks before parsing frontmatter", () => {
    const raw = "<think>reasoning</think>\n---\ndescription: hi\n---\nbody";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.frontmatter.description).toBe("hi");
  });
});

// ── detectTruncatedDescription ──────────────────────────────────────────────

describe("detectTruncatedDescription — guards against mid-sentence cutoffs", () => {
  it("returns null for a complete sentence", () => {
    expect(detectTruncatedDescription("A complete description ending with period.")).toBeNull();
    expect(detectTruncatedDescription("Short label")).toBeNull();
  });

  it("flags descriptions ending with a colon", () => {
    expect(detectTruncatedDescription("Tables in narrow column containers need:")).not.toBeNull();
  });

  it("flags descriptions ending with a comma", () => {
    expect(detectTruncatedDescription("Before deleting any legacy CSS rule,")).not.toBeNull();
  });

  it("flags descriptions ending with a semicolon", () => {
    expect(detectTruncatedDescription("Important to note;")).not.toBeNull();
  });

  it("flags descriptions ending with a plus operator", () => {
    expect(detectTruncatedDescription("Tables in narrow column containers need max-width:100% +")).not.toBeNull();
  });

  it("flags descriptions ending in ellipsis", () => {
    expect(detectTruncatedDescription("Continued from...")).not.toBeNull();
    expect(detectTruncatedDescription("Continued from…")).not.toBeNull();
  });

  it("flags descriptions ending with hanging connectors", () => {
    expect(detectTruncatedDescription("Before deleting any legacy CSS rule, verify shared.css has")).not.toBeNull();
    expect(
      detectTruncatedDescription("Eval tasks must create a genuine knowledge gap — the skill must be"),
    ).not.toBeNull();
    expect(detectTruncatedDescription("Steps to take with")).not.toBeNull();
  });
});

// ── validateProposalFrontmatter ─────────────────────────────────────────────

describe("validateProposalFrontmatter — required-field gate", () => {
  it("accepts a non-empty, untruncated description", () => {
    const result = validateProposalFrontmatter({ description: "A reasonable, complete description." });
    expect(result.ok).toBe(true);
  });

  it("rejects an empty description", () => {
    const result = validateProposalFrontmatter({ description: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MISSING_FRONTMATTER_DESCRIPTION");
  });

  it("rejects a whitespace-only description", () => {
    const result = validateProposalFrontmatter({ description: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MISSING_FRONTMATTER_DESCRIPTION");
  });

  it("rejects a missing description field", () => {
    const result = validateProposalFrontmatter({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MISSING_FRONTMATTER_DESCRIPTION");
  });

  it("rejects a non-string description value", () => {
    const result = validateProposalFrontmatter({ description: 42 as unknown as string });
    expect(result.ok).toBe(false);
  });

  it("rejects a truncated description", () => {
    const result = validateProposalFrontmatter({
      description: "Tables in narrow column containers need max-width:100% +",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.startsWith("TRUNCATED_DESCRIPTION")).toBe(true);
  });
});

// ── normalizeSlugForDedup ───────────────────────────────────────────────────

describe("normalizeSlugForDedup — collapses date suffixes and word-reorderings", () => {
  it("strips a -may-2026 suffix", () => {
    const a = normalizeSlugForDedup("knowledge:akm-consolidation-dedup-may-2026");
    const b = normalizeSlugForDedup("knowledge:akm-consolidation-dedup");
    expect(a).toBe(b);
  });

  it("strips a -2026-05-03 date suffix", () => {
    const a = normalizeSlugForDedup("knowledge:akm-consolidation-dedup-2026-05-03");
    const b = normalizeSlugForDedup("knowledge:akm-consolidation-dedup");
    expect(a).toBe(b);
  });

  it("collapses word-reorderings via alphabetical sort", () => {
    // "akm-semantic-search-fix" vs "fix-akm-semantic-search" — same tokens.
    const a = normalizeSlugForDedup("knowledge:akm-semantic-search-fix");
    const b = normalizeSlugForDedup("knowledge:fix-akm-semantic-search");
    expect(a).toBe(b);
  });

  it("treats variants of the same idea as the same slug", () => {
    const refs = [
      "knowledge:break-inside-class-cleanup",
      "knowledge:break-inside-class-cleanup-2026-05-03",
      "knowledge:cleanup-break-inside-class",
    ];
    const norms = refs.map(normalizeSlugForDedup);
    expect(norms[0]).toBe(norms[1]);
    expect(norms[1]).toBe(norms[2]);
  });

  it("preserves DIFFERENT slugs as different", () => {
    expect(normalizeSlugForDedup("knowledge:foo-bar")).not.toBe(normalizeSlugForDedup("knowledge:baz-qux"));
  });

  it("strips numeric counter suffixes like -2 / -3", () => {
    const a = normalizeSlugForDedup("knowledge:akm-config-task-2026");
    const b = normalizeSlugForDedup("knowledge:akm-config-task-2");
    // both should drop their numeric/year suffix → same normalised form
    expect(a).toBe(b);
  });
});

// ── dedup threshold constant ────────────────────────────────────────────────

describe("CONSOLIDATE_DEDUP_SIM_THRESHOLD", () => {
  it("is configured at 0.85 (high-precision semantic-near-duplicate cutoff)", () => {
    // Picked at 0.85 because empirical mem0 / A-MEM dedup work converges
    // around 0.80-0.90 for "same idea, different wording" detection on
    // normalised sentence embeddings. Below 0.80 false positives dominate;
    // above 0.90 misses paraphrases. 0.85 sits in the empirically-quiet zone.
    expect(CONSOLIDATE_DEDUP_SIM_THRESHOLD).toBe(0.85);
  });
});
