import { describe, expect, test } from "bun:test";
import { ensureAkmMarkdownType } from "../../src/core/asset/akm-markdown";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";

const FIXED_NOW = new Date(2026, 2, 14); // 2026-03-14, local time

describe("AKM Markdown OKF compatibility", () => {
  test("adds the native type without changing the body", () => {
    const body = "# A note\n\nBody bytes.\n";
    const output = ensureAkmMarkdownType(body, "knowledge");
    const parsed = parseFrontmatter(output);
    expect(parsed.data.type).toBe("knowledge");
    expect(parsed.content).toBe(body);
  });

  test("preserves nested metadata and body while correcting type", () => {
    const input = "---\ntype: Vendor\nvendor:\n  nested: 42\n---\n\nBody.\n";
    const parsed = parseFrontmatter(ensureAkmMarkdownType(input, "memory"));
    expect(parsed.data.type).toBe("memory");
    expect(parsed.data.vendor).toEqual({ nested: 42 });
    expect(parsed.content).toBe("\nBody.\n");
  });

  test("leaves an already conformant native document byte-identical", () => {
    // Conformant means type AND updated — `akm lint` flags a frontmatter-
    // bearing document with no `updated` as `missing-updated`.
    const input = "---\ntype: workflow\nupdated: 2026-01-15\ndescription: Keep formatting\n---\n\n# Workflow: Test\n";
    expect(ensureAkmMarkdownType(input, "workflow")).toBe(input);
  });

  // Every asset akm writes goes through this chokepoint. Without an `updated`
  // stamp, `akm remember` / `akm import` / accepted proposals produced files
  // that akm's own `akm lint` immediately flagged `missing-updated`.
  describe("updated stamp", () => {
    test("stamps updated when adding frontmatter to a bare body", () => {
      const parsed = parseFrontmatter(ensureAkmMarkdownType("Body bytes.\n", "knowledge", FIXED_NOW));
      expect(parsed.data.type).toBe("knowledge");
      expect(parsed.data.updated).toBe("2026-03-14");
    });

    test("stamps updated on an existing frontmatter block that lacks it", () => {
      const input = "---\ntype: memory\ndescription: Note\n---\n\nBody.\n";
      const parsed = parseFrontmatter(ensureAkmMarkdownType(input, "memory", FIXED_NOW));
      expect(parsed.data.updated).toBe("2026-03-14");
      expect(parsed.data.description).toBe("Note");
      expect(parsed.content).toBe("\nBody.\n");
    });

    test("never overwrites an author's existing updated value", () => {
      const input = "---\ntype: knowledge\nupdated: 2020-01-01\n---\n\nBody.\n";
      const parsed = parseFrontmatter(ensureAkmMarkdownType(input, "knowledge", FIXED_NOW));
      expect(parsed.data.updated).toBe("2020-01-01");
    });

    test("preserves YAML comments and formatting when only adding updated", () => {
      // Round-tripping the mapping through the serializer to contribute one
      // field would silently erase user-authored comments — unacceptable for
      // a write path every accepted proposal and asset edit passes through.
      const input = [
        "---",
        "type: knowledge",
        "# rotate quarterly — see runbook",
        'description: "Prod notes"',
        "---",
        "",
        "Body.",
      ].join("\n");

      const out = ensureAkmMarkdownType(input, "knowledge", FIXED_NOW);

      expect(out).toContain("# rotate quarterly — see runbook");
      expect(out).toContain('description: "Prod notes"');
      expect(parseFrontmatter(out).data.updated).toBe("2026-03-14");
      expect(parseFrontmatter(out).content).toBe("\nBody.\n".replace(/\n$/, ""));
    });

    test("stamps updated even when the type already matches", () => {
      // The type check used to short-circuit the whole function, so a
      // correctly-typed document could never acquire the stamp.
      const input = "---\ntype: knowledge\ndescription: Already typed\n---\n\nBody.\n";
      const parsed = parseFrontmatter(ensureAkmMarkdownType(input, "knowledge", FIXED_NOW));
      expect(parsed.data.updated).toBe("2026-03-14");
    });
  });

  // A proposal that corrects one line of a note must not also rewrap, reorder
  // or strip the note's frontmatter: the reviewer would see changes nobody
  // made. The frontmatter is edited as text, line by line.
  describe("source preservation", () => {
    const LONG_DESCRIPTION =
      "Rotate the staging database credentials every quarter, then restart the worker pool and confirm the nightly job still authenticates";
    const ANNOTATED = [
      "# rotate quarterly — see runbook",
      `description: ${LONG_DESCRIPTION}`,
      "summary: >-",
      "  Hand-wrapped folded text",
      "  that keeps its line breaks.",
      "tags: [ops, db]   # trailing comment",
    ];
    const doc = (frontmatter: string[]) => ["---", ...frontmatter, "---", "", "Body.", ""].join("\n");

    test("adds a missing type without touching a wrapped value, a comment or the key order", () => {
      const frontmatter = [...ANNOTATED, "updated: 2026-01-15"];

      const out = ensureAkmMarkdownType(doc(frontmatter), "knowledge", FIXED_NOW);

      expect(out).toBe(doc([...frontmatter, "type: knowledge"]));
    });

    test("adds a missing type and a missing updated as two lines, in that order", () => {
      const out = ensureAkmMarkdownType(doc(ANNOTATED), "knowledge", FIXED_NOW);

      expect(out).toBe(doc([...ANNOTATED, "type: knowledge", "updated: 2026-03-14"]));
    });

    test("corrects a wrong type on its own line and keeps every other line", () => {
      // The nested `type:` before it is another key and must be left alone.
      const before = [ANNOTATED[0]!, "vendor:", "  type: nested", ...ANNOTATED.slice(1)];
      const after = ["updated: 2026-01-15"];

      const out = ensureAkmMarkdownType(doc([...before, "type: Vendor", ...after]), "memory", FIXED_NOW);

      expect(out).toBe(doc([...before, "type: memory", ...after]));
    });

    test("corrects a wrong type in place and appends a missing updated", () => {
      const out = ensureAkmMarkdownType(doc(["type: Vendor", "# keep", "description: Note"]), "memory", FIXED_NOW);

      expect(out).toBe(doc(["type: memory", "# keep", "description: Note", "updated: 2026-03-14"]));
    });

    test("keeps CRLF line endings, the body included", () => {
      const crlf = (text: string) => text.replaceAll("\n", "\r\n");

      expect(
        ensureAkmMarkdownType(crlf(doc(["description: Note", "updated: 2026-01-15"])), "knowledge", FIXED_NOW),
      ).toBe(crlf(doc(["description: Note", "updated: 2026-01-15", "type: knowledge"])));
      expect(ensureAkmMarkdownType(crlf(doc(["type: Vendor", "updated: 2026-01-15"])), "knowledge", FIXED_NOW)).toBe(
        crlf(doc(["type: knowledge", "updated: 2026-01-15"])),
      );
    });

    test("re-serializes only when a multi-line type cannot be replaced on one line", () => {
      const input = doc(["type:", "  - a", "  - b", "description: Note", "updated: 2026-01-15"]);

      const parsed = parseFrontmatter(ensureAkmMarkdownType(input, "memory", FIXED_NOW));

      expect(parsed.data).toEqual({ type: "memory", description: "Note", updated: "2026-01-15" });
      expect(parsed.content).toBe("\nBody.\n");
    });

    test("re-serializes a flow-style frontmatter mapping rather than append to it", () => {
      const parsed = parseFrontmatter(ensureAkmMarkdownType(doc(["{description: Note}"]), "memory", FIXED_NOW));

      expect(parsed.data).toEqual({ type: "memory", description: "Note", updated: "2026-03-14" });
      expect(parsed.content).toBe("\nBody.\n");
    });
  });
});
