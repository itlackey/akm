// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AssetParameter, StashEntryScope, StashIntent } from "../../core/adapter/types";
import { normalizeScopeObject, SCOPE_KEYS } from "./entry-normalize";

/**
 * Extract structured parameters from a command template containing
 * `$ARGUMENTS`, `$1`-`$9`, or `{{named}}` placeholders.
 */
export function extractCommandParameters(template: string): AssetParameter[] | undefined {
  const params: AssetParameter[] = [];
  const add = (name: string) => {
    if (!params.some((p) => p.name === name)) params.push({ name });
  };

  if (/\$ARGUMENTS\b/.test(template)) params.push({ name: "ARGUMENTS" });
  for (const match of template.matchAll(/\$([1-9])(?!\d)/g)) add(`$${match[1]}`);
  for (const match of template.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g)) add(match[1]!);

  return params.length > 0 ? params : undefined;
}

/**
 * Extract `@param` JSDoc tags from a script file's leading comment block.
 *
 * Supports both JSDoc-style (`/** ... * /`) and hash-style (`# @param ...`)
 * comments. Optionally captures `{type}` annotations.
 */
export function extractScriptParameters(content: string): AssetParameter[] | undefined {
  const lines = content.split(/\r?\n/).slice(0, 50);
  const params: AssetParameter[] = [];

  // Match @param lines in any comment style:
  // JSDoc:  * @param {string} name - description
  // JSDoc:  * @param name - description
  // Hash:   # @param name - description
  const paramRegex = /^[\s/*#;-]*@param\s+(?:\{([^}]+)\}\s+)?(\w+)(?:\s+-\s+(.+))?/;

  for (const line of lines) {
    const match = line.match(paramRegex);
    if (match) {
      const param: AssetParameter = { name: match[2]! };
      if (match[1]) param.type = match[1].trim();
      if (match[3]) param.description = match[3].trim();
      params.push(param);
    }
  }

  return params.length > 0 ? params : undefined;
}

/**
 * Extract parameters from frontmatter `params:` key.
 *
 * The frontmatter parser produces a nested object for `params:` like:
 * ```
 * { region: "AWS region to deploy to", instance_type: "EC2 instance type" }
 * ```
 */
export function extractFrontmatterParameters(fmData: Record<string, unknown>): AssetParameter[] | undefined {
  const paramsRaw = fmData.params;
  if (typeof paramsRaw !== "object" || paramsRaw === null || Array.isArray(paramsRaw)) return undefined;

  const paramsObj = paramsRaw as Record<string, unknown>;
  const params: AssetParameter[] = [];

  for (const [key, value] of Object.entries(paramsObj)) {
    const param: AssetParameter = { name: key };
    if (typeof value === "string" && value.trim()) {
      param.description = value.trim();
    }
    params.push(param);
  }

  return params.length > 0 ? params : undefined;
}

/**
 * Merge two parameter lists, deduplicating by name.
 * Parameters from `additional` are appended only if their name is not already present.
 */
export function mergeParameters(
  existing: AssetParameter[] | undefined,
  additional: AssetParameter[] | undefined,
): AssetParameter[] | undefined {
  if (!additional || additional.length === 0) return existing;
  if (!existing || existing.length === 0) return additional;

  const names = new Set(existing.map((p) => p.name));
  const merged = [...existing];
  for (const param of additional) {
    if (!names.has(param.name)) {
      merged.push(param);
      names.add(param.name);
    }
  }
  return merged;
}

export interface CommentMetadata {
  description?: string;
  tags?: string[];
  aliases?: string[];
  searchHints?: string[];
  usage?: string[];
  examples?: string[];
  intent?: StashIntent;
  run?: string;
  setup?: string;
  cwd?: string;
  scope?: StashEntryScope;
}

function splitCommentList(raw: string): string[] {
  return raw
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseCommentScope(raw: string): StashEntryScope | undefined {
  const scopeRaw: Record<string, unknown> = {};
  for (const pair of splitCommentList(raw)) {
    const [keyPart, ...valueParts] = pair.split("=");
    const key = keyPart?.trim();
    const value = valueParts.join("=").trim();
    if (!key || !value) continue;
    if ((SCOPE_KEYS as readonly string[]).includes(key)) {
      scopeRaw[key] = value;
    }
  }
  return normalizeScopeObject(scopeRaw);
}

function parseIntentCommentLine(cleaned: string, metadata: CommentMetadata): boolean {
  const intentMatch = cleaned.match(/^@intent(?:\.(when|input|output))?\s+(.+)$/);
  if (!intentMatch) return false;
  metadata.intent ??= {};
  const value = intentMatch[2]!.trim();
  const key = intentMatch[1];
  if (key === "when") metadata.intent.when = value;
  else if (key === "input") metadata.intent.input = value;
  else if (key === "output") metadata.intent.output = value;
  else metadata.intent.when ??= value;
  return true;
}

/** `@tag value` comment lines, in match order; the first matching tag wins a line. */
const COMMENT_TAGS: ReadonlyArray<readonly [RegExp, (metadata: CommentMetadata, value: string) => void]> = [
  [/^@description\s+(.+)$/, (m, v) => (m.description = v.trim())],
  [/^@tags?\s+(.+)$/, (m, v) => (m.tags = splitCommentList(v))],
  [/^@aliases?\s+(.+)$/, (m, v) => (m.aliases = splitCommentList(v))],
  [/^@searchHints?\s+(.+)$/, (m, v) => (m.searchHints = splitCommentList(v))],
  [/^@usage\s+(.+)$/, (m, v) => (m.usage = [...(m.usage ?? []), v.trim()])],
  [/^@examples?\s+(.+)$/, (m, v) => (m.examples = [...(m.examples ?? []), v.trim()])],
  [/^@run\s+(.+)$/, (m, v) => (m.run = v.trim())],
  [/^@setup\s+(.+)$/, (m, v) => (m.setup = v.trim())],
  [/^@cwd\s+(.+)$/, (m, v) => (m.cwd = v.trim())],
  [
    /^@scope\s+(.+)$/,
    (m, v) => {
      const scope = parseCommentScope(v);
      if (scope) m.scope = scope;
    },
  ],
];

export function extractCommentMetadata(content: string): CommentMetadata | undefined {
  const lines = content.split(/\r?\n/).slice(0, 50);
  const metadata: CommentMetadata = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!/^(?:\/\/|#|\/?\*|;|--)/.test(trimmed) && !trimmed.startsWith("'")) continue;

    const cleaned = trimmed
      .replace(/^(?:\/\/|##?|\/?\*\*?\/?|;|--|'?)\s*/, "")
      .replace(/\*\/\s*$/, "")
      .trim();
    if (!cleaned) continue;

    if (parseIntentCommentLine(cleaned, metadata)) continue;
    for (const [pattern, apply] of COMMENT_TAGS) {
      const match = cleaned.match(pattern);
      if (match) {
        apply(metadata, match[1]!);
        break;
      }
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}
