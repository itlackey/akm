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

import { createHash } from "node:crypto";
import fs from "node:fs";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { existingFileMode, writeFileAtomic } from "../common";
import { recordWrittenPath } from "../write-provenance";
import { assembleAsset, serializeFrontmatter } from "./asset-serialize";

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
 * Normalize YAML dates to match expected AKM frontmatter types.
 *
 * `Date` → YYYY-MM-DD string: the yaml "core" schema parses bare date
 *    scalars like `2026-06-18` as JS Date instances. AKM frontmatter treats
 *    `updated:` and similar fields as plain strings.
 */
function normalizeYamlValues(value: unknown): unknown {
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (Array.isArray(value)) return value.map(normalizeYamlValues);
  if (value !== null && typeof value === "object") {
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
    const key = m[1]!;
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
 * A frontmatter mutation is a METADATA edit, not a content edit: when the file
 * already has a frontmatter block, only that block is replaced and the body
 * bytes are kept verbatim (routing through `assembleAsset` would strip the
 * body's leading blank lines and force a trailing newline, silently reshaping
 * assets whose writer used a different separator style). A file gaining its
 * FIRST frontmatter block goes through the canonical `assembleAsset` shape.
 *
 * @returns `true` if a write occurred, `false` if the mutator returned `null`.
 */
export function mutateFrontmatter(
  filePath: string,
  mutator: (parsed: ReturnType<typeof parseFrontmatter>) => Record<string, unknown> | null,
): boolean {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(raw);
  if (parsed.frontmatter?.trim()) {
    let strict: unknown;
    try {
      strict = yamlParse(parsed.frontmatter);
    } catch {
      throw new Error(`Cannot mutate malformed YAML frontmatter in ${filePath}.`);
    }
    if (strict === null || typeof strict !== "object" || Array.isArray(strict)) {
      throw new Error(`Cannot mutate non-mapping YAML frontmatter in ${filePath}.`);
    }
  }
  const nextFrontmatter = mutator(parsed);
  if (nextFrontmatter === null) return false;
  const next =
    parsed.frontmatter !== null
      ? `---\n${serializeFrontmatter(nextFrontmatter)}\n---\n${parsed.content}`
      : assembleAsset(nextFrontmatter, parsed.content);
  // Atomic, like the canonical asset write: this rewrites a file the user
  // authored, and a truncate-in-place left a window where a crash or a
  // concurrent reader saw a half-written or empty asset. The existing mode is
  // preserved so stamping frontmatter never changes an asset's permissions.
  writeFileAtomic(filePath, next, existingFileMode(filePath));
  // #652: in-place frontmatter stamps (belief state, contradiction markers,
  // salience) are real asset mutations — journal them for the run's sync.
  recordWrittenPath(filePath);
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
    const frontmatter = match[1]!.replace(/\r/g, "");
    const content = match[2]!;
    return {
      frontmatter,
      content,
      bodyStartLine: countLines(raw.slice(0, match[0]!.length - content.length)) + 1,
    };
  }
  // Empty frontmatter (---\n---): the content-bearing regex above requires at
  // least one character between the fences. Handle the degenerate case so
  // callers can reconstruct `---\nkey: val\n---\n\nbody` from a previously
  // empty-frontmatter file without corrupting it by wrapping the entire raw
  // string as body content.
  const emptyMatch = raw.match(/^---\r?\n---(?:\r\n|\r|\n)([\s\S]*)$/);
  if (emptyMatch) {
    return { frontmatter: "", content: emptyMatch[1]!, bodyStartLine: 3 };
  }
  return null;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length - 1;
}

/**
 * Insert one `key: value` line just before the closing `---` of an existing
 * frontmatter block, leaving every other byte — YAML comments, quoting, key
 * order, line endings — untouched. Returns null when `raw` has no well-formed
 * block, so callers can fall back to a parse-and-serialize path.
 *
 * This is the source-preserving way to ADD a field to user-authored
 * frontmatter: round-tripping the mapping through the YAML serializer drops
 * comments and normalizes formatting, which is unacceptable for a write that
 * only needs to contribute one line. Shared by `ensureAkmMarkdownType`
 * (stamping `updated:` on write) and lint's `--fix` for `missing-updated`.
 */
export function spliceFrontmatterLine(raw: string, line: string): string | null {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx === -1) return null;
  lines.splice(closeIdx, 0, line);
  return lines.join("\n");
}

/**
 * Strip one layer of matching quotes — frontmatter list items are often quoted
 * refs. Written as an explicit char compare rather than a backreference regex
 * on purpose: `scripts/lint-repository-sql.ts`'s comment/string stripper has no
 * regex-literal awareness, so a literal holding an ODD number of quote
 * characters desyncs its state machine and corrupts every match after it.
 */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  if ((first === '"' || first === "'") && trimmed[trimmed.length - 1] === first) return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * Remove specific VALUES from one frontmatter list key, preserving every other
 * byte — the counterpart to {@link spliceFrontmatterLine} for the
 * `akm lint --prune-dangling-edges` repair (#884).
 *
 * Handles the three spellings a belief channel appears in: a block sequence
 * (`contradictedBy:\n  - a`), an inline flow (`contradictedBy: [a, b]`), and a
 * bare scalar (`contradictedBy: a`). When every value under the key is removed
 * the key itself goes too — an empty `contradictedBy: []` is not the same
 * assertion as no edge at all.
 *
 * Returns the rewritten source, or `null` when `raw` has no well-formed
 * frontmatter block or nothing matched, so the caller can leave the file
 * untouched and report the finding unfixed. Deliberately source-preserving:
 * these are user-authored memories, and a repair must not silently reformat
 * the frontmatter it was not asked to touch.
 */
export function removeFrontmatterListValues(raw: string, key: string, values: readonly string[]): string | null {
  const remove = new Set(values.map((v) => unquote(v)));
  if (remove.size === 0) return null;

  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx === -1) return null;

  const out: string[] = [];
  let changed = false;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    if (index === 0 || index >= closeIdx) {
      out.push(line);
      index += 1;
      continue;
    }

    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv === null || kv[1] !== key) {
      out.push(line);
      index += 1;
      continue;
    }

    const rest = kv[2]!.trim();

    // Inline flow: contradictedBy: [a, b]
    const flow = rest.match(/^\[(.*)\]$/);
    if (flow !== null) {
      const kept = flow[1]!
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .filter((item) => !remove.has(unquote(item)));
      const original = flow[1]!.split(",").filter((s) => s.trim().length > 0).length;
      if (kept.length !== original) {
        changed = true;
        if (kept.length > 0) out.push(`${key}: [${kept.join(", ")}]`);
      } else {
        out.push(line);
      }
      index += 1;
      continue;
    }

    // Bare scalar: contradictedBy: a
    if (rest !== "") {
      if (remove.has(unquote(rest))) changed = true;
      else out.push(line);
      index += 1;
      continue;
    }

    // Block sequence: the key line, then `  - value` items.
    const header = line;
    const items: string[] = [];
    let cursor = index + 1;
    while (cursor < closeIdx) {
      const itemMatch = lines[cursor]!.match(/^\s+-\s*(.*)$/);
      if (itemMatch === null) break;
      items.push(lines[cursor]!);
      cursor += 1;
    }
    const kept = items.filter((item) => !remove.has(unquote(item.replace(/^\s*-\s*/, ""))));
    if (kept.length !== items.length) {
      changed = true;
      if (kept.length > 0) {
        out.push(header);
        out.push(...kept);
      }
    } else {
      out.push(header);
      out.push(...items);
    }
    index = cursor;
  }

  return changed ? out.join("\n") : null;
}

/**
 * Rewrite specific VALUES in one frontmatter list key to new spellings,
 * preserving every other byte — the rename counterpart to
 * {@link removeFrontmatterListValues}, used by `akm lint --fix` to migrate
 * retired `type:slug` xref values (`xrefs:`/`supersededBy:`/`contradictedBy:`)
 * to their conceptId form once resolution confirms the rewritten spelling
 * still points at a real asset.
 *
 * Handles the same three spellings a belief channel appears in: a block
 * sequence, an inline flow, and a bare scalar. `replacements` maps an
 * unquoted OLD value to its NEW value; a value not present in the map is left
 * untouched byte-for-byte (including any quoting it had).
 *
 * Returns the rewritten source, or `null` when `raw` has no well-formed
 * frontmatter block or nothing matched, so the caller can leave the file
 * untouched. Deliberately source-preserving, like its sibling.
 */
export function rewriteFrontmatterListValue(
  raw: string,
  key: string,
  replacements: ReadonlyMap<string, string>,
): string | null {
  if (replacements.size === 0) return null;

  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx === -1) return null;

  const out: string[] = [];
  let changed = false;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    if (index === 0 || index >= closeIdx) {
      out.push(line);
      index += 1;
      continue;
    }

    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv === null || kv[1] !== key) {
      out.push(line);
      index += 1;
      continue;
    }

    const rest = kv[2]!.trim();

    // Inline flow: xrefs: [a, b]
    const flow = rest.match(/^\[(.*)\]$/);
    if (flow !== null) {
      const items = flow[1]!.split(",").map((item) => item.trim());
      const nextItems = items.map((item) => {
        if (!item) return item;
        const replacement = replacements.get(unquote(item));
        if (replacement === undefined) return item;
        changed = true;
        return replacement;
      });
      out.push(items.length > 0 && items[0] !== "" ? `${kv[1]}: [${nextItems.join(", ")}]` : line);
      index += 1;
      continue;
    }

    // Bare scalar: xrefs: a
    if (rest !== "") {
      const replacement = replacements.get(unquote(rest));
      if (replacement === undefined) {
        out.push(line);
      } else {
        changed = true;
        out.push(`${kv[1]}: ${replacement}`);
      }
      index += 1;
      continue;
    }

    // Block sequence: the key line, then `  - value` items.
    out.push(line);
    let cursor = index + 1;
    while (cursor < closeIdx) {
      const itemLine = lines[cursor]!;
      const itemMatch = itemLine.match(/^(\s*-\s*)(.*)$/);
      if (itemMatch === null) break;
      const [, prefix, value] = itemMatch;
      const replacement = replacements.get(unquote(value!));
      if (replacement === undefined) {
        out.push(itemLine);
      } else {
        changed = true;
        out.push(`${prefix}${replacement}`);
      }
      cursor += 1;
    }
    index = cursor;
  }

  return changed ? out.join("\n") : null;
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

// ── Bookkeeping-insensitive freshness (STALE, R20) ────────────────────────────

/**
 * Frontmatter keys akm's own improve/index passes write into an EXISTING
 * asset as pipeline bookkeeping — never a change to the asset's authored
 * meaning. `salience`/`salienceInputs` come from {@link writeSalienceToFrontmatter}
 * (distill); `inferenceProcessed` comes from memory inference
 * (`indexer/passes/memory-inference.ts`). A pending proposal's mint-time
 * before-hash is sensitive to these rewrites even though nothing a reviewer
 * or the proposal's own diff cares about actually changed, which stales out
 * proposals that a same-run bookkeeping pass touches after mint. See
 * {@link computeNormalizedContentHash} and {@link carryForwardBookkeepingFrontmatter}.
 *
 * Deliberately excludes `beliefState`/`contradictedBy`/`supersededBy`: those
 * are editorial state (contradiction/supersession demotions), not derived
 * audit metadata — a promote should still refuse when one of those changed
 * underneath a pending proposal.
 */
export const BOOKKEEPING_FRONTMATTER_KEYS = ["salience", "salienceInputs", "inferenceProcessed"] as const;

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Hash of `raw` with {@link BOOKKEEPING_FRONTMATTER_KEYS} removed from its
 * frontmatter and the remaining frontmatter re-serialized with sorted keys,
 * so pipeline-only bookkeeping rewrites (and incidental key-order churn)
 * cannot change the result. The body is hashed verbatim.
 *
 * Falls back to hashing `raw` verbatim when there is no frontmatter block or
 * it fails to parse — normalizing unparsable frontmatter isn't safe, and the
 * caller's existing raw-hash check already covers that case.
 */
export function computeNormalizedContentHash(raw: string): string {
  const block = parseFrontmatterBlock(raw);
  if (!block?.frontmatter.trim()) return sha256Hex(raw);
  let data: unknown;
  try {
    data = yamlParse(block.frontmatter);
  } catch {
    return sha256Hex(raw);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return sha256Hex(raw);
  const normalized = { ...(data as Record<string, unknown>) };
  for (const key of BOOKKEEPING_FRONTMATTER_KEYS) delete normalized[key];
  const canonicalFrontmatter = yamlStringify(normalized, { sortMapEntries: true }).trimEnd();
  return sha256Hex(`---\n${canonicalFrontmatter}\n---\n${block.content}`);
}

/**
 * Fold the live target's {@link BOOKKEEPING_FRONTMATTER_KEYS} into
 * `proposedRaw` wherever the proposal's own frontmatter does not already set
 * them, so promoting a proposal minted before a bookkeeping rewrite never
 * drops that bookkeeping (STALE, R20) — e.g. dropping `inferenceProcessed`
 * would make memory inference reprocess the memory.
 *
 * Returns `proposedRaw` unchanged when either side has no parseable
 * frontmatter block or nothing needs to carry forward.
 */
export function carryForwardBookkeepingFrontmatter(proposedRaw: string, liveRaw: string): string {
  const proposedBlock = parseFrontmatterBlock(proposedRaw);
  const liveBlock = parseFrontmatterBlock(liveRaw);
  if (!proposedBlock || !liveBlock) return proposedRaw;

  let proposedData: Record<string, unknown>;
  let liveData: Record<string, unknown>;
  try {
    const parsedProposed = proposedBlock.frontmatter.trim() ? yamlParse(proposedBlock.frontmatter) : {};
    const parsedLive = liveBlock.frontmatter.trim() ? yamlParse(liveBlock.frontmatter) : {};
    if (parsedProposed === null || typeof parsedProposed !== "object" || Array.isArray(parsedProposed)) {
      return proposedRaw;
    }
    if (parsedLive === null || typeof parsedLive !== "object" || Array.isArray(parsedLive)) return proposedRaw;
    proposedData = parsedProposed as Record<string, unknown>;
    liveData = parsedLive as Record<string, unknown>;
  } catch {
    return proposedRaw;
  }

  const merged = { ...proposedData };
  let changed = false;
  for (const key of BOOKKEEPING_FRONTMATTER_KEYS) {
    if (!(key in merged) && key in liveData) {
      merged[key] = liveData[key];
      changed = true;
    }
  }
  if (!changed) return proposedRaw;

  const newFrontmatter = yamlStringify(merged).trimEnd();
  const separator = proposedBlock.content.startsWith("\n") ? "" : "\n";
  return `---\n${newFrontmatter}\n---\n${separator}${proposedBlock.content}`;
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
