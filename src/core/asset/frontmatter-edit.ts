// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reading a file's frontmatter as keys and values, and changing keys in it (set or remove) while every other byte stays as
 * written: untouched keys keep their order, quoting, comments and line endings, and the body is not touched. A change that
 * cannot be made that way is refused, never approximated.
 */

import { isDeepStrictEqual } from "node:util";
import { parseDocument, parse as parseYaml } from "yaml";
import { UsageError } from "../errors";
import { serializeFrontmatter } from "./asset-serialize";
import { parseFrontmatterBlock } from "./frontmatter";

export interface FrontmatterChange {
  key: string;
  /** The new value; the key is set to it. */
  value?: unknown;
  /** Remove the key. */
  remove?: true;
}

export interface FrontmatterReading {
  /** Whether the text starts with a frontmatter block. */
  present: boolean;
  /** Where the body starts in the text: after the closing fence, or 0 when there is no block. */
  bodyStart: number;
  /** The keys in file order with their values. Empty when the block is absent or does not parse. */
  entries: Array<{ key: string; value: unknown }>;
  /** Why the block does not parse, with its line in the file when the parser gives one. */
  error?: { reason: string; line?: number };
}

const KEY_RE = /^\w[\w-]*$/;
const KEY_LINE_RE = /^(\w[\w-]*):(?:[ \t]|$)/;
const MALFORMED = "AKM Markdown has malformed YAML frontmatter.";

function strictMapping(block: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = block.trim() ? parseYaml(block) : {};
  } catch {
    throw new UsageError(MALFORMED, "INVALID_FLAG_VALUE");
  }
  if (parsed === null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed))
    throw new UsageError("AKM Markdown frontmatter must be a YAML mapping.", "INVALID_FLAG_VALUE");
  return parsed as Record<string, unknown>;
}

/** The frontmatter of `content` as the strict YAML parser reads it, the way a write of the file would. */
export function readFrontmatter(content: string): FrontmatterReading {
  const block = parseFrontmatterBlock(content);
  if (!block) return { present: false, bodyStart: 0, entries: [] };
  const bodyStart = content.length - block.content.length;
  try {
    return {
      present: true,
      bodyStart,
      entries: Object.entries(strictMapping(block.frontmatter)).map(([key, value]) => ({ key, value })),
    };
  } catch (error) {
    const line = parseDocument(block.frontmatter).errors[0]?.linePos?.[0]?.line;
    return {
      present: true,
      bodyStart,
      entries: [],
      error: {
        reason: error instanceof Error ? error.message : String(error),
        ...(line === undefined ? {} : { line: line + 1 }),
      },
    };
  }
}

/** The lines of a key's block in `parts` (alternating line and line ending): its `key:` line and the lines that continue it. */
function keyBlock(parts: string[], closeAt: number, key: string): { start: number; end: number } | undefined {
  for (let i = 2; i < closeAt; i += 2) {
    if (parts[i]?.match(KEY_LINE_RE)?.[1] !== key) continue;
    let end = i + 2;
    while (end < closeAt && /^(?:[ \t]+\S|-(?:[ \t]|$))/.test(parts[end] as string)) end += 2;
    return { start: i, end };
  }
  return undefined;
}

const withEnds = (lines: string[], eol: string): string[] => lines.flatMap((line) => [line, eol]);

/** `content` with the changes applied to its frontmatter, and nothing else changed. */
export function changeFrontmatter(content: string, changes: readonly FrontmatterChange[]): string {
  for (const change of changes) {
    if (!KEY_RE.test(change.key))
      throw new UsageError(`"${change.key}" is not a frontmatter key akm can edit as a field.`);
    if ((change.remove === true) === "value" in change)
      throw new UsageError(`Change "${change.key}" by setting a value or removing it, not both or neither.`);
  }
  const block = parseFrontmatterBlock(content);
  const intended = block ? { ...strictMapping(block.frontmatter) } : {};
  for (const change of changes) {
    if (change.remove) delete intended[change.key];
    else intended[change.key] = change.value;
  }
  if (!block) {
    const sets = changes.filter((change) => !change.remove);
    if (sets.length === 0) return content;
    return `---\n${serializeFrontmatter(Object.fromEntries(sets.map((change) => [change.key, change.value])))}\n---\n${content}`;
  }

  const parts = content.split(/(\r?\n)/);
  const eol = parts[1] ?? "\n";
  const current = strictMapping(block.frontmatter);
  for (const change of changes) {
    const closeAt = parts.findIndex((part, i) => i > 0 && part.trim() === "---");
    const found = keyBlock(parts, closeAt, change.key);
    if (change.remove) {
      if (found) parts.splice(found.start, found.end - found.start);
      continue;
    }
    if (found && isDeepStrictEqual(current[change.key], change.value)) continue;
    const lines = withEnds(serializeFrontmatter({ [change.key]: change.value }).split("\n"), eol);
    if (found) parts.splice(found.start, found.end - found.start, ...lines);
    else parts.splice(closeAt, 0, ...lines);
    current[change.key] = change.value;
  }
  const result = parts.join("");
  const written = parseFrontmatterBlock(result);
  let reread: Record<string, unknown> | undefined;
  try {
    reread = written ? strictMapping(written.frontmatter) : undefined;
  } catch {
    reread = undefined;
  }
  if (!isDeepStrictEqual(reread, intended))
    throw new UsageError("These changes cannot be made to the frontmatter as written; edit its text instead.");
  return result;
}
