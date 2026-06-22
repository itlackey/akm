/**
 * Unit tests for the two standards leaf resolvers (Step 1 of the standards
 * plan, docs/design/standards-wiki-schema-PLAN.md):
 *
 *   - `loadWikiSchema`        (Feature A — wiki schema body delivery)
 *   - `resolveStashStandards` (Feature B — convention/meta fact bodies)
 *
 * Both are pure disk readers that swallow-and-degrade; no spawn/serve, fast.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveStashStandards } from "../src/core/standards/resolve-stash-standards";
import { loadWikiSchema } from "../src/wiki/wiki";
import { makeSandboxDir, makeStashDir, type SandboxedDir } from "./_helpers/sandbox";

describe("loadWikiSchema", () => {
  let sb: SandboxedDir;
  beforeEach(() => {
    sb = makeSandboxDir("akm-sb-wikischema");
  });
  afterEach(() => sb.cleanup());

  function writeSchema(name: string, contents: string): void {
    const dir = path.join(sb.dir, "wikis", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "schema.md"), contents, "utf8");
  }

  test("returns the markdown body and frontmatter for a valid schema.md", () => {
    writeSchema(
      "research",
      [
        "---",
        "description: Research wiki schema",
        "pageKind: [note, source]",
        "---",
        "",
        "# Page contract",
        "",
        "Hard rule: every page MUST cite a source.",
        "",
      ].join("\n"),
    );

    const { body, frontmatter } = loadWikiSchema(sb.dir, "research");
    expect(body).toContain("# Page contract");
    expect(body).toContain("Hard rule: every page MUST cite a source.");
    // Body must NOT include the frontmatter block.
    expect(body).not.toContain("description: Research wiki schema");
    expect(frontmatter.description).toBe("Research wiki schema");
  });

  test("returns empty for a missing schema.md", () => {
    const result = loadWikiSchema(sb.dir, "does-not-exist");
    expect(result).toEqual({ body: "", frontmatter: {} });
  });

  test("returns empty for an invalid wiki name (never throws)", () => {
    const result = loadWikiSchema(sb.dir, "Not A Valid Name!");
    expect(result).toEqual({ body: "", frontmatter: {} });
  });

  test("malformed frontmatter degrades to whole content as body, never throws", () => {
    // No frontmatter delimiters at all: parseFrontmatter treats the entire
    // file as body with empty data — a valid prose schema.
    writeSchema("plain", "# Just prose\n\nNo frontmatter here.\n");
    const { body, frontmatter } = loadWikiSchema(sb.dir, "plain");
    expect(body).toContain("# Just prose");
    expect(frontmatter).toEqual({});
  });
});

describe("resolveStashStandards", () => {
  let sb: SandboxedDir;
  beforeEach(() => {
    sb = makeStashDir();
    fs.mkdirSync(path.join(sb.dir, "facts"), { recursive: true });
  });
  afterEach(() => sb.cleanup());

  function writeFact(relPath: string, category: string | null, body: string): void {
    const abs = path.join(sb.dir, "facts", relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const fm = category === null ? "" : `category: ${category}\n`;
    fs.writeFileSync(abs, `---\n${fm}---\n\n${body}\n`, "utf8");
  }

  test("returns '' when there are no facts", () => {
    expect(resolveStashStandards(sb.dir)).toBe("");
  });

  test("returns '' when there is no facts directory at all", () => {
    const empty = makeSandboxDir("akm-sb-nofacts");
    try {
      expect(resolveStashStandards(empty.dir)).toBe("");
    } finally {
      empty.cleanup();
    }
  });

  test("concatenates convention and meta fact bodies with provenance headers", () => {
    writeFact("conventions/naming.md", "convention", "Use kebab-case for asset names.");
    writeFact("meta/projects.md", "meta", "Active project: akm.");

    const out = resolveStashStandards(sb.dir);
    expect(out).toContain("# fact:conventions/naming");
    expect(out).toContain("Use kebab-case for asset names.");
    expect(out).toContain("# fact:meta/projects");
    expect(out).toContain("Active project: akm.");
  });

  test("ignores facts in other categories", () => {
    writeFact("personal/me.md", "personal", "I like tabs.");
    writeFact("team/stack.md", "team", "We use Bun.");
    writeFact("project/x.md", "project", "Project detail.");
    writeFact("uncategorized.md", null, "No category here.");

    expect(resolveStashStandards(sb.dir)).toBe("");
  });

  test("selects by frontmatter category regardless of subdirectory (flat vs nested)", () => {
    // A convention fact placed FLAT at facts/ root (not under conventions/).
    writeFact("flat-rule.md", "convention", "Flat convention body.");
    // A non-standard fact placed UNDER conventions/ — path says convention,
    // but frontmatter category does not, so it must be ignored.
    writeFact("conventions/misfiled.md", "project", "Misfiled, should be skipped.");

    const out = resolveStashStandards(sb.dir);
    expect(out).toContain("# fact:flat-rule");
    expect(out).toContain("Flat convention body.");
    expect(out).not.toContain("Misfiled, should be skipped.");
  });

  test("preserves stable enumeration order across calls", () => {
    writeFact("conventions/aaa.md", "convention", "First.");
    writeFact("conventions/bbb.md", "convention", "Second.");
    writeFact("meta/ccc.md", "meta", "Third.");

    const first = resolveStashStandards(sb.dir);
    const second = resolveStashStandards(sb.dir);
    expect(first).toBe(second);
    // aaa before bbb before ccc (sorted, depth-first).
    expect(first.indexOf("# fact:conventions/aaa")).toBeLessThan(first.indexOf("# fact:conventions/bbb"));
    expect(first.indexOf("# fact:conventions/bbb")).toBeLessThan(first.indexOf("# fact:meta/ccc"));
  });
});
