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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isHotCapturedMemory,
  normalizeUpdatedField,
  sanitizeMergedContent,
  stripOuterCodeFence,
  validateProposalFrontmatter,
} from "../src/commands/consolidate";
import { detectTruncatedDescription } from "../src/core/text-truncation";

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

// ── normalizeUpdatedField — `updated: today` placeholder defuse ─────────────

describe("normalizeUpdatedField — drains placeholder leaks from `updated:`", () => {
  const todayIso = new Date().toISOString().slice(0, 10);

  it("rewrites a literal `today` string to today's ISO date", () => {
    const fm: Record<string, unknown> = { updated: "today" };
    normalizeUpdatedField(fm);
    expect(fm.updated).toBe(todayIso);
  });

  it("rewrites case-insensitive variants (TODAY, Now, etc.)", () => {
    for (const variant of ["TODAY", "Today", "now", "Now", "{today}", "${today}", "{{today}}", "  today  "]) {
      const fm: Record<string, unknown> = { updated: variant };
      normalizeUpdatedField(fm);
      expect(fm.updated).toBe(todayIso);
    }
  });

  it("rewrites a map-shaped leak `{today: null}` to today's ISO date", () => {
    // This is the literal shape observed on proposal 4136246b (2026-05-20):
    // `updated:\n  today: null` — the LLM treated `today` as a YAML key.
    const fm: Record<string, unknown> = { updated: { today: null } };
    normalizeUpdatedField(fm);
    expect(fm.updated).toBe(todayIso);
  });

  it("rewrites other map-shaped leaks", () => {
    const fm: Record<string, unknown> = { updated: { now: null, generated: false } };
    normalizeUpdatedField(fm);
    expect(fm.updated).toBe(todayIso);
  });

  it("leaves a real ISO date string alone", () => {
    const fm: Record<string, unknown> = { updated: "2026-05-19" };
    normalizeUpdatedField(fm);
    expect(fm.updated).toBe("2026-05-19");
  });

  it("leaves a real ISO datetime string alone", () => {
    const fm: Record<string, unknown> = { updated: "2026-05-19T10:30:00Z" };
    normalizeUpdatedField(fm);
    expect(fm.updated).toBe("2026-05-19T10:30:00Z");
  });

  it("converts a Date object to its yyyy-mm-dd ISO form", () => {
    const fm: Record<string, unknown> = { updated: new Date("2026-05-19T10:30:00Z") };
    normalizeUpdatedField(fm);
    expect(fm.updated).toBe("2026-05-19");
  });

  it("leaves `updated` untouched when the field is absent", () => {
    const fm: Record<string, unknown> = { description: "doc" };
    normalizeUpdatedField(fm);
    expect("updated" in fm).toBe(false);
  });

  it("leaves null/empty-string untouched (we don't invent metadata)", () => {
    const a: Record<string, unknown> = { updated: null };
    normalizeUpdatedField(a);
    expect(a.updated).toBeNull();
    const b: Record<string, unknown> = { updated: "" };
    normalizeUpdatedField(b);
    expect(b.updated).toBe("");
  });

  it("leaves unknown string formats untouched (visible in diff)", () => {
    const fm: Record<string, unknown> = { updated: "last week sometime" };
    normalizeUpdatedField(fm);
    expect(fm.updated).toBe("last week sometime");
  });
});

// ── sanitizeMergedContent integration with normalizeUpdatedField ────────────

describe("sanitizeMergedContent — wires normalizeUpdatedField into the pipeline", () => {
  const todayIso = new Date().toISOString().slice(0, 10);

  it("normalises a `today: null` map leak in the output frontmatter", () => {
    // Mirrors the exact pattern observed on proposal 4136246b (2026-05-20).
    const raw = "---\ndescription: print-md disciplined workflow\nupdated:\n  today: null\n---\n\nBody.";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.frontmatter.updated).toBe(todayIso);
    // The serialised content carries the normalised value too.
    expect(result.result.content).toContain(`updated: ${todayIso}`);
    expect(result.result.content).not.toContain("today: null");
  });

  it("normalises a literal `updated: today` string in the output frontmatter", () => {
    const raw = "---\ndescription: doc\nupdated: today\n---\nBody.";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.frontmatter.updated).toBe(todayIso);
  });

  it("preserves a real ISO date in `updated:` through the pipeline", () => {
    const raw = "---\ndescription: doc\nupdated: 2026-05-19\n---\nBody.";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.frontmatter.updated).toBe("2026-05-19");
    expect(result.result.content).toContain("updated: 2026-05-19");
  });
});

// ── isHotCapturedMemory — user-explicit memory guard ────────────────────────

describe("isHotCapturedMemory — protects user-captured memories from auto-delete/auto-merge", () => {
  // Background: 14 user memories with `captureMode: hot` were silent-deleted
  // by the consolidate LLM between 2026-05-19 and 2026-05-20. This guard
  // refuses any delete/merge whose participants include hot-captured memories.

  function writeMemory(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-hot-guard-test-"));
    const file = path.join(dir, "memory.md");
    fs.writeFileSync(file, content);
    return file;
  }

  it("returns true for a memory with captureMode: hot in frontmatter", () => {
    const file = writeMemory(`---
description: A user-captured memo
captureMode: hot
beliefState: asserted
tags: [important]
---

Body content.
`);
    expect(isHotCapturedMemory(file)).toBe(true);
  });

  it("returns false for a memory with captureMode: background (LLM-inferred)", () => {
    const file = writeMemory(`---
description: A derived memo
captureMode: background
inferred: true
---

Body content.
`);
    expect(isHotCapturedMemory(file)).toBe(false);
  });

  it("returns false for a memory with no captureMode field", () => {
    const file = writeMemory(`---
description: A pre-captureMode-era memo
tags: [legacy]
---

Body content.
`);
    expect(isHotCapturedMemory(file)).toBe(false);
  });

  it("returns false for a non-existent file (fail-safe)", () => {
    expect(isHotCapturedMemory("/tmp/does-not-exist-akm-hot-test.md")).toBe(false);
  });

  it("returns false for a malformed-frontmatter file (fail-safe)", () => {
    const file = writeMemory("not actually markdown frontmatter\nno --- delimiters\n");
    expect(isHotCapturedMemory(file)).toBe(false);
  });

  it("returns false for an empty file", () => {
    const file = writeMemory("");
    expect(isHotCapturedMemory(file)).toBe(false);
  });

  it("only the literal 'hot' string qualifies (case-sensitive)", () => {
    const file = writeMemory(`---
description: ambiguous case
captureMode: HOT
---

Body.
`);
    // The frontmatter field requires exactly "hot" — uppercase/mixed-case
    // do NOT trigger the guard. Documents the contract: the indexer only
    // accepts the literal "hot" enum value.
    expect(isHotCapturedMemory(file)).toBe(false);
  });
});
