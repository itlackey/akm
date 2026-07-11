import { describe, expect, test } from "bun:test";
import { ARCHITECTURE_PATH, extractSection, readDoc } from "./spec-helpers";

// Current orchestration invariants:
//   * search → indexer.search(q); registry hits never merge into source hits.
//   * show → indexer.lookup(ref) then read file from disk.
//   * remember/import target resolution: --target → defaultWriteTarget →
//     working stash → ConfigError.
//   * `index.db` is ephemeral; `usage_events` is preserved across schema bumps.

describe("current orchestration documentation contract", () => {
  const architecture = readDoc(ARCHITECTURE_PATH);

  test("search uses one local scoring pipeline and keeps registry hits separate", () => {
    const section = extractSection(architecture, "## Search Pipeline");
    expect(section).toContain("one");
    expect(section).toContain("registryHits");
    expect(section).toMatch(/not\s+rank-merged/i);
  });

  test("show resolves through the index and reads from disk without provider fallback", () => {
    const section = extractSection(architecture, "## Show Resolution");
    expect(section).toContain("lookup(ref)");
    expect(section).toMatch(/reads? the file from disk/i);
    expect(section).toContain("no remote provider fallback");
  });

  test("write-target resolution retains explicit, default, stash order", () => {
    const section = extractSection(architecture, "## Writing to Sources");
    expect(section.replace(/\s+/g, " ")).toMatch(/--target.*defaultWriteTarget.*stashDir.*ConfigError/);
  });

  test("workflow run state remains separate from the asset index", () => {
    const section = extractSection(architecture, "## Workflow Runtime State");
    expect(section).toContain("workflow.db");
    expect(section).toMatch(/survive index rebuilds/i);
    expect(section).toMatch(/not derived from the FTS index/i);
  });
});
