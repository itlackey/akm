import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { CLI_DOC_PATH, readDoc } from "./contract-helpers";

// Pure file reads: pins the docs that describe the metrics events and the
// Unreleased changelog layout, so a drift back to the old text fails here.
const repoRoot = path.resolve(import.meta.dir, "..", "..");
const TELEMETRY_DOC = readDoc(path.join(repoRoot, "docs", "reference", "data-and-telemetry.md"));
const STORAGE_DOC = readDoc(path.join(repoRoot, "docs", "architecture", "internals", "storage-locations.md"));
const CLI_DOC = readDoc(CLI_DOC_PATH);
const CHANGELOG = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");

function tableRow(doc: string, eventType: string): string[] {
  return doc.split("\n").filter((line) => line.startsWith(`| \`${eventType}\``));
}

function unreleasedSection(): string {
  const start = CHANGELOG.indexOf("## [Unreleased]");
  const next = CHANGELOG.indexOf("\n## [", start + 1);
  return CHANGELOG.slice(start, next === -1 ? undefined : next);
}

describe("metrics event inventories", () => {
  const phaseFields = ["mode", "totalMs", "walkMs", "llmMs", "embedMs", "ftsMs", "finalizeMs"];

  for (const [name, doc] of [
    ["data-and-telemetry.md", TELEMETRY_DOC],
    ["storage-locations.md", STORAGE_DOC],
  ] as const) {
    test(`${name} lists index_completed with its phase fields`, () => {
      const rows = tableRow(doc, "index_completed");
      expect(rows).toHaveLength(1);
      for (const field of phaseFields) expect(rows[0]).toContain(`\`${field}\``);
    });

    test(`${name} says llm_usage comes from any command and the process-wide sink skips an empty summary`, () => {
      expect(tableRow(doc, "llm_usage")[0]).toMatch(/every akm command|any akm command/);
      expect(tableRow(doc, "llm_usage_summary")[0]).toContain("writes none when it saw no call");
    });
  }

  test("data-and-telemetry.md documents the search summary row timings", () => {
    expect(TELEMETRY_DOC).toMatch(
      /search` summary row[\s\S]{0,400}`totalMs`[\s\S]{0,200}`rankMs`[\s\S]{0,60}`embedMs`/,
    );
    expect(TELEMETRY_DOC).toContain("registry-only search has `totalMs` alone");
  });
});

describe("docs wording", () => {
  test("cli.md --since note reads cleanly", () => {
    expect(CLI_DOC).toContain("A `--since` older than what a store keeps names the store");
    expect(CLI_DOC).not.toContain("older than a store keeps");
  });
});

describe("CHANGELOG Unreleased layout", () => {
  const section = unreleasedSection();

  test("has no bullets before the first subsection heading", () => {
    const beforeFirstHeading = section.split(/^### /m)[0];
    expect(beforeFirstHeading).not.toMatch(/^- /m);
  });

  test("every subsection heading has a blank line before it", () => {
    const lines = section.split("\n");
    lines.forEach((line, i) => {
      if (line.startsWith("### ")) expect(lines[i - 1]).toBe("");
    });
  });

  test("files each entry under Added, Changed or Fixed", () => {
    const body = (heading: string): string => {
      const m = section.match(new RegExp(`### ${heading}\\n([\\s\\S]*?)(?=\\n### |$)`));
      return m?.[1] ?? "";
    };
    expect(body("Added")).toContain("`akm metrics` reports what akm has recorded");
    expect(body("Changed")).toContain("LLM usage is recorded for every command");
    expect(body("Changed")).toContain("`index_completed` event");
    expect(body("Fixed")).toContain("Usage-event retention no longer deletes a day early");
  });
});
