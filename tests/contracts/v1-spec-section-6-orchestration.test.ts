import { describe, expect, test } from "bun:test";
import { extractSection, readDoc, SPEC_PATH } from "./spec-helpers";

// Pins v1 spec §6 — Orchestration.
//
// The freeze rule:
//   * search → indexer.search(q); registry hits never merge into source hits.
//   * show → indexer.lookup(ref) then read file from disk.
//   * remember/import target resolution: --target → defaultWriteTarget →
//     working stash → ConfigError.
//   * `index.db` is ephemeral; `usage_events` is preserved across schema bumps.

describe("v1 spec §6 — orchestration", () => {
  const spec = readDoc(SPEC_PATH);
  const section = extractSection(spec, "## 6. Orchestration");

  test("§6 exists in the spec", () => {
    expect(section).not.toBe("");
  });

  test("§6.1 says search uses indexer.search and registry hits stay separate", () => {
    expect(section).toMatch(/indexer\.search/);
    expect(section).toMatch(/--include-registry/);
    expect(section).toMatch(/never merge into source hits/i);
  });

  test("§6.2 says show uses indexer.lookup and reads the file from disk", () => {
    expect(section).toMatch(/indexer\.lookup/);
    expect(section).toMatch(/readFile/);
  });

  test("§6.5 declares the write-target resolution order", () => {
    const flat = section.replace(/\s+/g, " ");
    expect(flat).toMatch(/--target.*defaultWriteTarget.*working stash.*ConfigError/);
    expect(section).toMatch(/akm init/);
  });

  test("§6.7 declares index.db is ephemeral and usage_events is preserved", () => {
    expect(section).toMatch(/index\.db.*ephemeral/i);
    expect(section).toMatch(/preserving `usage_events`/);
    expect(section).toMatch(/workflow\.db.*never\s*touched/i);
  });

  test("§6 stops before §7 (helper boundary check)", () => {
    expect(section).not.toContain("## 7.");
    expect(section).not.toContain("## 8.");
  });
});
