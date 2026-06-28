import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..");

export const SPEC_PATH = path.join(repoRoot, "docs", "technical", "v1-architecture-spec.md");
export const CLI_DOC_PATH = path.join(repoRoot, "docs", "cli.md");
export const CONFIG_DOC_PATH = path.join(repoRoot, "docs", "configuration.md");
export const MIGRATION_PATH = path.join(repoRoot, "docs", "migration", "v1.md");

export function readDoc(p: string): string {
  return fs.readFileSync(p, "utf8");
}

/**
 * Extract a section by its heading line (e.g. "## 9. Locked contracts for v1").
 * Returns an empty string if the heading is not present.
 *
 * Used by contract tests to scope their assertions to a single spec
 * section so unrelated edits elsewhere in the doc don't cause false
 * positives.
 */
export function extractSection(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  if (start < 0) return "";
  const depthMatch = heading.match(/^#+/);
  const depth = depthMatch ? depthMatch[0].length : 2;
  // Stop only on a heading at the SAME depth or shallower, OUTSIDE any
  // fenced code block. Markdown headings inside ```...``` blocks are not
  // real headings and must not terminate a section. We stream the doc line
  // by line tracking fence state.
  const lines = doc.slice(start + heading.length).split("\n");
  const stopRe = new RegExp(`^#{1,${depth}}\\s`);
  let inFence = false;
  let consumed = 0;
  // Skip the rest of the heading line itself.
  consumed += (lines.shift() ?? "").length + 1;
  for (const line of lines) {
    const fenceMatch = /^(```+|~~~+)/.test(line.trimStart());
    if (fenceMatch) {
      inFence = !inFence;
    } else if (!inFence && stopRe.test(line)) {
      return doc.slice(start, start + heading.length + consumed);
    }
    consumed += line.length + 1;
  }
  return doc.slice(start);
}
