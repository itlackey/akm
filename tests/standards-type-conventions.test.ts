/**
 * Unit tests for the per-type SOFT authoring-convention layer (#646):
 *
 *   - `resolveTypeConventions(stashRoot, type)` — reads
 *     `facts/conventions/assets/<type>.md` directly from disk, validated by
 *     `getAssetTypes()`, degrading to "" on any miss.
 *   - `resolveStandardsContext(ref, stashRoot)` — type-scoped dispatch: a
 *     `skill:x` target pulls the `skill` convention, a `command:y` target pulls
 *     the `command` convention (never the other), the built-in `TYPE_HINTS`
 *     fallback is untouched, and the un-type-scoped general layer no longer
 *     leaks per-type facts.
 *
 * Pure disk reads through the same resolver the reflect/propose call sites use;
 * no spawn/serve, fast.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveStandardsContext } from "../src/core/standards/resolve-standards-context";
import { resolveStashStandards } from "../src/core/standards/resolve-stash-standards";
import { resolveTypeConventions } from "../src/core/standards/resolve-type-conventions";
import { writeFact } from "./_helpers/assets";
import { makeSandboxDir, makeStashDir, type SandboxedDir } from "./_helpers/sandbox";

function writeTypeConvention(stashRoot: string, type: string, body: string, category = "convention"): void {
  const abs = path.join(stashRoot, "facts", "conventions", "assets", `${type}.md`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const fm = category === "" ? "" : `category: ${category}\n`;
  fs.writeFileSync(abs, `---\n${fm}---\n\n${body}\n`, "utf8");
}

describe("resolveTypeConventions", () => {
  let sb: SandboxedDir;
  beforeEach(() => {
    sb = makeStashDir();
  });
  afterEach(() => sb.cleanup());

  test("returns the body of facts/conventions/assets/<type>.md for a known type", () => {
    writeTypeConvention(sb.dir, "skill", "Skills should open with an imperative verb.");
    expect(resolveTypeConventions(sb.dir, "skill")).toBe("Skills should open with an imperative verb.");
  });

  test("returns '' when the per-type fact is absent", () => {
    expect(resolveTypeConventions(sb.dir, "skill")).toBe("");
  });

  test("returns '' when the whole facts dir is missing (degrades safely)", () => {
    const empty = makeSandboxDir("akm-sb-noconv");
    try {
      expect(resolveTypeConventions(empty.dir, "skill")).toBe("");
    } finally {
      empty.cleanup();
    }
  });

  test("returns '' for a basename that is not a known asset type", () => {
    // A file exists, but `bogus` is not in getAssetTypes() → never resolved.
    writeTypeConvention(sb.dir, "bogus", "Some prose for a non-type basename.");
    expect(resolveTypeConventions(sb.dir, "bogus")).toBe("");
  });

  test("returns '' for an undefined/empty type", () => {
    writeTypeConvention(sb.dir, "skill", "Body.");
    expect(resolveTypeConventions(sb.dir, undefined)).toBe("");
    expect(resolveTypeConventions(sb.dir, "")).toBe("");
  });

  test("strips frontmatter, returns only the body", () => {
    writeTypeConvention(sb.dir, "command", "Command body guidance here.");
    const out = resolveTypeConventions(sb.dir, "command");
    expect(out).toContain("Command body guidance here.");
    expect(out).not.toContain("category:");
  });
});

describe("resolveStandardsContext — per-type SOFT conventions (#646)", () => {
  let sb: SandboxedDir;
  beforeEach(() => {
    sb = makeStashDir();
  });
  afterEach(() => sb.cleanup());

  test("authoring skill:x injects the skill convention, not the command one (type-scoped)", () => {
    writeTypeConvention(sb.dir, "skill", "SKILL CONVENTION: keep skills imperative.");
    writeTypeConvention(sb.dir, "command", "COMMAND CONVENTION: body is the prompt.");

    const skillOut = resolveStandardsContext("skill:deploy", sb.dir);
    expect(skillOut).toContain("SKILL CONVENTION: keep skills imperative.");
    expect(skillOut).not.toContain("COMMAND CONVENTION: body is the prompt.");
    // Labeled clearly as soft guidance.
    expect(skillOut).toContain("# fact:conventions/assets/skill");
    expect(skillOut.toLowerCase()).toContain("soft");

    const cmdOut = resolveStandardsContext("command:ship", sb.dir);
    expect(cmdOut).toContain("COMMAND CONVENTION: body is the prompt.");
    expect(cmdOut).not.toContain("SKILL CONVENTION: keep skills imperative.");
  });

  test("when no per-type fact exists, the general layer is returned unchanged (TYPE_HINTS fallback path untouched)", () => {
    // No per-type fact authored. The dispatch must return exactly the general
    // stash standards (which is "" here) — the built-in TYPE_HINTS fallback in
    // prompts.ts is then used downstream, unchanged.
    expect(resolveStandardsContext("skill:deploy", sb.dir)).toBe("");

    writeFact(sb.dir, "conventions/naming.md", "convention", "Use kebab-case for asset names.");
    const out = resolveStandardsContext("skill:deploy", sb.dir);
    expect(out).toContain("Use kebab-case for asset names.");
    expect(out).not.toContain("conventions/assets");
  });

  test("general + per-type compose: both appear, per-type clearly separated", () => {
    writeFact(sb.dir, "conventions/naming.md", "convention", "Use kebab-case for asset names.");
    writeTypeConvention(sb.dir, "skill", "SKILL CONVENTION: keep skills imperative.");

    const out = resolveStandardsContext("skill:deploy", sb.dir);
    expect(out).toContain("Use kebab-case for asset names.");
    expect(out).toContain("SKILL CONVENTION: keep skills imperative.");
    // The general layer comes first, the per-type soft section after.
    expect(out.indexOf("kebab-case")).toBeLessThan(out.indexOf("SKILL CONVENTION"));
  });

  test("per-type facts do NOT leak un-type-scoped through the general layer", () => {
    // A per-type convention fact carries category: convention, so without the
    // exclusion it would also be picked up un-type-scoped by resolveStashStandards.
    writeTypeConvention(sb.dir, "skill", "SKILL CONVENTION should not leak to command.");

    // The general resolver must ignore facts/conventions/assets/*.
    expect(resolveStashStandards(sb.dir)).toBe("");

    // Authoring a different type must NOT receive the skill convention.
    const cmdOut = resolveStandardsContext("command:ship", sb.dir);
    expect(cmdOut).not.toContain("SKILL CONVENTION should not leak to command.");
  });

  test("a fact under conventions/assets/ with an unknown-type basename is never injected", () => {
    writeTypeConvention(sb.dir, "bogus", "Junk under a non-type basename.");
    // Not via the general layer (excluded), and not via the type-scoped layer
    // (basename not a known type).
    expect(resolveStashStandards(sb.dir)).toBe("");
    expect(resolveStandardsContext("bogus:thing" as string, sb.dir)).toBe("");
  });

  test("wiki targets are unaffected — no per-type convention leaks into Feature A", () => {
    const dir = path.join(sb.dir, "wikis", "research");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "schema.md"),
      ["---", "description: research wiki schema", "---", "", "Research rule: cite a source.", ""].join("\n"),
      "utf8",
    );
    writeTypeConvention(sb.dir, "skill", "SKILL CONVENTION: keep skills imperative.");

    const out = resolveStandardsContext("wiki:research/foo", sb.dir);
    expect(out).toContain("Research rule: cite a source.");
    expect(out).not.toContain("SKILL CONVENTION: keep skills imperative.");
  });
});
