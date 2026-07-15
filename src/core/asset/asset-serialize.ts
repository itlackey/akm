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
 * Serialize a frontmatter object with every value `JSON.stringify`-quoted,
 * without `---` fences and without a trailing newline.
 *
 * Use this instead of {@link serializeFrontmatter} when the input is a
 * pre-validated LLM payload where `yaml.stringify` may emit shapes
 * (`|`-block scalars, anchors, unquoted multiline) that the project's
 * hand-rolled `parseFrontmatter` subset parser cannot read back. Every scalar
 * becomes a quoted JSON literal; arrays become `[<json>, <json>]` (space after
 * the comma). Field order is preserved from the input's insertion order.
 *
 * This is the single home for the "guaranteed-quoted scalars" serializer the
 * module doc above anticipates; before it, `distill` (array-aware) and
 * `distill/content-repair` (scalar-only) reimplemented it divergently.
 */
export function serializeFrontmatterQuoted(frontmatter: Record<string, unknown>): string {
  return Object.entries(frontmatter)
    .map(([k, v]) =>
      Array.isArray(v) ? `${k}: [${v.map((s) => JSON.stringify(s)).join(", ")}]` : `${k}: ${JSON.stringify(v)}`,
    )
    .join("\n");
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
  return assembleAssetFromString(serializeFrontmatter(frontmatter), body);
}

/**
 * Same fence/body assembly as `assembleAsset` but takes a pre-serialized
 * frontmatter string. Use this when a caller needs its own frontmatter
 * serializer (e.g. defensive single-line flattening for untrusted LLM
 * output, or JSON.stringify-per-value for guaranteed-quoted scalars) while
 * still sharing the canonical fence-and-body template.
 *
 * The `serializedFm` argument must already match `serializeFrontmatter`'s
 * contract: no `---` fences, no trailing newline. Trailing whitespace is
 * trimmed defensively.
 *
 * Output contract — identical to `assembleAsset`:
 *   - `---\n<serializedFm>\n---\n\n<body>\n`
 *   - body has leading `\n` characters stripped
 *   - exactly one `\n` terminates the file
 *
 * This helper is the single point of truth for the fence-and-body template.
 * Three command surfaces (`reflect`, `distill`, `consolidate`) call it
 * directly because their inputs are pre-validated LLM payloads where the
 * full `yamlStringify` may emit shapes (`|`-block scalars, anchors) that
 * the project's hand-rolled `parseFrontmatter` subset parser cannot read.
 */
export function assembleAssetFromString(serializedFm: string, body: string): string {
  const yaml = serializedFm.replace(/\s+$/, "");
  const normalizedBody = body.replace(/^\n+/, "");
  const withTrailingNewline = normalizedBody.endsWith("\n") ? normalizedBody : `${normalizedBody}\n`;
  return `---\n${yaml}\n---\n\n${withTrailingNewline}`;
}
