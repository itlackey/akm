import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const docsRoot = path.join(repoRoot, "docs");
const NON_USER_FACING_DOC_DIRS = new Set([
  "archive",
  "design",
  "historical",
  "incidents",
  "migration",
  "posts",
  "reviews",
]);
const ACTIVE_ROOT_DOCS = ["README.md", ".github/README.npm.md", "SECURITY.md", "STABILITY.md"];
const HELP_DOCS_ROOT = path.join(repoRoot, "src", "assets", "help");

export const ARCHITECTURE_PATH = path.join(repoRoot, "docs", "technical", "architecture.md");
export const CLI_DOC_PATH = path.join(repoRoot, "docs", "cli.md");
export const CONFIG_DOC_PATH = path.join(repoRoot, "docs", "configuration.md");
export const IMPROVE_AUTOSYNC_PATH = path.join(repoRoot, "docs", "technical", "improve-autosync-investigation.md");
export const MIGRATION_PATH = path.join(repoRoot, "docs", "migration", "v0.8-to-v0.9.md");
export const PR_714_REPRO_PATH = path.join(repoRoot, "docs", "technical", "pr-714-workflow-validation-repro.md");

export function readDoc(p: string): string {
  return fs.readFileSync(p, "utf8");
}

export function activeMarkdownDocs(): string[] {
  const docs = ACTIVE_ROOT_DOCS.map((relativePath) => path.join(repoRoot, relativePath));
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && NON_USER_FACING_DOC_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".md")) docs.push(fullPath);
    }
  };
  walk(docsRoot);
  for (const entry of fs.readdirSync(HELP_DOCS_ROOT, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) docs.push(path.join(HELP_DOCS_ROOT, entry.name));
  }
  return docs.sort();
}

function withoutRetiredSections(doc: string): string {
  const lines = doc.split("\n");
  const kept: string[] = [];
  let ignoredHeadingDepth: number | undefined;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const depth = heading[1]!.length;
      if (ignoredHeadingDepth !== undefined && depth <= ignoredHeadingDepth) ignoredHeadingDepth = undefined;
      if (/\b(?:legacy|migration|retired)\b/i.test(heading[2]!)) ignoredHeadingDepth = depth;
    }
    if (ignoredHeadingDepth === undefined) kept.push(line);
  }
  return kept.join("\n");
}

export function retiredExecutionExamples(doc: string): string[] {
  const findings: string[] = [];
  const activeDoc = withoutRetiredSections(doc);
  if (/(?:^|[{,]\s*)["']?(?:profiles|profile|runner)["']?\s*:/m.test(activeDoc)) findings.push("profile/runner");
  if (/(?:^|\s)--(?:profile|runner)(?:$|[=\s`.,;)])/m.test(activeDoc)) findings.push("profile/runner");
  if (/\bdefaults\.agent\b/.test(activeDoc)) findings.push("defaults.agent");
  if (/"defaults"\s*:\s*\{[^{}]*"agent"\s*:/s.test(activeDoc)) findings.push("defaults.agent");
  if (/^\s*defaults:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+agent\s*:/m.test(activeDoc)) findings.push("defaults.agent");
  if (/\bllm\.endpoint\b/.test(activeDoc)) findings.push("llm.endpoint");
  return [...new Set(findings)];
}

/**
 * Extract a section by its heading line (e.g. "## 9. Locked contracts for v1").
 * Returns an empty string if the heading is not present.
 *
 * Used by contract tests to scope their assertions to one current-document
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
