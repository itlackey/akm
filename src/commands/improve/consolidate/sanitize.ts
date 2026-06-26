// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// ── LLM-output sanitization ─────────────────────────────────────────────────
//
// Pure string/frontmatter transforms that defend against three classes of LLM
// defect observed across hundreds of consolidate proposals:
//
//   1. Code-fence leakage: the entire merged asset is wrapped in
//      ```markdown … ``` (or ```yaml … ```) despite the prompt forbidding
//      fences. The post-processor used to pass this through verbatim, so the
//      first character of the asset content became a backtick rather than
//      `---`, defeating the frontmatter parser.
//   2. YAML quote-escaping bugs: descriptions like `'"Specialty intro...:`
//      with unbalanced quotes that break the YAML reader. The post-processor
//      historically passed the LLM's raw scalar straight into a manually
//      assembled `description: <raw>` line.
//   3. Truncated descriptions hitting token cutoffs — the model's max_tokens
//      runs out mid-sentence, leaving things like
//      `description: "Tables in narrow column containers need max-width:100% +"`
//      with no closing context.
//
// `sanitizeMergedContent` and `validateProposalFrontmatter` defend against
// all three at the point where LLM output is consumed.

import { parse as yamlParse } from "yaml";
import { assembleAssetFromString, serializeFrontmatter } from "../../../core/asset/asset-serialize";
import { parseFrontmatter } from "../../../core/asset/frontmatter";

/**
 * Attempt to recover a frontmatter block that is missing its closing `---`.
 *
 * Scans lines after the opening `---` for the first blank line or the first
 * line that cannot be a YAML scalar (i.e. not a key-value, indented
 * continuation, comment, or list item). Injects `---` before that line so
 * the normal parser can proceed.
 *
 * Returns the patched string on success, or `null` if the structure is too
 * ambiguous to recover safely (e.g. no opening `---`, or no body content
 * found after the frontmatter key-value lines).
 */
function recoverMalformedFrontmatter(raw: string): string | null {
  if (!raw.startsWith("---")) return null;
  const lines = raw.split(/\r?\n/);
  // Skip the opening `---` line (index 0).
  let insertAt = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // A blank line marks the end of the frontmatter block in many YAML variants.
    if (line.trim() === "") {
      insertAt = i;
      break;
    }
    // A line that is clearly body content: doesn't look like a YAML key, an
    // indented continuation, a comment, or a sequence item.
    const isYaml =
      /^\w[\w-]*\s*:/.test(line) || // key: value
      /^\s+\S/.test(line) || // indented continuation / nested
      /^\s*#/.test(line) || // YAML comment
      /^\s*-\s/.test(line); // sequence item
    if (!isYaml) {
      insertAt = i;
      break;
    }
  }
  if (insertAt < 0) return null;
  const result = [...lines.slice(0, insertAt), "---", ...lines.slice(insertAt)].join("\n");
  return result;
}

/**
 * Outer-fence stripper specific to consolidate. Unlike the shared
 * `stripMarkdownFences` helper (which only handles markdown fences), this
 * variant additionally recognises `yaml` and bare-language fences and refuses
 * to strip an unbalanced fence — i.e. a leading ``` with no trailing ``` is
 * treated as a malformed response, not partially sanitized.
 *
 * Returns `null` when only one half of a fence pair is present (caller
 * should reject the response entirely).
 */
export function stripOuterCodeFence(raw: string): { content: string; stripped: boolean } | null {
  const trimmed = raw.trim();
  const leading = trimmed.match(/^```(?:markdown|md|yaml|yml)?\s*\r?\n/i);
  const trailing = trimmed.match(/\r?\n```\s*$/);
  if (!leading && !trailing) return { content: trimmed, stripped: false };
  if (!leading || !trailing) return null; // unbalanced — refuse
  const inner = trimmed.slice(leading[0].length, trimmed.length - trailing[0].length).trim();
  return { content: inner, stripped: true };
}

/**
 * Sanitize raw LLM output destined to be written as an asset body:
 *   1. Strip outer code fences (rejects unbalanced fences).
 *   2. Verify the remaining payload starts with `---\n` (frontmatter sentinel).
 *   3. Re-serialise the frontmatter via the `yaml` library so any unbalanced
 *      quoting or odd escaping the LLM produced gets normalised. If yaml.parse
 *      throws, return `null` — the response is unusable.
 */
interface SanitizedMergedContent {
  /** Clean markdown with re-serialised frontmatter. */
  content: string;
  /** Parsed frontmatter object (after yaml round-trip). */
  frontmatter: Record<string, unknown>;
}

export function sanitizeMergedContent(
  raw: string,
): { ok: true; result: SanitizedMergedContent } | { ok: false; reason: string } {
  // Step 1: Strip outer code fence.
  // Recovery path: if only the leading fence is present, strip it and continue
  // provided the inner content starts with `---`. Trailing-only fences are NOT
  // recovered — a trailing ``` is more likely a body code block than a forgotten
  // wrapper, so recovering would silently corrupt the body.
  let body: string;
  {
    const fenceResult = stripOuterCodeFence(raw);
    if (fenceResult) {
      body = fenceResult.content;
    } else {
      const trimmed = raw.trim();
      const leadingMatch = trimmed.match(/^```(?:markdown|md|yaml|yml)?\s*\r?\n([\s\S]*)$/i);
      const inner = leadingMatch ? leadingMatch[1].trim() : null;
      if (!inner?.startsWith("---")) {
        return { ok: false, reason: "UNBALANCED_CODE_FENCE" };
      }
      body = inner;
    }
  }

  // Strip <think> blocks (some local models still emit them despite system prompts).
  body = body.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // Step 2: Verify frontmatter sentinel.
  // Recovery path: LLM sometimes emits 1-2 lines of preamble (e.g. "Here is the
  // merged content:") before the `---`. Accept if `---` appears within 300 chars.
  // Beyond that it's more likely a body section divider, not a frontmatter start.
  if (!body.startsWith("---")) {
    const nlIdx = body.indexOf("\n---");
    if (nlIdx >= 0 && nlIdx < 300) {
      body = body.slice(nlIdx + 1);
    } else {
      return { ok: false, reason: "MISSING_FRONTMATTER_SENTINEL" };
    }
  }

  // Extract frontmatter block.
  // Recovery path: LLM sometimes omits the closing `---` delimiter. Detect this
  // by scanning lines after the opening `---` for the first blank line or the
  // first line that isn't a YAML key-value pair, then inject `---` there.
  let match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r\n|\r|\n|$)([\s\S]*)$/);
  if (!match) {
    const recovered = recoverMalformedFrontmatter(body);
    if (recovered) {
      match = recovered.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r\n|\r|\n|$)([\s\S]*)$/);
    }
    if (!match) {
      return { ok: false, reason: "MALFORMED_FRONTMATTER_BLOCK" };
    }
  }

  // Re-parse via the yaml library so any quote-escaping mistakes either get
  // normalised or surface as a parse error we can reject.
  // Recovery: if the strict yaml library fails, fall back to the lenient
  // hand-rolled parseFrontmatter parser, which tolerates common LLM YAML
  // quirks (unescaped special chars, bare scalars, etc.). If it recovers
  // at least one key, proceed — serializeFrontmatter below will re-serialize
  // cleanly. Only reject if both parsers fail to extract any data.
  let parsedFm: unknown;
  try {
    parsedFm = yamlParse(match[1]);
  } catch (e) {
    const fallback = parseFrontmatter(`---\n${match[1]}\n---\n${match[2]}`);
    if (fallback.frontmatter !== null && Object.keys(fallback.data).length > 0) {
      parsedFm = fallback.data;
    } else {
      return { ok: false, reason: `INVALID_YAML: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  if (parsedFm === null || typeof parsedFm !== "object" || Array.isArray(parsedFm)) {
    return { ok: false, reason: "FRONTMATTER_NOT_OBJECT" };
  }
  const fm = parsedFm as Record<string, unknown>;

  // Normalise placeholder leaks like `updated: today`, `updated: {today: null}`,
  // `updated: now`, etc. The consolidate prompt instructs the LLM not to emit
  // these, but small models still do. Replace any such leak with today's ISO
  // date OR drop the field if we can't safely normalise it.
  normalizeUpdatedField(fm);

  // Re-serialise via yaml.stringify to fix any quoting quirks.
  let serialized: string;
  try {
    serialized = serializeFrontmatter(fm);
  } catch (e) {
    return { ok: false, reason: `YAML_STRINGIFY_FAILED: ${e instanceof Error ? e.message : String(e)}` };
  }

  const cleaned = assembleAssetFromString(serialized, match[2]);
  return { ok: true, result: { content: cleaned, frontmatter: fm } };
}

/**
 * Mutate `fm.updated` in place to normalise placeholder leaks emitted by the
 * LLM. The consolidate prompt forbids these, but small models still produce
 * literal `today` / `{today: null}` / `now` values.
 *
 * Rules:
 *   - A real ISO-style date string (YYYY-MM-DD, optionally with time) stays as-is.
 *   - A Date object (some YAML parsers materialise dates) is converted to its
 *     ISO yyyy-mm-dd form.
 *   - A placeholder string ("today", "now", "{today}", "${today}", template
 *     variables) is replaced with today's ISO date.
 *   - A map/object (e.g. `{today: null}`) is replaced with today's ISO date.
 *   - `null`, empty string, missing → left alone (no field added; reviewers
 *     should not silently gain metadata they didn't write).
 *
 * Exported for unit testing.
 */
export function normalizeUpdatedField(fm: Record<string, unknown>): void {
  if (!("updated" in fm)) return;
  const v = fm.updated;
  if (v === null || v === undefined || v === "") return;
  const todayIso = new Date().toISOString().slice(0, 10);
  if (v instanceof Date) {
    fm.updated = v.toISOString().slice(0, 10);
    return;
  }
  if (typeof v === "string") {
    const trimmed = v.trim().toLowerCase();
    if (/^\d{4}-\d{2}-\d{2}/.test(v.trim())) return; // already a real date
    if (
      trimmed === "today" ||
      trimmed === "now" ||
      trimmed === "{today}" ||
      // biome-ignore lint/suspicious/noTemplateCurlyInString: matches the literal user-typed placeholder text "${today}" so we can normalize it to today's ISO date
      trimmed === "${today}" ||
      trimmed === "{{today}}" ||
      /^\{?\s*today\s*\}?$/.test(trimmed)
    ) {
      fm.updated = todayIso;
      return;
    }
    // Unknown string format — leave alone so it's visible in the diff.
    return;
  }
  if (typeof v === "object") {
    // Maps like `{today: null}`, `{now: null}` — clearly a template leak.
    fm.updated = todayIso;
    return;
  }
}
