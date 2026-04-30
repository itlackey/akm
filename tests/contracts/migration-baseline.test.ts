import { describe, expect, test } from "bun:test";
import { extractSection, MIGRATION_PATH, readDoc } from "./spec-helpers";

// Pins docs/migration/v1.md — pre-release migration baseline.
//
// The migration page must describe the delta from the current pre-release
// to v1.0, not the older 0.5 → 0.6 refactor narrative. This test fails if
// the page reverts to the old framing.

describe("docs/migration/v1.md — pre-release migration baseline", () => {
  const doc = readDoc(MIGRATION_PATH);

  test("audience is pre-release users, not 0.5.x users", () => {
    expect(doc).toMatch(/0\.6\.x or 0\.7\.x \*\*pre-release\*\*/);
  });

  test("delta table names every locked planned-for-v1 surface", () => {
    expect(doc).toContain("`agent.*`");
    expect(doc).toContain("`llm.features.*`");
    expect(doc).toContain("`lesson`");
    expect(doc).toContain("Proposal queue");
  });

  test("describes the proposal queue as durable filesystem state under .akm/proposals/", () => {
    expect(doc).toContain("<stashRoot>/.akm/proposals/");
    expect(doc).toContain("proposal.json");
  });

  test("calls out the registry `curated` removal as a planned change", () => {
    const section = extractSection(doc, "## Planned for v1 — registry `curated` removed");
    expect(section).not.toBe("");
    expect(section).toMatch(/parses and silently ignores/);
  });

  test("locked decisions list includes the planned quality and boundary rules", () => {
    const tldr = extractSection(doc, "## TL;DR — locked decisions for v1");
    expect(tldr).not.toBe("");
    expect(tldr).toContain('quality: "proposed"');
    expect(tldr).toContain("CLI shell-out only");
  });

  test("does NOT lead with the historical 0.5 → 0.6 baseline", () => {
    // Sanity: the page should orient new readers around the pre-release
    // delta, not the old refactor narrative. The first H1 must be the v1
    // migration page.
    const firstHeading = doc.match(/^# .*$/m);
    expect(firstHeading?.[0]).toBe("# Migrating to akm v1");
    // The opening blockquote must point readers on 0.5.x to the older guide.
    expect(doc).toMatch(/v0\.5-to-v0\.6\.md/);
  });
});
