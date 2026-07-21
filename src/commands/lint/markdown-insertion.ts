// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Table-aware insertion-point selection for markdown auto-fixers.
 *
 * Background: an earlier `lint --fix` rule that auto-inserted a callout note
 * landed it INSIDE a markdown table in `knowledge/akm-cli-reference.md`, which
 * split the table fence and broke rendering. This module centralises the
 * "where is it safe to insert a new block?" decision so any current or future
 * fixer that wants to inject content into a markdown body can route through
 * `findSafeInsertionPoint` and avoid the same class of bug.
 *
 * The helper is intentionally pure: it takes a `string[]` of body lines plus a
 * proposed insertion line, and returns an adjusted insertion line that is
 * guaranteed to fall outside of any of the following no-insert regions:
 *
 *   - Markdown pipe tables (header row + `|---|---|` separator + data rows)
 *   - HTML tables (`<table>…</table>`)
 *   - Fenced code blocks (``` or ~~~ fences)
 *   - Indented code blocks (4+ leading spaces or a tab, after a blank line)
 *
 * Frontmatter is intentionally NOT detected here — callers should already
 * strip the frontmatter and operate on the body, or pass the full content
 * including frontmatter (in which case the helper treats it like prose and
 * will not detect it as a no-insert region; the existing
 * `fixMissingUpdated` flow injects into the frontmatter via regex without
 * needing this helper).
 *
 * Line numbers are 0-based throughout this module to match `Array.splice`
 * semantics. Callers using 1-based line numbers (e.g. from
 * `parseMarkdownToc`) must subtract 1 before passing in.
 */

// ── Pipe-table detection ─────────────────────────────────────────────────────

/**
 * Pattern matching a markdown table separator row, e.g. `|---|---|`,
 * `| :--- | ---: |`, or `:---|---:` (pipe-less style).
 *
 * Allows optional leading/trailing whitespace, optional outer pipes, and
 * alignment colons. Requires at least two cells (i.e. at least one inner
 * pipe between dash sequences) so we don't false-positive on a horizontal
 * rule like `---`.
 */
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/**
 * Pattern matching a plausible markdown table header/data row. Must contain
 * at least one pipe character that is not at the very start AND not part of
 * an inline code span. We don't try to be perfect here — the existence of a
 * matching separator row on the next line is the real signal that this is a
 * table.
 */
function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  // Must contain at least one pipe.
  if (!trimmed.includes("|")) return false;
  // Exclude lines that are obviously not table rows: headings, list items
  // starting with `- |` are rare but possible; we lean permissive here
  // because the separator-row check below is the real gate.
  if (/^#{1,6}\s/.test(trimmed)) return false;
  return true;
}

/**
 * Given the start line of a candidate table (the header row), return the
 * **exclusive** end line — the first line after the table that is NOT part
 * of it (either a blank line, EOF, or a line that doesn't look like a table
 * row). Returns -1 if the candidate is not actually a table.
 *
 * @param lines       Full body as a `string[]`.
 * @param headerLine  0-based index of the candidate header row.
 */
export function findEndOfTable(lines: string[], headerLine: number): number {
  if (headerLine < 0 || headerLine >= lines.length) return -1;
  if (!looksLikeTableRow(lines[headerLine]!)) return -1;
  const sepLine = headerLine + 1;
  if (sepLine >= lines.length) return -1;
  if (!TABLE_SEPARATOR_RE.test(lines[sepLine]!)) return -1;

  // Walk forward through data rows. A blank line, EOF, or a line that does
  // not look like a table row terminates the table.
  let i = sepLine + 1;
  while (i < lines.length) {
    if (lines[i]!.trim() === "") break;
    if (!looksLikeTableRow(lines[i]!)) break;
    i += 1;
  }
  return i;
}

/**
 * If `lineIdx` falls inside a markdown pipe table, return the exclusive end
 * line of that table. Otherwise return -1.
 *
 * "Inside" includes the header row, the separator row, and any data row.
 */
export function isInsideTable(lines: string[], lineIdx: number): number {
  if (lineIdx < 0 || lineIdx >= lines.length) return -1;

  // Walk backwards from lineIdx looking for a plausible table header
  // (i.e. a line followed by a separator row), up to the nearest blank
  // line or start-of-file.
  for (let i = lineIdx; i >= 0; i -= 1) {
    if (lines[i]!.trim() === "") return -1; // blank line — out of any table
    if (!looksLikeTableRow(lines[i]!)) return -1;
    const end = findEndOfTable(lines, i);
    if (end !== -1 && lineIdx < end) return end;
    // Continue scanning backwards — this row looks like a table row but
    // the table doesn't start here (could be a data row).
  }
  return -1;
}

// ── Fenced code block detection ───────────────────────────────────────────────

/**
 * Match a fenced code block opener/closer: ```` ``` ```` or `~~~`, with
 * optional leading whitespace and optional language identifier. The fence
 * character must repeat at least three times; the matched group is the
 * fence character + repeat count so we can detect matching closers.
 */
const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

interface FenceRegion {
  /** 0-based inclusive line of the opening fence. */
  start: number;
  /** 0-based inclusive line of the closing fence (or last line if unterminated). */
  end: number;
}

/**
 * Return all fenced-code-block regions in `lines`. A fence is considered
 * unterminated if EOF is reached without a matching closer — in that case
 * the region extends to the last line. This matches CommonMark behaviour
 * and means "EOF closes any open fence" so we still treat the tail as a
 * no-insert region (otherwise a fixer could inject content into what the
 * author meant as a multi-line code sample).
 */
export function findFenceRegions(lines: string[]): FenceRegion[] {
  const regions: FenceRegion[] = [];
  let openIdx = -1;
  let openFence = "";

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]!.match(FENCE_RE);
    if (!match) continue;
    const fence = match[2]!;
    if (openIdx === -1) {
      // Opening fence
      openIdx = i;
      openFence = fence[0]!; // ``` or ~~~
      continue;
    }
    // Inside a fence — only a matching fence character closes it, and the
    // closer must be at least as long. Per CommonMark we ignore any info
    // string on the closer (`match[3]` is allowed but typically empty).
    if (fence[0] === openFence && fence.length >= openFence.length) {
      regions.push({ start: openIdx, end: i });
      openIdx = -1;
      openFence = "";
    }
  }
  if (openIdx !== -1) {
    // Unterminated fence — extends to EOF.
    regions.push({ start: openIdx, end: lines.length - 1 });
  }
  return regions;
}

/**
 * If `lineIdx` falls inside any fenced code block, return the exclusive
 * end line (one past the closing fence). Otherwise return -1.
 */
export function isInsideCodeFence(lines: string[], lineIdx: number): number {
  if (lineIdx < 0 || lineIdx >= lines.length) return -1;
  for (const region of findFenceRegions(lines)) {
    if (lineIdx >= region.start && lineIdx <= region.end) {
      return region.end + 1;
    }
  }
  return -1;
}

// ── HTML table detection ─────────────────────────────────────────────────────

/**
 * If `lineIdx` falls inside an HTML `<table>…</table>` block, return the
 * exclusive end line (one past the `</table>`). Otherwise return -1.
 *
 * We do a deliberately simple scan: detect `<table` on any prior line (case
 * insensitive, allowing attributes) and require a `</table>` on or after
 * `lineIdx`. Nested tables are NOT supported — that's a markdown
 * anti-pattern and we'd rather under-detect than over-detect.
 */
export function isInsideHtmlTable(lines: string[], lineIdx: number): number {
  if (lineIdx < 0 || lineIdx >= lines.length) return -1;

  let openIdx = -1;
  for (let i = 0; i <= lineIdx; i += 1) {
    if (/<table[\s>]/i.test(lines[i]!)) openIdx = i;
    if (/<\/table\s*>/i.test(lines[i]!) && openIdx !== -1 && i >= openIdx) {
      // Closing tag before lineIdx — table already finished, reset.
      if (i < lineIdx) openIdx = -1;
      else return i + 1;
    }
  }
  if (openIdx === -1) return -1;

  // We're after a `<table` opener — find the matching `</table>`.
  for (let i = lineIdx; i < lines.length; i += 1) {
    if (/<\/table\s*>/i.test(lines[i]!)) return i + 1;
  }
  // Unterminated table — extend to EOF so we don't inject into malformed HTML.
  return lines.length;
}

// ── Indented code block detection ────────────────────────────────────────────

/**
 * Per CommonMark, an indented code block is a sequence of lines indented by
 * 4+ spaces (or one tab), preceded by a blank line. We use a simplified
 * detection: if `lineIdx` is indented 4+ spaces / starts with a tab AND
 * either is the first line of the body or follows a blank line, treat it
 * as part of an indented code block and skip to the next non-indented
 * non-blank line.
 *
 * Returns the exclusive end of the code block if `lineIdx` is inside one,
 * otherwise -1.
 */
export function isInsideIndentedCode(lines: string[], lineIdx: number): number {
  if (lineIdx < 0 || lineIdx >= lines.length) return -1;

  const isIndented = (s: string) => /^( {4}|\t)/.test(s);
  if (!isIndented(lines[lineIdx]!)) return -1;

  // Walk backwards: every line above must be either indented or blank, and
  // we must eventually hit a blank line (or BOF) before any non-indented
  // non-blank line. If we find a non-indented non-blank line first, this
  // isn't an indented code block (it's just a continuation of a list item
  // or paragraph).
  let foundBlankBoundary = false;
  for (let i = lineIdx - 1; i >= 0; i -= 1) {
    if (lines[i]!.trim() === "") {
      foundBlankBoundary = true;
      break;
    }
    if (!isIndented(lines[i]!)) {
      return -1; // probably a list continuation, not a code block
    }
  }
  if (!foundBlankBoundary && lineIdx > 0) {
    // Walked all the way to BOF without a blank line — but lineIdx > 0
    // means there was a non-indented non-blank line above, which would
    // have returned -1 already. This branch is for safety only.
    return -1;
  }

  // Walk forwards to find the end of the block.
  let i = lineIdx + 1;
  while (i < lines.length) {
    if (lines[i]!.trim() === "") {
      // A blank line MAY terminate the block, but per CommonMark a single
      // blank line followed by more indented lines is still part of the
      // same block. Peek ahead.
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() === "") j += 1;
      if (j >= lines.length || !isIndented(lines[j]!)) {
        break; // block ends at the blank line
      }
      i = j;
      continue;
    }
    if (!isIndented(lines[i]!)) break;
    i += 1;
  }
  return i;
}

// ── Composite: find a safe insertion point ───────────────────────────────────

/**
 * Given a proposed 0-based insertion line, return an adjusted 0-based line
 * that is guaranteed to fall outside of any markdown table, HTML table,
 * fenced code block, or indented code block.
 *
 * Strategy: if the proposed line falls inside a no-insert region, push it
 * to the line immediately AFTER that region. We never push it before —
 * most callouts are forward references to surrounding content, so
 * post-region is the safer choice (and prevents the very bug this helper
 * exists to fix: a callout landing between the header separator and the
 * first data row).
 *
 * The check is iterative: pushing past one region may land inside another
 * (e.g. table immediately followed by code fence), so we re-check until a
 * stable safe point is reached or we hit EOF. The iteration is bounded by
 * line count to guarantee termination.
 *
 * @param lines                Body as a `string[]`.
 * @param proposedLineNumber   0-based index where the caller wants to insert.
 * @returns                    0-based safe insertion index (may equal `lines.length`).
 */
export function findSafeInsertionPoint(lines: string[], proposedLineNumber: number): number {
  if (lines.length === 0) return 0;
  let target = Math.max(0, Math.min(proposedLineNumber, lines.length));

  // Iterate at most `lines.length` times — each iteration that finds a
  // region only moves `target` forward, so we cannot loop forever.
  for (let guard = 0; guard <= lines.length; guard += 1) {
    if (target >= lines.length) return lines.length;

    const tableEnd = isInsideTable(lines, target);
    if (tableEnd !== -1) {
      target = tableEnd;
      continue;
    }
    const fenceEnd = isInsideCodeFence(lines, target);
    if (fenceEnd !== -1) {
      target = fenceEnd;
      continue;
    }
    const htmlEnd = isInsideHtmlTable(lines, target);
    if (htmlEnd !== -1) {
      target = htmlEnd;
      continue;
    }
    const indentedEnd = isInsideIndentedCode(lines, target);
    if (indentedEnd !== -1) {
      target = indentedEnd;
      continue;
    }
    return target;
  }
  // Defensive fallback — should be unreachable given the guard above.
  return Math.min(target, lines.length);
}

/**
 * Convenience wrapper that operates on a raw string (splits on `\r?\n` and
 * accepts 0-based line numbers). Returns the adjusted 0-based line.
 *
 * Useful when a caller has the markdown as a single string and only wants
 * to know "where can I safely splice in N more lines?"
 */
export function findSafeInsertionPointInText(content: string, proposedLineNumber: number): number {
  return findSafeInsertionPoint(content.split(/\r?\n/), proposedLineNumber);
}
