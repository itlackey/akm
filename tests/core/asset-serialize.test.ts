/**
 * Tests for src/core/asset-serialize.ts — the single source of truth for
 * frontmatter YAML serialization and full-asset string assembly.
 *
 * Before this helper existed, 11 sites across the codebase independently
 * reimplemented `yamlStringify(fm).trimEnd() + "---\n…\n---\n\n${body}"`,
 * with each site drifting in body normalization, separator newlines, and
 * trailing-newline policy. This file pins the canonical contract and
 * documents — via "before/after" regression assertions for each of the 11
 * sites — that the dedup is byte-safe for the realistic inputs each site
 * sees in production (i.e. assets read off disk in the standard
 * `---\nfm\n---\n\nbody` shape).
 */
import { describe, expect, it } from "bun:test";
import { stringify as yamlStringify } from "yaml";
import { assembleAsset, assembleAssetFromString, serializeFrontmatter } from "../../src/core/asset/asset-serialize";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";

describe("serializeFrontmatter — canonical YAML for the frontmatter block", () => {
  it("returns yaml.stringify output with the trailing newline trimmed", () => {
    const fm = { description: "hello", tags: ["a", "b"] };
    expect(serializeFrontmatter(fm)).toBe(yamlStringify(fm).trimEnd());
  });

  it("is deterministic — two calls with the same input produce identical bytes", () => {
    const fm = { description: "x", tags: ["a"], captureMode: "hot" };
    expect(serializeFrontmatter(fm)).toBe(serializeFrontmatter(fm));
  });

  it("preserves the input object's insertion order (no reordering)", () => {
    const a = serializeFrontmatter({ description: "x", tags: ["a"], updated: "2026-05-21" });
    const b = serializeFrontmatter({ updated: "2026-05-21", description: "x", tags: ["a"] });
    expect(a).not.toBe(b);
    // First key of `a` is `description:`; first key of `b` is `updated:`.
    expect(a.startsWith("description:")).toBe(true);
    expect(b.startsWith("updated:")).toBe(true);
  });

  it("emits no trailing whitespace or newline", () => {
    const out = serializeFrontmatter({ description: "x", tags: ["a"] });
    expect(out.endsWith("\n")).toBe(false);
    expect(out.endsWith(" ")).toBe(false);
  });
});

describe("assembleAsset — canonical asset file shape", () => {
  it("wraps frontmatter in `---` fences with a blank line before the body", () => {
    const out = assembleAsset({ description: "x" }, "body content");
    expect(out).toBe("---\ndescription: x\n---\n\nbody content\n");
  });

  it("strips leading newlines from the body (collapses drift)", () => {
    const a = assembleAsset({ description: "x" }, "\nbody");
    const b = assembleAsset({ description: "x" }, "\n\n\nbody");
    const c = assembleAsset({ description: "x" }, "body");
    expect(a).toBe(c);
    expect(b).toBe(c);
  });

  it("adds a single trailing newline if the body does not already end with one", () => {
    const withTrailing = assembleAsset({ description: "x" }, "body\n");
    const withoutTrailing = assembleAsset({ description: "x" }, "body");
    expect(withTrailing).toBe(withoutTrailing);
    expect(withTrailing.endsWith("\n")).toBe(true);
    expect(withTrailing.endsWith("\n\n")).toBe(false);
  });

  it("is idempotent under parseFrontmatter round-trip for realistic inputs", () => {
    const fm = { description: "round-trip test", tags: ["a", "b"], captureMode: "hot" };
    const body = "Some markdown body.\n\nMultiple paragraphs.\n";
    const assembled = assembleAsset(fm, body);
    const parsed = parseFrontmatter(assembled);
    const reassembled = assembleAsset(parsed.data, parsed.content);
    expect(reassembled).toBe(assembled);
  });

  it("preserves field-order policy through the helper layer", () => {
    const fm = { description: "x", tags: ["a"], updated: "2026-05-21", subjective: true };
    const out = assembleAsset(fm, "body");
    const keysInOrder = out
      .split("\n")
      .filter((l) => /^[a-zA-Z_]\w*:/.test(l))
      .map((l) => l.split(":")[0]);
    expect(keysInOrder).toEqual(["description", "tags", "updated", "subjective"]);
  });
});

/**
 * Per-call-site regression: for each of the 11 sites that previously
 * inlined the assembly pattern, take a representative input shaped like
 * what the site actually sees in production (i.e. assets read off disk
 * via `parseFrontmatter`, which always yield body content prefixed with
 * `\n` for the standard `---\nfm\n---\n\nbody` file shape), and confirm
 * `assembleAsset` produces the same bytes as the inline code did.
 *
 * The "standard input" cases here mirror real-world inputs — files that
 * already follow the canonical shape. The drift sites (those that wrote
 * `---\nfm\n---\n${body}` with a single newline and no body
 * normalization) emit byte-identical output on standard inputs; the
 * dedup is therefore safe.
 */
describe("regression — 11 inline call sites → assembleAsset", () => {
  // Representative frontmatter shape covering common keys.
  const realisticFm = {
    description: "regression fixture",
    tags: ["regression", "asset-serialize"],
    captureMode: "hot",
  };

  // Simulates `parseFrontmatter(raw).content` for a standard
  // `---\nfm\n---\n\nbody` file on disk: body starts with `\n`.
  const parsedBodyContent = "\nThis is the body.\n\nWith multiple paragraphs.\n";

  it("site 1 — src/commands/remember.ts:107 (frontmatter-only, no body)", () => {
    // buildMemoryFrontmatter returns just the fenced frontmatter block;
    // it predates assembleAsset and uses serializeFrontmatter directly.
    const inline = `---\n${yamlStringify(realisticFm).trimEnd()}\n---`;
    const refactored = `---\n${serializeFrontmatter(realisticFm)}\n---`;
    expect(refactored).toBe(inline);
  });

  it("site 2 — src/commands/distill-promotion-policy.ts:248 (canonical pattern)", () => {
    // Inline: `---\n${fm}\n---\n\n${body}\n` with body already trimmed.
    const body = "Trimmed knowledge body.";
    const inline = `---\n${yamlStringify(realisticFm).trimEnd()}\n---\n\n${body}\n`;
    const refactored = assembleAsset(realisticFm, body);
    expect(refactored).toBe(inline);
  });

  it("site 3 — src/core/memory-improve.ts:323 (drift: single-newline separator)", () => {
    // Inline: `---\n${fmStr}\n---\n${resolvedBody}` where resolvedBody = `\nbody`.
    const inline = `---\n${yamlStringify(realisticFm).trimEnd()}\n---\n${parsedBodyContent}`;
    const refactored = assembleAsset(realisticFm, parsedBodyContent);
    // Standard-shape inputs land at identical bytes.
    expect(refactored).toBe(inline);
  });

  it("site 4 — src/core/memory-improve.ts:612 (audit-archive write, canonical)", () => {
    const auditFm = {
      schemaVersion: 1,
      kind: "memory-cleanup-archive",
      archivedAt: "2026-05-21T00:00:00Z",
      beliefState: "archived",
      ref: "memory/foo",
      reason: "test",
    };
    const auditBody = "Archived derived memory for recoverable cleanup.\n";
    const inline = `---\n${yamlStringify(auditFm).trimEnd()}\n---\n\n${auditBody}`;
    const refactored = assembleAsset(auditFm, auditBody);
    expect(refactored).toBe(inline);
  });

  it("site 5 — src/core/memory-improve.ts:666 (canonical: body stripped of leading \\n)", () => {
    // Inline: body = parsed.content.replace(/^\n+/, ""); then `---\n${fm}\n---\n\n${body}`.
    const rawBody = parsedBodyContent;
    const strippedBody = rawBody.replace(/^\n+/, "");
    const inline = `---\n${yamlStringify(realisticFm).trimEnd()}\n---\n\n${strippedBody}`;
    const refactored = assembleAsset(realisticFm, rawBody);
    // refactored has the trailing \n that the inline already has (body ends with \n).
    expect(refactored).toBe(inline);
  });

  it("site 6 — src/core/memory-belief.ts:71 (drift: single-newline separator)", () => {
    const inline = `---\n${yamlStringify(realisticFm).trimEnd()}\n---\n${parsedBodyContent}`;
    const refactored = assembleAsset(realisticFm, parsedBodyContent);
    expect(refactored).toBe(inline);
  });

  it("site 7 — src/core/memory-contradiction-detect.ts:185 (drift: single-newline separator)", () => {
    const inline = `---\n${yamlStringify(realisticFm).trimEnd()}\n---\n${parsedBodyContent}`;
    const refactored = assembleAsset(realisticFm, parsedBodyContent);
    expect(refactored).toBe(inline);
  });

  it("site 8 — src/indexer/staleness-detect.ts:563 (conditional separator)", () => {
    // Inline: `---\n${yaml}\n---\n${body.startsWith("\n") ? "" : "\n"}${body}`.
    // Standard input (body starts with \n) → `---\n${yaml}\n---\n${body}`.
    const inline = `---\n${yamlStringify(realisticFm).trimEnd()}\n---\n${parsedBodyContent.startsWith("\n") ? "" : "\n"}${parsedBodyContent}`;
    const refactored = assembleAsset(realisticFm, parsedBodyContent);
    expect(refactored).toBe(inline);
  });

  it("site 9 — src/indexer/memory-inference.ts:351 (canonical, body pre-built with trailing \\n)", () => {
    const fm = {
      inferred: true,
      captureMode: "background",
      source: "memory/parent",
      description: "derived",
      tags: ["derived"],
      title: "Derived Title",
    };
    const constructedBody = `# ${"Derived Title".trim()}\n\n${"Derived content.".trim()}\n`;
    const inline = `---\n${yamlStringify(fm).trimEnd()}\n---\n\n${constructedBody}`;
    const refactored = assembleAsset(fm, constructedBody);
    expect(refactored).toBe(inline);
  });

  it("site 10 — src/indexer/memory-inference.ts:372 (conditional separator)", () => {
    const inline = `---\n${yamlStringify(realisticFm).trimEnd()}\n---\n${parsedBodyContent.startsWith("\n") ? "" : "\n"}${parsedBodyContent}`;
    const refactored = assembleAsset(realisticFm, parsedBodyContent);
    expect(refactored).toBe(inline);
  });

  it("site 11 — src/commands/schema-repair.ts:193 (drift: single-newline separator)", () => {
    const inline = `---\n${yamlStringify(realisticFm).trimEnd()}\n---\n${parsedBodyContent}`;
    const refactored = assembleAsset(realisticFm, parsedBodyContent);
    expect(refactored).toBe(inline);
  });

  it("bonus — src/cli.ts:1908 (feedback --applied-to, conditional separator)", () => {
    // Same pattern as staleness-detect / memory-inference site 10.
    const inline = `---\n${yamlStringify(realisticFm).trimEnd()}\n---\n${parsedBodyContent.startsWith("\n") ? "" : "\n"}${parsedBodyContent}`;
    const refactored = assembleAsset(realisticFm, parsedBodyContent);
    expect(refactored).toBe(inline);
  });
});

describe("assembleAssetFromString — shared fence/body template, BYO serializer", () => {
  it("produces the same bytes as assembleAsset when the serializer matches", () => {
    const fm = { description: "x", tags: ["a"] };
    const direct = assembleAsset(fm, "body");
    const fromString = assembleAssetFromString(serializeFrontmatter(fm), "body");
    expect(fromString).toBe(direct);
  });

  it("accepts a custom JSON.stringify-per-value serializer (distill pattern)", () => {
    // Mirrors src/commands/distill.ts:482-487 — every value JSON-stringified
    // so unquoted/multiline strings can never break the subset parser.
    const fm = { description: "Multi: line breaks: like this", tags: ["a", "b"] };
    const fmLines = Object.entries(fm)
      .map(([k, v]) => {
        if (Array.isArray(v)) return `${k}: [${v.map((s) => JSON.stringify(s)).join(", ")}]`;
        return `${k}: ${JSON.stringify(v)}`;
      })
      .join("\n");
    const out = assembleAssetFromString(fmLines, "Body text.");
    expect(out).toBe(`---\n${fmLines}\n---\n\nBody text.\n`);
    // And it round-trips through the subset parser without losing the description.
    expect(parseFrontmatter(out).data.description).toBe(fm.description);
  });

  it("trims trailing whitespace from the serialized fm defensively", () => {
    const out = assembleAssetFromString("description: x\n\n", "body");
    expect(out).toBe("---\ndescription: x\n---\n\nbody\n");
  });

  it("strips leading newlines from the body (same contract as assembleAsset)", () => {
    const a = assembleAssetFromString("description: x", "\nbody");
    const b = assembleAssetFromString("description: x", "\n\n\nbody");
    const c = assembleAssetFromString("description: x", "body");
    expect(a).toBe(c);
    expect(b).toBe(c);
  });

  it("adds exactly one trailing newline (same contract as assembleAsset)", () => {
    const a = assembleAssetFromString("description: x", "body");
    const b = assembleAssetFromString("description: x", "body\n");
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
    expect(a.endsWith("\n\n")).toBe(false);
  });

  it("is byte-identical for the inline pattern that consolidate.ts:719 used to emit", () => {
    // Consolidate path: input was already round-tripped through parseFrontmatter,
    // so parsed.content begins with `\n` for the standard `---\nfm\n---\n\nbody` shape.
    // The OLD inline code: `---\n${fmStr}\n---\n${parsed.content}` — single \n separator
    // plus parsed.content's leading \n produces the standard \n\n. assembleAssetFromString
    // strips body's leading \n, then the \n\n in the template plus normalizedBody (no
    // leading \n) gives the same total. Verify byte-identity on standard input.
    const fmStr = yamlStringify({ description: "x", tags: ["a"] }).trimEnd();
    const parsedContent = "\nbody content.\n";
    const inline = `---\n${fmStr}\n---\n${parsedContent}`;
    const refactored = assembleAssetFromString(fmStr, parsedContent);
    expect(refactored).toBe(inline);
  });

  it("matches the reflect.ts inline pattern for cleaned bodies (no leading whitespace)", () => {
    // Reflect path: cleanedBody = rawLlmBody.replace(/^\s+/, "") so it never starts
    // with a newline. Old inline: `---\n${fm}\n---\n\n${cleanedBody.trimStart()}`.
    // The cleanedBody has no leading whitespace, trimStart is a no-op. Bytes match
    // except the helper now guarantees a trailing newline (which reflect's old code
    // did not — but downstream proposal writes were already POSIX-tolerant).
    const fmStr = "description: defensive\ntags:\n  - a";
    const cleanedBody = "Body content with no leading whitespace.";
    const oldInline = `---\n${fmStr}\n---\n\n${cleanedBody.trimStart()}`;
    const refactored = assembleAssetFromString(fmStr, cleanedBody);
    expect(refactored).toBe(`${oldInline}\n`); // helper adds the canonical trailing \n
  });
});

/**
 * WS8 (#490) regression: the 5 residual `yamlStringify(fm).trimEnd()` sites
 * that bypassed serializeFrontmatter (extract.ts:193, consolidate.ts:999 /
 * 1956 / 2285 / 2669) were swapped to `serializeFrontmatter(fm)`. Since
 * `serializeFrontmatter`'s body literally IS `yamlStringify(fm).trimEnd()`,
 * the swap is byte-identical for ANY input — pin that here so the equivalence
 * is provable, not asserted.
 */
describe("WS8 regression — residual yamlStringify(fm).trimEnd() sites → serializeFrontmatter", () => {
  const cases: Array<{ label: string; fm: Record<string, unknown> }> = [
    { label: "extract.ts:193 (extracted candidate fm)", fm: { description: "x", sources: ["session:claude:abc"] } },
    {
      label: "consolidate.ts:999 (archiveMemory supersede fm)",
      fm: { description: "y", superseded_at: "2026-06-06T00:00:00.000Z", superseded_reason: "merged" },
    },
    {
      label: "consolidate.ts:1956 (mergedBodyFm)",
      fm: { description: "merged", tags: ["a", "b"], updated: "2026-06-06" },
    },
    { label: "consolidate.ts:2285 (re-serialised cleaned fm)", fm: { description: "cleaned", id: "lesson/foo" } },
    {
      label: "consolidate.ts:2669 (repaired merged fm)",
      fm: { description: "repaired", when_to_use: "always", updated: "2026-06-06" },
    },
  ];
  for (const { label, fm } of cases) {
    it(`byte-identical: ${label}`, () => {
      expect(serializeFrontmatter(fm)).toBe(yamlStringify(fm).trimEnd());
    });
  }

  it("consolidate.ts:2669 keeps its single-newline-separator template (NOT assembleAssetFromString)", () => {
    // This site intentionally emits `---\n${fm}\n---\n${body}` (one \n after the
    // closing fence, no body normalization) — NOT the canonical `\n\n` shape.
    // The serializer is unified but the template literal is preserved verbatim,
    // because assembleAssetFromString would change the bytes (extra trailing \n,
    // leading-\n strip). Pin the divergence so a future "finish the dedup" pass
    // does not silently alter output.
    const repairedYaml = serializeFrontmatter({ description: "x" });
    const bodyPart = "\nbody without trailing newline";
    const out = `---\n${repairedYaml}\n---\n${bodyPart}`;
    expect(out).not.toBe(assembleAssetFromString(repairedYaml, bodyPart));
    expect(out).toBe("---\ndescription: x\n---\n\nbody without trailing newline");
  });
});

describe("regression — assembleAsset survives round-trip through parseFrontmatter (asset shape on disk)", () => {
  it("re-parses to the original frontmatter object", () => {
    const fm = {
      description: "round-trip",
      tags: ["a", "b"],
      captureMode: "hot",
      beliefState: "asserted",
    };
    const body = "First line.\n\nSecond paragraph.\n";
    const assembled = assembleAsset(fm, body);
    const parsed = parseFrontmatter(assembled);
    expect(parsed.data.description).toBe(fm.description);
    expect(parsed.data.tags).toEqual(fm.tags);
    expect(parsed.data.captureMode).toBe(fm.captureMode);
    expect(parsed.data.beliefState).toBe(fm.beliefState);
  });

  it("re-assembles to byte-identical output", () => {
    const fm = { description: "x", tags: ["a"] };
    const body = "body content\n";
    const first = assembleAsset(fm, body);
    const parsed = parseFrontmatter(first);
    const second = assembleAsset(parsed.data, parsed.content);
    expect(second).toBe(first);
  });
});
