// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared JSON parsing utilities for LLM and agent output.
 *
 * Lives in `src/core/` so that both `src/llm/` and `src/integrations/agent/`
 * can import without crossing the one-way boundary defined by v1 spec §9.7
 * (agent/ must not import from llm/).
 *
 * The canonical implementation is ported from `src/llm/client.ts` (most
 * complete version):
 *   - Strips `<think>…</think>` reasoning blocks.
 *   - Strips markdown code fences (``` or ~~~, optional language tag, with
 *     trailing spaces on the fence line).
 *   - Escapes unescaped control characters (actual \n, \r, \t bytes) inside
 *     JSON string values so `JSON.parse` succeeds on outputs from local LLMs.
 *   - Balanced-brace scanner handles both `{…}` and `[…]` top-level
 *     structures (spawn.ts v0 only handled `{…}` — that was a bug).
 */

/**
 * Strips `<think>…</think>` blocks from LLM output (for reasoning-capable
 * models). Also strips leading/trailing whitespace.
 */
export function stripThinkBlocks(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * Strips markdown code fences (``` or ~~~, with optional language tag).
 * Handles fences with trailing spaces. Returns trimmed content.
 */
export function stripCodeFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
}

/**
 * Escapes unescaped control characters (actual \n, \r, \t bytes) inside JSON
 * string values. Prevents `JSON.parse` failures from embedded newlines in
 * local-LLM output.
 */
export function escapeJsonStringControls(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Full pipeline: stripThinkBlocks → stripCodeFences → escapeJsonStringControls
 * → JSON.parse. Returns `undefined` on parse failure.
 */
export function parseJsonResponse<T = unknown>(raw: string): T | undefined {
  try {
    const cleaned = escapeJsonStringControls(stripCodeFences(stripThinkBlocks(raw)));
    return JSON.parse(cleaned) as T;
  } catch {
    return undefined;
  }
}

/** Options for {@link parseEmbeddedJsonResponse}. */
export interface ParseEmbeddedJsonOptions {
  /**
   * Which top-level shape the caller expects.
   *
   * - `"any"` (default): object-preferring. A `{…}` object found first is
   *   returned immediately; arrays are only a fallback. Preserves the
   *   historical behaviour for the many object-expecting callers.
   * - `"array"`: array-preferring. Only top-level `[…]` arrays are returned;
   *   leading/example `{…}` objects are ignored. Use this for callers that
   *   expect a JSON array (e.g. batched graph extraction, #635) so a stray
   *   object before the array no longer masks a valid array as "non-array".
   */
  expect?: "any" | "array";
}

/**
 * Attempts `parseJsonResponse` first. On failure, scans for the first
 * balanced `{ }` or `[ ]` structure in the text and attempts to parse that
 * substring. Returns `undefined` if no valid JSON structure is found.
 *
 * Shape preference is controlled by {@link ParseEmbeddedJsonOptions.expect}:
 * - `"any"` (default): non-array results are preferred — a `{…}` object found
 *   first is returned immediately; arrays (`[…]`) are a fallback.
 * - `"array"`: only top-level arrays are returned. The direct parse is
 *   accepted only if it is an array, and the scanner returns the first
 *   balanced `[…]` while skipping `{…}` openers entirely.
 */
export function parseEmbeddedJsonResponse<T = unknown>(raw: string, options?: ParseEmbeddedJsonOptions): T | undefined {
  const expectArray = options?.expect === "array";

  const direct = parseJsonResponse<T>(raw);
  if (direct !== undefined && (!expectArray || Array.isArray(direct))) return direct;

  const text = escapeJsonStringControls(stripCodeFences(stripThinkBlocks(raw)));
  let arrayFallback: T | undefined;

  // Scan only *top-level* balanced structures: once a `{…}`/`[…]` is matched we
  // jump `start` past its closing bracket rather than re-scanning its interior.
  // This keeps array mode from salvaging an array *nested inside* a leading
  // object (e.g. the `entities` array of a bare `{entities,relations}` object).
  for (let start = 0; start < text.length; start++) {
    const opener = text[start];
    if (opener !== "{" && opener !== "[") continue;

    const closer = opener === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === opener) depth += 1;
      if (ch === closer) {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (end === -1) continue; // never balanced — let the next opener try

    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as T;
      if (Array.isArray(parsed)) {
        // First valid array wins in array mode; in "any" mode it is the
        // fallback returned only if no object is found.
        if (expectArray) return parsed;
        arrayFallback ??= parsed;
      } else if (!expectArray) {
        return parsed;
      }
      // Skip past this balanced structure so we don't descend into it.
      start = end;
    } catch {
      // Malformed candidate — advance one char and try the next opener.
    }
  }

  return arrayFallback;
}
