// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared stash-asset writers for tests.
 *
 * These write markdown asset files (memories, lessons, skills, facts) into a
 * stash directory in the exact byte format the previously-duplicated per-file
 * copies produced, so tests keep asserting the same indexed content. Consolidating
 * them here deletes the copy-paste scaffolding that made test LOC exceed source LOC.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Render a frontmatter object into YAML lines (no surrounding `---` fences).
 * Scalars become `key: value`; arrays become a `key:` line followed by
 * `  - item` lines.
 */
export function renderFrontmatter(frontmatter: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${String(item)}`);
      continue;
    }
    lines.push(`${key}: ${String(value)}`);
  }
  return lines;
}

/**
 * Write `memories/<name>.md` with the given frontmatter and body.
 * Format: `---\n<frontmatter>\n---\n\n<body.trim()>\n`.
 */
export function writeMemory(stashDir: string, name: string, frontmatter: Record<string, unknown>, body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = ["---", ...renderFrontmatter(frontmatter), "---", "", body.trim(), ""];
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

/**
 * Write `lessons/<name>.md` with a `description` + `when_to_use` frontmatter and
 * a `# <name>` heading followed by `Body text.`.
 */
export function writeLesson(stashDir: string, name: string, description: string, whenToUse: string): void {
  const filePath = path.join(stashDir, "lessons", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [
    "---",
    `description: ${description}`,
    `when_to_use: ${whenToUse}`,
    "---",
    "",
    `# ${name}`,
    "",
    "Body text.",
    "",
  ];
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

/**
 * Write `skills/<name>.md` with a `name` + `description` frontmatter and the
 * given body.
 */
export function writeSkill(stashDir: string, name: string, body: string): void {
  const filePath = path.join(stashDir, "skills", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}\n`, "utf8");
}

/**
 * Write `facts/<relPath>` with a `category` frontmatter and the given body.
 */
export function writeFact(stashRoot: string, relPath: string, category: string, body: string): void {
  const abs = path.join(stashRoot, "facts", relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `---\ncategory: ${category}\n---\n\n${body}\n`, "utf8");
}
