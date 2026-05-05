#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseDocument } from "yaml";
import { parseFrontmatterBlock } from "../src/core/frontmatter";

const MAX_DESCRIPTION_LENGTH = 160;

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write("Usage: bun scripts/publish-devto.ts <file...>\n");
  process.exit(2);
}

let changed = false;
const normalizedFiles = files.map((file) => path.resolve(file));

for (const file of normalizedFiles) {
  const original = fs.readFileSync(file, "utf8");
  const normalized = normalizePostText(original);

  const block = parseFrontmatterBlock(normalized);
  if (!block) {
    throw new Error(`${path.relative(process.cwd(), file)}: missing valid frontmatter delimiters`);
  }

  const doc = parseDocument(block.frontmatter, { prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new Error(`${path.relative(process.cwd(), file)}: ${doc.errors[0]?.message ?? "invalid frontmatter"}`);
  }

  const frontmatter = (doc.toJSON() ?? {}) as Record<string, unknown>;
  const validation = validateFrontmatter(file, frontmatter);
  const updated = applyFixes(normalized, block.frontmatter, validation);

  if (updated !== original) {
    fs.writeFileSync(file, updated, "utf8");
    changed = true;
  }
}

const publish = spawnSync(
  "npx",
  [
    "-y",
    "@sinedied/devto-cli",
    "push",
    ...normalizedFiles,
    "--token",
    process.env.DEVTO_TOKEN ?? "",
    "--repo",
    process.env.GITHUB_REPOSITORY ?? "",
    "--branch",
    process.env.GITHUB_REF_NAME ?? "main",
    "--reconcile",
  ],
  { encoding: "utf8", stdio: "pipe" },
);

if (publish.stdout) process.stdout.write(publish.stdout);
if (publish.stderr) process.stderr.write(publish.stderr);

process.exit(publish.status ?? 1);

function normalizePostText(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200D\u2060\u00AD]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .normalize("NFC");
}

function validateFrontmatter(file: string, frontmatter: Record<string, unknown>): { descriptionTooLong: boolean } {
  const title = stringValue(frontmatter.title);
  const description = stringValue(frontmatter.description);
  const tags = arrayValue(frontmatter.tags);
  const prefix = `${path.relative(process.cwd(), file)}:`;

  if (!title) throw new Error(`${prefix} missing required 'title'`);
  if (!description) throw new Error(`${prefix} missing required 'description'`);
  if (!tags) throw new Error(`${prefix} missing required 'tags' array`);

  if (title.length > 100) throw new Error(`${prefix} title exceeds 100 characters`);
  if (tags.length > 4) throw new Error(`${prefix} tags array exceeds DEV.to's 4-tag limit`);
  if (description.length > MAX_DESCRIPTION_LENGTH) return { descriptionTooLong: true };

  return { descriptionTooLong: false };
}

function applyFixes(original: string, frontmatter: string, validation: { descriptionTooLong: boolean }): string {
  if (!validation.descriptionTooLong) return original;

  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith("description:")) continue;

    const value = lines[i].slice("description:".length).trim();
    const parsed = parseDescriptionValue(value);
    if (!parsed) return original;

    const truncated = parsed.length > MAX_DESCRIPTION_LENGTH ? `${parsed.slice(0, MAX_DESCRIPTION_LENGTH - 3)}...` : parsed;
    lines[i] = `description: '${escapeSingleQuotes(truncated)}'`;
    return original.replace(frontmatter, lines.join("\n"));
  }

  return original;
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
