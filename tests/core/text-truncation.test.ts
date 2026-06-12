/**
 * Tests for src/core/text-truncation.ts — the shared truncation-detection
 * helper used by `distill` and `consolidate`. The vocabulary is the union of
 * the two prior command-local sets; behaviour must be at least as strict as
 * either prior implementation.
 */
import { describe, expect, it } from "bun:test";
import { isValidDescription } from "../../src/commands/proposal/validators/proposal-quality-validators";
import {
  detectTruncatedDescription,
  repairTruncatedDescription,
  TRUNCATION_TRAILING_WORDS,
} from "../../src/core/text-truncation";

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

describe("repairTruncatedDescription — post-generation repair pass (#556)", () => {
  const REF = "lesson:some-topic";

  // ── Zero behaviour change for already-valid descriptions ──────────────────
  describe("already-valid descriptions pass through byte-identical", () => {
    const valid = [
      "A complete description ending with a period.",
      "Tightening CSS resets prevents layout shift on narrow viewports.",
      "Run the migration before deploying to avoid schema drift in production.",
      "Ends with a question mark and is clearly complete?",
      "Use prepared statements to defend against SQL injection in user input.",
    ];
    for (const v of valid) {
      it(`returns identical string for: "${v.slice(0, 40)}…"`, () => {
        const out = repairTruncatedDescription(v, "Some body sentence here. Another body sentence.");
        // Byte-identical (===), not merely equivalent.
        expect(out).toBe(v);
        // And it was valid to begin with (sanity).
        expect(isValidDescription(v, REF).ok).toBe(true);
      });
    }
  });

  // ── Truncated inputs get repaired to something isValidDescription accepts ──
  describe("truncated inputs are repaired to a valid description", () => {
    const cases: { name: string; desc: string; body?: string }[] = [
      {
        name: "ends with preposition 'to'",
        desc: "Always run the database migration before deploying the service to",
      },
      {
        name: "ends with preposition 'for'",
        desc: "Configure connection pooling to reduce latency under load for",
      },
      {
        name: "ends with conjunction 'and'",
        desc: "Validate all user input at the API boundary to prevent injection and",
      },
      {
        name: "ends with article 'the'",
        desc: "Cache expensive query results to cut p99 latency across the",
      },
      {
        name: "trailing comma",
        desc: "Before deleting any legacy CSS rule, verify the shared stylesheet is unused,",
      },
      {
        name: "trailing semicolon",
        desc: "Prefer idempotent retries when calling the payment gateway endpoint;",
      },
      {
        name: "trailing ellipsis",
        desc: "Memoize the selector to avoid recomputing on every render…",
      },
      {
        name: "stacked hanging tail 'related to the'",
        desc: "Document the rollback procedure for every schema change related to the",
      },
      {
        name: "complete first sentence, truncated second — keep first",
        desc: "Use a connection pool to bound concurrent database connections. This also helps with",
      },
      {
        name: "YAML-continuation-loss fragment (whole desc is a dangling fragment) — recover from body",
        // The continuation line of a folded YAML scalar was lost, leaving only
        // the lead-in which dangles on a connector. Body supplies the real sentence.
        desc: "This lesson explains how to",
        body: "Pin the runtime version in CI to keep builds reproducible across machines.\n\nFurther notes follow.",
      },
    ];

    for (const c of cases) {
      it(`repairs: ${c.name}`, () => {
        // Pre-condition: the raw input really is detected as truncated.
        expect(detectTruncatedDescription(c.desc)).not.toBeNull();
        const repaired = repairTruncatedDescription(c.desc, c.body);
        // Post-condition: the repaired output passes the real validator.
        const check = isValidDescription(repaired, REF);
        expect(check.ok).toBe(true);
        // And it is no longer detected as truncated.
        expect(detectTruncatedDescription(repaired)).toBeNull();
        // Repair must not fabricate: every alphabetic word in the result must
        // have appeared in the original description or the supplied body.
        const haystack = `${c.desc} ${c.body ?? ""}`.toLowerCase();
        for (const word of repaired.toLowerCase().match(/[a-z']+/g) ?? []) {
          expect(haystack.includes(word)).toBe(true);
        }
      });
    }
  });

  // ── Fallback: no clean completion available → return original unchanged ───
  it("falls back to the original string when no safe completion exists", () => {
    // Truncated, no body, and stripping the tail leaves too little to be valid.
    const desc = "relates to";
    const out = repairTruncatedDescription(desc);
    expect(out).toBe(desc); // unchanged → downstream validation rejects as before
    expect(isValidDescription(out, REF).ok).toBe(false);
  });

  it("does not invent content when body has no usable sentence", () => {
    const desc = "Explains how to";
    const body = "x\n\n## heading only\n\n- a\n- b";
    const out = repairTruncatedDescription(desc, body);
    expect(out).toBe(desc); // no clean body sentence → unchanged
  });

  it("handles non-string input defensively", () => {
    expect(repairTruncatedDescription(undefined as unknown as string)).toBeUndefined();
  });
});
