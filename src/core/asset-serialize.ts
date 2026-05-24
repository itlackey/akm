// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Canonical asset-on-disk serialization.
 *
 * Before this module, 9+ call sites across `src/` independently reimplemented
 * `yamlStringify(fm).trimEnd() + "---\n…\n---\n\n${body}"` to assemble a
 * Markdown asset. The reimplementations drifted (different body normalization,
 * different separator newlines, different trailing-newline policy), which is
 * exactly the kind of silent format-shift the proposal-quality validators end
 * up chasing downstream. This file is the single point of truth for
 * "what does a well-formed AKM asset look like on disk".
 *
 * Two helpers are exported:
 *   - `serializeFrontmatter(fm)` — YAML for the frontmatter block only, with
 *     no `---` fences and no trailing newline. Single home for quoting style,
 *     field-order policy, and trailing-whitespace rules.
 *   - `assembleAsset(fm, body)` — frontmatter wrapped in `---` fences with a
 *     blank line between the closing fence and the body, and exactly one
 *     trailing `\n`. Single home for body normalization and the file-shape
 *     contract.
 *
 * Contract (must hold for the dedup to be safe):
 *   - Idempotent: `parseFrontmatter(assembleAsset(fm, body))` re-assembled
 *     reproduces the same bytes.
 *   - Field order: insertion order of `fm` is preserved (the caller controls
 *     ordering; the helper never reorders).
 *   - Quoting: `yaml.stringify` defaults — no custom quoting logic.
 *   - Trailing newline: exactly one `\n` at end of output.
 *   - Body normalization: leading newlines are stripped (`/^\n+/`). This
 *     collapses the assorted `body.replace(/^\n+/, "")` /
 *     `body.startsWith("\n") ? "" : "\n" + body` / bare `${body}` patterns
 *     onto the most aggressive existing normalizer.
 */

import { stringify as yamlStringify } from "yaml";

/**
 * Serialize a frontmatter object to its on-disk YAML form, without `---`
 * fences and without a trailing newline.
 *
 * Two calls with the same input produce byte-identical output. Field order is
 * preserved from the input object's insertion order — callers control
 * ordering, the helper never reorders.
 */
export function serializeFrontmatter(frontmatter: Record<string, unknown>): string {
  return yamlStringify(frontmatter).trimEnd();
}

/**
 * Assemble a complete asset file string from a frontmatter object and a body.
 *
 * Output shape: `---\n<yaml>\n---\n\n<body>\n` where:
 *   - `<yaml>` is `serializeFrontmatter(frontmatter)`.
 *   - `<body>` has any leading `\n` characters stripped.
 *   - Exactly one `\n` terminates the file.
 *
 * Idempotent under round-trip through the project's `parseFrontmatter`.
 */
export function assembleAsset(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = serializeFrontmatter(frontmatter);
  const normalizedBody = body.replace(/^\n+/, "");
  const withTrailingNewline = normalizedBody.endsWith("\n") ? normalizedBody : `${normalizedBody}\n`;
  return `---\n${yaml}\n---\n\n${withTrailingNewline}`;
}
