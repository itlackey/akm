// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { localDateStamp } from "../common";
import { UsageError } from "../errors";
import { serializeFrontmatter } from "./asset-serialize";
import { parseFrontmatterBlock, replaceFrontmatterLine, spliceFrontmatterLine } from "./frontmatter";

/**
 * Ensure an AKM-authored Markdown concept is also a conformant OKF concept.
 *
 * Stamps BOTH `type` and `updated`, because both are required of a conformant
 * document and this is the one chokepoint every `.md` write passes through
 * (`core/write-source.ts`). Without the `updated` stamp, every asset akm
 * created for you — `akm remember`, `akm import`, accepted proposals,
 * authored workflows — was immediately flagged `missing-updated` by akm's own
 * `akm lint`, so the tool disagreed with itself about its own output.
 *
 * An existing `updated` is left alone: this fills a gap, it does not
 * re-stamp on every write (which would churn timestamps and manufacture
 * needless diffs in git-backed bundles).
 *
 * Source preservation: whenever the frontmatter block parses, it is edited as
 * text and never round-tripped through the YAML serializer, which rewraps long
 * values, reorders keys and drops comments — changes nobody made, shown to the
 * reviewer of what may be a one-line correction. A missing `type` and a
 * missing `updated` are each added as one line before the closing `---`, in
 * that order; a wrong `type` is replaced on its own line. Every other byte —
 * comments, wrapping, quoting, key order, line endings, the body — is kept as
 * written. The edited text is parsed back to confirm it holds exactly the
 * intended mapping; when it does not (a `type` value that spans several lines,
 * a flow-style `{…}` block), the document is re-serialized instead, as it
 * always used to be. A document with no frontmatter block gets a new one;
 * malformed YAML throws. An inserted or re-serialized block uses CRLF when
 * every line break in the document is CRLF, and LF otherwise.
 */
export function ensureAkmMarkdownType(content: string, type: string, now: Date = new Date()): string {
  const eol = documentLineEnding(content);
  const block = parseFrontmatterBlock(content);
  if (!block) {
    return (
      `---\n${serializeFrontmatter({ type, updated: localDateStamp(now) })}\n---\n`.replaceAll("\n", eol) + content
    );
  }

  let parsed: unknown;
  try {
    parsed = block.frontmatter.trim() ? parseYaml(block.frontmatter) : {};
  } catch {
    throw new UsageError("AKM Markdown has malformed YAML frontmatter.", "INVALID_FLAG_VALUE");
  }
  if (parsed === null) parsed = {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("AKM Markdown frontmatter must be a YAML mapping.", "INVALID_FLAG_VALUE");
  }
  const data = parsed as Record<string, unknown>;
  const updated = localDateStamp(now);
  const needsUpdated = !("updated" in data);
  if (data.type === type && !needsUpdated) return content;

  let edited: string | null = content;
  if (data.type !== type) {
    edited =
      "type" in data
        ? replaceFrontmatterLine(edited, "type", `type: ${type}`)
        : spliceFrontmatterLine(edited, `type: ${type}`);
  }
  if (edited !== null && needsUpdated) edited = spliceFrontmatterLine(edited, `updated: ${updated}`);
  const intended = needsUpdated ? { ...data, type, updated } : { ...data, type };
  if (edited !== null && parsesTo(edited, intended)) return edited;

  // The text edit could not be done safely, but a re-serialized document
  // beats a non-conformant one.
  const { type: _priorType, ...rest } = data;
  const next: Record<string, unknown> = { type, ...rest };
  if (needsUpdated) next.updated = updated;
  return `---\n${serializeFrontmatter(next)}\n---\n`.replaceAll("\n", eol) + block.content;
}

/**
 * The exact text `writeAssetToSource` writes for an AKM Markdown asset: the
 * conformant document from {@link ensureAkmMarkdownType}, ending in a line
 * break in the document's own line-ending style.
 */
export function normalizeAkmMarkdown(content: string, type: string, now: Date = new Date()): string {
  const authored = ensureAkmMarkdownType(content, type, now);
  return authored.endsWith("\n") ? authored : authored + documentLineEnding(authored);
}

/** CRLF only when every line break is CRLF; LF for LF-only, mixed or single-line text. */
function documentLineEnding(text: string): "\r\n" | "\n" {
  const breaks = text.split("\n").length - 1;
  return breaks > 0 && text.split("\r\n").length - 1 === breaks ? "\r\n" : "\n";
}

/** True when the frontmatter of `text` parses to exactly `intended`. */
function parsesTo(text: string, intended: Record<string, unknown>): boolean {
  try {
    return isDeepStrictEqual(parseYaml(parseFrontmatterBlock(text)?.frontmatter ?? ""), intended);
  } catch {
    return false;
  }
}
