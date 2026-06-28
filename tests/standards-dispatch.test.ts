/**
 * Unit tests for the standards dispatch resolver (Step 2 of the
 * standards plan, docs/archive/standards-wiki-schema-PLAN.md):
 *
 *   resolveStandardsContext(ref, stashRoot) — the single place that selects
 *   which standards feature fires for a write target, mutually exclusively:
 *     - wiki page  → Feature A (that wiki's schema.md body)
 *     - non-wiki   → Feature B (convention/meta fact bodies)
 *     - wiki raw/  → neither (empty)
 *     - wiki infra → neither (empty)
 *
 * Pure disk reads through the same resolver the reflect/propose call sites use;
 * no spawn/serve, fast.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveStandardsContext } from "../src/core/standards/resolve-standards-context";
import { makeStashDir, type SandboxedDir } from "./_helpers/sandbox";

describe("resolveStandardsContext", () => {
  let sb: SandboxedDir;
  beforeEach(() => {
    sb = makeStashDir();
  });
  afterEach(() => sb.cleanup());

  function writeSchema(name: string, body: string): void {
    const dir = path.join(sb.dir, "wikis", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "schema.md"),
      ["---", `description: ${name} wiki schema`, "pageKind: [note, source]", "---", "", body, ""].join("\n"),
      "utf8",
    );
  }

  function writeFact(relPath: string, category: string, body: string): void {
    const abs = path.join(sb.dir, "facts", relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `---\ncategory: ${category}\n---\n\n${body}\n`, "utf8");
  }

  // ── Feature A — wiki page targets pull that wiki's schema body ────────────

  test("a wiki-page target injects body-derived rules from that wiki's schema", () => {
    writeSchema("research", "# Page contract\n\nHard rule: every page MUST cite a source.");

    const out = resolveStandardsContext("wiki:research/topics/photosynthesis", sb.dir);
    // Body-derived rule, NOT merely the frontmatter description.
    expect(out).toContain("Hard rule: every page MUST cite a source.");
    expect(out).toContain("# Page contract");
    expect(out).not.toContain("description:");
  });

  test("editing one wiki's page pulls that wiki's schema, never the other's", () => {
    writeSchema("research", "Research rule: cite a source.");
    writeSchema("product", "Product rule: link the spec.");

    const research = resolveStandardsContext("wiki:research/foo", sb.dir);
    expect(research).toContain("Research rule: cite a source.");
    expect(research).not.toContain("Product rule: link the spec.");

    const product = resolveStandardsContext("wiki:product/foo", sb.dir);
    expect(product).toContain("Product rule: link the spec.");
    expect(product).not.toContain("Research rule: cite a source.");
  });

  // ── Feature B — non-wiki asset targets pull convention/meta facts ─────────

  test("a non-wiki asset target injects the convention/meta fact bodies", () => {
    writeFact("conventions/naming.md", "convention", "Use kebab-case for asset names.");
    writeFact("meta/projects.md", "meta", "Active project: akm.");

    const out = resolveStandardsContext("skill:deploy", sb.dir);
    expect(out).toContain("# fact:conventions/naming");
    expect(out).toContain("Use kebab-case for asset names.");
    expect(out).toContain("# fact:meta/projects");
    expect(out).toContain("Active project: akm.");
  });

  test("an undefined target (chooser flow) falls back to stash standards", () => {
    writeFact("conventions/naming.md", "convention", "Use kebab-case for asset names.");
    const out = resolveStandardsContext(undefined, sb.dir);
    expect(out).toContain("Use kebab-case for asset names.");
  });

  // ── Mutual exclusion ──────────────────────────────────────────────────────

  test("a wiki-page target gets NO stash-standards facts", () => {
    writeSchema("research", "Research rule: cite a source.");
    writeFact("conventions/naming.md", "convention", "Use kebab-case for asset names.");

    const out = resolveStandardsContext("wiki:research/foo", sb.dir);
    expect(out).toContain("Research rule: cite a source.");
    expect(out).not.toContain("Use kebab-case for asset names.");
    expect(out).not.toContain("# fact:conventions/naming");
  });

  test("a non-wiki target gets NO wiki schema", () => {
    writeSchema("research", "Research rule: cite a source.");
    writeFact("conventions/naming.md", "convention", "Use kebab-case for asset names.");

    const out = resolveStandardsContext("skill:deploy", sb.dir);
    expect(out).toContain("Use kebab-case for asset names.");
    expect(out).not.toContain("Research rule: cite a source.");
  });

  // ── Neither fires ─────────────────────────────────────────────────────────

  test("a wiki raw/ target yields empty standardsContext (neither fires)", () => {
    writeSchema("research", "Research rule: cite a source.");
    writeFact("conventions/naming.md", "convention", "Use kebab-case for asset names.");

    expect(resolveStandardsContext("wiki:research/raw/some-source", sb.dir)).toBe("");
  });

  test("a wiki infra file (schema/index/log) target yields empty (neither fires)", () => {
    writeSchema("research", "Research rule: cite a source.");
    expect(resolveStandardsContext("wiki:research/schema", sb.dir)).toBe("");
    expect(resolveStandardsContext("wiki:research/index", sb.dir)).toBe("");
    expect(resolveStandardsContext("wiki:research/log", sb.dir)).toBe("");
  });

  test("a bare wiki ref with no page yields empty (neither fires)", () => {
    writeSchema("research", "Research rule: cite a source.");
    expect(resolveStandardsContext("wiki:research", sb.dir)).toBe("");
  });

  test("a NESTED page whose basename matches an infra name still fires (Feature A)", () => {
    writeSchema("research", "Research rule: cite a source.");
    // `wiki:research/analysis/schema` is a genuine nested page, NOT the wiki's
    // root schema.md — it must inject the wiki schema body, not be suppressed.
    const out = resolveStandardsContext("wiki:research/analysis/schema", sb.dir);
    expect(out).toContain("Research rule: cite a source.");
  });
});
