#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { parseFrontmatterBlock } from "../src/core/frontmatter";

type Options = {
  fix: boolean;
  rootDir: string;
};

type Issue = {
  file: string;
  message: string;
  severity: "error" | "warn";
};

type Frontmatter = Record<string, unknown>;

const MAX_DESCRIPTION_LENGTH = 160;

const options = parseArgs(process.argv.slice(2));
const postsDir = path.resolve(options.rootDir, "docs/posts");
const files = collectMarkdownFiles(postsDir);

const issues: Issue[] = [];
let changedFiles = 0;

for (const file of files) {
  const original = fs.readFileSync(file, "utf8");
  const normalized = normalizePostText(original);

  if (normalized !== original) {
    issues.push({
      file,
      message: "contains characters that will be normalized before publishing",
      severity: "warn",
    });
  }

  const block = parseFrontmatterBlock(normalized);
  if (!block) {
    issues.push({ file, message: "missing valid frontmatter delimiters", severity: "error" });
    continue;
  }

  const doc = parseDocument(block.frontmatter, { prettyErrors: true });
  if (doc.errors.length > 0) {
    for (const error of doc.errors) {
      issues.push({ file, message: `frontmatter YAML error: ${error.message}`, severity: "error" });
    }
    continue;
  }

  const frontmatter = (doc.toJSON() ?? {}) as Frontmatter;
  const validation = validateFrontmatter(file, frontmatter, issues);

  if (options.fix) {
    const updated = applyFixes(normalized, block.frontmatter, validation);
    if (updated !== original) {
      fs.writeFileSync(file, updated, "utf8");
      changedFiles += 1;
    }
  }
}

const uniqueIssues = dedupeIssues(issues);

for (const issue of uniqueIssues) {
  process.stderr.write(`${path.relative(process.cwd(), issue.file)}: ${issue.message}\n`);
}

const hasErrors = uniqueIssues.some((issue) => issue.severity === "error");

if (hasErrors) {
  process.stderr.write(
    options.fix
      ? `\nFix the reported errors and rerun.\n`
      : `\nRun with --fix to normalize characters in-place.\n`,
  );
  process.exit(1);
}

if (uniqueIssues.length > 0) {
  process.stderr.write(
    options.fix
      ? `\nWarnings were emitted, but the files were normalized successfully.\n`
      : `\nRun with --fix to normalize characters in-place.\n`,
  );
}

if (options.fix) {
  process.stdout.write(`Normalized ${changedFiles} file(s).\n`);
} else {
  process.stdout.write(`Validated ${files.length} file(s).\n`);
}

function parseArgs(argv: string[]): Options {
  let fix = false;
  let rootDir = process.cwd();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fix") {
      fix = true;
      continue;
    }

    if (arg === "--root" && i + 1 < argv.length) {
      rootDir = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: bun scripts/lint-devto-posts.ts [--fix] [--root <repo-root>]\n",
      );
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { fix, rootDir };
}

function collectMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function normalizePostText(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200D\u2060\u00AD]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .normalize("NFC");
}

function validateFrontmatter(
  file: string,
  frontmatter: Frontmatter,
  issues: Issue[],
): { descriptionTooLong: boolean } {
  const title = stringValue(frontmatter.title);
  const description = stringValue(frontmatter.description);
  const tags = arrayValue(frontmatter.tags);
  let descriptionTooLong = false;

  if (!title) {
    issues.push({ file, message: "frontmatter is missing required 'title'" });
  } else {
    if (title.length > 100) {
      issues.push({ file, message: "title exceeds 100 characters" });
    }
    if (hasControlChars(title)) {
      issues.push({ file, message: "title contains control characters" });
    }
  }

  if (!description) {
    issues.push({ file, message: "frontmatter is missing required 'description'" });
  } else {
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      descriptionTooLong = true;
      issues.push({
        file,
        message: `description exceeds ${MAX_DESCRIPTION_LENGTH} characters and will be truncated in --fix mode`,
        severity: "warn",
      });
    }
    if (hasControlChars(description)) {
      issues.push({ file, message: "description contains control characters", severity: "error" });
    }
  }

  if (tags === null) {
    issues.push({ file, message: "frontmatter is missing required 'tags' array", severity: "error" });
  } else {
    if (tags.length === 0) {
      issues.push({ file, message: "tags array must not be empty", severity: "error" });
    }
    if (tags.length > 4) {
      issues.push({ file, message: "tags array exceeds DEV.to's 4-tag limit", severity: "error" });
    }

    for (const tag of tags) {
      if (!tag) {
        issues.push({ file, message: "tags must contain only non-empty strings", severity: "error" });
        continue;
      }
      if (tag.length > 25) {
        issues.push({ file, message: `tag '${tag}' exceeds 25 characters`, severity: "error" });
      }
      if (hasControlChars(tag)) {
        issues.push({ file, message: `tag '${tag}' contains control characters`, severity: "error" });
      }
      if (/\s/.test(tag)) {
        issues.push({ file, message: `tag '${tag}' contains whitespace`, severity: "error" });
      }
    }
  }

  const coverImage = stringValue(frontmatter.cover_image);
  if (coverImage && !isHttpUrl(coverImage)) {
    issues.push({ file, message: "cover_image must be an absolute http(s) URL", severity: "error" });
  }

  const published = frontmatter.published;
  if (published !== undefined && typeof published !== "boolean") {
    issues.push({ file, message: "published must be a boolean", severity: "error" });
  }

  const date = stringValue(frontmatter.date);
  if (date && Number.isNaN(Date.parse(date))) {
    issues.push({ file, message: "date must be a valid ISO-8601 string", severity: "error" });
  }

  return { descriptionTooLong };
}

function applyFixes(original: string, frontmatter: string, validation: { descriptionTooLong: boolean }): string {
  let updatedFrontmatter = frontmatter;

  if (validation.descriptionTooLong) {
    updatedFrontmatter = truncateDescription(updatedFrontmatter);
  }

  if (updatedFrontmatter === frontmatter) {
    return original;
  }

  return original.replace(frontmatter, updatedFrontmatter);
}

function truncateDescription(frontmatter: string): string {
  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith("description:")) continue;

    const value = lines[i].slice("description:".length).trim();
    const parsed = parseDescriptionValue(value);
    if (!parsed) return frontmatter;

    const truncated = parsed.length > MAX_DESCRIPTION_LENGTH ? `${parsed.slice(0, MAX_DESCRIPTION_LENGTH - 3)}...` : parsed;
    lines[i] = `description: '${escapeSingleQuotes(truncated)}'`;
    return lines.join("\n");
  }

  return frontmatter;
}

function parseDescriptionValue(value: string): string | null {
  if (!value) return null;
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value;
}

function escapeSingleQuotes(value: string): string {
  return value.replace(/'/g, "''");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function arrayValue(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;

  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (!trimmed) return null;
    result.push(trimmed);
  }

  return result;
}

function hasControlChars(value: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function dedupeIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const unique: Issue[] = [];

  for (const issue of issues) {
    const key = `${issue.file}\0${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(issue);
  }

  return unique;
}
