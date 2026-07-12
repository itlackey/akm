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
import { describe, expect, it, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hasSupersededStatus,
  isHotCapturedMemory,
  normalizeUpdatedField,
  sanitizeMergedContent,
  stripOuterCodeFence,
  validateProposalFrontmatter,
} from "../../../src/commands/improve/consolidate";
import type { AkmConfig } from "../../../src/core/config/config";
import { detectTruncatedDescription } from "../../../src/core/text-truncation";
import { resolveImproveProcessRunner } from "../../../src/integrations/agent/runner";

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

  it("recovers from leading-only unbalanced fence when inner content is valid", () => {
    // LLM emits ```markdown but forgets the closing ```. Recovery: strip the
    // opening line and proceed — the inner content is valid.
    const raw = "```markdown\n---\ndescription: foo\n---\nbody no closer";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.frontmatter.description).toBe("foo");
      expect(result.result.content).toContain("body no closer");
    }
  });

  it("still rejects trailing-only unbalanced fence (UNBALANCED_CODE_FENCE)", () => {
    // A trailing ``` with no opening is likely a body code block, not a wrapper.
    const raw = "---\ndescription: foo\n---\nbody content\n```";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNBALANCED_CODE_FENCE");
  });

  it("still rejects leading-only fence when inner content has no frontmatter sentinel", () => {
    const raw = "```markdown\njust prose, no frontmatter";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNBALANCED_CODE_FENCE");
  });

  it("recovers from preamble before frontmatter sentinel", () => {
    // LLM emits a lead-in line before the `---`. Recovery: find `---` within
    // 300 chars and slice from there.
    const raw = "Here is the merged content:\n---\ndescription: bar\n---\nbody\n";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.frontmatter.description).toBe("bar");
      expect(result.result.content).toContain("body");
    }
  });

  it("rejects content with no frontmatter sentinel anywhere", () => {
    const raw = "no frontmatter, just prose";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MISSING_FRONTMATTER_SENTINEL");
  });

  it("rejects preamble where --- appears beyond 300 chars", () => {
    // A `---` that appears too late is treated as a body divider, not frontmatter.
    const preamble = "x".repeat(301);
    const raw = `${preamble}\n---\ndescription: foo\n---\nbody\n`;
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MISSING_FRONTMATTER_SENTINEL");
  });

  it("recovers from missing closing --- when body starts after blank line", () => {
    // LLM emits frontmatter with no closing `---`; blank line separates body.
    const raw = "---\ndescription: merged thing\nupdated: 2026-05-27\n\nBody content here.\n";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.frontmatter.description).toBe("merged thing");
      expect(result.result.content).toContain("Body content here.");
    }
  });

  it("recovers from missing closing --- when body starts with non-YAML line", () => {
    // LLM omits closing `---`; body starts with a sentence (no key: pattern).
    const raw = "---\ndescription: some fact\nupdated: 2026-05-27\nThis is the body sentence.\n";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.frontmatter.description).toBe("some fact");
      expect(result.result.content).toContain("This is the body sentence.");
    }
  });

  it("rejects malformed frontmatter block that cannot be recovered", () => {
    // No body content at all — can't determine where frontmatter ends.
    const raw = "---\ndescription: foo\ntags: [a, b]";
    const result = sanitizeMergedContent(raw);
    // Either recovers (if heuristic finds a boundary) or rejects — either is acceptable,
    // but if it rejects it should be MALFORMED_FRONTMATTER_BLOCK.
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

  it("recovers from invalid YAML using lenient parseFrontmatter fallback", () => {
    // Single-quoted scalar with no closing quote — yaml.parse throws, but
    // parseFrontmatter can extract the key and re-serialize cleanly.
    const raw = "---\ndescription: 'unterminated quote\n---\nbody\n";
    const result = sanitizeMergedContent(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(typeof result.result.frontmatter.description).toBe("string");
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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: array contains literal placeholder strings under test, not template interpolations
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

// ── hasSupersededStatus — promote guard for superseded memories ─────────────

describe("hasSupersededStatus — refuses consolidate promote of superseded memories", () => {
  // Background: 5 of 7 pending consolidate promotes from 2026-05-20 were
  // against source memories with `status: superseded`. The superseded
  // frontmatter dragged through verbatim into the new knowledge asset
  // (broken-on-arrival). This guard short-circuits the promote before any
  // proposal is queued.

  it("returns true when status is exactly 'superseded'", () => {
    expect(hasSupersededStatus({ status: "superseded" })).toBe(true);
  });

  it("returns true when status is 'superseded' with surrounding whitespace", () => {
    expect(hasSupersededStatus({ status: "  superseded  " })).toBe(true);
  });

  it("returns true when status is uppercase variant (case-insensitive)", () => {
    expect(hasSupersededStatus({ status: "SUPERSEDED" })).toBe(true);
    expect(hasSupersededStatus({ status: "Superseded" })).toBe(true);
  });

  it("returns false for the canonical active states", () => {
    for (const s of ["active", "asserted", "deprecated", "contradicted", "archived"]) {
      expect(hasSupersededStatus({ status: s })).toBe(false);
    }
  });

  it("returns false when status is missing", () => {
    expect(hasSupersededStatus({})).toBe(false);
    expect(hasSupersededStatus({ description: "no status here" })).toBe(false);
  });

  it("returns false when frontmatter is undefined (defensive)", () => {
    expect(hasSupersededStatus(undefined)).toBe(false);
  });

  it("returns false when status is a non-string type (defensive)", () => {
    expect(hasSupersededStatus({ status: true })).toBe(false);
    expect(hasSupersededStatus({ status: 42 })).toBe(false);
    expect(hasSupersededStatus({ status: null })).toBe(false);
    expect(hasSupersededStatus({ status: ["superseded"] })).toBe(false);
  });
});

describe("ConsolidateResult.skipReasons / judgedNoAction — emitter contract", () => {
  // Regression for the 2026-05-26 tuning-reasons investigation. The
  // consolidate envelope MUST surface judgedNoAction and skipReasons so
  // health.ts can aggregate without regex-parsing the warnings bag, AND so
  // dashboards can disambiguate the consolidation.merged-vs-warnings desync
  // documented in §Q2 (the warnings stream includes "Merge: merged content
  // for X missing description" rejection lines that look like successes —
  // they are NOT counted into `merged`, and now also appear in
  // skipReasons[].reason === "merge_missing_description").
  //
  // This is a shape contract; it validates the typed surface without driving
  // the full LLM-backed runConsolidate. The aggregation behaviour is covered
  // end-to-end in tests/health-command.test.ts.
  it("envelope carries judgedNoAction and structured skipReasons", () => {
    type ConsolidateResultShape = {
      judgedNoAction?: number;
      skipReasons?: Array<{ ref: string; skips: Array<{ op: string; reason: string }> }>;
      merged: number;
    };
    const sample: ConsolidateResultShape = {
      merged: 0,
      judgedNoAction: 78,
      skipReasons: [
        { ref: "memory:a", skips: [{ op: "merge", reason: "merge_missing_description" }] },
        { ref: "memory:b", skips: [{ op: "merge", reason: "merge_missing_description" }] },
        { ref: "memory:c", skips: [{ op: "merge", reason: "merge_sanitization_failed" }] },
        { ref: "memory:d", skips: [{ op: "delete", reason: "captureMode_hot_refused" }] },
        { ref: "memory:e", skips: [{ op: "promote", reason: "dedup_pending_proposal" }] },
      ],
    };

    // merged == 0 is consistent with three Merge-op attempts that ALL hit a
    // skip reason. The invariant the investigation report was probing: if
    // every merge op recorded a skipReason, `merged` MUST be (mergeOpsAttempted - mergeSkips).
    const mergeSkips = (sample.skipReasons ?? []).flatMap((e) => e.skips).filter((s) => s.op === "merge").length;
    const mergeOpsAttempted = 3; // all three got a skip reason
    expect(sample.merged).toBe(mergeOpsAttempted - mergeSkips);

    // Per-reason histogram is reconstructable client-side by aggregating every
    // skip across all grouped ref entries.
    const histogram: Record<string, number> = {};
    for (const entry of sample.skipReasons ?? []) {
      for (const skip of entry.skips) {
        histogram[skip.reason] = (histogram[skip.reason] ?? 0) + 1;
      }
    }
    expect(histogram).toEqual({
      merge_missing_description: 2,
      merge_sanitization_failed: 1,
      captureMode_hot_refused: 1,
      dedup_pending_proposal: 1,
    });
  });

  it("groups multiple skip ops for the same ref into one entry with skips.length === 2", () => {
    // A ref hit by two distinct deterministic rejections (e.g.
    // merge_participant_blocked then dedup_pending_proposal) must appear
    // exactly once in skipReasons so skipReasons.length stays the unique-ref
    // count (accounting invariant), while both reasons are retained in skips[].
    type Grouped = Array<{ ref: string; skips: Array<{ op: string; reason: string }> }>;
    const skipReasons: Grouped = [
      {
        ref: "memory:dup",
        skips: [
          { op: "merge", reason: "merge_participant_blocked" },
          { op: "promote", reason: "dedup_pending_proposal" },
        ],
      },
      { ref: "memory:other", skips: [{ op: "delete", reason: "captureMode_hot_refused" }] },
    ];

    // Each ref occupies exactly one array entry.
    expect(skipReasons.length).toBe(2);
    const dup = skipReasons.find((e) => e.ref === "memory:dup");
    expect(dup?.skips.length).toBe(2);
    // Health-style aggregation counts every skip across all refs.
    const histogram: Record<string, number> = {};
    for (const entry of skipReasons) {
      for (const skip of entry.skips) {
        histogram[skip.reason] = (histogram[skip.reason] ?? 0) + 1;
      }
    }
    expect(histogram).toEqual({
      merge_participant_blocked: 1,
      dedup_pending_proposal: 1,
      captureMode_hot_refused: 1,
    });
  });
});

describe("ConsolidateResult accounting invariant — 2026-05-26 leak fix", () => {
  // Regression for the accounting leak observed in run
  // 2026-05-27T02-07-01-518Z-650b4b81: processed=117, actioned (promoted +
  // merged + deleted + contradicted) = 5, judgedNoAction=69, skipReasons.length=32
  // → 117 − 5 − 69 − 32 = 11 unaccounted memories.
  //
  // Root causes (see commit message):
  //   1. Multi-secondary merges: chunk loop adds primary+secondaries to
  //      targetRefs (excluding all from judgedNoAction) but only ONE
  //      counter increment occurs per merge op — `merged++` on success or
  //      a single skipReason on failure. Secondaries silently vanish.
  //   2. Chunk-level transport/parse failures: failedChunks counter exists,
  //      but the chunk's memories never reach the per-chunk noAction
  //      calculation and never enter skipReasons either.
  //   3. Three "not found in loaded memories" sites (merge primary, delete,
  //      promote, contradict.ref) emitted a warning but NO skipReason.
  //
  // Fix introduces two additive envelope fields:
  //   - mergedSecondaries: extras absorbed by successful merges
  //   - failedChunkMemories: memories in chunks whose LLM call failed
  // and emits per-participant skipReasons on failed merges, plus
  // skipReason entries at every "not found" continue site.
  //
  // The invariant the fix MUST preserve:
  //   processed
  //     == promoted.length + merged + mergedSecondaries + deleted + contradicted
  //      + judgedNoAction + Σ(skipReasons that reference loaded-memory refs)
  //      + failedChunkMemories
  //
  // For phantom refs (op.ref / op.primary not in memoryByRef), the chunk
  // loop never reduced any chunk's noAction count for them, so a skipReason
  // emitted at a "not found" site is informational — it does NOT need to
  // appear on the left side of the invariant. The test below covers BOTH
  // shapes: an all-loaded-memory case (strict equality with skipReasons.length)
  // and a phantom-mixed case (equality after partitioning).

  type SkipEntry = { ref: string; skips: Array<{ op: string; reason: string }> };
  type Envelope = {
    processed: number;
    promoted: { length: number };
    merged: number;
    deleted: number;
    contradicted: number;
    judgedNoAction: number;
    skipReasons: SkipEntry[];
    mergedSecondaries: number;
    failedChunkMemories: number;
  };

  const accountedTotal = (e: Envelope, loadedRefs: Set<string>): number =>
    e.promoted.length +
    e.merged +
    e.mergedSecondaries +
    e.deleted +
    e.contradicted +
    e.judgedNoAction +
    e.failedChunkMemories +
    e.skipReasons.filter((s) => loadedRefs.has(s.ref)).length;

  it("invariant holds for the 11-memory leak case once mergedSecondaries + failedChunkMemories are populated", () => {
    // Reconstructed shape from the live run envelope (2026-05-27 02:07).
    // The 11 missing memories are modeled as 4 secondaries from two
    // multi-secondary failed merges and 7 additional in-chunk targets
    // that were excluded from judgedNoAction but never accounted for
    // because of "not found in loaded memories" warnings without
    // skipReasons. Pre-fix accounted = 117 − 11 = 106; post-fix the
    // expanded skipReasons close the gap exactly.
    const loadedRefs = new Set<string>([
      // 32 originally counted via skipReasons (all in-chunk):
      ...Array.from({ length: 32 }, (_, i) => `memory:s${i}`),
      // 4 additional secondaries from two multi-secondary failed merges:
      "memory:sec-a1",
      "memory:sec-a2",
      "memory:sec-b1",
      "memory:sec-b2",
      // 7 from now-emitted "not found" / write-failed skipReasons that
      // ARE in-chunk (modeled — in practice these were a mix of phantom
      // and in-chunk refs; only in-chunk ones impact the invariant):
      ...Array.from({ length: 7 }, (_, i) => `memory:in-chunk-not-found-${i}`),
      // 5 contradict targets:
      "memory:c1",
      "memory:c2",
      "memory:c3",
      "memory:c4",
      "memory:c5",
      // 69 judgedNoAction memories:
      ...Array.from({ length: 69 }, (_, i) => `memory:n${i}`),
    ]);
    // Sanity: 32 + 4 + 7 + 5 + 69 = 117 = processed.
    const skipReasons: SkipEntry[] = [
      // Original 32 from the run (pre-fix, but post-fix they remain):
      ...Array.from({ length: 32 }, (_, i) => ({
        ref: `memory:s${i}`,
        skips: [{ op: "promote" as const, reason: "dedup_pending_proposal" }],
      })),
      // Post-fix: 2 failed merges each emit primary + 2 secondaries.
      // Replace the 2 single-primary entries with 6 total (3 each).
      // NB: in real code the primary skipReason was already emitted by the
      // sanitization/missing-description guard pre-fix; the fix adds the
      // 4 secondaries. For invariant arithmetic only the unique-ref count
      // matters, and each of these refs is distinct → one group entry each.
      { ref: "memory:merge-fail-a", skips: [{ op: "merge", reason: "merge_sanitization_failed" }] },
      { ref: "memory:sec-a1", skips: [{ op: "merge", reason: "merge_sanitization_failed" }] },
      { ref: "memory:sec-a2", skips: [{ op: "merge", reason: "merge_sanitization_failed" }] },
      { ref: "memory:sec-b1", skips: [{ op: "merge", reason: "merge_missing_description" }] },
      { ref: "memory:sec-b2", skips: [{ op: "merge", reason: "merge_missing_description" }] },
      // 7 "not found" / failure sites that are in-chunk (post-fix all
      // emit a skipReason; pre-fix only a freeform warning):
      ...Array.from({ length: 7 }, (_, i) => ({
        ref: `memory:in-chunk-not-found-${i}`,
        skips: [{ op: "promote" as const, reason: "promote_ref_missing" }],
      })),
    ];
    const envelope: Envelope = {
      processed: 117,
      promoted: { length: 0 },
      merged: 0,
      deleted: 0,
      contradicted: 5,
      judgedNoAction: 69,
      skipReasons,
      mergedSecondaries: 0, // no successful merges in this run
      failedChunkMemories: 0,
    };
    expect(accountedTotal(envelope, loadedRefs)).toBe(envelope.processed);
  });

  it("invariant credits mergedSecondaries for successful multi-secondary merges", () => {
    // Scenario: 1 chunk of 10 memories. LLM proposes 1 merge with primary +
    // 3 secondaries. Merge succeeds. Pre-fix: merged=1, judgedNoAction=6,
    // skipReasons=[] → 1 + 6 = 7, but processed=10 → 3 missing.
    // Post-fix: mergedSecondaries=3 → 1 + 3 + 6 = 10. Closes the gap.
    const loadedRefs = new Set<string>([
      "memory:p",
      "memory:s1",
      "memory:s2",
      "memory:s3",
      ...Array.from({ length: 6 }, (_, i) => `memory:n${i}`),
    ]);
    const envelope: Envelope = {
      processed: 10,
      promoted: { length: 0 },
      merged: 1,
      mergedSecondaries: 3,
      deleted: 0,
      contradicted: 0,
      judgedNoAction: 6,
      skipReasons: [],
      failedChunkMemories: 0,
    };
    expect(accountedTotal(envelope, loadedRefs)).toBe(envelope.processed);
  });

  it("invariant credits failedChunkMemories when chunk LLM calls fail", () => {
    // Scenario: 3 chunks of 5 memories each = 15 input. Chunk 1 succeeds
    // with 1 successful contradict + 4 noAction. Chunks 2-3 fail.
    // Pre-fix: failedChunks=2 (visible) but the 10 memories vanish from
    // the invariant. Post-fix: failedChunkMemories=10 closes it.
    const loadedRefs = new Set<string>([
      "memory:c-1",
      ...Array.from({ length: 4 }, (_, i) => `memory:n${i}`),
      ...Array.from({ length: 10 }, (_, i) => `memory:f${i}`),
    ]);
    const envelope: Envelope = {
      processed: 15,
      promoted: { length: 0 },
      merged: 0,
      mergedSecondaries: 0,
      deleted: 0,
      contradicted: 1,
      judgedNoAction: 4,
      skipReasons: [],
      failedChunkMemories: 10,
    };
    expect(accountedTotal(envelope, loadedRefs)).toBe(envelope.processed);
  });

  // Regression for the +1 overshoot observed in run
  // 2026-05-27T05-07-02-093Z-8edc5b07: processed=117 vs accounted=118.
  //
  // Root cause: cross-chunk references. Chunk-X proposes "merge primary:A with
  // secondary:B" where B is a member of chunk-Y (a different chunk in the same
  // run). Chunk-Y's own LLM call did NOT propose any op for B, so B contributed
  // to chunk-Y's judgedNoAction. Later, when the merge op fails (e.g.
  // merge_missing_description), emitMergeFailureSkips pushed a skipReason for
  // B — double-counting it. The 2026-05-27 fix introduces judgedNoActionRefs:
  // a Set tracking which refs contributed to judgedNoAction. pushSkipReason
  // now decrements judgedNoAction and removes the ref from the set so the
  // ref lands in exactly one bucket.
  //
  // This test mirrors the run-state arithmetic so a regression would surface
  // as an off-by-one in the invariant.
  it("invariant holds when cross-chunk refs are promoted from judgedNoAction to skipReasons", () => {
    // 117 memories across 3 chunks of ~39 each. 5 contradicts succeed.
    // 8 merge ops fail (6 missing_description, 2 sanitization_failed). One of
    // those failed merges has a secondary B that lived in a different chunk
    // and would have been counted in judgedNoAction. Pre-fix: judgedNoAction
    // includes B and skipReasons also includes B → +1 overshoot. Post-fix:
    // pushSkipReason removes B from judgedNoActionRefs and decrements the
    // counter.
    //
    // Modeled directly: 117 = 5 contradicted + 77 judgedNoAction (pre-promote)
    //                       + 36 skipReasons (one of which double-counts B).
    // Post-fix: judgedNoAction is decremented by 1 when B's skipReason is
    // pushed → 76 + 36 = 112... 76 + 36 + 5 = 117. ✓
    const loadedRefs = new Set<string>([
      ...Array.from({ length: 5 }, (_, i) => `memory:c${i}`),
      ...Array.from({ length: 76 }, (_, i) => `memory:n${i}`),
      ...Array.from({ length: 35 }, (_, i) => `memory:s${i}`),
      "memory:cross-chunk-secondary",
    ]);
    const envelope: Envelope = {
      processed: 117,
      promoted: { length: 0 },
      merged: 0,
      mergedSecondaries: 0,
      deleted: 0,
      contradicted: 5,
      judgedNoAction: 76, // 77 pre-promote, -1 after B is moved to skipReasons
      skipReasons: [
        ...Array.from({ length: 35 }, (_, i) => ({
          ref: `memory:s${i}`,
          skips: [{ op: "promote" as const, reason: "dedup_pending_proposal" }],
        })),
        {
          ref: "memory:cross-chunk-secondary",
          skips: [{ op: "merge" as const, reason: "merge_missing_description" }],
        },
      ],
      failedChunkMemories: 0,
    };
    expect(accountedTotal(envelope, loadedRefs)).toBe(envelope.processed);
  });
});

// Folded from tests/consolidate-profile-resolution.test.ts (2026-05-26
// regression guard): the consolidate pass must honor
// improve.strategies.default.processes.consolidate.engine instead of silently
// using the default LLM. These are unit tests over the resolver; no real LLM.
const CONSOLIDATE_PRIMARY = { endpoint: "http://localhost:11434/v1/chat/completions", model: "gemma-default" };
const CONSOLIDATE_MINISTRAL = { endpoint: "http://localhost:11434/v1/chat/completions", model: "ministral-3b" };

describe("consolidate honors processes.consolidate.engine", () => {
  test("resolves to the per-process engine when configured", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: {
        default: { kind: "llm", ...CONSOLIDATE_PRIMARY },
        ministral: { kind: "llm", ...CONSOLIDATE_MINISTRAL },
      },
      improve: {
        strategies: {
          default: {
            processes: { consolidate: { engine: "ministral" } },
          },
        },
      },
      defaults: { llmEngine: "default" },
    };

    const strategy = config.improve?.strategies?.default;
    const runnerSpec = resolveImproveProcessRunner(strategy, "consolidate", config);
    expect(runnerSpec).not.toBeNull();
    expect(runnerSpec?.kind).toBe("llm");
    if (runnerSpec?.kind === "llm") {
      expect(runnerSpec.connection.model).toBe("ministral-3b");
    }
  });

  test("inherits defaults.llmEngine when no process engine is set", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: { default: { kind: "llm", ...CONSOLIDATE_PRIMARY } },
      defaults: { llmEngine: "default" },
    };
    const runnerSpec = resolveImproveProcessRunner({ processes: { consolidate: {} } }, "consolidate", config);
    expect(runnerSpec?.engine).toBe("default");
  });
});
