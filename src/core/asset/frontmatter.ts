// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared frontmatter parsing utilities.
 *
 * Uses the `yaml` library for all YAML parsing so that the full YAML spec
 * (block scalars, multi-line strings, nested objects, flow sequences, escape
 * sequences) is handled correctly without a brittle hand-rolled state machine.
 */

import fs from "node:fs";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { assembleAsset } from "./asset-serialize";

/**
 * Sub-signal breakdown produced by `scoreEncodingSalience` in encoding-salience.ts.
 * Mirrored here to avoid a core → commands import. Keep in sync with
 * `EncodingSalienceResult` in `src/commands/improve/encoding-salience.ts`.
 */
export interface SalienceSubSignals {
  novelty: number;
  magnitude: number;
  predictionError: number;
}

/**
 * Parse YAML frontmatter from a Markdown (or similar) string.
 *
 * Returns the parsed key-value data and the remaining body content.
 * Delegates all YAML parsing to the `yaml` library; the only responsibility
 * of this function is extracting the `---…---` block and normalizing the
 * parsed result (e.g. converting YAML timestamp values to ISO date strings).
 */
export function parseFrontmatter(raw: string): {
  data: Record<string, unknown>;
  content: string;
  frontmatter: string | null;
  bodyStartLine: number;
} {
  const parsedBlock = parseFrontmatterBlock(raw);
  if (!parsedBlock) {
    return { data: {}, content: raw, frontmatter: null, bodyStartLine: 1 };
  }

  let data: Record<string, unknown> = {};
  if (parsedBlock.frontmatter.trim()) {
    try {
      const parsed = yamlParse(parsedBlock.frontmatter) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        // Normalize Date objects: the yaml "core" schema parses YYYY-MM-DD
        // literals as JS Date instances. Convert them back to ISO date strings
        // to preserve the string type that callers (and yaml.stringify on write)
        // expect.
        data = normalizeYamlValues(parsed as Record<string, unknown>) as Record<string, unknown>;
      }
    } catch {
      // Malformed YAML (e.g. unterminated quotes from LLM output corruption).
      // Fall back to line-by-line best-effort extraction so callers still get
      // whatever scalar values they can rather than a completely empty record.
      data = parseFrontmatterLenient(parsedBlock.frontmatter);
    }
  }

  return {
    data,
    content: parsedBlock.content,
    frontmatter: parsedBlock.frontmatter,
    bodyStartLine: parsedBlock.bodyStartLine,
  };
}

/**
 * Normalize YAML-parsed values to match expected AKM frontmatter types.
 *
 * Two conversions:
 * 1. `Date` → YYYY-MM-DD string: the yaml "core" schema parses bare date
 *    scalars like `2026-06-18` as JS Date instances. AKM frontmatter treats
 *    `updated:` and similar fields as plain strings.
 * 2. `null` → `""`: the yaml library parses empty-value keys (`key:` with no
 *    value) as `null`, but AKM callers historically received `""` from the
 *    hand-rolled parser. Convert to preserve backward compatibility.
 */
function normalizeYamlValues(value: unknown): unknown {
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (value === null) return "";
  if (Array.isArray(value)) return value.map(normalizeYamlValues);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeYamlValues(v)]),
    );
  }
  return value;
}

/**
 * Best-effort line-by-line frontmatter extraction for malformed YAML.
 *
 * Used as a fallback when yaml.parse throws (e.g. unterminated quotes from LLM
 * output corruption). Extracts simple `key: value` scalar pairs only — nested
 * objects and sequences are skipped. Values that are individually parseable by
 * yaml are normalized; otherwise stored as raw strings.
 */
function parseFrontmatterLenient(frontmatter: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const m = line.match(/^([\w][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rawValue = (m[2] ?? "").trim();
    try {
      const singleEntry = yamlParse(`k: ${rawValue}`) as unknown;
      if (singleEntry !== null && typeof singleEntry === "object" && !Array.isArray(singleEntry)) {
        const v = (singleEntry as Record<string, unknown>).k;
        data[key] = v === null || v === undefined ? "" : v;
      } else {
        data[key] = rawValue;
      }
    } catch {
      data[key] = rawValue;
    }
  }
  return data;
}

/**
 * Read a file, parse its frontmatter, let `mutator` compute the next
 * frontmatter object, and write the reassembled asset back to disk.
 *
 * This is the shared read→parse→mutate→write primitive. The `mutator` receives
 * the parsed result and returns either the next frontmatter object (to write)
 * or `null` to skip the write entirely (e.g. for idempotent no-ops). The body
 * content is preserved from the parse.
 *
 * @returns `true` if a write occurred, `false` if the mutator returned `null`.
 */
export function mutateFrontmatter(
  filePath: string,
  mutator: (parsed: ReturnType<typeof parseFrontmatter>) => Record<string, unknown> | null,
): boolean {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(raw);
  const nextFrontmatter = mutator(parsed);
  if (nextFrontmatter === null) return false;
  fs.writeFileSync(filePath, assembleAsset(nextFrontmatter, parsed.content), "utf8");
  return true;
}

export function parseFrontmatterBlock(
  raw: string,
): { frontmatter: string; content: string; bodyStartLine: number } | null {
  // Handle both LF and CRLF line endings throughout.
  // The closing --- may be preceded by \r\n; capture and strip trailing \r
  // from the frontmatter block so key parsing sees clean LF-terminated lines.
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r\n|\r|\n|$)([\s\S]*)$/);
  if (match) {
    // Strip any \r characters from the frontmatter block to normalise CRLF → LF
    const frontmatter = match[1].replace(/\r/g, "");
    const content = match[2];
    return {
      frontmatter,
      content,
      bodyStartLine: countLines(raw.slice(0, match[0].length - match[2].length)) + 1,
    };
  }
  // Empty frontmatter (---\n---): the content-bearing regex above requires at
  // least one character between the fences. Handle the degenerate case so
  // callers can reconstruct `---\nkey: val\n---\n\nbody` from a previously
  // empty-frontmatter file without corrupting it by wrapping the entire raw
  // string as body content.
  const emptyMatch = raw.match(/^---\r?\n---(?:\r\n|\r|\n)([\s\S]*)$/);
  if (emptyMatch) {
    return { frontmatter: "", content: emptyMatch[1], bodyStartLine: 3 };
  }
  return null;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length - 1;
}

/**
 * Parse a YAML scalar value (string, boolean, or number).
 *
 * For quoted strings (single or double), delegates to the `yaml` library so
 * escape sequences are handled correctly per spec. The previous hand-rolled
 * `slice(1, -1)` only stripped one layer of quoting and left inner quotes and
 * escape sequences as literal characters in the stored value, causing visible
 * corruption when `yaml.stringify` re-quoted them on the next write.
 */
export function parseYamlScalar(value: string): unknown {
  if (value === "") return "";
  if (value === "true") return true;
  if (value === "false") return false;
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber)) return asNumber;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      const parsed = yamlParse(value) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      // Fall through to raw slice on malformed YAML — better than throwing.
    }
    return value.slice(1, -1);
  }
  return value;
}

// ── Minimum score delta to trigger a frontmatter salience rewrite ─────────────
const SALIENCE_WRITE_DELTA_THRESHOLD = 0.05;

/**
 * Idempotently write `salience` and `salienceInputs` fields into the YAML
 * frontmatter of a raw asset string.
 *
 * Skips the write when the existing `salience` field differs from `score` by
 * less than {@link SALIENCE_WRITE_DELTA_THRESHOLD}, to avoid churn for minor
 * floating-point drift. Returns the raw string unchanged when no write is needed
 * or when no frontmatter block is present.
 *
 * The `salienceInputs` field is written for auditability only; no pipeline code
 * reads it back. `state.db :: asset_salience` is the canonical store.
 */
export function writeSalienceToFrontmatter(raw: string, score: number, inputs: SalienceSubSignals): string {
  const parsed = parseFrontmatterBlock(raw);
  if (!parsed) return raw;

  const existingData = parseFrontmatter(raw).data;
  const existingSalience = typeof existingData.salience === "number" ? existingData.salience : undefined;

  if (existingSalience !== undefined && Math.abs(existingSalience - score) < SALIENCE_WRITE_DELTA_THRESHOLD) {
    return raw;
  }

  // Parse existing frontmatter into an object, then set/overwrite salience fields.
  let fm: Record<string, unknown> = {};
  if (parsed.frontmatter.trim()) {
    try {
      const p = yamlParse(parsed.frontmatter) as unknown;
      if (p !== null && typeof p === "object" && !Array.isArray(p)) {
        fm = p as Record<string, unknown>;
      }
    } catch {
      // Malformed YAML — rebuild from best-effort parse
      fm = parseFrontmatterLenient(parsed.frontmatter);
    }
  }

  fm.salience = roundTo2dp(score);
  fm.salienceInputs = {
    novelty: roundTo2dp(inputs.novelty),
    magnitude: roundTo2dp(inputs.magnitude),
    predictionError: roundTo2dp(inputs.predictionError),
  };

  const newFrontmatter = yamlStringify(fm).trimEnd();
  const body = parsed.content;
  // Preserve original line ending style between frontmatter and body
  const separator = body.startsWith("\n") ? "" : "\n";
  return `---\n${newFrontmatter}\n---\n${separator}${body}`;
}

function roundTo2dp(n: number): number {
  return Math.round(n * 100) / 100;
}
