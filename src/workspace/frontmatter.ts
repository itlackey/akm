// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A file's frontmatter for a form: its keys and values as akm's own YAML code reads them, the keys akm knows for the file's
 * type (and which are required), and the application of key changes to a text that leaves everything else as written.
 */

import { changeFrontmatter, type FrontmatterChange, readFrontmatter } from "../core/asset/frontmatter-edit";
import { frontmatterKeysFor } from "../core/asset/type-keys";
import { UsageError } from "../core/errors";
import { akmBundleFile, typeOfText } from "./check-text";

/** The frontmatter of `content` as the text of `path` in `bundle`: entries in file order, and the keys akm knows for its type. */
export function frontmatter(input: { bundle: string; path: string; content: string }) {
  const { bundle, relative } = akmBundleFile(input);
  const type = typeOfText(relative, input.content);
  const reading = readFrontmatter(input.content);
  const known = type === null ? [] : frontmatterKeysFor(type);
  return {
    bundle,
    path: relative,
    type,
    present: reading.present,
    entries: reading.entries.map((entry) => ({ ...entry, known: known.some((key) => key.key === entry.key) })),
    ...(reading.error ? { error: reading.error } : {}),
    keys: known,
  };
}

/** `content` with the changes applied to its frontmatter (a key set to a value, or removed), and nothing else changed. */
export function applyFrontmatter(input: { content: string; changes: FrontmatterChange[] }) {
  if (typeof input.content !== "string") throw new UsageError("content must be text.");
  if (!Array.isArray(input.changes)) throw new UsageError("changes must be a list.");
  return { content: changeFrontmatter(input.content, input.changes) };
}
