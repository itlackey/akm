// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Consolidate's defence against three recurring LLM output defects: the whole
 * asset wrapped in a code fence, frontmatter with broken YAML quoting, and a
 * missing closing `---`.
 */

import { parse as yamlParse } from "yaml";
import { assembleAssetFromString, serializeFrontmatter } from "../../../core/asset/asset-serialize";
import { parseFrontmatter } from "../../../core/asset/frontmatter";

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(?:\r\n|\r|\n|$)([\s\S]*)$/;

/**
 * Insert the missing closing `---` before the first blank line or the first
 * line that cannot be YAML (key, indented continuation, comment, list item);
 * `null` when there is no such line.
 */
function recoverMalformedFrontmatter(raw: string): string | null {
  if (!raw.startsWith("---")) return null;
  const lines = raw.split(/\r?\n/);
  const insertAt = lines.findIndex(
    (line, i) =>
      i > 0 &&
      (line.trim() === "" ||
        !(/^\w[\w-]*\s*:/.test(line) || /^\s+\S/.test(line) || /^\s*#/.test(line) || /^\s*-\s/.test(line))),
  );
  if (insertAt < 0) return null;
  return [...lines.slice(0, insertAt), "---", ...lines.slice(insertAt)].join("\n");
}

/**
 * Strip a markdown/yaml/bare code fence wrapping the whole response; `null`
 * when only one half of the pair is present.
 */
export function stripOuterCodeFence(raw: string): { content: string; stripped: boolean } | null {
  const trimmed = raw.trim();
  const leading = trimmed.match(/^```(?:markdown|md|yaml|yml)?\s*\r?\n/i);
  const trailing = trimmed.match(/\r?\n```\s*$/);
  if (!leading && !trailing) return { content: trimmed, stripped: false };
  if (!leading || !trailing) return null;
  return { content: trimmed.slice(leading[0].length, trimmed.length - trailing[0].length).trim(), stripped: true };
}

interface SanitizedMergedContent {
  content: string;
  frontmatter: Record<string, unknown>;
}

/**
 * Model output as an asset: fence stripped, `<think>` removed, frontmatter
 * re-serialized through the YAML library (the lenient parser recovers what the
 * strict one rejects), or a reason it is unusable.
 */
export function sanitizeMergedContent(
  raw: string,
): { ok: true; result: SanitizedMergedContent } | { ok: false; reason: string } {
  let body: string;
  const fenceResult = stripOuterCodeFence(raw);
  if (fenceResult) {
    body = fenceResult.content;
  } else {
    // A leading fence alone is recovered when frontmatter follows; a trailing
    // one alone is more likely a body code block, so it is not.
    const inner = raw
      .trim()
      .match(/^```(?:markdown|md|yaml|yml)?\s*\r?\n([\s\S]*)$/i)?.[1]
      ?.trim();
    if (!inner?.startsWith("---")) return { ok: false, reason: "UNBALANCED_CODE_FENCE" };
    body = inner;
  }
  body = body.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // A line or two of preamble before the frontmatter is tolerated; a `---`
  // further in is more likely a section divider.
  if (!body.startsWith("---")) {
    const nlIdx = body.indexOf("\n---");
    if (nlIdx < 0 || nlIdx >= 300) return { ok: false, reason: "MISSING_FRONTMATTER_SENTINEL" };
    body = body.slice(nlIdx + 1);
  }
  let match = body.match(FRONTMATTER_BLOCK);
  if (!match) {
    const recovered = recoverMalformedFrontmatter(body);
    match = recovered ? recovered.match(FRONTMATTER_BLOCK) : null;
    if (!match) return { ok: false, reason: "MALFORMED_FRONTMATTER_BLOCK" };
  }
  let parsedFm: unknown;
  try {
    parsedFm = yamlParse(match[1]!);
  } catch (e) {
    const fallback = parseFrontmatter(`---\n${match[1]}\n---\n${match[2]}`);
    if (fallback.frontmatter === null || Object.keys(fallback.data).length === 0) {
      return { ok: false, reason: `INVALID_YAML: ${e instanceof Error ? e.message : String(e)}` };
    }
    parsedFm = fallback.data;
  }
  if (parsedFm === null || typeof parsedFm !== "object" || Array.isArray(parsedFm)) {
    return { ok: false, reason: "FRONTMATTER_NOT_OBJECT" };
  }
  const fm = parsedFm as Record<string, unknown>;
  normalizeUpdatedField(fm);
  let serialized: string;
  try {
    serialized = serializeFrontmatter(fm);
  } catch (e) {
    return { ok: false, reason: `YAML_STRINGIFY_FAILED: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, result: { content: assembleAssetFromString(serialized, match[2]!), frontmatter: fm } };
}

/**
 * Normalize a leaked `updated` placeholder in place: a Date becomes
 * `YYYY-MM-DD`; `today`/`now`/`{today}`-style templates and maps like
 * `{today: null}` become today's date; real dates, unknown strings and empty
 * values are left alone (visible in the diff, never invented).
 */
export function normalizeUpdatedField(fm: Record<string, unknown>): void {
  const v = fm.updated;
  if (v === null || v === undefined || v === "") return;
  const todayIso = new Date().toISOString().slice(0, 10);
  if (v instanceof Date) {
    fm.updated = v.toISOString().slice(0, 10);
  } else if (typeof v === "string") {
    const trimmed = v.trim().toLowerCase();
    if (/^\d{4}-\d{2}-\d{2}/.test(v.trim())) return;
    if (
      trimmed === "today" ||
      trimmed === "now" ||
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal "${today}" placeholder a model emits
      trimmed === "${today}" ||
      trimmed === "{{today}}" ||
      /^\{?\s*today\s*\}?$/.test(trimmed)
    ) {
      fm.updated = todayIso;
    }
  } else if (typeof v === "object") {
    fm.updated = todayIso;
  }
}
