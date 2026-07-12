import { describe, expect, test } from "bun:test";
import { ARCHITECTURE_PATH, extractSection, readDoc } from "./contract-helpers";

describe("current provider boundary contract", () => {
  const architecture = readDoc(ARCHITECTURE_PATH);

  test("source providers are limited to materialized filesystem, git, website, and npm sources", () => {
    const section = extractSection(architecture, "## Sources and Source Providers");
    for (const kind of ["filesystem", "git", "website", "npm"]) expect(section).toContain(`\`${kind}\``);
    expect(section).toMatch(/do \*\*not\*\* implement `search`, `show`, `canShow`/);
    expect(section).toMatch(/local FTS5 index/);
  });

  test("registry providers remain catalogs separate from source providers", () => {
    const section = extractSection(architecture, "## Registry Providers");
    expect(section).toContain("RegistryProvider");
    expect(section).toContain("`static-index`");
    expect(section).toContain("`skills-sh`");
    expect(section).toMatch(/Context Hub is \*\*not\*\* a registry provider type/);
  });
});
